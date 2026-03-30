// ============================================================
// constants.template.dart
// Salin file ini menjadi constants.dart dan isi nilai yang sesuai.
// JANGAN commit constants.dart ke repo — sudah ada di .gitignore
// ============================================================

/// URL WebSocket backend (Cloud Run)
const String kWsUrl = 'WSS_BACKEND_URL_HERE';
// Contoh: 'wss://chrono-backend-XXXXXXXXXXXX.asia-southeast1.run.app'

/// Supabase anonymous key (bukan service role key)
const String kSupabaseAnonKey = 'SUPABASE_ANON_KEY_HERE';
// Ambil dari: Supabase Dashboard → Project Settings → API → anon public

/// Google API Key — harus enable: Places API (New) + Routes API + Geocoding API
const String kPlacesApiKey = 'GOOGLE_API_KEY_HERE';
// Ambil dari: GCP Console → APIs & Services → Credentials
// Restriction: Android app (package name + SHA-1 fingerprint)

/// Mapbox Access Token (public token, bukan secret token)
const String kMapboxAccessToken = 'MAPBOX_PUBLIC_TOKEN_HERE';
// Ambil dari: account.mapbox.com → Tokens
// Scope minimum: styles:read, tiles:read
