"use strict";

const { synthNavTts } = require("./ttsService");

function determineTtsLevel(distanceMeters) {
  if (distanceMeters > 500) return "far";
  if (distanceMeters >= 150) return "near";
  return "now";
}

function buildTtsText(level, instruction) {
  switch (level) {
    case "far":  return instruction;
    case "near": return `Dalam 200 meter, ${instruction.toLowerCase()}`;
    case "now":  return `Sekarang, ${instruction.toLowerCase()}`;
    default:     return instruction;
  }
}

async function processGpsUpdate({ ws, lat: _lat, lng: _lng, speedKmh: _speedKmh, stepIndex, distanceToNext }) {
  if (ws.mode !== "nav" || !ws.routeSteps) return null;

  const step = ws.routeSteps[stepIndex ?? 0];
  if (!step) return null;

  const level = determineTtsLevel(distanceToNext);
  const dedupKey = `${step.stepId}_${level}`;

  if (ws.spokenSteps.has(dedupKey)) return null;
  ws.spokenSteps.add(dedupKey);

  const text = buildTtsText(level, step.instruction);

  let audioB64 = "";
  try {
    const audioBuffer = await synthNavTts(text);
    audioB64 = audioBuffer.toString("base64");
  } catch (_err) {}

  return {
    type: "nav_tts",
    step_id: dedupKey,
    level,
    text,
    audio_b64: audioB64,
    triggered_at_ms: Date.now(),
  };
}

module.exports = { processGpsUpdate };
