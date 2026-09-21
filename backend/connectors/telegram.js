// Telegram connector — Bot API for messaging the user where they already are.
// Needs: TELEGRAM_BOT_TOKEN (from @BotFather). Optional: TELEGRAM_WEBHOOK_SECRET
// to gate POST /api/telegram/webhook (see server.js).
//
// Powers "text me on Telegram": send a message to any chat, read recent
// inbound messages, and receive webhook events from Telegram.
//
// NOTE: telegram_send is risk 'medium' — the agent may only call it after a
// tap/voice confirm or via an in-app approval card, never silently.
const { env, missing, NotConfigured } = require('../lib/config');

const id = 'telegram';
const name = 'Telegram';
const description = 'Send and read Telegram messages via a Bot API token; inbound webhook lands in per-sender threads.';
const envVars = ['TELEGRAM_BOT_TOKEN'];
const requiredEnv = envVars; // server.js /api/connectors reads this

function status() {
  const m = missing(requiredEnv);
  return { ok: m.length === 0, missing: m };
}

function guard() {
  const m = missing(requiredEnv);
  if (m.length) throw new NotConfigured('Telegram', m);
}

function apiUrl(method) {
  return `https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/${method}`;
}

// Keep the token out of error messages.
async function tg(method, body) {
  guard();
  const r = await fetch(apiUrl(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) {
    throw new Error(`Telegram ${method} failed (${r.status}): ${String(data.description || 'unknown error').slice(0, 160)}`);
  }
  return data.result;
}

async function sendMessage({ chat_id, text }) {
  if (!chat_id) throw new Error('chat_id is required');
  if (!text || typeof text !== 'string') throw new Error('text is required');
  const msg = await tg('sendMessage', { chat_id, text: text.slice(0, 4096) });
  return { message_id: msg.message_id, chat_id: msg.chat?.id, date: msg.date };
}

async function history({ limit = 20 } = {}) {
  const updates = await tg('getUpdates', { limit: Math.min(Math.max(limit | 0, 1), 50), timeout: 0 });
  return (updates || [])
    .filter((u) => u.message)
    .map((u) => ({
      update_id: u.update_id,
      chat_id: u.message.chat.id,
      from: u.message.from?.first_name || u.message.from?.username || 'unknown',
      text: u.message.text || '',
      date: u.message.date,
    }));
}

const tools = [
  {
    name: 'telegram_send', risk: 'medium', fn: sendMessage,
    schema: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'text'] },
    describe: 'Send a Telegram message via the bot (needs user confirmation)',
  },
  {
    name: 'telegram_history', risk: 'low', fn: history,
    schema: { type: 'object', properties: { limit: { type: 'number' } } },
    describe: 'Read recent inbound Telegram messages',
  },
];

module.exports = { id, name, description, envVars, requiredEnv, status, sendMessage, history, tools };
