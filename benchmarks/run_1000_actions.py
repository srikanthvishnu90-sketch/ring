#!/usr/bin/env python3
"""Capture Ring /api/chat responses for all scenarios in 1000-actions.json.

Designed for a 1000-scenario benchmark run:
  - authenticates once as demo@ring.app (token re-fetched on 401)
  - POSTs each scenario input to /api/chat on a FRESH thread
  - captures: full response text, tools called, response time, error codes in text
  - writes results INCREMENTALLY after every scenario (crash-safe)
  - resumes from the results file: scenarios already present are skipped

Usage:
  RING_PASSWORD=... python3 run_1000_actions.py [--limit N] [--sleep SECONDS] [--mock]
  RING_EMAIL defaults to demo@ring.app; RING_PASSWORD required unless --mock.

  --limit N     run at most N scenarios (default: all not-yet-done)
  --sleep S     seconds between calls (default 1.5)
  --mock        exercise the whole pipeline with fake responses (no credentials needed)
  --scenarios   path to scenarios JSON (default: 1000-actions.json next to this script)
  --results     path to results JSON (default: 1000-actions-ring-results.json next to this script)

Options/env are kept deliberately compatible with run_realworld_tests.py.
Password is read from env only, never logged or written to disk.
"""
import argparse, json, os, re, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "https://ringsss.vercel.app"
EMAIL = os.environ.get("RING_EMAIL", "demo@ring.app")
PASSWORD = os.environ.get("RING_PASSWORD", "")
ERROR_CODE_RE = re.compile(r"\[[a-z_0-9]+\]")


def api(method, path, body=None, token=None, timeout=180):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, {"_http_error": e.code, "_body": e.read().decode(errors="replace")[:2000]}
    except Exception as e:
        return -1, {"_exc": f"{type(e).__name__}: {e}"[:500]}


class Client:
    """Real Ring API client with 401 re-auth."""
    def __init__(self):
        self.token = None
        self.authenticate()

    def authenticate(self):
        print("Authenticating as", EMAIL, "...", flush=True)
        status, auth = api("POST", "/api/auth/password",
                           {"email": EMAIL, "password": PASSWORD}, timeout=60)
        self.token = (auth or {}).get("access_token")
        if not self.token:
            print(f"AUTH FAILED (http {status}): {json.dumps(auth)[:200]}", file=sys.stderr)
            sys.exit(1)
        print("Authenticated OK", flush=True)

    def chat(self, text, thread_id):
        status, resp = api("POST", "/api/chat",
                           {"text": text[:2000], "threadId": thread_id}, self.token)
        if status == 401:  # token expired mid-run -> re-auth once, retry
            self.authenticate()
            status, resp = api("POST", "/api/chat",
                               {"text": text[:2000], "threadId": thread_id}, self.token)
        return status, resp


class MockClient:
    """Fake client that exercises the whole pipeline without credentials."""
    def __init__(self):
        print("MOCK MODE: no real API calls", flush=True)
        self.token = "mock"
        self.n = 0

    def authenticate(self):
        pass

    def chat(self, text, thread_id):
        self.n += 1
        time.sleep(0.05)
        # every 3rd scenario "calls tools"; one scenario contains a fake error code
        tools = [{"name": "browser_check_google_auth"}, {"name": "web_search"}] if self.n % 3 == 0 else []
        reply = f"Mock reply #{self.n} to: {text[:60]}"
        if self.n == 2:
            reply += " failed with [browser_timeout] so retry later"
        return 200, {"text": reply, "toolsUsed": tools, "model": "mock-v1"}


def load_json(path):
    with open(path) as f:
        return json.load(f)


def save_json_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--sleep", type=float, default=1.5)
    p.add_argument("--mock", action="store_true")
    p.add_argument("--scenarios", default=os.path.join(HERE, "1000-actions.json"))
    p.add_argument("--results", default=os.path.join(HERE, "1000-actions-ring-results.json"))
    args = p.parse_args()

    if not args.mock and not PASSWORD:
        print("RING_PASSWORD env required (or use --mock)", file=sys.stderr)
        sys.exit(1)

    scenarios = load_json(args.scenarios)
    print(f"Loaded {len(scenarios)} scenarios from {args.scenarios}", flush=True)

    # resume: load existing results, skip completed ids
    store = {"meta": {}, "results": {}}
    if os.path.exists(args.results):
        store = load_json(args.results)
        store.setdefault("meta", {})
        store.setdefault("results", {})
        print(f"Resuming: {len(store['results'])} scenarios already done, skipping them", flush=True)

    todo = [s for s in scenarios if s.get("id") not in store["results"]]
    if args.limit is not None:
        todo = todo[:args.limit]
    print(f"Running {len(todo)} scenarios (limit={args.limit}, sleep={args.sleep}s)", flush=True)
    if not todo:
        print("Nothing to do.")
        return

    client = MockClient() if args.mock else Client()
    run_id = f"run1000_{int(time.time())}"
    latencies = []

    for i, s in enumerate(todo):
        sid = s.get("id", f"NOID_{i}")
        tid = f"{run_id}_{sid}"
        t0 = time.time()
        try:
            status, resp = client.chat(s.get("input", ""), tid)
        except Exception as e:  # defensive: never lose the loop
            status, resp = -1, {"_exc": f"{type(e).__name__}: {e}"[:500]}
        elapsed = round(time.time() - t0, 2)
        latencies.append(elapsed)

        if status != 200 or resp.get("_http_error") or resp.get("_exc"):
            rec = {"id": sid, "category": s.get("category"), "input": s.get("input", "")[:200],
                   "ok": False, "http_status": status,
                   "response_time_s": elapsed, "response_text": "",
                   "tools_called": [], "tools_detail": [],
                   "error_codes_in_text": [], "error": json.dumps(resp)[:500]}
            print(f"[{i+1}/{len(todo)}] {sid} ERROR http={status} {str(resp)[:90]}", flush=True)
        else:
            text = resp.get("text", "") or resp.get("reply", "") or ""
            tools_used = resp.get("toolsUsed", []) or resp.get("tools", []) or []
            tool_names = [t.get("name", "?") for t in tools_used if isinstance(t, dict)]
            codes = sorted(set(ERROR_CODE_RE.findall(text)))
            rec = {"id": sid, "category": s.get("category"), "input": s.get("input", "")[:200],
                   "ok": True, "http_status": status,
                   "response_time_s": elapsed, "response_text": text,
                   "tools_called": tool_names, "tools_detail": tools_used,
                   "error_codes_in_text": codes,
                   "model": resp.get("model"), "thread_id": tid,
                   "error": None}
            print(f"[{i+1}/{len(todo)}] {sid} ok {elapsed}s "
                  f"{len(text.split())}w tools={tool_names[:4]}"
                  + (f" CODES={codes}" if codes else ""), flush=True)

        store["results"][sid] = rec
        store["meta"] = {"run_id": run_id, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                         "scenarios_file": os.path.basename(args.scenarios),
                         "done": len(store["results"]), "total": len(scenarios),
                         "mock": args.mock}
        save_json_atomic(args.results, store)  # incremental, crash-safe

        if i < len(todo) - 1:
            time.sleep(args.sleep)

    # summary
    done = list(store["results"].values())
    oks = [r for r in done if r.get("ok")]
    avg = (sum(latencies) / len(latencies)) if latencies else 0
    coded = [r for r in oks if r.get("error_codes_in_text")]
    print("\n=== RUN SUMMARY ===")
    print(f"  completed this run: {len(latencies)} (total stored: {len(done)}/{len(scenarios)})")
    print(f"  ok: {len(oks)}, failed: {len(done) - len(oks)}")
    print(f"  avg response time: {avg:.1f}s (this run)")
    print(f"  responses containing [error_codes]: {len(coded)}")
    if avg:
        full = len(scenarios) * (avg + args.sleep) / 3600
        print(f"  estimated full {len(scenarios)}-scenario run at this pace: ~{full:.1f}h")
    print(f"Saved to {args.results}")


if __name__ == "__main__":
    main()
