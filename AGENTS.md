# AGENTS.md

## Overview

Real-time turn-by-turn navigation app with voice guidance. Architecture described in `arsitektur.md` (Indonesian).

- **Backend**: Node.js WebSocket server in `_backend/` — HTTP health endpoint + WS message routing
- **Frontend**: Flutter Android app (planned, not yet implemented)
- **External services**: Google Routes API v2, Google Cloud TTS (Chirp 3 HD), Supabase JWT auth, Upstash Redis, Mapbox

## Cursor Cloud specific instructions

### Backend (`_backend/`)

- **Dev server**: `npm run dev` (uses `node --watch`) or `npm start` from `_backend/`
- **Tests**: `npm test` — runs Node.js built-in test runner against `test/server.test.js`
- **Lint**: `npm run lint` — ESLint 9 flat config
- **Port**: defaults to `8080`, override via `PORT` env var
- **Health check**: `GET http://localhost:8080/health`
- The server starts without any API keys set. Auth falls through to anonymous mode when `SUPABASE_JWT_SECRET` is empty. Navigation (`nav_start`) requires `ROUTES_API_KEY`; TTS requires `TTS_SA_KEY`.
- Tests run fully without any external API keys (they test HTTP health, WebSocket ping/pong, auth flow, and nav guard logic).

### Frontend (`_frontend/`)

- Not yet implemented. Flutter SDK is **not** pre-installed in the Cloud VM.

### Key caveats

- The `--watch` flag in `npm run dev` restarts on file changes but does **not** pick up new npm dependencies — restart the process after `npm install`.
- WebSocket tests bind to port `9876` to avoid conflicts with a running dev server on `8080`.
