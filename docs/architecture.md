# Architecture

How the pieces fit once real keys are in. The prototype (`index.html`) is
the UI contract — this backend is what makes it real without a rewrite.

```
┌─────────────┐      ┌──────────────────────┐      ┌─────────────────┐
│  index.html │◄────►│  backend/server.js   │◄────►│   LLM provider  │
│  (chat UI,  │ HTTP │  · serves the app    │      │  (OpenAI /      │
│  approvals, │+ WS  │  · /api/chat         │      │   Anthropic)    │
│  onboarding)│      │  · /api/health       │      └─────────────────┘
└─────────────┘      │  · OAuth callbacks   │      ┌─────────────────┐
                     │  · WebSocket (groups)│◄────►│   Supabase      │
┌─────────────┐      └──────────┬───────────┘      │  (DB, auth,     │
│  Ring (BLE) │                │                  │   realtime)     │
│  → phone    │      ┌─────────▼───────────┐      └─────────────────┘
│  → /api/    │      │  backend/lib/agent.js │
│    voice    │      │  · tool registry      │      ┌─────────────────┐
└─────────────┘      │  · approval gates    │◄────►│  Connectors     │
                     └─────────────────────┘      │  gmail, calendar│
                                                  │  uber, dining   │
                                                  └─────────────────┘
```

## Request flow

1. User speaks (ring → phone mic → `/api/voice`) or types (`/api/chat`).
2. `agent.js` builds context (memory from Supabase, thread history) and calls
   the LLM with the tool registry.
3. The model may call tools: `gmail.search`, `gmail.send`, `calendar.create`,
   `places.search`, `uber.rideLink` / `uber.requestRide`, `dining.findSlots`,
   `dining.bookTable`, `group.invite`, `group.mention`.
4. **Approval gates** (the product's core trust mechanic): low-risk tools run
   immediately; medium-risk need a tap/voice confirm; high-risk (anything that
   spends money or sends as the user) create a pending approval — pushed to
   the phone, resolved in the app. Nothing irreversible happens silently.
5. Group chats: threads in Supabase, realtime over WebSocket; mentioning the
   agent (`@name`) routes the message through the same agent loop with the
   group as context, and booking options go through the normal approval card.

## Connector contract

Every connector in `backend/connectors/` exports:

- `requiredEnv: string[]` — env vars it needs (from `.env.example`)
- `status()` — `{ ok, missing[] }`, surfaced at `/api/health`
- its methods, which throw `notConfigured()` when keys are missing and
  `partnershipRequired()` when the platform has no self-serve API

This is what keeps "peak functionality" honest: the app can probe exactly
which capabilities are live and degrade gracefully (deep link instead of
direct booking) rather than failing mysteriously.

## What the prototype maps to

| Prototype (index.html) | Backend |
|---|---|
| Canned chat replies | `POST /api/chat` → agent loop (OpenAI or Anthropic) |
| Approval cards | `lib/approvals.js` — medium/high-risk calls HELD, executed only on `POST /api/approvals/:id/resolve` |
| Groups tab | `lib/threads.js` — group threads, `@ring` mention routing, SSE live stream |
| Workflows | Agent schedules / cron tools |
| Connectors screen | `/api/health` connector status |
| Onboarding "connect essentials" | OAuth callbacks under `/auth/*` (Google live; tokens server-side in `lib/google.js` with refresh) |
| Hold-to-talk | `POST /api/voice` (audio in, text out) |

## Tool registry (what the agent can actually call)

Low risk (runs immediately): `gmail_search`, `calendar_list`, `places_search`, `uber_ride_link`, `dining_links`.
Medium risk (tap/voice confirm): `calendar_create`.
High risk (in-app approval card): `gmail_send`.
Partnership-gated (no self-serve API): direct Uber dispatch, direct OpenTable booking, Resy direct booking (opt-in unofficial `resyFindSlots`/`resyBookUnofficial` via `RESY_API_KEY` + `RESY_AUTH_TOKEN`).

## Run it

```sh
cp .env.example .env   # fill in keys (see docs/keys-and-access.md)
cd backend && npm install && npm start
# → http://localhost:3000 serves the app with the API live
```

With no keys set, everything still runs — connectors report `missing`, the
agent falls back to canned responses, and deep links carry the demo.
