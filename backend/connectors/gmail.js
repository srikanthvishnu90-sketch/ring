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
    scopes: ['gmail.readonly', 'gmail.send', 'gmail.modify'],
  };
}

function guard() {
  const m = missing(requiredEnv);
  if (m.length) throw new NotConfigured('Gmail', m);
}

const header = (m, name) =>
  (m.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

// Run async fn over items with at most `limit` in flight. Gmail's per-user
// rate limit punishes burst fan-out (30 threads x metadata+body via
// Promise.all = 60 concurrent requests -> 429s), so batch readers stay
// sequential-ish here.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// gfetch with backoff on rate-limit responses. A 429 is transient —
// retrying a few seconds later usually succeeds — so a whole-topic read
// degrades to "unknown, retry me" only after real retries, never on the
// first 429.
async function gfetchRetry(userId, url, opts, tries = 4) {
  let delay = 1500;
  for (let n = 0; n < tries; n++) {
    try {
      return await gfetch(userId, url, opts);
    } catch (e) {
      const transient = /429|rate|quota|exhausted|too many/i.test(e.message || '');
      if (transient && n < tries - 1) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw e;
    }
  }
}

async function searchMessages({ userId, query, maxResults = 30 }) {
  guard();
  // maxResults counts THREADS, not messages: page through matches
  // (newest-first) until we have that many unique threads, so a broad
  // query's older threads are never silently cut off by a message cap.
  const seen = new Set();
  const threads = [];
  let pageToken = null;
  let fetchedMsgs = 0;
  const MSG_CAP = 300;
  do {
    let url =
      `https://gmail.googleapis.com/gmail/v1/users/me/messages` +
      `?q=${encodeURIComponent(query)}&maxResults=${Math.min(100, MSG_CAP - fetchedMsgs)}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const list = await gfetchRetry(userId, url);
    const batch = list.messages || [];
    fetchedMsgs += batch.length;
    const full = await mapLimit(
      batch,
      5,
      (m) =>
        gfetchRetry(
          userId,
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
        )
    );
    // Collapse to one entry per thread (matches arrive newest-first, so
    // the first message seen per thread is its latest).
    for (const m of full) {
      if (seen.has(m.threadId)) continue;
      seen.add(m.threadId);
      threads.push({
        threadId: m.threadId,
        subject: header(m, 'Subject'),
        from: header(m, 'From'),
        to: header(m, 'To'),
        date: header(m, 'Date'),
        snippet: (m.snippet || '').slice(0, 80),
      });
      if (threads.length >= maxResults) break;
    }
    pageToken = list.nextPageToken;
  } while (pageToken && threads.length < maxResults && fetchedMsgs < MSG_CAP);
  return { threads, hasMore: !!pageToken && threads.length >= maxResults };
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
  if (!to) throw new Error('recipient is required');
  if (!body) throw new Error('email body is required');
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
// Scan the recent inbox (read AND unread — unread-only triage misses action
// items the user has already glanced at), collapse to one entry per thread
// (its latest message), and bucket each into urgent / needs-reply / fyi.
// Threads where the user already has the last word are excluded: nothing to
// reply to. Categorization is a deterministic heuristic; the agent refines
// from full content before acting on anything.
const URGENT_RE = /\b(urgent|asap|action required|payment failed|declined|overdue|expires? (today|tomorrow)|security alert|unauthorized|immediately)\b/i;
const REPLY_RE = /(\?|let me know|can you|please confirm|need your|reply|rsvp|action needed|follow up|verify)/i;
const FYI_RE = /^(unsubscribe|newsletter|promotion|noreply|no-reply|donotreply)/i;

function triageOne(m) {
  const subject = header(m, 'Subject');
  const from = header(m, 'From');
  const labels = m.labelIds || [];
  const text = `${subject} ${m.snippet || ''}`;
  // Gmail's own bulk categories first: a promo "?" must never read as needs-reply.
  if (
    (labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_SOCIAL')) &&
    !URGENT_RE.test(text)
  ) {
    return { category: 'fyi', reason: 'Promotional/social bulk mail' };
  }
  if (URGENT_RE.test(text)) {
    const kw = (text.match(URGENT_RE) || [])[0];
    return { category: 'urgent', reason: `Matched "${kw}" in subject/snippet`, signal: kw };
  }
  // Bulk/newsletter senders next: a promo subject with a rhetorical "?"
  // must not outrank the sender signal and land in needs-reply.
  if (FYI_RE.test(from) || FYI_RE.test(subject)) {
    return { category: 'fyi', reason: 'Bulk/newsletter-style sender, no action implied' };
  }
  if (REPLY_RE.test(text)) {
    const kw = (text.match(REPLY_RE) || [])[0];
    return { category: 'needs-reply', reason: `Asks for a response ("${kw}")`, signal: kw };
  }
  return { category: 'fyi', reason: 'No urgency or reply request detected' };
}

async function triageMessages({ userId, maxResults = 25 }) {
  guard();
  const me = (
    await gfetch(userId, 'https://gmail.googleapis.com/gmail/v1/users/me/profile').catch(() => ({}))
  ).emailAddress || '';
  const meLow = me.toLowerCase();
  // Fetch enough messages to cover the whole 2-day window: the newest N
  // messages can span fewer threads than maxResults when bulk mail arrives
  // in bursts, so over-fetch messages before collapsing to threads.
  const list = await gfetch(
    userId,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent('in:inbox newer_than:2d')}&maxResults=80`
  );
  const full = await Promise.all(
    (list.messages || []).map((m) =>
      gfetch(
        userId,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`
      )
    )
  );
  // One entry per thread: messages.list is newest-first, so the first
  // message seen per thread is its latest.
  const latestByThread = new Map();
  for (const m of full) {
    if (!latestByThread.has(m.threadId)) latestByThread.set(m.threadId, m);
  }
  const items = [];
  for (const m of latestByThread.values()) {
    const from = header(m, 'From') || '';
    // User already has the last word — nothing needs a reply.
    if (meLow && from.toLowerCase().includes(meLow)) continue;
    items.push({
      id: m.id,
      subject: header(m, 'Subject'),
      from,
      date: header(m, 'Date'),
      unread: (m.labelIds || []).includes('UNREAD'),
      snippet: (m.snippet || '').slice(0, 220),
      ...triageOne(m),
    });
    if (items.length >= maxResults) break;
  }
  const counts = { urgent: 0, 'needs-reply': 0, fyi: 0 };
  for (const it of items) counts[it.category]++;
  // Actionable first: if a downstream consumer truncates the payload, the
  // urgent / needs-reply items must survive, not the promo noise.
  const rank = { urgent: 0, 'needs-reply': 1, fyi: 2 };
  items.sort((a, b) => rank[a.category] - rank[b.category]);
  // Pre-digested action list: short imperative lines up top so the agent
  // relays each one instead of skimming past a long JSON array.
  const actionItems = items
    .filter((it) => it.category === 'urgent' || it.category === 'needs-reply')
    .map((it) => {
      const name = (it.from || '').split('<')[0].trim().replace(/^"|"$/g, '') || it.from;
      const subj = it.subject || '(no subject)';
      let snip = it.snippet || '';
      // Center on the sentence carrying the reply signal, so the action
      // itself is named — not a pleasantry from the first sentence.
      if (it.signal) {
        const idx = snip.toLowerCase().indexOf(it.signal.toLowerCase());
        if (idx >= 0) {
          const start = Math.max(0, idx - 70);
          snip = (start > 0 ? '…' : '') + snip.slice(start, idx + 90).trim();
        } else {
          snip = snip.slice(0, 140);
        }
      } else {
        snip = snip.slice(0, 140);
      }
      return `${name} — ${subj}: ${snip}`;
    });
  return { counts, actionItems, messages: items };
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
  // Full text of each message (truncated): snippets alone mislead
  // categorization (a polite "thank you for reaching out" can precede a
  // decline buried mid-body). Fetch bodies in parallel.
  const fullBodies = await Promise.all(
    msgs.map(async (m) => {
      try {
        const fm = await gfetch(
          userId,
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`
        );
        const raw = findTextBody(fm.payload);
        const txt = raw ? Buffer.from(raw, 'base64url').toString('utf8') : '';
        return txt.replace(/\s+/g, ' ').trim().slice(0, 1200);
      } catch {
        return m.snippet || '';
      }
    })
  );
  const bodies = fullBodies.filter(Boolean);
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
    messages: msgs.map((m, i) => ({
      from: header(m, 'From'),
      date: header(m, 'Date'),
      body: fullBodies[i] || '',
    })),
    actionItems: actions,
  };
}

// First-pass reply-stance signal from the latest inbound text. The agent
// MUST verify against latestReply.body before finalizing — this is a hint,
// not a verdict.
function classifyStance(text) {
  const t = (text || '').toLowerCase();
  if (/(undeliverable|delivery (status )?fail|address not found|mailbox unavailable|bounced)/.test(t)) return 'bounced';
  if (/(do not|don't|does not|doesn't) (provide|offer|manufacture)|unable to|cannot support|can't support|not taking|declin|pass(ing)? on|outside (of )?our (scope|business|product)|not (a |our )(product|service|business)|no longer|discontinu/.test(t)) return 'declined';
  if (/(nre|moq|unit price|quotation|quote|prototype cost|\$\s?\d)/.test(t)) return 'quoted';
  if (/(interested|would love|happy to|excited|let's|schedule a call|please (share|send)|send us|nda|next step)/.test(t)) return 'interested';
  return t ? 'replied' : 'no-reply';
}

// Strip HTML to readable text for HTML-only emails (marketing/portal mail
// often has no text/plain part — without this the detail is <meta> garbage).
function htmlToText(html) {
  return (html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanBodyText(txt) {
  const t = (txt || '').trim();
  return /<[a-z][^>]*>/i.test(t) ? htmlToText(t) : t;
}

// Pull the decline sentence(s) out of a longer reply so a polite opening
// never buries the verdict (the failure this tool exists to prevent).
function extractDecline(text) {
  const pat = /(do not|don't|does not|doesn't) (provide|offer|manufacture)|unable to|cannot support|can't support|not taking|declin|pass(ing)? on|outside (of )?our (scope|business|product)|not (a |our )(product|service|business)|no longer|discontinu/i;
  const hits = (text || '').split(/(?<=[.!?])\s+/).filter((s) => pat.test(s));
  return hits.slice(0, 3).join(' ');
}

// --- Batch thread read ------------------------------------------------------
// Read up to 30 threads in ONE tool call, so whole-topic questions
// ("all the emails about X") get complete coverage in a single round — the
// tool does the exhaustive fetching (it doesn't get lazy), the model
// synthesizes. Returns one compact row per thread: vendor, a first-pass
// stance signal (interested/quoted/declined/bounced/replied/no-reply —
// VERIFY against the detail text before trusting it), and the key detail:
// for declines, the decline sentence(s) themselves (a polite opening never
// buries the verdict); otherwise the opening of the latest reply from the
// other party. Full bodies stay one gmail_thread call away.
async function readThreads({ userId, threadIds }) {
  guard();
  const ids = [...new Set(threadIds || [])].slice(0, 30);
  if (!ids.length) throw new Error('threadIds is required (array of thread ids from gmail_search)');
  let owner = '';
  try {
    const prof = await gfetch(userId, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
    owner = (prof.emailAddress || '').toLowerCase();
  } catch {
    owner = '';
  }
  const threads = await mapLimit(
    ids,
    5,
    async (threadId) => {
      try {
        const t = await gfetchRetry(
          userId,
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
        );
        const msgs = t.messages || [];
        const participants = [...new Set(msgs.map((m) => header(m, 'From')).filter(Boolean))];
        const vendor = (participants.find((p) => !owner || !p.toLowerCase().includes(owner)) || participants[0] || '').slice(0, 60);
        // Newest message not from the account owner = the latest follow-up.
        const inbound = [...msgs]
          .reverse()
          .find((m) => !owner || !header(m, 'From').toLowerCase().includes(owner));
        if (!inbound) return { threadId, vendor, stance: 'no-reply', detail: null };
        try {
          const fm = await gfetchRetry(
            userId,
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${inbound.id}?format=full`
          );
          const raw = findTextBody(fm.payload);
          const fullTxt = cleanBodyText(
            (raw ? Buffer.from(raw, 'base64url').toString('utf8').replace(/\s+/g, ' ').trim() : '') || inbound.snippet || ''
          );
          const stance = classifyStance(fullTxt);
          const detail = (stance === 'declined' ? extractDecline(fullTxt) || fullTxt : fullTxt).slice(0, 150);
          return { threadId, vendor, stance, detail: detail || null };
        } catch {
          // Full text unavailable even after retries: report unknown, NEVER
          // categorize from the snippet (a polite snippet opening is not a
          // positive follow-up). The model must list these as unreadable.
          return { threadId, vendor, stance: 'unknown', detail: 'Full reply text unavailable (temporary API limit) — not categorized.' };
        }
      } catch (e) {
        return { threadId, vendor: '', stance: 'error', detail: e.message.slice(0, 100) };
      }
    }
  );
  const counts = {};
  for (const t of threads) counts[t.stance] = (counts[t.stance] || 0) + 1;
  return { readCount: threads.length, truncated: (threadIds || []).length > ids.length, counts, threads };
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
  const d = await gfetch(userId, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
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
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`
      )
    )
  );
  const receipts = full.map((m) => {
    const from = header(m, 'From');
    const merchant = from.replace(/<[^>]*>/, '').replace(/"/g, '').trim() || from;
    const amount = extractReceiptAmount(m);
    return {
      id: m.id,
      merchant,
      amount,
      order: extractReceiptOrderNo(m),
      date: header(m, 'Date'),
      subject: header(m, 'Subject'),
    };
  });
  return { receipts };
}

// Amount extraction for receipts: prefer a total near total-like keywords in
// the message body, fall back to the first $X.XX anywhere; treat $0 as null
// (promo "$0 delivery" copy is not a purchase amount).
const TOTAL_RE = /(?:grand total|order total|total|amount (?:due|charged)|charged|balance)\D{0,40}(\$[\d,]+\.\d{2})/i;
// Order/confirmation number: shipping/confirmation emails for one order share
// it, so spending totals can dedupe them across days.
const ORDER_NO_RE = /(?:order|confirm(?:ation|ed)?|receipt)[\s#:]*([A-Z0-9][A-Z0-9-]{4,39})/i;
function extractReceiptOrderNo(m) {
  let bodyText = '';
  try {
    const raw = findTextBody(m.payload);
    if (raw) bodyText = Buffer.from(raw, 'base64url').toString('utf8');
  } catch { /* subject only */ }
  const mt = (`${header(m, 'Subject')}\n${bodyText}`).match(ORDER_NO_RE);
  return mt ? mt[1] : null;
}
function extractReceiptAmount(m) {
  let bodyText = '';
  try {
    const raw = findTextBody(m.payload);
    if (raw) bodyText = Buffer.from(raw, 'base64url').toString('utf8');
  } catch { /* fall through to snippet */ }
  const hay = `${bodyText}\n${m.snippet || ''}`;
  const total = hay.match(TOTAL_RE);
  const pick = (total && total[1]) || (hay.match(AMOUNT_RE) || [])[0];
  if (!pick) return null;
  const num = parseFloat(pick.replace(/[$,]/g, ''));
  if (!num || num <= 0) return null; // "$0 delivery" promos are not amounts
  return pick;
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
  readThreads,
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
