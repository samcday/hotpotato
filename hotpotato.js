"use strict";

// TODO: handle worker death.
// TODO: handle timeouts to acks.
// TODO: default router.
// TODO: don't allow requests to be passed if data has already been read from them.
// TODO: handle upgrades.
// TODO: propagate errors on passing to the request (so server picks up clientErrors).

var Promise = require("bluebird"),
    cluster = require("cluster"),
    http    = require("http"),
    _debug  = require("debug");

function writeHttpError(socket) {
  try {
    socket.write("HTTP/1.1 503 Service Temporarily Unavailable\r\n\r\n");
  }
  finally {
    try {
      socket.end();
    } catch(e) { }
  }
}

function initMaster(opts, state) {
  var api = {},
      debug = _debug(state.debugName("core")),
      clusterphone = state.clusterphone;

  state.routerFn = function() {
    throw new Error("Master needs a routing function set for Hotpotato to work correctly.");
  };

  api.router = function(fn) {
    state.routerFn = fn;
  };

  var runRouter = function(method, url, headers) {
    var deferred = Promise.defer();

    var routerMethod = Promise.method(state.routerFn);
    deferred.resolve(routerMethod(method, url, headers, deferred.callback));

    return deferred.promise.catch(function(e) {
      debug("Error running connection router.");
      debug(e);
      return -1;
    }).then(function(workerId) {
      var worker = cluster.workers[workerId];
      if (!worker) {
        debug("Router directed connection to nonexistent worker id.");
        return null;
      }
      return worker;
    });
  };

  var handoffId = 1;
  clusterphone.handlers.routeRequest = function(worker, data) {
    var method    = data.method,
        url       = data.url,
        headers   = data.headers,
        strategy  = data.strategy;

    return runRouter(method, url, headers).then(function(worker) {
      if (!worker) {
        throw new Error("No worker found.");
      }

      var newHandoffId = handoffId++;
      debug("New handoffId " + newHandoffId, method, url, headers);

      var handoff = state.handoffs[strategy],
          routeResponse = {
            workerId: worker.id,
            handoffId: newHandoffId
          };

      if (handoff.afterRoute) {
        return handoff.afterRoute(routeResponse);
      }

      return routeResponse;
    });
  };

  clusterphone.handlers.routeUpgrade = function(worker, data, socket) {
    // !!! Make sure socket doesn't leak !!!
    socket._handle.readStop();

    var method    = data.method,
        url       = data.url,
        headers   = data.headers;

    return runRouter(method, url, headers).then(function(worker) {
      if (!worker) {
        debug("Failed to route an upgrade.");
        writeHttpError(socket);
        return Promise.reject(new Error("Router failed to direct upgrade to a new worker."));
      }

      var newHandoffId = handoffId++;
      debug("New handoffId " + newHandoffId + " for upgrade.", method, url, headers);

      var upgradeHandoff = {
        handoffId: newHandoffId,
        data: data
      };

      return clusterphone.sendTo(worker, "handleUpgrade", upgradeHandoff, socket, true).ackd();
    });
  };

  return api;
}

function initWorker(opts, state) {
  var api = {},
      clusterphone = state.clusterphone,
      debug = _debug(state.debugName("core"));

  state.targetServer = null;

  api.bindTo = function(server) {
    if (state.targetServer) {
      throw new Error("You can only set up one server for Hotpotato workers.");
    }
    state.targetServer = server;

    Object.keys(state.handoffs).forEach(function(strategy) {
      if (state.handoffs[strategy].configureServer) {
        state.handoffs[strategy].configureServer(server);
      }
    });
  };

  var pass = function(passConnection, req, res) {
    if (!state.targetServer) {
      throw new Error("No server has been setup.");
    }

    if (req._hotpotato) {
      throw new Error("You're trying to pass a connection that has already been proxied from another server. This is not supported.");
    }

    var selectedStrategy;
    Object.keys(state.handoffs).some(function(strategy) {
      if (state.handoffs[strategy].canHandle(passConnection, req, res)) {
        selectedStrategy = strategy;
        return true;
      }
    });

    if (!selectedStrategy) {
      throw new Error("No handoff strategy suitable for this request.");
    }

    var handoff = state.handoffs[selectedStrategy];

    var requestData = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      strategy: selectedStrategy
    };

    debug("Handing off request using " + selectedStrategy, requestData);

    Promise.resolve(handoff.preRoute(passConnection, req, res)).then(function() {
      return clusterphone.sendToMaster("routeRequest", requestData).ackd()
        .then(function(routeReply) {
          debug("Got handoff reply", routeReply);
          handoff.postRoute(passConnection, routeReply, req, res);
        })
        .catch(function(err) {
          if (err.origMessage) {
            err.message = err.origMessage;
            err.stack = err.origStack;
          }

          debug("Failed to pass off connection: " + err.message, err.stack);

          try {
            res.writeHead(500);
            res.end();
          } catch(e) {
            try { req.connection.destroy(); } catch(e) {}
          }
        });
    });
  };

  api.passRequest = function(req, res) {
    pass(false, req, res);
  };

  api.passConnection = function(req, res) {
    pass(true, req, res);
  };

  api.passUpgrade = function(req, socket, buf) {
    // !!! Make sure socket doesn't leak !!!
    socket.pause();
    var buffered = [buf.toString("base64")];
    socket.push = function(buffer) {
      if (buffer) {
        buffered.push(buffer.toString("base64"));
      }
      return false;
    };

    var reqData = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      buffered: buffered
    };

    return new Promise(function(resolve) {
      process.nextTick(function() {
        // Bundle everything up, send it to master to be re-routed.
        resolve(clusterphone.sendToMaster("routeUpgrade", reqData, socket).ackd());
      });
    });
  };

  clusterphone.handlers.handleUpgrade = function(upgradeHandoff, socket) {
    var handoffId = upgradeHandoff.handoffId;

    debug("Got an upgrade for handoffId " + handoffId);

    // Reconstruct request.
    var newReq = new http.IncomingMessage(socket);
    newReq.url = upgradeHandoff.data.url;
    newReq.method = upgradeHandoff.data.method;
    newReq.headers = upgradeHandoff.data.headers;
    // TODO: HTTP version on req.

    var proceed = true;

    setImmediate(function() {
      if (proceed) {
        var buffers = upgradeHandoff.data.buffered.map(function(data) {
          return new Buffer(data, "base64");
        });
        state.targetServer.emit("upgrade", newReq, socket, Buffer.concat(buffers));
      } else {
        debug("Decided not to go ahead with handling upgrade for handoffId " + handoffId);
      }
    });

    socket.on("close", function() {
      proceed = false;
    });

    socket.on("error", function() {
      proceed = false;
    });
  };

  return api;
}

var instances = {};

module.exports = function(id, opts) {
  if (!id) {
    throw new Error("Hotpotato requires an ID to setup correctly.");
  }

  if (instances[id]) {
    return instances[id];
  }

  var myName = cluster.isMaster ? "master" : ("worker" + cluster.worker.id);

  opts = opts || {};

  var state = {
    id: id,
    clusterphone: require("clusterphone").ns("hotpotato:" + id),
    debugName: function(tag) {
      var name = "hotpotato:" + id;
      if (tag) {
        name += ":" + tag;
      }
      return name + ":" + myName;
    }
  };

  _debug(state.debugName("core"))("Initializing.");

  // Setup handoff strategies.
  var handoffStrategies = require("./handoffs");
  state.handoffs = {};
  Object.keys(handoffStrategies).forEach(function(strategy) {
    if (Array.isArray(opts.strategies) && opts.strategies.indexOf(strategy) === -1) {
      return;
    }
    state.handoffs[strategy] = new handoffStrategies[strategy](state);
  });

  instances[id] = cluster.isMaster ? initMaster(opts, state) : initWorker(opts, state);
  return instances[id];
};
