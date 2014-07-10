"use strict";

// We have a few different strategies we can use to hand-off connections.
// Some of which only make sense in certain scenarios. We set up a priority 
// order for these, based on optimal case. Each strategy decides whether it can
// service the handoff request.

module.exports = {
  proxying: require("./handoff-proxying"),
};

return;

function Proxy(state) {
  internalServer.on("request", function(req, res) {
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

}

// Buffer + Pass.
// With this strategy we buffer all raw packets that have been received for an
// inbound connection. If we're asked to pass that connection, we pause the
// socket, bundle up all the buffers, and send them over to the new worker.
// This strategy will only work if its a connection pass and it's done on the 
// FIRST request over the wire, since Node's HTTP parser doesn't give us enough
// information to demarcate two incoming requests and throw away buffers for old
// ones.
function ConnectionBuffering(state) {
  return {
    handles: function() {
      return false;
    }
  };
}

// Upgrades.
// Upgrades are pretty easy, since we're given the request data + initial buffer.
// We handle this by pausing underlying connection and passing the socket + 
// passing initial data, very similar to Buffer + Pass strategy, except in this
// case it's okay if the upgrade request isn't the first req on the connection.
function Upgrade(state) {
  return {
    handles: function() {
      return false;
    }
  }
}

module.exports = [Upgrades, ConnectionBuffering, Proxy];
