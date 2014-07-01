"use strict";

// Super simple messaging layer between cluster worker <-> master.
// Messages can be sent unidirectionally, and acks can be replied.

// TODO: cleanup pendings as not everything will be ack'd.

var cluster = require("cluster"),
    Promise = require("bluebird"),
    debug = require("debug");

if (cluster.isMaster) {
  var masterDebug = debug("hotpotato:master:messaging");

  var sendTo = function(worker, cmd, payload, fd) {
    var deferred = Promise.defer(),
        seq = worker._hotpotato.seq++;

    var message = {
      _hotpotato: {
        cmd: cmd,
        seq: seq,
        payload: payload
      }
    };
    worker._hotpotato.pending[seq] = deferred;

    worker.send(message, fd);
    return deferred.promise;
  };

  var sendAck = function(worker, seq, reply) {
    worker.send({
      _hotpotato: {
        ack: seq,
        reply: reply
      }
    });
  };

  var masterMessageHandler = function(worker, message, fd) {
    if (!message || ! message._hotpotato) {
      return;
    }

    if (message._hotpotato.ack) {
      var pending = worker._hotpotato.pending[message._hotpotato.ack];
      delete worker._hotpotato.pending[message._hotpotato.ack];
      if (!pending) {
        masterDebug("Got an ack for a message that wasn't pending. Dropping it on the floor.");
        return;
      }
      pending.resolve(message._hotpotato.reply);
      return;
    }

    var cmd = message._hotpotato.cmd;
    if (!exports.handlers[cmd]) {
      masterDebug("Got cmd " + cmd + " but had no handler for it.");
      return;
    }

    var seq = message._hotpotato.seq,
        ack = sendAck.bind(null, worker, seq);

    exports.handlers[cmd](ack, message._hotpotato.payload, fd);
  };

  var setupWorkerMessaging = function(worker) {
    worker._hotpotato = {
      seq: 1,
      pending: {}
    };
    worker.on("message", masterMessageHandler.bind(null, worker));
  };

  cluster.on("fork", setupWorkerMessaging);

  exports.handlers = {};
  exports.sendTo = sendTo;
} else {
  var worker = cluster.worker;
  var workerDebug = debug("hotpotato:worker" + worker.id + ":messaging");
  var pendings = {},
      seqCounter = 1;

  var sendToMaster = function(cmd, payload, fd) {
    var deferred = Promise.defer();

    var seq = seqCounter++;
    var message = {
      _hotpotato: {
        seq: seq,
        cmd: cmd,
        payload: payload
      }
    };
    pendings[seq] = deferred;

    process.send(message, fd);
    return deferred.promise;
  };

  var sendAck = function(seq, reply) {
    process.send({
      _hotpotato: {
        ack: seq,
        reply: reply
      }
    });
  };

  var messageHandler = function(message, fd) {
    if (!message || !message._hotpotato) {
      return;
    }

    if (message._hotpotato.ack) {
      var pending = pendings[message._hotpotato.ack];
      delete pendings[message._hotpotato.ack];
      if (!pending) {
        workerDebug("Got an ack for a message that wasn't pending.");
        return;
      }
      pending.resolve(message._hotpotato.reply);
      return;
    }

    var handler = exports.handlers[message._hotpotato.cmd];
    if (!handler) {
      workerDebug("Got a message I can't handle: " + message._hotpotato.cmd);
      return;
    }

    var ack = sendAck.bind(null, message._hotpotato.seq);
    handler(ack, message._hotpotato.payload, fd);
  };

  process.on("message", messageHandler);

  exports.handlers = {};
  exports.sendToMaster = sendToMaster;
}
