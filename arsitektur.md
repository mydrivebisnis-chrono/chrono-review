Tech Stack
text
Frontend  : Flutter (Android)
Peta      : Mapbox SDK Flutter (render + UI)
Routing   : Google Routes API v2 (server-side, bukan client)
TTS Nav   : Google Cloud TTS — Chirp 3 HD (server-side synth)
AI Voice  : Gemini Live 2.5 Flash via Vertex AI (Fase 2)
Backend   : Node.js + WebSocket (library: ws)
Infra     : Cloud Run + Upstash Redis
Auth      : Supabase JWT
Struktur Folder
Backend
text
_backend/
  index.js                  — entry point, HTTP + WS server
  services/
    wsService.js            — WebSocket handler, routing semua pesan
    navService.js           — TTS level logic, step dedup, traffic refresh
    routeService.js         — Google Routes API v2
    ttsService.js           — Chirp 3 HD synth via GCP TTS
    geminiService.js        — Gemini Live session (Fase 2, kosong dulu)
  middleware/
    authMiddleware.js       — verifikasi Supabase JWT
  config/
    env.js                  — load semua process.env, export sebagai objek
Frontend
text
_frontend/lib/
  main.dart
  config/
    constants.dart          — WS URL, env values
  services/
    ws_service.dart         — connect, send, receive, reconnect
    gps_service.dart        — location stream, permission
    nav_tts_player.dart     — queue player Chirp audio (OGG)
    audio_capture.dart      — mic PCM, noise gate (Fase 2)
    gemini_audio_player.dart — PCM stream player (Fase 2, kosong dulu)
  screens/
    home_screen.dart
    navigation_screen.dart
  widgets/
    map_widget.dart         — Mapbox render + route polyline
WebSocket Message Contract
Flutter → Backend
json
// Autentikasi (pertama kali connect)
{ "type": "auth", "token": "<supabase_jwt>" }

// Mulai navigasi
{
  "type": "nav_start",
  "destination": "Monas, Jakarta",
  "dest_lat": -6.1754,
  "dest_lng": 106.8272,
  "origin_lat": -6.2000,
  "origin_lng": 106.8160
}

// Update posisi GPS (tiap 1 detik)
{
  "type": "gps_update",
  "lat": -6.1900,
  "lng": 106.8200,
  "speed_kmh": 42.5,
  "heading": 270.0,
  "distance_to_next": 380,
  "step_index": 3
}

// Stop navigasi
{ "type": "nav_stop" }

// Heartbeat
{ "type": "ping", "ts": 1711234567890 }

// Fase 2 — audio chunk dari mic (binary frame, bukan JSON)
// dikirim sebagai Uint8List langsung, bukan JSON

// Fase 2 — mulai voice session
{ "type": "voice_start" }

// Fase 2 — stop voice session
{ "type": "voice_stop" }
Backend → Flutter
json
// Auth berhasil
{ "type": "auth_ok" }

// Auth gagal
{ "type": "auth_error", "message": "Invalid token" }

// Navigasi dimulai, kirim route ke Flutter
{
  "type": "nav_started",
  "session_id": "nav_abc123",
  "route": {
    "polyline": "<encoded_polyline>",
    "distance_meters": 4200,
    "duration_seconds": 840,
    "steps": [
      {
        "step_id": "step_0",
        "instruction": "Belok kiri ke Jalan Sudirman",
        "distance_meters": 400,
        "maneuver": "turn-left",
        "lat": -6.192,
        "lng": 106.823
      }
    ]
  }
}

// TTS navigasi — kirim audio Chirp ke Flutter
{
  "type": "nav_tts",
  "step_id": "step_3_near",
  "level": "near",
  "text": "Dalam 200 meter, belok kanan",
  "audio_b64": "<base64 OGG Chirp 3 HD>",
  "triggered_at_ms": 1711234567890
}

// Update traffic
{
  "type": "nav_traffic",
  "segments": [
    { "lat": -6.195, "lng": 106.821, "congestion": "heavy" }
  ]
}

// Navigasi selesai
{ "type": "nav_ended" }

// Heartbeat balas
{ "type": "pong", "ts": 1711234567890 }

// Error umum
{ "type": "error", "code": "ROUTE_NOT_FOUND", "message": "..." }

// Fase 2 — audio dari Gemini (binary frame)
// dikirim sebagai raw PCM Uint8List, bukan JSON

// Fase 2 — Gemini mulai bicara
{ "type": "ai_speaking" }

// Fase 2 — Gemini selesai bicara
{ "type": "ai_done" }
Alur Kerja Lengkap — Fase 1
text
1. Flutter connect WS → kirim auth
2. Backend verifikasi JWT via Supabase → balas auth_ok
3. Flutter kirim nav_start
4. Backend:
   a. Panggil Google Routes API v2 → dapat steps + polyline
   b. Kirim nav_started + route data ke Flutter
   c. Set timer traffic refresh tiap 2 menit
5. Flutter render polyline di Mapbox
6. GpsService stream posisi tiap 1 detik → kirim gps_update
7. Backend navService.js:
   a. Hitung jarak user ke step berikutnya
   b. Tentukan TTS level:
      - far  : jarak > 500m dari maneuver
      - near : jarak 150–500m
      - now  : jarak < 150m
   c. Cek apakah step_id sudah pernah diucapkan (Set dedup)
   d. Kalau belum → panggil ttsService → synth Chirp 3 HD
   e. Kirim nav_tts ke Flutter
8. Flutter terima nav_tts:
   a. Decode audio_b64 → Uint8List
   b. Validasi 4 magic bytes pertama = OggS (0x4F 0x67 0x67 0x53)
   c. Kalau valid → masuk queue NavTtsPlayer
   d. NavTtsPlayer: FIFO, satu AudioPlayer, play satu per satu
9. Traffic refresh tiap 2 menit:
   a. Backend re-fetch kondisi traffic di sepanjang route
   b. Kirim nav_traffic ke Flutter → update UI visual saja
10. User tap stop → Flutter kirim nav_stop → Backend bersihkan session
Alur Kerja — Fase 2 (Gemini Live, tambah setelah Fase 1 stabil)
text
1. User tap tombol mic (one-tap toggle)
2. Flutter kirim voice_start ke backend
3. Backend buka Gemini Live session via Vertex AI
4. Flutter AudioCapture mulai rekam PCM 16kHz mono
5. Noise gate filter:
   - RMS threshold idle    : 0.035
   - RMS threshold AI speaking : 0.065
6. Chunk yang lolos noise gate → kirim ke backend sebagai binary WS frame
7. Backend relay audio chunk ke Gemini Live
8. Gemini Live AAD (Automatic Activity Detection) deteksi end-of-speech
   → TIDAK ada sendAudioStreamEnd manual
9. Gemini merespons: audio PCM 24kHz → backend relay ke Flutter binary
10. Flutter AudioRouter:
    - Cek apakah NavTtsPlayer sedang aktif
    - Kalau NavTTS aktif → buffer chunk Gemini, jangan play
    - Kalau NavTTS idle → feed langsung ke GeminiAudioPlayer (FlutterSoundPlayer PCM stream)
    - Setelah NavTTS selesai → flush buffer Gemini
11. Backend kirim ai_done → Flutter GeminiAudioPlayer selesai
12. User tap lagi → voice_stop → backend tutup Gemini session
Session State Backend (Per Koneksi WS)
javascript
// Fase 1
ws.sessionId        // string unik
ws.userId           // dari JWT
ws.mode             // 'idle' | 'nav'
ws.routeSteps       // array steps dari Google Routes
ws.spokenSteps      // Set — step_id yang sudah diucapkan
ws.trafficTimer     // setInterval handle untuk refresh tiap 2 menit
ws.originLat/Lng    // koordinat asal
ws.destLat/Lng      // koordinat tujuan

// Fase 2 (tambahan)
ws.geminiSession    // Gemini Live session object
ws.voiceActive      // boolean
Yang Sengaja Tidak Ada di V2
text
❌ Bluetooth SCO                — tambah nanti kalau dibutuhkan
❌ Legacy audio engine fallback — satu engine saja (FlutterSoundPlayer)
❌ Half-duplex manual block     — biarkan AAD yang handle
❌ Engine switching mid-stream  — tidak ada
❌ sendAudioStreamEnd manual    — tidak ada, AAD cukup
❌ HERE API                     — diganti Google Routes API
❌ Ducking/unduck kompleks      — AudioRouter sederhana, buffer saja
❌ PTT hold                     — one-tap toggle saja
❌ Self-heal session            — restart manual kalau koneksi putus
