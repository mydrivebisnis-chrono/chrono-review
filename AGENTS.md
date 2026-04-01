# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Chrono is a motorcycle navigation app with an AI voice assistant (Gemini Live), built for the Indonesian market. The repo is a **sanitized public mirror** — no secrets, API keys, or credentials are committed.

- **Backend** (`_backend/`): Node.js (CommonJS, >=18) WebSocket server. This is the only runnable component in this repo.
- **Frontend** (`_frontend/`): Flutter/Dart source files only — no `pubspec.yaml`, cannot be built from this repo.

### Running the backend

1. `cd _backend && npm install`
2. Copy `.env.example` to `.env` (already gitignored). In dev mode (`NODE_ENV=development`), all API keys default to empty strings and auth is bypassed.
3. `npm run dev` — starts Node.js with `--watch` on port 8080.
4. Health check: `curl http://localhost:8080/health`
5. WebSocket: `ws://localhost:8080`

### Caveats

- **No eslint config**: `npm run lint` fails because no `eslint.config.js` exists in the repo. ESLint v9+ requires a flat config file.
- **No test files**: `npm test` references `test/server.test.js` and `test/navService.test.js` which are not in this sanitized mirror.
- **DEV AUTH BYPASS**: In development mode, WebSocket auth is fully bypassed (logged as `DEV AUTH BYPASS AKTIF`). No Supabase or shared-secret is needed.
- **punycode deprecation warning**: Node 22+ shows `[DEP0040] DeprecationWarning: The punycode module is deprecated` at startup from the Supabase dependency. This is harmless.
- **External API keys**: Google Routes, Google TTS, Gemini, and Supabase keys are only required in production (`NODE_ENV=production`). The server will crash at startup if critical vars are missing in production mode.
