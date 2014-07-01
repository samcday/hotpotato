"use strict";

// TODO: handle timeouts to acks.
// TODO: default router.
// TODO: handle worker death.
// TODO: don't allow requests to be passed if data has already been read from them.

var Promise = require("bluebird"),
    net     = require("net"),
    http    = require("http"),
    cluster = require("cluster"),
    debug   = require("debug"),
    temp    = require("temp"),
    path    = require("path"),
    shimmer = require("shimmer"),
    msgs    = require("./messaging");

function setupMaster() {
  var masterDebug = debug("hotpotato:master");

  temp.track();

  // This will map worker ids to the side-channel servers they are available on.
  var serverMap = {};

  var socketDir = temp.mkdirSync();

  var createWorkerServer = function(worker) {
    masterDebug("Setting up server for new worker #" + worker.id);

    // We won't resolve the promise until the worker has responded that they
    // have created the server.
    var serverDeferred = Promise.defer();
    serverMap[worker.id] = serverDeferred.promise;

    var socketFile = path.join(socketDir, "worker-" + worker.id + ".sock");
    msgs.sendTo(worker, "createServer", { path: socketFile }).then(function() {
      serverDeferred.resolve(socketFile);
    });
  };

  msgs.handlers.routeConnection = function(ack, message) {
    masterDebug("Routing connection.");

    var workerId;
    try {
      workerId = exports.router(message.method, message.url, message.headers);
    } catch(e) {
      masterDebug("Error running connection router.");
      masterDebug(e);
      workerId = -1;
    }

    var worker = cluster.workers[workerId];

    if (!worker) {
      masterDebug("Router directed connection to nonexistent worker id.");
      return ack({error: "No worker found."});
    }

    serverMap[workerId].then(function(path) {
      ack({id: "TODO", path: path});
    });
  };

  cluster.on("online", createWorkerServer);
}

function setupWorker() {
  var worker = cluster.worker;
  var workerDebug = debug("hotpotato:worker" + worker.id);
  var sideChannelServer;
  var destServer;

  var setupSideChannelServer = function(socketPath) {
    workerDebug("Creating side-channel server");

    var deferred = Promise.defer();

    // TODO: This is some epic fucking hax. But I couldn't figure out how else
    // to create a Server that doesn't get shared with master.
    sideChannelServer = http.createServer();
    var handle = net._createServerHandle(socketPath, -1, -1, undefined);
    sideChannelServer._listen2(null, null, null, -1, handle.fd);
    sideChannelServer.on("listening", deferred.callback);

    sideChannelServer.on("request", function(req, res) {
      if (!destServer) {
        workerDebug("Side channel request received, but no dest server to forward to.");
        req.abort();
        // TODO: properly handle this.
        res.writeHead(500);
        res.end();
      }

      res.shouldKeepAlive = true;
      destServer.emit("request", req, res);
    });
    return deferred.promise;
  };

  msgs.handlers.createServer = function(ack, msg) {
    setupSideChannelServer(msg.path).then(function() {
      ack();
    });
  };

  var connectionHandler = function(connection) {
    connection._hotpotato = {};

    // The idea here is to shim the parser onHeaders / onHeadersComplete events.
    // When they're called we mark the request as "parsing". When we've fully
    // received the request, we check if we've already begun parsing again.
    // This can happen if we get pipelined requests.
    var shim = function(original) {
      return function() {
        connection._hotpotato.parsing = true;
        original.apply(this, arguments);
      }
    };

    shimmer.wrap(connection.parser, "onHeaders", shim);
    shimmer.wrap(connection.parser, "onHeadersComplete", shim);
  }

  var pass = function(req, res) {
    workerDebug("Passing off a connection.");

    // Reset the parsing flag.
    req.connection._hotpotato.parsing = false;

    msgs.sendToMaster("routeConnection", {
      method: req.method,
      url: req.url,
      headers: req.headers
    }).then(function(resp) {
      req.resume();


      if (resp.error) {
        workerDebug("Failed to pass off connection: " + resp.error);
        res.writeHead(500);
        res.end();
      }

      req.headers["X-HOTPOTATO-WORKER"] = cluster.worker.id;

      var proxyReq = http.request({
        socketPath: resp.path,
        path: req.url,
        method: req.method,
        headers: req.headers
      });

      req.pipe(proxyReq);
      req.on("end", function() {
        // TODO: check parser state and see if we can hand-off connection here
      });

      proxyReq.on("response", function(proxyResp) {
        res.writeHead(proxyResp.statusCode, proxyResp.headers);
        proxyResp.pipe(res);
      });
    });

  };

  var setServer = function(server) {
    if (destServer) {
      destServer.removeListener("connection", connectionHandler);
    }
    destServer = server;
    destServer.on("connection", connectionHandler);
  };

  exports.pass = pass;
  exports.server = setServer;
}

if (cluster.isMaster) {
  setupMaster();
} else {
  setupWorker();
}
