"use strict";

// This example shows how you can "sticky" connections to specific workers
// based on a query string.

var hotpotato = require("../hotpotato"),
    http = require("http"),
    cluster = require("cluster"),
    ws = require("ws"),
    url = require("url");

if (cluster.isMaster) {
  hotpotato.router = function() {
    return 2;
  };

  cluster.fork();
  cluster.fork();
  cluster.fork();
} else {
  var wsServer = new ws.Server({noServer: true});

  var server = http.createServer(function(req, res) {
    res.writeHead(200);
    res.end("Hello.");
  });

  server.on("upgrade", function(req, socket, head) {
    // console.log("Upgrade!", req.headers);
    if (cluster.worker.id !== 2) {
      return hotpotato.passUpgrade(req, socket, head);
    }

    wsServer.handleUpgrade(req, socket, head, function(websocket) {
      websocket.send("Hello from " + cluster.worker.id);
    });
  });

  hotpotato.server(server);

  if(cluster.worker.id === 1) {
    server.listen(3000);
  }
}
