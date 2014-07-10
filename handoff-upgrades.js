"use strict";

// Upgrades.
// Upgrades are pretty easy, since we're given the request data + initial buffer.
// We handle this by pausing underlying connection and passing the socket + 
// passing initial data, very similar to Buffer + Pass strategy, except in this
// case it's okay if the upgrade request isn't the first req on the connection.

// TODO: