import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart' as mb;

import '../config/constants.dart';

class MapWidget extends StatefulWidget {
  final String? encodedPolyline;
  final double? initialLat;
  final double? initialLng;
  const MapWidget({super.key, this.encodedPolyline, this.initialLat, this.initialLng});

  @override
  State<MapWidget> createState() => MapWidgetState();
}

class MapWidgetState extends State<MapWidget> {
  static const String _routeSourceId = 'route-source';
  static const String _routeLayerId = 'route-layer';
  static const Duration _interactionCooldown = Duration(seconds: 3);

  mb.MapboxMap? _mapboxMap;
  bool _userIsInteracting = false;
  DateTime? _lastUserInteraction;

  @override
  void initState() {
    super.initState();
    if (kMapboxToken.isNotEmpty) mb.MapboxOptions.setAccessToken(kMapboxToken);
  }

  Future<void> centerTo(double lat, double lng) async {
    final now = DateTime.now();
    if (_userIsInteracting) return;
    if (_lastUserInteraction != null &&
        now.difference(_lastUserInteraction!) < _interactionCooldown) return;
    await _mapboxMap?.flyTo(
      mb.CameraOptions(
        center: mb.Point(coordinates: mb.Position(lng, lat)),
        zoom: 14.0,
        padding: mb.MbxEdgeInsets(top: 100, left: 50, bottom: 200, right: 50),
      ),
      mb.MapAnimationOptions(duration: 800),
    );
  }

  void _onMapTouchStart() { _userIsInteracting = true; _lastUserInteraction = DateTime.now(); }
  void _onMapTouchEnd()   { _userIsInteracting = false; _lastUserInteraction = DateTime.now(); }

  @override
  void didUpdateWidget(covariant MapWidget oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.encodedPolyline != widget.encodedPolyline) _renderRoute();
    if ((oldWidget.initialLat != widget.initialLat || oldWidget.initialLng != widget.initialLng) &&
        widget.initialLat != null && widget.initialLng != null) {
      centerTo(widget.initialLat!, widget.initialLng!);
    }
  }

  Future<void> _renderRoute() async {
    final map = _mapboxMap;
    if (map == null) return;
    try { await map.style.removeStyleLayer(_routeLayerId); } catch (_) {}
    try { await map.style.removeStyleSource(_routeSourceId); } catch (_) {}
    final encoded = widget.encodedPolyline;
    if (encoded == null || encoded.isEmpty) return;
    final points = _decodeGooglePolyline(encoded);
    if (points.length < 2) return;
    final geoJson = jsonEncode({'type': 'Feature',
      'geometry': {'type': 'LineString', 'coordinates': points.map((p) => [p.longitude, p.latitude]).toList()},
      'properties': {}});
    await map.style.addSource(mb.GeoJsonSource(id: _routeSourceId, data: geoJson));
    await map.style.addLayer(mb.LineLayer(
      id: _routeLayerId, sourceId: _routeSourceId,
      lineColor: Colors.blue.toARGB32(), lineWidth: 6.0, lineOpacity: 0.9,
      lineCap: mb.LineCap.ROUND, lineJoin: mb.LineJoin.ROUND,
    ));
  }

  List<mb.Position> _decodeGooglePolyline(String encoded) {
    final List<mb.Position> points = [];
    int index = 0, lat = 0, lng = 0;
    while (index < encoded.length) {
      int result = 0, shift = 0, b;
      do { b = encoded.codeUnitAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && index < encoded.length);
      lat += (result & 1) != 0 ? ~(result >> 1) : (result >> 1);
      result = 0; shift = 0;
      do { b = encoded.codeUnitAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && index < encoded.length);
      lng += (result & 1) != 0 ? ~(result >> 1) : (result >> 1);
      points.add(mb.Position(lng / 1e5, lat / 1e5));
    }
    return points;
  }

  @override
  Widget build(BuildContext context) {
    return Listener(
      onPointerDown: (_) => _onMapTouchStart(),
      onPointerUp: (_) => _onMapTouchEnd(),
      onPointerCancel: (_) => _onMapTouchEnd(),
      child: mb.MapWidget(
        styleUri: 'mapbox://styles/mapbox/streets-v12',
        cameraOptions: mb.CameraOptions(
          center: mb.Point(coordinates: mb.Position(widget.initialLng ?? 106.8456, widget.initialLat ?? -6.2088)),
          zoom: 13.0,
        ),
        onMapCreated: (mapboxMap) {
          _mapboxMap = mapboxMap;
          _renderRoute();
          if (widget.initialLat != null && widget.initialLng != null) {
            centerTo(widget.initialLat!, widget.initialLng!);
          }
        },
      ),
    );
  }
}
