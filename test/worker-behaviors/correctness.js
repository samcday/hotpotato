"use strict";

var hotpotato = require("../../hotpotato");
var server = require("http").createServer();
var cluster = require("cluster");

var bouncer = hotpotato("test");

bouncer.bindTo(server);

server.on("request", function(req, res) {
  console.log("Worker", cluster.worker.id, "GOT:", req.url);
  if (parseInt(req.headers["x-worker-id"], 10) !== cluster.worker.id) {
    return bouncer.passConnection(req, res);
  }
  res.writeHead(200);
  res.end("worker" + cluster.worker.id);
});

if (cluster.worker.id === 1) {
  server.listen(3000, "0.0.0.0", 2000);
}
