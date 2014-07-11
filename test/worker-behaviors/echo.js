"use strict";

var Promise = require("bluebird");
var hotpotato = require("../../hotpotato");
var server = require("http").createServer();
var cluster = require("cluster");
var http = require("http");
var WebSocketServer = require("ws").Server;
var clusterphone = require("clusterphone").ns("hotpotato-test");

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
  if (req.headers["sec-websocket-key"]) {
    wss.handleUpgrade(req, socket, head, function(websocket) {
      websocket.send(JSON.stringify({
        me: cluster.worker.id,
        method: req.method,
        headers: req.headers,
        body: head.toString("utf8")
      }));
    });
  } else {
    var res = new http.ServerResponse(req);
    res.assignSocket(socket);
    res.writeHead(200);
    res.end(head.toString());
  }
});

clusterphone.handlers.ping = function() {
  return Promise.resolve("pong");
};

if (process.env.LISTEN) {
  server.listen();
}
