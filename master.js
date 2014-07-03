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
  serverMap[worker.id] = null;
}

function setupWorker(worker) {
  worker.on("exit", cleanupWorker);
}

function createWorkerServer(worker) {
  // We won't resolve the promise until the worker has responded that they
  // have created the server.
  var serverDeferred = Promise.defer();
  serverMap[worker.id] = serverDeferred.promise;

  var socketFile = path.join(socketDir, "worker-" + worker.id + ".sock");

  fs.unlinkAsync(socketFile).finally(function() {
    return clusterphone.sendTo(worker, "createServer", { path: socketFile }).then(function() {
      serverDeferred.resolve(socketFile);
    });
  }).catch(function() {});  // Ugly I know, only way I could find to STFU bluebird.
}

function runRouter(method, url, headers) {
  var deferred = Promise.defer();

  var routerMethod = Promise.method(exports.router);
  deferred.resolve(routerMethod(method, url, headers, deferred.callback));

  return deferred.promise.catch(function() {
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

clusterphone.handlers.routeConnection = function(message) {
  debug("Routing connection.");

  return runRouter(message.method, message.url, message.headers).then(function(worker) {
    if (!worker) {
      return {error: "No worker found."};
    }

    return serverMap[worker.id].then(function(path) {
      return {id: worker.id, path: path};
    });
  });
};

clusterphone.handlers.passConnection = function(message, connection) {
  debug("Passing a connection off.");

  var workerId = message.id;
  var worker = cluster.workers[workerId];

  if (!worker) {
    debug("Tried to pass a connection off to a nonexistent worker.");
    // TODO: handle this better? Form a basic 503 response?
    connection.destroy();
  }

  clusterphone.sendTo(worker, "connection", {}, connection);

  return Promise.resolve();
};

clusterphone.handlers.passUpgrade = function(message, socket) {
  debug("Routing upgrade.");

  return runRouter(message.method, message.url, message.headers).then(function(worker) {
    if (!worker) {
      debug("Router directed upgrade to nonexistent worker id.");
      socket.destroy();
      return;
    }

    clusterphone.sendTo(worker, "upgrade", message, socket);
  });
};

cluster.on("online", createWorkerServer);
cluster.on("fork", setupWorker);
