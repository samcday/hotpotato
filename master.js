"use strict";

var Promise = require("bluebird"),
    cluster = require("cluster"),
    debug   = require("debug"),
    temp    = require("temp"),
    path    = require("path"),
    fs      = Promise.promisifyAll(require("fs")),
    clusterphone = require("clusterphone").ns("hotpotato");

// TODO: handle edge case of router sending request to originating worker.

var masterDebug = debug("hotpotato:master");

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

clusterphone.handlers.routeConnection = function(message) {
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
    return Promise.resolve({error: "No worker found."});
  }

  return serverMap[workerId].then(function(path) {
    return {id: workerId, path: path};
  });
};

clusterphone.handlers.passConnection = function(message, fd) {
  masterDebug("Passing a connection off.");

  var workerId = message.id;
  var worker = cluster.workers[workerId];

  if (!worker) {
    // TODO: handle me.
    masterDebug("Tried to pass a connection off to a nonexistent worker.");
  }

  clusterphone.sendTo(worker, "connection", {}, fd);
};

clusterphone.handlers.passUpgrade = function(message, fd) {
  masterDebug("Routing upgrade.");

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
    return Promise.resolve({error: "No worker found."});
  }

  clusterphone.sendTo(worker, "upgrade", message, fd);
};

cluster.on("online", createWorkerServer);
cluster.on("fork", setupWorker);
