"use strict";

var Promise = require("bluebird"),
    http    = require("http"),
    cluster = require("cluster"),
    debug   = require("debug"),
    shimmer = require("shimmer"),
    Agent   = require("yakaa"),
    debug   = debug("hotpotato:worker" + cluster.worker.id),
    clusterphone = require("clusterphone").ns("hotpotato");

var HTTPParser = process.binding('http_parser').HTTPParser;

// TODO: clean up socket state on finished pass.
// TODO: figure out how we handle failed passes gracefully.

// This will run a http.Server listening on the separate socket the master
// directs us to.
var sideChannelServer;

// This is the http.Agent we use when talking to intra-cluster workers.
// It pools connections and keeps them alive for a configrable timeout.
// This is preferable over Node.js default Agent, which *does* use keep-alive,
// but will close a socket if there's no requests queued up to use it.
// The max-sockets here is on a per host basis.
var workerAgent = new Agent({
    maxSockets: 100,
    maxFreeSockets: 100,
    keepAlive: true,
    keepAliveTimeoutMsecs: 10000
});

// This is the actual server that is handling requests in caller. We pump
// sidechanneled requests into this. We also attach the transferred connection
// to this server.
var targetServer;

function setupSideChannelServer() {
  debug("Creating side-channel server");

  sideChannelServer = http.createServer();
  // Regular listen() call results in net module asking cluster to step in and
  // get the master to create server FD for us. Which we don't want.
  sideChannelServer._listen2("127.0.0.1", 0, null, -1);

  sideChannelServer.on("connection", function(connection) {
    connection._hotpotato = {
      isRerouted: true
    };
  });

  sideChannelServer.on("request", function(req, res) {
    var routeId = req.headers["x-hotpotato-routeid"];

    if (!targetServer) {
      debug("Side channel request for " + routeId + " received, but no dest server to forward to.");
      // TODO: properly handle this.
      req.abort();
      res.writeHead(500);
      res.end();
    }

    // TODO: I think this is safe - keep-alive on the internal side-channel
    // connections should be fine. Without this, pipelined requests from the
    // remote client will break.
    // var shouldKeepAlive = req.headers["x-hotpotato-keepalive"] === "true";
    // res.shouldKeepAlive = shouldKeepAlive;

    // TODO: we should handle this on the proxying side, not here.
    res.shouldKeepAlive = true;

    debug("Side channel got request for routeId " + routeId);
    targetServer.emit("request", req, res);
  });

  return new Promise(function(resolve) {
    sideChannelServer.on("listening", function() {
      var address = sideChannelServer.address();
      var connectionDetails = {
        host: address.address,
        port: address.port
      };
      resolve(connectionDetails);
    });
  });
}

clusterphone.handlers.init = function() {
  return setupSideChannelServer();
};

clusterphone.handlers.connection = function(connectionData, socket) {
  try {
    var routeId = connectionData.routeId;

    if (!targetServer) {
      // TODO: handle me.
      debug("Ouch. No target server for connection.");
      return Promise.resolve();
    }

    if (!socket) {
      debug("Connection for routeId " + routeId + " died by the time it made it to us.");
      return Promise.resolve();
    }

    debug("Connection " + socket.remoteAddress + ":" + socket.remotePort + " for routeId " + routeId + " passed to me.");

    targetServer.emit("connection", socket);

    connectionData.buffered.forEach(function(buffer) {
      buffer = new Buffer(buffer, "base64");
      console.log(socket.remoteAddress + ":" + socket.remotePort, "data", buffer.toString("utf8"));
      socket.ondata(buffer, 0, buffer.length);
    });

    return Promise.resolve();
  }
  catch(e) {
    console.log("OHSNAP.");
    console.log(e);
    console.log(e.stack);
  }
};

clusterphone.handlers.upgrade = function(requestData, socket) {
  debug("Got an upgrade passed to me.");

  if (!targetServer) {
    // TODO: handle me.
    debug("No target server to handle upgrade.");
    socket.close();
    return;
  }

  // Reconstruct the request.
  var req = new http.IncomingMessage(socket);
  req.httpVersionMinor = requestData.httpVersionMinor;
  req.httpVersionMajor = requestData.httpVersionMajor;
  req.httpVersion = req.httpVersionMajor + "." + req.httpVersionMinor;
  req.headers = requestData.headers;
  req.url = requestData.url;

  var head;
  if (requestData.head) {
    head = new Buffer(requestData.head, "base64");
  }

  targetServer.emit("upgrade", req, socket, head);

  return Promise.resolve();
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

  if (HTTPParser.kOnHeadersComplete) {
    shimmer.wrap(connection.parser, HTTPParser.kOnHeaders, shim);
    shimmer.wrap(connection.parser, HTTPParser.kOnHeadersComplete, shim);
  } else {
    shimmer.wrap(connection.parser, "onHeaders", shim);
    shimmer.wrap(connection.parser, "onHeadersComplete", shim);
  }
}

function handlePassingRequest(req, res) {
  var deferred = Promise.defer(),
      routeId = req._hotpotato.routeId,
      targetWorker = req._hotpotato.targetWorker,
      socket = req.connection,
      socketAddress = socket.remoteAddress + ":" + socket.remotePort;

  req.headers["X-HOTPOTATO-WORKER"] = cluster.worker.id;
  req.headers["X-HOTPOTATO-ROUTEID"] = routeId;
  req.headers["X-HOTPOTATO-KEEPALIVE"] = res.shouldKeepAlive;

  debug("Proxying request for routeId " + routeId + " from " + socketAddress + " to worker " + targetWorker);

  // Open a connection to the target and proxy the inbound request to it.
  var proxyReq = http.request({
    agent: workerAgent,
    host: req._hotpotato.proxyTo.host,
    port: req._hotpotato.proxyTo.port,
    path: req.url,
    method: req.method,
    headers: req.headers
  });

  req.pipe(proxyReq);

  proxyReq.on("error", function(err) {
    // TODO: cleanup here.
    debug("Proxy request for routeId " + routeId + " errored while we were proxying it.", err.stack);
  });

  // Once we've finished sending the request over the wire, we might want to
  // pause the connection in preparation for a handover.
  req.on("end", function() {
    if (socket._hotpotato.passConnection && !socket._hotpotato.parsing && !socket._hotpotato.pendingReqs.length) {
      // Okay. We finished proxying this request, and we're not already parsing
      // another. Pause the connection so that we don't pull anything else 
      // off it.
      debug("Pausing socket " +  socketAddress + " request for routeId " + routeId);

      var buffered = socket._hotpotato.buffered = [];

      socket.pause();

      if (socket._handle) {
        socket._handle.onread = function(buf, start, end) {
          if(!buf) {
            // console.log("WTF?!", arguments, new Error().stack);
            return;
          }
          buffered.push(buf.slice(start, start+end).toString("base64"));
        };
      }
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
      debug("Finishing proxying request for routeId " + routeId + " to worker " + targetWorker);
      if (socket._hotpotato.passConnection && !socket._hotpotato.parsing && !socket._hotpotato.pendingReqs.length) {
        // TODO: is this test necessary?
        if (!socket._handle) {
          // Most likely the connection was closed. That's okay.
          debug("Connection for routeId " + routeId + " died when we were supposed to pass it.");
          return;
        }

        debug("Passing off connection for routeId " + routeId);

        setTimeout(function() {
          // The connection needs to be passed to the new worker, *and* this is 
          // a good time to do it. So let's do it.
          var passRequest = {
            workerId: req._hotpotato.targetWorker,
            routeId: routeId,
            buffered: socket._hotpotato.buffered
          };

          return clusterphone.sendToMaster("passConnection", passRequest, socket).ackd().then(function() {
            // TODO: is this actually necessary? child_process closes the underlying
            // handle. Does that result in a close being emitted on the socket itself?
            // Cleanup the socket from our end.
            // socket.emit("close");
          });
        }, 100);

        return;
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
  debug("Passing off a request.");

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
      debug("Queueing up another request on connection with routeId " + req.socket._hotpotato.routeId);
      socket._hotpotato.parsing = false;
      socket._hotpotato.pendingReqs.push([req, res]);
    });
  }

  // Make sure we don't read anything off connection whilst we're asking master
  // where to route this request to.
  req.pause();

  var requestData = {
    method: req.method,
    url: req.url,
    headers: req.headers
  };

  return clusterphone.sendToMaster("routeRequest", requestData).ackd()
    .then(function(routeReply) {
      req._hotpotato.routeId = routeReply.routeId;
      req._hotpotato.targetWorker = routeReply.workerId;
      req._hotpotato.proxyTo = routeReply.connection;

      if (passConnection) {
        socket._hotpotato.routeId = routeReply.routeId;
      }

      // It's safe to resume the request now.
      req.resume();

      handlePassingRequest(req, res);
    })
    .catch(function(err) {
      // TODO: handle this better.
      debug("Failed to pass off connection: " + err.stack);
      res.writeHead(500);
      res.end();
      return;
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
  debug("Passing off an upgrade.");

  if (req._hotpotato) {
    throw new Error("Looks like passUpgrade was called on same request more than once.");
  }

  req._hotpotato = {};

  var requestData = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    httpVersionMinor: req.httpVersionMinor,
    httpVersionMajor: req.httpVersionMajor,
    head: head ? head.toString("base64") : null,
  };

  return clusterphone.sendToMaster ("passUpgrade", requestData, socket).ackd();
}

exports.passRequest = pass.bind(null, false);
exports.passConnection = pass.bind(null, true);
exports.passUpgrade = passUpgrade;
exports.server = setServer;
