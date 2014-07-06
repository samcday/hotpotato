"use strict";

var Promise = require("bluebird"),
    cluster = require("cluster"),
    net     = require("net"),
    http    = require("http"),
    hotpotato = require("../hotpotato");

var foreverAgent = require("yakaa")({
  keepAlive: true,
  keepAliveTimeoutMsecs: 30000
});

// TODO: test larger chunked bodies are correctly handled.
// TODO: test passing to a nonexistent worker.
// TODO: test passing a request to a dying worker.
// TODO: test passing a connection to a dying worker.
// TODO: test passing a request to a worker that is timing out.
// TODO: test timeouts
// TODO: test passing a connection that is Connection:close
// TODO: test websockets

var expect = require("chai").expect;
var common = require("./common");

function readResponse(response) {
  return new Promise(function(resolve) {
    var data = "";
    response.setEncoding("utf8");
    response.on("data", function(chunk) {
      data += chunk;
    });
    response.on("end", function() {
      resolve(data);
    });
  });
}

describe("hotpotato", function() {
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

  // TODO: midnight coding resulted in this madness. Please clean me up.
  it("passes connections between workers correctly", function(done) {
    hotpotato.router = function() {
      return new Promise(function(resolve) {
        var secondWorker = cluster.fork({BEHAVIOR: "listen-echo"});
        secondWorker.on("listening", function() {
          resolve(secondWorker.id);
        });
      });
    };

    var firstWorker = cluster.fork({BEHAVIOR: "listen-pass"});
    firstWorker.on("listening", function(address) {
      var request = http.get({
        agent: foreverAgent,
        port: address.port,
        path: "/passall"
      });

      var reqSocket;
      request.on("socket", function() {
        reqSocket = request.connection;
      });

      request.on("response", function(resp) {
        readResponse(resp).then(function(firstReply) {
          var req2 = http.get({
            agent: foreverAgent,
            port: address.port,
            path: "/again"
          });
          req2.on("socket", function() {
            expect(req2.connection).to.eql(reqSocket);
          });
          req2.on("response", function(resp2) {
            readResponse(resp2).then(function(reply2) {
              expect(reply2).to.eql(firstReply);
              done();
            });
          });
        });
      });
    });
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

  // TODO: Uh. This is working, but the debug logs for it look pretty suspicious.
  // Why is routeid null?
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