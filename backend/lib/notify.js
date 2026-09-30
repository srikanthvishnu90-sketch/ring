// notify.js — fan-out user notifications for background work.
// Used by: trip tracker (Uber arrival), long-running task completion, reminders.
//
// Channels (best-effort, in order):
//   1. Supabase Realtime broadcast → topic `user:<userId>` event `notify`
//      (lights up the Ring app if it's open; the client subscribes on boot).
//   2. Telegram DM → if the user's Telegram chat_id is known (they messaged
//      the bot at least once; see resolveTelegramChat).
//
// Never throws. Returns { realtime: bool, telegram: bool }.
// Notification CONTENT policy: informational only (arrival, completion).
// Outbound actions (sends, bookings) still go through approval cards.
const { broadcastRealtime } = require('./realtime');
const memory = require('./memory');

let tg = null;
function telegram() {
  if (!tg) {
    try { tg = require('../connectors/telegram'); } catch { tg = false; }
  }
  return tg || null;
}

// The user's Telegram chat_id, learned when they message the bot.
// Stored as a memory so it survives restarts. Set via linkTelegramChat().
const TG_CHAT_KEY = 'notify.telegram_chat_id';

async function getTelegramChat(userId) {
  try {
    const ms = await memory.list(userId, TG_CHAT_KEY).catch(() => []);
    const m = (ms || []).find((x) => x.key === TG_CHAT_KEY || x.text);
    if (m) return m.value || m.text || null;
  } catch { /* fall through */ }
  return null;
}

async function linkTelegramChat(userId, chatId) {
  try {
    await memory.save(userId, TG_CHAT_KEY, String(chatId));
    return true;
  } catch { return false; }
}

// Scan recent bot updates for a private message and link the sender.
// Call after asking the user to message the bot. Returns chat_id or null.
async function resolveTelegramChatFromUpdates(userId) {
  const t = telegram();
  if (!t) return null;
  try {
    const updates = await t.history({ limit: 20 });
    const priv = updates.find((u) => u.chat_id);
    if (priv) {
      await linkTelegramChat(userId, priv.chat_id);
      return priv.chat_id;
    }
  } catch { /* best effort */ }
  return null;
}

async function notifyUser(userId, { title, body, kind = 'info' } = {}) {
  const text = title ? `${title}\n${body || ''}`.trim() : (body || '');
  const out = { realtime: false, telegram: false };
  if (!text) return out;
  // 1. In-app realtime (never throws).
  try {
    out.realtime = await broadcastRealtime(`user:${userId}`, 'notify', { title, body, kind, at: new Date().toISOString() });
  } catch { /* no-op */ }
  // 2. Telegram DM (needs linked chat).
  try {
    const chatId = await getTelegramChat(userId);
    const t = telegram();
    if (chatId && t) {
      await t.sendMessage({ chat_id: chatId, text: text.slice(0, 4000) });
      out.telegram = true;
    }
  } catch { /* best effort */ }
  return out;
}

module.exports = { notifyUser, getTelegramChat, linkTelegramChat, resolveTelegramChatFromUpdates };
