"use strict";

// TODO: handle worker death.
// TODO: handle timeouts to acks.
// TODO: default router.
// TODO: don't allow requests to be passed if data has already been read from them.
// TODO: handle upgrades.

var Promise = require("bluebird"),
    cluster = require("cluster"),
    _debug  = require("debug");

function initMaster(opts, state) {
  var api = {},
      debug = _debug(state.debugName("core"));

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
  state.clusterphone.handlers.routeRequest = function(worker, data) {
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
  };

  var pass = function(passConnection, req, res) {
    if (!state.targetServer) {
      throw new Error("No server has been setup.");
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

    Promise.resolve(handoff.preRoute(req, res)).then(function() {
      return clusterphone.sendToMaster("routeRequest", requestData).ackd()
        .then(function(routeReply) {
          debug("Got handoff reply", routeReply);
          handoff.postRoute(routeReply, req, res);
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

  return api;
}

module.exports = function(id, opts) {
  if (!id) {
    throw new Error("Hotpotato requires an ID to setup correctly.");
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
    if (Array.isArray(opts.strategies) && opts.strategies.indexOf(strategy === -1)) {
      return;
    }
    state.handoffs[strategy] = new handoffStrategies[strategy](state);
  });

  return cluster.isMaster ? initMaster(opts, state) : initWorker(opts, state);
};
