# Voice audio retention policy

**Applies to:** `/api/voice`, `/api/voice/stream` (the ring hardware voice path).

## The short version

- **Your voice audio is never stored.** Not on disk, not in the database, not in logs. It lives in the server's memory only for the few seconds it takes to transcribe it, then it's gone.
- **Transcripts are off by default.** A double-tap-and-speak turn is ephemeral unless you attach it to a chat thread or turn on transcript saving.
- **Anything stored follows the normal rules:** it's included in Export my data, and Delete my account wipes it.

## In detail

### 1. Raw audio — never retained

When the phone posts audio from the ring's mic, the server:

1. Holds the bytes in request memory.
2. Sends them to the transcription provider (required to turn speech into text).
3. Drops them when the request finishes.

The server never writes audio bytes to a file, a database row, a cache, or a log line. The transcription provider receives the audio for the single request; provider-side retention is governed by the provider's own policy and the zero-retention terms of the configured account.

### 2. Transcripts — opt-in persistence

| Request | What happens to the transcript |
|---|---|
| Default (no `threadId`, no `saveTranscript`) | Ephemeral. Returned in the response, never stored. |
| `threadId` set (a thread you're a member of) | Stored as messages in that thread (`you (voice)` / `agent (voice)`), visible in the app like any chat. |
| `saveTranscript: true` | Stored in your private **Voice** thread, created automatically on first use. |

Demo (signed-out) turns never persist transcripts.

### 3. Stored transcripts are your data

- Included in **Privacy → Download my data**.
- Deleted by **Privacy → Delete my account** (the Voice thread is a sole-member thread, so it's fully removed).
- Never used to train models.

### 4. What's logged

For latency debugging the server records **timings only** — milliseconds spent in transcription, the agent turn, and speech synthesis. No audio, no transcript text, no content of any kind.

### 5. Latency targets

The ring path is built for speed: tap-to-mic under 1 second (hardware), first transcript event under ~1.5 seconds on the streaming endpoint, first spoken audio as early as the pipeline allows. Voice replies are capped at one or two short sentences — shorter replies mean faster answers.

## Verification

- `backend/lib/voice.js` performs no filesystem or database writes (checked by the retention self-check: the module contains no `fs`, `writeFile`, or persistence calls for audio).
- `/api/voice` and `/api/voice/stream` return 501 `VOICE_NOT_CONFIGURED` until STT/TTS credentials are installed; no audio is accepted or retained before that point either.
