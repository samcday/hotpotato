"use strict";

var hotpotato = require("../../hotpotato");
var server = require("http").createServer();
var cluster = require("cluster");

var bouncer = hotpotato("test");
bouncer.bindTo(server);

server.on("request", function(req, res) {
  res.writeHead(200);
  res.end("worker" + cluster.worker.id);
});

if (process.env.LISTEN) {
  server.listen();
}
