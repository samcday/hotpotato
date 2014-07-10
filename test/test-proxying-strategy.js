"use strict";

var Promise = require("bluebird"),
    hotpotato = require("../hotpotato"),
    cluster = require("cluster"),
    common = require("./common");

var expect = require("chai").expect;

var bouncer = hotpotato("test", {
  strategies: ["proxying"]
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

  it.only("bounces requests correctly", function() {
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
});
