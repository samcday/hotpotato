"use strict";

// Hypothesis: passing a net.Server bound to a unix socket to a cluster worker is broken.

var net = require("net"),
    cluster = require("cluster"),
    fs = require("fs");


if (cluster.isMaster) {

  var server;

  var worker = cluster.fork();
  worker.on("online", function() {
  server = net.createServer();

  try { fs.unlinkSync("/tmp/test.socket"); } catch (e) {}
  server.listen("/tmp/test.socket", function() {
    console.log("Listening?");
    server.on("connection", function() {
      console.log("master got connection.");
    });

      // setTimeout(function() {
        worker.send("foo", server);
      // }, 500);
    });
  });

  worker.on("message", function() {
    setTimeout(function() { server.close(); }, 1000);
  });
} else {
  process.on("message", function(msg, fd) {
    // console.log(fd.address());
    fd.address = function() {
      console.log("sigh...");
      return {port: -1};
    };
    console.log("Worker msg.");
    // var server = net.createServer();
    // server.listen(fd);

    process.send("foo");
    fd.on("connection", function(s) {
      console.log("Worker got connection.");
      s.end();
    });
  });
  // var server1 = net.createServer();
  // server1.listen("/tmp/test.socket");
  // server1.on("listening", function() {
  //   console.log("server1 listening", server1._handle);
  //   server1.on("connection", function(s) { console.log("server1 connection"); s.end(); });

  //   var server2 = net.createServer();
  //   server2.listen(server1);
  //   server2.on("listening", function() {
  //     console.log("server2 listening", server2._handle);
  //     server2.on("connection", function(s) { console.log("server2 connection"); s.end(); });
  //   });
  // });
}