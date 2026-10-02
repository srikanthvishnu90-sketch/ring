// backend/lib/live_view.js — Stream Ring's browser to the chat UI in real-time.
//
// When Ring's intelligence layer acts, capture a screenshot after each step
// and broadcast it via Supabase Realtime. The frontend subscribes and shows
// a live view of what Ring sees and does.

const { broadcastRealtime } = require('./realtime');

// Broadcast a screenshot for a thread.
// Call this after each browser action to update the live view.
async function pushFrame({ threadId, page, label, step, bbSessionId, sessionId, needHelp, showBrowser }) {
  if (!threadId || !page) {
    if (!threadId) console.log('[live_view] No threadId, skipping frame broadcast');
    return false;
  }
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 50 });
    const base64 = buf.toString('base64');
    const ok = await broadcastRealtime(`thread:${threadId}`, 'browser_frame', {
      image: base64,
      label: label || '',
      step: step || 0,
      url: page.url().slice(0, 120),
      // Browserbase live session URL for "take over"
      liveUrl: bbSessionId ? `https://www.browserbase.com/sessions/${bbSessionId}` : null,
      sessionId: sessionId || null, // Ring session ID for Take Over proxy (no Browserbase login needed)
      needHelp: !!needHelp, // agent explicitly needs the user's hands → frontend reveals panel + Take Over
      showBrowser: !!showBrowser, // force panel visible (rare)
      ts: Date.now(),
    });
    console.log(`[live_view] Frame broadcast to thread:${threadId}: ${ok ? 'ok' : 'failed'}`);
    return !!ok;
  } catch (e) {
    // Best-effort; never break the automation for the live view
    console.log('[live_view] Frame error:', e.message);
    return false;
  }
}

// Broadcast a status update (what Ring is thinking/doing).
async function pushStatus({ threadId, status, detail, needHelp, sessionId }) {
  if (!threadId) return;
  try {
    await broadcastRealtime(`thread:${threadId}`, 'browser_status', {
      status,
      detail: (detail || '').slice(0, 200),
      needHelp: !!needHelp, // agent needs user intervention → frontend reveals Take Over
      sessionId: sessionId || null,
      ts: Date.now(),
    });
  } catch {}
}

module.exports = { pushFrame, pushStatus };
