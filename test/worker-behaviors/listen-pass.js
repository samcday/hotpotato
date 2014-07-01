// A worker behaviour that listens for connections and passes them off.

var hotpotato = require("../../hotpotato");
var server = require("http").createServer();

hotpotato.server(server);

server.on("request", function(req, res) {
  if (/passme$/.test(req.url))
    return hotpotato.pass(req, res);
  res.writeHead(200);
  res.end("direct");
});

server.listen();
