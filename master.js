var Promise = require("bluebird"),
    cluster = require("cluster"),
    debug   = require("debug"),
    temp    = require("temp"),
    path    = require("path"),
    fs      = Promise.promisifyAll(require("fs")),
    msgs    = require("./messaging");

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
    return msgs.sendTo(worker, "createServer", { path: socketFile }).then(function() {
      serverDeferred.resolve(socketFile);
    });
  }).catch(function() {});  // Ugly I know, only way I could find to STFU bluebird.
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
    ack({id: workerId, path: path});
  });
};

msgs.handlers.passConnection = function(ack, message, fd) {
  masterDebug("Passing a connection off.");

  var workerId = message.id;
  var worker = cluster.workers[workerId];

  if (!worker) {
    // TODO: handle me.
    masterDebug("Tried to pass a connection off to a nonexistent worker.");
  }

  msgs.sendTo(worker, "connection", {}, fd);
};

cluster.on("online", createWorkerServer);
cluster.on("fork", setupWorker);
