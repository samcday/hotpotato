"use strict";

// TODO: handle no router.
// TODO: handle edge case of router sending request to originating worker.

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

  return api;
};
