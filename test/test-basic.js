var cluster = require("cluster"),
    hotpotato = require("../hotpotato"),
    http = require("http");

var expect = require("chai").expect;

function filterWorkerMessages(fn) {
  return function(message) {
    if (!message.test) return;
    fn(message);
  }
}

describe("Basic handoff", function() {
  before(function() {
    cluster.setupMaster({
      exec: __dirname + "/worker-entrypoint.js"
    });
  });

  it ("works correctly", function(done) {
    var listener = cluster.fork({BEHAVIOR: "listen-pass"});
    var worker = cluster.fork({BEHAVIOR: "notify-received"});
    worker.on("message", filterWorkerMessages(function(msg) {
      var method = msg.test.req.method,
          url = msg.test.req.url,
          headers = msg.test.req.headers;
      expect(method).to.eql("OPTIONS");
      expect(url).to.eql("/foo/bar");
      expect(headers).to.have.property("foo", "bar");
      
      worker.send({test:"continue"})
    }));

    hotpotato.router = function(method, url, headers) {
      try {
        expect(method).to.eql("OPTIONS");
        expect(url).to.eql("/foo/bar");
        expect(headers).to.have.property("foo", "bar");
      } catch(e) {
        done(e);
      }
      return worker.id;
    };

    listener.on("listening", function(address) {
      var req = http.request({
        method: "OPTIONS",
        path: "/foo/bar",
        port: address.port,
        headers: {
          foo: "bar"
        }
      }, function(res) {
        done();
      });
      req.end();
      req.on("error", done);
    });
  });
});