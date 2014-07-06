"use strict";

var Promise = require("bluebird"),
    cluster = require("cluster"),
    debug   = require("debug")("hotpotato:master"),
    temp    = require("temp"),
    clusterphone = require("clusterphone").ns("hotpotato");

// TODO: handle edge case of router sending request to originating worker.

temp.track();

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
  });
}

function runRouter(method, url, headers) {
  var deferred = Promise.defer();

  var routerMethod = Promise.method(exports.router);
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

var routeId = 0;
clusterphone.handlers.routeRequest = function(worker, requestData) {
  debug("Routing request.");

  var method  = requestData.method,
      url     = requestData.url,
      headers = requestData.headers;

  return runRouter(method, url, headers).then(function(worker) {
    if (!worker) {
      throw new Error("No worker found.");
    }

    return serverMap[worker.id].then(function(connectionDetails) {
      return {
        workerId: worker.id,
        connection: connectionDetails,
        routeId: routeId++
      };
    });
  });
};

clusterphone.handlers.passConnection = function(worker, request, connection) {
  var destWorkerId = request.workerId,
      routeId = request.routeId;

  debug("Passing connection for routeId " + routeId + " off to new destination.");

  if (!connection) {
    debug("WEIRDNESS: asked to pass off a nonexistent connection for routeId " + routeId + ". FIXME.");
    return Promise.resolve();
  }

  var destWorker = cluster.workers[destWorkerId];

  if (!destWorker) {
    // Presumably, the originating worker proxied a request to dest worker
    // that caused it to error and terminate by the time we got around to 
    // sending it the connection.
    debug("ERROR: Connection pass for routeId " + routeId + " was destined for a nonexistent worker.");

    // TODO: handle this better? Form a basic 503 response?
    return connection.destroy();
  }

  return clusterphone.sendTo(destWorker, "connection", routeId, connection).ackd().catch(function() {
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
