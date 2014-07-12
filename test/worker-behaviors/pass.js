"use strict";

// A worker behaviour that listens for connections and passes them off.

var hotpotato = require("../../hotpotato");
var server = require("http").createServer();
var cluster = require("cluster");

var bouncer = hotpotato("test", {
  strategies: ["proxying"],
  proxyMaxSockets: parseInt(process.env.PROXY_MAX_SOCKETS, 10) || 1
});
bouncer.bindTo(server);

server.on("request", function(req, res) {
  if (/^\/passme/.test(req.url)) {
    return bouncer.passRequest(req, res);
  }
  else if (/^\/passconn/.test(req.url)) {
    if (parseInt(req.url[req.url.length-1], 10) !== cluster.worker.id) {
    return bouncer.passConnection(req, res);
    }
  }

  res.writeHead(200);
  var data = "";
  req.setEncoding("utf8");
  req.on("data", function(chunk) {
    data += chunk;
  });

  req.on("end", function() {
    res.end(JSON.stringify({
      me: cluster.worker.id,
      headers: req.headers,
      body: data
    }));
  });
});

server.on("upgrade", function(req, socket, head) {
  bouncer.passUpgrade(req, socket, head);
});

if (process.env.LISTEN) {
  server.listen();
}
