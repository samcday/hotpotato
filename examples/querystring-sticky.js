"use strict";

// This example shows how you can "sticky" connections to specific workers
// based on a query string.

var hotpotato = require("../hotpotato"),
    http = require("http"),
    cluster = require("cluster");

if (cluster.isMaster) {
  hotpotato.router = function(method, url, headers) {
    return 1;
  };

  cluster.fork();
  cluster.fork();
} else {
  var server = http.createServer(function(req, res) {
    if (cluster.worker.id !== 1) {
        return hotpotato.pass(req, res);
    }

    var body = [];
    req.setEncoding("utf8");
    req.on("data", function(data) {
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

  hotpotato.server(server);

  if(cluster.worker.id > 1)
    server.listen(3000);
}
