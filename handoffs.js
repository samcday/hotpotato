"use strict";

// We have a few different approaches we can use to hand-off connections.
// Some of which only make sense in certain scenarios.

// Standard proxying.
// Not exactly a naive http proxy though. We have an internal pool of 
// connections between each of our workers that we forward requests over.
// However, the forwarding isn't 1:1, we actually multiplex in-flight requests
// over this internal pool. This is to ensure that a long polling request
// doesn't hog one of the internal connections.
function Proxy(server) {


  // setup: function() {

  // },
  // supports: function() {
  //   return true;
  // },
  // handle: function(req, res) {

  // }
}

module.exports = [Proxy];