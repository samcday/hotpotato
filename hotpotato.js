"use strict";

// TODO: handle worker death.
// TODO: handle timeouts to acks.
// TODO: default router.
// TODO: don't allow requests to be passed if data has already been read from them.
// TODO: handle upgrades.

var cluster = require("cluster");

module.exports = function(id) {
  if (cluster.isMaster) {
    return require("./master")(id);
  } else {
    return require("./worker")(id);
  }
};
