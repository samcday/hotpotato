"use strict";

var Promise = require("bluebird"),
    hotpotato = require("../hotpotato"),
    cluster = require("cluster"),
    Agent = require("yakaa"),
    common = require("./common");

var expect = require("chai").expect;

var bouncer = hotpotato("test", {
  strategies: ["proxying"]
});

var keepaliveAgent = new Agent({
  keepAlive: true,
  maxIdle: 1,
  maxSockets: 1
});

describe("hotpotato proxy strategy", function() {
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

  it("bounces requests correctly", function() {
    var echo = this.echo;

    bouncer.router(function() {
      return echo.id;
    });

    return common.requestToWorker(this.listenPass, { path: "/passme" })
      .then(function(req) {
        req.end();

        return common.readFully(req);
      })
      .then(function(result) {
        expect(result).to.eql("worker" + echo.id);
      });
  });

  it("only bounces first request", function() {
    var self = this;

    bouncer.router(function() {
      return self.echo.id;
    });

    return common.requestToWorker(this.listenPass, { path: "/passme", agent: keepaliveAgent })
      .then(function(req) {
        req.end();

        return common.readFully(req);
      })
      .then(function(text) {
        expect(text).to.eql("worker" + self.echo.id);
        return common.requestToWorker(self.listenPass, { path: "/foo", agent: keepaliveAgent });
      })
      .then(function(req) {
        req.end();
        return common.readFully(req);
      })
      .then(function(text) {
        expect(text).to.eql("worker" + self.listenPass.id);
      });
  });

  it("bounces connections correctly", function() {
    var self = this;

    bouncer.router(function() {
      return self.echo.id;
    });

    return common.requestToWorker(self.listenPass, { path: "/passconn", agent: keepaliveAgent })
      .then(function(req) {
        req.end();
        return common.readFully(req);
      })
      .then(function(text) {
        expect(text).to.eql("worker" + self.echo.id);
        return common.requestToWorker(self.listenPass, { path: "/foo", agent: keepaliveAgent });
      })
      .then(function(req) {
        req.end();
        return common.readFully(req);
      })
      .then(function(text) {
        expect(text).to.eql("worker" + self.echo.id);
      });
  });
});
