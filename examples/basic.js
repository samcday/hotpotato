"use strict";

// This example shows how you can bounce connections from one worker to another.

var hotpotato = require("../hotpotato"),
    http = require("http"),
    cluster = require("cluster");

var bouncer = hotpotato("example");

if (cluster.isMaster) {
  bouncer.router(function() {
    return 2;
  });

  cluster.fork();
  cluster.fork();
} else {
  var server = http.createServer(function(req, res) {
    console.log(cluster.worker.id + " got " + req.url, req.headers);

    if (cluster.worker.id === 1) {
      return bouncer.passConnection(req, res);
    }

    var body = [];
    req.setEncoding("utf8");
    req.on("data", function(data) {
      console.log("req data.");
      body.push(data);
    });
    req.on("end", function() {
      res.writeHead(200);
      res.end(JSON.stringify({
        me: cluster.worker.id,
        body: body.join(""),
        from: req.headers["x-hotpotato-worker"],
        headers: req.headers
      }));
    });
  });

  bouncer.bindTo(server);

  if(cluster.worker.id === 1) {
    server.listen(3000);
  }
}
