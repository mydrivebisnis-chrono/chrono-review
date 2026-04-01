import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';

class GpsSample {
  final double lat;
  final double lng;
  final double speedKmh;
  final double heading;

  const GpsSample({
    required this.lat,
    required this.lng,
    required this.speedKmh,
    required this.heading,
  });
}

class GpsService {
  GpsService._();

  static final GpsService instance = GpsService._();

  final StreamController<GpsSample> _positionController =
      StreamController<GpsSample>.broadcast();
  final StreamController<bool> _serviceStatusController =
      StreamController<bool>.broadcast();

  StreamSubscription<Position>? _subscription;
  StreamSubscription<ServiceStatus>? _serviceStatusSub;
  GpsSample? _lastSample;
  bool _gpsAvailable = false;

  Stream<GpsSample> get stream => _positionController.stream;

  /// true = GPS service active, false = GPS turned off
  Stream<bool> get serviceStatus => _serviceStatusController.stream;

  GpsSample? get lastSample => _lastSample;
  bool get running => _subscription != null;
  bool get gpsAvailable => _gpsAvailable;

  /// Start listening to GPS service on/off changes (call once at app startup).
  void listenServiceStatus() {
    _serviceStatusSub?.cancel();
    _serviceStatusSub = Geolocator.getServiceStatusStream().listen(
      (status) {
        _gpsAvailable = status == ServiceStatus.enabled;
        _serviceStatusController.add(_gpsAvailable);

        // Auto-restart position stream when GPS comes back on
        if (_gpsAvailable && !running) {
          start();
        }
      },
      onError: (_) {},
      cancelOnError: false,
    );
  }

  Future<bool> requestPermission() async {
    final serviceEnabled = await Geolocator.isLocationServiceEnabled();
    _gpsAvailable = serviceEnabled;
    _serviceStatusController.add(serviceEnabled);
    if (!serviceEnabled) return false;

    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }

    if (permission == LocationPermission.deniedForever) {
      await Geolocator.openAppSettings();
      return false;
    }

    return permission == LocationPermission.always ||
        permission == LocationPermission.whileInUse;
  }

  Future<void> start() async {
    if (running) return;

    final granted = await requestPermission();
    if (!granted) return;

    final settings = _buildSettings();
    _subscription =
        Geolocator.getPositionStream(locationSettings: settings).listen(
      (position) {
        final sample = GpsSample(
          lat: position.latitude,
          lng: position.longitude,
          speedKmh: (position.speed * 3.6).clamp(0, 300).toDouble(),
          heading: position.heading.isNaN ? 0 : position.heading,
        );
        _lastSample = sample;
        _positionController.add(sample);
      },
      onError: (_) {
        // GPS stream error — mark as stopped so it can restart
        _subscription?.cancel();
        _subscription = null;
      },
      cancelOnError: false,
    );
  }

  Future<void> stop() async {
    await _subscription?.cancel();
    _subscription = null;
  }

  Future<void> dispose() async {
    await stop();
    await _serviceStatusSub?.cancel();
    await _positionController.close();
    await _serviceStatusController.close();
  }

  LocationSettings _buildSettings() {
    if (defaultTargetPlatform == TargetPlatform.android) {
      return AndroidSettings(
        accuracy: LocationAccuracy.best,
        distanceFilter: 5,
        intervalDuration: const Duration(seconds: 2),
      );
    }

    return const LocationSettings(
      accuracy: LocationAccuracy.best,
      distanceFilter: 5,
    );
  }
}
