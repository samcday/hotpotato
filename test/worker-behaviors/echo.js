"use strict";

var hotpotato = require("../../hotpotato");
var server = require("http").createServer();
var cluster = require("cluster");
var WebSocketServer = require("ws").Server;

var bouncer = hotpotato("test", {
  strategies: ["proxying"]
});
bouncer.bindTo(server);

var wss = new WebSocketServer({noServer: true});

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

server.on("upgrade", function(req, socket, head) {
  wss.handleUpgrade(req, socket, head, function(websocket) {
    websocket.send(JSON.stringify({
      me: cluster.worker.id,
      method: req.method,
      headers: req.headers,
      body: head.toString("utf8")
    }));
  });
});

if (process.env.LISTEN) {
  server.listen();
}
