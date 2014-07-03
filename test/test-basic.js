"use strict";

var Promise = require("bluebird"),
    cluster = require("cluster"),
    net     = require("net"),
    hotpotato = require("../hotpotato");

// TODO: test larger chunked bodies are correctly handled.
// TODO: test passing to a nonexistent worker.
// TODO: test passing to worker that is failing.
// TODO: test timeouts
// TODO: test websockets

var expect = require("chai").expect;
var common = require("./common");

describe("Basic handoff", function() {
  before(function() {
    cluster.setupMaster({
      exec: __dirname + "/worker-entrypoint.js"
    });
  });

  beforeEach(function() {
    hotpotato.router = function() { return -1; };
  });

  afterEach(function() {
    Object.keys(cluster.workers).forEach(function(workerId) {
      cluster.workers[workerId].kill();
    });
  });

  it("router receives correct params", function() {
    var routerCalled = false;
    var routerDeferred = Promise.defer();
    hotpotato.router = function(method, url, headers) {
      routerCalled = true;
      try {
        expect(method).to.eql("OPTIONS");
        expect(url).to.eql("/foo/passme");
        expect(headers).to.have.property("foo", "bar");
      } catch(e) {
        routerDeferred.reject(e);
        return -1;
      }
      routerDeferred.resolve();
      return -1;
    };

    return Promise.all([routerDeferred.promise, common.spawnListenPasser(function(listenWorker, req) {
      return req("OPTIONS", "/foo/passme", {foo: "bar"})
        .then(function() {
          expect(routerCalled, "Router called").to.be.true;
        });
    })]);
  });

  it ("works correctly", function() {
    var worker = common.spawnNotifierWorker(function(method, url, headers) {
      expect(method).to.eql("OPTIONS");
      expect(url).to.eql("/foo/passme");
      expect(headers).to.have.property("foo", "bar");
    });

    hotpotato.router = function() {
      return worker.id;
    };

    return common.spawnListenPasser(function(listenWorker, req) {
      return req("OPTIONS", "/foo/passme", {foo: "bar"})
        .then(function(response) {
          expect(response.statusCode).to.eql(200);
          expect(response.text).to.eql("worker" + worker.id);
        });
    });
  });

  it("only hands off first request", function() {
    var worker = common.spawnNotifierWorker();

    var passed = 0;
    hotpotato.router = function() {
      passed++;
      return worker.id;
    };

    return common.spawnListenPasser(function(listenWorker, req) {
      return req("GET", "/foo/passme").then(function(response) {
        expect(response.text).to.eql("worker" + worker.id);

        return req("GET", "/foo/direct").then(function(response2) {
          expect(response2.text).to.eql("worker" + listenWorker.id);
        });
      });
    });
  });

  it("hands off connection correctly", function() {
    var worker = common.spawnNotifierWorker();

    hotpotato.router = function() {
      return worker.id;
    };

    return common.spawnListenPasser(function(listenWorker, req) {
      return Promise.all([
        req("GET", "/foo/passall").then(function(response) {
          expect(response.text).to.eql("worker" + worker.id);
        }),
        req("GET", "/foo/arbitrary").then(function(response) {
          expect(response.text).to.eql("worker" + worker.id);
        })
      ]);
    });
  });

  it("handles request handoffs from pipelined requests correctly", function() {
    var worker = common.spawnNotifierWorker();

    hotpotato.router = function() {
      return worker.id;
    };

    var HTTPParser = process.binding('http_parser').HTTPParser;

    return common.spawnListenPasser(function(listenWorker, req) {
      // Node http impl doesn't do pipelining.
      var deferred = Promise.defer();
      var conn = net.createConnection(req.port);

      conn.write("GET /passme HTTP/1.1\r\n\r\n");
      conn.write("GET /foo HTTP/1.1\r\n\r\n");

      var parser = new HTTPParser(HTTPParser.RESPONSE);

      conn.on("data", function(data) {
        parser.execute(data, 0, data.length);
      });

      // If this test starts being flakey, we have to stop being lazy and handle
      // onHeaders too.
      var responses = [];
      parser.onHeadersComplete = function(info) {
        responses.push(info);
        info.body = "";
      };
      parser.onBody = function(body, start, len) {
        responses[responses.length-1].body += body.slice(start, start + len);
      };
      parser.onMessageComplete = function() {
        if (responses.length === 2) {
          var response1 = responses[0],
              response2 = responses[1];

          expect(response1.body).to.eql("worker" + worker.id);
          expect(response2.body).to.eql("worker" + listenWorker.id);
          deferred.resolve();
        }
      };

      return deferred.promise;
    });
  });

  it("handles connection handoffs from pipelined requests correctly", function() {
    var worker = common.spawnNotifierWorker();

    hotpotato.router = function() {
      return worker.id;
    };

    var HTTPParser = process.binding('http_parser').HTTPParser;

    return common.spawnListenPasser(function(listenWorker, req) {
      // Node http impl doesn't do pipelining.
      var deferred = Promise.defer();
      var conn = net.createConnection(req.port);

      conn.write("GET /passall HTTP/1.1\r\n\r\n");
      conn.write("GET /foo HTTP/1.1\r\n\r\n");

      var parser = new HTTPParser(HTTPParser.RESPONSE);

      conn.on("data", function(data) {
        parser.execute(data, 0, data.length);
      });

      // If this test starts being flakey, we have to stop being lazy and handle
      // onHeaders too.
      var responses = [];
      parser.onHeadersComplete = function(info) {
        responses.push(info);
        info.body = "";
      };
      parser.onBody = function(body, start, len) {
        responses[responses.length-1].body += body.slice(start, start + len);
      };
      parser.onMessageComplete = function() {
        if (responses.length === 2) {
          var response1 = responses[0],
              response2 = responses[1];

          expect(response1.body).to.eql("worker" + worker.id);
          expect(response2.body).to.eql("worker" + worker.id);
          deferred.resolve();
        }
      };

      return deferred.promise;
    });
  });
});