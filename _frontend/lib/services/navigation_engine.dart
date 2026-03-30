import 'dart:async';
import 'dart:math' as math;

// ---------------------------------------------------------------------------
// NavigationEngine — Navigation Engine (Brainstem) — Model A
//
// Responsibilities:
//   1. Receive GPS ticks from GpsService
//   2. Track current step, distance, heading against route steps
//   3. Trigger Chirp TTS request when within announce threshold
//   4. Emit NavigationState stream for Mapbox visual layer
//
// Does NOT call GeminiService. Does NOT wait for AI response.
// ---------------------------------------------------------------------------

class RouteStep {
  final String instruction;
  final double endLat;
  final double endLng;
  final double distanceMeters;
  const RouteStep({required this.instruction, required this.endLat,
      required this.endLng, required this.distanceMeters});
}

class NavigationState {
  final double lat;
  final double lng;
  final double heading;
  final double speedKmh;
  final double distanceToNextStepMeters;
  final double distanceToDestinationKm;
  final int currentStepIndex;
  final String currentInstruction;
  final String? nextInstruction;
  final int etaMinutes;
  final bool isNavigating;
  const NavigationState({required this.lat, required this.lng, required this.heading,
      required this.speedKmh, required this.distanceToNextStepMeters,
      required this.distanceToDestinationKm, required this.currentStepIndex,
      required this.currentInstruction, this.nextInstruction,
      required this.etaMinutes, required this.isNavigating});
}

class NavigationEngine {
  NavigationEngine._();
  static final NavigationEngine instance = NavigationEngine._();

  List<RouteStep> _steps = [];
  int _currentStepIndex = 0;
  int _etaMinutes = 0;
  bool _isNavigating = false;

  static const _stepAdvanceThresholdMeters = 20.0;
  static const _announceThresholdMeters = 200.0;
  bool _hasAnnouncedCurrentStep = false;

  final StreamController<NavigationState> _stateController =
      StreamController<NavigationState>.broadcast();

  Stream<NavigationState> get onStateUpdate => _stateController.stream;
  void Function(String instruction, String requestId)? onChirpSpeak;
  void Function()? onArrived;

  void startNavigation({required List<RouteStep> steps, required int etaMinutes}) {
    _steps = steps;
    _currentStepIndex = 0;
    _etaMinutes = etaMinutes;
    _isNavigating = true;
    _hasAnnouncedCurrentStep = false;
  }

  void stopNavigation() {
    _isNavigating = false;
    _steps = [];
    _currentStepIndex = 0;
    _hasAnnouncedCurrentStep = false;
  }

  bool get isNavigating => _isNavigating;
  int get currentStepIndex => _currentStepIndex;

  void onGpsTick({required double lat, required double lng,
      required double speedKmh, required double heading}) {
    if (!_isNavigating || _steps.isEmpty) return;

    final step = _steps[_currentStepIndex];
    final distToStep = _haversineMeters(lat, lng, step.endLat, step.endLng);
    final distToDestKm = _distanceToDestination(lat, lng);

    if (distToStep <= _announceThresholdMeters && !_hasAnnouncedCurrentStep) {
      _hasAnnouncedCurrentStep = true;
      final requestId = '\${_currentStepIndex}_\${DateTime.now().millisecondsSinceEpoch}';
      onChirpSpeak?.call(step.instruction, requestId);
    }

    if (distToStep <= _stepAdvanceThresholdMeters) {
      if (_currentStepIndex < _steps.length - 1) {
        _currentStepIndex++;
        _hasAnnouncedCurrentStep = false;
      } else {
        stopNavigation();
        final requestId = 'arrived_\${DateTime.now().millisecondsSinceEpoch}';
        onChirpSpeak?.call('Anda telah tiba di tujuan.', requestId);
        onArrived?.call();
        return;
      }
    }

    final currentStep = _steps[_currentStepIndex];
    final nextInstruction = _currentStepIndex + 1 < _steps.length
        ? _steps[_currentStepIndex + 1].instruction : null;

    _stateController.add(NavigationState(
      lat: lat, lng: lng, heading: heading, speedKmh: speedKmh,
      distanceToNextStepMeters: distToStep,
      distanceToDestinationKm: distToDestKm,
      currentStepIndex: _currentStepIndex,
      currentInstruction: currentStep.instruction,
      nextInstruction: nextInstruction,
      etaMinutes: _etaMinutes,
      isNavigating: _isNavigating,
    ));
  }

  void dispose() { _stateController.close(); }

  double _haversineMeters(double lat1, double lng1, double lat2, double lng2) {
    const r = 6371000.0;
    final dLat = _rad(lat2 - lat1);
    final dLng = _rad(lng2 - lng1);
    final a = math.pow(math.sin(dLat / 2), 2) +
        math.cos(_rad(lat1)) * math.cos(_rad(lat2)) * math.pow(math.sin(dLng / 2), 2);
    return r * 2 * math.asin(math.sqrt(a.toDouble()));
  }

  double _distanceToDestination(double lat, double lng) {
    if (_steps.isEmpty) return 0;
    return _haversineMeters(lat, lng, _steps.last.endLat, _steps.last.endLng) / 1000;
  }

  static double _rad(double deg) => deg * 0.017453292519943295;
}
