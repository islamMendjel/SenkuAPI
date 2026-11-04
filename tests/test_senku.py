#!/usr/bin/env python3
"""
test_senku.py — end-to-end verification suite for SenkuAPI.

Pure Python 3 stdlib (urllib.request + json — no third-party packages).
Runs against the LIVE dev server (default http://localhost:3000, override
with the SENKU_BASE_URL env var):

    python3 tests/test_senku.py        (equivalently: bun run test:senku)

Exit code 0 only if every check passes.

NOTE ON CACHE PROBES: SenkuAPI caches exact-match responses for 24 h, so
each probe message carries a per-run nonce. This keeps the suite
re-runnable (the "first" request of every cache test is always a genuine
cache miss) while preserving the semantics under test: the two requests
inside a cache test share an IDENTICAL body, byte for byte.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get("SENKU_BASE_URL", "http://localhost:3000")
TIMEOUT = 90  # seconds — cloud calls can be slow
NONCE = "{}-{}".format(int(time.time()), uuid.uuid4().hex[:6])

RESULTS = []  # (test_no, label, ok, detail)


# ─────────────────────────────────────────────────────────────────────
# Harness
# ─────────────────────────────────────────────────────────────────────

def check(test_no, label, ok, detail=""):
    """Record + print one PASS/FAIL line; returns the boolean."""
    ok = bool(ok)
    RESULTS.append((test_no, label, ok, detail))
    mark = "PASS" if ok else "FAIL"
    line = "  [{}] Test {}: {}".format(mark, test_no, label)
    if detail:
        line += "  — {}".format(detail)
    print(line, flush=True)
    return ok


def api(method, path, body=None, timeout=TIMEOUT):
    """JSON request helper. Returns (status, parsed_body, content_type)."""
    url = BASE + path
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status, ctype = resp.status, resp.headers.get("Content-Type", "")
            raw = resp.read()
    except urllib.error.HTTPError as e:
        status, ctype = e.code, e.headers.get("Content-Type", "")
        raw = e.read()
    except urllib.error.URLError as e:
        raise RuntimeError("cannot reach {} {}: {}".format(method, url, e))
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        parsed = None
    return status, parsed, ctype


def sse_post(path, body, timeout=TIMEOUT):
    """POST and consume a text/event-stream response.

    Reads the raw stream, splits frames on blank lines ("\\n\\n") and
    parses every line starting with "data: ". Returns
    (content_type, [events]).
    """
    url = BASE + path
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ctype = resp.headers.get("Content-Type", "")
            raw = resp.read()  # stream stays open until the server closes it
    except urllib.error.HTTPError as e:
        # Non-2xx: surface the error body as a single error-ish event.
        ctype = e.headers.get("Content-Type", "")
        raw = e.read()
    except urllib.error.URLError as e:
        raise RuntimeError("cannot reach POST {}: {}".format(url, e))

    text = raw.decode("utf-8", errors="replace")
    events = []
    for frame in text.split("\n\n"):
        for line in frame.split("\n"):
            line = line.strip()
            if line.startswith("data:"):
                payload = line[len("data:"):].strip()
                if payload:
                    try:
                        events.append(json.loads(payload))
                    except ValueError:
                        pass
    return ctype, events


def get_chat_ids():
    _, chats, _ = api("GET", "/api/chats")
    return chats if isinstance(chats, list) else []


def cleanup_test_chats():
    """Delete every persisted chat whose title starts with SENKU-TEST."""
    deleted = 0
    for c in get_chat_ids():
        if isinstance(c, dict) and str(c.get("title", "")).startswith("SENKU-TEST"):
            status, _, _ = api("DELETE", "/api/chats/{}".format(c.get("id")))
            if status == 200:
                deleted += 1
    return deleted


def ensure_apinex_active():
    """Safety net: make sure APInex is the active provider. Returns name."""
    _, usage, _ = api("GET", "/api/usage")
    usage = usage or {}
    active = usage.get("activeProvider") or {}
    if active.get("slug") == "apinex":
        return active.get("name")
    apinex = next(
        (p for p in (usage.get("providers") or []) if p.get("slug") == "apinex"),
        None,
    )
    if apinex:
        api("POST", "/api/providers/switch", {"providerId": apinex["id"]})
        _, usage2, _ = api("GET", "/api/usage")
        return (usage2 or {}).get("activeProvider", {}).get("name")
    return active.get("name")


# ─────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────

def test_1_bootstrap():
    print("\n=== Test 1: bootstrap integrity ===")
    status, b, _ = api("GET", "/api/bootstrap")
    check(1, "GET /api/bootstrap returns 200", status == 200, "status={}".format(status))
    if status != 200 or not isinstance(b, dict):
        check(1, "bootstrap payload is a JSON object", False, "aborting Test 1")
        return None
    for key in ("user", "activeProvider", "providers", "limiter", "chats"):
        check(1, "bootstrap contains '{}'".format(key), key in b)

    providers = b.get("providers") or []
    check(1, "providers seeded (>= 2)", len(providers) >= 2, "got {}".format(len(providers)))
    by_name = {p.get("name"): p for p in providers if isinstance(p, dict)}
    apinex, oxion = by_name.get("APInex"), by_name.get("OxionAI")
    check(1, "APInex and OxionAI both present", apinex is not None and oxion is not None)

    active = [p.get("name") for p in providers if p.get("isActive")]
    check(1, "exactly ONE active provider", len(active) == 1, "active={}".format(active))

    if apinex is not None:
        check(1, "APInex.slug == 'apinex'", apinex.get("slug") == "apinex", "got {!r}".format(apinex.get("slug")))
        check(1, "APInex.baseUrl == 'https://api.apinex.bond/v1'",
              apinex.get("baseUrl") == "https://api.apinex.bond/v1",
              "got {!r}".format(apinex.get("baseUrl")))
        check(1, "APInex.hasTokenLimit is false", apinex.get("hasTokenLimit") is False,
              "got {!r}".format(apinex.get("hasTokenLimit")))
        check(1, "APInex.tokenMultiplier == 4.0", apinex.get("tokenMultiplier") == 4.0,
              "got {!r}".format(apinex.get("tokenMultiplier")))
        models = apinex.get("models") or []
        free = [m for m in models if str(m).startswith("free/")]
        check(1, "APInex exposes free/* models", len(free) >= 3,
              "free/* models: {}".format(free))
    if oxion is not None:
        check(1, "OxionAI.slug == 'oxionai'", oxion.get("slug") == "oxionai",
              "got {!r}".format(oxion.get("slug")))
        check(1, "OxionAI.hasTokenLimit is true", oxion.get("hasTokenLimit") is True,
              "got {!r}".format(oxion.get("hasTokenLimit")))
        check(1, "OxionAI.tokenLimitPerKey == 500000",
              oxion.get("tokenLimitPerKey") == 500000,
              "got {!r}".format(oxion.get("tokenLimitPerKey")))
        keys = oxion.get("keys") or []
        check(1, "OxionAI has >= 2 pooled keys", len(keys) >= 2, "got {}".format(len(keys)))
        masked_ok = all(isinstance(k.get("masked"), str) and "•" in k["masked"] for k in keys)
        check(1, "OxionAI keys are masked (contain '•')", masked_ok,
              "masked={}".format([k.get("masked") for k in keys]))
        check(1, "no raw key material exposed in key objects",
              not any("keyValue" in k for k in keys),
              "key fields={}".format(sorted(keys[0].keys()) if keys else []))
    return {"apinex": apinex, "oxion": oxion}


def test_2a_switch_to_oxionai(oxion_id):
    print("\n=== Test 2 (part 1/2): switch to OxionAI ===")
    status, snap, _ = api("POST", "/api/providers/switch", {"providerId": oxion_id})
    check(2, "POST /api/providers/switch → OxionAI returns 200", status == 200,
          "status={}".format(status))
    status, u, _ = api("GET", "/api/usage")
    check(2, "GET /api/usage returns 200", status == 200, "status={}".format(status))
    u = u or {}
    active = [p.get("name") for p in (u.get("providers") or []) if p.get("isActive")]
    check(2, "exactly one active provider, and it is OxionAI",
          len(active) == 1 and active[0] == "OxionAI", "active={}".format(active))
    check(2, "usage.activeProvider is OxionAI",
          (u.get("activeProvider") or {}).get("name") == "OxionAI")
    lim = u.get("limiter") or {}
    check(2, "limiter.unlimited is false for OxionAI", lim.get("unlimited") is False,
          "got {!r}".format(lim.get("unlimited")))
    ak, pl = lim.get("activeKeys"), lim.get("poolLimit")
    check(2, "poolLimit == 500000 × activeKeys (2 pooled keys)",
          isinstance(ak, int) and ak >= 2 and pl == 500000 * ak,
          "activeKeys={}, poolLimit={}".format(ak, pl))


def test_2b_switch_back_to_apinex(apinex_id):
    print("\n=== Test 2 (part 2/2): switch back to APInex ===")
    status, _, _ = api("POST", "/api/providers/switch", {"providerId": apinex_id})
    check(2, "POST /api/providers/switch → APInex returns 200", status == 200,
          "status={}".format(status))
    status, u, _ = api("GET", "/api/usage")
    u = u or {}
    active = [p.get("name") for p in (u.get("providers") or []) if p.get("isActive")]
    check(2, "exactly one active provider, and it is APInex",
          len(active) == 1 and active[0] == "APInex", "active={}".format(active))
    lim = u.get("limiter") or {}
    check(2, "limiter.unlimited is true for APInex", lim.get("unlimited") is True,
          "got {!r}".format(lim.get("unlimited")))
    check(2, "limiter.status == 'unlimited'", lim.get("status") == "unlimited",
          "got {!r}".format(lim.get("status")))


def test_3_round_robin():
    print("\n=== Test 3: round-robin key rotation (OxionAI active) ===")
    keys_seen = []
    for word in ("alpha", "beta"):
        body = {
            "model": "claude-sonnet-5.5",
            "messages": [{"role": "user",
                          "content": "Reply with the single word: {} ({})".format(word, NONCE)}],
        }
        status, r, _ = api("POST", "/api/v1/chat/completions", body)
        ok = status == 200 and isinstance(r, dict) and isinstance(r.get("senku"), dict)
        check(3, "completion '{}' succeeded via OxionAI".format(word), ok,
              "status={}".format(status))
        label = (r.get("senku") or {}).get("key") if isinstance(r, dict) else None
        check(3, "completion '{}' reports senku.key".format(word),
              isinstance(label, str) and label != "", "senku.key={!r}".format(label))
        if label:
            keys_seen.append(label)
    check(3, "the two requests used DIFFERENT pooled keys",
          len(keys_seen) == 2 and keys_seen[0] != keys_seen[1],
          "keys={}".format(keys_seen))
    check(3, "both keys are OxionAI pool keys ('Pool key #N')",
          len(keys_seen) == 2 and all(k.startswith("Pool key #") for k in keys_seen),
          "keys={}".format(keys_seen))


def test_10_limiter_tiers():
    print("\n=== Test 10: limiter tier sanity (OxionAI active) ===")
    _, u, _ = api("GET", "/api/usage")
    lim = (u or {}).get("limiter") or {}
    tiers = lim.get("tiers") or {}
    monthly, daily, burst = tiers.get("monthly") or {}, tiers.get("daily") or {}, tiers.get("burst5h") or {}
    check(10, "tiers.monthly.label == 'Monthly Pool'", monthly.get("label") == "Monthly Pool",
          "got {!r}".format(monthly.get("label")))
    check(10, "tiers.monthly.limit == 500000", monthly.get("limit") == 500000,
          "got {!r}".format(monthly.get("limit")))
    check(10, "tiers.daily.label == 'Daily Pace'", daily.get("label") == "Daily Pace",
          "got {!r}".format(daily.get("label")))
    check(10, "tiers.daily.limit == 16667", daily.get("limit") == 16667,
          "got {!r}".format(daily.get("limit")))
    check(10, "tiers.burst5h.label == '5H Burst'", burst.get("label") == "5H Burst",
          "got {!r}".format(burst.get("label")))
    check(10, "tiers.burst5h.limit == 6945", burst.get("limit") == 6945,
          "got {!r}".format(burst.get("limit")))
    ak = lim.get("activeKeys")
    check(10, "poolLimit == 500000 × activeKeys",
          isinstance(ak, int) and ak >= 1 and lim.get("poolLimit") == 500000 * ak,
          "activeKeys={}, poolLimit={}".format(ak, lim.get("poolLimit")))
    check(10, "limiter.status is an OxionAI pacing status",
          lim.get("status") in ("on-track", "steady", "high-pace", "exhausted"),
          "got {!r}".format(lim.get("status")))


def test_4_openai_compat():
    print("\n=== Test 4: OpenAI-compatible response shape (APInex active) ===")
    body = {
        "model": "free/glm-5.3",
        "messages": [{"role": "user",
                      "content": "Reply with exactly: shape probe q7 ({})".format(NONCE)}],
    }
    status, r, _ = api("POST", "/api/v1/chat/completions", body)
    check(4, "POST /api/v1/chat/completions returns 200", status == 200,
          "status={}".format(status))
    r = r or {}
    check(4, "response has non-empty 'id'", isinstance(r.get("id"), str) and bool(r["id"]),
          "id={!r}".format(r.get("id")))
    check(4, "object == 'chat.completion'", r.get("object") == "chat.completion",
          "got {!r}".format(r.get("object")))
    choices = r.get("choices") or []
    msg = (choices[0] or {}).get("message") if choices else None
    check(4, "choices[0].message.content is non-empty",
          isinstance(msg, dict) and isinstance(msg.get("content"), str) and bool(msg["content"].strip()),
          "content={!r}".format((msg or {}).get("content")))
    check(4, "choices[0].message.role == 'assistant'",
          isinstance(msg, dict) and msg.get("role") == "assistant",
          "got {!r}".format((msg or {}).get("role")))
    usage = r.get("usage") or {}
    tt = usage.get("total_tokens")
    check(4, "usage.total_tokens >= 0", isinstance(tt, int) and tt >= 0,
          "usage={}".format(usage))
    senku = r.get("senku") or {}
    check(4, "senku.provider == 'APInex'", senku.get("provider") == "APInex",
          "got {!r}".format(senku.get("provider")))


def test_5_exact_match_cache():
    print("\n=== Test 5: exact-match caching (APInex active) ===")
    body = {
        "model": "free/glm-5.3",
        "messages": [{"role": "user",
                      "content": "Reply with exactly: cache probe 7c9x {}".format(NONCE)}],
    }
    status, r1, _ = api("POST", "/api/v1/chat/completions", body)
    check(5, "first request returns 200", status == 200, "status={}".format(status))
    r1 = r1 or {}
    s1 = r1.get("senku") or {}
    check(5, "first response senku.cached == false", s1.get("cached") is False,
          "got {!r}".format(s1.get("cached")))
    u1 = r1.get("usage") or {}
    check(5, "first response usage.total_tokens > 0",
          isinstance(u1.get("total_tokens"), int) and u1["total_tokens"] > 0,
          "usage={}".format(u1))

    # IDENTICAL body — byte for byte the same JSON payload.
    status, r2, _ = api("POST", "/api/v1/chat/completions", body)
    check(5, "second (identical) request returns 200", status == 200,
          "status={}".format(status))
    r2 = r2 or {}
    s2 = r2.get("senku") or {}
    check(5, "second response senku.cached == true", s2.get("cached") is True,
          "got {!r}".format(s2.get("cached")))
    u2 = r2.get("usage") or {}
    check(5, "second response usage.total_tokens == 0", u2.get("total_tokens") == 0,
          "usage={}".format(u2))

    c1 = ((r1.get("choices") or [{}])[0].get("message") or {}).get("content")
    c2 = ((r2.get("choices") or [{}])[0].get("message") or {}).get("content")
    check(5, "cached content identical to the first response",
          isinstance(c1, str) and bool(c1) and c1 == c2,
          "first={!r} second={!r}".format(c1, c2))


def test_6_sse_temporary():
    print("\n=== Test 6: SSE streaming + temporary chat (APInex active) ===")
    chats_before = get_chat_ids()
    ids_before = {c.get("id") for c in chats_before if isinstance(c, dict)}

    body = {
        "content": "Reply with exactly: temp probe k3m2 {}".format(NONCE),
        "model": "free/glm-5.3",
        "search": False,
        "temporary": True,
        "history": [],
    }
    ctype, ev1 = sse_post("/api/chat/send", body)
    check(6, "response Content-Type is text/event-stream",
          "text/event-stream" in (ctype or ""), "got {!r}".format(ctype))
    types1 = [e.get("type") for e in ev1 if isinstance(e, dict)]
    check(6, "no 'error' event on first send", "error" not in types1,
          "event types={}".format(types1[:12]))

    metas = [e for e in ev1 if isinstance(e, dict) and e.get("type") == "meta"]
    check(6, "'meta' event received", len(metas) == 1, "types={}".format(types1[:12]))
    if metas:
        m = metas[0]
        check(6, "meta.chatId is null (temporary chat)", m.get("chatId") is None,
              "got {!r}".format(m.get("chatId")))
        check(6, "meta.provider == 'APInex'", m.get("provider") == "APInex",
              "got {!r}".format(m.get("provider")))
        check(6, "meta.model == 'free/glm-5.3'", m.get("model") == "free/glm-5.3",
              "got {!r}".format(m.get("model")))
    deltas = [e for e in ev1 if isinstance(e, dict) and e.get("type") == "delta"]
    check(6, "at least one 'delta' event", len(deltas) >= 1, "got {}".format(len(deltas)))
    check(6, "no 'sources' event when search=false", "sources" not in types1)
    dones = [e for e in ev1 if isinstance(e, dict) and e.get("type") == "done"]
    check(6, "'done' event received", len(dones) == 1, "types={}".format(types1[:12]))
    d1 = dones[0] if dones else {}
    check(6, "first done.cached == false", d1.get("cached") is False,
          "got {!r}".format(d1.get("cached")))
    check(6, "first done.chatId is null (nothing persisted)", d1.get("chatId") is None,
          "got {!r}".format(d1.get("chatId")))

    # IDENTICAL request again — must be served from cache on the SSE path.
    _, ev2 = sse_post("/api/chat/send", body)
    d2 = next((e for e in ev2 if isinstance(e, dict) and e.get("type") == "done"), {})
    check(6, "second identical send: done.cached == true", d2.get("cached") is True,
          "got {!r}".format(d2.get("cached")))
    check(6, "second identical send: done.tokens == 0", d2.get("tokens") == 0,
          "got {!r}".format(d2.get("tokens")))
    check(6, "cached SSE content matches the first send",
          isinstance(d1.get("content"), str) and bool(d1["content"]) and d1.get("content") == d2.get("content"))

    # Nothing may have been persisted by either temporary send.
    chats_after = get_chat_ids()
    ids_after = {c.get("id") for c in chats_after if isinstance(c, dict)}
    new_ids = ids_after - ids_before
    check(6, "no new persisted chat after temporary sends", not new_ids,
          "new chat ids={}".format(sorted(new_ids)))
    leaked = [c.get("title") for c in chats_after
              if isinstance(c, dict) and "temp probe" in str(c.get("title", ""))]
    check(6, "no chat title contains the temp-probe text", not leaked,
          "leaked={}".format(leaked))


def test_7_search_discipline():
    print("\n=== Test 7: web search discipline ===")
    status, r, _ = api("POST", "/api/search", {"query": "python programming language"})
    check(7, "POST /api/search returns 200", status == 200, "status={}".format(status))
    r = r or {}
    results = r.get("results") or []
    check(7, "result count matches 'count' field", r.get("count") == len(results),
          "count={!r}, len={}".format(r.get("count"), len(results)))
    check(7, "at most 3 results returned", len(results) <= 3, "got {}".format(len(results)))
    check(7, "at least 1 result returned", len(results) >= 1, "got {}".format(len(results)))
    snippet_ok = all(isinstance(x.get("snippet"), str) and len(x["snippet"]) <= 300
                     for x in results)
    longest = max((len(x.get("snippet") or "") for x in results), default=0)
    check(7, "every snippet <= 300 chars", snippet_ok, "longest snippet={}".format(longest))
    no_html = all(
        "<" not in str(x.get("title", "")) and ">" not in str(x.get("title", "")) and
        "<" not in str(x.get("snippet", "")) and ">" not in str(x.get("snippet", ""))
        for x in results)
    check(7, "no '<' or '>' characters in title/snippet", no_html)
    url_ok = all(isinstance(x.get("url"), str) and
                 (x["url"].startswith("http://") or x["url"].startswith("https://")) and
                 len(x["url"]) > 8
                 for x in results)
    check(7, "every result has a non-empty url starting with http", url_ok,
          "urls={}".format([x.get("url") for x in results]))
    title_ok = all(isinstance(x.get("title"), str) and bool(x["title"].strip())
                   for x in results)
    check(7, "every result has a non-empty title", title_ok)


def test_8_chat_crud():
    print("\n=== Test 8: chat CRUD ===")
    status, chat, _ = api("POST", "/api/chats", {"title": "SENKU-TEST-CHAT"})
    check(8, "POST /api/chats returns 200", status == 200, "status={}".format(status))
    chat = chat or {}
    cid = chat.get("id")
    check(8, "created chat has an id", isinstance(cid, str) and bool(cid), "chat={!r}".format(chat))
    check(8, "created chat title == 'SENKU-TEST-CHAT'", chat.get("title") == "SENKU-TEST-CHAT",
          "got {!r}".format(chat.get("title")))
    if not cid:
        return
    status, got, _ = api("GET", "/api/chats/{}".format(cid))
    check(8, "GET /api/chats/{id} returns 200", status == 200, "status={}".format(status))
    check(8, "chat detail contains a 'messages' array",
          isinstance((got or {}).get("messages"), list),
          "got {!r}".format(type((got or {}).get("messages")).__name__))
    status, patched, _ = api("PATCH", "/api/chats/{}".format(cid),
                             {"title": "SENKU-TEST-RENAMED"})
    check(8, "PATCH rename returns 200", status == 200, "status={}".format(status))
    check(8, "PATCH response title == 'SENKU-TEST-RENAMED'",
          (patched or {}).get("title") == "SENKU-TEST-RENAMED",
          "got {!r}".format((patched or {}).get("title")))
    status, got2, _ = api("GET", "/api/chats/{}".format(cid))
    check(8, "rename persisted (GET shows new title)",
          (got2 or {}).get("title") == "SENKU-TEST-RENAMED",
          "got {!r}".format((got2 or {}).get("title")))
    status, _, _ = api("DELETE", "/api/chats/{}".format(cid))
    check(8, "DELETE returns 200", status == 200, "status={}".format(status))
    status, _, _ = api("GET", "/api/chats/{}".format(cid))
    check(8, "GET after DELETE returns 404", status == 404, "status={}".format(status))
    listing = get_chat_ids()
    check(8, "deleted chat no longer appears in GET /api/chats",
          all(c.get("id") != cid for c in listing))


def test_9_models():
    print("\n=== Test 9: models endpoint (APInex active) ===")
    status, m, _ = api("GET", "/api/models")
    check(9, "GET /api/models returns 200", status == 200, "status={}".format(status))
    m = m or {}
    prov = m.get("provider") or {}
    check(9, "provider.name == 'APInex'", prov.get("name") == "APInex",
          "got {!r}".format(prov.get("name")))
    check(9, "provider.slug == 'apinex'", prov.get("slug") == "apinex",
          "got {!r}".format(prov.get("slug")))
    check(9, "provider.baseUrl == 'https://api.apinex.bond/v1'",
          prov.get("baseUrl") == "https://api.apinex.bond/v1",
          "got {!r}".format(prov.get("baseUrl")))
    models = m.get("models") or []
    check(9, "models list is non-empty", len(models) >= 1, "got {}".format(len(models)))
    check(9, "'free/glm-5.3' present in models", "free/glm-5.3" in models,
          "models={}".format(models))
    check(9, "'free/claude-4.6-opus' present in models", "free/claude-4.6-opus" in models)
    check(9, "all APInex models are free/* models",
          all(str(x).startswith("free/") for x in models), "models={}".format(models))


# ─────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────

def run_test(test_no, fn, *args):
    """Run one test function; a crash counts as a FAIL for that test."""
    try:
        fn(*args)
    except Exception as e:  # noqa: BLE001 — report, don't die
        check(test_no, "{} completed without exception".format(fn.__name__), False,
              "{}: {}".format(type(e).__name__, e))


def summarize():
    by_test = {}
    for test_no, label, ok, detail in RESULTS:
        agg = by_test.setdefault(test_no, {"pass": 0, "fail": 0, "fails": []})
        if ok:
            agg["pass"] += 1
        else:
            agg["fail"] += 1
            agg["fails"].append("{}{}".format(label, " ({})".format(detail) if detail else ""))

    print("\n" + "=" * 68)
    print("SUMMARY")
    print("=" * 68)
    all_ok = True
    for test_no in sorted(by_test):
        agg = by_test[test_no]
        status = "PASS" if agg["fail"] == 0 else "FAIL"
        print("  Test {:<3}: {}  ({}/{} checks)".format(test_no, status, agg["pass"],
                                                        agg["pass"] + agg["fail"]))
        for f in agg["fails"]:
            print("           ✗ {}".format(f))
        if agg["fail"]:
            all_ok = False
    total_pass = sum(1 for _, _, ok, _ in RESULTS if ok)
    print("-" * 68)
    print("TOTAL: {}/{} checks passed — {}".format(
        total_pass, len(RESULTS), "ALL TESTS PASSED" if all_ok else "SOME TESTS FAILED"))
    return all_ok


def main():
    print("SenkuAPI verification suite")
    print("Target   : {}".format(BASE))
    print("Run nonce: {}  (keeps cache probes fresh on every run)".format(NONCE))
    start = time.time()

    leftover = cleanup_test_chats()
    if leftover:
        print("[setup] removed {} leftover SENKU-TEST chat(s) from earlier runs".format(leftover))

    ids = None
    try:
        ids = test_1_bootstrap() or {}
        apinex = ids.get("apinex") or {}
        oxion = ids.get("oxion") or {}

        # OxionAI-dependent tests first (provider switching is expensive) …
        if oxion.get("id"):
            run_test(2, test_2a_switch_to_oxionai, oxion["id"])
            run_test(3, test_3_round_robin)
            run_test(10, test_10_limiter_tiers)
        else:
            check(2, "OxionAI provider found in bootstrap", False, "cannot switch")
        # … then restore APInex and run the APInex-dependent tests.
        if apinex.get("id"):
            run_test(2, test_2b_switch_back_to_apinex, apinex["id"])
        else:
            check(2, "APInex provider found in bootstrap", False, "cannot switch back")

        run_test(4, test_4_openai_compat)
        run_test(5, test_5_exact_match_cache)
        run_test(6, test_6_sse_temporary)
        run_test(7, test_7_search_discipline)
        run_test(8, test_8_chat_crud)
        run_test(9, test_9_models)
    finally:
        # ── Contract: always leave the app in its default state. ──
        name = ensure_apinex_active()
        print("\n[restore] active provider is now: {}".format(name))
        cleaned = cleanup_test_chats()
        print("[restore] SENKU-TEST chats remaining after cleanup: {}".format(cleaned))

    all_ok = summarize()
    print("Elapsed: {:.1f}s".format(time.time() - start))
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
