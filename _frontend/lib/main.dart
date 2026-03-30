import 'package:flutter/material.dart';
import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart';

import 'config/constants.dart';
import 'screens/home_screen.dart';

void main() async {
  // WAJIB sebelum plugin apapun diinisialisasi
  WidgetsFlutterBinding.ensureInitialized();
  MapboxOptions.setAccessToken(kMapboxToken);
  runApp(const ChronoApp());
}

class ChronoApp extends StatelessWidget {
  const ChronoApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Chrono',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(useMaterial3: true, colorSchemeSeed: Colors.blue),
      home: const HomeScreen(),
    );
  }
}
