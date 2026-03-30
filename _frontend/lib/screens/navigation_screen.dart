import 'dart:async';

import 'package:flutter/material.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../services/gps_service.dart';
import '../services/navigation_engine.dart';
import '../services/ws_service.dart';
import '../widgets/map_widget.dart';

class NavigationScreen extends StatefulWidget {
  final String destination;

  const NavigationScreen({
    super.key,
    required this.destination,
  });

  @override
  State<NavigationScreen> createState() => _NavigationScreenState();
}

class _NavigationScreenState extends State<NavigationScreen> {
  final WsService _ws            = WsService.instance;
  final GpsService _gps          = GpsService.instance;
  final NavigationEngine _engine = NavigationEngine.instance;
  final GlobalKey<MapWidgetState> _mapKey = GlobalKey<MapWidgetState>();

  StreamSubscription<Map<String, dynamic>>? _wsSub;
  StreamSubscription<GpsSample>? _gpsSub;
  StreamSubscription<bool>? _gpsStatusSub;
  StreamSubscription<NavigationState>? _engineSub;

  String? _encodedPolyline;
  String _status = 'Menunggu route...';
  String? _currentInstruction;
  String? _nextInstruction;
  double _distanceToNext = 0;
  int _etaMinutes = 0;
  GpsSample? _lastGps;
  bool _gpsActive = true;
  bool _navStartSent = false;
  DateTime? _lastNavStartTime;
  bool _restartingGps = false;

  @override
  void initState() {
    super.initState();
    WakelockPlus.enable();

    _engine.onChirpSpeak = (instruction, requestId) {
      _ws.sendTtsRequest(text: instruction, requestId: requestId);
    };
    _engine.onArrived = () {
      if (mounted) {
        setState(() => _status = 'Tiba di tujuan!');
        Future.delayed(const Duration(seconds: 3), () {
          if (mounted) Navigator.of(context).pop();
        });
      }
    };

    _engineSub = _engine.onStateUpdate.listen((state) {
      _mapKey.currentState?.centerTo(state.lat, state.lng);
      if (mounted) {
        setState(() {
          _currentInstruction = state.currentInstruction;
          _nextInstruction    = state.nextInstruction;
          _distanceToNext     = state.distanceToNextStepMeters;
          _etaMinutes         = state.etaMinutes;
          _status             = 'Navigasi aktif';
        });
      }
      _ws.sendGpsUpdate(
        lat: state.lat,
        lng: state.lng,
        speedKmh: state.speedKmh,
        heading: state.heading,
        distanceToNext: state.distanceToNextStepMeters,
        stepIndex: state.currentStepIndex,
      );
    });

    _wsSub = _ws.messages.listen(_handleWsMessage);

    _gpsActive = _gps.gpsAvailable;
    _gpsStatusSub = _gps.serviceStatus.listen((available) {
      if (mounted) setState(() => _gpsActive = available);
    });

    _startGpsStream();
  }

  void _startGpsStream() {
    _gpsSub?.cancel();
    _gpsSub = _gps.stream.listen(
      (sample) {
        if (!mounted) return;
        _lastGps = sample;
        _engine.onGpsTick(
          lat: sample.lat,
          lng: sample.lng,
          speedKmh: sample.speedKmh,
          heading: sample.heading,
        );
      },
      onError: (e) {
        debugPrint('[Chrono] GPS stream error: \$e');
        _restartGpsIfNeeded();
      },
      onDone: () => _restartGpsIfNeeded(),
      cancelOnError: false,
    );
  }

  Future<void> _restartGpsIfNeeded() async {
    if (_restartingGps || !mounted) return;
    _restartingGps = true;
    try {
      await _gps.start();
      _startGpsStream();
      final sample    = _lastGps ?? _gps.lastSample;
      final now       = DateTime.now();
      final canResend = !_navStartSent ||
          (_lastNavStartTime != null &&
              now.difference(_lastNavStartTime!) > const Duration(seconds: 3));
      if (!_engine.isNavigating && sample != null && canResend) {
        _navStartSent     = true;
        _lastNavStartTime = now;
        _ws.sendNavStart(
          destination: widget.destination,
          originLat: sample.lat,
          originLng: sample.lng,
        );
      }
    } catch (e) {
      debugPrint('[Chrono] GPS restart failed: \$e');
    } finally {
      _restartingGps = false;
    }
  }

  void _handleWsMessage(Map<String, dynamic> msg) {
    final type = (msg['type'] ?? '').toString();

    if (type == 'nav_started') {
      _navStartSent = true;
      final route = msg['route'];
      if (route is! Map<String, dynamic>) return;

      final polyline = (route['polyline'] ?? '').toString();
      final rawSteps = route['steps'];
      final steps = <RouteStep>[];
      if (rawSteps is List) {
        for (final s in rawSteps) {
          if (s is! Map<String, dynamic>) continue;
          steps.add(RouteStep(
            instruction:    (s['instruction'] ?? '').toString(),
            endLat:         (s['end_lat'] as num?)?.toDouble() ?? 0,
            endLng:         (s['end_lng'] as num?)?.toDouble() ?? 0,
            distanceMeters: (s['distance_meters'] as num?)?.toDouble() ?? 0,
          ));
        }
      }

      final etaSeconds = (msg['eta_seconds'] as num?)?.toInt() ?? 0;
      _engine.startNavigation(
        steps: steps,
        etaMinutes: (etaSeconds / 60).round(),
      );

      final originLat = (msg['origin_lat'] as num?)?.toDouble() ?? _lastGps?.lat;
      final originLng = (msg['origin_lng'] as num?)?.toDouble() ?? _lastGps?.lng;

      if (mounted) {
        setState(() {
          _encodedPolyline = polyline.isEmpty ? null : polyline;
          _status = steps.isEmpty ? 'Route diterima (tanpa steps)' : 'Navigasi aktif';
        });
      }

      if (originLat != null && originLng != null) {
        _mapKey.currentState?.centerTo(originLat, originLng);
      }
      return;
    }

    if (type == 'nav_ended') {
      _engine.stopNavigation();
      if (mounted) Navigator.of(context).pop();
      return;
    }
  }

  void _stopNavigation() {
    try { _ws.sendNavStop(); } catch (_) {}
    _engine.stopNavigation();
    _gpsSub?.cancel();
    _wsSub?.cancel();
    _gpsStatusSub?.cancel();
    _engineSub?.cancel();
    if (mounted) Navigator.of(context).pop();
  }

  @override
  void dispose() {
    WakelockPlus.disable();
    _engine.onChirpSpeak = null;
    _engine.onArrived    = null;
    _wsSub?.cancel();
    _gpsSub?.cancel();
    _gpsStatusSub?.cancel();
    _engineSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          MapWidget(
            key: _mapKey,
            encodedPolyline: _encodedPolyline,
            initialLat: _lastGps?.lat,
            initialLng: _lastGps?.lng,
          ),
          if (!_gpsActive)
            Positioned(
              top: MediaQuery.of(context).padding.top,
              left: 0, right: 0,
              child: Container(
                color: Colors.orange.shade700,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                child: const Row(
                  children: [
                    Icon(Icons.gps_off, color: Colors.white, size: 18),
                    SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        '⚠ GPS tidak aktif — menggunakan lokasi terakhir',
                        style: TextStyle(color: Colors.white, fontWeight: FontWeight.w500),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          Positioned(
            bottom: 0, left: 0, right: 0,
            child: Container(
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.95),
                borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
                boxShadow: const [BoxShadow(blurRadius: 8, color: Colors.black26)],
              ),
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (_currentInstruction != null) ...[
                    Text(
                      _currentInstruction!,
                      style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '\${_distanceToNext.toStringAsFixed(0)} m',
                      style: TextStyle(fontSize: 14, color: Colors.grey.shade600),
                    ),
                  ],
                  if (_nextInstruction != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      'Lalu: \$_nextInstruction',
                      style: TextStyle(fontSize: 13, color: Colors.grey.shade700),
                    ),
                  ],
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          '\$_status  •  ETA \$_etaMinutes mnt',
                          style: TextStyle(fontSize: 12, color: Colors.grey.shade500),
                        ),
                      ),
                      FilledButton.tonal(
                        onPressed: _stopNavigation,
                        child: const Text('Stop'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
