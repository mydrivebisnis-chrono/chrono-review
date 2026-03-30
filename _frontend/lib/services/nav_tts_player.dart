import 'dart:async';
import 'dart:collection';
import 'dart:typed_data';

import 'package:just_audio/just_audio.dart';

import 'ws_service.dart';

/// NavTtsPlayer — plays Chirp 3HD navigation TTS audio (OGG Opus)
/// TTL = 3 seconds. Stale audio is dropped silently.
/// After each playback, calls WsService.sendChirpDone() to unlock Gemini.
class NavTtsPlayer {
  NavTtsPlayer._();
  static final NavTtsPlayer instance = NavTtsPlayer._();

  static const _ttlMs = 3000;

  final AudioPlayer _player = AudioPlayer();
  final Queue<_TtsChunk> _queue = Queue<_TtsChunk>();
  bool _playing = false;

  bool get isPlaying => _playing;

  Future<void> play(Uint8List oggBytes, {required String requestId, required int issuedAt}) async {
    final age = DateTime.now().millisecondsSinceEpoch - issuedAt;
    if (age > _ttlMs) return;
    if (!_isValidOgg(oggBytes)) return;
    _queue.add(_TtsChunk(bytes: oggBytes, requestId: requestId, issuedAt: issuedAt));
    if (_playing) return;
    _playing = true;
    try {
      while (_queue.isNotEmpty) {
        final chunk = _queue.removeFirst();
        final chunkAge = DateTime.now().millisecondsSinceEpoch - chunk.issuedAt;
        if (chunkAge > _ttlMs) continue;
        final source = _NavBytesAudioSource(chunk.bytes);
        await _player.setAudioSource(source);
        await _player.play();
      }
    } finally {
      _playing = false;
      WsService.instance.sendChirpDone();
    }
  }

  bool _isValidOgg(Uint8List bytes) {
    if (bytes.length < 4) return false;
    return bytes[0] == 0x4F && bytes[1] == 0x67 && bytes[2] == 0x67 && bytes[3] == 0x53;
  }

  Future<void> dispose() async {
    _queue.clear();
    await _player.dispose();
  }
}

class _TtsChunk {
  final Uint8List bytes;
  final String requestId;
  final int issuedAt;
  const _TtsChunk({required this.bytes, required this.requestId, required this.issuedAt});
}

class _NavBytesAudioSource extends StreamAudioSource {
  final Uint8List _bytes;
  _NavBytesAudioSource(this._bytes);

  @override
  Future<StreamAudioResponse> request([int? start, int? end]) async {
    final safeStart = (start ?? 0).clamp(0, _bytes.length);
    final safeEnd   = (end ?? _bytes.length).clamp(safeStart, _bytes.length);
    final chunk     = _bytes.sublist(safeStart, safeEnd);
    return StreamAudioResponse(
      sourceLength:  _bytes.length,
      contentLength: chunk.length,
      offset:        safeStart,
      stream:        Stream<List<int>>.value(chunk),
      contentType:   'audio/ogg',
    );
  }
}
