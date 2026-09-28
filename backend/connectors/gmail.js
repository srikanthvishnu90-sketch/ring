// Gmail connector — read + send via the Gmail API (OAuth 2.0).
// Needs: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (+ per-user tokens from
// /auth/google, kept server-side in lib/google.js — never in the repo).
const { missing, NotConfigured } = require('../lib/config');
const { gfetch } = require('../lib/google');

const requiredEnv = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];

function status() {
  const m = missing(requiredEnv);
  return {
    ok: m.length === 0,
    missing: m,
    auth: 'oauth2',
    // Honest generic status: never claim "connected" from server-side
    // token state (a token-file presence check can't prove a live grant).
    // Real per-user state comes only from authenticated
    // GET /api/oauth/google/status.
    connected: false,
    perUser: '/api/oauth/google/status',
    scopes: ['gmail.readonly', 'gmail.send'],
  };
}

function guard() {
  const m = missing(requiredEnv);
  if (m.length) throw new NotConfigured('Gmail', m);
}

const header = (m, name) =>
  (m.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

async function searchMessages({ userId, query, maxResults = 5 }) {
  guard();
  const list = await gfetch(
    userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`
  );
  const full = await Promise.all(
    (list.messages || []).map((m) =>
      gfetch(
        userId,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
      )
    )
  );
  return {
    messages: full.map((m) => ({
      id: m.id,
      subject: header(m, 'Subject'),
      from: header(m, 'From'),
      date: header(m, 'Date'),
      snippet: m.snippet,
    })),
  };
}

// Walk a Gmail payload tree and return the first text/plain body (base64url).
function findTextBody(payload) {
  if (!payload) return null;
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) return payload.body.data;
  for (const part of payload.parts || []) {
    const hit = findTextBody(part);
    if (hit) return hit;
  }
  return (payload.body && payload.body.data) || null;
}

async function readMessage({ userId, id }) {
  guard();
  if (!id) throw new Error('message id is required');
  const m = await gfetch(
    userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`
  );
  const raw = findTextBody(m.payload);
  return {
    id: m.id,
    subject: header(m, 'Subject'),
    from: header(m, 'From'),
    date: header(m, 'Date'),
    body: raw ? Buffer.from(raw, 'base64url').toString('utf8').slice(0, 8000) : '',
  };
}

async function sendMessage({ userId, to, subject, body }) {
  guard();
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
    'utf8'
  ).toString('base64url');
  const sent = await gfetch(userId, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw }),
  });
  return { id: sent.id, to, subject };
}

// --- Triage (3) ------------------------------------------------------------
// List unread inbox and bucket each message into urgent / needs-reply / fyi
// with a one-line reason. Categorization is a deterministic heuristic; the
// agent refines from full content before acting on anything.
const URGENT_RE = /\b(urgent|asap|action required|payment failed|declined|overdue|expires? (today|tomorrow)|security alert|unauthorized|immediately)\b/i;
const REPLY_RE = /(\?|please let me know|can you|please confirm|need your|reply|rsvp|action needed|follow up)/i;
const FYI_RE = /^(unsubscribe|newsletter|promotion|noreply|no-reply|donotreply)/i;

function triageOne(m) {
  const subject = header(m, 'Subject');
  const from = header(m, 'From');
  const text = `${subject} ${m.snippet || ''}`;
  if (URGENT_RE.test(text)) {
    const kw = (text.match(URGENT_RE) || [])[0];
    return { category: 'urgent', reason: `Matched "${kw}" in subject/snippet` };
  }
  if (REPLY_RE.test(text)) {
    const kw = (text.match(REPLY_RE) || [])[0];
    return { category: 'needs-reply', reason: `Asks for a response ("${kw}")` };
  }
  if (FYI_RE.test(from) || FYI_RE.test(subject)) {
    return { category: 'fyi', reason: 'Bulk/newsletter-style sender, no action implied' };
  }
  return { category: 'fyi', reason: 'No urgency or reply request detected' };
}

async function triageMessages({ userId, maxResults = 10 }) {
  guard();
  const list = await gfetch(
    userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent('is:unread in:inbox')}&maxResults=${maxResults}`
  );
  const full = await Promise.all(
    (list.messages || []).map((m) =>
      gfetch(
        userId,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
      )
    )
  );
  const items = full.map((m) => ({
    id: m.id,
    subject: header(m, 'Subject'),
    from: header(m, 'From'),
    date: header(m, 'Date'),
    ...triageOne(m),
  }));
  const counts = { urgent: 0, 'needs-reply': 0, fyi: 0 };
  for (const it of items) counts[it.category]++;
  return { counts, messages: items };
}

// --- Thread (4) ------------------------------------------------------------
// Fetch a full thread: concise summary + key dates + action items (heuristic).
async function readThread({ userId, threadId }) {
  guard();
  if (!threadId) throw new Error('thread id is required');
  const t = await gfetch(
    userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
  );
  const msgs = t.messages || [];
  const participants = [...new Set(msgs.map((m) => header(m, 'From')).filter(Boolean))];
  const dates = msgs.map((m) => header(m, 'Date')).filter(Boolean);
  const subjects = [...new Set(msgs.map((m) => header(m, 'Subject')).filter(Boolean))];
  const bodies = msgs.map((m) => m.snippet || '').filter(Boolean);
  const actions = bodies
    .flatMap((s) => s.split(/(?<=[.!?])\s+/))
    .filter((s) => /(\?|please|could you|need|action|deadline|due)/i.test(s))
    .slice(0, 5);
  return {
    threadId: t.id,
    messageCount: msgs.length,
    participants,
    firstDate: dates[0] || null,
    lastDate: dates[dates.length - 1] || null,
    subjects,
    summary: bodies[0]
      ? `Started: "${bodies[0].slice(0, 160)}"${bodies.length > 1 ? ` … Latest: "${bodies[bodies.length - 1].slice(0, 160)}"` : ''}`
      : 'No message bodies available.',
    actionItems: actions,
  };
}

// Build a base64url RFC2822 message.
function mimeRaw(headers, body) {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  return Buffer.from(`${head}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body || ''}`, 'utf8').toString(
    'base64url'
  );
}

// --- Reply (5, HIGH) --------------------------------------------------------
// Reply to a message, threaded (In-Reply-To/References + threadId). The exact
// body goes through the agent's approval card before this ever runs.
async function replyMessage({ userId, id, body }) {
  guard();
  if (!id) throw new Error('message id is required');
  if (!body) throw new Error('reply body is required');
  const m = await gfetch(
    userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Message-ID&metadataHeaders=Date`
  );
  const msgId = header(m, 'Message-ID');
  const subject = header(m, 'Subject');
  const to = header(m, 'From');
  const reSubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const raw = mimeRaw(
    { To: to, Subject: reSubject, 'In-Reply-To': msgId, References: msgId },
    body
  );
  const sent = await gfetch(userId, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw, threadId: m.threadId }),
  });
  return { id: sent.id, threadId: sent.threadId, to, subject: reSubject };
}

// --- Forward (6, HIGH) ------------------------------------------------------
// Forward a message to `to`, quoting the original headers + body.
async function forwardMessage({ userId, id, to }) {
  guard();
  if (!id) throw new Error('message id is required');
  if (!to) throw new Error('recipient is required');
  const m = await gfetch(
    userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`
  );
  const rawBody = findTextBody(m.payload);
  const text = rawBody ? Buffer.from(rawBody, 'base64url').toString('utf8').slice(0, 8000) : '';
  const quoted =
    `\n\n---------- Forwarded message ----------\n` +
    `From: ${header(m, 'From')}\nDate: ${header(m, 'Date')}\nSubject: ${header(m, 'Subject')}\nTo: ${header(m, 'To')}\n\n${text}`;
  const raw = mimeRaw({ To: to, Subject: `Fwd: ${header(m, 'Subject')}` }, quoted);
  const sent = await gfetch(userId, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw }),
  });
  return { id: sent.id, to, subject: `Fwd: ${header(m, 'Subject')}` };
}

// --- Draft (8) --------------------------------------------------------------
async function createDraft({ userId, to, subject, body }) {
  guard();
  if (!to) throw new Error('recipient is required');
  const raw = mimeRaw({ To: to, Subject: subject || '' }, body || '');
  const d = await gfetch(userId, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/create', {
    method: 'POST',
    body: JSON.stringify({ message: { raw } }),
  });
  return { draftId: d.id, messageId: d.message && d.message.id, to, subject: subject || '' };
}

// --- Trash (9, MEDIUM) ------------------------------------------------------
async function trashMessage({ userId, id }) {
  guard();
  if (!id) throw new Error('message id is required');
  const m = await gfetch(
    userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/trash`,
    { method: 'POST' }
  );
  return { id: m.id, trashed: true };
}

// --- Archive (10) -----------------------------------------------------------
async function archiveMessage({ userId, id }) {
  guard();
  if (!id) throw new Error('message id is required');
  const m = await gfetch(
    userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`,
    { method: 'POST', body: JSON.stringify({ removeLabelIds: ['INBOX'] }) }
  );
  return { id: m.id, archived: true };
}

// --- Mark read/unread (11) ---------------------------------------------------
async function markMessage({ userId, id, read }) {
  guard();
  if (!id) throw new Error('message id is required');
  const m = await gfetch(
    userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`,
    {
      method: 'POST',
      body: JSON.stringify(
        read ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] }
      ),
    }
  );
  return { id: m.id, read: !!read };
}

// --- Star/unstar (12) --------------------------------------------------------
async function starMessage({ userId, id, starred }) {
  guard();
  if (!id) throw new Error('message id is required');
  const m = await gfetch(
    userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`,
    {
      method: 'POST',
      body: JSON.stringify(
        starred ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] }
      ),
    }
  );
  return { id: m.id, starred: !!starred };
}

// --- Receipts (13) -----------------------------------------------------------
// Order confirmations / receipts via Gmail search operators. Amounts are a
// regex heuristic on the snippet, not authoritative totals.
const AMOUNT_RE = /[$€£]\s?[\d,]+(?:\.\d{2})?/;

async function findReceipts({ userId, days = 30 }) {
  guard();
  const q = `newer_than:${Math.max(1, Math.min(365, Number(days) || 30))}d (subject:receipt OR subject:order OR subject:confirmation OR subject:invoice OR subject:"payment received")`;
  const list = await gfetch(
    userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=20`
  );
  const full = await Promise.all(
    (list.messages || []).map((m) =>
      gfetch(
        userId,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
      )
    )
  );
  const receipts = full.map((m) => {
    const from = header(m, 'From');
    const merchant = from.replace(/<[^>]*>/, '').replace(/"/g, '').trim() || from;
    const amount = (m.snippet || '').match(AMOUNT_RE);
    return {
      id: m.id,
      merchant,
      amount: amount ? amount[0] : null,
      date: header(m, 'Date'),
      subject: header(m, 'Subject'),
    };
  });
  return { receipts };
}

// --- Attachments (14) --------------------------------------------------------
// Messages with attachments for a query; walks the payload tree for file
// parts. Lists metadata only — no attachment content is downloaded.
function walkAttachments(payload, out) {
  if (!payload) return;
  if (payload.filename && (payload.body || {}).size > 0) {
    out.push({
      filename: payload.filename,
      mimeType: payload.mimeType,
      size: payload.body.size,
    });
  }
  for (const part of payload.parts || []) walkAttachments(part, out);
}

async function findAttachments({ userId, query }) {
  guard();
  if (!query) throw new Error('query is required');
  const list = await gfetch(
    userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(`has:attachment ${query}`)}&maxResults=10`
  );
  const full = await Promise.all(
    (list.messages || []).map((m) =>
      gfetch(userId, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`)
    )
  );
  const out = [];
  for (const m of full) {
    const parts = [];
    walkAttachments(m.payload, parts);
    for (const p of parts) out.push({ ...p, messageId: m.id, subject: header(m, 'Subject') });
  }
  return out;
}

module.exports = {
  requiredEnv,
  status,
  searchMessages,
  readMessage,
  sendMessage,
  triageMessages,
  readThread,
  replyMessage,
  forwardMessage,
  createDraft,
  trashMessage,
  archiveMessage,
  markMessage,
  starMessage,
  findReceipts,
  findAttachments,
};
