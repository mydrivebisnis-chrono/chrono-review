"use strict";

/**
 * wsService.js — WebSocket message router
 *
 * [AUTH-A] Shared secret auth (Opsi A — jangka pendek, tanpa login screen):
 *   Backend verifikasi token === WS_SHARED_SECRET via timingSafeEqual.
 *   Tidak ada Supabase round-trip → auth_ok < 1ms setelah token diterima.
 *
 * [BUG-003] NODE_ENV gate:
 *   development  = bypass aktif
 *   production   = wajib kirim WS_SHARED_SECRET
 *
 * [SEC-001] Rate limiting per koneksi (tanpa library):
 *   tts_request : min 3000ms
 *   gps_update  : min 800ms
 */

const { timingSafeEqual } = require("crypto");
const { getRoute }        = require("./routeService");
const { processGpsUpdate } = require("./navService");
const { synthNavTts }     = require("./ttsService");
const geminiService       = require("./geminiService");
const conductor           = require("./conductor");

// ── Shared secret [AUTH-A] ────────────────────────────────────────────────
const WS_SHARED_SECRET = (process.env.WS_SHARED_SECRET || "").trim();

const IS_DEV = process.env.NODE_ENV === "development";

if (IS_DEV) {
  console.warn("\x1b[31m%s\x1b[0m", "[WsService] 🔴 DEV AUTH BYPASS AKTIF");
} else if (!WS_SHARED_SECRET) {
  console.error("[Auth] FATAL: WS_SHARED_SECRET tidak di-set di production!");
  process.exit(1);
}

// ── Rate limit config [SEC-001] ───────────────────────────────────────────
const RL = {
  tts_request: 3000,
  gps_update:   800,
};

function checkRateLimit(ws, type) {
  const minInterval = RL[type];
  if (!minInterval) return true;
  const now = Date.now();
  if (!ws.rl) ws.rl = {};
  const last = ws.rl[type] || 0;
  if (now - last < minInterval) return false;
  ws.rl[type] = now;
  return true;
}

// ── handleConnection ──────────────────────────────────────────────────────
function handleConnection(ws) {
  ws.mode        = "idle";
  ws.voiceActive = false;
  ws.rl          = {};

  if (IS_DEV) {
    ws.authenticated = true;
    ws.userId        = "dev";
    console.warn("[WsService] DEV: koneksi baru — bypass aktif");
  } else {
    ws.authenticated = false;
    ws.userId        = null;
  }

  ws.on("message", async (raw) => {
    if (Buffer.isBuffer(raw) || raw instanceof ArrayBuffer) {
      if (!ws.authenticated) return;
      if (ws.voiceActive && ws.mode === "nav") {
        const session = geminiService.getSession(ws.sessionId);
        if (!session?.navStatus?.chirpActive) {
          geminiService.sendAudioChunk(
            ws.sessionId,
            Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
          );
        }
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", code: "INVALID_JSON", message: "Could not parse JSON" }));
      return;
    }

    try {
      switch (msg.type) {
        case "auth":
          handleAuth(ws, msg);
          break;

        case "ping":
          ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
          break;

        default: {
          if (!ws.authenticated) {
            ws.send(JSON.stringify({
              type:    "error",
              code:    "UNAUTHORIZED",
              message: "Kirim { type: 'auth', token: '<shared_secret>' } terlebih dahulu",
            }));
            return;
          }

          switch (msg.type) {
            case "nav_start":
              await startNavigation(ws, msg);
              break;

            case "gps_update":
              if (!checkRateLimit(ws, "gps_update")) return;
              await handleGpsUpdateMsg(ws, msg);
              break;

            case "nav_stop":
              if (ws.mode === "nav") stopNavigation(ws);
              break;

            case "tts_request":
              if (ws.mode !== "nav") return;
              if (!checkRateLimit(ws, "tts_request")) {
                console.log(`[TTS] Rate limited — drop ${(msg.request_id || "").toString()}`);
                return;
              }
              await handleTtsRequest(ws, msg);
              break;

            case "voice_start":
              if (ws.mode !== "nav") {
                ws.send(JSON.stringify({ type: "error", code: "VOICE_NOT_READY", message: "Navigation not active" }));
                return;
              }
              await startVoiceStream(ws);
              break;

            case "voice_stop":
              ws.voiceActive = false;
              ws.send(JSON.stringify({ type: "voice_stopped" }));
              break;

            case "chirp_done":
              if (ws.sessionId) conductor.onChirpEnd(ws.sessionId, ws);
              break;

            default:
              ws.send(JSON.stringify({ type: "error", code: "UNKNOWN_TYPE", message: `Unknown type: ${msg.type}` }));
          }
        }
      }
    } catch (err) {
      console.error("[WS] handler error:", err.message);
      ws.send(JSON.stringify({ type: "error", code: "INTERNAL", message: err.message }));
    }
  });

  ws.on("close", () => {
    if (ws.trafficTimer) clearInterval(ws.trafficTimer);
    if (ws.sessionId) {
      geminiService.destroySession(ws.sessionId);
      conductor.destroySession(ws.sessionId);
    }
  });
}

// ── Auth handler [AUTH-A] ─────────────────────────────────────────────────
// Sync — tidak ada await, tidak ada network call. auth_ok < 1ms.
function handleAuth(ws, msg) {
  if (IS_DEV) {
    ws.authenticated = true;
    ws.send(JSON.stringify({ type: "auth_ok" }));
    return;
  }

  const token = (msg.token || "").toString().trim();
  if (!token) {
    ws.send(JSON.stringify({ type: "auth_error", message: "Token tidak disertakan" }));
    ws.close(4401, "Unauthorized: no token");
    return;
  }

  let valid = false;
  try {
    const a = Buffer.from(token,            "utf8");
    const b = Buffer.from(WS_SHARED_SECRET, "utf8");
    valid = a.length === b.length && timingSafeEqual(a, b);
  } catch {
    valid = false;
  }

  if (!valid) {
    console.warn("[Auth] Token tidak valid");
    ws.send(JSON.stringify({ type: "auth_error", message: "Token tidak valid" }));
    ws.close(4401, "Unauthorized: invalid token");
    return;
  }

  ws.authenticated = true;
  ws.userId        = "shared_secret_user";
  console.log("[Auth] ✓ authenticated via shared secret");
  ws.send(JSON.stringify({ type: "auth_ok" }));
}

// ── Navigation ────────────────────────────────────────────────────────────
async function startNavigation(ws, msg) {
  const { destination, dest_lat, dest_lng, origin_lat, origin_lng } = msg;
  const sessionId = `nav_${Date.now().toString(36)}`;

  ws.sessionId   = sessionId;
  ws.mode        = "nav";
  ws.destLat     = dest_lat;
  ws.destLng     = dest_lng;
  ws.originLat   = origin_lat;
  ws.originLng   = origin_lng;
  ws.spokenSteps = new Set();

  geminiService.createSession(sessionId, { destination });
  conductor.initSession(sessionId, { destination });

  try {
    const route = await getRoute({
      originLat:   origin_lat,
      originLng:   origin_lng,
      destLat:     dest_lat,
      destLng:     dest_lng,
      destination,
    });

    ws.routeSteps = route.steps;
    conductor.updateRouteSteps(sessionId, route.steps, route.durationSeconds);

    ws.send(JSON.stringify({
      type:        "nav_started",
      session_id:  sessionId,
      eta_seconds: route.durationSeconds,
      origin_lat,
      origin_lng,
      route: {
        polyline:         route.polyline,
        distance_meters:  route.distanceMeters,
        duration_seconds: route.durationSeconds,
        steps: route.steps.map((s) => ({
          instruction:     s.instruction,
          distance_meters: s.distanceMeters,
          maneuver:        s.maneuver,
          end_lat: s.lat,
          end_lng: s.lng,
        })),
      },
    }));

    ws.trafficTimer = setInterval(() => refreshTraffic(ws), 120000);
  } catch (err) {
    console.error(`[Nav] getRoute failed for session ${sessionId}:`, err.message);
    geminiService.destroySession(sessionId);
    conductor.destroySession(sessionId);
    ws.send(JSON.stringify({ type: "error", code: "ROUTE_NOT_FOUND", message: err.message }));
    ws.mode = "idle";
  }
}

async function handleGpsUpdateMsg(ws, msg) {
  const payload = await processGpsUpdate({
    ws,
    lat:            msg.lat,
    lng:            msg.lng,
    speedKmh:       msg.speed_kmh,
    stepIndex:      msg.step_index,
    distanceToNext: msg.distance_to_next,
  });

  if (ws.sessionId) {
    conductor.onGpsUpdate(
      ws.sessionId,
      {
        lat:             msg.lat,
        lng:             msg.lng,
        speedKmh:        msg.speed_kmh || 0,
        stepIndex:       msg.step_index || 0,
        distanceToNextM: msg.distance_to_next || 0,
      },
      ws
    );
  }

  if (payload) ws.send(JSON.stringify(payload));
}

async function handleTtsRequest(ws, msg) {
  const text      = (msg.text      || "").trim();
  const requestId = (msg.request_id || "").toString();
  const issuedAt  = msg.issued_at || Date.now();

  if (!text || !requestId) return;

  const ageMs = Date.now() - issuedAt;
  if (ageMs > 4000) {
    console.log(`[TTS] Dropped stale request ${requestId} (age: ${ageMs}ms)`);
    return;
  }

  try {
    const audioBuffer = await synthNavTts(text);
    ws.send(JSON.stringify({
      type:       "tts_response",
      request_id: requestId,
      issued_at:  issuedAt,
      audio_b64:  audioBuffer.toString("base64"),
    }));
  } catch (err) {
    console.error(`[TTS] synthNavTts failed: ${err.message}`);
    ws.send(JSON.stringify({
      type:       "error",
      code:       "TTS_FAILED",
      request_id: requestId,
      message:    err.message,
    }));
  }
}

async function startVoiceStream(ws) {
  ws.voiceActive = true;
  ws.send(JSON.stringify({ type: "voice_ready", session_id: ws.sessionId }));

  await geminiService.openLiveStream(ws.sessionId, {
    onAudio: (chunk) => {
      if (ws.voiceActive) ws.send(chunk);
    },
    onDone:        () => ws.send(JSON.stringify({ type: "ai_done" })),
    onInterrupted: () => ws.send(JSON.stringify({ type: "ai_interrupted" })),
    onTranscript: (transcript) => {
      if (transcript.role === "gemini") {
        const decision = conductor.resolveConflict(ws.sessionId, transcript.text, ws);
        if (decision === "suppress") return;
      }
      ws.send(JSON.stringify({
        type:     "transcript",
        role:     transcript.role,
        text:     transcript.text,
        finished: transcript.finished,
      }));
    },
    onError: (err) => {
      console.error("[Gemini Live] Error:", err.message);
      ws.send(JSON.stringify({ type: "error", code: "GEMINI_LIVE_ERROR", message: err.message }));
      ws.voiceActive = false;
    },
  }).catch((err) => {
    ws.send(JSON.stringify({ type: "error", code: "GEMINI_LIVE_ERROR", message: err.message }));
    ws.voiceActive = false;
  });
}

function stopNavigation(ws) {
  if (ws.trafficTimer) {
    clearInterval(ws.trafficTimer);
    ws.trafficTimer = null;
  }
  if (ws.sessionId) {
    geminiService.destroySession(ws.sessionId);
    conductor.destroySession(ws.sessionId);
  }
  ws.voiceActive = false;
  ws.mode        = "idle";
  ws.routeSteps  = null;
  ws.spokenSteps = null;
  ws.send(JSON.stringify({ type: "nav_ended" }));
}

function refreshTraffic(ws) {
  if (ws.mode !== "nav") return;
  ws.send(JSON.stringify({ type: "nav_traffic", segments: [] }));
}

module.exports = { handleConnection };
