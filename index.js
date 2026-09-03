const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/api/status") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    });

    res.end(JSON.stringify({
      system: "777",
      status: "online",
      monitoring: [
        "market-signals",
        "political-signals",
        "corporate-events",
        "global-market-timing"
      ],
      time: new Date().toISOString()
    }));

    return;
  }

  const filePath = path.join(__dirname, "public", "index.html");

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Server error");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`777 running on port ${PORT}`);
});
