var Promise = require("bluebird"),
    cluster = require("cluster"),
    http    = require("http");

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

exports.spawnListenPasser = function(cb) {
  var listener = cluster.fork({BEHAVIOR: "listen-pass"});
  var deferred = Promise.defer();
  listener.on("listening", function(address) {
    var requestFn = function(method, url, headers) {
      var reqDeferred = Promise.defer();
      var req = http.request({
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
    deferred.resolve(cb(requestFn));
  });
  return deferred.promise;
}