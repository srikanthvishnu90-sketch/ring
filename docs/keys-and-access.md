# Keys, access & platforms

The complete inventory of everything Ring needs to reach full functionality.
`.env.example` is the machine-readable version of this doc — every variable
there maps to a row below. **Never commit real keys** (`.env` is gitignored);
in production they live in the host's secret store (Vercel env vars, etc.).

## The honest picture

Some features have clean self-serve APIs. Three don't — and the plan accounts
for it:

| Feature | Platform | Access reality | Path |
|---|---|---|---|
| Agent brain | OpenAI / Anthropic | Self-serve API key | Get key today |
| Read + send email | Gmail API | Self-serve OAuth 2.0 | Google Cloud project today |
| Calendar | Google Calendar API | Self-serve OAuth 2.0 | Same project as Gmail |
| Restaurant discovery | Google Places API | Self-serve API key | Same project |
| Order Ubers | Uber | **No public ride-request API** (was partner-whitelist) | **Deep links today** (open Uber app with trip prefilled) → partnership track for direct booking |
| Book tables | OpenTable | **Partner-only API** | **Deep links today** → apply at dev.opentable.com/partner-portal |
| Book tables | Resy | **No public API** (partner-only) | **Deep links today** → unofficial web-API path is opt-in only (fragile) |
| Book tables | Tock | No public API | Deep links only |
| Threads, groups, memory | Postgres / Supabase | Self-serve | Supabase project today |
| Push (approvals, mentions) | APNs + FCM | Self-serve developer accounts | Apple Developer + Firebase today |

The connectors in `backend/connectors/` encode exactly this: deep-link
builders that work now, direct-booking methods that fail loudly with
`PARTNERSHIP_REQUIRED` until the business track lands — so the product never
pretends a capability it doesn't have.

## Platform-by-platform

### 1. Agent brain — OpenAI or Anthropic (get today)
- Sign up, create an API key, set `LLM_PROVIDER`, the key, and `AGENT_MODEL`.
- The agent loop (`backend/lib/agent.js`) calls tools and drafts replies
  through this. No key → the backend serves the same canned responses the
  prototype uses now, so development never blocks on it.

### 2. Gmail + Calendar — Google OAuth 2.0 (get today)
- Google Cloud Console → new project → enable **Gmail API** and **Google
  Calendar API** → Credentials → OAuth client ID (web app) → authorized
  redirect URI = `GOOGLE_REDIRECT_URI`.
- OAuth consent screen: add scopes `gmail.readonly`, `gmail.send`,
  `calendar.events`. Verification is needed before public launch; in testing,
  add your Gmail as a test user.
- Keys: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Per-user tokens are
  stored server-side (never in the repo).

### 3. Places — Google Places API (get today)
- Same Google Cloud project → enable **Places API (New)** → API key with
  application restrictions → `GOOGLE_PLACES_API_KEY`.
- Powers restaurant search, details, photos, and geocoding for pickups.

### 4. Uber (deep links today, partnership track)
- There is no self-serve endpoint that dispatches a real driver. The connector
  builds universal links (`https://m.uber.com/go/...`) with pickup and
  dropoff prefilled — the user confirms in the Uber app, which is also the
  correct approval UX for a paid ride.
- Business track: Uber for Business / strategic partnership for direct
  booking. `UBER_CLIENT_ID` / `UBER_CLIENT_SECRET` / `UBER_SERVER_TOKEN`
  are reserved for that.

### 5. OpenTable (deep links today, partner application)
- The booking API is restricted to approved partners — apply at
  https://dev.opentable.com/partner-portal (business justification required).
- Until approved, the connector builds search/booking deep links
  (`opentable.com/r/<slug>?dateTime=…&covers=…`) with the slot prefilled.
- `OPENTABLE_PARTNER_ID` / `OPENTABLE_API_KEY` activate the direct path when
  the partnership is signed.

### 6. Resy (deep links today, unofficial path opt-in)
- No public API; partner integrations only. The community has
  reverse-engineered the `api.resy.com` endpoints the web app uses
  (find → details → book), but they are undocumented and can break without
  notice — so this stays behind an explicit flag, never the default.
- Default: deep links (`resy.com/cities/<city>/<slug>?date=…&seats=…`).
- If you opt in: set `RESY_API_KEY` (the web client's public key) and mint a
  per-user `RESY_AUTH_TOKEN` from a Resy login.

### 7. Data, auth & realtime — Supabase (get today)
- One Supabase project gives Postgres (threads, group chats, approvals,
  memory), Auth (magic link / OAuth), Realtime (group chat sockets), and
  Storage. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`
  (service key stays server-side only).
- Or bring your own Postgres via `DATABASE_URL`.

### 8. Push — APNs + FCM (get today)
- Approval requests ("Approve $24 Uber?") and group-chat `@mentions` need
  push. iOS: Apple Developer key (`.p8`) → `APNS_*`. Android/web: Firebase
  Cloud Messaging → `FCM_SERVER_KEY`.

## Suggested order

1. `LLM_PROVIDER` key — the agent works end-to-end in the terminal.
2. Google OAuth + Places — email, calendar, and restaurant search light up.
3. Supabase — threads, group chats, and memory persist.
4. APNs/FCM — approvals reach the phone.
5. Partnership track (Uber, OpenTable, Resy) — direct booking without
   app-switching; deep links cover the demo until then.

## Adding a new platform later

1. Add its variables to `.env.example` (with a comment: where to get them).
2. Add a row to the table above.
3. Add `backend/connectors/<name>.js` exporting `{ requiredEnv, status() }`
   plus its methods — it shows up in `/api/health` automatically.
