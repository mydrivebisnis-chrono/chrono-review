"use strict";

const { TextToSpeechClient } = require("@google-cloud/text-to-speech");

const VOICE_NAME = "id-ID-Chirp3-HD-Kore";
const LANGUAGE_CODE = "id-ID";

let _client;

function getClient() {
  if (!_client) {
    const raw = process.env.TTS_SA_KEY;
    if (!raw) throw new Error("TTS_SA_KEY environment variable is not set");
    _client = new TextToSpeechClient({ credentials: JSON.parse(raw) });
  }
  return _client;
}

async function synthNavTts(text) {
  const [response] = await getClient().synthesizeSpeech({
    input: { text },
    voice: { languageCode: LANGUAGE_CODE, name: VOICE_NAME },
    audioConfig: { audioEncoding: "OGG_OPUS" },
  });
  return Buffer.from(response.audioContent);
}

module.exports = { synthNavTts };
