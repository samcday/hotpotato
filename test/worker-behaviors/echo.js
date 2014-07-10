"use strict";

var hotpotato = require("../../hotpotato");
var server = require("http").createServer();
var cluster = require("cluster");

var bouncer = hotpotato("test", {
  strategies: ["proxying"]
});
bouncer.bindTo(server);

server.on("request", function(req, res) {
  res.writeHead(203, "bacon");

  var data = "";
  req.setEncoding("utf8");
  req.on("data", function(chunk) {
    data += chunk;
  });

  req.on("end", function() {
    res.end(JSON.stringify({
      me: cluster.worker.id,
      method: req.method,
      headers: req.headers,
      body: data
    }));
  });
});

if (process.env.LISTEN) {
  server.listen();
}
