"use strict";

/**
 * geminiService.js — AI Stream Engine
 * Manages Gemini Live sessions, NavigationStatusObject, proactive audio.
 */

const { GoogleGenAI, Modality } = require("@google/genai");
const { GEMINI_API_KEY } = require("../config/env");

const LIVE_MODEL = "gemini-2.0-flash-live-001";
const TEXT_MODEL  = "gemini-2.0-flash";

let _genAI = null;
function getGenAI() {
  if (!_genAI) _genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  return _genAI;
}

const sessions = new Map();

function createSession(sessionId, opts = {}) {
  sessions.set(sessionId, {
    sessionId,
    navStatus: {
      lat: 0, lng: 0, speedKmh: 0, stepIndex: 0,
      instruction: "", distanceToNextM: 0,
      destination: opts.destination || "",
      etaSeconds: 0, chirpActive: false,
    },
    history: [],
    liveSession: null,
    createdAt: Date.now(),
  });
}

function updateNavStatus(sessionId, navStatus) {
  const session = sessions.get(sessionId);
  if (!session) return;
  Object.assign(session.navStatus, navStatus);
}

function updateContext(sessionId, ctx) { updateNavStatus(sessionId, ctx); }
function getSession(sessionId) { return sessions.get(sessionId) || null; }

function buildSystemPrompt(navStatus) {
  return [
    "Kamu adalah asisten navigasi AI bernama Chrono. Kamu membantu pengemudi motor di Indonesia.",
    "",
    "STATUS NAVIGASI SAAT INI:",
    `- Tujuan     : ${navStatus.destination || "belum ditentukan"}`,
    `- Posisi     : ${navStatus.lat.toFixed(6)}, ${navStatus.lng.toFixed(6)}`,
    `- Kecepatan  : ${navStatus.speedKmh} km/h`,
    `- Step ke-   : ${navStatus.stepIndex}`,
    `- Instruksi  : ${navStatus.instruction || "tidak ada"}`,
    `- Jarak ke step berikutnya: ${navStatus.distanceToNextM}m`,
    `- ETA        : ${Math.round(navStatus.etaSeconds / 60)} menit`,
    "",
    "ATURAN PENTING:",
    "1. Jawab dalam Bahasa Indonesia kecuali pengguna berbicara bahasa lain.",
    "2. Jawaban SINGKAT — pengguna sedang berkendara motor.",
    "3. JANGAN ulangi instruksi belok — itu sudah ditangani sistem navigasi (Chirp).",
    "4. Jika ada kemacetan atau info jalan, sampaikan secara proaktif tapi singkat.",
    "5. Prioritas keselamatan: selalu ingatkan fokus berkendara.",
    "6. Jika tidak tahu sesuatu, katakan tidak tahu. Jangan buat informasi palsu.",
  ].join("\n");
}

async function openLiveStream(sessionId, callbacks) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const { onAudio, onDone, onInterrupted, onTranscript, onError } = callbacks;

  const liveSession = await getGenAI().live.connect({
    model: LIVE_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      proactivity: { proactiveAudio: true },
      inputAudioTranscription:  {},
      outputAudioTranscription: {},
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
      systemInstruction: buildSystemPrompt(session.navStatus),
    },
    callbacks: {
      onopen: () => console.log(`[Gemini Live] Connected: ${sessionId}`),
      onmessage: (message) => {
        const sc = message.serverContent;
        if (!sc) return;
        if (sc.interrupted) { onInterrupted?.(); return; }
        for (const part of sc.modelTurn?.parts || []) {
          if (part.inlineData?.data) onAudio(Buffer.from(part.inlineData.data, "base64"));
        }
        if (sc.inputTranscription?.text)  onTranscript?.({ role: "user",   text: sc.inputTranscription.text,  finished: true });
        if (sc.outputTranscription?.text) onTranscript?.({ role: "gemini", text: sc.outputTranscription.text, finished: true });
        if (sc.turnComplete) onDone?.();
      },
      onerror: (e) => { onError?.(new Error(e.message)); },
      onclose: (e) => console.log(`[Gemini Live] Closed: ${sessionId} — ${e?.reason || "no reason"}`),
    },
  });

  session.liveSession = liveSession;
}

function sendAudioChunk(sessionId, chunk) {
  const session = sessions.get(sessionId);
  if (!session?.liveSession) return;
  session.liveSession.sendRealtimeInput({ audio: { data: chunk.toString("base64"), mimeType: "audio/pcm;rate=16000" } });
}

function sendNavStatusToLive(sessionId) {
  const session = sessions.get(sessionId);
  if (!session?.liveSession) return;
  const ns = session.navStatus;
  const summary = `[NAV_UPDATE] Posisi: ${ns.lat.toFixed(5)},${ns.lng.toFixed(5)} | Speed: ${ns.speedKmh}km/h | Step ${ns.stepIndex}: ${ns.instruction} | Jarak ke belokan: ${ns.distanceToNextM}m | ETA: ${Math.round(ns.etaSeconds / 60)}m`;
  try { session.liveSession.send({ text: summary }); } catch (_) {}
}

function setChirpActive(sessionId, active) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.navStatus.chirpActive = active;
  if (active && session.liveSession) {
    try { session.liveSession.sendRealtimeInput({ activityEnd: {} }); } catch (_) {}
  }
}

async function getResponse(sessionId, userMessage) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

  const systemPrompt = buildSystemPrompt(session.navStatus);
  session.history.push(`User: ${userMessage}`);
  if (session.history.length > 10) session.history = session.history.slice(-10);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\n--- Conversation ---\n${session.history.join("\n")}` }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 256, topP: 0.9 },
    }),
  });

  if (!response.ok) throw new Error(`Gemini API error ${response.status}: ${await response.text()}`);

  const data  = await response.json();
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Maaf, tidak ada respons.";
  session.history.push(`Assistant: ${reply}`);
  if (session.history.length > 10) session.history = session.history.slice(-10);
  return reply;
}

function destroySession(sessionId) {
  const session = sessions.get(sessionId);
  if (session?.liveSession) {
    try { session.liveSession.close(); } catch (_) {}
    session.liveSession = null;
  }
  sessions.delete(sessionId);
}

function getSessionCount() { return sessions.size; }

module.exports = { createSession, updateNavStatus, updateContext, getSession, openLiveStream, sendAudioChunk, sendNavStatusToLive, setChirpActive, getResponse, destroySession, getSessionCount };
