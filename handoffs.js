"use strict";

// We have a few different strategies we can use to hand-off connections.
// Some of which only make sense in certain scenarios. We set up a priority 
// order for these, based on optimal case. Each strategy decides whether it can
// service the handoff request.

module.exports = {
  proxying: require("./handoff-proxying"),
};
