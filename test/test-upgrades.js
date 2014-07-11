"use strict";

var Promise = require("bluebird"),
    hotpotato = require("../hotpotato"),
    cluster = require("cluster"),
    WebSocket = require("ws"),
    common = require("./common");

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
      common.waitForWorker(this.echo)
    ]);
  });

  afterEach(function() {
    Object.keys(cluster.workers).forEach(function(workerId) {
      cluster.workers[workerId].kill();
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

  xit("manages errored upgrade connections correctly");
  xit("handles upgrades that die during handoff gracefully");
  xit("gracefully handles routing failure during handoff");
  xit("behaves correctly with many concurrent connections");
});
