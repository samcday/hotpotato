"use strict";

// Hypothesis: creating multiple net.Server to listen on a unix socket does not work.

// I think this is confirmed, from what I can tell in the node 0.10 series, ondata and onconnection are overwritten in _listen2.
// This makes sense anyway, why would a single process want to have multiple listens on a single FD?!

var net = require("net"),
    fs = require("fs");

try { fs.unlinkSync("/tmp/test.socket"); } catch (e) {}

var server1 = net.createServer();
server1.listen("/tmp/test.socket");
server1.on("listening", function() {
  console.log("server1 listening", server1._handle);
  server1.on("connection", function(s) { console.log("server1 connection"); s.end(); });

  var server2 = net.createServer();
  server2.listen(server1);
  server2.on("listening", function() {
    console.log("server2 listening", server2._handle);
    server2.on("connection", function(s) { console.log("server2 connection"); s.end(); });
  });
});
