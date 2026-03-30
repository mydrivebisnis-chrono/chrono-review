"use strict";

const config = {
  PORT: parseInt(process.env.PORT || "8080", 10),
  ROUTES_API_KEY: process.env.ROUTES_API_KEY || "",
  TTS_SA_KEY: process.env.TTS_SA_KEY || "",
  SUPABASE_JWT_SECRET: process.env.SUPABASE_AUTH_JWT || "",
  TRAFFIC_REFRESH_MS: parseInt(process.env.TRAFFIC_REFRESH_MS || "120000", 10),
  GEMINI_API_KEY: process.env.GEMINI_25_LIVE_GEMINI_API_KEY || "",
};

module.exports = config;
