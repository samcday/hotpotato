"use strict";

var Promise = require("bluebird"),
    hotpotato = require("../hotpotato"),
    cluster = require("cluster"),
    Agent = require("yakaa"),
    common = require("./common"),
    clusterphone = require("clusterphone").ns("hotpotato-test");

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

  it("handles slow inbound requests correctly", function() {
    var self = this;

    bouncer.router(function() {
      return self.echo.id;
    });

    return common.requestToWorker(this.listenPass, { method: "POST", path: "/passme", agent: keepaliveAgent })
      .then(function(req) {
        req.write("Hello, ");
        return Promise.delay(1000).then(function() {
          req.write("world!");
          req.end();
          return common.readFullyJSON(req);
        });
      })
      .spread(function(response, result) {
        expect(result.me).to.eql(self.echo.id);
        expect(result.body).to.eql("Hello, world!");
      });
  });

  it("does not block internal queue when a request trickles in", function() {
    var self = this;

    bouncer.router(function() {
      return self.echo.id;
    });

    var reqOpts = { method: "POST", path: "/passme" };

    var firstReq;

    return common.requestToWorker(self.listenPass, reqOpts).then(function(req) {
      firstReq = req;
      req.write("slooooooow");
      return Promise.delay(200);
    }).then(function() {
      return common.requestToWorker(self.listenPass, reqOpts);
    }).then(function(req2) {
      req2.write("ok2");
      req2.end();

      return common.readFullyJSON(req2);
    }).spread(function(response, data) {
      expect(data.body).to.eql("ok2");
      firstReq.end();
      return common.readFullyJSON(firstReq);
    }).spread(function(response, data) {
      expect(data.body).to.eql("slooooooow");
    });
  });

  it("allows pausing of request on proxied end", function() {
    var self = this;

    bouncer.router(function() {
      return self.echo.id;
    });

    var reqOpts = {
      path: "/passme",
      method: "PUT",
      headers: {
        host: "foo.bar",
        awesome: "sauce",
        pauseme: "please?"
      }
    };

    return common.requestToWorker(this.listenPass, reqOpts)
      .then(function(req) {
        req.write("Hello, world!");
        req.end();

        req.on("response", function() {
          throw new Error("Shouldn't have gotten a response yet.");
        });

        return Promise.delay(req, 100); // TODO: not ideal. Should wait for a signal from worker.
      })
      .then(function(req) {
        clusterphone.sendTo(self.echo, "resume");
        req.removeAllListeners("response");
        return common.readFullyJSON(req);
      })
      .spread(function(response, result) {
        expect(response.statusCode).to.eql(203);
        expect(result.me).to.eql(self.echo.id);
        expect(result.body).to.eql("Hello, world!");
      });
  });

  xit("handles client errors gracefully");
  xit("times out upstream requests");

  // TODO: fix me!
  xit("recovers from failure on proxy end", function() {
    var self = this;

    bouncer.router(function() {
      return self.echo.id;
    });

    var reqOpts = {
      path: "/passme",
      headers: {
        host: "foo.bar",
        awesome: "sauce",
        error: "explosions!"
      }
    };

    return common.requestToWorker(this.listenPass, reqOpts)
      .then(function(req) {
        req.end();
        return common.readFullyJSON(req);
      })
      .spread(function(response) {
        expect(response.statusCode).to.eql(503);
      });
  });

  it("passes requests correctly with many concurrent connections", function() {
    var self = this;

    bouncer.router(function() {
      return self.echo.id;
    });

    var promises = [];

    for (var i = 0; i < 200; i++) {
      (function(i) {
        var reqOpts = {
          path: "/passme",
          method: "PUT",
          headers: {
            host: "foo.bar",
            awesome: "sauce"
          }
        };

        promises.push(common.requestToWorker(self.listenPass, reqOpts)
          .then(function(req) {
            req.write("Hello, world! " + i);
            req.end();

            return common.readFullyJSON(req);
          })
          .spread(function(response, result) {
            expect(response.statusCode).to.eql(203);
            expect(result.me).to.eql(self.echo.id);
            expect(result.method).to.eql("PUT");
            expect(result.body).to.eql("Hello, world! " + i);
            expect(result.headers).to.eql({
              host: "foo.bar",
              awesome: "sauce",
              connection: "keep-alive",   // TODO: this is actually wrong. FIXME.
              "transfer-encoding": "chunked"
            });
          }));
      })(i);
    }

    return Promise.all(promises);
  });
});
