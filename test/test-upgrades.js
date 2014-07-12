"use strict";

var upgradeConcurrencyNum = 1000,
    upgradeConcurrencyRounds = 10;

var Promise = require("bluebird"),
    hotpotato = require("../hotpotato"),
    cluster = require("cluster"),
    http = require("http"),
    WebSocket = require("ws"),
    common = require("./common");

var clusterphone = require("clusterphone").ns("hotpotato-test");
var expect = require("chai").expect;
var bouncer = hotpotato("test");

describe("hotpotato Upgrade handling", function() {
  before(function() {
    cluster.setupMaster({
      exec: __dirname + "/worker-entrypoint.js"
    });
  });

  beforeEach(function() {
    this.listenPass = common.spawn("pass", true);
    this.echo = common.spawn("echo");

    return Promise.all([
      common.waitForWorker(this.listenPass, true),
      common.waitForWorker(this.echo),
    ]);
  });

  afterEach(function() {
    Object.keys(cluster.workers).forEach(function(workerId) {
      try {
        cluster.workers[workerId].kill();
      } catch(e) {}
    });
  });

  it("passes upgrades correctly", function() {
    var self = this;

    bouncer.router(function() {
      return self.echo.id;
    });

    return new Promise(function(resolve) {
      var ws = new WebSocket("ws://localhost:" + self.listenPass.port);
      ws.on("message", function(data) {
        resolve([ws, JSON.parse(data)]);
      });
    }).spread(function(ws, data) {
      expect(data.me).to.eql(self.echo.id);
    });
  });

  // it("manages errored upgrade connections correctly", function(done) {
  it("handles upgrades that die during handoff gracefully", function(done) {
    var self = this;

    var req = http.request({
      port: self.listenPass.port,
      headers: {
        Connection: "upgrade",
        Upgrade: "foo"
      }
    });
    req.end();

    bouncer.router(function() {
      req.socket.end();
      return self.echo.id;
    });

    req.on("error", function() {
      // Ensure the worker didn't die.
      Promise.delay(300).then(function() {
        return clusterphone.sendTo(self.echo, "ping").ackd();
      }).then(function(reply) {
        expect(reply).to.eql("pong");
        done();
      });
    });
  });

  it("gracefully handles routing failure during handoff", function() {
    var self = this;

    bouncer.router(function() {
      throw new Error("Explosions!");
    });

    var req = http.request({
      port: self.listenPass.port,
      headers: {
        Connection: "upgrade",
        Upgrade: "foo"
      }
    });
    req.end();

    return new Promise(function(resolve) {
      req.on("response", function(response) {
        expect(response.statusCode).to.eql(503);
        resolve();
      });
    });
  });

  it("behaves correctly with many concurrent connections", function() {
    this.timeout(5 * 60 * 1000);

    var self = this;

    bouncer.router(function() {
      return self.echo.id;
    });

    var runRound = function(resolve) {
      var promises = [];
      var created = 0;
      var create = function() {
        var i = created++;
        if (i > upgradeConcurrencyNum) {
          return Promise.all(promises).then(resolve);
        }

        promises.push(new Promise(function(resolve) {
          var data = "test" + (Math.random() * i);

          var req = http.request({
            port: self.listenPass.port,
            method: "POST",
            agent: false,
            headers: {
              Connection: "upgrade",
              Upgrade: "bacon",
              "Content-Length": data.length
            }
          });
          req.write(data);
          req.end();

          req.on("response", function(resp) {
            var respText = "";
            resp.setEncoding("utf8");
            resp.on("data", function(chunk) {
              respText += chunk;
            });
            resp.on("end", function() {
              expect(respText).to.eql(data);
              req.socket.destroy();

              setTimeout(function() {
                resolve();
              }, 5000);
            });
          });
        }));

        setTimeout(create, 1);
      };

      create();
    };

    var rounds = 0;
    var go = function() {
      rounds++;
      if (rounds <= upgradeConcurrencyRounds) {
        return new Promise(function(resolve) {
          runRound(resolve);
        }).then(function() {
          console.log("Upgrade perf finished round " + rounds);
          return go();
        });
      }
    };
    return go();
  });
});
