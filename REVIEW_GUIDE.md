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

## Bug Aktif — Perlu Review

### 🔴 BUG-001 — WebSocket Timeout saat Mulai Navigasi
**Files:** `_frontend/lib/screens/home_screen.dart` + `_frontend/lib/services/ws_service.dart`

**Gejala:** User tekan "Mulai Navigasi" → warning "Koneksi ke server timeout".

**Hipotesis:**
1. Timeout 10 detik terlalu pendek — Cloud Run cold start bisa 5–15 detik
2. `connect()` di `ws_service.dart` melakukan WS handshake DAN menunggu `auth_ok` dalam satu future — kalau salah satu lambat, keduanya timeout bersama
3. Error path di `home_screen.dart` tidak selalu `return` setelah catch, berpotensi lanjut ke `sendNavStart` meski koneksi gagal

**Yang perlu direview:**
- Apakah timeout 20 detik cukup atau perlu split (connect vs auth masing-masing punya timeout)?
- Apakah perlu retry 1x sebelum show error ke user?
- Apakah `_markDisconnected()` perlu cancel `_authCompleter` yang masih pending?

### 🟡 BUG-002 — Potensi Race Condition Double-call connect()
**File:** `_frontend/lib/services/ws_service.dart`

**Gejala:** User tekan navigasi 2x cepat → `connect()` dipanggil dua kali → dua `_authCompleter` bisa bertabrakan

**Solusi kandidat:** Tambahkan flag `_isConnecting` sebagai guard di awal `connect()`:
```dart
bool _isConnecting = false;

Future<void> connect() async {
  if (_isConnecting || (_wsReady && _authOk)) return;
  _isConnecting = true;
  try {
    // ... existing logic
  } finally {
    _isConnecting = false;
  }
}
```

### 🟡 BUG-003 — DEV BYPASS Auth di Backend (Perlu Ditandai)
**File:** `_backend/services/wsService.js` baris ~18

**Issue:** `ws.authenticated = true` hardcoded — auth bypass untuk development.
Ini **harus dihapus** sebelum production release.

```js
// SAAT INI (DEV BYPASS — TIDAK AMAN UNTUK PRODUCTION):
ws.authenticated = true;
ws.userId = "dev";

// SEHARUSNYA di production:
// ws.authenticated = false;
// verifikasi JWT dari Supabase sebelum set authenticated = true
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
      home_screen.dart          ← entry point navigasi ← FOKUS REVIEW BUG-001
      navigation_screen.dart    ← layar saat navigasi aktif
    services/
      ws_service.dart           ← WebSocket + auth flow ← FOKUS REVIEW BUG-001 & BUG-002
      navigation_engine.dart    ← Google Routes, polyline
      gemini_service.dart       ← Gemini Live stream
      geocoding_service.dart    ← Places Autocomplete
      gps_service.dart          ← GPS permission + stream
      nav_tts_player.dart       ← Chirp 3HD audio
    widgets/

_backend/
  index.js                      ← server entry point
  config/
    env.js                      ← semua config dari process.env
  services/
    wsService.js                ← WebSocket handler ← FOKUS REVIEW BUG-003
    conductor.js                ← Arbiter 2-engine
    geminiService.js            ← Gemini Live + text sessions
    routeService.js             ← Google Routes API
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
