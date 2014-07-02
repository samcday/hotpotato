"use strict";

// This example shows how you can "sticky" connections to specific workers
// based on a query string.

var hotpotato = require("../hotpotato"),
    http = require("http"),
    cluster = require("cluster"),
    url = require("url");

if (cluster.isMaster) {
  hotpotato.router = function(method, reqUrl, headers) {
    var workerIds = Object.keys(cluster.workers);
    reqUrl = url.parse(reqUrl, true);
    return reqUrl.query.worker;
  };

  cluster.fork();
  cluster.fork();
  cluster.fork();
} else {
  var server = http.createServer(function(req, res) {
    var reqUrl = url.parse(req.url, true);

    if (!req.headers["x-hotpotato-worker"]) {
      if (reqUrl.query.worker && parseInt(reqUrl.query.worker, 10) !== cluster.worker.id) {
        return hotpotato.passConnection(req, res);
      }
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

  if(cluster.worker.id === 1) {
    server.listen(3000);
  }
}
