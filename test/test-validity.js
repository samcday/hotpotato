"use strict";

var cluster = require("cluster"),
    hotpotato = require("../hotpotato"),
    http = require("http");

var expect = require("chai").expect;

var numWorkers = 4;
var numRequests = 100000;
var agent = new http.Agent({maxSockets: 100});

describe("hotpotato correctness tests", function() {
  this.timeout(6000000);

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

      var runRequest = function(worker) {
        var req = http.get({
          agent: agent,
          port: address.port,
          headers: {
            "x-worker-id": worker
          }
        });
        req.on("response", function(resp) {
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
            done();
          }
        });
      };

      for(var i = 0; i < numRequests; i++) {
        runRequest((i % numWorkers) + 1);
      }
    });
  });
});
