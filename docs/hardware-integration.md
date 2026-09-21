# Ring Hardware Integration Contract v1 (FROZEN)

Status: **frozen 2026-09-21**. The ring is dumb by design: mic, tap sensor,
vibration motor, battery, BLE radio. No speaker, no AI, no GPS, no direct
internet. The phone app is the brain; the cloud agent does the thinking.

Firmware and app implement against this document. Changes need a version bump
and a note in `docs/hardware-changelog.md`.

## BLE GATT contract

**Custom service UUID (128-bit):**
`2C827DB5-23EA-41C0-8860-154B7F7F283B` — "Ring Control Service"

| Characteristic | UUID | Properties | Format |
|---|---|---|---|
| AUDIO_STREAM | `2C827DB5-23EA-41C0-8860-154B6F7F2831` | Notify | 16 kHz, 16-bit, mono PCM, little-endian; 20 ms frames = **640 bytes** per notification |
| TAP_EVENT | `2C827DB5-23EA-41C0-8860-154B5F7F2832` | Notify | 1 byte: `0x01` single · `0x02` double · `0x03` long-press |
| HAPTIC_CMD | `2C827DB5-23EA-41C0-8860-154B4F7F2833` | Write (no response) | 1 byte pattern id |

Haptic patterns:

| id | Pattern | Used for |
|---|---|---|
| `0x01` | short buzz (80 ms) | tap acknowledged |
| `0x02` | double buzz (2×80 ms, 120 ms gap) | voice session started |
| `0x03` | long buzz (400 ms) | voice session ended / cancelled |
| `0x04` | success (short-long) | approval approved |
| `0x05` | error (3×short) | approval declined / failed |

**Standard services:** Battery Service `0x180F` / Battery Level `0x2A19`
(read + notify, 0–100%). Device Name `0x2A00` under GAP, advertised as e.g.
`Ring-4F2A`.

## Pairing flow (app side)

1. App scans for the service UUID `2C827DB5-…283B`. No PIN, no manual pairing
   dance — Just Works pairing.
2. On connect: read Battery Level, enable notifications on TAP_EVENT and
   AUDIO_STREAM (audio notify is enabled per-session, see below).
3. App calls `POST /api/devices/register` with the BLE device id; the server
   returns a device row the app keeps for the session.
4. On disconnect: stop any audio session, show "ring disconnected" state.

## Audio session lifecycle

1. **Double-tap** (TAP_EVENT `0x02`) → app enables AUDIO_STREAM notifications,
   sends HAPTIC_CMD `0x02` (session started), streams PCM frames to the
   app's in-memory audio buffer.
2. **Stop condition:** 1.2 s of silence (energy-based VAD in the app), a second
   double-tap, or 30 s timeout. App disables AUDIO_STREAM notifications, sends
   HAPTIC_CMD `0x03`.
3. App POSTs the captured audio to `POST /api/voice` (WAV/PCM, see server
   docs). The spoken reply is played through the phone speaker; a condensed
   card lands in chat.
4. If a medium/high-risk tool fires mid-session, the approval card appears in
   the app AND the ring buzzes `0x01` (attention). Double-tap approves
   (see tap-to-approve); long-press cancels.

**Bandwidth note:** 640 bytes/20 ms = 32 kB/s — fine for BLE 4.2+ with a
reasonable connection interval. If packets drop, the app tolerates gaps;
the cloud VAD handles it.

## Tap-to-approve

While an approval card is pending for the user:

- **Double-tap** → `POST /api/devices/:id/tap {type:'double'}` → server
  approves the most recent pending card (ownership enforced) → response
  `{haptic:'success'}` → app writes HAPTIC_CMD `0x04`. On failure,
  `{haptic:'error'}` → `0x05`.
- **Long-press** → declines the most recent pending card → `0x05`.
- **Single tap** → reserved for voice invoke (see audio session).

Taps with no pending card: single/double behave as voice invoke; long-press
is a no-op (server returns `{haptic:'error'}` only to give feedback).

## Reconnect policy (app)

- Auto-reconnect with exponential backoff: 1 s, 2 s, 5 s, 15 s, 60 s, then
  every 60 s. Never show a blocking dialog; show a status dot.
- On reconnect: re-subscribe TAP_EVENT, read battery, re-register device
  (`last_seen_at` updates server-side).
- If the ring is unreachable for 10 min, send the user a quiet notification
  ("Ring out of range").

## Firmware MUST implement

- GATT server with the exact UUIDs, properties, and byte formats above.
- Tap classification in firmware (debounce 60 ms; double-tap window 400 ms;
  long-press threshold 600 ms) — the app must never see raw accelerometer
  noise.
- AUDIO_STREAM frames exactly 640 bytes, cadence 50 Hz while enabled.
  Notifications stop within 100 ms of the app unsubscribing.
- HAPTIC_CMD patterns as tabled above; motor must not run longer than 2 s
  even on garbage input (watchdog).
- Battery Level notify on ±5% change; deep-sleep when disconnected.

## App handles (firmware does NOT)

- VAD, silence detection, speech-to-text, agent calls, text-to-speech.
- Tap semantics (approve/decline/invoke) — firmware only reports gesture ids.
- Reconnect policy, pairing UX, device registration.
- Anything resembling AI, networking, or auth.

## Open decisions for the firmware co-founder

1. Exact tap-sensor hardware (capacitive touch pad vs. accelerometer tap
   detection) — affects power budget and false-positive rate.
2. Whether long-press should also wake the audio session (current contract:
   no-op unless an approval is pending).
3. Haptic motor choice (ERM vs. LRA) — LRA gives crisper patterns but costs more.
4. Deep-sleep current target (aim: <50 µA disconnected, ~7-day battery).
5. Whether the ring should buzz on incoming high-priority notifications
   (calendar "leave now") — app-side feature, needs a new HAPTIC pattern id.
