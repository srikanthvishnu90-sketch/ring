# Muse Reference Architecture
## Saved 2026-10-03 — Use to formulate Ring

This document captures how Muse is built and designed, from firsthand knowledge.
Use alongside the 3000-scenario deep analysis to bring Ring to parity.

---

## Core Architecture

- Each user gets their own **dedicated VM** (Linux computer) that persists between conversations. Not stateless — files, memory, browser sessions all survive.
- Powered by **Muse Spark**, from Meta's Muse model family.
- Runs as an **agent loop**: read user message → search memory → pick tools → execute → respond. Every turn.

## Connectors

- Every integration is a **skill** — a `SKILL.md` file defining *exactly* what commands exist. Nothing more. If it's not in the skill doc, it doesn't exist.
- Skills live in `/opt/hatch/skills/` (built-in) and `~/workspace/skills/` (custom). Each has its own CLI or API wrapper.
- Connection state is **verified live every time** via status checks — never trusted from memory.
- OAuth tokens stored server-side. Scopes are granular — users can allow reads but deny sends, per connector.
- **Rate limits** are real and enforced per connector. Hit a 429 and that connector stops for the attempt.
- Multiple accounts supported per connector (e.g., two Gmails).

## Tools & Capabilities

- **Namespaced tools**: `muse.*` (files, exec, memory), `browser.*` (search, open, spawn_task), `subagent.*` (delegate), `cron.*` (scheduled), etc.
- **Subagents**: Can spawn child agents that inherit context, work in background, report back.
- **Browser**: Real Chromium with persistent profile. Logged-in flows, forms, multi-step interactions.
- **Memory**: `MEMORY.md` + `memory/` tree (people, groups, dated logs). Searched at the start of every substantive turn.

## Chat Interface Design

- Clean message list, user messages right-aligned, assistant responses left-aligned.
- No bubbles with heavy borders — minimal, text-focused.
- Input box at bottom, simple rounded rectangle with placeholder text.
- Send button appears when there's text.
- No clutter: no suggested prompts, no onboarding cards in the way.

## Connector UX

- Live in Settings → Connectors. Each shows: name, icon, connected/not state, connect button.
- Tapping connect opens the provider's OAuth flow. User approves; token stored server-side.
- No fake "connected" states — status verified live via API check every time.
- Multiple accounts supported per connector.

## Response Style

- Short. One to three sentences for simple things.
- No preamble like "Great question!" or "I'd be happy to help!"
- Direct answer first, details if needed.
- Formatting only when it helps: bullets for lists, bold sparingly.
- Never expose internals — no `[error_code]`, no stack traces in chat.

## Simplicity Principle

- The interface gets out of the way. No feature carousels, no tips, no upsells in chat.
- Settings behind one tap, not scattered.
- The agent does complex work invisibly — user just sees the result.

## Subscription Search Process (Step-by-Step)

1. List all connected Google accounts (not just one).
2. For each account, search Gmail: `subject:(receipt OR subscription OR "you were charged" OR "payment confirmed" OR "billing") newer_than:90d`
3. Extract merchant from sender name.
4. Deduplicate by merchant (one entry per service).
5. Present as clean list with merchant, subject, date, and which email it came from.

## Engineering Principle

**The agent is the product**, not the UI. The chat interface is thin; the intelligence is in the loop — memory search, tool selection, error recovery, and knowing when to ask vs act.

---

## How to Use This Document

When the 3000-scenario analysis arrives:
1. Cross-reference each gap against this architecture doc.
2. For design gaps: apply the Chat Interface Design and Simplicity Principle sections.
3. For connector gaps: apply the Connectors and Connector UX sections.
4. For response gaps: apply the Response Style section.
5. For capability gaps: check if the architecture supports it; if not, build it.

The goal is not to copy Muse's code — it's to match Muse's *behavioral* quality through Ring's own architecture.
