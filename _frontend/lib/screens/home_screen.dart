import 'dart:async';

import 'package:flutter/material.dart';

import '../services/geocoding_service.dart';
import '../services/gps_service.dart';
import '../services/ws_service.dart';
import 'navigation_screen.dart';

// FIX [BUG-002]: early return guard di _startNavigation()
// FIX [BUG-001]: hapus .timeout() wrapper di sisi UI — WsService kelola sendiri

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final GpsService _gps = GpsService.instance;
  PlaceResult? _selectedPlace;
  bool _gpsReady  = false;
  bool _isLoading = false;
  String _loadingLabel = 'Memuat...';
  StreamSubscription<bool>? _gpsStatusSub;

  @override
  void initState() { super.initState(); _initGps(); }

  Future<void> _initGps() async {
    _gps.listenServiceStatus();
    _gpsStatusSub = _gps.serviceStatus.listen((available) {
      if (mounted) setState(() => _gpsReady = available);
    });
    final granted = await _gps.requestPermission();
    if (granted) await _gps.start();
    if (mounted) setState(() => _gpsReady = _gps.gpsAvailable);
  }

  Future<void> _startNavigation() async {
    if (_isLoading) return; // [BUG-002] double-safety guard
    if (_selectedPlace == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Pilih destinasi dari daftar saran')));
      return;
    }
    setState(() { _isLoading = true; _loadingLabel = 'Mendeteksi lokasi...'; });
    try {
      if (!_gps.running) await _gps.start();
      GpsSample? sample = _gps.lastSample;
      if (sample == null) {
        sample = await _gps.stream.first
            .timeout(const Duration(seconds: 10))
            .then<GpsSample?>((v) => v)
            .catchError((_) => null);
      }
      if (sample == null || (sample.lat == 0.0 && sample.lng == 0.0)) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('GPS belum mendapat sinyal. Pastikan GPS aktif.'),
          duration: Duration(seconds: 5)));
        return;
      }
      if (mounted) setState(() => _loadingLabel = 'Mencari destinasi...');
      final resolved = await GeocodingService.resolvePlace(
          _selectedPlace!.placeId, _selectedPlace!.name);
      // [BUG-001] Tidak ada .timeout() di sini — WsService.connect() kelola sendiri
      if (mounted) setState(() => _loadingLabel = 'Menghubungkan...');
      await WsService.instance.connect();
      WsService.instance.sendNavStart(
          destination: resolved.name,
          originLat: sample.lat,
          originLng: sample.lng);
      if (!mounted) return;
      Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => NavigationScreen(destination: resolved.name)));
    } on TimeoutException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message ?? 'Koneksi timeout — coba lagi')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Error: $e')));
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  void dispose() { _gpsStatusSub?.cancel(); super.dispose(); }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Chrono')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: _gpsReady ? Colors.green.shade50 : Colors.orange.shade50,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: _gpsReady ? Colors.green.shade300 : Colors.orange.shade300)),
            child: Row(children: [
              Icon(_gpsReady ? Icons.gps_fixed : Icons.gps_off,
                  size: 18, color: _gpsReady ? Colors.green : Colors.orange),
              const SizedBox(width: 8),
              Text(_gpsReady ? 'GPS aktif' : 'GPS tidak aktif — aktifkan GPS perangkat',
                  style: TextStyle(
                      color: _gpsReady ? Colors.green.shade800 : Colors.orange.shade800,
                      fontWeight: FontWeight.w500)),
            ])),
          const SizedBox(height: 16),
          Autocomplete<PlaceResult>(
            displayStringForOption: (place) => place.name,
            optionsBuilder: (textEditingValue) async {
              final query = textEditingValue.text.trim();
              if (query.length < 2) return const Iterable.empty();
              try { return await GeocodingService.searchPlace(query); }
              catch (_) { return const Iterable.empty(); }
            },
            onSelected: (place) {
              FocusManager.instance.primaryFocus?.unfocus();
              setState(() => _selectedPlace = place);
            },
            fieldViewBuilder: (context, controller, focusNode, onFieldSubmitted) {
              return TextField(
                controller: controller, focusNode: focusNode,
                decoration: const InputDecoration(
                    border: OutlineInputBorder(), labelText: 'Destinasi',
                    hintText: 'Contoh: Monas, Jakarta', prefixIcon: Icon(Icons.search)),
                textInputAction: TextInputAction.go,
                onSubmitted: (_) => onFieldSubmitted());
            }),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: _isLoading ? null : _startNavigation, // [BUG-002]
              child: _isLoading
                  ? Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                      const SizedBox(height: 16, width: 16,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)),
                      const SizedBox(width: 10),
                      Text(_loadingLabel, style: const TextStyle(color: Colors.white))])
                  : const Text('Mulai Navigasi'))),
        ]),
      ),
    );
  }
}
