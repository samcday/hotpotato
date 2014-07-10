"use strict";

// Standard proxying.
// Not exactly a naive http proxy though. We have an internal pool of 
// connections between each of our workers that we forward requests over.
// However, the forwarding isn't 1:1, we actually multiplex in-flight requests
// over this internal pool. This is to ensure that a long polling request
// doesn't hog one of the internal connections.

// TODO: need to handle connection passes properly.
// TODO: handle pausing the fake request.
// TODO: handle 100 continues.

var Promise = require("bluebird"),
    cluster = require("cluster"),
    http    = require("http"),
    util    = require("util"),
    _debug  = require("debug"),
    Agent   = require("yakaa");

function ProxyingMaster(state) {
  var debug = _debug(state.debugName("proxying")),
      clusterphone = state.clusterphone;

  // This is the map of internal servers, keyed by worker id.
  // Each entry will be a Promise that is resolved once that worker has their
  // server listening and tell us about it.
  var serverMap = {};

  clusterphone.handlers.notifyProxyServer = function(worker, address) {
    debug("Got proxy server from worker " + worker.id, address);
    serverMap[worker.id].resolve(address);
  };

  var waitForServer = function(routeResponse) {
    return serverMap[routeResponse.workerId].then(function(connectionDetails) {
      routeResponse.connection = connectionDetails;
      return routeResponse;
    });
  };

  cluster.on("fork", function(worker) {
    var resolve,
        promise = new Promise(function(_resolve) {
          resolve = _resolve;
        });

    serverMap[worker.id] = promise;
    promise.resolve = resolve;

    worker.on("exit", function() {
      delete serverMap[worker.id];
    });
  });

  return {
    afterRoute: function(routeResponse) {
      return waitForServer(routeResponse);
    }
  };
}

function ProxyingWorker(state) {
  var debug = _debug(state.debugName("proxying")),
      clusterphone = state.clusterphone;

  // Setup the internal server.
  debug("Creating internal server for proxying requests.");
  var internalServer = http.createServer(),
      internalAddress;

  // Regular listen() call results in net module asking cluster to step in and
  // get the master to create server FD for us. Which we don't want.
  // So unfortunately we have to be a little hacky here.
  internalServer._listen2("127.0.0.1", 0, null, -1);

  // Let the master know what our internal server address is once we're ready.
  internalServer.on("listening", function() {
    var address = internalServer.address();
    internalAddress = address.address + ":" + address.port;

    clusterphone.sendToMaster("notifyProxyServer", {
      host: address.address,
      port: address.port
    });
  });

  // This is the http.Agent we use when talking to intra-cluster internal servers.
  // It pools connections and keeps them alive for a configrable timeout.
  // This is preferable over Node.js default Agent, which *does* use keep-alive,
  // but will close a socket if there's no requests queued up to use it.
  // The max-sockets here is on a per host basis.
  var workerAgent = new Agent({
      maxSockets: 20,
      maxFreeSockets: 20,
      keepAlive: true,
      keepAliveTimeoutMsecs: 10000
  });

  var proxyInbounds = {},
      proxyOutbounds = {};

  // TODO: this needs to handle error cases.
  // This method handles the process of proxying request over to remote worker.
  var proxyRequest = function(req, res, routeReply) {
    var handoffId = routeReply.handoffId,
        targetWorker = routeReply.workerId,
        socket = req.connection,
        socketAddress = socket.remoteAddress + ":" + socket.remotePort;

    proxyOutbounds[handoffId] = {
      req: req,
      res: res
    };

    debug("Proxying request for handoffId " + handoffId + " from " + socketAddress + " to worker " + targetWorker);

    // This represents the active connection we have with the proxy endpoint
    // *right now*. As bytes come in from underlying request we shunt them in
    // here. If this is undefined though, we need to reopen.
    var activeProxyReq,
        proxyReqTimeout,
        awaitingResponse = false,
        bufferedData = [],
        reqDone = false;

    var finishProxying = function(data) {
      var reqOpts = {
        path: "/req-done",
        method: "POST",
        agent: workerAgent,
        host: routeReply.connection.host,
        port: routeReply.connection.port,
        headers: {
          "X-Hotpotato-Handoff-ID": handoffId
        }
      };

      var finishReq = http.request(reqOpts);
      if (data) {
        finishReq.write(data);
      }
      finishReq.end();
    };

    var continueProxying = function(initial) {
      // If we're still waiting for a response from last proxy request, we 
      // don't wanna pile up multiple new ones.
      if (awaitingResponse) {
        return;
      }

      var reqOpts = {
        path: initial === true ? "/req-start" : "/req-continue",
        method: "POST",
        agent: workerAgent,
        host: routeReply.connection.host,
        port: routeReply.connection.port,
        headers: {
          "X-Hotpotato-Handoff-ID": handoffId
        }
      };

      if (initial === true) {
        reqOpts.headers["X-Hotpotato-URL"] = req.url;
        reqOpts.headers["X-Hotpotato-Verb"] = req.method;
        reqOpts.headers["X-Hotpotato-Host"] = req.headers.host;
        reqOpts.headers["X-Hotpotato-Origin"] = internalAddress;
        Object.keys(req.headers, function(headerName) {
          if (headerName === "transfer-encoding" ||
              headerName === "connection") {
            return;
          }

          reqOpts.headers[headerName] = req.headers[headerName];
        });
      }

      activeProxyReq = http.request(reqOpts);

      activeProxyReq.on("response", function(response) {
        // Don't care about response from remote.
        response.resume();

        awaitingResponse = false;

        // Request is done. Finish up now.
        if (reqDone) {
          finishProxying();
        }

        // If more data came in while we were waiting for remote to respond,
        // then we simply continue proxying again in a new req.
        if (bufferedData.length) {
          continueProxying();
        }
      });

      proxyReqTimeout = setTimeout(function() {
        activeProxyReq.end();
        awaitingResponse = true;
        activeProxyReq = null;
        proxyReqTimeout = null;
      }, 100);  // TODO: make this window configurable.
    };

    // Kick off initial.
    continueProxying(true);

    req.on("data", function(data) {
      if (!activeProxyReq) {
        continueProxying();
        bufferedData.push(data);
      } else {
        activeProxyReq.write(data);
      }
    });

    // TODO: handle this case.
    req.on("clientError", function() {

    });

    req.on("end", function(data) {
      // Signal that we're done.
      reqDone = true;

      // If there's an existing request in flight, wrap it up now.
      // We don't immediately finish proxying in this case. The response handler
      // in continueProxying() will detect that request has ended and call it
      // for us.
      if (activeProxyReq) {
        clearTimeout(proxyReqTimeout);
        // We can sneak in any last data we got too.
        if (data) {
          activeProxyReq.write(data);
        }
        activeProxyReq.end();
      } else {
        finishProxying(data);
      }
    });
  };

  var handleProxyResponse = function(req, res) {
    var handoffId = parseInt(req.headers["x-hotpotato-handoff-id"], 10),
        outbound = proxyOutbounds[handoffId],
        status = parseInt(req.headers["x-hotpotato-status"], 10),
        phrase = req.headers["x-hotpotato-phrase"];

    debug("Got proxy response for handoffId " + handoffId);

    // Sanitize headers.
    delete req.headers["x-hotpotato-handoff-id"];
    delete req.headers["x-hotpotato-status"];
    delete req.headers["x-hotpotato-phrase"];
    delete req.headers["transfer-encoding"];
    delete req.headers.connection;

    outbound.res.writeHead(status, phrase, req.headers);

    req.on("data", function(data) {
      outbound.res.write(data);
    });

    req.on("end", function() {
      res.end();
      outbound.res.end();
    });
  };

  // TODO: handle timeouts on writing out response.
  function ProxiedServerResponse(req, origin, handoffId) {
    http.ServerResponse.call(this, req);

    // We don't begin our proxy response back to origin until first bytes have
    // been written.
    var proxyReq = null;

    this.writeHead = function(statusCode) {
      var reasonPhrase,
          additionalHeaders,
          headers;

      if (typeof arguments[1] === "string") {
        reasonPhrase = arguments[1];
        additionalHeaders = arguments[2];
      } else {
        reasonPhrase = http.STATUS_CODES[statusCode] || 'unknown';
        additionalHeaders = arguments[1];
      }

      headers = this._renderHeaders();

      if (additionalHeaders) {
        Object.keys(additionalHeaders).forEach(function(headerName) {
          if (additionalHeaders[headerName]) {
            headers[headerName] = additionalHeaders[headerName];
          }
        });
      }

      headers["X-Hotpotato-Handoff-ID"] = handoffId;
      headers["X-Hotpotato-Status"] = statusCode;
      headers["X-Hotpotato-Phrase"] = reasonPhrase;

      proxyReq = http.request({
        path: "/response",
        method: "POST",
        agent: workerAgent,
        host: origin.host,
        port: origin.port,
        headers: headers
      });
    };

    this.write = function(chunk, encoding) {
      if (!proxyReq) {
        // TODO: how does real http handle this?
        throw new Error("write() called before writeHead");
      }

      proxyReq.write(chunk, encoding);
    };

    this.end = function(chunk, encoding) {
      if (!proxyReq) {
        // TODO: how does real http handle this?
        throw new Error("end() called before writeHead");
      }

      proxyReq.write(chunk, encoding);
      proxyReq.end();
    };
  }

  util.inherits(ProxiedServerResponse, http.ServerResponse);

  // // Set up a fake "res" object. The res is a real http.ServerResponse, but
  // // we override write / end 
  // var createProxiedOutbound = function(proxiedReq, underlyingRes) {
  //   var res = new http.ServerResponse(newReq);

  //   var buffers = [],
  //       bufferEncs = [];

  //   res.write = function(data, encoding) {
  //     buffers.push(data);
  //     bufferEncs.push(encoding);
  //   };

  //   // TODO: handle origin being dead by the time we're ready to respond.
  //   res.end = function() {
  //     var req = http.request({

  //     });
  //   };

  //   return res;
  // };

  // This sets up a shim req and res for an inbound proxied request, and then
  // pumps it into the target server.
  var setupProxiedRequest = function(req, res) {
    var handoffId = parseInt(req.headers["x-hotpotato-handoff-id"], 10),
        url = req.headers["x-hotpotato-url"],
        method = req.headers["x-hotpotato-verb"],
        host = req.headers["x-hotpotato-host"],
        origin = req.headers["x-hotpotato-origin"];

    debug("Handling proxied request for handoffId " + handoffId);

    var originParts = origin.split(":");
    origin = {
      host: originParts[0],
      port: originParts[1]
    };

    // TODO: sanity checks on incoming data + target server.

    // Construct the new request.

    // We set up a fake socket to ensure certain internals of http don't fail.
    var fakeSocket = {
      readable: false
    };

    var newReq = new http.IncomingMessage(fakeSocket);

    newReq.url = url;
    newReq.method = method;
    newReq.headers = req.headers;

    // Force http 1.1
    newReq.httpVersionMajor = newReq.httpVersionMinor = 1;
    newReq.httpVersion = "1.1";

    // Sanitize the headers.
    delete newReq.headers["x-hotpotato-handoff-id"];
    delete newReq.headers["x-hotpotato-url"];
    delete newReq.headers["x-hotpotato-verb"];
    delete newReq.headers["x-hotpotato-host"];
    delete newReq.headers["x-hotpotato-origin"];
    newReq.headers.host = host;


    var newRes = new ProxiedServerResponse(newReq, origin, handoffId);

    proxyInbounds[handoffId] = {
      req: newReq,
      res: newRes
    };

    state.targetServer.emit("request", newReq, newRes);

    // Pump data from the proxy req into the simulated req.
    req.on("data", function(data) {
      newReq.emit("data", data);
    });

    req.on("end", function() {
      res.end();
    });
  };

  var handleContinuedProxyRequest = function(req, res) {
    var handoffId = parseInt(req.headers["x-hotpotato-handoff-id"], 10),
        underlyingReq = proxyInbounds[handoffId];

    debug("Got data from proxied request for handoffId " + handoffId);

    req.on("data", function(data) {
      underlyingReq.emit("data", data);
    });

    req.on("end", function() {
      res.end();
    });

    res.end();
  };

  var handleFinishedProxyRequest = function(req, res) {
    var handoffId = parseInt(req.headers["x-hotpotato-handoff-id"], 10),
        underlying = proxyInbounds[handoffId];

    req.on("end", function() {
      underlying.req.emit("end");
    });

    handleContinuedProxyRequest(req, res);
  };

  internalServer.on("request", function(req, res) {
    debug("Internal server got " + req.url);

    if (req.url === "/req-start") {
      setupProxiedRequest(req, res);
    } else if (req.url === "/req-continue") {
      handleContinuedProxyRequest(req, res);
    } else if (req.url === "/req-done") {
      handleFinishedProxyRequest(req, res);
    } else if (req.url === "/response") {
      handleProxyResponse(req, res);
    }
  });

  return {
    canHandle: function(passConnection, req) {
      // This strategy can handle anything. Except upgrades.
      return req.headers.upgrade === undefined;
    },
    preRoute: function(req) {
      // Make sure we don't miss any data while we're waiting for master to
      // route this request.
      req.pause();
    },
    postRoute: function(routeReply, req, res) {
      // Safe to resume data events on underlying request now.
      req.resume();

      // Start proxying this request over to destination.
      proxyRequest(req, res, routeReply);
    }
  };
}

module.exports = require("cluster").isMaster ? ProxyingMaster : ProxyingWorker;
