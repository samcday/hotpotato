// This is the entrypoint when we fork workers for our tests.
process._debugPort = 5858 + require("cluster").worker.id

require("./worker-behaviors/" + process.env.BEHAVIOR);
