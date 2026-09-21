// Server voice pipeline for the ring hardware path:
// audio in → transcript → agent turn → spoken audio out.
//
// STT/TTS go through the OpenAI-compatible audio endpoints at OPENAI_BASE_URL
// (OpenAI itself or a compatible provider such as Gemini's OpenAI endpoint).
// Graceful degradation: missing creds or an endpoint the provider doesn't
// support → VOICE_NOT_CONFIGURED (the turn can't proceed); TTS failure →
// audioBase64:null while the text reply still goes through.
//
// Speed design (the ring path is latency-critical):
// - The ring streams 16 kHz 16-bit mono PCM over BLE; the phone may POST it
//   raw (encoding "pcm16") and the server wraps it in a WAV header for the
//   STT provider — no phone-side encode/decode, no resampling.
// - Voice agent turns use a tight token cap + a speak-aloud style prompt so
//   replies stay to one or two sentences (faster LLM, faster TTS).
// - /api/voice/stream emits SSE events as each stage completes so the phone
//   can show the transcript and start playback incrementally.
//
// RETENTION POLICY (see docs/voice-retention.md):
// - Raw audio is NEVER persisted: not to disk, not to the database, not to
//   logs. It exists only in request memory for the duration of the turn.
// - Transcripts persist only when the caller attaches the turn to a thread
//   (threadId) or opts in (saveTranscript:true); otherwise they are
//   ephemeral. Persisted transcripts follow the normal export/delete rules.
// - This module performs zero filesystem or database writes of audio —
//   verified by the retention self-check (no fs/db calls in this file).
//
// No new dependencies: multipart upload uses global FormData/Blob (Node 18+).
const { env } = require('./config');
const { runAgentTurn, runAgentTurnStream } = require('./agent');

const MAX_SPOKEN_CHARS = 600; // voice brevity: spoken replies stay short
const RING_SAMPLE_RATE = 16000; // BLE contract: 16 kHz 16-bit mono PCM LE

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

// Wrap raw 16-bit mono PCM in a WAV header (44 bytes) for STT providers.
// Byte-exact and allocation-light: one concat, no resampling.
function pcm16ToWav(pcmBuf, sampleRate = RING_SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuf.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcmBuf.length, 40);
  return Buffer.concat([header, pcmBuf]);
}

// Normalize the inbound audio to a Buffer + mime the STT provider accepts.
// Retention: the returned buffer lives in memory only; callers must not
// persist it (see policy above).
function normalizeAudio({ audioBase64, mimeType, encoding, sampleRate }) {
  const buf = Buffer.from(audioBase64, 'base64');
  if (!buf.length) throw voiceErr('EMPTY_AUDIO', 'empty audio payload');
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'pcm16' || enc === 'pcm') {
    if (buf.length % 2 !== 0) throw voiceErr('EMPTY_AUDIO', 'malformed pcm16 payload');
    return { buf: pcm16ToWav(buf, Number(sampleRate) || RING_SAMPLE_RATE), mime: 'audio/wav', ext: 'wav' };
  }
  const m = String(mimeType || '').toLowerCase();
  const ext = m.includes('webm') ? 'webm' : m.includes('ogg') ? 'ogg' : m.includes('wav') ? 'wav' : m.includes('m4a') || m.includes('mp4') ? 'm4a' : 'mp3';
  return { buf, mime: mimeType || 'audio/webm', ext };
}

// --- STT -----------------------------------------------------------------
async function transcribe({ audioBase64, mimeType, encoding, sampleRate }) {
  const { base, key } = apiBase();
  const { buf, mime, ext } = normalizeAudio({ audioBase64, mimeType, encoding, sampleRate });

  const form = new FormData();
  form.append('model', env('VOICE_STT_MODEL', 'whisper-1'));
  form.append('file', new Blob([buf], { type: mime }), `audio.${ext}`);

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
// Retention: audio bytes are never written anywhere; the transcript is
// returned to the caller, which decides whether to persist it.
async function processVoice({ audioBase64, mimeType, encoding, sampleRate, userId, demo = false }) {
  if (!audioBase64 || typeof audioBase64 !== 'string') {
    throw voiceErr('EMPTY_AUDIO', 'audio is required');
  }
  const t0 = Date.now();
  const transcript = await transcribe({ audioBase64, mimeType, encoding, sampleRate });
  const sttMs = Date.now() - t0;

  const t1 = Date.now();
  // voice:true → speak-aloud style + tight token cap for speed.
  const reply = await runAgentTurn({ text: transcript, userId, demo, voice: true });
  const agentMs = Date.now() - t1;

  const spoken = String(reply.text || '').slice(0, MAX_SPOKEN_CHARS);
  const t2 = Date.now();
  const audio = spoken ? await synthesize(spoken) : null;
  const ttsMs = Date.now() - t2;

  return {
    transcript,
    text: reply.text,
    toolsUsed: reply.toolsUsed || [],
    audioBase64: audio ? audio.base64 : null,
    audioMime: audio ? audio.mime : null,
    timings: { sttMs, agentMs, ttsMs, totalMs: Date.now() - t0 },
  };
}

// Streaming variant: same stages, but the agent turn streams tokens through
// onEvent so /api/voice/stream can forward them as SSE events.
async function processVoiceStream({ audioBase64, mimeType, encoding, sampleRate, userId, demo = false, onEvent }) {
  if (!audioBase64 || typeof audioBase64 !== 'string') {
    throw voiceErr('EMPTY_AUDIO', 'audio is required');
  }
  const emit = (type, data) => { if (onEvent) onEvent(type, data); };
  const t0 = Date.now();
  const transcript = await transcribe({ audioBase64, mimeType, encoding, sampleRate });
  const sttMs = Date.now() - t0;
  emit('transcript', { text: transcript, sttMs });

  const t1 = Date.now();
  const reply = await runAgentTurnStream({
    text: transcript, userId, demo, voice: true,
    onToken: (tok) => emit('token', { token: tok }),
  });
  const agentMs = Date.now() - t1;

  const spoken = String(reply.text || '').slice(0, MAX_SPOKEN_CHARS);
  const t2 = Date.now();
  const audio = spoken ? await synthesize(spoken) : null;
  const ttsMs = Date.now() - t2;
  emit('audio', {
    base64: audio ? audio.base64 : null,
    mime: audio ? audio.mime : null,
    ttsMs,
  });
  return {
    transcript,
    text: reply.text,
    toolsUsed: reply.toolsUsed || [],
    audioBase64: audio ? audio.base64 : null,
    audioMime: audio ? audio.mime : null,
    timings: { sttMs, agentMs, ttsMs, totalMs: Date.now() - t0 },
  };
}

module.exports = { processVoice, processVoiceStream, pcm16ToWav, normalizeAudio };
