"use strict";

// ---------------------------------------------------------------------------
// env.js — Centralized environment variable loader
//
// [BUG-003] Tambah SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY:
//   - Dibutuhkan wsService.js untuk inisialisasi supabaseAdmin di production
//   - SERVICE_ROLE_KEY ≠ ANON_KEY:
//       ANON_KEY         : public, aman di client Flutter
//       SERVICE_ROLE_KEY : secret, hanya backend, bypass RLS
// ---------------------------------------------------------------------------

const config = {
  PORT:                      parseInt(process.env.PORT || "8080", 10),
  NODE_ENV:                  process.env.NODE_ENV || "development",

  // Google APIs
  ROUTES_API_KEY:            process.env.ROUTES_API_KEY            || "",
  TTS_SA_KEY:                process.env.TTS_SA_KEY                || "",
  GCP_VERTEX_SA_KEY:         process.env.GCP_VERTEX_SA_KEY         || "",
  GEMINI_API_KEY:            process.env.GEMINI_25_LIVE_GEMINI_API_KEY || "",

  // Supabase
  SUPABASE_URL:              process.env.SUPABASE_URL              || "",
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  SUPABASE_JWT_SECRET:       process.env.SUPABASE_AUTH_JWT         || "",

  // Misc
  TRAFFIC_REFRESH_MS: parseInt(process.env.TRAFFIC_REFRESH_MS || "120000", 10),
};

// Validasi critical vars di production saat startup
if (config.NODE_ENV !== "development") {
  const required = [
    "ROUTES_API_KEY",
    "TTS_SA_KEY",
    "GEMINI_API_KEY",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const missing = required.filter((k) => !config[k]);
  if (missing.length > 0) {
    console.error(
      `[env.js] FATAL: Variabel production berikut belum di-set: ${missing.join(", ")}`
    );
    process.exit(1);
  }
}

module.exports = config;
