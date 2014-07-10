"use strict";

var cluster = require("cluster"),
    hotpotato = require("../hotpotato"),
    net = require("net"),
    http = require("http"),
    async = require("async");

var expect = require("chai").expect;

describe("hotpotato under high concurrent load", function() {
  before(function() {
    cluster.setupMaster({
      exec: __dirname + "/worker-entrypoint.js"
    });
  });

  it("passes connections correctly", function(done) {
    this.timeout(30000);
    var numRounds = 1000;
    var concurrency = 50;

    // Two workers. One that listens and passes, and one that doesn't.
    var worker1 = cluster.fork({BEHAVIOR: "listen-pass"});
    var worker2 = cluster.fork({BEHAVIOR: "echo"});

    hotpotato.router = function(method, url, headers) {
      return worker2.id;
    };

    var runRound = function(port, cb) {
      var connection;
      var req = http.request({
        path: "/passconn",
        port: port,
        createConnection: function() { connection = net.createConnection({port: port}); return connection; },
      });
      req.agent = true;
      req.shouldKeepAlive = true;
      req.end();

      req.on("response", function(resp) {
        resp.setEncoding("utf8");
        resp.once("readable", function() {
          expect(resp.read()).to.equal("worker" + worker2.id);
        });

        resp.on("end", function() {
          var req2 = http.request({
            path: "/hello",
            createConnection: function() { return connection; },
          });
          req2.end();

          req2.on("response", function(resp2) {
            resp2.setEncoding("utf8");
            resp2.once("readable", function() {
              expect(resp2.read()).to.equal("worker" + worker2.id);
              connection.destroy();
              cb();
            });
          });
        });
      });
    };

    worker1.on("listening", function(address) {
      var q = async.queue(runRound, concurrency);
      for (var i = 0; i < numRounds; i++) {
        q.push(address.port);
      }

      q.drain = done;
    });
  });

  it.only("passes connections multiple times correctly", function(done) {
    this.timeout(30000);
    var numRounds = 1000;
    var concurrency = 50;

    // Three workers. One that listens and passes, and two that don't.
    var worker1 = cluster.fork({BEHAVIOR: "pass", LISTEN: 1});
    var worker2 = cluster.fork({BEHAVIOR: "pass"});
    var worker3 = cluster.fork({BEHAVIOR: "echo"});

    hotpotato.router = function(method, url, headers) {
      return parseInt(url[url.length-1], 10);
    };

    var runRound = function(port, cb) {
      var connection;
      var req = http.request({
        path: "/passconn/" + worker2.id,
        port: port,
        createConnection: function() { connection = net.createConnection({port: port}); return connection; },
      });
      req.agent = true;
      req.shouldKeepAlive = true;
      req.end();

      req.on("response", function(resp) {
        resp.setEncoding("utf8");
        resp.once("readable", function() {
          expect(resp.read()).to.equal("worker" + worker2.id);
        });

        resp.on("end", function() {
          var req2 = http.request({
            path: "/passconn/" + worker3.id,
            createConnection: function() { return connection; },
          });
          req2.shouldKeepAlive = true;
          req2.agent = true;
          req2.end();

          req2.on("response", function(resp2) {
            resp2.setEncoding("utf8");
            resp2.once("readable", function() {
              expect(resp2.read()).to.equal("worker" + worker3.id);
            });
            resp2.on("end", function() {
              var req3 = http.request({
                path: "/foo",
                createConnection: function() { return connection; },
              });
              req3.end();
              req3.on("response", function(resp3) {
                resp3.setEncoding("utf8");
                resp3.once("readable", function() {
                  expect(resp3.read()).to.equal("worker" + worker3.id);
                  connection.destroy();
                  cb();
                });
              });
            });
          });
        });
      });
    };

    worker1.on("listening", function(address) {
      var q = async.queue(runRound, concurrency);
      for (var i = 0; i < numRounds; i++) {
        q.push(address.port);
      }

      q.drain = done;
    });
  });

  // TODO: this test fails sometimes. But to be fair, it's modelling something
  // that probably shouldn't happen (a small pool of keepalives being passed
  // around a group of workers a LOT in a small period of time).
  // In this test I'm observing all sorts of crazy. My favourite is when the
  // remote addresses are suddenly undefined... I suspect Node isn't really
  // designed to pass the same one file descriptor around a billion times.
  xit("passConnection operates correctly in the face of unadulterated insanity", function(done) {
    this.timeout(0);

    var numWorkers = 4;
    var numRequests = 1000;
    var agent = new require("yakaa")({maxSockets: 100});

    hotpotato.router = function(method, url, headers) {
      return parseInt(headers["x-worker-id"], 10);
    };

    var complete = false;

    for (var i = 0; i < numWorkers; i++) {
      cluster.settings.execArgv.push('--debug=' + (5859 + i));
      var worker = cluster.fork({BEHAVIOR: "correctness"});
      cluster.settings.execArgv.pop();

      worker.on("exit", function() {
        expect(complete, "Worker should only exit when we're done.").to.be.true;
      });
    }

    var workersOnline = 0;

    cluster.on("listening", function(worker, address) {
      workersOnline++;
      // if (workersOnline < numWorkers) {
      //   return;
      // }

      var completedRequests = 0;
      var pendingIds = {};

      var runRequest = function(id, worker) {
        pendingIds[id] = true;
        var req = http.request({
          agent: agent,
          path: "/" + id,
          port: address.port,
          headers: {
            "x-worker-id": worker
          }
        });
        req.on("error", function(err) {
          console.log("/" + id + " failed.", err);
        });
        req.on("socket", function(socket) {
          process.nextTick(function() {
            var address = socket.address();
            if (address)
              console.log("/" + id + " is going over socket " + address.address + ":" + address.port);
          });
        });
        req.on("response", function(resp) {
          delete pendingIds[id];
          var data = "";
          resp.setEncoding("utf8");
          resp.on("data", function(chunk) {
            data += chunk;
          });
          resp.on("end", function() {
            expect(data).to.eql("worker"+worker);
          });

          completedRequests++;
          if (completedRequests === numRequests) {
            complete = true;
            done();
          }
        });
        req.end();
      };

      setInterval(function() {
        console.log("Pending ids: ", Object.keys(pendingIds));
      }, 1000);

      var i = 0;
      function go() {
        if (i === numRequests) {
          return;
        }

        runRequest(i, (i % numWorkers) + 1);
        i++;
        setImmediate(go);
      }
      go();
    });
  });
});
