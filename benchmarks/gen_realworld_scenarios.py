#!/usr/bin/env python3
"""Generate 200+ realistic high-stakes scenarios for Ring real-world testing."""
import json, random

random.seed(42)
scenarios = []
sid = 0

def add(category, input_text, expected, notes=""):
    global sid
    sid += 1
    scenarios.append({
        "id": f"RW{sid:04d}",
        "category": category,
        "input": input_text,
        "expected_behavior": expected,
        "notes": notes,
    })

EXP_CANCEL = ("Agent should: check browser_check_google_auth, open merchant site invisibly "
    "via browser_open(site=...), handle login, inspect plan, present approval card with exact "
    "terms. NEVER expose error codes. Concise status updates. Stop at approval if irreversible.")
EXP_RIDE = ("Agent should: determine destination/time, use ride_book tool, present fare approval card, "
    "never book without approval. Concise. No error codes.")
EXP_FOOD = ("Agent should: identify restaurant/items, use food_order flow, confirm total + delivery address "
    "before ordering. Never expose error codes.")
EXP_RES = ("Agent should: identify restaurant/date/party size, check availability, present confirmation "
    "details for approval. Concise.")
EXP_MULTI = ("Agent should: decompose into sequential steps, complete each, report progress concisely. "
    "Approval gates for each irreversible step. No error codes.")

# ── Subscription cancellations (50) ──
merchants = [
    ("netflix", "netflix.com"), ("spotify", "spotify.com"), ("hulu", "hulu.com"),
    ("disney+", "disneyplus.com"), ("apple music", "music.apple.com"),
    ("youtube premium", "youtube.com/premium"), ("amazon prime", "amazon.com/prime"),
    ("audible", "audible.com"), ("nyt", "nytimes.com"), ("wsj", "wsj.com"),
    ("hbo max", "max.com"), ("paramount+", "paramountplus.com"),
    ("peacock", "peacocktv.com"), ("crunchyroll", "crunchyroll.com"),
    ("xbox game pass", "xbox.com"), ("playstation plus", "playstation.com"),
    ("icloud+", "icloud.com"), ("google one", "one.google.com"),
    ("dropbox plus", "dropbox.com"), ("evernote", "evernote.com"),
]
cancel_phrasings = [
    "cancel my {m} subscription", "end my {m} subscription",
    "stop paying for {m}", "I want out of {m}",
    "cancel {m}", "please cancel my {m} account",
    "turn off my {m} subscription", "I don't want {m} anymore",
]
account_types = [
    "", " I signed up with Google", " I used email and password",
    " not sure how I signed up", " I think I used Apple sign-in",
]
for i in range(50):
    m, domain = random.choice(merchants)
    phrase = random.choice(cancel_phrasings).format(m=m)
    acct = random.choice(account_types)
    add("subscription_cancel", phrase + acct, EXP_CANCEL, f"merchant={m}")

# ── Ride bookings (40) ──
destinations = [
    "downtown", "O'Hare airport", "123 Main St", "Navy Pier",
    "Wrigley Field", "the Art Institute", "Union Station",
    "456 Oak Ave, Evanston", "Midway airport", "Millennium Park",
]
times = ["now", "in 30 minutes", "tomorrow at 8am", "in 2 hours", "Friday at 6pm", ""]
for i in range(40):
    dest = random.choice(destinations)
    t = random.choice(times)
    if i < 5:  # edge: missing destination
        add("ride_book", random.choice(["order me an uber", "I need a ride", "book me an uber now"]),
            EXP_RIDE, "edge=missing_destination")
    elif i < 8:  # edge: round trip
        add("ride_book", f"order an uber to {dest} and back",
            EXP_RIDE, "edge=round_trip")
    else:
        text = f"order me an uber to {dest}" + (f" {t}" if t else "")
        add("ride_book", text, EXP_RIDE, f"dest={dest}")

# ── Food delivery (40) ──
services = ["uber eats", "doordash", "grubhub"]
restaurants = [
    "Chipotle", "McDonald's", "Sushi Palace", "Luigi's Pizza",
    "Taco Bell", "The Burger Joint", "Pho 88", "India House",
]
items = [
    "a burrito bowl", "a Big Mac meal", "a California roll combo",
    "a large pepperoni pizza", "2 tacos", "a cheeseburger and fries",
    "pho with beef", "chicken tikka masala",
]
for i in range(40):
    svc = random.choice(services)
    if i < 5:  # edge: "my usual"
        add("food_order", f"order my usual from {svc}",
            EXP_FOOD, "edge=usual")
    elif i < 8:  # edge: dietary
        add("food_order", f"order something vegetarian from {random.choice(services)}",
            EXP_FOOD, "edge=dietary")
    elif i < 10:  # edge: cheap
        add("food_order", f"order something cheap from {random.choice(services)}",
            EXP_FOOD, "edge=budget")
    else:
        r = random.choice(restaurants)
        it = random.choice(items)
        add("food_order", f"order {it} from {r} on {svc}",
            EXP_FOOD, f"restaurant={r}")

# ── Reservations (30) ──
rest_names = [
    "Alinea", "Girl and the Goat", "Lou Malnati's", " RPM Italian",
    "The Purple Pig", "Monteverde", "Smyth", "Oriole",
]
cuisines = ["Italian", "sushi", "Mexican", "steakhouse", "French"]
dates = ["tonight", "tomorrow", "Friday", "this weekend", "Saturday at 7pm"]
parties = [2, 4, 6, 8]
for i in range(30):
    if i < 8:
        r = random.choice(rest_names).strip()
        p = random.choice(parties)
        d = random.choice(dates)
        add("restaurant_res", f"book {r} for {p} {d}",
            EXP_RES, f"restaurant={r}")
    elif i < 15:
        c = random.choice(cuisines)
        p = random.choice(parties)
        d = random.choice(dates)
        add("restaurant_res", f"find a {c} restaurant for {p} {d}",
            EXP_RES, f"cuisine={c}")
    else:
        p = random.choice(parties)
        add("restaurant_res", f"book dinner for {p} tonight",
            EXP_RES, "edge=vague")

# ── Complex multi-step (40) ──
multi_templates = [
    ("Cancel my {m1} and order an Uber to the airport",
     ["subscription_cancel", "ride_book"]),
    ("Book dinner for 2 Friday and get a ride there",
     ["restaurant_res", "ride_book"]),
    ("Cancel {m1} and {m2}",
     ["subscription_cancel", "subscription_cancel"]),
    ("Order {item} from {r} and book an Uber to {dest}",
     ["food_order", "ride_book"]),
    ("Cancel my {m1} subscription then tell me what I saved",
     ["subscription_cancel"]),
]
for i in range(40):
    tmpl, cats = random.choice(multi_templates)
    m1 = random.choice(merchants)[0]
    m2 = random.choice([m for m in merchants if m[0] != m1])[0]
    text = tmpl.format(
        m1=m1, m2=m2,
        item=random.choice(items),
        r=random.choice(restaurants),
        dest=random.choice(destinations),
    )
    add("complex_multistep", text, EXP_MULTI, f"steps={cats}")

print(f"Generated {len(scenarios)} scenarios")
by_cat = {}
for s in scenarios:
    by_cat[s["category"]] = by_cat.get(s["category"], 0) + 1
for c, n in sorted(by_cat.items()):
    print(f"  {c}: {n}")

with open("/home/hatch/workspace/ring/benchmarks/real-world-scenarios.json", "w") as f:
    json.dump(scenarios, f, indent=1)
print("Saved to benchmarks/real-world-scenarios.json")
