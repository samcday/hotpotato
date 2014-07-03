"use strict";

var Promise = require("bluebird"),
    net     = require("net"),
    http    = require("http"),
    cluster = require("cluster"),
    debug   = require("debug"),
    shimmer = require("shimmer"),
    clusterphone = require("clusterphone").ns("hotpotato");

// TODO: use a separate agent for all proxy requests.
// TODO: clean up socket state on finished pass.
// TODO: figure out how we handle failed passes gracefully.

var worker = cluster.worker;
var workerDebug = debug("hotpotato:worker" + worker.id);

// This will run a http.Server listening on the separate socket the master
// directs us to.
var sideChannelServer;

// This is the actual server that is handling requests in caller. We pump
// sidechanneled requests into this. We also attach the transferred connection
// to this server.
var targetServer;

function setupSideChannelServer(socketPath) {
  workerDebug("Creating side-channel server");

  var deferred = Promise.defer();

  // TODO: This is some epic fucking hax. But I couldn't figure out how else
  // to create a Server that doesn't get shared with master.
  sideChannelServer = http.createServer();
  var handle = net._createServerHandle(socketPath, -1, -1, undefined);
  sideChannelServer._listen2(null, null, null, -1, handle.fd);

  sideChannelServer.on("connection", function(connection) {
    connection._hotpotato = {
      isRerouted: true
    };
  });

  sideChannelServer.on("request", function(req, res) {
    if (!targetServer) {
      workerDebug("Side channel request received, but no dest server to forward to.");
      // TODO: properly handle this.
      req.abort();
      res.writeHead(500);
      res.end();
    }

    // TODO: I think this is safe - keep-alive on the internal side-channel
    // connections should be fine. Without this, pipelined requests from the
    // remote client will break.
    var shouldKeepAlive = req.headers["x-hotpotato-keepalive"] === "true";
    res.shouldKeepAlive = shouldKeepAlive;
    targetServer.emit("request", req, res);
  });

  sideChannelServer.on("listening", deferred.callback);

  return deferred.promise;
}

clusterphone.handlers.createServer = function(msg) {
  return setupSideChannelServer(msg.path);
};

clusterphone.handlers.connection = function(msg, socket) {
  workerDebug("Got a new connection passed to me.");

  if (!targetServer) {
    // TODO: handle me.
    workerDebug("Ouch. No target server for a newly handed off connection.");
    return;
  }

  targetServer.emit("connection", socket);
};

clusterphone.handlers.upgrade = function(msg, socket) {
  workerDebug("Got a new upgrade passed to me.");

  if (!targetServer) {
    // TODO: handle me.
    workerDebug("No target server to handle upgrade.");
    socket.close();
    return;
  }

  // Reconstruct the request.
  var req = new http.IncomingMessage(socket);
  req.httpVersionMinor = msg.httpVersionMinor;
  req.httpVersionMajor = msg.httpVersionMajor;
  req.httpVersion = msg.httpVersionMajor + "." + msg.httpVersionMinor;
  req.headers = msg.headers;
  req.url = msg.url;

  var head;
  if (msg.head) {
    head = new Buffer(msg.head, "base64");
  }
  targetServer.emit("upgrade", req, socket, head);
};

function connectionHandler(connection) {
  connection._hotpotato = {
    pendingReqs: []
  };

  // The idea here is to shim the parser onHeaders / onHeadersComplete events.
  // When they're called we mark the request as "parsing". When we've fully
  // received the request, we check if we've already begun parsing again.
  // This can happen if we get pipelined requests.
  var shim = function(original) {
    return function() {
      connection._hotpotato.parsing = true;
      original.apply(this, arguments);
    };
  };

  shimmer.wrap(connection.parser, "onHeaders", shim);
  shimmer.wrap(connection.parser, "onHeadersComplete", shim);
}

function handlePassingRequest(req, res) {
  var deferred = Promise.defer(),
      socket = req.connection;

  req.headers["X-HOTPOTATO-WORKER"] = cluster.worker.id;
  req.headers["X-HOTPOTATO-KEEPALIVE"] = res.shouldKeepAlive;

  // Open a connection to the target and proxy the inbound request to it.
  var proxyReq = http.request({
    socketPath: req._hotpotato.proxyTo,
    path: req.url,
    method: req.method,
    headers: req.headers
  });

  req.pipe(proxyReq);

  proxyReq.on("error", function() {
    // TODO: cleanup here.
    workerDebug("Incoming request errored while we were proxying it.");
  });

  // Once we've finished sending the request over the wire, we might want to
  // pause the connection in preparation for a handover.
  req.on("end", function() {
    if (socket._hotpotato.passConnection && !socket._hotpotato.parsing && !socket._hotpotato.pendingReqs.length) {
      // Okay. We finished proxying this request, and we're not already parsing
      // another. Pause the connection so that we don't pull anything else 
      // off it.
      req.pause();
      socket.parser.pause();
    }
  });

  // Once we get a response from the target worker, we proxy that over to the 
  // client.
  proxyReq.on("response", function(proxyResp) {
    // TODO: write status reason phrase if exists.
    res.writeHead(proxyResp.statusCode, proxyResp.headers);
    // TODO: error handling on pipe.
    proxyResp.pipe(res);
    proxyResp.on("end", function() {
      if (socket._hotpotato.passConnection && !socket._hotpotato.parsing && !socket._hotpotato.pendingReqs.length) {
        workerDebug("Passing off a connection.");
        // The connection needs to be passed to the new worker, *and* this is 
        // a good time to do it. So let's do it.
        clusterphone.sendToMaster("passConnection", { id: req._hotpotato.targetWorker }, socket);

        // Cleanup the socket from our end.
        socket.emit("close");
      }

      // We have now finished proxying this request.
      // If we're attempting to pass off this connection though, we're not done
      // until all pending requests have been proxied and finished up.
      if (socket._hotpotato.passConnection) {
        if (socket._hotpotato.pendingReqs.length) {
          var next = socket._hotpotato.pendingReqs.shift();
          var nextReq = next[0], nextRes = next[1];
          nextReq._hotpotato = {
            targetWorker: req._hotpotato.targetWorker,
            proxyTo: req._hotpotato.proxyTo
          };
          deferred.resolve(handlePassingRequest(nextReq, nextRes));
        }
      }
      deferred.resolve();
    });
  });

  return deferred.promise;
}

// TODO: what happens if a second request is passed from the same
// connection whilst one is still in progress?

// This handles the process of passing off the given request to another worker.
// It can also operate in a mode where it passes off the whole connection to 
// the new worker.
function pass(passConnection, req, res) {
  workerDebug("Passing off a request.");

  var socket = req.connection;

  // Sanity checks.
  if (socket._hotpotato.isRerouted) {
    throw new Error("Attempting to pass a request that was already passed from another worker. This is not supported.");
  }
  if (req._hotpotato) {
    throw new Error("Looks like pass was called on same request more than once.");
  }

  // Set up state.
  req._hotpotato = {};

  if (passConnection) {
    socket._hotpotato.passConnection = true;
    // Reset the parsing flag.
    socket._hotpotato.parsing = false;

    socket.on("__hotpotato-request", function(req, res) {
      socket._hotpotato.parsing = false;
      socket._hotpotato.pendingReqs.push([req, res]);
    });
  }

  // Make sure we don't read anything off connection whilst we're asking master
  // where to route this request to.
  req.pause();

  clusterphone.sendToMaster("routeConnection", {
    method: req.method,
    url: req.url,
    headers: req.headers
  }).then(function(routeReply) {
    if (routeReply.error) {
      // TODO: handle this better.
      workerDebug("Failed to pass off connection: " + routeReply.error);
      res.writeHead(500);
      res.end();
      return;
    }

    req._hotpotato.targetWorker = routeReply.id;
    req._hotpotato.proxyTo = routeReply.path;

    // It's safe to resume the request now.
    req.resume();

    handlePassingRequest(req, res);
  });
}

function setServer(server) {
  if (targetServer) {
    targetServer.removeListener("connection", connectionHandler);
  }
  targetServer = server;
  targetServer.on("connection", connectionHandler);

  // This is a little hacky, but hear me out.
  // If the caller opts to passAll() on a request, it means that the current
  // request and all subsequent requests for that connection should be 
  // bounced elsewhere. The problem is, we might get two requests in rapid
  // succession (pipelined), or a request that comes in whilst we're still 
  // finishing up flushing out a response (keep-alive requests on a good 
  // network). In this case we don't want to emit request events for that
  // connection anymore. This is how we filter those out.
  shimmer.wrap(server, "emit", function(original) {
    return function(event, req, res) {
      // If we don't own this server anymore, then skip this.
      if (targetServer !== this) {
        return original.apply(this, arguments);
      }

      if ((event === "request") && req && req.connection &&
          req.connection._hotpotato && req.connection._hotpotato.passConnection) {
        return req.connection.emit("__hotpotato-request", req, res);
      }

      return original.apply(this, arguments);
    };
  });
}

function passUpgrade(req, socket, head) {
  workerDebug("Passing off an upgrade.");

  if (req._hotpotato) {
    throw new Error("Looks like passUpgrade was called on same request more than once.");
  }

  req._hotpotato = {};

  clusterphone.sendToMaster ("passUpgrade", {
    method: req.method,
    url: req.url,
    headers: req.headers,
    httpVersionMinor: req.httpVersionMinor,
    httpVersionMajor: req.httpVersionMajor,
    head: head ? head.toString("base64") : null,
  }, socket);
}

exports.passRequest = pass.bind(null, false);
exports.passConnection = pass.bind(null, true);
exports.passUpgrade = passUpgrade;
exports.server = setServer;
