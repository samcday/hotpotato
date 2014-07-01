// Hypothesis: pause()ing a connection allows you to still write to it, but not
// pull incoming bytes off it.

var net = require("net");
var server = net.createServer();

server.listen(3000);

server.on("listening", function() {
    server.on("connection", function(socket) {
        socket.pause();
        var writer = setInterval(socket.write.bind(socket, "Hello!"), 1000);
        socket.setEncoding("utf8");
        socket.on("data", console.log.bind(console, "Server got data"));

        socket.on("end", server.close.bind(server));
        setTimeout(clearTimeout.bind(null, writer), 4000);
        setTimeout(socket.resume.bind(socket), 3000);
    });

    var client = net.createConnection({port: 3000});
    client.on("connect", function() {
        var writer = setInterval(client.write.bind(client, "Hello!"), 1);
        client.setEncoding("utf8");
        client.on("data", console.log.bind(console, "Client got data"));
        setTimeout(clearTimeout.bind(null, writer), 4000);
        setTimeout(client.end.bind(client), 5000);
    });
});