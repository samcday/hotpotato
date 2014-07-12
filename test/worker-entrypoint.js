"use strict";

// This is the entrypoint when we fork workers for our tests.
process._debugPort = 5858 + require("cluster").worker.id

require("./worker-behaviors/" + process.env.BEHAVIOR);


process.on("uncaughtException", function() {
  console.log("Well, that sucks.");
  process.exit(1);
});