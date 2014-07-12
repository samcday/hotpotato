"use strict";

// We can have different strategies we use to hand-off connections.
// Some of which only make sense in certain scenarios. We set up a priority 
// order for these, based on optimal case. Each strategy decides whether it can
// service the handoff request.

// Upgrades are a special case that are handled in one specific way in hotpotato.js

module.exports = {
  proxying: require("./handoff-proxying"),
};
