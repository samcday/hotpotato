"use strict";

var Promise = require("bluebird"),
    cluster = require("cluster"),
    debug   = require("debug")("hotpotato:master");

// TODO: handle no router.
// TODO: handle edge case of router sending request to originating worker.

module.exports = function(id) {
  var api = {};

  var clusterphone = require("clusterphone").ns("hotpotato:" + id);

  // This will map worker ids to the side-channel servers they are available on.
  var serverMap = {};

  function cleanupWorker(worker) {
    delete serverMap[worker.id];
  }

  function setupWorker(worker) {
    worker.on("exit", cleanupWorker.bind(null, worker));
  }

  function initWorker(worker) {
    // We won't resolve the promise until the worker has responded that they
    // have created the server.
    var serverDeferred = Promise.defer();
    serverMap[worker.id] = serverDeferred.promise;

    return clusterphone.sendTo(worker, "init").ackd().then(function(address) {
      serverDeferred.resolve(address);
    }).catch(function() {
      // TODO: worker is toast. What to do here?
      console.log("WARN: hotpotato couldn't init worker " + worker.id);
    });
  }

  function runRouter(method, url, headers) {
    var deferred = Promise.defer();

    var routerMethod = Promise.method(api.router);
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
  }

  var routeId = 1;
  clusterphone.handlers.routeRequest = function(worker, requestData) {
    var method  = requestData.method,
        url     = requestData.url,
        headers = requestData.headers;

    return runRouter(method, url, headers).then(function(worker) {
      if (!worker) {
        throw new Error("No worker found.");
      }

      var newRouteId = routeId++;
      debug("Created new routeId " + newRouteId, method, url, headers);

      return serverMap[worker.id].then(function(connectionDetails) {
        return {
          workerId: worker.id,
          connection: connectionDetails,
          routeId: newRouteId
        };
      });
    });
  };

  clusterphone.handlers.passConnection = function(worker, request, connection) {
    var destWorkerId = request.workerId,
        routeId = request.routeId;


    debug("Passing connection for routeId " + routeId + " off to worker " + destWorkerId);

    if (!connection) {
      debug("WEIRDNESS: asked to pass off a nonexistent connection for routeId " + routeId + ". FIXME.");
      return Promise.resolve();
    }

    connection._handle.readStop();

    var destWorker = cluster.workers[destWorkerId];

    if (!destWorker) {
      // Presumably, the originating worker proxied a request to dest worker
      // that caused it to error and terminate by the time we got around to 
      // sending it the connection.
      debug("ERROR: Connection pass for routeId " + routeId + " was destined for a nonexistent worker.");

      // TODO: handle this better? Form a basic 503 response?
      connection.destroy();
      return Promise.resolve();
    }

    var connectionData = {
      routeId: routeId,
      buffered: request.buffered
    };

    return clusterphone.sendTo(destWorker, "connection", connectionData, connection).ackd().catch(function() {
      debug("Failed to pass off connection to worker.");
    });
  };

  clusterphone.handlers.passUpgrade = function(requestData, socket) {
    debug("Routing upgrade.");

    var method  = requestData.method,
        url     = requestData.url,
        headers = requestData.headers;

    return runRouter(method, url, headers).then(function(worker) {
      if (!worker) {
        debug("Worker not found.");
        socket.destroy();
        return;
      }

      return clusterphone.sendTo(worker, "upgrade", requestData, socket).ackd();
    });
  };

  cluster.on("online", initWorker);
  cluster.on("fork", setupWorker);

  return api;
};
