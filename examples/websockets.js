"use strict";

// This example shows how to pass off an incoming websocket upgrade to another
// worker.

var hotpotato = require("../hotpotato"),
    http = require("http"),
    cluster = require("cluster"),
    ws = require("ws");

var bouncer = hotpotato("websockets-example");

if (cluster.isMaster) {
  bouncer.router(function() {
    return 2;
  });

  cluster.fork();
  cluster.fork();
} else {
  var wsServer = new ws.Server({noServer: true});

  var server = http.createServer(function(req, res) {
    res.writeHead(200);
    res.end("Hello.");
  });

  server.on("upgrade", function(req, socket, head) {
    if (cluster.worker.id !== 2) {
      return bouncer.passUpgrade(req, socket, head);
    }

    wsServer.handleUpgrade(req, socket, head, function(websocket) {
      websocket.send("Hello from " + cluster.worker.id);
    });
  });

  bouncer.bindTo(server);

  if(cluster.worker.id === 1) {
    server.listen(3000);
  }
}
