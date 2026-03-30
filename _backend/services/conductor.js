"use strict";

/**
 * conductor.js — The Arbiter
 * Sits between Navigation Engine and AI Engine.
 * Chirp (nav TTS) always wins over Gemini voice.
 */

const geminiService = require("./geminiService");

const NAV_STATUS_INTERVAL = 5000;
const CHIRP_LOCK_DISTANCE = 250;

const conductorState = new Map();

function initSession(sessionId, opts = {}) {
  conductorState.set(sessionId, {
    sessionId,
    lastNavStatusPush: 0,
    chirpLocked: false,
    lastChirpStep: -1,
    destination: opts.destination || "",
    routeSteps: opts.routeSteps || [],
    etaSeconds: opts.etaSeconds || 0,
  });
}

function destroySession(sessionId) {
  conductorState.delete(sessionId);
}

function onGpsUpdate(sessionId, gps, ws) {
  const state = conductorState.get(sessionId);
  if (!state) return;

  const now = Date.now();
  const currentStep = state.routeSteps[gps.stepIndex] || {};

  const navStatus = {
    lat:             gps.lat,
    lng:             gps.lng,
    speedKmh:        gps.speedKmh || 0,
    stepIndex:       gps.stepIndex || 0,
    instruction:     currentStep.instruction || "",
    distanceToNextM: gps.distanceToNextM || 0,
    destination:     state.destination,
    etaSeconds:      state.etaSeconds,
    chirpActive:     state.chirpLocked,
  };

  geminiService.updateNavStatus(sessionId, navStatus);

  if (now - state.lastNavStatusPush >= NAV_STATUS_INTERVAL) {
    geminiService.sendNavStatusToLive(sessionId);
    state.lastNavStatusPush = now;
  }

  const approachingManeuver =
    gps.distanceToNextM > 0 &&
    gps.distanceToNextM <= CHIRP_LOCK_DISTANCE &&
    gps.stepIndex !== state.lastChirpStep;

  if (approachingManeuver && !state.chirpLocked) {
    _lockGemini(sessionId, gps.stepIndex, ws);
  }

  if (state.chirpLocked && gps.stepIndex > state.lastChirpStep) {
    _unlockGemini(sessionId, ws);
  }
}

function onChirpStart(sessionId, stepIndex, ws) {
  _lockGemini(sessionId, stepIndex, ws);
}

function onChirpEnd(sessionId, ws) {
  _unlockGemini(sessionId, ws);
}

function _lockGemini(sessionId, stepIndex, ws) {
  const state = conductorState.get(sessionId);
  if (!state || state.chirpLocked) return;
  state.chirpLocked   = true;
  state.lastChirpStep = stepIndex;
  geminiService.setChirpActive(sessionId, true);
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: "chirp_lock", step_index: stepIndex, message: "Chirp speaking — Gemini audio ducked" }));
  }
}

function _unlockGemini(sessionId, ws) {
  const state = conductorState.get(sessionId);
  if (!state || !state.chirpLocked) return;
  state.chirpLocked = false;
  geminiService.setChirpActive(sessionId, false);
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: "chirp_unlock", message: "Chirp done — Gemini audio restored" }));
  }
}

function updateRouteSteps(sessionId, steps, etaSeconds) {
  const state = conductorState.get(sessionId);
  if (!state) return;
  state.routeSteps = steps || [];
  state.etaSeconds = etaSeconds || 0;
}

function resolveConflict(sessionId, geminiText, ws) {
  const navKeywords = ["belok kiri","belok kanan","putar balik","ambil jalan","turn left","turn right","u-turn","take the road"];
  const session = geminiService.getSession(sessionId);
  if (!session) return "allow";
  const currentInstruction = (session.navStatus.instruction || "").toLowerCase();
  const geminiLower        = (geminiText || "").toLowerCase();
  const hasNavKeyword  = navKeywords.some((kw) => geminiLower.includes(kw));
  const matchesCurrent = currentInstruction.length > 0 &&
    navKeywords.some((kw) => currentInstruction.includes(kw) && geminiLower.includes(kw));
  if (hasNavKeyword && !matchesCurrent) {
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ type: "ai_conflict_suppressed", message: "Gemini instruction conflicts with route — suppressed" }));
    }
    return "suppress";
  }
  return "allow";
}

module.exports = { initSession, destroySession, onGpsUpdate, onChirpStart, onChirpEnd, updateRouteSteps, resolveConflict };
