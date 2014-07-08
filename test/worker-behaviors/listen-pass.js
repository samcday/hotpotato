// A worker behaviour that listens for connections and passes them off.

var hotpotato = require("../../hotpotato");
var server = require("http").createServer();
var cluster = require("cluster");

hotpotato.server(server);

server.on("request", function(req, res) {
  req.headers["x-from"] = cluster.worker.id;

  if (/passme$/.test(req.url)) {
    return hotpotato.passRequest(req, res);
  }
  else if (/passconn$/.test(req.url)) {
    return hotpotato.passConnection(req, res);
  }
  res.writeHead(200);
  res.end("worker" + cluster.worker.id);
});

server.listen();
