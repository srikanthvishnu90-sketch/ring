# Ring UI/UX Audit — 2026-10-03
## Live audit of https://ringsss.vercel.app (demo@ring.app)

### Critical Issues (vs Muse Standard)

1. **Prototype labels exposed**: Footer says "Prototype · data shown is sample data." Muse never labels itself as prototype in UI.

2. **Backend internals exposed**: Connectors screen shows debug card "Backend · agent live (openai) — Email: live · Calendar: live · Rides: live · Reservations: live". Muse never exposes model names or backend status.

3. **Fake connected states**: Google shows "Connected" with green dot but tapping does nothing — no email shown, no disconnect option, no manage page. Muse verifies live and shows the actual account.

4. **Placeholder text in production UI**: Venue buttons render "[Venue name] Ramen · veggie broth · short wait". Muse never ships placeholders.

5. **UUIDs in user-facing UI**: Group titles show "Bench demo-booking-001 36c81014-c968-4de4-b301-5992fcb392c4". Muse uses human-readable names.

6. **Two confused Google concepts**: "Google account" (OAuth) vs "Google browser login" are not distinguished. The browser-login "Log in" button unexpectedly navigates to CHAT and sends a message. Muse has one clear Google connector.

7. **No multi-account UI**: Backend supports multiple Google accounts, but UI shows only single "Connected" state with no add-account flow. Onboarding says "Add more anytime in Agent" but no such UI exists.

8. **Unclear badges**: CHAT tab shows "2" badge with no explanation. AGENT tab "1" = pending approvals (clear). Muse badges are self-explanatory.

9. **Hidden activity feed**: "Handled for you" feed is behind the HOME bottom sheet — easy to miss. Key completed actions are buried.

10. **Dead UI elements**: Chat "+" (attach photo) does nothing visible. Muse either works or isn't shown.

11. **Duplicate empty chats**: Chat list has many duplicate empty-title conversations. Muse dedupes.

12. **No login wall**: App opens directly authenticated. "Sign out" exists but flow untested.

### Design Language (Current)
- Dark theme: near-black backgrounds, white primary text, gray secondary
- Serif display headings, sans-serif body
- Mint/sage green accents (progress ring, toggles, "Connected" dots)
- Orange badge on AGENT tab
- Dark gray rounded cards, pill buttons

### Screens Audited
- HOME: Greeting, ring photo with progress arc (82%), stat cards, voice sheet, hidden activity feed
- CHAT: Message bubbles (user: light blue-gray right; agent: dark gray left with "Agent" label + Copy button), quick-reply pills, "Stop generating" indicator (no typing dots)
- PROFILE: Demo/demo@ring.app, Plus plan pill, Your ring (82%, Find it), toggles, Memories (47 things), Listening/privacy, Appearance, Plan/billing, Connectors, Privacy/data, Sign out
- CONNECTORS: Google account (connected, not tappable), Google browser login (Log in → chat), More (Messages, Location, Reminders, Contacts, Music, Uber/Lyft, OpenTable/Resy, Notes)
- GROUPS: Group list with UUID titles, invite codes, agent messages with approval cards
- AGENT: Workflows (5, 3 on), pending approvals sheet, Connectors section

### Priority Fixes for Muse Parity
1. Remove all "prototype" labels and debug cards
2. Make Google connector tappable → show email, disconnect, add account
3. Unify the two Google concepts into one clear flow
4. Replace all placeholders and UUIDs with real/human-readable content
5. Fix badge meanings or remove unclear ones
6. Surface the activity feed (don't hide behind sheet)
7. Remove or fix dead "+" button
8. Dedupe chat list
