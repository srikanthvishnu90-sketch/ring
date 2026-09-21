// Supabase Realtime Broadcast via REST.
//
// Server-side fan-out for cross-instance realtime: POSTing here pushes a
// broadcast event to every websocket client subscribed to the topic,
// regardless of which serverless instance produced it. Clients subscribe to
// the Phoenix topic `realtime:<topic>` (the `realtime:` prefix is added by
// the client side; the REST API takes the bare topic name).
//
// No-op when Supabase isn't configured. Never throws.
const { env } = require('./config');
const { ENABLED } = require('./supabase');

const SB_URL = env('SUPABASE_URL');
const SB_KEY = env('SUPABASE_SERVICE_KEY');

async function broadcastRealtime(topic, event, payload) {
  try {
    if (!ENABLED) return false;
    const r = await fetch(`${SB_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: [{ topic, event, payload }] }),
    });
    if (!r.ok) throw new Error(`Realtime broadcast ${r.status}`);
    return true;
  } catch (e) {
    return false; // realtime is best-effort; the local path must never break
  }
}

module.exports = { broadcastRealtime };
