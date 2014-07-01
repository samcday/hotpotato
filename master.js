var Promise = require("bluebird"),
    cluster = require("cluster"),
    debug   = require("debug"),
    temp    = require("temp"),
    path    = require("path"),
    msgs    = require("./messaging");

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