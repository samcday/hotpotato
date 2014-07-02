"use strict";

var Promise = require("bluebird"),
    cluster = require("cluster"),
    hotpotato = require("../hotpotato");

// TODO: test larger chunked bodies are correctly handled.
// TODO: test pipelined requests.
// TODO: test passing to a nonexistent worker.
// TODO: test passing to worker that is failing.
// TODO: test timeouts

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
});