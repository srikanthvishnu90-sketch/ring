#!/usr/bin/env python3
"""Run Ring agent scenarios against live /api/chat, score vs rubric.

Usage: RING_EMAIL=... RING_PASSWORD=... python3 run_tests.py [sample_per_cat] [offset]
Password is read from env only, never logged.
"""
import json, os, re, sys, time, urllib.request, random

BASE = "https://ringsss.vercel.app"
EMAIL = os.environ.get("RING_EMAIL", "demo@ring.app")
PASSWORD = os.environ.get("RING_PASSWORD", "")
if not PASSWORD:
    print("RING_PASSWORD env required", file=sys.stderr); sys.exit(1)

SAMPLE_PER_CAT = int(sys.argv[1]) if len(sys.argv) > 1 else 15
OFFSET = int(sys.argv[2]) if len(sys.argv) > 2 else 0

def api(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json"})
    if token: req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"_http_error": e.code, "_body": e.read().decode()[:500]}

# ── auth ──
print("Authenticating...", flush=True)
auth = api("POST", "/api/auth/password", {"email": EMAIL, "password": PASSWORD})
token = auth.get("access_token")
if not token:
    print(f"AUTH FAILED: {json.dumps(auth)[:200]}"); sys.exit(1)
print("Authenticated OK", flush=True)

# ── load scenarios, stratified sample ──
scenarios = json.load(open("/home/hatch/workspace/ring/benchmarks/real-world-scenarios.json"))
by_cat = {}
for s in scenarios: by_cat.setdefault(s["category"], []).append(s)
sample = []
for cat, lst in sorted(by_cat.items()):
    random.seed(1234)
    idx = random.sample(range(len(lst)), min(SAMPLE_PER_CAT, len(lst)))
    for i in sorted(idx)[OFFSET:]:
        sample.append(lst[i])
print(f"Sample: {len(sample)} scenarios", flush=True)

ERROR_CODE_RE = re.compile(r"\[[a-z_0-9]+\]")
FLUFF_RES = [
    re.compile(r"i'?m about to", re.I), re.compile(r"let me explain", re.I),
    re.compile(r"as an ai", re.I), re.compile(r"here'?s what i'?m going to do", re.I),
]

def score(s, reply_text, tools_used):
    """Heuristic 0-100 vs rubric."""
    breakdown = {}
    text = reply_text or ""
    # Correctness (30): right tool family invoked.
    # Also credit appropriate TEXT handling: clarifying questions, catching
    # mismatches, making reasonable assumptions — these are intelligent.
    cat = s["category"]
    tools = [t.get("name","") for t in (tools_used or [])]
    expected_tools = {
        "subscription_cancel": ["browser_check_google_auth","browser_open","browser_connect_google","unsubscribe_email"],
        "ride_book": ["browser_check_google_auth","browser_open","ride_book"],
        "food_order": ["browser_check_google_auth","browser_open","food_order"],
        "restaurant_res": ["browser_open","web_search","dining_tonight","places_search","calendar_list"],
        "general_chat": [],
        "prerequisite": ["browser_check_google_auth"],
        "error_handling": [],
        "conciseness": [],
        "edge": [],
    }
    exp = expected_tools.get(cat, [])
    hit = any(t in tools for t in exp)
    mentions_prereq = bool(re.search(r"connect.*google|google.*connect|log in", text, re.I))
    asks_clarifying = bool(re.search(r"\?", text)) and len(text.split()) <= 40
    catches_mismatch = bool(re.search(r"doesn'?t (serve|offer|have)|not (available|serve)", text, re.I))
    makes_assumption = bool(re.search(r"assum", text, re.I))
    if not exp:
        breakdown["correctness"] = 30
    elif hit or mentions_prereq or asks_clarifying or catches_mismatch or makes_assumption:
        breakdown["correctness"] = 30
    else:
        breakdown["correctness"] = 8
    # Conciseness (25)
    words = len(text.split())
    fluff = sum(1 for r in FLUFF_RES if r.search(text))
    if cat == "general_chat":
        breakdown["conciseness"] = 25 if words <= 40 else (15 if words <= 80 else 5)
    else:
        breakdown["conciseness"] = 25 if (words <= 120 and fluff == 0) else (12 if words <= 250 else 5)
    # No error codes (20)
    codes = ERROR_CODE_RE.findall(text)
    # allowlist: none — any [code] is a fail
    breakdown["no_error_codes"] = 0 if codes else 20
    # Intelligence (15): graceful on edge/error; not empty
    if not text.strip():
        breakdown["intelligence"] = 0
    elif cat in ("error_handling","edge") and len(text.split()) < 3:
        breakdown["intelligence"] = 5
    else:
        breakdown["intelligence"] = 15
    # Prerequisites (10)
    if cat == "prerequisite":
        has_google_instructions = bool(re.search(r"(tap|click|go to|open|profile|settings|connect).{0,80}(google|login|sign ?in)", text, re.I))
        asks_missing_info = bool(re.search(r"which|where|what|when|who", text, re.I)) and "?" in text
        breakdown["prerequisites"] = 10 if (has_google_instructions or asks_missing_info) else 3
    else:
        breakdown["prerequisites"] = 10
    total = sum(breakdown.values())
    return total, breakdown, codes

results = []
for i, s in enumerate(sample):
    tid = f"bench_{int(time.time())}_{i}"
    try:
        resp = api("POST", "/api/chat", {"text": s["input"][:2000], "threadId": tid}, token)
    except Exception as e:
        resp = {"_exc": str(e)[:200]}
    if resp.get("_http_error") or resp.get("_exc"):
        results.append({"id": s["id"], "category": s["category"], "input": s["input"][:120],
                        "score": 0, "breakdown": {}, "error": str(resp)[:200], "reply": ""})
        print(f"[{i+1}/{len(sample)}] {s['id']} ERROR {str(resp)[:80]}", flush=True)
        continue
    reply_text = resp.get("text", "") or resp.get("reply", "")
    tools_used = resp.get("toolsUsed", []) or resp.get("tools", [])
    total, bd, codes = score(s, reply_text, tools_used)
    results.append({"id": s["id"], "category": s["category"], "input": s["input"][:120],
                    "score": total, "breakdown": bd, "codes": codes,
                    "reply": reply_text[:600], "tools": [t.get("name") for t in tools_used][:6]})
    print(f"[{i+1}/{len(sample)}] {s['id']} {s['category']} score={total} " +
          (f"CODES={codes} " if codes else "") + f"tools={[t.get('name') for t in tools_used][:4]}", flush=True)
    time.sleep(1.5)  # be gentle on the API

out = "/home/hatch/workspace/ring/benchmarks/real-world-test-results.json"
json.dump({"results": results,
           "summary": {c: {"n": len([r for r in results if r["category"]==c]),
                           "avg": round(sum(r["score"] for r in results if r["category"]==c)/max(1,len([r for r in results if r["category"]==c])),1)}
                       for c in by_cat}},
          open(out, "w"), indent=1)
avgs = {}
for r in results: avgs.setdefault(r["category"], []).append(r["score"])
print("\n=== CATEGORY AVERAGES ===")
for c in sorted(avgs): print(f"  {c}: {sum(avgs[c])/len(avgs[c]):.1f} (n={len(avgs[c])})")
overall = sum(r["score"] for r in results)/max(1,len(results))
print(f"OVERALL: {overall:.1f}/100 (n={len(results)})")
print(f"Saved to {out}")
