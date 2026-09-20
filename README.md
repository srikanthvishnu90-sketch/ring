# Ring — app prototype

Interactive single-file prototype of the Ring companion app. No build step:
`index.html` is the whole app (markup + CSS + JS).

## What's in the prototype

- **Splash → Auth → Onboarding** — animated mark, email/social signup with
  6-digit verify, 3-step ring setup (find ring, double-tap, connect essentials)
- **Home** — ring hero with animated charge gauge, status tiles, next-up card,
  "Handled for you" feed
- **Chat** — agent conversation with canned flows, place cards, and approval
  cards (approve / edit before the agent books or sends)
- **Agent** — workflows (create from plain English, toggle, run, per-workflow
  connector requirements) + connectors grid
- **Profile** — plan, agent memory, listening & privacy, safety
  ("ask before acting")

## Run it

Open `index.html` in a browser, or serve it:

```sh
python3 -m http.server 8080
```

On desktop widths (≥600px) it renders inside a phone frame; on a phone it is
full-bleed. State persists in `localStorage` under `ringapp.*` keys.

## Backend & API keys

`backend/` is an Express server that turns the prototype real: it serves the
app, runs the agent loop (`POST /api/chat`), and reports which capabilities
are live (`GET /api/health`).

```sh
cp .env.example .env   # fill in keys — see docs/keys-and-access.md
cd backend && npm install && npm start
# → http://localhost:3000, API at /api/health
```

- `.env.example` — the full key inventory (LLM, Google OAuth, Places,
  Uber/OpenTable/Resy, Supabase, APNs/FCM). Never commit `.env`.
- `docs/keys-and-access.md` — every platform: what it unlocks, how to get
  access, what it costs, and what's self-serve vs partnership track.
- `docs/architecture.md` — request flow, connector contract, approval gates,
  and how the prototype maps to the backend.
- `backend/connectors/` — gmail, calendar, uber, dining. Each declares its
  required env vars and fails loudly when keys are missing.

With no keys set everything still runs: connectors report `missing`, the
agent falls back to canned responses, and deep links carry the demo.

## Deploy (phone preview)

The repo is Vercel-ready (`vercel.json` + `api/index.js` serverless entry):

1. In the [Vercel dashboard](https://vercel.com/new), import
   `srikanthvishnu90-sketch/ring` — auto-deploys from `main`.
2. Add env vars from `.env.example` as needed (works with none set).
3. Open the deployment URL on your phone — the app detects the backend
   automatically and routes chat through the real agent loop.

## Notes

- All data is sample data. Placeholders like `[Venue name]`, `[Friend]`,
  `[Name]` are intentional — product and agent naming are still open.
- The live-agent hook (`window.claude.use('sample')`) only resolves inside
  Claude-hosted previews; everywhere else the chat falls back to canned
  responses.
- Design system: dark editorial (Newsreader + Hanken Grotesk), tuned against
  Oura / Whoop / Apple Fitness / Nothing conventions — hairline borders with
  hierarchy carried by surfaces, tabular hero numbers, uppercase tracked
  micro-labels, glow-over-shadow, sage reserved for good/done states, amber
  for needs-attention, staggered entrances.

## Roadmap (from the product brief)

- Real agent backend (LLM + tool-calling) replacing canned flows
- Backend (auth, chat threads, group chats with `@agent` invocation, memory store)
- Connectors: Gmail/Calendar first, then rides (Uber/Lyft deep links),
  dining (OpenTable/Resy)
- BLE ring relay in the mobile app; hold-to-talk stands in for the ring for now
