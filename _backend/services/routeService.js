"use strict";

const axios = require("axios");

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

const FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.polyline.encodedPolyline",
  "routes.legs.steps.navigationInstruction",
  "routes.legs.steps.distanceMeters",
  "routes.legs.steps.startLocation",
].join(",");

async function getRoute({ originLat, originLng, destLat, destLng, destination }) {
  const apiKey = process.env.ROUTES_API_KEY;
  if (!apiKey) throw new Error("ROUTES_API_KEY environment variable is not set");

  let dest;
  if (destLat != null && destLng != null) {
    dest = { location: { latLng: { latitude: destLat, longitude: destLng } } };
  } else if (destination) {
    dest = { address: destination };
  } else {
    throw new Error("Either destLat/destLng or destination address is required");
  }

  const { data } = await axios.post(
    ROUTES_URL,
    {
      origin: { location: { latLng: { latitude: originLat, longitude: originLng } } },
      destination: dest,
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      languageCode: "id",
      units: "METRIC",
    },
    {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
        "Content-Type": "application/json",
      },
    },
  );

  const route = data.routes[0];
  const leg = route.legs[0];
  const durationSec = parseInt(route.duration.replace("s", ""), 10);

  const steps = leg.steps.map((s, i) => ({
    stepId: `step_${i}`,
    instruction: s.navigationInstruction?.instructions || "",
    distanceMeters: s.distanceMeters || 0,
    maneuver: (s.navigationInstruction?.maneuver || "").toLowerCase().replace(/_/g, "-"),
    lat: s.startLocation?.latLng?.latitude || 0,
    lng: s.startLocation?.latLng?.longitude || 0,
  }));

  return {
    polyline: route.polyline.encodedPolyline,
    distanceMeters: route.distanceMeters,
    durationSeconds: durationSec,
    steps,
  };
}

module.exports = { getRoute };
