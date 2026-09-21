# Connectors

How to add a new connector (SMS, Telegram, Stripe, smart home, …) to Ring.
Written for an independent coding agent: follow it exactly and you won't need
to ask anyone anything.

## 1. Where things live

```
backend/connectors/<id>.js      ← your connector module
backend/connectors/registry.js  ← add ONE line: require it in CONNECTORS
backend/lib/agent.js            ← no changes needed (picks up tools automatically)
backend/server.js               ← only if you need a webhook route (see §6)
```

Do NOT put connector code in `backend/lib/` — connectors are top-level
citizens under `backend/connectors/`.

## 2. The connector module contract

Export exactly this shape:

```js
module.exports = {
  id: 'telegram',                       // lowercase, URL-safe, unique
  name: 'Telegram',                     // human display name
  description: 'Send and read Telegram messages',
  envVars: ['TELEGRAM_BOT_TOKEN'],      // every env var the connector needs
  status,                               // () => { ok, missing[], auth, connected, ... }
  tools,                                // array of tool objects (see §3). Optional.
};
```

`status()` rules:
- Call `missing(envVars)` from `../lib/config` — never invent your own check.
- Return `{ ok, missing, auth, connected }`. `connected` must NOT burn an API
  call: env-present ⇒ connected, unless you have a cheap cached token check.
- Extra fields (scopes, mode) are fine; keep them small — this ships in /api/health.

Errors: when env is missing, tool functions throw `NotConfigured` from
`../lib/config`. When the provider API fails, throw an `Error` with a `code`
property (e.g. `TWILIO_API_ERROR`) and a message safe to show the user —
never leak tokens or secrets in error text.

## 3. The tool object template

Copy this verbatim and fill it in:

```js
{
  name: 'telegram_send',          // unique across ALL connectors; prefix with the connector id
  risk: 'medium',                 // 'low' | 'medium' | 'high' — see §4
  describe: 'Send a Telegram message (always needs approval)',
  schema: {                       // JSON Schema for the model
    type: 'object',
    properties: {
      chatId: { type: 'string', description: 'Telegram chat id' },
      text:   { type: 'string', description: 'Message text (max 4096 chars)' },
    },
    required: ['chatId', 'text'],
  },
  fn: async ({ chatId, text }) => {
    // `userId` is injected by the agent loop — accept it as a param if you need it.
    // Return a plain JSON-serializable object.
    return { messageId: 123 };
  },
},
```

Notes:
- `fn` receives `{ userId, ...args }`. Always return JSON-safe values.
- Tool names are deduped by name across connectors (first registration wins);
  legacy tools in `lib/agent.js` always win over connector tools on collision,
  so prefix everything with your connector id.
- Validate inputs in `fn` (phone formats, ranges, required fields) — the model
  will send garbage eventually.

## 4. Risk-tier rules (non-negotiable)

| Tier | Meaning | Examples |
|------|---------|----------|
| `low` | Executes immediately, no confirmation | search, list, read, status, build a deep link |
| `medium` | Held as an approval card — user taps to confirm | **any send/message**, calendar create, reservation request |
| `high` | Held for in-app phone approval | **any money movement** (charge, refund, transfer), irreversible deletes |

Rules:
- Sends, messages, posts, and notifications are `medium` **minimum**.
- Money movement of any kind is `high`. No exceptions, no "small amounts" carve-out.
- If you're unsure between two tiers, pick the higher one.
- Standing product rule: **never build a voice-call tool** ("calls should never work").
- The approval gate lives in `server.js` + `lib/approvals.js` — you don't
  implement it, you just set the right `risk` and it applies automatically.

## 5. Idempotency & audit (non-negotiable)

- Every tool execution is logged to `ring_tool_runs` automatically — you don't
  log it yourself.
- Make tools **idempotent-safe**: a retry must not double-send/double-charge.
  Practical patterns: pass through an idempotency key when the provider
  supports one; keep `fn` free of hidden side effects beyond its one job;
  never retry a send inside `fn` — let the caller retry.
- Approval cards dedupe identical pending requests in a 10-minute window, and
  resolving a card is atomic (a card can only ever execute once) — don't
  re-implement this.

## 6. Webhooks (optional)

If the provider pushes events (Twilio inbound SMS, Stripe events, …):

1. Add the route in `server.js` near the other connector routes.
2. **Always verify the provider's signature** before touching any data.
   Invalid signature → `403`. No signature scheme → don't ship the webhook.
3. Parse the provider's native body format (Twilio sends
   `application/x-www-form-urlencoded` — mount `express.urlencoded()` on that
   route only).
4. Route the event into a thread via `lib/threads.js`
   (`createThread` / `postMessage`); `postMessage` already broadcasts to SSE
   and Supabase Realtime subscribers.
5. **No auto-replies.** Inbound events create visibility; outbound actions go
   through the agent + approval gate like everything else.

## 7. Checklist before you're done

- [ ] `backend/connectors/<id>.js` exports `{ id, name, description, envVars, status, tools }`
- [ ] Registered in `backend/connectors/registry.js` `CONNECTORS` map
- [ ] Every send/money tool has the correct risk tier (§4)
- [ ] Tool names prefixed with connector id; no collisions with existing tools
- [ ] `status()` uses `missing()` and makes no network calls
- [ ] Missing env → `NotConfigured`; provider errors → `Error` with `code`, no secrets in text
- [ ] Webhook (if any) verifies signatures, 403s on failure, never auto-replies
- [ ] New env vars added to `.env.example` with empty values + comments
- [ ] Tested: `node -e "require('./backend/lib/agent').TOOLS.map(t=>t.name)"` shows your tools; `/api/health` shows your connector status
- [ ] No real sends/charges/messages fired during testing
