"use strict";

// Buffer + Pass.
// With this strategy we buffer all raw packets that have been received for an
// inbound connection. If we're asked to pass that connection, we pause the
// socket, bundle up all the buffers, and send them over to the new worker.
// This strategy will only work if its a connection pass and it's done on the 
// FIRST request over the wire, since Node's HTTP parser doesn't give us enough
// information to demarcate two incoming requests and throw away buffers for old
// ones.

// TODO: