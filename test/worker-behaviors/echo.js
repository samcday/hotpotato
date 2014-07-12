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

var paused = [];

clusterphone.handlers.resume = function() {
  paused.forEach(function(req) {
    req.resume();
  });

  paused = [];
};

var wss = new WebSocketServer({noServer: true});

server.on("request", function(req, res) {
  if (req.headers.pauseme) {
    req.pause();
    paused.push(req);
  }

  if (req.headers.error) {
    throw new Error();
  }

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

  clusterphone.sendToMaster("incomingReq");
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

    socket.on("end", function() {
      socket.destroy();
    });
  }
});

clusterphone.handlers.ping = function() {
  return Promise.resolve("pong");
};

if (process.env.LISTEN) {
  server.listen();
}
