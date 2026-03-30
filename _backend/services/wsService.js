"use strict";

/**
 * wsService.js — WebSocket message router
 *
 * Model A TTS: Flutter decides WHEN to speak (NavigationEngine, Haversine).
 * Backend decides HOW to synthesize (Chirp 3 HD via ttsService).
 * tts_request handler: receive text + request_id → synthesize → return tts_response.
 *
 * DEV NOTE: Auth is bypassed during testing phase.
 * TODO: restore verifyToken() when profile/auth is reconnected.
 */

const { getRoute }          = require("./routeService");
const { processGpsUpdate }  = require("./navService");
const { synthNavTts }       = require("./ttsService");
const geminiService         = require("./geminiService");
const conductor             = require("./conductor");

function handleConnection(ws) {
  ws.mode          = "idle";
  // DEV BYPASS: set authenticated=true immediately — no JWT/login required.
  // Re-enable verifyToken() when profile screen is reconnected.
  ws.authenticated = true;
  ws.userId        = "dev";
  ws.voiceActive   = false;

  ws.on("message", async (raw) => {
    if (Buffer.isBuffer(raw) || raw instanceof ArrayBuffer) {
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
          ws.send(JSON.stringify({ type: "auth_ok" }));
          break;

        case "nav_start":
          await startNavigation(ws, msg);
          break;

        case "gps_update":
          await handleGpsUpdateMsg(ws, msg);
          break;

        case "nav_stop":
          if (ws.mode === "nav") stopNavigation(ws);
          break;

        case "tts_request":
          if (ws.mode !== "nav") return;
          await handleTtsRequest(ws, msg);
          break;

        case "ping":
          ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
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
