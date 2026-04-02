# CODEMAP — Source of Truth

> **Instruksi untuk AI (baca ini PERTAMA sebelum mulai kerja di sesi apapun):**
> 1. Baca file ini PERTAMA sebelum membaca atau menulis file apapun.
> 2. Sebelum fix bug di file tertentu, lihat kolom "Branch Audit" di bawah — cek branch yang relevan untuk tahu riwayat perbaikan sebelumnya.
> 3. Tidak perlu audit 100% setiap branch — cukup branch yang menyentuh file yang sedang dikerjakan.
> 4. Setiap kali push file, update SHA di file registry yang bersangkutan.
> 5. Jangan push file yang tidak ada di daftar ini tanpa menambahkan entry baru.

---

## Status Proyek

- **Phase aktif:** Phase 1 (GPS + Navigasi + Chirp TTS)
- **Phase 3:** Gemini Live voice — ditunda, menunggu Phase 1 stabil
- **Commit terakhir stabil:** `54f9148a` (29 Mar 2026)
- **Build status:** Analyze clean, APK build passing

---

## Branch Audit Map

Sebelum memperbaiki file tertentu, cek branch berikut untuk tahu apa yang pernah diperbaiki:

| Branch | File yang Disentuh | Isi Perbaikan |
|--------|--------------------|---------------|
| `fix/flutter-critical-bugs` | `home_screen`, `ws_service`, `main` | Bug kritis GPS + WS race condition |
| `fix/flutter-gps-camera-stability` | `navigation_screen`, `gps_service`, `map_widget` | Stabilitas GPS stream + kamera follow |
| `fix/flutter-stop-crash-and-gps-permission` | `gps_service`, `navigation_screen` | Crash saat stop nav + permission flow |
| `fix/flutter-error-handling-and-ux` | `home_screen`, `navigation_screen` | Error handling + UX feedback |
| `fix/flutter-mapbox-and-nav-debug` | `map_widget`, `navigation_screen` | Mapbox init + debug nav |
| `fix/gps-geocoding-bugs` | `gps_service`, `geocoding_service` | GPS signal + geocoding error |
| `fix/autocomplete-click-and-wakelock` | `home_screen`, `navigation_screen` | Autocomplete tap + wakelock |
| `fix/nav-core-phase1` | `navigation_engine`, `navigation_screen`, `ws_service` | NavigationEngine + Chirp TTS Phase 1 |
| `feat/gemini-live-bidi` | `ws_service`, `gemini_service`, `conductor` | Phase 3 Gemini Live — belum aktif |
| `feat/gemini-context-and-dest-clear` | `gemini_service`, `navigation_screen` | Gemini context + clear destination |
| `feat/ws-gemini-lifecycle` | `ws_service`, `gemini_service` | WS lifecycle Gemini |
| `feat/places-autocomplete` | `geocoding_service`, `home_screen` | Google Places autocomplete |
| `feat/connect-flutter-production` | `ws_service`, `constants` | Connect ke backend production |
| `refactor/places-api-new` | `geocoding_service` | Migrasi Places API New |
| `cursor/development-environment-setup-*` | Semua | Setup awal environment |

---

## Arsitektur Singkat

```
Flutter App
  HomeScreen
    └── GpsService        → deteksi lokasi
    └── GeocodingService  → autocomplete + resolve koordinat
    └── WsService.connect() → await channel.ready sebelum resolve
    └── sendNavStart()    → dikirim SETELAH WS benar-benar OPEN
  NavigationScreen
    └── GpsService.stream   → onGpsTick() → NavigationEngine
    └── NavigationEngine    → emit NavigationState → centerTo() + UI
    └── onChirpSpeak        → sendTtsRequest() → tts_response → NavTtsPlayer
    └── MapWidget(key)      → centerTo() via GlobalKey

Backend (Node.js, Cloud Run)
  wsService.js    → WebSocket handler utama
  routeService.js → Google Routes API
  ttsService.js   → Google Cloud TTS
  geminiService.js → Gemini Live (Phase 3, belum aktif)
  conductor.js    → arbiter Chirp vs Gemini audio
```

---

## File Registry — Flutter Frontend

### `_frontend/lib/main.dart`
- **SHA:** `22ff6751708634258ba7eaad37638216323f0540`
- **Branch audit:** `fix/flutter-critical-bugs`, `cursor/development-environment-setup-*`
- **Fix diterapkan:**
  - `async main()` + `WidgetsFlutterBinding.ensureInitialized()` ← WAJIB, jangan hapus
  - MapboxOptions.setAccessToken dipanggil setelah binding init
- **Jangan ubah:** urutan init — binding harus sebelum runApp

### `_frontend/lib/screens/home_screen.dart`
- **SHA:** `(diperbarui commit b699d6ae)`
- **Branch audit:** `fix/flutter-critical-bugs`, `fix/autocomplete-click-and-wakelock`, `fix/flutter-error-handling-and-ux`, `feat/places-autocomplete`
- **Fix diterapkan:**
  - Import `constants.dart` DIHAPUS (tidak dipakai langsung di screen)
  - `ws.connect()` tanpa parameter
  - `sendNavStart()` hanya 3 param: `destination`, `originLat`, `originLng`
  - Tidak ada `waitForAuth()`
  - GPS wait timeout 10 detik
  - Loading label bertahap: "Mendeteksi lokasi" → "Mencari destinasi" → "Menghubungkan"
- **Jangan ubah:** urutan step 1→2→3→4→5 di `_startNavigation()`

### `_frontend/lib/screens/navigation_screen.dart`
- **SHA:** `02e5e75de2a51c5ed9825d57bf0da163ac9d0e78`
- **Branch audit:** `fix/flutter-gps-camera-stability`, `fix/flutter-stop-crash-and-gps-permission`, `fix/autocomplete-click-and-wakelock`, `fix/nav-core-phase1`
- **Fix diterapkan:**
  - Import `dart:foundation` dihapus
  - `withOpacity()` diganti `withValues(alpha:)`
  - Tidak ada `setRoute()` — polyline via constructor MapWidget
  - Camera follow GPS via `_engineSub` → `centerTo(state.lat, state.lng)`
  - GPS stream restart otomatis jika error/done
- **Jangan ubah:** `_mapKey` GlobalKey harus tetap ada

### `_frontend/lib/services/ws_service.dart`
- **SHA:** `(diperbarui commit b699d6ae)`
- **Branch audit:** `fix/flutter-critical-bugs`, `fix/nav-core-phase1`, `feat/gemini-live-bidi`, `feat/connect-flutter-production`, `feat/ws-gemini-lifecycle`
- **Fix diterapkan:**
  - `connect()` TANPA parameter — baca `kWsUrl` dari constants internal
  - `await _channel!.ready` sebelum resolve
  - `_wsReady` flag — `_send()` skip jika `!_wsReady`
  - Tidak ada `waitForAuth()`, tidak ada `connect(url, key)`
- **KRITIS:** Jangan kembalikan signature `connect(url, key)` — ini sumber bug regresi utama

### `_frontend/lib/services/gps_service.dart`
- **SHA:** `76573b7b6ef61400d9d81c81d0e0950a0000c97e`
- **Branch audit:** `fix/gps-geocoding-bugs`, `fix/flutter-stop-crash-and-gps-permission`, `fix/flutter-gps-camera-stability`
- **Status:** Stabil, tidak perlu diubah

### `_frontend/lib/services/navigation_engine.dart`
- **SHA:** `68af54a0d0000b3a2f1a1e8454e320cdaca77f98`
- **Branch audit:** `fix/nav-core-phase1`
- **Status:** Stabil, tidak perlu diubah

### `_frontend/lib/services/nav_tts_player.dart`
- **SHA:** `cf701dac5527f434963cd388b139eda3809a8784`
- **Branch audit:** `fix/nav-core-phase1`
- **Warning diketahui:** `StreamAudioSource` experimental (just_audio) — tidak block build
- **Status:** Stabil untuk Phase 1

### `_frontend/lib/services/gemini_service.dart`
- **SHA:** `bfe69db35de68b559339c4844f85d168f3b558bd`
- **Branch audit:** `feat/gemini-live-bidi`, `feat/gemini-context-and-dest-clear`, `feat/ws-gemini-lifecycle`
- **Status:** Ada di repo tapi TIDAK dipakai di Phase 1
- **Catatan:** `updateNavigationStatus()` TIDAK ADA — jangan panggil dari file lain

### `_frontend/lib/widgets/map_widget.dart`
- **SHA:** `ff98ca083ebd9dd933baf897ea73aa92cad1e4dd`
- **Branch audit:** `fix/flutter-mapbox-and-nav-debug`, `fix/flutter-gps-camera-stability`
- **API publik:** `centerTo(lat, lng)`, constructor `encodedPolyline`, `initialLat`, `initialLng`
- **TIDAK ADA:** `setRoute()` — jangan panggil method ini
- **Status:** Stabil

### `_frontend/lib/services/geocoding_service.dart`
- **SHA:** `edf73ddb0a34f3ad8b54dce369e3b0de924e222f`
- **Branch audit:** `fix/gps-geocoding-bugs`, `feat/places-autocomplete`, `refactor/places-api-new`
- **Status:** Stabil

---

## File Registry — Android

### `_frontend/android/app/src/main/AndroidManifest.xml`
- **SHA:** `(diperbarui commit b699d6ae)`
- **Branch audit:** `fix/flutter-stop-crash-and-gps-permission`, `fix/flutter-critical-bugs`
- **Permissions WAJIB ada:**
  - `ACCESS_FINE_LOCATION`
  - `ACCESS_COARSE_LOCATION`
  - `ACCESS_BACKGROUND_LOCATION` ← tanpa ini GPS mati saat layar off (Android 10+)
  - `INTERNET`
  - `FOREGROUND_SERVICE`
  - `FOREGROUND_SERVICE_LOCATION`
- **Jangan hapus** `ACCESS_BACKGROUND_LOCATION`

---

## File Registry — Backend

### `_backend/services/wsService.js`
- **SHA:** `0a1de45d0070306adaf6f074be2306f27b88b9ee`
- **Branch audit:** `fix/nav-core-phase1`, `feat/gemini-live-bidi`, `feat/ws-gemini-lifecycle`
- **Handler aktif:** `nav_start`, `nav_stop`, `gps_update`, `tts_request`, `chirp_done`
- **Status:** Stabil untuk Phase 1

### `_backend/services/routeService.js`
- **SHA:** `feea258462db47dfa55ec6bc59d73b5e4abf669e`
- **Response fields:** `steps[].end_lat`, `steps[].end_lng`, `steps[].distance_meters`, `steps[].instruction`, `polyline`, `eta_seconds`
- **Status:** Stabil

### `_backend/services/ttsService.js`
- **SHA:** `880e3fa789d024fcb42ef9d2e28465ffa107f7d2`
- **Status:** Stabil

### `_backend/services/geminiService.js`
- **SHA:** `f082d5919c9fc8c7561187857c62de6510524f78`
- **Branch audit:** `feat/gemini-live-bidi`, `feat/gemini-context-and-dest-clear`
- **Status:** Ada, belum aktif penuh untuk Phase 3

### `_backend/services/conductor.js`
- **SHA:** `76ed6703dab6858040801da2a82b30f84edf8541`
- **Branch audit:** `feat/gemini-live-bidi`
- **Status:** Dipakai untuk chirp_lock/unlock

---

## CI/CD

### `.github/workflows/build-android-apk.yml`
- **Branch audit:** `fix/flutter-critical-bugs`
- **Analyze flags:** `--no-fatal-infos --no-fatal-warnings` ← KEDUANYA wajib ada
- **Catatan:** `--no-fatal-warnings` wajib karena `just_audio` punya experimental warning

---

## Known Issues — Phase 1

| # | Masalah | Status |
|---|---------|--------|
| 1 | Kamera tampil Jakarta default sebelum GPS lock pertama | Acceptable, bukan bug kritis |
| 2 | `nav_started` kadang tidak ada `origin_lat/lng` dari backend | Di-handle dengan fallback `_lastGps` |

---

## Pending — Phase 3

- Audio output Gemini Live adalah PCM16 24kHz raw — Flutter belum bisa play langsung
- Opsi: encode backend ke OGG/Opus, atau pakai `flutter_sound`
- Jangan aktifkan Phase 3 sebelum ini diselesaikan

---

## Changelog

| Tanggal | Commit | Isi |
|---------|--------|-----|
| 29 Mar 2026 | `54f9148a` | Tambah CODEMAP.md |
| 29 Mar 2026 | `b699d6ae` | Fix GPS binding, WS ready-wait, background location permission |
| 29 Mar 2026 | `8a007562` | Fix analyze flags --no-fatal-warnings |
| 29 Mar 2026 | `a70ee870` | Fix home_screen align WsService API, deprecation |
| 29 Mar 2026 | `d08993c9` | Fix navigation_screen — centerTo() ganti setRoute() |
| 28 Mar 2026 | `d2092be5` | Phase 1 core — NavigationEngine + Chirp TTS |
