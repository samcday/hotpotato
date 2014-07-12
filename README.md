# hotpotato

Allows you to pass a HTTP connection from one cluster worker to another.

## How?

`npm install hotpotato`


## Why?

Generally, to take advantage of Node's `cluster` module, your application needs to be architected in a ["Share Nothing"](http://en.wikipedia.org/wiki/Shared_nothing_architecture) fashion. That is, each instance of your application should not store state specific to a particular client. This approach means that if an instance goes away for whatever reason, any other instance can continue serving a particular user session. Unfortunately, this approach isn't always an option, especially if you're using a library / framework that makes this more difficult. For example, Socket.IO 1.0.


## License 

hotpotato is released under the [MIT License](LICENSE).
