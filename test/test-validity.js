"use strict";

var cluster = require("cluster"),
    hotpotato = require("../hotpotato"),
    http = require("http");

var expect = require("chai").expect;

var numWorkers = 4;
var numRequests = 500;
var agent = new http.Agent({maxSockets: 50});

describe("hotpotato correctness tests", function() {
  this.timeout(0);

  before(function() {
    cluster.setupMaster({
      exec: __dirname + "/worker-entrypoint.js"
    });
  });

  it("passRequest operates correctly under high load", function(done) {
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
            console.log("/" + id + " got a socket.");
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

      for(var i = 0; i < numRequests; i++) {
        runRequest(i, (i % numWorkers) + 1);
      }
    });
  });
});
