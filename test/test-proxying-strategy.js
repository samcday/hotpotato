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

  it("passes requests with correct data", function() {
    var echo = this.echo;

    bouncer.router(function() {
      return echo.id;
    });

    var reqOpts = {
      path: "/passme",
      method: "PUT",
      headers: {
        host: "foo.bar",
        awesome: "sauce"
      }
    };

    return common.requestToWorker(this.listenPass, reqOpts)
      .then(function(req) {
        req.write("Hello, world!");
        req.end();

        return common.readFullyJSON(req);
      })
      .spread(function(response, result) {
        expect(response.statusCode).to.eql(203);
        // expect(response.reasonPhrase).to.eql("bacon");   // LAME - node http client doens't expose reason phrase!
        expect(result.me).to.eql(echo.id);
        expect(result.method).to.eql("PUT");
        expect(result.body).to.eql("Hello, world!");
        expect(result.headers).to.eql({
          host: "foo.bar",
          awesome: "sauce",
          connection: "keep-alive",   // TODO: this is actually wrong. FIXME.
          "transfer-encoding": "chunked"
        });
      });
  });

  it("passes connections with correct data", function() {
    var self = this;

    bouncer.router(function() {
      return self.echo.id;
    });

    var reqOpts = {
      path: "/passconn",
      method: "PUT",
      agent: keepaliveAgent,
      headers: {
        host: "foo.bar",
        awesome: "sauce"
      }
    };

    return common.requestToWorker(self.listenPass, reqOpts)
      .then(function(req) {
        req.write("Hello, world!");
        req.end();
        return common.readFullyJSON(req);
      })
      .spread(function(response, result) {
        expect(response.statusCode).to.eql(203);
        expect(result.me).to.eql(self.echo.id);
        expect(result.method).to.eql("PUT");
        expect(result.body).to.eql("Hello, world!");
        expect(result.headers).to.eql({
          host: "foo.bar",
          awesome: "sauce",
          connection: "keep-alive",
          "transfer-encoding": "chunked"
        });

        reqOpts = {
          path: "/foo",
          method: "PUT",
          agent: keepaliveAgent,
          headers: {
            host: "bar.foo",
            sauce: "awesome"
          }
        };
        return common.requestToWorker(self.listenPass, reqOpts);
      })
      .then(function(req) {
        req.write("Hello, world!");
        req.end();
        return common.readFullyJSON(req);
      })
      .spread(function(response, result) {
        expect(response.statusCode).to.eql(203);
        expect(result.me).to.eql(self.echo.id);
        expect(result.method).to.eql("PUT");
        expect(result.body).to.eql("Hello, world!");
        expect(result.headers).to.eql({
          host: "bar.foo",
          sauce: "awesome",
          connection: "keep-alive",
          "transfer-encoding": "chunked"
        });
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

        return common.readFullyJSON(req);
      })
      .spread(function(response, result) {
        expect(result.me).to.eql(self.echo.id);
        return common.requestToWorker(self.listenPass, { path: "/foo", agent: keepaliveAgent });
      })
      .then(function(req) {
        req.end();
        return common.readFullyJSON(req);
      })
      .spread(function(response, result) {
        expect(result.me).to.eql(self.listenPass.id);
      });
  });
});
