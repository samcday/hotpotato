"use strict";

var hotpotato = require("../../hotpotato");
var server = require("http").createServer();
var cluster = require("cluster");

hotpotato.server(server);

server.on("request", function(req, res) {
  console.log("GOT:", req.url);
  if (parseInt(req.headers["x-worker-id"], 10) !== cluster.worker.id) {
    return hotpotato.passConnection(req, res);
  }
  res.writeHead(200);
  res.end("worker" + cluster.worker.id);
});

server.listen(0, "0.0.0.0", 2000);
