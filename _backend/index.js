"use strict";

if (process.env.TTS_SA_KEY) {
  process.env.TTS_SA_KEY = Buffer.from(process.env.TTS_SA_KEY, "base64").toString("utf8");
}
if (process.env.GCP_VERTEX_SA_KEY) {
  process.env.GCP_VERTEX_SA_KEY = Buffer.from(process.env.GCP_VERTEX_SA_KEY, "base64").toString("utf8");
}

const http = require("http");
const { WebSocketServer } = require("ws");
const config = require("./config/env");
const { handleConnection } = require("./services/wsService");

function createServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => handleConnection(ws, req));

  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(config.PORT, () => {
    console.log(`Chrono backend listening on port ${config.PORT}`);
    console.log(`  HTTP health: http://localhost:${config.PORT}/health`);
    console.log(`  WebSocket:   ws://localhost:${config.PORT}`);
  });
}

module.exports = { createServer };
