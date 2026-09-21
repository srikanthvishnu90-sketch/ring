// Server voice pipeline for the ring hardware path:
// audio in → transcript → agent turn → spoken audio out.
//
// STT/TTS go through the OpenAI-compatible audio endpoints at OPENAI_BASE_URL
// (OpenAI itself or a compatible provider such as Gemini's OpenAI endpoint).
// Graceful degradation: missing creds or an endpoint the provider doesn't
// support → VOICE_NOT_CONFIGURED (the turn can't proceed); TTS failure →
// audioBase64:null while the text reply still goes through.
//
// No new dependencies: multipart upload uses global FormData/Blob (Node 18+).
const { env } = require('./config');
const { runAgentTurn } = require('./agent');

const MAX_SPOKEN_CHARS = 600; // voice brevity: spoken replies stay short

function voiceErr(code, message) {
  return Object.assign(new Error(message), { code });
}

function apiBase() {
  const base = env('OPENAI_BASE_URL');
  const key = env('OPENAI_API_KEY');
  if (!base || !key) {
    throw voiceErr('VOICE_NOT_CONFIGURED', 'voice transcription not configured');
  }
  return { base: base.replace(/\/+$/, ''), key };
}

function extFromMime(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('m4a') || m.includes('mp4')) return 'm4a';
  return 'mp3';
}

// --- STT -----------------------------------------------------------------
async function transcribe({ audioBase64, mimeType }) {
  const { base, key } = apiBase();

  const buf = Buffer.from(audioBase64, 'base64');
  if (!buf.length) throw voiceErr('EMPTY_AUDIO', 'empty audio payload');

  const form = new FormData();
  form.append('model', env('VOICE_STT_MODEL', 'whisper-1'));
  form.append(
    'file',
    new Blob([buf], { type: mimeType || 'audio/webm' }),
    `audio.${extFromMime(mimeType)}`
  );

  const r = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!r.ok) {
    if (r.status === 404) {
      throw voiceErr('VOICE_NOT_CONFIGURED', 'voice transcription not configured');
    }
    if (r.status === 429) {
      throw voiceErr('VOICE_RATE_LIMITED', 'voice transcription rate-limited, try again');
    }
    if (r.status >= 400 && r.status < 500) {
      throw voiceErr(
        'VOICE_NOT_CONFIGURED',
        `voice transcription not configured (provider HTTP ${r.status})`
      );
    }
    throw voiceErr('VOICE_FAILED', `transcription failed (provider HTTP ${r.status})`);
  }
  const text = String((await r.json()).text || '').trim();
  if (!text) throw voiceErr('EMPTY_AUDIO', 'no speech detected');
  return text;
}

// --- TTS (best-effort; never fails the turn) -------------------------------
async function synthesize(text) {
  let base, key;
  try {
    ({ base, key } = apiBase());
  } catch (e) {
    return null;
  }
  try {
    const r = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env('VOICE_TTS_MODEL', 'tts-1'),
        input: text,
        voice: env('VOICE_TTS_VOICE', 'alloy'),
        response_format: 'mp3',
      }),
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return null;
    return { base64: buf.toString('base64'), mime: 'audio/mpeg' };
  } catch (e) {
    return null;
  }
}

// --- main ------------------------------------------------------------------
async function processVoice({ audioBase64, mimeType, userId, demo = false }) {
  if (!audioBase64 || typeof audioBase64 !== 'string') {
    throw voiceErr('EMPTY_AUDIO', 'audio is required');
  }
  const transcript = await transcribe({ audioBase64, mimeType });
  const reply = await runAgentTurn({ text: transcript, userId, demo });

  const spoken = String(reply.text || '').slice(0, MAX_SPOKEN_CHARS);
  const audio = spoken ? await synthesize(spoken) : null;

  return {
    transcript,
    text: reply.text,
    toolsUsed: reply.toolsUsed || [],
    audioBase64: audio ? audio.base64 : null,
    audioMime: audio ? audio.mime : null,
  };
}

module.exports = { processVoice };
