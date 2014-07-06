"use strict";

var cluster = require("cluster"),
    hotpotato = require("../hotpotato"),
    http = require("http");

var expect = require("chai").expect;

var numWorkers = 4;
var numRequests = 50;
var agent = new http.Agent({maxSockets: 10});

describe("hotpotato correctness tests", function() {
  this.timeout(6000);

  before(function() {
    cluster.setupMaster({
      exec: __dirname + "/worker-entrypoint.js",
      args: [""]
    });
  });

  it("passRequest operates correctly under high load", function(done) {
    hotpotato.router = function(method, url, headers) {
      return parseInt(headers["x-worker-id"], 10);
    };

    for (var i = 0; i < numWorkers; i++) {
      cluster.fork({BEHAVIOR: "correctness"});
    }

    var workersOnline = 0;

    cluster.on("listening", function(worker, address) {
      workersOnline++;
      if (workersOnline < numWorkers) {
        return;
      }

      var completedRequests = 0;
      var pendingIds = {};

      var runRequest = function(id, worker) {
        pendingIds[id] = true;
        var req = http.get({
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
        req.on("response", function(resp) {
          delete pendingIds[id];
          var data = "";
          resp.setEncoding("utf8");
          resp.on("data", function(chunk) {
            data += chunk;
          });
          resp.on("end", function() {
            // expect(data).to.eql("worker"+worker);
          });

          completedRequests++;
          if (completedRequests === numRequests) {
            done();
          }
        });
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
