"use strict";

/**
 * wsService.js — WebSocket message router
 *
 * FIX [BUG-003]: DEV auth bypass sekarang di-gate oleh NODE_ENV.
 *   - development : bypass aktif + console.warn merah
 *   - production  : verifikasi JWT via Supabase Admin SDK
 *
 * Auth flow (library 'ws' native — bukan Socket.IO):
 *   Token datang via pesan JSON { type: 'auth', token: '<jwt>' },
 *   BUKAN dari header handshake. Ini perbedaan kritis dari saran Grok.
 */

const { createClient }      = require("@supabase/supabase-js");
const { getRoute }          = require("./routeService");
const { processGpsUpdate }  = require("./navService");
const { synthNavTts }       = require("./ttsService");
const geminiService         = require("./geminiService");
const conductor             = require("./conductor");

let supabaseAdmin = null;
if (process.env.NODE_ENV !== "development") {
  const supabaseUrl        = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error("[Auth] FATAL: SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY tidak di-set!");
    process.exit(1);
  }
  supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const IS_DEV = process.env.NODE_ENV === "development";
if (IS_DEV) {
  console.warn("\x1b[31m%s\x1b[0m", "[WsService] 🔴 DEV AUTH BYPASS AKTIF");
}

function handleConnection(ws) {
  ws.mode        = "idle";
  ws.voiceActive = false;

  if (IS_DEV) {
    ws.authenticated = true;
    ws.userId        = "dev";
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
          geminiService.sendAudioChunk(ws.sessionId,
            Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
        }
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { ws.send(JSON.stringify({ type: "error", code: "INVALID_JSON" })); return; }

    try {
      switch (msg.type) {
        case "auth":  await handleAuth(ws, msg); break;
        case "ping":  ws.send(JSON.stringify({ type: "pong", ts: msg.ts })); break;
        default: {
          if (!ws.authenticated) {
            ws.send(JSON.stringify({ type: "error", code: "UNAUTHORIZED",
              message: "Kirim { type: 'auth', token } terlebih dahulu" }));
            return;
          }
          switch (msg.type) {
            case "nav_start":   await startNavigation(ws, msg); break;
            case "gps_update":  await handleGpsUpdateMsg(ws, msg); break;
            case "nav_stop":    if (ws.mode === "nav") stopNavigation(ws); break;
            case "tts_request": if (ws.mode === "nav") await handleTtsRequest(ws, msg); break;
            case "voice_start":
              if (ws.mode !== "nav") {
                ws.send(JSON.stringify({ type: "error", code: "VOICE_NOT_READY" })); return;
              }
              await startVoiceStream(ws); break;
            case "voice_stop":
              ws.voiceActive = false;
              ws.send(JSON.stringify({ type: "voice_stopped" })); break;
            case "chirp_done":
              if (ws.sessionId) conductor.onChirpEnd(ws.sessionId, ws); break;
            default:
              ws.send(JSON.stringify({ type: "error", code: "UNKNOWN_TYPE", message: `Unknown: ${msg.type}` }));
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

async function handleAuth(ws, msg) {
  if (IS_DEV) { ws.send(JSON.stringify({ type: "auth_ok" })); return; }
  const token = (msg.token || "").toString().trim();
  if (!token) {
    ws.send(JSON.stringify({ type: "auth_error", message: "Token tidak disertakan" }));
    ws.close(4401, "Unauthorized"); return;
  }
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      ws.send(JSON.stringify({ type: "auth_error", message: error?.message || "Token tidak valid" }));
      ws.close(4401, "Unauthorized"); return;
    }
    ws.authenticated = true;
    ws.userId        = data.user.id;
    ws.send(JSON.stringify({ type: "auth_ok" }));
  } catch (err) {
    console.error("[Auth] Supabase error:", err.message);
    ws.send(JSON.stringify({ type: "auth_error", message: "Auth service error" }));
    ws.close(4401, "Unauthorized");
  }
}

async function startNavigation(ws, msg) {
  const { destination, dest_lat, dest_lng, origin_lat, origin_lng } = msg;
  const sessionId = `nav_${Date.now().toString(36)}`;
  ws.sessionId = sessionId; ws.mode = "nav";
  ws.destLat = dest_lat; ws.destLng = dest_lng;
  ws.originLat = origin_lat; ws.originLng = origin_lng;
  ws.spokenSteps = new Set();
  geminiService.createSession(sessionId, { destination });
  conductor.initSession(sessionId, { destination });
  try {
    const route = await getRoute({ originLat: origin_lat, originLng: origin_lng,
        destLat: dest_lat, destLng: dest_lng, destination });
    ws.routeSteps = route.steps;
    conductor.updateRouteSteps(sessionId, route.steps, route.durationSeconds);
    ws.send(JSON.stringify({
      type: "nav_started", session_id: sessionId,
      eta_seconds: route.durationSeconds, origin_lat, origin_lng,
      route: {
        polyline: route.polyline, distance_meters: route.distanceMeters,
        duration_seconds: route.durationSeconds,
        steps: route.steps.map((s) => ({
          instruction: s.instruction, distance_meters: s.distanceMeters,
          maneuver: s.maneuver, end_lat: s.lat, end_lng: s.lng })),
      },
    }));
    ws.trafficTimer = setInterval(() => refreshTraffic(ws), 120000);
  } catch (err) {
    console.error(`[Nav] getRoute failed:`, err.message);
    geminiService.destroySession(sessionId); conductor.destroySession(sessionId);
    ws.send(JSON.stringify({ type: "error", code: "ROUTE_NOT_FOUND", message: err.message }));
    ws.mode = "idle";
  }
}

async function handleGpsUpdateMsg(ws, msg) {
  const payload = await processGpsUpdate({ ws, lat: msg.lat, lng: msg.lng,
      speedKmh: msg.speed_kmh, stepIndex: msg.step_index, distanceToNext: msg.distance_to_next });
  if (ws.sessionId) {
    conductor.onGpsUpdate(ws.sessionId, { lat: msg.lat, lng: msg.lng,
        speedKmh: msg.speed_kmh || 0, stepIndex: msg.step_index || 0,
        distanceToNextM: msg.distance_to_next || 0 }, ws);
  }
  if (payload) ws.send(JSON.stringify(payload));
}

async function handleTtsRequest(ws, msg) {
  const text = (msg.text || "").trim();
  const requestId = (msg.request_id || "").toString();
  const issuedAt  = msg.issued_at || Date.now();
  if (!text || !requestId) return;
  if (Date.now() - issuedAt > 4000) return;
  try {
    const audioBuffer = await synthNavTts(text);
    ws.send(JSON.stringify({ type: "tts_response", request_id: requestId,
        issued_at: issuedAt, audio_b64: audioBuffer.toString("base64") }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", code: "TTS_FAILED",
        request_id: requestId, message: err.message }));
  }
}

async function startVoiceStream(ws) {
  ws.voiceActive = true;
  ws.send(JSON.stringify({ type: "voice_ready", session_id: ws.sessionId }));
  await geminiService.openLiveStream(ws.sessionId, {
    onAudio: (chunk) => { if (ws.voiceActive) ws.send(chunk); },
    onDone:        () => ws.send(JSON.stringify({ type: "ai_done" })),
    onInterrupted: () => ws.send(JSON.stringify({ type: "ai_interrupted" })),
    onTranscript: (transcript) => {
      if (transcript.role === "gemini") {
        if (conductor.resolveConflict(ws.sessionId, transcript.text, ws) === "suppress") return;
      }
      ws.send(JSON.stringify({ type: "transcript", role: transcript.role,
          text: transcript.text, finished: transcript.finished }));
    },
    onError: (err) => {
      ws.send(JSON.stringify({ type: "error", code: "GEMINI_LIVE_ERROR", message: err.message }));
      ws.voiceActive = false;
    },
  }).catch((err) => {
    ws.send(JSON.stringify({ type: "error", code: "GEMINI_LIVE_ERROR", message: err.message }));
    ws.voiceActive = false;
  });
}

function stopNavigation(ws) {
  if (ws.trafficTimer) { clearInterval(ws.trafficTimer); ws.trafficTimer = null; }
  if (ws.sessionId) {
    geminiService.destroySession(ws.sessionId); conductor.destroySession(ws.sessionId);
  }
  ws.voiceActive = false; ws.mode = "idle";
  ws.routeSteps = null; ws.spokenSteps = null;
  ws.send(JSON.stringify({ type: "nav_ended" }));
}

function refreshTraffic(ws) {
  if (ws.mode !== "nav") return;
  ws.send(JSON.stringify({ type: "nav_traffic", segments: [] }));
}

module.exports = { handleConnection };
