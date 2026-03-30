# Chrono — Aplikasi Navigasi Motor

> **Repository ini adalah mirror publik untuk keperluan code review.**
> Tidak ada API key, credentials, atau secrets di repo ini.

## Tentang Proyek

Chrono adalah aplikasi navigasi motor berbasis Flutter dengan asisten AI suara (Gemini Live).
Dibangun dengan arsitektur **2-Engine** untuk memisahkan jalur navigasi deterministik dari jalur AI probabilistik.

## Tech Stack

| Layer | Teknologi |
|---|---|
| Frontend | Flutter (Android-first) |
| Backend | Node.js, Google Cloud Run (`asia-southeast1`) |
| Navigasi | Google Routes API + Mapbox |
| AI Asisten | Gemini Live 2.5 (`gemini-2.0-flash-live-001`) |
| TTS Navigasi | Google Chirp 3 HD (`id-ID-Chirp3-HD-Kore`) |
| Database/Auth | Supabase |

## Arsitektur 2-Engine

```
┌─────────────────────────────────────────┐
│              Flutter App                 │
│                                         │
│  ┌──────────────────┐  ┌─────────────┐  │
│  │ Navigation Engine│  │  AI Engine  │  │
│  │ (navigation_     │  │(gemini_     │  │
│  │  engine.dart)    │  │ service.dart│  │
│  │                  │  │             │  │
│  │ Google Routes ↕  │  │ WebSocket ↕ │  │
│  │ Mapbox visual    │  │ to Backend  │  │
│  └──────────────────┘  └─────────────┘  │
└─────────────────────────────────────────┘
                     │
              ┌──────▼──────┐
              │   Backend   │
              │  Node.js    │
              │             │
              │  conductor  │ ← Arbiter antara dua engine
              │  wsService  │
              │  geminiSvc  │
              │  routeSvc   │
              │  ttsSvc     │
              └─────────────┘
```

## ⚠️ Cara Menjalankan Lokal

Repo ini **tidak bisa langsung dijalankan** karena:
- `_frontend/lib/config/constants.dart` tidak disertakan (lihat `constants.template.dart`)
- `_backend/.env` tidak disertakan (lihat `.env.example`)

Untuk menjalankan: salin kedua file template tersebut, isi dengan credentials asli kamu.

## Review

Lihat [`REVIEW_GUIDE.md`](./REVIEW_GUIDE.md) untuk panduan lengkap code review.
