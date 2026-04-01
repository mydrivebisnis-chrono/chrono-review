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
const { handleConnection, handleHttpMessage, getWsByToken } = require("./services/wsService");

// ── Helper: parse JSON body dari HTTP request ─────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    // ── CORS headers ──────────────────────────────────────────────────
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Health check ──────────────────────────────────────────────────
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
      return;
    }

    // ── HTTP→WS bridge: POST /api/send ────────────────────────────────
    // Flutter kirim message via HTTP karena WS client→server tidak jalan
    // di Cloud Run. Backend route ke handler WS yang sama.
    if (req.url === "/api/send" && req.method === "POST") {
      try {
        const body = await parseBody(req);
        const sessionToken = (req.headers["authorization"] || "").replace("Bearer ", "").trim();

        if (!sessionToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing Authorization header" }));
          return;
        }

        const ws = getWsByToken(sessionToken);
        if (!ws) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found — reconnect WebSocket" }));
          return;
        }

        if (body.type !== "gps_update") {
          console.log(`[HTTP→WS] type="${body.type}" session=${sessionToken.slice(0, 8)}...`);
        }

        // Route message melalui handler WS yang sama
        const result = await handleHttpMessage(ws, body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result || { ok: true }));
      } catch (err) {
        console.error("[HTTP→WS] Error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
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
    console.log(`  HTTP→WS:    POST http://localhost:${config.PORT}/api/send`);
    console.log(`  WebSocket:   ws://localhost:${config.PORT}`);
  });
}

module.exports = { createServer };
