import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import '../config/constants.dart';
import 'nav_tts_player.dart';

// ---------------------------------------------------------------------------
// WsService — WebSocket client singleton
//
// FIX [BUG-001]: Split timeout menjadi dua tahap:
//   - Phase 1: TCP + WS handshake  → timeout 8 detik
//   - Phase 2: auth_ok dari backend → timeout 18 detik
//   Total max ~26 detik, cukup untuk Cloud Run cold start asia-southeast1.
//   Retry 1x otomatis dengan delay 500ms jika attempt pertama gagal.
//
// FIX [BUG-002]: Guard _isConnecting mencegah double-call connect()
//   pada double-tap tombol "Mulai Navigasi".
// ---------------------------------------------------------------------------

class WsService {
  WsService._();
  static final WsService instance = WsService._();

  WebSocketChannel? _channel;
  bool _wsReady      = false;  // true = TCP + WS handshake selesai
  bool _authOk       = false;  // true = backend reply auth_ok
  bool _isConnecting = false;  // [BUG-002] guard double-call

  // [BUG-001] Timeout constants — dipisah per phase
  static const _kHandshakeTimeout = Duration(seconds: 8);
  static const _kAuthTimeout      = Duration(seconds: 18);
  static const _kRetryDelay       = Duration(milliseconds: 500);

  final StreamController<Map<String, dynamic>> _messagesController =
      StreamController<Map<String, dynamic>>.broadcast();
  final StreamController<Uint8List> _binaryController =
      StreamController<Uint8List>.broadcast();

  Completer<void>? _authCompleter;
  String? _sessionToken;  // dari auth_ok, dipakai untuk HTTP→WS bridge
  final Map<String, int> _pendingTtsRequests = {};

  // HTTP base URL dihitung dari WS URL (wss://host → https://host)
  String get _httpBaseUrl {
    final wsUri = Uri.parse(kWsUrl);
    final scheme = wsUri.scheme == 'wss' ? 'https' : 'http';
    return '$scheme://${wsUri.host}${wsUri.hasPort ? ':${wsUri.port}' : ''}';
  }

  Stream<Map<String, dynamic>> get messages => _messagesController.stream;
  Stream<Uint8List> get binaryFrames => _binaryController.stream;

  bool get isConnected   => _channel != null;
  bool get isReady       => _wsReady && _authOk;
  bool get isConnecting  => _isConnecting;

  // -------------------------------------------------------------------------
  // connect() — [BUG-001] + [BUG-002] fixed
  // -------------------------------------------------------------------------
  Future<void> connect() async {
    // [BUG-002] Guard: tolak double-call
    if (_isConnecting) {
      debugPrint('[WsService] connect() already in progress, skipping');
      return _authCompleter?.future ?? Future.value();
    }
    // Sudah connect + auth — langsung return
    if (_channel != null && _wsReady && _authOk) return;

    _isConnecting = true;
    try {
      await _attemptConnect();
    } catch (e) {
      // [BUG-001] Retry 1x dengan delay 500ms
      debugPrint('[WsService] connect() attempt 1 failed: $e — retrying in 500ms...');
      await Future.delayed(_kRetryDelay);
      try {
        await _attemptConnect();
      } catch (retryErr) {
        debugPrint('[WsService] connect() retry failed: $retryErr');
        rethrow;
      }
    } finally {
      _isConnecting = false;
    }
  }

  // -------------------------------------------------------------------------
  // _attemptConnect() — satu kali percobaan koneksi penuh
  // [AUTH-URL] Token dikirim sebagai query parameter di URL WebSocket.
  // Backend verifikasi saat HTTP upgrade → auth_ok dikirim langsung.
  // Phase 1: TCP + WS handshake    (timeout _kHandshakeTimeout)
  // Phase 2: tunggu auth_ok        (timeout _kAuthTimeout)
  // -------------------------------------------------------------------------
  Future<void> _attemptConnect() async {
    _channel?.sink.close();
    _channel = null;
    _wsReady = false;
    _authOk  = false;

    _authCompleter = Completer<void>();

    // Bangun URL dengan token sebagai query parameter
    final wsUri = Uri.parse(kWsUrl);
    final authUri = wsUri.replace(queryParameters: {
      ...wsUri.queryParameters,
      'token': kSupabaseAnonKey,
    });
    debugPrint('[WsService] Connecting to ${wsUri.host} (token in URL, ${kSupabaseAnonKey.length} chars)...');

    try {
      _channel = WebSocketChannel.connect(authUri);

      // Phase 1 — TCP + WS handshake
      await _channel!.ready.timeout(
        _kHandshakeTimeout,
        onTimeout: () => throw TimeoutException(
          'WS handshake timeout (>${_kHandshakeTimeout.inSeconds}s)',
        ),
      );
      _wsReady = true;
      debugPrint('[WsService] WS handshake OK — waiting auth_ok...');

      _channel!.stream.listen(
        _onData,
        onError: (e) {
          debugPrint('[WsService] socket error: $e');
          _markDisconnected();
          if (_authCompleter != null && !_authCompleter!.isCompleted) {
            _authCompleter!.completeError(e);
          }
        },
        onDone: () {
          debugPrint('[WsService] socket closed');
          _markDisconnected();
          if (_authCompleter != null && !_authCompleter!.isCompleted) {
            _authCompleter!.completeError(
              Exception('Socket closed before auth_ok'),
            );
          }
        },
        cancelOnError: false,
      );
    } catch (e) {
      _markDisconnected();
      if (_authCompleter != null && !_authCompleter!.isCompleted) {
        _authCompleter!.completeError(e);
      }
      rethrow;
    }

    // Phase 2 — tunggu auth_ok dari backend
    return _authCompleter!.future.timeout(
      _kAuthTimeout,
      onTimeout: () {
        _markDisconnected();
        throw TimeoutException(
          'auth_ok timeout (>${_kAuthTimeout.inSeconds}s) — server tidak merespons',
        );
      },
    );
  }

  // -------------------------------------------------------------------------
  // Data handler
  // -------------------------------------------------------------------------
  void _onData(dynamic data) {
    if (data is Uint8List) {
      _binaryController.add(data);
      return;
    }
    if (data is List<int>) {
      _binaryController.add(Uint8List.fromList(data));
      return;
    }
    if (data is String) {
      Map<String, dynamic> msg;
      try {
        msg = jsonDecode(data) as Map<String, dynamic>;
      } catch (e) {
        debugPrint('[WsService] JSON parse error: $e');
        return;
      }
      _handleIncoming(msg);
    }
  }

  void _handleIncoming(Map<String, dynamic> msg) {
    final type = (msg['type'] ?? '').toString();
    debugPrint('[WsService] incoming: type=$type');

    // ── Server ping — diagnostic response ──────────────────────────────────────
    if (type == 'server_ping') {
      debugPrint('[WsService] server_ping received — responding with client_pong');
      _send({'type': 'client_pong', 'ts': DateTime.now().millisecondsSinceEpoch});
      return;
    }

    // ── Auth handshake ─────────────────────────────────────────────────────
    if (type == 'auth_ok') {
      _authOk = true;
      _sessionToken = (msg['session_token'] ?? '').toString();
      debugPrint('[WsService] auth_ok received ✓ sessionToken=${_sessionToken!.substring(0, 8)}...');
      debugPrint('[WsService] HTTP base URL: $_httpBaseUrl');
      if (_authCompleter != null && !_authCompleter!.isCompleted) {
        _authCompleter!.complete();
      }
      return;
    }

    if (type == 'auth_error') {
      final reason = (msg['message'] ?? 'auth_error').toString();
      debugPrint('[WsService] auth_error: $reason');
      if (_authCompleter != null && !_authCompleter!.isCompleted) {
        _authCompleter!.completeError(Exception('Auth failed: $reason'));
      }
      return;
    }

    // ── TTS response ──────────────────────────────────────────────────────
    if (type == 'tts_response') {
      final requestId = (msg['request_id'] ?? '').toString();
      final audioB64  = (msg['audio_b64']  ?? '').toString();
      if (requestId.isEmpty || audioB64.isEmpty) return;

      final issuedAt = _pendingTtsRequests.remove(requestId);
      if (issuedAt == null) return;

      try {
        final bytes = Uint8List.fromList(base64Decode(audioB64));
        NavTtsPlayer.instance.play(bytes, requestId: requestId, issuedAt: issuedAt);
      } catch (e) {
        debugPrint('[WsService] tts_response decode error: $e');
      }
      return;
    }

    // ── Semua message lain → forward ke listeners ────────────────────────────
    _messagesController.add(msg);
  }

  void _markDisconnected() {
    _wsReady       = false;
    _authOk        = false;
    _channel       = null;
    _sessionToken  = null;
  }

  void disconnect() {
    _channel?.sink.close();
    _markDisconnected();
  }

  // [HTTP→WS Bridge] Semua client→server messages dikirim via HTTP POST
  // karena WebSocket client→server tidak jalan di Cloud Run.
  // Server→client messages tetap via WS (berfungsi normal).
  void _send(Map<String, dynamic> data) {
    if (_sessionToken == null || _sessionToken!.isEmpty || !_authOk) {
      debugPrint('[WsService] _send SKIPPED type=${data['type']} — no session');
      return;
    }
    // Fire-and-forget HTTP POST
    _sendHttp(data);
  }

  Future<void> _sendHttp(Map<String, dynamic> data) async {
    final type = data['type'] ?? 'unknown';
    try {
      final url = Uri.parse('$_httpBaseUrl/api/send');
      final response = await http.post(
        url,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $_sessionToken',
        },
        body: jsonEncode(data),
      );
      if (type != 'gps_update') {
        debugPrint('[WsService] HTTP _send type=$type → ${response.statusCode}');
      }
      if (response.statusCode != 200) {
        debugPrint('[WsService] HTTP _send error body: ${response.body}');
      }
    } catch (e) {
      debugPrint('[WsService] HTTP _send ERROR type=$type: $e');
    }
  }

  // ── Navigation ──────────────────────────────────────────────────────────────────

  void sendNavStart({
    required String destination,
    required double originLat,
    required double originLng,
  }) {
    _send({
      'type':        'nav_start',
      'destination': destination,
      'origin_lat':  originLat,
      'origin_lng':  originLng,
    });
  }

  void sendNavStop() => _send({'type': 'nav_stop'});

  void sendGpsUpdate({
    required double lat,
    required double lng,
    required double speedKmh,
    required double heading,
    required double distanceToNext,
    required int stepIndex,
  }) {
    _send({
      'type':             'gps_update',
      'lat':              lat,
      'lng':              lng,
      'speed_kmh':        speedKmh,
      'heading':          heading,
      'distance_to_next': distanceToNext,
      'step_index':       stepIndex,
    });
  }

  // ── TTS on-demand (Model A) ───────────────────────────────────────────────

  void sendTtsRequest({required String text, required String requestId}) {
    final issuedAt = DateTime.now().millisecondsSinceEpoch;
    _pendingTtsRequests[requestId] = issuedAt;
    _send({
      'type':       'tts_request',
      'text':       text,
      'request_id': requestId,
      'issued_at':  issuedAt,
    });
  }

  // ── Gemini Voice (Phase 3) ────────────────────────────────────────────────

  void sendVoiceStart() => _send({'type': 'voice_start'});
  void sendVoiceStop()  => _send({'type': 'voice_stop'});

  void sendAudioChunk(Uint8List pcmBytes) {
    if (_channel == null || !_wsReady || !_authOk) return;
    try {
      _channel!.sink.add(pcmBytes);
    } catch (e) {
      debugPrint('[WsService] sendAudioChunk error: $e');
    }
  }

  void sendChirpDone() => _send({'type': 'chirp_done'});

  Future<void> dispose() async {
    disconnect();
    await _messagesController.close();
    await _binaryController.close();
  }
}
