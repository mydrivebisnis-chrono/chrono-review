import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
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
  bool _wsReady      = false;
  bool _authOk       = false;
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
  final Map<String, int> _pendingTtsRequests = {};

  Stream<Map<String, dynamic>> get messages => _messagesController.stream;
  Stream<Uint8List> get binaryFrames => _binaryController.stream;

  bool get isConnected  => _channel != null;
  bool get isReady      => _wsReady && _authOk;
  bool get isConnecting => _isConnecting;

  Future<void> connect() async {
    if (_isConnecting) {
      return _authCompleter?.future ?? Future.value();
    }
    if (_channel != null && _wsReady && _authOk) return;

    _isConnecting = true;
    try {
      await _attemptConnect();
    } catch (e) {
      debugPrint('[WsService] attempt 1 failed: $e — retrying in 500ms...');
      await Future.delayed(_kRetryDelay);
      try {
        await _attemptConnect();
      } catch (retryErr) {
        debugPrint('[WsService] retry failed: $retryErr');
        rethrow;
      }
    } finally {
      _isConnecting = false;
    }
  }

  Future<void> _attemptConnect() async {
    _channel?.sink.close();
    _channel = null;
    _wsReady = false;
    _authOk  = false;
    _authCompleter = Completer<void>();

    try {
      _channel = WebSocketChannel.connect(Uri.parse(kWsUrl));
      await _channel!.ready.timeout(
        _kHandshakeTimeout,
        onTimeout: () => throw TimeoutException('WS handshake timeout'),
      );
      _wsReady = true;

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
            _authCompleter!.completeError(Exception('Socket closed before auth_ok'));
          }
        },
        cancelOnError: false,
      );

      _channel!.sink.add(jsonEncode({'type': 'auth', 'token': kSupabaseAnonKey}));
    } catch (e) {
      _markDisconnected();
      if (_authCompleter != null && !_authCompleter!.isCompleted) {
        _authCompleter!.completeError(e);
      }
      rethrow;
    }

    return _authCompleter!.future.timeout(
      _kAuthTimeout,
      onTimeout: () {
        _markDisconnected();
        throw TimeoutException('auth_ok timeout — server tidak merespons');
      },
    );
  }

  void _onData(dynamic data) {
    if (data is Uint8List) { _binaryController.add(data); return; }
    if (data is List<int>) { _binaryController.add(Uint8List.fromList(data)); return; }
    if (data is String) {
      Map<String, dynamic> msg;
      try { msg = jsonDecode(data) as Map<String, dynamic>; }
      catch (e) { debugPrint('[WsService] JSON parse error: $e'); return; }
      _handleIncoming(msg);
    }
  }

  void _handleIncoming(Map<String, dynamic> msg) {
    final type = (msg['type'] ?? '').toString();
    if (type == 'auth_ok') {
      _authOk = true;
      if (_authCompleter != null && !_authCompleter!.isCompleted) _authCompleter!.complete();
      return;
    }
    if (type == 'auth_error') {
      final reason = (msg['message'] ?? 'auth_error').toString();
      if (_authCompleter != null && !_authCompleter!.isCompleted) {
        _authCompleter!.completeError(Exception('Auth failed: $reason'));
      }
      return;
    }
    if (type == 'tts_response') {
      final requestId = (msg['request_id'] ?? '').toString();
      final audioB64  = (msg['audio_b64']  ?? '').toString();
      if (requestId.isEmpty || audioB64.isEmpty) return;
      final issuedAt = _pendingTtsRequests.remove(requestId);
      if (issuedAt == null) return;
      try {
        final bytes = Uint8List.fromList(base64Decode(audioB64));
        NavTtsPlayer.instance.play(bytes, requestId: requestId, issuedAt: issuedAt);
      } catch (e) { debugPrint('[WsService] tts decode error: $e'); }
      return;
    }
    _messagesController.add(msg);
  }

  void _markDisconnected() { _wsReady = false; _authOk = false; _channel = null; }
  void disconnect() { _channel?.sink.close(); _markDisconnected(); }

  void _send(Map<String, dynamic> data) {
    if (_channel == null || !_wsReady || !_authOk) return;
    try { _channel!.sink.add(jsonEncode(data)); }
    catch (e) { debugPrint('[WsService] send error: $e'); }
  }

  void sendNavStart({required String destination, required double originLat, required double originLng}) {
    _send({'type': 'nav_start', 'destination': destination, 'origin_lat': originLat, 'origin_lng': originLng});
  }
  void sendNavStop() => _send({'type': 'nav_stop'});
  void sendGpsUpdate({required double lat, required double lng, required double speedKmh,
      required double heading, required double distanceToNext, required int stepIndex}) {
    _send({'type': 'gps_update', 'lat': lat, 'lng': lng, 'speed_kmh': speedKmh,
        'heading': heading, 'distance_to_next': distanceToNext, 'step_index': stepIndex});
  }
  void sendTtsRequest({required String text, required String requestId}) {
    final issuedAt = DateTime.now().millisecondsSinceEpoch;
    _pendingTtsRequests[requestId] = issuedAt;
    _send({'type': 'tts_request', 'text': text, 'request_id': requestId, 'issued_at': issuedAt});
  }
  void sendVoiceStart() => _send({'type': 'voice_start'});
  void sendVoiceStop()  => _send({'type': 'voice_stop'});
  void sendAudioChunk(Uint8List pcmBytes) {
    if (_channel == null || !_wsReady || !_authOk) return;
    try { _channel!.sink.add(pcmBytes); } catch (e) { debugPrint('[WsService] chunk error: $e'); }
  }
  void sendChirpDone() => _send({'type': 'chirp_done'});

  Future<void> dispose() async {
    disconnect();
    await _messagesController.close();
    await _binaryController.close();
  }
}
