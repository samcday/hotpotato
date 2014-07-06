"use strict";

var Promise = require("bluebird"),
    cluster = require("cluster"),
    debug   = require("debug")("hotpotato:master"),
    temp    = require("temp"),
    path    = require("path"),
    fs      = Promise.promisifyAll(require("fs")),
    clusterphone = require("clusterphone").ns("hotpotato");

// TODO: handle edge case of router sending request to originating worker.

temp.track();

// This will map worker ids to the side-channel servers they are available on.
var serverMap = {};

var socketDir = temp.mkdirSync();

function cleanupWorker(worker) {
  delete serverMap[worker.id];
}

function setupWorker(worker) {
  worker.on("exit", cleanupWorker.bind(null, worker));
}

function createWorkerServer(worker) {
  // We won't resolve the promise until the worker has responded that they
  // have created the server.
  var serverDeferred = Promise.defer();
  serverMap[worker.id] = serverDeferred.promise;

  var socketFile = path.join(socketDir, "worker-" + worker.id + ".sock");

  fs.unlinkAsync(socketFile).finally(function() {
    return clusterphone.sendTo(worker, "createServer", socketFile).ackd().then(function() {
      serverDeferred.resolve(socketFile);
    });
  }).catch(function() {});  // Ugly I know, only way I could find to STFU bluebird.
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

clusterphone.handlers.routeRequest = function(worker, requestData) {
  debug("Routing request.");

  var method  = requestData.method,
      url     = requestData.url,
      headers = requestData.headers;

  return runRouter(method, url, headers).then(function(worker) {
    if (!worker) {
      throw new Error("No worker found.");
    }

    return serverMap[worker.id].then(function(path) {
      return {id: worker.id, path: path};
    });
  });
};

clusterphone.handlers.passConnection = function(worker, destWorkerId, connection) {
  debug("Passing a connection off.");

  var destWorker = cluster.workers[destWorkerId];

  if (!destWorker) {
    // Presumably, the originating worker proxied a request to dest worker
    // that caused it to error and terminate by the time we got around to 
    // sending it the connection.
    debug("Tried to pass a connection off to a nonexistent worker.");

    // TODO: handle this better? Form a basic 503 response?
    return connection.destroy();
  }

  return clusterphone.sendTo(destWorker, "connection", {}, connection).ackd();
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

cluster.on("online", createWorkerServer);
cluster.on("fork", setupWorker);
