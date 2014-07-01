// This is the entrypoint when we fork workers for our tests.

require("./worker-behaviors/" + process.env.BEHAVIOR);