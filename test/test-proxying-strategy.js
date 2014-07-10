"use strict";

var hotpotato = require("../hotpotato"),
    cluster = require("cluster"),
    common = require("./common");

var bouncer = hotpotato("test", {
  strategies: ["proxying"]
});

describe("hotpotato proxy strategy", function() {
  before(function() {
    cluster.setupMaster({
      exec: __dirname + "/worker-entrypoint.js"
    });
  });

  it.only("bounces requests correctly", function() {
    var worker1 = common.spawn("pass", true); //cluster.fork({BEHAVIOR: "pass", LISTEN: 1});
    var worker2 = common.spawn("echo"); //cluster.fork({BEHAVIOR: "echo"});

    bouncer.router(function() {
      return worker2.id;
    });

    common.requestToWorker({}).then(function(req) {
      console.log(req);
    });
  });
});
