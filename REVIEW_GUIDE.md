# REVIEW_GUIDE.md
## Panduan Code Review — Chrono Navigation App

Repo ini adalah **mirror publik yang telah disanitasi** dari repo private `mydrivebisnis-chrono/main`.
Tidak ada secrets, API keys, atau credentials di repo ini.

---

## Konteks Proyek

Chrono adalah aplikasi navigasi motor Flutter dengan asisten AI Gemini Live.
Arsitektur utama: **2 engine terpisah dalam 1 APK**.

| Engine | File Utama | Sifat |
|---|---|---|
| Navigation Engine | `navigation_engine.dart`, `routeService.js` | Deterministik, real-time |
| AI Engine | `gemini_service.dart`, `geminiService.js` | Probabilistik, cloud streaming |
| Arbiter/Conductor | `conductor.js` | Memutuskan konflik antara dua engine |

---

## Bug Resolved

### ✅ BUG-001 — WebSocket Timeout saat Mulai Navigasi
**Status:** RESOLVED
**Fix:** Split timeout menjadi dua phase (handshake 8s + auth_ok 18s) + retry 1x otomatis.

### ✅ BUG-002 — Race Condition Double-call connect()
**Status:** RESOLVED
**Fix:** Flag `_isConnecting` sebagai guard di `ws_service.dart`.

### ✅ BUG-003 — DEV BYPASS Auth di Backend
**Status:** RESOLVED
**Fix:** Ganti hardcoded bypass dengan `WS_SHARED_SECRET` via `timingSafeEqual`.

### ✅ AUTH-A — Shared Secret Auth (Supabase round-trip)
**Status:** RESOLVED
**Fix:** `supabaseAdmin.auth.getUser()` diganti constant-time compare terhadap `WS_SHARED_SECRET`.

### ✅ AUTH-URL — Cloud Run Tidak Teruskan WS Data Frames
**Status:** RESOLVED
**Root Cause:** Cloud Run proxy tidak meneruskan WebSocket data frames client→server setelah HTTP upgrade. Token auth yang dikirim via `sink.add()` tidak pernah sampai ke backend.
**Fix:** Token dikirim sebagai `?token=` query parameter di URL saat HTTP upgrade request. Backend baca token dari `req.url` di `handleConnection(ws, req)` — auth selesai sebelum frame pertama.

---

## Bug Aktif — Perlu Review

### 🔴 BUG-004 — Lokasi User Tidak Terdeteksi
**Files:** `_frontend/lib/services/gps_service.dart`, `_frontend/lib/screens/home_screen.dart`

**Gejala:** Kamera map stuck di posisi center (default), tidak mengikuti lokasi user. `getCurrentPosition()` tidak return atau terlambat.

**Hipotesis:**
1. Permission GPS belum di-grant atau diminta tapi tidak ditunggu dengan benar sebelum `connect()` dipanggil
2. `Geolocator.getCurrentPosition()` timeout di device tertentu tanpa fallback
3. `origin_lat / origin_lng` yang dikirim di `nav_start` kemungkinan `null` atau `0.0` — Routes API gagal tapi error tidak ditampilkan ke UI

**Yang perlu direview:**
- Apakah ada guard yang memastikan lokasi valid sebelum `sendNavStart()` dipanggil?
- Apakah ada fallback ke `getLastKnownPosition()` jika `getCurrentPosition()` timeout?

### 🔴 BUG-005 — Route Tidak Muncul, Status "Menunggu Route" Terus
**Files:** `_backend/services/routeService.js`, `_frontend/lib/services/navigation_engine.dart`

**Gejala:** Places API terpanggil (destinasi resolve OK), tapi route tidak pernah muncul. Status UI stuck di "menunggu route". GCP metrics menunjukkan Places API request ada, tapi Routes API tidak terpanggil atau responnya tidak sampai ke Flutter.

**Hipotesis:**
1. `nav_start` dikirim dengan `origin_lat/origin_lng` null/zero (akibat BUG-004) → Routes API gagal → error ditelan di backend tanpa feedback yang jelas ke UI
2. `nav_started` response dari backend tidak sampai ke Flutter (bidirectional WS masih bermasalah untuk server→client frames tertentu)
3. `navigation_engine.dart` tidak handle `nav_started` dengan benar jika field tertentu null

**Yang perlu direview:**
- Apakah `routeService.js` mengembalikan error yang informatif jika `origin_lat` null/invalid?
- Apakah ada validasi koordinat sebelum Routes API dipanggil?
- Apakah `nav_started` handler di Flutter sudah robust terhadap partial response?

---

## Diagnostic Log (Terpasang)

Log debug aktif di production untuk diagnosa bug di atas:

**Cloud Run (backend):**
```
[WS] New connection — IS_DEV=false, url="/?token=..."
[Auth-URL] ✓ authenticated via URL token
[WS] Raw message #1 ... {"type":"nav_start",...}   ← konfirmasi bidirectional OK
```

**Flutter logcat:**
```
[WsService] incoming: type=auth_ok
[WsService] _send type=nav_start (xx chars)
[WsService] _send OK — sink.add() completed for type=nav_start
```

---

## Struktur Folder

```
_frontend/
  lib/
    main.dart
    config/
      constants.template.dart   ← template (bukan yang asli)
    screens/
      home_screen.dart          ← entry point navigasi
      navigation_screen.dart    ← layar saat navigasi aktif
    services/
      ws_service.dart           ← WebSocket + auth flow
      navigation_engine.dart    ← Google Routes, polyline
      gemini_service.dart       ← Gemini Live stream
      geocoding_service.dart    ← Places Autocomplete
      gps_service.dart          ← GPS permission + stream ← FOKUS BUG-004
      nav_tts_player.dart       ← Chirp 3HD audio
    widgets/

_backend/
  index.js                      ← server entry point
  config/
    env.js                      ← semua config dari process.env
  services/
    wsService.js                ← WebSocket handler
    conductor.js                ← Arbiter 2-engine
    geminiService.js            ← Gemini Live + text sessions
    routeService.js             ← Google Routes API ← FOKUS BUG-005
    navService.js               ← TTS level logic
    ttsService.js               ← Chirp 3HD synthesis
```

---

## Format Review

Semua saran tulis sebagai GitHub Issue atau PR comment dengan format:

- `[BUG-XXX] Deskripsi singkat` — untuk bug baru
- `[FIX-XXX] Deskripsi` — untuk solusi dari bug yang ada
- `[SUGGESTION] Deskripsi` — untuk best practice / improvement
- `[SECURITY] Deskripsi` — untuk celah keamanan

**Aturan:**
- Jangan merge ke `main` repo private — branch ini hanya untuk review
- Jangan gunakan API key nyata dalam contoh kode
- Semua contoh kode harus bisa langsung di-apply oleh Codex/developer

## Primary Architect
Review utama dikoordinasikan oleh **Perplexity AI** sebagai Software Architect.
