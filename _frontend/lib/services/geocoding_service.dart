import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config/constants.dart';

class PlaceResult {
  final String placeId;
  final String name;
  final double lat;
  final double lng;
  PlaceResult({required this.placeId, required this.name, required this.lat, required this.lng});

  @override
  String toString() => name;
}

class GeocodingService {
  static Future<List<PlaceResult>> searchPlace(String query) async {
    if (query.length < 2) return [];
    final url = Uri.parse('https://places.googleapis.com/v1/places:autocomplete');
    final response = await http.post(
      url,
      headers: {'X-Goog-Api-Key': kGoogleApiKey, 'Content-Type': 'application/json'},
      body: jsonEncode({'input': query, 'languageCode': 'id'}),
    );
    if (response.statusCode != 200) return [];
    final data = jsonDecode(response.body);
    final suggestions = (data['suggestions'] as List?) ?? [];
    return suggestions
        .where((s) => s['placePrediction'] != null)
        .map<PlaceResult>((s) {
      final prediction = s['placePrediction'];
      return PlaceResult(
        placeId: prediction['placeId'] ?? '',
        name: prediction['text']?['text'] ?? '',
        lat: 0, lng: 0,
      );
    }).toList();
  }

  static Future<PlaceResult> resolvePlace(String placeId, String name) async {
    final cleanId = placeId.startsWith('places/')
        ? placeId.substring('places/'.length) : placeId;
    final url = Uri.parse('https://places.googleapis.com/v1/places/\$cleanId');
    final response = await http.get(
      url,
      headers: {'X-Goog-Api-Key': kGoogleApiKey, 'X-Goog-FieldMask': 'id,displayName,location'},
    );
    if (response.statusCode != 200) {
      throw Exception('Failed to resolve place details (\${response.statusCode})');
    }
    final data = jsonDecode(response.body);
    final location = data['location'];
    if (location == null) throw Exception('Place details not found — no location data');
    return PlaceResult(
      placeId: cleanId,
      name: data['displayName']?['text'] ?? name,
      lat: (location['latitude'] as num).toDouble(),
      lng: (location['longitude'] as num).toDouble(),
    );
  }
}
