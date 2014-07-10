// This behavior will cause worker to send a message to parent when it receives a request.

var hotpotato = require("../../hotpotato");
var server = require("http").createServer();
var cluster = require("cluster");

var bouncer = hotpotato("test");
bouncer.bindTo(server);

server.on("request", function(req, res) {
  process.send({test: { req: {
    method: req.method,
    url: req.url,
    headers: req.headers
  }}});

  process.on("message", function(msg) {
    if (msg && msg.test && msg.test === "continue") {
      res.writeHead(200);
      res.end("worker" + cluster.worker.id);
    }
  });
});
