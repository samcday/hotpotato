"use strict";

var Promise = require("bluebird"),
    cluster = require("cluster"),
    http    = require("http"),
    shimmer = require("shimmer");

exports.spawn = function(type, listen) {
  var env = {BEHAVIOR: type};
  if (listen) {
    env.LISTEN = true;
  }

  var worker = cluster.fork(env);

  worker.on("listening", function(address) {
    worker.port = address.port;
  });

  return worker;
};

exports.requestToWorker = function(worker, opts) {
  var deferred = Promise.defer();
  var go = function() {
    opts.port = worker.port;
    var req = http.request(opts);
    deferred.resolve(req);
  };

  if (worker.port) {
    go();
  } else {
    worker.on("listening", function() {
      go();
    });
  }

  return deferred.promise;
}

exports.spawnNotifierWorker = function(notify) {
  var worker = cluster.fork({BEHAVIOR: "notify-received"});

  worker.on("message", function(msg) {
    if (!msg.test) return;

    if (notify) {
      var method = msg.test.req.method,
          url = msg.test.req.url,
          headers = msg.test.req.headers;
      notify(method, url, headers);
    }

    worker.send({test:"continue"});
  });

  return worker;
}

var agent = new http.Agent({maxSockets: 1});

exports.spawnListenPasser = function(cb) {
  var listener = cluster.fork({BEHAVIOR: "pass", LISTEN: 1});
  var deferred = Promise.defer();
  listener.on("listening", function(address) {
    var requestFn = function(method, url, headers) {
      var reqDeferred = Promise.defer();
      var req = http.request({
        agent: agent,
        port: address.port,
        method: method,
        path: url,
        headers: headers
      }, function(response) {
        var data = [];
        response.setEncoding("utf8");
        response.on("data", data.push.bind(data));
        response.on("end", function() {
          response.text = data.join("");
          reqDeferred.resolve(response);
        });
      });
      req.on("error", reqDeferred.reject.bind(reqDeferred));
      req.end();
      return reqDeferred.promise;
    };
    requestFn.port = address.port;
    deferred.resolve(cb(listener, requestFn));
  });
  return deferred.promise;
}