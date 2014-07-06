"use strict";

var hotpotato = require("../../hotpotato");
var server = require("http").createServer();
var cluster = require("cluster");

hotpotato.server(server);

server.on("request", function(req, res) {
  res.writeHead(200);
  res.end("worker" + cluster.worker.id);
});

server.listen();
