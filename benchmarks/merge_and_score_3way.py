#!/usr/bin/env python3
"""Merge 966 real Ring responses + score Ring vs Muse for the 1000-action 3-way.

Outputs per-batch files: 3way-batch-N.json (N=1..10, 100 actions each)
Also updates 1000-actions-scores.json with ring_response/ring_scores/ring_total.

Scoring rubric (0-25 each, calibrated on 12 manual samples + 165 live samples):
- Conciseness: word-count ratio vs Muse. 1.0-1.5x=25, 1.5-2x=20, 2-3x=14, 3x+=8, empty=0
- Intelligence: tool efficiency. <=3 relevant tools=20-25, 4-6 tools=15, 7+=10-12 (over-searching),
  empty response=15 baseline only if tools ran, 0 tools + empty text=review
- Directness: acts or asks clearly=25, hedged=18, empty=0-25 based on tools
- Outcome: would achieve result=25, approval correctly held=25, empty/no-action=0-17
"""
import json, os, re
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))

def load(p):
    with open(os.path.join(HERE, p)) as f:
        return json.load(f)

def wc(t):
    return len(re.findall(r"\S+", t or ""))

def score_ring_vs_muse(muse_resp, ring_resp, ring_tools):
    """Calibrated heuristic scorer. Returns dict of 4 dims + total."""
    mw = wc(muse_resp)
    rw = wc(ring_resp or "")
    nt = len(ring_tools or [])
    empty = rw == 0

    # --- Conciseness ---
    if empty:
        conc = 0
    elif mw == 0:
        conc = 20 if rw <= 40 else 12
    else:
        ratio = rw / max(mw, 1)
        if ratio <= 1.5: conc = 25
        elif ratio <= 2.0: conc = 20
        elif ratio <= 3.0: conc = 14
        else: conc = 8

    # --- Intelligence (tool efficiency + recognition) ---
    # Count redundant gmail_search calls
    gsearch = sum(1 for t in (ring_tools or []) if t == "gmail_search")
    if empty and nt == 0:
        intel = 10
    elif gsearch >= 5:
        intel = 12  # exhaustive over-searching pattern
    elif nt >= 7:
        intel = 12
    elif nt >= 4:
        intel = 15
    elif nt == 0:
        # no tools: either correctly answered directly or failed to act
        intel = 18 if rw > 0 else 10
    else:
        intel = 20

    # --- Directness ---
    if empty:
        direct = 0 if nt == 0 else 15
    else:
        txt = (ring_resp or "").lower()
        if any(p in txt for p in ["i'm not able to", "i cannot", "i can't", "unable to"]):
            # honest capability boundary = still direct
            direct = 25
        elif any(p in txt for p in ["probably", "you may be able", "it's possible that"]):
            direct = 18
        else:
            direct = 25

    # --- Outcome ---
    if empty:
        out = 0
    else:
        txt = (ring_resp or "").lower()
        # approval held correctly
        if "approve" in txt and any(t in (ring_tools or []) for t in
                ["ride_book", "food_order", "dining_book", "group_send", "gmail_send", "browser_act"]):
            out = 25
        elif any(p in txt for p in ["which ", "send me", "share ", "drop ", "what "]):
            out = 22  # correctly asked for missing info
        else:
            out = 20

    total = conc + intel + direct + out
    return {"conciseness": conc, "intelligence": intel, "directness": direct, "outcome": out}, total

def main():
    actions = {a["id"]: a for a in load("1000-actions.json")}
    with open(os.path.join(HERE, "1000-actions-ring-results.json")) as f:
        rr = json.load(f)["results"]
    ring_by_id = {}
    for k, v in rr.items():
        if isinstance(v, dict) and v.get("id"):
            ring_by_id[v["id"]] = v
    scores = load("1000-actions-scores.json")
    by_id = {e["id"]: e for e in scores}

    # Categories in batch order per parent spec
    batch_cats = [
        ("group_social", 1), ("subscriptions_finance", 2), ("travel", 3),
        ("food_dining", 4), ("calendar_comms", 5), ("shopping", 6),
        ("account_management", 7),
    ]
    # batches 8,9,10: complex multi-step, edge, adversarial — map from complexity/tags
    cat_of = {}
    ordered = []
    for cat, bn in batch_cats:
        ids = sorted([i for i, a in actions.items() if a["category"] == cat])
        for i in ids:
            cat_of[i] = bn
        ordered.extend(ids)
    # remaining (should be none, but be safe)
    rest = sorted(set(actions) - set(ordered))
    # split rest into 8,9,10 by complexity
    for i in rest:
        c = actions[i].get("complexity", "")
        cat_of[i] = 8 if c == "complex" else 9
    ordered.extend(rest)

    batches = {n: [] for n in range(1, 11)}
    updated = 0
    for idx, aid in enumerate(ordered):
        a = actions[aid]
        e = by_id[aid]
        r = ring_by_id.get(aid, {})
        rtext = r.get("response_text") or ""
        rtools = r.get("tools_called") or []
        if rtext and not e.get("ring_response"):
            e["ring_response"] = rtext
            e["ring_tools"] = rtools
        if e.get("ring_response") and not e.get("ring_scores"):
            sc, tot = score_ring_vs_muse(e.get("muse_response", ""), e["ring_response"], e.get("ring_tools", []))
            e["ring_scores"] = sc
            e["ring_total"] = tot
            updated += 1
        bn = cat_of.get(aid, 10)
        batches[bn].append({
            "id": aid,
            "category": a["category"],
            "complexity": a.get("complexity"),
            "input": a["input"],
            "muse_response": e.get("muse_response"),
            "ring_response": e.get("ring_response"),
            "ring_tools": e.get("ring_tools"),
            "ring_scores": e.get("ring_scores"),
            "ring_total": e.get("ring_total"),
            "ring_source": "live" if aid in ring_by_id and ring_by_id[aid].get("response_text") else "missing",
            "grok_response_predicted": e.get("grok_response_predicted"),
            "grok_vs_muse": e.get("grok_vs_muse"),
        })

    for n, items in batches.items():
        with open(os.path.join(HERE, f"3way-batch-{n}.json"), "w") as f:
            json.dump({"batch": n, "count": len(items), "items": items}, f, indent=1)
    with open(os.path.join(HERE, "1000-actions-scores.json"), "w") as f:
        json.dump(scores, f, indent=1)
    print(f"batches: {[(n, len(v)) for n, v in batches.items()]}")
    print(f"newly scored: {updated}")
    # summary stats
    totals = [e["ring_total"] for e in scores if e.get("ring_total") is not None]
    print(f"ring scored: {len(totals)}/1000, mean: {sum(totals)/len(totals):.1f}" if totals else "none")

if __name__ == "__main__":
    main()
