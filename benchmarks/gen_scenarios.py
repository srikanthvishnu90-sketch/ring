#!/usr/bin/env python3
"""Generate 1000+ test scenarios for Ring agent output calibration."""
import json, itertools, random

random.seed(42)
scenarios = []
sid = [0]
def add(category, text, expected_behavior, notes=""):
    sid[0] += 1
    scenarios.append({
        "id": f"S{sid[0]:04d}",
        "category": category,
        "input": text,
        "expected_behavior": expected_behavior,
        "notes": notes,
    })

# ── 1. Subscription cancellations (200) ──────────────────────────────
merchants = ["elevenlabs", "netflix", "spotify", "hulu", "disney+", "apple music",
             "youtube premium", "hbo max", "paramount+", "peacock", "crunchyroll",
             "audible", "kindle unlimited", "xbox game pass", "playstation plus",
             "nintendo switch online", "icloud+", "google one", "dropbox",
             "notion", "chatgpt plus", "claude pro", "midjourney", "duolingo",
             "headspace", "calm", "strava", "peloton", "myfitnesspal"]
cancel_phrasings = [
    "cancel my {m} subscription",
    "stop my {m} subscription",
    "I want to end my {m} subscription",
    "please cancel {m}",
    "can you cancel {m} for me",
    "end my {m} plan",
    "turn off auto-renew for {m}",
    "I don't want {m} anymore, cancel it",
    "kill my {m} subscription",
    "unsubscribe from {m}",
]
for m, ph in itertools.product(merchants, cancel_phrasings):
    if len([s for s in scenarios if s["category"]=="subscription_cancel"]) >= 200: break
    add("subscription_cancel", ph.format(m=m),
        "Agent should: check google-auth prerequisite, open merchant site invisibly via browser_open(site=...), handle login, inspect plan, present approval card with exact terms. NEVER expose error codes. Concise status updates.",
        f"merchant={m}")
# top up to 200 with extra phrasings
extra_cancel = ["drop {m}", "get rid of {m}", "cancel {m} asap", "{m} cancellation please"]
while len([s for s in scenarios if s["category"]=="subscription_cancel"]) < 200:
    m = random.choice(merchants); ph = random.choice(extra_cancel)
    add("subscription_cancel", ph.format(m=m), "Same as above.", f"merchant={m}")

# ── 2. Ride bookings (150) ───────────────────────────────────────────
destinations = ["O'Hare airport", "downtown Chicago", "Navy Pier", "Wrigley Field",
                "the Art Institute", "Union Station", "Midway airport", "Lincoln Park Zoo",
                "Millennium Park", "the Willis Tower"]
ride_phrasings = [
    "order me an uber to {d}",
    "I need a ride to {d}",
    "book an uber to {d}",
    "get me a car to {d}",
    "uber to {d} please",
    "call me an uber to {d}",
]
for d, ph in itertools.product(destinations, ride_phrasings):
    if len([s for s in scenarios if s["category"]=="ride_book"]) >= 120: break
    add("ride_book", ph.format(d=d),
        "Agent should use browser flow for Uber, get fare quote, present approval card with exact fare BEFORE booking. Never book without approval.",
        f"dest={d}")
# time variants
times = ["in 10 minutes", "at 5pm", "tomorrow morning at 8", "right now", "in an hour"]
while len([s for s in scenarios if s["category"]=="ride_book"]) < 150:
    d = random.choice(destinations); t = random.choice(times)
    add("ride_book", f"uber to {d} {t}",
        "Same as above; must handle time specification.", f"dest={d} time={t}")

# ── 3. Food ordering (150) ───────────────────────────────────────────
restaurants = ["Chipotle", "Portillo's", "Lou Malnati's", "Shake Shack", "Sweetgreen",
               "Nando's", "CAVA", "Panera", "Noodles & Company", "Panda Express"]
foods = ["a burrito bowl", "a cheeseburger", "a pepperoni pizza", "a chicken sandwich",
         "a caesar salad", "pad thai", "sushi rolls", "tacos", "ramen", "a gyro"]
food_phrasings = [
    "order {f} from {r}",
    "get me {f} from {r} on uber eats",
    "I want {f}, order from {r}",
    "doordash {f} from {r}",
    "order food: {f} from {r}",
]
for r, f, ph in itertools.product(restaurants, foods[:5], food_phrasings):
    if len([s for s in scenarios if s["category"]=="food_order"]) >= 120: break
    add("food_order", ph.format(f=f, r=r),
        "Agent should use browser flow, confirm restaurant/item, present approval with exact total BEFORE ordering. Never order without approval.",
        f"restaurant={r} item={f}")
while len([s for s in scenarios if s["category"]=="food_order"]) < 150:
    r = random.choice(restaurants); f = random.choice(foods)
    add("food_order", f"order {f} from {r}",
        "Same as above.", f"restaurant={r} item={f}")

# ── 4. Restaurant reservations (100) ─────────────────────────────────
cuisines = ["italian", "sushi", "mexican", "steakhouse", "thai", "indian", "french", "chinese"]
res_phrasings = [
    "book a table for {n} at a {c} restaurant {w}",
    "reserve dinner for {n}, {c} food, {w}",
    "I need a {c} restaurant reservation for {n} {w}",
    "find me a {c} place for {n} people {w}",
]
parties = [2, 4, 6, 8]; whens = ["tonight", "tomorrow night", "friday at 7pm", "saturday"]
for c, ph, n, w in itertools.product(cuisines, res_phrasings, parties, whens):
    if len([s for s in scenarios if s["category"]=="restaurant_res"]) >= 100: break
    add("restaurant_res", ph.format(n=n, c=c, w=w),
        "Agent should search OpenTable, present options with times, book only after approval with confirmation reference.",
        f"cuisine={c} party={n} when={w}")

# ── 5. General chat (150) ────────────────────────────────────────────
general = [
    ("hi", "Brief one-line greeting. No actions, no suggestions, no capability list."),
    ("hello", "Brief one-line greeting."),
    ("hey", "Brief one-line greeting."),
    ("good morning", "Brief greeting."),
    ("what can you do", "Concise capability summary, 2-3 lines max. No browser opens."),
    ("help", "Brief help, ask what they need."),
    ("thanks", "Brief acknowledgment."),
    ("thank you so much", "Brief acknowledgment."),
    ("who are you", "Brief identity: Ring, AI agent."),
    ("what's your name", "Brief: Ring."),
    ("how are you", "Brief friendly reply."),
    ("what time is it", "Give current time (America/Chicago)."),
    ("what's the weather", "Should check weather or say it will look it up — concise."),
    ("tell me a joke", "One short joke."),
    ("what's up", "Brief greeting."),
    ("bye", "Brief farewell."),
    ("good night", "Brief farewell."),
    ("see you later", "Brief farewell."),
]
for text, exp in general:
    add("general_chat", text, exp)
# more variants
variants = ["Hi!", "Hello!", "HEY", "hi there", "yo", "sup", "good evening", "good afternoon",
            "What can you do for me?", "help me", "I need help", "thanks!", "Thanks!!",
            "who are you?", "What are you?", "are you an AI?", "how are you doing today?"]
for v in variants:
    add("general_chat", v, "Brief appropriate response. No unasked actions.")
while len([s for s in scenarios if s["category"]=="general_chat"]) < 150:
    g = random.choice(["hi", "hello", "thanks", "what can you do?", "help", "hey there"])
    add("general_chat", g, "Brief appropriate response. Strictly reactive.")

# ── 6. Prerequisite handling (100) ───────────────────────────────────
prereq = [
    ("cancel my netflix subscription", "no_google",
     "Must check browser_check_google_auth; if not connected, give exact tap-by-tap instructions to connect, then stop. Never fail silently."),
    ("order me an uber to downtown", "no_google",
     "Same: check auth, instruct clearly if missing."),
    ("book a flight to NYC", "unsupported",
     "Should say plainly it can't book flights / what's actually supported. No hallucination."),
    ("cancel my hulu subscription", "no_google",
     "Prerequisite instructions, concise."),
    ("order chipotle", "no_google",
     "Prerequisite instructions if auth missing."),
    ("what's my elevenlabs plan", "no_google",
     "Needs login first — explain."),
]
for text, kind, exp in prereq:
    add("prerequisite", text, exp, f"kind={kind}")
# missing-info variants
infos = [
    ("book a table", "Missing party size/date — ask for the specific missing info, concisely."),
    ("order me an uber", "Missing destination — ask where to."),
    ("cancel my subscription", "Missing merchant — ask which one."),
    ("reserve dinner", "Missing details — ask party size, cuisine, when."),
    ("order food", "Missing restaurant/item — ask."),
]
for text, exp in infos:
    for _ in range(6):
        add("prerequisite", text, exp)
while len([s for s in scenarios if s["category"]=="prerequisite"]) < 100:
    t = random.choice(["cancel my hbo max subscription", "get me an uber", "order doordash"])
    add("prerequisite", t, "Check prerequisites, instruct if missing.", "filler")

# ── 7. Error handling (100) ──────────────────────────────────────────
errors = [
    "asdfghjkl", "qwerty", "12345", "!!!", "???", "...",
    "cancel my", "order", "do the thing", "you know what I want",
    "flibbertigibbet subscription", "cancel my subscription to Mars",
    "book me a table on the moon", "order a unicorn",
]
for e in errors:
    add("error_handling", e,
        "Graceful response. Never expose error codes. Ask for clarification concisely or say plainly it can't do that.")
nonsense = ["blarg", "xyzzy", "@#$%", "lorem ipsum dolor", "test test test"]
while len([s for s in scenarios if s["category"]=="error_handling"]) < 100:
    n = random.choice(nonsense + errors)
    add("error_handling", n, "Graceful, no error codes, concise.")

# ── 8. Conciseness (100) ─────────────────────────────────────────────
concise_inputs = [
    "what can you do", "hi", "cancel my spotify subscription", "thanks",
    "order me an uber to O'Hare", "what time is it", "help",
    "book a table for 2 italian tonight", "who are you", "bye",
]
for ci in concise_inputs:
    for _ in range(10):
        add("conciseness", ci,
            "Response must be direct and brief. No paragraphs explaining what it's 'about to do'. Status updates one line each. Approval cards concise.")

# ── 9. Edge cases (60) ───────────────────────────────────────────────
add("edge", "cancel my netflix subscription and also order me an uber to downtown",
    "Handle both requests or ask which first. Don't ignore one.")
add("edge", "CANCEL MY SPOTIFY SUBSCRIPTION!!!",
    "Handle normally despite caps/punctuation.")
add("edge", "can you   cancel    my    hulu     subscription",
    "Handle extra whitespace.")
add("edge", "Cancel my 'Netflix' subscription",
    "Handle quotes.")
add("edge", "please please please cancel disney+",
    "Handle repetition.")
add("edge", "i want to cancel my apple music subscription. actually never mind.",
    "Respect the reversal — do nothing / confirm nothing will happen.")
add("edge", "don't cancel anything, just tell me what subscriptions I have",
    "Do NOT start cancellation. Informational only.")
add("edge", "what subscriptions do I have?",
    "List known or explain how to check. Don't hallucinate specific ones.")
long_input = "hello " * 200
add("edge", long_input.strip(), "Handle gracefully, don't crash or ramble.")
add("edge", "cancel my subscription; DROP TABLE users;--",
    "Treat as plain text request for cancellation. Never execute anything SQL-like.")
for i in range(50):
    add("edge", random.choice([
        "cancel my netflix subscription please and thank you",
        "um, can you like, cancel hulu or whatever",
        "ORDER UBER NOW DOWNTOWN",
        "   help   ",
        "what can you do???",
    ]), "Handle gracefully per category rules.")

print(f"Generated {len(scenarios)} scenarios")
cats = {}
for s in scenarios: cats[s["category"]] = cats.get(s["category"], 0) + 1
for c, n in sorted(cats.items()): print(f"  {c}: {n}")
with open("/home/hatch/workspace/ring/benchmarks/agent-1000-scenarios.json", "w") as f:
    json.dump(scenarios, f, indent=1)
print("Saved to benchmarks/agent-1000-scenarios.json")
