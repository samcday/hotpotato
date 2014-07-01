var Promise = require("bluebird"),
    net     = require("net"),
    http    = require("http"),
    cluster = require("cluster"),
    debug   = require("debug"),
    shimmer = require("shimmer"),
    msgs    = require("./messaging");

var worker = cluster.worker;
var workerDebug = debug("hotpotato:worker" + worker.id);

// This will run a http.Server listening on the separate socket the master
// directs us to.
var sideChannelServer;

// This is the actual server that is handling requests in caller. We pump
// sidechanneled requests into this. We also attach the transferred connection
// to this server.
var targetServer;

var setupSideChannelServer = function(socketPath) {
  workerDebug("Creating side-channel server");

  var deferred = Promise.defer();

  // TODO: This is some epic fucking hax. But I couldn't figure out how else
  // to create a Server that doesn't get shared with master.
  sideChannelServer = http.createServer();
  var handle = net._createServerHandle(socketPath, -1, -1, undefined);
  sideChannelServer._listen2(null, null, null, -1, handle.fd);

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
    res.shouldKeepAlive = true;
    targetServer.emit("request", req, res);
  });

  sideChannelServer.on("listening", deferred.callback);

  return deferred.promise;
};

msgs.handlers.createServer = function(ack, msg) {
  setupSideChannelServer(msg.path).then(function() {
    ack();
  });
};

var connectionHandler = function(connection) {
  connection._hotpotato = {};

  // The idea here is to shim the parser onHeaders / onHeadersComplete events.
  // When they're called we mark the request as "parsing". When we've fully
  // received the request, we check if we've already begun parsing again.
  // This can happen if we get pipelined requests.
  var shim = function(original) {
    return function() {
      connection._hotpotato.parsing = true;
      original.apply(this, arguments);
    }
  };

  shimmer.wrap(connection.parser, "onHeaders", shim);
  shimmer.wrap(connection.parser, "onHeadersComplete", shim);
}

var pass = function(req, res) {
  workerDebug("Passing off a connection.");

  // Reset the parsing flag.
  req.connection._hotpotato.parsing = false;

  msgs.sendToMaster("routeConnection", {
    method: req.method,
    url: req.url,
    headers: req.headers
  }).then(function(resp) {
    req.resume();

    if (resp.error) {
      workerDebug("Failed to pass off connection: " + resp.error);
      res.writeHead(500);
      res.end();
    }

    req.headers["X-HOTPOTATO-WORKER"] = cluster.worker.id;

    var proxyReq = http.request({
      socketPath: resp.path,
      path: req.url,
      method: req.method,
      headers: req.headers
    });

    req.pipe(proxyReq);
    req.on("end", function() {
      // TODO: check parser state and see if we can hand-off connection here
    });

    proxyReq.on("response", function(proxyResp) {
      res.writeHead(proxyResp.statusCode, proxyResp.headers);
      proxyResp.pipe(res);
    });
  });

};

var setServer = function(server) {
  if (targetServer) {
    targetServer.removeListener("connection", connectionHandler);
  }
  targetServer = server;
  targetServer.on("connection", connectionHandler);
};

exports.pass = pass;
exports.server = setServer;
