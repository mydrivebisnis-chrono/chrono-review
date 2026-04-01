"use strict";

/**
 * wsService.js — WebSocket message router
 *
 * [AUTH-A] Shared secret auth (Opsi A — jangka pendek, tanpa login screen):
 *   Backend verifikasi token === WS_SHARED_SECRET via timingSafeEqual.
 *   Tidak ada Supabase round-trip → auth_ok < 1ms setelah token diterima.
 *   Mendukung fallback ke kSupabaseAnonKey agar build Flutter lama tetap jalan.
 *
 * [BUG-003] NODE_ENV gate:
 *   development  = bypass aktif
 *   production   = wajib kirim WS_SHARED_SECRET
 *
 * [SEC-001] Rate limiting per koneksi (tanpa library):
 *   tts_request : min 3000ms
 *   gps_update  : min 800ms
 */

const { timingSafeEqual, randomBytes } = require("crypto");
const { getRoute }        = require("./routeService");
const { processGpsUpdate } = require("./navService");
const { synthNavTts }     = require("./ttsService");
const geminiService       = require("./geminiService");
const conductor           = require("./conductor");

// ── Session token registry (HTTP→WS bridge) ───────────────────────────────
// Map<sessionToken, ws>  — digunakan oleh POST /api/send untuk menemukan
// koneksi WS yang sesuai. Token digenerate saat auth success.
const sessionRegistry = new Map();

// ── Shared secret [AUTH-A] ────────────────────────────────────────────────
// Wajib di-set di production. Boleh pakai nilai kSupabaseAnonKey dari Flutter
// sebagai WS_SHARED_SECRET di Cloud Run env vars agar tidak perlu rebuild app.
const WS_SHARED_SECRET = (process.env.WS_SHARED_SECRET || "").trim();

const IS_DEV = process.env.NODE_ENV === "development";

if (IS_DEV) {
  console.warn("\x1b[31m%s\x1b[0m", "[WsService] 🔴 DEV AUTH BYPASS AKTIF");
} else if (!WS_SHARED_SECRET) {
  console.error("[Auth] FATAL: WS_SHARED_SECRET tidak di-set di production!");
  process.exit(1);
} else {
  console.log(`[Auth] WS_SHARED_SECRET loaded (${WS_SHARED_SECRET.length} chars, starts: ${WS_SHARED_SECRET.slice(0, 6)}...)`);
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

// ── Auth helpers ──────────────────────────────────────────────────────────

function extractTokenFromUrl(url) {
  try {
    // req.url looks like "/?token=xxx" or "/" or "/?token=xxx&other=yyy"
    const urlObj = new URL(url, "http://localhost");
    return (urlObj.searchParams.get("token") || "").trim() || null;
  } catch {
    return null;
  }
}

function verifyToken(token) {
  if (!token || !WS_SHARED_SECRET) return false;
  try {
    const a = Buffer.from(token,            "utf8");
    const b = Buffer.from(WS_SHARED_SECRET, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── handleConnection ──────────────────────────────────────────────────────
function handleConnection(ws, req) {
  ws.mode        = "idle";
  ws.voiceActive = false;
  ws.rl          = {};
  ws._connectedAt = Date.now();
  ws._msgCount    = 0;

  const reqUrl = req?.url || "";
  console.log(`[WS] New connection — IS_DEV=${IS_DEV}, NODE_ENV=${process.env.NODE_ENV}, url="${reqUrl}"`);

  if (IS_DEV) {
    ws.authenticated = true;
    ws.userId        = "dev";
    ws._sessionToken = generateSessionToken();
    sessionRegistry.set(ws._sessionToken, ws);
    console.warn("[WsService] DEV: koneksi baru — bypass aktif");
    ws.send(JSON.stringify({ type: "auth_ok", session_token: ws._sessionToken }));
  } else {
    ws.authenticated = false;
    ws.userId        = null;

    // [AUTH-URL] Primary auth: token dari URL query parameter
    // URL format: wss://host/?token=SHARED_SECRET
    const urlToken = extractTokenFromUrl(reqUrl);
    if (urlToken) {
      console.log(`[Auth-URL] Token found in URL (${urlToken.length} chars, starts: "${urlToken.slice(0, 6)}...")`);
      const valid = verifyToken(urlToken);
      if (valid) {
        ws.authenticated = true;
        ws.userId        = "shared_secret_user";
        ws._sessionToken = generateSessionToken();
        sessionRegistry.set(ws._sessionToken, ws);
        console.log(`[Auth-URL] ✓ authenticated — sessionToken=${ws._sessionToken.slice(0, 8)}... (took ${Date.now() - ws._connectedAt}ms)`);
        ws.send(JSON.stringify({ type: "auth_ok", session_token: ws._sessionToken }));
      } else {
        console.warn(`[Auth-URL] ✗ Token MISMATCH — closing connection`);
        ws.send(JSON.stringify({ type: "auth_error", message: "Token tidak valid" }));
        ws.close(4401, "Unauthorized: invalid token");
        return;
      }
    } else {
      console.log(`[WS] No token in URL — waiting for auth message fallback...`);
      // Kirim welcome agar Flutter tahu channel siap (fallback flow)
      try {
        ws.send(JSON.stringify({ type: "welcome", ts: Date.now() }));
        console.log(`[WS] Welcome message sent`);
      } catch (err) {
        console.error(`[WS] Failed to send welcome:`, err.message);
      }
    }
  }

  ws.on("message", async (raw) => {
    // Binary frame (PCM audio — Gemini Live)
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

    ws._msgCount++;
    const rawStr = raw.toString();

    let msg;
    try {
      msg = JSON.parse(rawStr);
    } catch (parseErr) {
      console.error(`[WS] JSON parse error on message #${ws._msgCount}:`, parseErr.message);
      ws.send(JSON.stringify({ type: "error", code: "INVALID_JSON", message: "Could not parse JSON" }));
      return;
    }


    try {
      switch (msg.type) {
        case "auth":
          console.log(`[WS] Auth message received — processing...`);
          handleAuth(ws, msg);   // sync — tidak ada await, tidak ada network call
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
    if (ws._sessionToken) sessionRegistry.delete(ws._sessionToken);
    if (ws.sessionId) {
      geminiService.destroySession(ws.sessionId);
      conductor.destroySession(ws.sessionId);
    }
  });
}

// ── Auth handler [AUTH-A] ─────────────────────────────────────────────────
// Sync — tidak ada await, tidak ada network call.
// auth_ok dikirim dalam <1ms setelah token diterima.
function handleAuth(ws, msg) {
  console.log(`[Auth] handleAuth called — IS_DEV=${IS_DEV}`);

  if (IS_DEV) {
    ws.authenticated = true;
    console.log(`[Auth] DEV bypass — sending auth_ok`);
    ws.send(JSON.stringify({ type: "auth_ok" }));
    return;
  }

  const token = (msg.token || "").toString().trim();
  if (!token) {
    console.warn(`[Auth] ✗ No token provided in auth message`);
    ws.send(JSON.stringify({ type: "auth_error", message: "Token tidak disertakan" }));
    ws.close(4401, "Unauthorized: no token");
    return;
  }

  console.log(`[Auth] Token received: ${token.length} chars, starts: "${token.slice(0, 6)}...", ends: "...${token.slice(-4)}"`);
  console.log(`[Auth] Secret loaded:  ${WS_SHARED_SECRET.length} chars, starts: "${WS_SHARED_SECRET.slice(0, 6)}...", ends: "...${WS_SHARED_SECRET.slice(-4)}"`);
  console.log(`[Auth] Length match: ${token.length === WS_SHARED_SECRET.length}`);

  // timingSafeEqual: mencegah timing attack
  // Buffer.byteLength agar panjang selalu sama sebelum compare
  let valid = false;
  try {
    const a = Buffer.from(token,            "utf8");
    const b = Buffer.from(WS_SHARED_SECRET, "utf8");
    // Jika panjang berbeda, langsung reject — timingSafeEqual wajib sama panjang
    valid = a.length === b.length && timingSafeEqual(a, b);
  } catch (err) {
    console.error(`[Auth] timingSafeEqual threw:`, err.message);
    valid = false;
  }

  if (!valid) {
    console.warn(`[Auth] ✗ Token MISMATCH — token(${token.length}) vs secret(${WS_SHARED_SECRET.length})`);
    ws.send(JSON.stringify({ type: "auth_error", message: "Token tidak valid" }));
    ws.close(4401, "Unauthorized: invalid token");
    return;
  }

  ws.authenticated = true;
  ws.userId        = "shared_secret_user";  // diganti real userId saat Opsi B
  console.log(`[Auth] ✓ shared secret — authenticated (took ${Date.now() - ws._connectedAt}ms since connect)`);
  ws.send(JSON.stringify({ type: "auth_ok" }));
}

// ── Navigation ──────────────────────────────────────────────────────────
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

// ── TTS on-demand (Model A) ───────────────────────────────────────────────
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

// ── Gemini Live (Phase 3) ─────────────────────────────────────────────────
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

// ── Helpers ───────────────────────────────────────────────────────────────
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

function generateSessionToken() {
  return randomBytes(16).toString("hex");
}

// ── HTTP→WS bridge ───────────────────────────────────────────────────────
// Dipanggil dari POST /api/send — route message ke handler yang sama
// seperti WS message handler.
async function handleHttpMessage(ws, msg) {
  if (!ws.authenticated) {
    return { error: "UNAUTHORIZED" };
  }

  // Logging dilakukan di index.js — tidak perlu duplikat di sini

  switch (msg.type) {
    case "nav_start":
      await startNavigation(ws, msg);
      return { ok: true, type: "nav_start_accepted" };

    case "gps_update":
      if (!checkRateLimit(ws, "gps_update")) return { ok: true, throttled: true };
      await handleGpsUpdateMsg(ws, msg);
      return { ok: true };

    case "nav_stop":
      if (ws.mode === "nav") stopNavigation(ws);
      return { ok: true };

    case "tts_request":
      if (ws.mode !== "nav") return { ok: true, skipped: true };
      if (!checkRateLimit(ws, "tts_request")) return { ok: true, throttled: true };
      await handleTtsRequest(ws, msg);
      return { ok: true };

    case "voice_start":
      if (ws.mode !== "nav") return { error: "VOICE_NOT_READY" };
      await startVoiceStream(ws);
      return { ok: true };

    case "voice_stop":
      ws.voiceActive = false;
      ws.send(JSON.stringify({ type: "voice_stopped" }));
      return { ok: true };

    case "chirp_done":
      if (ws.sessionId) conductor.onChirpEnd(ws.sessionId, ws);
      return { ok: true };

    default:
      return { error: "UNKNOWN_TYPE", message: `Unknown type: ${msg.type}` };
  }
}

function getWsByToken(token) {
  return sessionRegistry.get(token) || null;
}

module.exports = { handleConnection, handleHttpMessage, getWsByToken };
