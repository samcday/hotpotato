"use strict";

// A worker behaviour that listens for connections and passes them off.

var hotpotato = require("../../hotpotato");
var server = require("http").createServer();
var cluster = require("cluster");

var bouncer = hotpotato("test", {
  strategies: ["proxying"]
});
bouncer.bindTo(server);

server.on("request", function(req, res) {
  req.headers["x-from"] = cluster.worker.id;

  if (/^\/passme/.test(req.url)) {
    return bouncer.passRequest(req, res);
  }
  else if (/^\/passconn/.test(req.url)) {
    if (parseInt(req.url[req.url.length-1], 10) !== cluster.worker.id) {
    return bouncer.passConnection(req, res);
    }
  }
  res.writeHead(200);
  res.end("worker" + cluster.worker.id);
});


if (process.env.LISTEN) {
  server.listen();
}
