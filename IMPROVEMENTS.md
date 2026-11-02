# IMPROVEMENTS.md — SenkuAPI continuous improvement log

One meaningful, verified change per run. Highest rung of the priority
ladder wins: correctness → usability → performance → robustness →
quality → polish.

---

## Run 1 — 2026-11-01: Health-aware key dispatch (circuit breaker + in-turn retry)

**Rung:** 1 (Correctness) + 2 (Usability) + 3 (Performance)

**Ladder context:** Earlier fixes already shipped: WelcomeScreen
layout rewrite, de-gilded Thinking animation, professional code
blocks (Markdown.tsx), live date/time context in the system prompt
(fixes "June 19, 2023" date hallucination — verified working).

### Diagnosis

Live-testing the gateway revealed the round-robin key router had
**zero key-health awareness**. APInex's "Pool key #2" returns
`401 Invalid API key` from the provider, so:

- Every other request (whenever rotation landed on the dead key)
  silently failed over to the Z.ai cloud runtime — the slow
  fake-streaming path (48-char chunks @ 6ms) instead of the fast
  native provider SSE stream.
- The message metadata row **lied**: it claimed
  "APInex · Pool key #2 · cloud failover" — crediting a provider
  endpoint and a pool key that never served a single token.
- Usage accounting billed the dead key for tokens it never
  generated (usageEvent.keyId + monthly accumulator + lastUsedAt).

### Change

New architecture: `pick → try → mark health → retry next key →
cloud failover only when every key failed`.

- **`src/lib/senku/keyhealth.ts` (new)** — in-memory circuit
  breaker. Auth failure (401/403) = 1 strike → 10-minute quarantine.
  Transient failure (network cut / empty stream) = 2 strikes within
  5 min → 60-second cooldown. Any success clears all strikes.
- **`src/lib/senku/dispatch.ts` (new)** — orchestrator. Round-robins
  pooled keys via the router, retries the *next* key on typed
  failure, never duplicates already-streamed output (retries only
  when zero deltas were emitted), preserves the original coded
  errors for hard pool conditions (no-keys / limiter exhaustion).
- **`src/lib/senku/executor.ts`** — `tryProviderStream` now returns
  a typed `ProviderAttempt` (`auth` | `unreachable` | `empty` +
  `emitted` flag) instead of an opaque `null`. Removed the
  single-key `executeCompletion` (superseded by the dispatcher).
- **`src/lib/senku/router.ts`** — `pickKey(provider, excludeIds?)`:
  skips keys already attempted this turn, deprioritizes quarantined
  keys (probes them as last resort so a recovered key re-enters
  rotation automatically), new `"all-tried"` reason.
- **`src/lib/senku/gateway.ts`** — uses `dispatchCompletion`; bills
  `usageEvent.keyId` / monthly accumulator / `lastUsedAt` only to
  the key that actually served; `keyLabel` is null on cloud
  failover so persisted messages never claim a key they didn't use.
- **`src/app/api/v1/chat/completions/route.ts`** — same dispatch
  resilience; `senku.key` only reported when a pooled key served,
  `senku.failover: true` otherwise.

### Expected effect

- A dead key costs at most ONE failed round-trip (~0.5s) per turn,
  then is quarantined for 10 minutes — while healthy keys keep
  serving with native provider streaming (real SSE, lower latency).
- Metadata is honest: "1.8k tokens · APInex · Test key" when the
  pool served; "APInex · cloud failover" (no key claim) only when
  the endpoint is genuinely unreachable.
- Rotated keys self-heal: after the quarantine expires, the key is
  probed once and re-enters rotation if it works again.

### Verification (all passed)

- `bun run lint` clean.
- 3/3 unique gateway requests: `servedBy: provider`,
  `keyLabel: Test key` (before: every other request silently
  `zai-cloud` via the dead key).
- `/api/v1/chat/completions`: 200, `senku.key: "Test key"`, correct
  usage, 1.7s including compile.
- Browser golden path: message sent through the UI, reply rendered,
  metadata row reads "1.8k tokens | APInex · Test key", zero console
  or page errors, zero runtime errors in dev.log.
- Test data cleaned (6 test chats + 5 cache rows + 5 orphan usage
  events removed; the 5 seeded demo chats preserved).

### Known pre-existing flaws (NOT introduced this run, deferred)

- Mid-stream provider death after partial emission still re-emits
  the full answer from the cloud (client sees partial + full). The
  dispatcher now refuses to *retry keys* in that case (no
  duplication across keys), but a client-side restart marker would
  be needed to fully fix re-emission.
- Breaker state is in-memory: a server restart re-probes dead keys
  once. Acceptable for a single-process personal gateway.

---

## Run 2 — 2026-11-01: Thinking animation — faithful Claude Code GIF replication

**Rung:** 2 (Usability/UX — user-directed)

**Request:** "improve the thinking animation like this" + the Claude
Code thinking GIF (media.tenor.com/WvYJnr85GLoAAAAi). The user has
now pointed at this exact GIF twice — the earlier interpretation
(white sparkle, invented stretch/wobble) was not faithful enough.

### Diagnosis (measured, not guessed)

Downloaded the GIF and analyzed all 12 frames programmatically
(PIL: pixel moments, bounding boxes, per-frame durations):

- Loop period **1.00s** (not the 1.5s we had).
- **Pure scale pulse — no rotation, no wobble** (principal-axis
  angles identical across frames; the old animation invented
  rotate(±6°) and scale spikes to 1.26 that the reference doesn't
  have).
- Curve: dot (0.31) → swell to max (1.0) at the 40% mark → settle
  to plateau (0.81) → hold → collapse back to the dot. Growth
  segments decelerate (ease-out); shrink frames run 60-70ms.
- Mark color: **constant flat terracotta rgb(215,118,86)**
  (#D77656) — no color shifting.

### Change

- `globals.css` — `@keyframes senku-think` rewritten to the
  measured curve (0.31 → 1 @40% → 0.81 plateau @53-80% → collapse,
  per-segment easing), duration 1s. `.senku-thinking-sparkle` is
  now a 28px div filled **flat #D77656 via CSS mask** over
  `/senku-sparkle.png` — the same flat-fill rendering model as the
  reference mark (this deliberately supersedes the earlier
  "sparkle stays white" decision: the user re-pointed at the GIF,
  and the GIF's defining look IS the terracotta fill; implemented
  as a clean mask fill, not the muddy animated sepia filters that
  were removed back then).
- `ChatTimeline.tsx` — while thinking, the avatar `<Image>` swaps
  to the masked div (identical 28px box + mt-0.5, so no layout
  shift); `role="img"` + aria-label keep it accessible. Resting
  messages keep the original white sparkle PNG untouched.
- `prefers-reduced-motion` block still applies (static terracotta
  mark instead of pulse).

### Verification (all passed)

- Served CSS chunk confirmed live (contains #d77656, mask rule,
  and the new keyframes — minified as `scale(.31)`).
- Injected the mark in isolation and sampled its rendered width at
  60fps for 1.25s: plateau 22.7px (0.811), max 27.9px (0.996),
  collapse/swell/settle phases all match the design curve; 1.0s
  period confirmed.
- Real E2E: sent a search-enabled message through the UI;
  screenshots during the "Searching the web" phase show the
  terracotta mark pulsing at the avatar slot (23px → 17px → 23px
  across consecutive shots), avg color rgb(193,107,79) — hue
  correct, slightly darkened by mid-pulse antialiasing.
- After the reply finished, the resting avatar returned to the
  white sparkle (151 white px, 0 terracotta in the avatar region).
- Zero browser console/page errors; dev.log clean; lint clean.
- Cleaned up my own test chat; **kept the user's own
  "what is the latest gemini model" chat** (they used the preview
  mid-run — real user data stays).

---

## Run 3 — 2026-11-02: Truth pass — 10 user-reported fixes in one batch

**Rung:** 1 (Correctness) + 2 (Usability) — user-directed list
from live dogfooding.

### Diagnosis (user's list, confirmed in browser)

1. **Knowledge hallucination**: "latest Gemini model?" → invented
   "Gemini 2.0 Flash-Lite Preview 11.06, released November 6,
   2025" (fake version + date, stated as fact).
2. Thinking animation turned terracotta — user wants OUR white
   logo with the same GIF motion.
3. "Test key" (key label) shown under every reply.
4. Raw metadata dump per reply (Copy, Listen, tokens, APInex).
5. "APInex" superscript stacked on every model row.
6. Raw auto titles ("who r u?", "what today date month year and").
7. Clock shown multiple times (greeting + input-bar chip).
8. `free/glm-5.3` chip reads like a leaked env string.
9. "Temporary" toggle with no explanation of consequences.
10. Failed replies had no recovery actions.

### Change

- **`constants.ts`** — new `KNOWLEDGE_HONESTY` directive inside
  `BASE_SYSTEM_PROMPT`: for latest/newest/most-recent questions
  with NO search results, the model must not invent version
  numbers, dates or names; it names only what it is confident
  about, states the cutoff, and points at the Search toggle.
  (Search-on turns keep the existing grounding directive.)
- **`globals.css` + `ChatTimeline.tsx`** — thinking mark is the
  white sparkle `<Image>` again, animated by the same measured
  GIF curve (0.31 → 1 @40% → 0.81 plateau → collapse, 1.00s
  loop). The terracotta mask fill is gone; only the motion is
  borrowed from the reference.
- **`ChatTimeline.tsx`** — metadata row replaced by one quiet
  provenance line `GLM 5.3 · APInex pool · 2.3k tokens · cache:
  miss` (+ `cloud failover` variant). Copy/Listen are icon-only.
  `keyLabel` is never rendered in replies — "Test key" gone.
- **`globals.css`** — `.senku-hover-actions` / `.senku-meta-row`:
  Tailwind's `group-hover` variant only applies under
  `(hover: hover)` while `opacity-0` is unconditional — action
  rows were permanently invisible on touch devices (pre-existing
  for user-message actions). Touch now always sees a faint row;
  hover-capable ≥768px hides until group hover.
- **`lib/senku/models.ts` (new)** — `modelMeta`/`modelHint`:
  pretty names + tier + strength notes for known ids, tidy
  prettifier fallback for synced unknowns. InputBar chip now
  `GLM 5.3 [FREE] ⌄` (raw id on hover); picker shows one APINEX
  group header + `Gemini 3.8 Flash — Free · Fastest` rows.
  Command palette uses the same names.
- **`/api/chat/title` (new) + `store.ts`** — proper titles via a
  cheap cloud pass (thinking disabled, ≤600-char prompt, 2-5
  Title Case words). New chats keep the instant derived title,
  then the refined one patches the sidebar (refresh awaited
  first — no clobber race). Failure keeps the derived title.
- **`InputBar.tsx`** — input-bar live-clock chip removed; the
  greeting timestamp is the only clock.
- **`TopBar.tsx`** — Temporary toggle: explicit state ("Temporary
  · On", inverted pill, EyeOff icon) + Radix tooltip spelling out
  "won't be saved to history" BEFORE the flip; banner after.
- **`ChatTimeline.tsx` + `store.ts`** — failed replies get inline
  **Retry** and **Switch model** (next model in list; chip
  updates, retry uses the override via a new `TurnOptions.model`).
- **`seed.ts` + one-off DB patch** — the 5 demo chats had garbage
  titles AND content ("What Day And Your"); replaced with
  realistic demos ("Who Are You" ← "who r u?", "Current Date
  Question" ← "what today date month year and time?", …).
  User's real chats preserved; their raw titles backfilled
  through the new route.

### Bugs found & fixed during verification

- `retryLast` duplicated the user bubble when the failed turn
  never reached the server — `appendUserBubble` was conflated
  with `persistUser`. Decoupled via an explicit
  `TurnOptions.appendUserBubble` override.
- (Environment, not code) a `git stash` cycle mid-verification
  replaced the SQLite file under the running server →
  "readonly database". Dev-server restart cleared it.

### Verification (all passed)

- `bun run lint` clean (×3).
- **Knowledge honesty**: same question now answers "I cannot
  confirm the absolute latest Gemini release with certainty…
  please turn on web search (the globe button)" — no invented
  version/date.
- **Thinking mark**: VLM frame comparison — white color
  confirmed, size visibly pulsing (dot → full sparkle).
- **Provenance**: exact line rendered, per-model correct
  ("GLM 5.3 · … " vs "Gemini 3.8 Flash · …"); touch/`hover:none`
  shows faint (0.75), desktop hides until hover.
- **Title refinement live**: "whats the capital of japan? one
  line" → sidebar shows "Japan Capital City" seconds later;
  user's "what is the latest gemini model" → "Latest Gemini
  Model".
- **Retry · switch model**: network-abort simulation → error card
  → Retry recovers (single user bubble after the fix) → Switch
  model recovers on Gemini 3.8 Flash with the chip updated.
- **Temporary**: "Temporary · On" + explanatory banner.
- Mobile 390px: no horizontal overflow (scrollWidth == viewport).
- dev.log clean; browser console shows only the pre-existing
  Radix/React-19 hydration attribute warning (verified present
  before this run via a stashed-tree test — NOT introduced).
- Data hygiene: my 3 test chats deleted; the user's 2 real chats
  (incl. their mid-run "Latest AI Model Releases" search chat,
  which shows the search-grounded path working with fresh data)
  preserved untouched.

### Known pre-existing flaws (NOT introduced this run, deferred)

- Hydration attribute mismatch on Radix popovers (dev-tools "1
  issue" badge; cosmetic, React 19 + Radix `useId`).
- Mid-stream provider death after partial emission still
  re-emits the full answer from the cloud (Run 1 deferred item).

---

## Run 4 — 2026-11-02: Grounded-answer contract for the search pipeline

**Rung:** 1 (Correctness) — user-supplied spec: "Retrieved results
are inputs, not truth. The user's question is the contract."

### Diagnosis

Run 3 fixed knowledge honesty for NO-search turns. But when search
was ON, the model received three **undated, unranked** snippets and
a one-line directive ("ground your answer, cite domains"). That is
structurally unable to answer time-scoped questions honestly:

- No dates → the model cannot check whether a source is inside the
  requested scope; it silently converts publication dates into
  release dates (exactly the failure mode the spec forbids).
- No authority signal → a Reddit thread and an official changelog
  arrive with equal weight; forum posts were being cited as
  factual evidence.
- No protocol → nothing told the model to extract the question's
  time scope, classify the retrieval, or admit a PARTIAL/STALE
  result set instead of pad-and-confident.

Live probe confirmed the raw material was a minefield: for
"latest Gemini model" the engine returned an aggregator claiming
"3.8 Flash since September 2026", another saying "5 days ago",
and a stale Reddit thread about Gemini 2.0 — plus a Reddit post
claiming "on Gemini 5" with no date.

### Change

- **`src/lib/senku/grounding.ts` (new)** — the audit primitives:
  `extractDateHint()` (relative "5 days ago" > full date >
  month-year; yearless dates like "March 12" and ambiguous numeric
  dates deliberately return null — an unusable date must not be
  guessed) and `authorityTier()` (official > press/news >
  reference > blog > forum/social, unknown = "web"; ~45 curated
  hosts, deterministic).
- **`search.ts`** — every search path now captures a `dateHint`:
  the Z.ai cloud engine's own `date` field when present, else the
  first date stated in title/snippet; DDG paths extract from text.
  "Read more" noise stripped from snippets. `SearchSource` gained
  the optional `dateHint` (persisted with message sources,
  backward compatible).
- **`constants.ts` — `SEARCH_SYSTEM_DIRECTIVE` rewritten** into the
  full grounded-answer contract: (1) extract the question's
  TIME SCOPE / CLAIM TYPE / PRECISION; (2) audit each result for
  DATE MATCH, AUTHORITY (forum/social can NEVER support a factual
  claim, especially a negative one), RELEVANCE → classify FULL /
  PARTIAL / STALE; (3) answer with a date on every claim, never
  silently broaden or narrow scope, report knowledge boundaries on
  negative claims, and end with exactly one confidence label —
  [confirmed] / [partial] / [stale sources]. All six NEVER rules
  included verbatim.
- **`searchContextBlock(sources, now)`** — each result line now
  carries `host (tier) · dated: <hint|none stated>`, and the
  header carries the retrieval clock plus the rule that a stated
  date is a publication date, NEVER a release date, and
  "none stated" must stay none — do not guess.
- **`ChatTimeline.tsx`** — the sources card chips now show
  `host · dated: <hint>` so the user sees the same dating the
  model reasoned from.

### Verification (all passed)

- `bun run lint` clean.
- Unit probe: relative > full > month-year priority correct;
  "March 12" (no year) → null; bare "2026" → null;
  21/09/2026 → null (ambiguous order); all six authority tiers
  classified correctly (reddit→forum/social, blog.google→official,
  theverge→press/news, wikipedia→reference, medium→blog,
  unknown→web).
- **Live pipeline, 3 scenarios via /api/chat/send (search on,
  temporary):**
  - Factual "latest Gemini model": dated answer ("released
    September 2026"), conflicting sources reconciled by date,
    boundary stated ("newer release cannot be ruled out"),
    `Confidence: [partial]`.
  - **Negative claim** "has Google released Gemini 5 yet?": cites
    the official changelog (dated), and **explicitly refuses the
    undated Reddit post as evidence** ("a forum post with no date
    and no official backing, so it cannot confirm a release") —
    the authority rule enforced verbatim. [partial] label.
  - Month scope "any big AI model releases this month?": answers
    within November, names the most recent dated source, dates
    every release, does NOT invent dates for the two undated
    trackers. [partial] label.
- Browser golden path (Temporary + Search on): answer rendered
  with dates + label; sources card shows all three
  `· dated:` chips; zero console/page errors; dev.log clean;
  no horizontal overflow at 390px.
- All tests ran with `temporary: true` — no test data created,
  nothing to clean.

### Known pre-existing flaws (NOT introduced this run, deferred)

- The confidence label format drifts slightly by model (one run
  appended per-source labels before the whole-answer one); the
  whole-answer label was always present. Acceptable model
  variance, not a pipeline defect.
- `extractDateHint` skips numeric dates (21/09/2026) as ambiguous —
  honest "none stated" beats a wrong day/month order guess.
- Hydration attribute mismatch on Radix popovers (pre-existing).
- Mid-stream provider death after partial emission (Run 1
  deferred item).

---

## Run 5 — 2026-11-02: Restart marker — no more duplicated answers on mid-stream provider death

**Rung:** 1 (TRUST) — the flaw logged as deferred in BOTH Run 1
and Run 3, now fixed at the protocol level.

*Innovation-cadence note: this is run #5 and the mandate asks for
a bold addition by now — but a known, twice-logged data-corruption
bug on the highest rung outranks a feature. Run 6 is committed to
the bold addition.*

### Diagnosis

When a pooled provider died MID-STREAM after partial text had
already streamed to the user, the dispatcher correctly refused to
retry other keys (that would duplicate too) but still failed over
to the Z.ai cloud — which re-generates and re-emits the FULL
answer through the same delta channel. The client had already
rendered the partial, so the user saw:

```
[partial answer from the dead provider][full answer from the cloud]
```

…a corrupted, duplicated message that also got persisted verbatim.
Rare (needs a mid-stream death) but exactly the kind of thing that
destroys trust in a gateway.

Live reproduction: a mock OpenAI provider (node:http) that streams
three SSE deltas then `socket.destroy()`s mid-response. Pre-fix
event stream: `delta × 3 → [cloud re-emits everything] → done`
with the client text = partial + full.

(Simulation subtlety: Bun's `ReadableStream.error()` from a
`Bun.serve` handler closes the connection cleanly from the
client's perspective — the fetch completes "successfully". A real
death needs an actual TCP reset: node:http + `res.socket.destroy()`.
Also learned: the first accidental clean-close run cached a
mock-prefixed answer for 24h — purged.)

### Change

New internal SSE event: **`restart`** — fired by the dispatcher at
the exact moment the cloud is about to re-generate AFTER partial
emission. Clients must clear their accumulated text on it.

- **`dispatch.ts`** — `DispatchParams.onRestart?`; tracks
  `emittedBeforeCloud` (set only on the `attempt.emitted` break —
  the only path where deltas preceded the cloud) and calls
  `onRestart()` before `zaiCloudExec`.
- **`gateway.ts`** — `TurnEvent` union gains `"restart"`;
  `runChatTurn` wires `onRestart → emit({type: "restart"})`.
- **`store.ts`** — `restart` handler: `assistantContent = ""` +
  `phase: "thinking"` so the UI shows the thinking animation
  during the cloud hand-off gap instead of a blank bubble; the
  next delta resets the phase. Final `done.content` (cloud full
  text) then matches the rendered text exactly.
- The v1 OpenAI-compatible route needed NO change: it is
  non-streaming (`onDelta` undefined), so failover there already
  yields one clean JSON — duplication is structurally impossible.

### Verification (all passed)

- `bun run lint` clean.
- **Failure E2E** (mock provider streaming 3 deltas then TCP
  reset, via /api/chat/send): `delta × 3 → restart → cloud deltas
  → done servedBy=zai-cloud`; restart-honoring client text =
  cloud answer ONLY; `done.content === client text`; `key: null`
  (no key billed for the cloud's work).
- **Browser golden path** (mock provider active in the UI): sent a
  message, watched partial → thinking → single clean answer;
  rendered text contains ZERO "MOCK-PARTIAL" remnants; provenance
  row honestly reads "… · MockFail · cloud failover · 290 tokens ·
  cache: miss"; 0 console/page errors.
- **No regressions**: mock provider deleted (usage events + cache
  rows purged, key cascade-dropped), APInex re-activated; sanity
  turn shows `meta, delta, done` — NO restart on the healthy
  path, servedBy provider, honest key billing.
- dev.log clean.

### Known pre-existing flaws (NOT introduced this run, deferred)

- If the CLOUD also fails after a mid-stream provider death, the
  error handler wipes the bubble to an error card (the partial is
  lost). Rare double-failure; acceptable.
- Hydration attribute mismatch on Radix popovers (pre-existing).
- Confidence-label format drift across models (Run 4 note).

---

## Run 6 — 2026-11-02: "keep" honored — the grounded-answer contract made deterministic + visible

**Rung:** 1 (TRUST/contract integrity) + 2 (CLARITY). User's
directive: "**keep**" the grounded-answer spec — meaning the
contract is a standing product requirement, not a one-off.

### Diagnosis

Re-audited the shipped contract against the spec line-by-line.
Directive-level conformance was verified probabilistic, not
guaranteed: across live samples, the confidence label was (a)
sometimes attached to INDIVIDUAL sources ("lorka.ai — [confirmed]")
instead of the whole answer, and (b) in one of three fresh runs
OMITTED entirely. A contract that holds 2/3 of the time isn't
kept. And when the label DID appear, it rendered as raw bracket
text "[partial]" inside the markdown — a spec output treated as
prose, not as a product element.

### Change

- **`constants.ts`** — directive tightened: "End the message with
  EXACTLY ONE confidence label on the whole answer — on its own
  final line with nothing else on that line. Never attach
  confidence labels to individual sources or inside inline
  sentences."
- **`grounding.ts`** — the label parser is now canonical and
  shared: `labelOfLine()` / `confidenceOf()` (accepts legacy
  variants like "Confidence: [partial]" for older messages; the
  pipeline and the UI use ONE definition).
- **`executor.ts`** — `appendConfidenceLabel()`: when a search
  answer lacks the label, ONE cheap cloud pass (thinking disabled,
  last 1500 chars, strict one-line output) classifies the
  retrieval as [confirmed]/[partial]/[stale sources] and appends
  it. Never fabricates (unparseable response → unchanged) and is
  best-effort on cloud failure.
- **`gateway.ts`** — contract enforcement on BOTH paths: fresh
  dispatch results AND cache hits (older cache entries predate the
  rule). Cache fills AFTER enforcement, so corrected answers are
  reused corrected. Cost: one tiny pass only on the minority of
  turns where the model omits the label.
- **`ChatTimeline.tsx`** — the trailing label is extracted and
  rendered as a **confidence badge** (colored dot + lowercase
  label + "· source confidence" hint: emerald=confirmed,
  amber=partial, rose=stale sources); the raw bracket line is
  removed from the displayed markdown only — Copy and
  read-aloud keep the faithful raw text. While streaming, the
  half-written final line still renders raw (no false positives).

### Verification (all passed)

- `bun run lint` clean.
- Extractor unit probes 8/8: plain / "Confidence:" prefix / bold /
  trailing-period variants match; mid-sentence brackets
  ("I am [confirmed] right now.") and half-streamed labels do NOT.
- **Live conformance 3/3** (fresh cache-miss runs, search on):
  every answer ends with exactly one final-line label; zero
  per-source labels.
- Corrective pass unit probe: label-less answer in → classified
  `[partial]` appended exactly once.
- Browser golden path: dated answer with cited official sources,
  sources card chips carry `dated:` hints, rose "stale sources ·
  source confidence" badge rendered, NO raw bracket line in the
  body, 0 console/page errors, no horizontal overflow at 390px.
- User's real chats (visible in sidebar) untouched; test ran in a
  Temporary chat.

### Known pre-existing flaws (NOT introduced this run, deferred)

- The corrective pass classifies from the answer text alone; if
  the answer itself misstates its sources, the label inherits
  that. Acceptable — the directive already governs the answer.
- Hydration attribute mismatch on Radix popovers (pre-existing).

---

## Run 7 — 2026-11-02: DUEL MODE — two models race one question, you keep the winner

**Rung:** differentiator (the bold addition owed since the Run 5
note; Run 6 was preempted by the user's "keep" directive).

### Competitor scan (web, 2026-11-02)

- **ChatGPT / Claude / Gemini**: one model per turn in the consumer
  chat. Switching models = regenerate; no same-turn comparison, no
  keeping the loser for reference. Users complain about manually
  pasting prompts into 4 apps (r/PromptEngineering: "Anyone else
  tired of comparing AI models manually?").
- **LMArena**: side-by-side battles exist — but anonymous models,
  throwaway chats, no history, no provenance, no search grounding,
  not your gateway. A benchmarking toy, not a daily driver.
- **Nobody** does it inside your own conversation with your own
  history, shared grounded search, per-lane provenance, and
  winner-picks-into-the-chat. Only a pooled multi-model gateway
  architecturally can.

### Change

**One tap sends the question to two models simultaneously. Both
stream live side by side; you click Keep on the better one; the
loser stays as a collapsed runner-up reference under the answer.**

- **`gateway.ts` — `runDuelTurn()`**: shared web search (both lanes
  reason from the SAME retrieval), shared chat + user-message
  persistence, then two independent lanes racing in parallel —
  per-lane exact-match cache, health-aware key dispatch, restart
  events scoped to the lane that died, grounded-contract
  enforcement, usage accounting and cache fill. Both lanes billed
  honestly for what they served. One lane failing never kills the
  other (degrades to a single answer); both failing = the normal
  error card.
- **SSE protocol (backward compatible)**: `duel_start {a,b}` ·
  `delta/restart` gain an optional `lane: "a"|"b"` · `lane_done`
  per lane with final stats · `done` carries the full `duel`
  payload (top-level fields mirror lane A for simple consumers).
- **`POST /api/chat/duel/pick` (new)**: persists the WINNING lane
  as the assistant message + the loser as `Message.altContent/
  altModel` (new nullable columns — no data loss). Provenance is
  preserved exactly as the lane reported it; usage accounting
  already happened at generation time. The pick only decides what
  the conversation remembers.
- **`models.ts`**: `modelFamily()` + `autoChallenger()` — the
  default opponent prefers a DIFFERENT model family (GLM vs Kimi,
  not GLM vs GLM).
- **`store.ts`**: `duelEnabled`/`challenger` state with revalidation
  on model-list changes; lane-aware `streamTurn`; `pickDuelWinner`
  (instant local commit, then persist; server id reconciled);
  auto-pick guards — a surviving lane is auto-kept when the other
  dies, and an unpicked duel auto-keeps lane A before the next
  send (history always has one voice).
- **UI**: amber `Swords` Duel pill beside Search (disabled when the
  provider has <2 models) + "vs <model>" challenger picker chip;
  entries in the "+" menu and the ⌘K palette. Duel turn renders as
  two lane cards (side-by-side ≥md, stacked on mobile) with per-lane
  thinking shimmer, streaming caret, cache badge, confidence badge
  and a Keep button (unlocks when the turn completes). After the
  pick: normal answer + "Runner-up · <model>" disclosure. Input
  pill row scrolls horizontally on narrow screens (no overflow).

**Also fixed (root cause found BY this feature):**
`liveContextBlockHourStable()` formatted the time with
`liveTime(false)` = "HH:MM", embedding the MINUTE into every cache
key — the 24h response cache could only hit within the same minute,
despite the docblock promising hour stability. Now formats the hour
only ("hour 22:00"); same-hour repeats hit the cache again (normal
AND duel lanes).

### Verification (all passed)

- `bun run lint` clean.
- **API E2E (temporary duel)**: `meta → duel_start → delta
  (lane-tagged, interleaved) → lane_done ×2 (distinct per-lane
  tokens: 568 vs 559 raw) → done` with the full `duel` payload.
- **Per-lane cache**: identical duel re-run 70s later → both lanes
  `cached=true servedBy=cache tokens=0`; normal send of the same
  prompt also hits (the hour-stability fix verified across a minute
  boundary).
- **Persisted lifecycle**: duel in a saved chat → pick lane B →
  `GET /api/chats/[id]` shows winner (model, keyLabel, tokens) +
  `altContent`/`altModel` runner-up; chat model updated to the
  winner.
- **Guards**: same-model duel → "Duel needs two different models";
  unknown challenger → "Both duel models must be available on the
  active provider". Normal (non-duel) send regression: untouched
  event shape, cache hit.
- **Browser golden path**: armed Duel (auto-challenger picked
  Gemini 3.8 Flash — different family from GLM), sent "why is the
  sky blue?", watched both lanes stream, kept lane B — winner became
  the canonical answer with its own provenance ("Gemini 3.8 Flash ·
  APInex pool · 2.3k tokens"), runner-up disclosure expanded to the
  full GLM answer. Second duel on mobile 390px: lanes stacked
  (318px cards), no horizontal overflow, pick worked. Persisted E2E
  chat re-opened after reload — winner + runner-up render from DB.
  0 console/page errors throughout; dev.log clean. Test chat
  deleted; user's 9 real chats untouched; duels tested in
  Temporary chats.

### Deferred / known trade-offs

- A stopped duel keeps both partial lanes pickable — picking a
  partial persists a partial (same semantics as stopping a normal
  turn).
- `retryLast` on a both-lanes-failed duel re-sends as a NORMAL
  turn (documented degradation).
- Hydration attribute mismatch on Radix popovers (pre-existing).
- The mid-stream restart event is lane-scoped and honored per lane;
  the rare double-failure (provider AND cloud) still loses the
  partial (Run 5 note).

---

## Run 8 — 2026-11-02: EFFORT DIAL — fast / medium / deep, with pooled-engine routing + deep research

**Rung:** differentiator-grade UX (the user's direct request: *"what
about adding deep search, and thinking mode and fast and medium"*).
One dial, three positions; the middle one changes nothing.

### Competitor scan (web + product knowledge, 2026-11-02)

- **ChatGPT**: the fast/quality toggle switches between two fixed
  models; thinking levels (instant/standard/extensive) and Deep
  Research are all locked to one vendor's backend.
- **Claude**: extended thinking + low/medium/high effort — one
  model, one backend.
- **Gemini**: per-model thinking budget; Deep Research plans then
  iterates — single-vendor retrieval, no per-source date/authority
  audit surfaced.
- **None of the three** can make one dial pick a DIFFERENT ENGINE
  from a pool per effort level, because none of them is a pooled
  multi-model gateway. That asymmetry is this feature's core.

### Change

**`Fast ⚡ / Medium ✦ / Deep 🧠` — a dial in the input bar. Medium
is byte-identical to before. Fast and Deep each do three things a
single-brand chat cannot:**

1. **Route across the pool** (`models.ts → effortModel()`): fast →
   the fastest engine the active provider offers (Gemini 3.8 Flash
   on APInex), deep → the strongest (Qwen 3.8 Max), medium → the
   user's selection, untouched. The popover shows exactly which
   engine each level maps to (`→ Gemini 3.8 Flash`) BEFORE the
   user picks — routing is transparent, never surprising, and the
   provenance row always reports the engine that actually served.
   Dial routing prefers the `free/*` tier when the provider has one
   (metered pool-tier ids can 402 at runtime — see root-cause fix
   below); providers without a free tier (OxionAI) dial over their
   full list.
2. **Effort-shaped prompts** (`constants.ts`): FAST_SYSTEM_ADDON
   (fewest words that fully answer), DEEP_RESEARCH_ADDON (weigh ALL
   evidence: agreements are evidence, conflicts are named per side,
   unanswered stays unanswered; structure = answer → evidence →
   disagreements/gaps; the grounded contract still applies in
   full), DEEP_THINKING_ADDON (deep without search = think-first
   mode on the strongest engine). Medium appends NOTHING — the
   system prompt stays byte-identical, so the 24h cache still hits
   pre-dial entries; fast/deep additions namespace the cache key
   per level for free.
3. **Deep research pipeline** (`search.ts → deepSearchDetailed()`):
   plan (one cheap cloud pass decomposes the question into 2-3
   angle queries) → round 1 searches the question verbatim →
   planned angles in parallel → merged, URL-deduped, capped at 8
   sources. Every stage label streams live to the client
   (`search_status {detail}` → "Deep research — planning queries",
   "Searching — …", "Searching 3 more angles — …"). All queries
   reuse the layered DDG/cloud failover + the 30-min memo.
   Deep effort also enables real thinking on the Z.ai cloud
   failover path (`executor.zaiCloudExec thinking:"enabled"` via
   `dispatch.thinking`); provider endpoints are unchanged (their
   rigor comes from the directive + the retrieval).

**Also shipped:** `EffortLevel` shared type; SSE `meta`/`done` carry
`effort` (backward compatible); `Message.effort` column (persisted,
shown as "Fast mode"/"Deep research" in the provenance line);
sources card auto-labels ">3 results" as **DEEP RESEARCH · N
SOURCES** (medium is structurally capped at 3) with a scrollable
list; ⌘K palette gains three Effort commands; duel turns honor
effort for the SHARED retrieval + lane thinking but never override
the user-chosen racers; `meta.model` now reconciles the client's
model chip when the dial routes elsewhere.

**Root-cause fixes found BY this feature (both verified live):**
- `ensureSeed()`'s upsert **update** branch overwrote
  `provider.models` back to the constants default on every module
  reload / process restart — a synced model list silently died with
  the process. The update branch no longer touches `models`
  (runtime state belongs to Sync).
- The seeded APInex list contained `free/claude-4.6-opus` — the
  endpoint 404s that id (the real id is `free/claude-opus-4.6`, and
  it 402s without a subscription anyway). The default list is now
  the five endpoint-verified free-tier models (all probed 200);
  `KNOWN` metadata updated to match.

### Verification (all passed)

- `bun run lint` clean.
- **Medium regression**: SSE event shape unchanged (`meta → delta* →
  done`), model = user's selection, provider-served, cache hit on
  repeat within the hour.
- **Fast**: `meta.model` = `free/gemini-3.8-flash` (routed, not
  selected); answer brief and direct; browser turn shows
  "Fast mode · Gemini 3.8 Flash · APInex pool · 5.9k tokens".
- **Deep + search** (API): stage labels streamed (planning →
  verbatim → 3 angles), 8 merged sources, `meta.model` =
  `free/qwen-3.8-max`, **servedBy=provider** (after the free-pool
  fix — previously every deep turn wasted a 404/402 round-trip and
  fell to the cloud), answer structured as Evidence /
  Disagreements, honest `[stale sources]` / `[partial]` /
  `[confirmed]` labels across runs.
- **Cache isolation**: same prompt deep×2 → second run
  `cached=true`; medium on the same prompt → miss (different
  system prompt + model = different key).
- **Persistence**: saved chat records `effort` on assistant rows
  (fast → "fast" + routed model + serving key; deep → "deep").
- **Browser golden path**: effort popover renders three options with
  per-level engine previews; 0 page/console errors; no horizontal
  overflow at 390px. **The user live-tested Deep themselves during
  the run** — their turn rendered the "DEEP RESEARCH · 8 SOURCES"
  card, a knowledge-boundary-honest answer ("As of my most recent
  sources (late October 2026), I cannot confirm November 2026
  releases…"), a `partial` confidence badge, and the provenance
  "Deep research · Qwen 3.8 Max · APInex pool · 8.7k tokens".
- Cleanup: 5 test chats + 67 test cache rows purged; the user's 10
  real chats untouched; dev.log clean.

### Deferred / known trade-offs

- A 402/404 model-level failure still lands as a "transient" strike
  on the key (it isn't the key's fault) — a future run could type
  model-level failures and skip the strike. The dial's free-pool
  preference already avoids the common case.
- Deep-search sources arrive as one batch when the pipeline
  finishes (stage labels carry the live narrative meanwhile);
  progressive per-round source streaming is a possible polish.
- Deep on a provider without a reasoning-tier model silently
  degrades to directive-only rigor (no engine swap) — acceptable,
  provenance stays honest.
- Hydration attribute mismatch on Radix popovers (pre-existing).

---

## Run 9 — 2026-11-02: REAL FILE UNDERSTANDING — attachments the model actually reads

**Rung:** 1 (Trust: the old "attachment" feature was a lie) closing
the worst OPEN competitor gap (all three), with a pooled-gateway
twist none of them can copy.

### Diagnosis (OBSERVE)

The "+" → "Upload from computer" flow inserted `[Attached:
filename]` as PLAIN TEXT into the prompt. The model never saw a
byte of file content — so it either ignored the "attachment" or
hallucinated content from the filename. For a gateway whose whole
pitch is honesty (grounded answers, visible provenance, honest
billing), a feature that pretends to read files was the most
trust-damaging thing in the product — and the #1 open gap
(Claude/ChatGPT/Gemini all read files for real).

### Competitor scan (product knowledge; no web-search tool in this
environment — noted, consistent with prior runs when needed)

- **ChatGPT**: real content understanding for docs/images/code;
  per-file chips with a "Reading…" state. What was extracted is
  INVISIBLE — you can't see how much was read or whether it was
  truncated. One vendor's backend.
- **Claude**: docs + images extracted into context; chips in the
  composer; extraction equally opaque. One backend.
- **Gemini**: file uploads with document understanding (up to 20);
  same opacity. One backend.
- **None of them** can show per-file extraction provenance
  (chars read, truncation, method) — their clients don't know, and
  none can route extraction across engines. Only a gateway that
  owns the pipeline can.

### Change

**Files are now READ at pick time. The chip tells you exactly what
the model will receive; unreadable files are NOT sent.**

1. **`src/lib/senku/attachments.ts` (new)** — three extraction
   engines, honest records (`kind`, `method`, `chars`,
   `totalChars`, `truncated`, `extract`):
   - **text** — UTF-8 decode for plain text/markdown/code/csv/json
     (≈70 extensions + text/* mimes), binary sanity gate (control-
     char ratio) so executables never decode as "text".
   - **pdf** — text-layer extraction via `unpdf` (serverless
     pdf.js build). Scanned/image-only PDFs fail HONESTLY: "No
     text layer found" → not sent. **New dependency: `unpdf@2.1.0`
     — justification: pure-JS, zero-config, serverless-safe PDF
     text extraction; the only alternative was shipping pdf.js by
     hand.**
   - **image** — a pooled VISION pass (z-ai-web-dev-sdk
     `createVision`, base64 data URI): transcribes ALL visible
     text verbatim (OCR with layout) + a 1–3 sentence visual
     description under a `--- VISUAL ---` marker. None of the
     three incumbents shows you the vision pass it ran.
   - Caps with in-band honesty notes: 20k chars/file (text/pdf),
     4k/file (vision), 60k/message, 5 files, 10 MB/file (6 MB
     images). Truncation cuts on line boundaries and SAYS so.
   - `sanitizeAttachments()` rebuilds every inbound record
     field-by-field — the send route never trusts client JSON.
2. **`POST /api/attachments/extract` (new)** — multipart, up to 5
   files; returns per-file records + typed errors. Extraction runs
   the moment a file is picked, so the composer chip shows what was
   read BEFORE sending.
3. **Prompt injection (gateway.ts)** — `attachmentContextBlock()`
   appends a clearly-delimited block to the CURRENT user turn
   (attachments first, then the search block), carrying its own
   instructions: user's own material (authoritative, unlike web
   results), refer by name, respect truncation markers, say when
   an answer isn't in the files. **The system prompt is untouched —
   turns without attachments stay byte-identical (cache included);
   attachment turns naturally namespace their cache key.**
   `expandHistory()` re-appends blocks for PRIOR user turns, so
   follow-up questions ("what was the revenue figure?") still see
   the file — exactly like the incumbents. Duel turns share the
   same block across both lanes.
4. **Persistence** — new nullable `Message.attachments` column
   (JSON records, extracts included) so reloads and follow-ups
   rebuild context from the DB; `/api/chats/[id]` and
   `/api/chat/truncate` return it parsed.
5. **UI** —
   - Composer: one chip per staged file with live status — spinner
     "reading…", then `✓ read · 180 chars` / `👁 vision pass · 435
     chars` (amber "(truncated)" when cut), or a red error line
     ending "— not sent". Send is disabled while anything is still
     extracting; error chips are excluded from the send (never
     pretend). Staged files clear on new chat / chat switch /
     temporary toggle.
   - Timeline: sent user messages carry compact in-bubble chips
     (icon · name · chars, ✂ marker + tooltip for truncation)
     showing what the model received.
   - "+" menu item now says what's supported: "Text · code · PDF ·
     image — read before sending".
6. **retryLast / editMessage** — the retried or edited turn
   re-sends the same files (attachments travel with the user
   message, not the text).

### Verification (all passed)

- `bun run lint` clean.
- **Extract API**: text file → 180-char record; reportlab PDF →
  full text-layer record (contract ID, dates, values); PIL
  whiteboard PNG → VLM record with PERFECT OCR ("WHITEBOARD —
  Sprint 42 / Blockers: payment API sandbox / Owner: Yasmine /
  Due: Friday 17:00") + visual description; random `.bin` → honest
  "Unsupported file type — not sent".
- **Turn E2E (API, temporary)**: "secret codename + revenue in my
  attached report" → "OBSIDIAN-9 … $1,284,000" (both only in the
  file), servedBy=provider. **Follow-up with the file only in
  HISTORY** → "March 14, 2027" — context persists across turns.
- **Duel with attachment**: both lanes (GLM 5.3 + Gemini 3.8
  Flash) answered "OBSIDIAN-9" from the shared file.
- **Saved-chat persistence**: user row stores the record
  (`kind: pdf, method: text-layer, chars: 260`), assistant answers
  "ACX", `GET /api/chats/[id]` returns it parsed. (Found + fixed a
  stale-Prisma-client issue after the schema push — dev server
  restart required.)
- **Regression**: no-attachment turns byte-identical —
  `meta → delta → done`, model = selection, and the SAME prompt
  twice → second run `cached=true` (cache unpolluted).
- **Browser golden path (Temporary chat)**: uploaded report.txt +
  binary.bin → chips "read · 180 chars" / "Unsupported … — not
  sent"; send gated on extraction; answer "Secret codename:
  OBSIDIAN-9; Headcount: 47 engineers."; then whiteboard.png →
  "vision pass · 435 chars" → "Owner: Yasmine; Due: Friday 17:00
  (Sprint 42)". Sent bubbles carry compact chips. 0 console/page
  errors; no horizontal overflow at 390px; mobile + desktop
  screenshots VLM-inspected (chips render, layout intact).
- Cleanup: 2 test chats + 7 test cache rows purged; the user's 10
  real chats untouched; dev.log clean.

### Deferred / known trade-offs

- Scanned/image-only PDFs are rejected honestly rather than
  page-rendered through vision — a future run could rasterize
  pages and OCR them via the vision engine.
- No drag-and-drop onto the composer yet (picker only).
- Attachment extracts count toward prompt tokens honestly but get
  no special cache treatment — repeated questions re-send the
  extract (a future run could cache extraction results by file
  hash, a pooled-gateway-only trick).
- Hydration attribute mismatch on Radix popovers (pre-existing).

### Ops note (for future runs)

The sandbox reaps background processes at tool-call boundaries —
`nohup`/`setsid` alone do NOT survive. The dev server must be
started with a double-fork orphan so it reparents to init DURING
the call: `( setsid bun run dev < /dev/null > /dev/null 2>&1 & )`.
After any `prisma db push`, the dev server must be restarted to
pick up the regenerated client.

---

## Run 10 — 2026-11-02: LIVE WORD-BY-WORD TYPING ON EVERY PATH — the cloud failover actually streams

**Rung:** 2 (Clarity/UX — the user's direct report: *"dont make the
response appear single time, make the respons typed live time word
per word, so it woudlnt be that the model take a lot of time"*).

### Diagnosis (OBSERVE — live-timed, not assumed)

Timestamped a real turn through the pipeline, then audited serving
history:

- **Provider path streams natively** — 35 fine-grained deltas over
  215 ms. Not the problem.
- **The user's own turns tonight (20:38–20:45, model
  `free/claude-4.6-opus`) were ALL `keyLabel: null`** — every one
  fell to the Z.ai cloud failover, where `zaiCloudExec` awaited the
  ENTIRE completion (non-streaming SDK call; worse with deep
  thinking enabled) and then fake-dumped 48-char chunks at 6 ms
  (~8k chars/sec = visually one shot). Long silent wait → answer
  appears single time. Exactly the complaint.
- **Cache hits emitted the whole answer as ONE delta** — on search
  turns the retrieval runs first (seconds), then the full cached
  answer pops at once. Also "single time".
- Probes confirmed the fix was available: the SDK with
  `stream: true` returns the runtime's REAL SSE stream (OpenAI
  chunk shape, word-level deltas; works with thinking enabled —
  151 progressive chunks measured).

### Competitor scan

ChatGPT / Claude / Gemini stream token-by-token on every answer,
including thinking turns — a turn that sits silent then dumps is
read as "the model is slow". Streaming is table stakes; we had it
on the provider path only. No gap-list change (parity restored on
our own secondary paths).

### Change

1. **`executor.ts → zaiCloudExec` rewritten to true streaming** —
   requests `stream: true`, parses the SSE ReadableStream with the
   same loop shape as `tryProviderStream`, and emits every
   `delta.content` to the client THE MOMENT the runtime generates
   it. If a runtime ever ignores `stream` and returns JSON, the
   full text still types out progressively instead of dumping.
   Usage is captured from chunks when present, estimated otherwise.
   Covers normal turns, BOTH duel lanes, and deep+thinking cloud
   turns; the `/api/v1` passthrough contract is unchanged
   (`ExecResult` still resolves with full content).
2. **`executor.ts → revealWords()` (new, exported)** — progressive
   reveal for content that arrives fully-formed: word-boundary
   chunks (byte-exact reassembly), ~1 word per 6 ms tick, batching
   on long answers to cap the reveal at ≈2 s.
3. **`gateway.ts` cache-hit branches (normal turn + duel lane)** —
   cached answers now type out live via `revealWords` instead of
   one mega-delta. Provenance still says "cache · 0 tokens" — the
   reveal is presentation, never a claim about where it came from.

### Verification (all passed)

- `bun run lint` clean; `tsc --noEmit` error count identical
  before/after (14 pre-existing, 0 new).
- **Cloud path (real)**: `free/claude-4.6-opus` → provider 404 →
  cloud: 71 word-by-word deltas, typing window 453 ms,
  `servedBy=zai-cloud` — previously a silent full-generation wait
  followed by a single-shot dump.
- **Cache path (real)**: same prompt ×2 → second turn `cached=true`
  with 15 word deltas ("The ", "quick ", "brown "…) instead of 1;
  test rows purged after.
- **Provider regression**: untouched — 30 progressive deltas,
  provider-served, same event shape.
- **Browser golden path (Temporary chat)**: in-page 100 ms DOM
  sampler recorded the answer growing 43 → 49 → 248 → 294 → 422 →
  435 chars with the ▍ caret blinking during, then done;
  provenance "GLM 5.3 · APInex pool · 3.1k tokens · cache: miss";
  0 page/console errors; screenshot VLM-inspected — poem complete,
  layout intact, no glitches.
- Cleanup: 3 test cache rows purged; 0 temporary chats persisted;
  the user's 10 real chats untouched; dev.log clean.

### Deferred / known trade-offs

- The confidence-label corrective pass (search turns whose answer
  lacks the label) still runs AFTER the answer streams — a short
  trailing pause before `done` (pre-existing; the label appends at
  the very end).
- Cloud stream chunks carry no usage in practice → cloud-failover
  turns bill estimated tokens (~4 chars/token) unless a usage chunk
  appears.
- `revealWords` pacing on cache hits is presentation-only and
  capped (~2 s); it never alters content, provenance, or billing.
- Hydration attribute mismatch on Radix popovers (pre-existing).

---

## Run 11 — 2026-11-02: SELF-HEALING DATABASE — "attempt to write a readonly database" can never kill a turn again

**Rung:** 1 (Trust — the user's screenshot showed a turn dying
mid-pipeline with a raw Prisma ConnectorError dump:
`SqliteError { extended_code: 1032, "attempt to write a readonly
database" }` on `db.message.create`).

### Diagnosis (OBSERVE — reproduced live, then root-caused by experiment)

- **Reproduced immediately**: the same POST through the running dev
  server failed with the exact error, while a **fresh process wrote
  fine** — file `z:z 664`, 7.3G free, rw mount. The DISK was healthy;
  the SERVER's Prisma pool was poisoned.
- **Root cause chain**: `db/custom.db` is **tracked by git** (runtime
  state committed by design so session snapshots carry user data).
  Session-snapshot automation commits every ~15 min, and Run 10's
  verification used `git stash`/`git stash pop` (22:45 — file mtime
  matches) — git rewrites the tracked file, replacing it under the
  running server.
- **Controlled experiments (`scripts/exp-readonly.ts`) proved the
  exact failure mechanics**:
  - E1: chmod'ing the file 444 under an ALREADY-OPEN read-write
    connection changes nothing (kernel checks at open).
  - E2: a connection OPENED while the file is unwritable →
    `SqliteError 8 "attempt to write a readonly database"` — and it
    **stays broken forever after the file becomes writable again**
    (a read-only SQLite connection never upgrades).
  - E3: replacing the file under a live connection (the git
    stash/pop scenario) → **`SqliteError 1032` — byte-identical to
    the user's screenshot** (journal/main-db inode mismatch on
    write).
  - Heal for both: `$disconnect()` + reopen by path.

### Change

**`src/lib/db.ts` — the exported client is now a self-healing
wrapper** (Prisma `$extends` query extension over the raw client):

- Every model operation that fails with "attempt to write a readonly
  database" (covers extended codes 8 AND 1032) triggers a
  **single-flight pool heal** (`$disconnect`, serialized so
  concurrent lanes heal once), then **retries exactly once** — the
  retry reopens the file by PATH and picks up whatever is on disk.
- Retry safety is deliberate: a read-only write was REJECTED without
  side effects, so retrying cannot double-insert. Ambiguous
  connection-closed errors are NOT retried (the write may have
  landed) — they surface honestly.
- One `console.warn` per heal for observability.
- The DB file stays **tracked** (untracking it would lose all user
  chats/keys if the sandbox is ever rebuilt from a snapshot commit —
  data loss is strictly worse than a self-healed hiccup).

### Verification (all passed)

- **The exact failing request** (non-temporary turn) → full success:
  chat + both messages persisted, provider-served.
- **Live poisoning of the real server**: swapped the DB file under
  the running dev server (E3-style, new inode), then sent a turn →
  heal logged, turn completed **fully transparently**: client
  received the complete `meta → delta×5 → done` sequence, both
  messages persisted with correct content, billing event recorded.
  Second poisoning identical.
- Post-heal turns, reads, and the browser golden path all clean:
  saved chat renders from DB with provenance; Temporary UI turn
  answered with "GLM 5.3 · APInex pool · 2.3k tokens"; 0 page/console
  errors; dev.log clean apart from the two intentional heal lines.
- `bun run lint` clean; `tsc --noEmit` error count identical to the
  pre-run baseline (14 pre-existing, 0 new).
- Cleanup: 5 test chats + 5 test cache rows purged; the user's real
  chats untouched and readable.

### Ops discipline (new, for future runs)

- **Never `git stash` / `git reset --hard` / `git checkout` on this
  repo while the dev server holds the DB open** — use `git diff`
  into a temp file instead when baselines are needed. The wrapper
  now makes even a violation self-healing, but the discipline stays.
- After any prisma schema push, restart the dev server (existing
  note) — and RESTART also clears any poisoned pool (the global
  client is cached in `globalThis` across hot reloads).

### Deferred / known trade-offs

- The heal retries only read-only-class failures; a genuinely
  read-only disk (permissions, full disk) still surfaces the honest
  error after one retry — by design.
- During a heal, a concurrently in-flight query on the OLD pool
  could observe a one-off connection error (not retried — ambiguous).
  Rare (heals only happen when git swaps the DB under the server)
  and strictly better than the previous permanent breakage.
- Hydration attribute mismatch on Radix popovers (pre-existing).

---

## Run 12 — 2026-11-02: CLIENT-SIDE TYPEWRITER GATE — responses type out word-by-word at a readable pace, on every path, with Skip / smart auto-scroll / reduced-motion

**Rung:** 2 (Clarity/UX — the user's spec'd request: *"Stream
responses word-by-word instead of displaying them instantly…
roughly 20–40 words per second… requestAnimationFrame, NOT
setInterval… auto-scroll only if the user has not scrolled up…
reserve the container height… prefers-reduced-motion… Skip
affordance… fall back to full text on JS failure… no new
dependencies"*).

### Diagnosis (OBSERVE — read the render path, then measured live)

Run 10 made every server path stream, but **pacing that the user
can watch cannot live on the server**: the client renders whatever
each `reader.read()` chunk contains, so network coalescing + React
batching + the server's own ~166 wps reveal let bursts land in a
single frame — the answer still read as "appeared all at once".
Two more defects surfaced in the same surface:

- `ChatTimeline` scrolled `scrollIntoView({smooth})` on EVERY store
  update — scroll-spam during typing, and it **yanked the user back
  down** whenever they scrolled up to read.
- At `done`, the server reconciles the assistant message id → React
  key change → **full remount**: any naive per-message typewriter
  would dump its remaining backlog at exactly that moment.

### Competitor scan

ChatGPT / Claude / Gemini decouple visual pacing from model speed:
the answer always types at a comfortable, constant rate, follows the
bottom only while the user is at the bottom, and can be skipped.
None of them yank the user's scroll. Parity restored with spec-exact
behavior plus a Skip affordance on the streaming text itself.

### Change (all client-side, vanilla TS, zero new dependencies)

1. **`src/components/senku/Typewriter.tsx` (new)** — the reveal
   engine. `WORDS_PER_SECOND = 30` (one exported knob), a
   requestAnimationFrame clock with a word budget (`MAX_FRAME_DT_MS`
   = 100 so a background tab never fast-forwards), word-boundary
   advance that never splits surrogate pairs and chunks unbroken
   runs (CJK/URLs) at ≤10 chars — **slices reassemble
   byte-for-byte**. History never replays (only growth observed
   after mount animates); trims/resets/server-truth replacements
   snap on the next frame via the tick's position clamp; any engine
   throw falls back to rendering the full text. `StreamedMarkdown`
   renders `<Markdown>` of the revealed prefix + caret + a
   `.senku-skip` pill, and treats **any click on the streaming
   text** (outside links/buttons/selections) as Skip.
   `useStickyScroll` publishes bottom-stickiness on the scroll
   container (36 px tolerance) that every instance consults.
2. **`Markdown.tsx`** — renderer map hoisted to a stable module
   constant + `CodeBlock` memoized: React now RECONCILES the
   markdown tree between frames instead of remounting it (previously
   every render created new component identities → the whole tree,
   including all code blocks, re-highlighted per delta). Only the
   growing block re-highlights now.
3. **`ChatTimeline.tsx`** — assistant messages use **slot-stable
   keys** (`slot-<index>`; messages are append-only while streaming,
   so the slot never shifts mid-turn) so the done-time id
   reconciliation can no longer remount the message and dump the
   reveal. Auto-scroll now fires only for NEW messages
   (count/lastId-keyed) and only while sticky; word-following is
   done by the gate per frame. Both surfaces (normal + duel lanes)
   render through `StreamedMarkdown`.
4. **`globals.css`** — `.senku-skip` pill + `.senku-caret` added to
   the `prefers-reduced-motion` kill list.

### Verification (all passed, live in the browser)

- `bun run lint` clean; `tsc --noEmit` 14 pre-existing errors
  before and after (0 new). React Compiler rules satisfied — all
  state transitions live in rAF callbacks / event handlers.
- **500-word story (provider path)**: steady **30 wps** window
  after window (29–31 across the whole curve), median frame
  17 ms / max 67 ms (no freeze), while the SSE stream had already
  delivered all 2971 chars early — the user watches text the model
  finished long ago, exactly as specified.
- **Byte-for-byte**: final DOM text (whitespace-stripped) identical
  to the raw `done.content` on every prose turn tested (2430/2430,
  327/327, 433/433 chars — zero mismatches, zero suffix drift);
  planted nonces present exactly twice; zero length decreases
  within a turn (no flicker).
- **Auto-scroll**: scrolled up mid-typing → 44 more words typed
  with scrollTop pinned at 0 (no yank, stick="0"); scrolled back to
  bottom → following resumed immediately (scrollTop=scrollMax).
- **Skip (button)**: one sample step 2280 → 3757 chars (entire
  backlog landed ≤100 ms), no intermediate partial states.
  **Skip (click on the text body)**: 7 → 58 chars in one step,
  re-arming correctly as the stream continued.
- **prefers-reduced-motion** (matchMedia override): full 433-word
  text present at t≈5 s (arrival-following, not 30 wps pacing),
  **Skip affordance never appears**, byte-identical.
- **Regressions**: code-block answers render with language badge +
  copy button; provenance rows on every turn; duel lanes both type
  via the same gate and the **Keep → runner-up** flow survives the
  slot-key change (kept GLM answer + "Runner-up · Gemini 3.8 Flash"
  collapsed under it); 0 page errors; dev.log clean apart from the
  pre-existing Radix hydration attribute mismatch.
- VLM-inspected mid-typing screenshot: partial answer, Skip pill
  visible, no layout glitches.
- Cleanup: 12 test cache rows purged (nonce-matched), 0 temporary
  chats persisted, user's real chats untouched.

### Deferred / known trade-offs

- The provenance row appears at `done` even if the gate is still
  typing out the backlog (the model IS done; the typing is
  presentation). Honest, and the Skip affordance covers impatience.
- Very long answers take as long as the spec'd constant pace
  implies (500 words ≈ 17 s) — by design; the Skip pill is always
  one click away.
- With slot-stable keys, chat switches no longer replay the
  fade-up animation for messages that occupy already-mounted slots
  (incumbents don't animate history either — calmer, intentional).
- Server-side `revealWords` (Run 10) still paces the SSE for
  non-browser consumers; the client gate is the single visual
  authority, and double-pacing is benign (server ticks arrive as
  bursts the gate smooths).

---

## Run 13 — 2026-11-02: LIVING SIDEBAR — animated open/close, hover-to-peek, and calm chat navigation

**User request.** (a) Animate opening AND closing the sidebar; (b)
animate entering a chat and going to a new chat; (c) resting the
cursor on the sidebar button opens it with no click at all — and
when the cursor moves away, the sidebar returns to closed.

### What shipped

**1. Animated sidebar (was: hard mount/unmount, zero motion).**
The sidebar is now always mounted inside a shell that animates:
- **Desktop**: shell width animates 0 ↔ 264 px with
  `cubic-bezier(0.32, 0.72, 0, 1)` 280 ms — the chat column
  reflows smoothly, claude.ai-style — while an inner panel
  (fixed 264 px, clipped by the shell) slides, so sidebar content
  never squishes mid-flight.
- **Mobile**: the shell is a fixed overlay sliding in from the
  left (translateX), with the backdrop fading (opacity 220 ms)
  instead of popping.
- **First-paint gate**: transitions stay off until two rAFs after
  mount — the hydration state never animates (the mobile
  default-closed sidebar no longer risks a visible slide-shut).
- **A11y**: shell is `inert` + `visibility: hidden` while closed
  (focus/AT can't wander in); a panel that closes under the
  cursor hands focus back (flyout hygiene); toggle carries
  `aria-expanded` reflecting the *effective* open state.

**2. Hover-to-peek on the toggle.** A transient `peek` state
sits beside the pinned `sidebarOpen` (effective = either):
- Cursor rests **140 ms** on the top-bar toggle → sidebar peeks
  open, no click (`SIDEBAR_PEEK_OPEN_MS`).
- Cursor leaves the toggle/sidebar → after a **320 ms grace**
  (`SIDEBAR_PEEK_CLOSE_MS`) it slides away — the grace lets the
  cursor travel between button and panel without collapse.
- Cursor *inside* the sidebar cancels any pending close.
- **Click while peeking pins it open** (converts transient →
  sticky); click when pinned closes; click when closed opens.
  One button, no surprise "my click closed the thing hover
  opened".
- Guarded by `(hover: hover) and (pointer: fine)` — touch devices
  keep the plain click toggle (verified: headless + iPhone
  emulation report `hover: none` and correctly never peek).

**3. Calm chat navigation.** Store gained `viewEpoch`, bumped by
`newChat` / `selectChat` / delete-of-current; the app shell keys
the conversation view on it, so every navigation remounts the
whole view and it settles in with one fade-and-rise
(`senku-view-in`, 260 ms) — instead of N messages exploding
individually. Sending a message never bumps the epoch, so the
typewriter gate is never remounted mid-stream. Bonus: re-clicking
the chat you're already reading is now a true no-op (no refetch,
no replay).

### Verification (all browser-proven, 40 ms in-page samplers)

- **Close on click**: width 264→112→28→14→4→2→0 — real
  intermediate frames, ~280 ms, not an instant jump.
- **Hover open (no click)**: 0→39→152→236→250→264 after the
  140 ms intent; `aria-expanded` flips true.
- **Cursor away**: 264 holds through the 320 ms grace, then
  264→175→41→20→10→3→1→0.
- **Cursor into the sidebar**: stays open (264).
- **Pin cycle**: peek + click → cursor moved far away → still
  264; second click → 0.
- **Enter chat** ("Explain Transformers Simply"): view opacity
  1.00 → 0.00 → 0.49 → 0.79 → 0.92 → 0.97 → 1.00; conversation
  and message actions render.
- **New chat**: 1.00 → 0.00 → 0.27 → 0.66 → 0.86 → 1.00;
  WelcomeScreen visible ("senku returns!").
- **Same-chat re-click**: opacity constant 1.00 — no replay, and
  no `/api/chats/:id` refetch.
- **prefers-reduced-motion** (exact rules injected — the media
  query itself can't be flipped headlessly): close went 264→0 in
  a single 20 ms sample step; open/close become instant state
  changes.
- **Mobile (iPhone 16 Pro emulation)**: boots closed
  (left −264, hidden) with no load animation; toggle click slides
  in −264→−64→−20→−10→−3→−1→0 with backdrop fading to 1; backdrop
  click slides out 0→−152→−223→−245→−264 with backdrop to 0.
- **Typewriter regression**: Temporary-mode turn answered "42"
  through the client gate (0→2 chars, single word) with the keyed
  view wrapper in place; Temporary banner renders inside it;
  message actions present; 0 page errors; dev.log clean.
- **VLM-inspected** hover-peek screenshot: sidebar + chat area
  correctly laid out, nothing clipped or overlapping.
- `bun run lint` clean; `tsc --noEmit` 14 errors — all
  pre-existing (examples/skills/attachments legacy +
  altContent/altModel + WelcomeScreen useNow), 0 new.
- Cleanup: 1 test cache row purged (content "42", today), 0
  temporary chats persisted, 11 real chats untouched.

### Deferred / known trade-offs

- Peek-close is strictly cursor-driven (per the user's spec): a
  peeked sidebar stays open while the cursor rests inside it,
  even after clicking a chat — it folds away only when the cursor
  leaves. Pinned never auto-closes.
- The desktop width animation animates layout (it has to — the
  chat column must reflow); the inner slide keeps the panel
  content itself transform-only, so no text re-wraps mid-flight.
- `prefers-reduced-motion` verification used injected rules
  identical to the shipped media-query block (the CLI can't
  emulate that media feature); the mechanism is the same CSS.

---

## Run 14 — 2026-11-02: YOUR OWN USAGE DAY — daily tokens reset at 01:00 Africa/Algiers, all-time counter beside it

**User request.** (a) The daily token usage must reset every night
at 01:00 after midnight, Algeria time; (b) also show a token usage
that is the all-time usage.

### What shipped

**1. The usage day is 01:00 → 01:00 Africa/Algiers — computed,
never scheduled.** Instead of a cron that zeroes a number (a cron
can be missed, crashed, or corrupted), every aggregate asks
"what did the current usage day start at?":
- `usageDayStart()` / `nextUsageDayRollover()` in `limiter.ts`
  resolve the 01:00 boundary through `Intl` timezone math
  (offset re-derived per instant — survives any future DST rule
  change). Between 00:00 and 00:59 the usage day still belongs
  to the previous evening, per the "after midnight" spec.
- The Daily Pace tier (`keyWindowUsage.daily`) now windows on the
  usage day instead of server-local midnight — one definition of
  "day" everywhere (blocking math and display).
- The pill's headline number is now **Today**: `dailyTokens`
  (effective ×multiplier) resets itself at 01:00 by construction.
  It counts EVERYTHING through the active provider — including
  cloud-failover turns (`keyId: null`) the per-key tier math
  skips.
- `dailyResetsAt` (ISO) ships with every snapshot.

**2. All-time usage, always visible.** `allTimeTokens` =
Σ(per-provider lifetime × that provider's multiplier) across
every provider — never resets. Surfaced in the limiter dialog
("All time · never resets") and in the pill's tooltip.

**3. The reset is visible at exactly 01:00.** `refreshUsage`
arms a single timer from the server's own `dailyResetsAt`
(+1 s, floored at 30 s to make clock-skew loops impossible) and
re-pulls when the day flips — no polling loop.

**UI.** Pill (Ultimate): `Tokens: 2.3k / ∞` (today) with tooltip
"Today's usage — resets daily at 01:00 (Africa/Algiers) · next
reset HH:MM · All time: 444k". Dialog: Today (big, with live
"resets in 13h 14m" countdown on the shared `useNow` clock) ·
This month · All time · ×4 metering note · per-provider lifetime
footer; limited providers get "The daily window runs 01:00 →
01:00 · Africa/Algiers." under the tier bars.

### Verification

- **Window math: 20/20 boundary checks** against independent
  expectations — midday → today 01:00; exactly 01:00:00 → fresh
  window; 00:00/00:30/00:59:59 → yesterday 01:00; Nov 1 00:30 →
  Oct 31 01:00 (month rollover); Jan 1 00:30 → Dec 31 01:00
  (year rollover); window length exactly 24 h; rollover strictly
  future (probed at 11:44 Algiers).
- **DB cross-check (5/5)**: served `dailyTokens` 2,308 ==
  SUM(events, provider, createdAt ≥ usageDayStart) × 4; served
  `allTimeTokens` 443,660 == Σ(per-provider lifetime × mult);
  `dailyResetsAt` == helper output == **01:00 Africa/Algiers**
  formatted; daily ≤ all-time.
- **Rollover re-pull (real store code path)**: stubbed fetch with
  `dailyResetsAt` 3 s ahead → `refreshUsage` re-invoked itself at
  +30 s (the floor) with no caller. First run also caught the
  floor working as designed (6 s wait → no premature pull).
- **Browser**: pill reads "Tokens: 2.3k / ∞" (was lifetime
  443.7k); dialog rows verified by text extraction AND VLM —
  Today 2,308 + countdown ticking, This month 396,660, All time
  443,660, window caption present; 0 page errors; dev.log clean.
- `bun run lint` clean; `tsc --noEmit` 14 errors — all
  pre-existing, 0 new.

### Deferred / known trade-offs

- The pill for *limited* providers still shows the monthly pool
  (that is its governing limit); the 01:00 daily window applies
  to their Daily Pace tier + dialog caption.
- The daily counter for the active provider is provider-scoped
  (matches `totalTokens` semantics); the gateway-wide number is
  the All-time row.
- Countdown text renders in the client's locale clock, the
  boundary itself is fixed to Africa/Algiers by the server.

---

## Run 15 — 2026-11-03: SESSION MANAGEMENT, FOR REAL — sidebar launches closed + 3-dot chat menu (rename / export / delete)

**User request.** (a) When SenkuAPI launches, the sidebar must be
closed. (b) Audit recommendations for chat lifecycle: 3-dot action
menu per chat (Rename / Export / Delete) and a Stop-generation
button, plus mobile keyboard polish
(`interactive-widget=resizes-content`).

### What shipped

**1. Sidebar closed on launch — everywhere.** The store default
flipped `sidebarOpen: true → false`. Desktop launches full-width
chat; mobile launches with the drawer translated off-screen and the
backdrop inert. The redundant `<768px` force-close effect was
removed (the default now covers it). Opening works exactly as
before: click-pin, hover-peek, touch toggle — all Run 13 animation
intact.

**2. 3-dot action menu on every chat row** (replaces the bare trash
icon): **Rename** (inline input in the row — autofocus + select,
Enter commits, Escape cancels, blur commits; a ref guard makes
double-commit impossible when unmount races the final blur),
**Export as Markdown**, **Export as JSON**, **Delete** (wipes the
SQLite chat + messages, as before).
- Rename is optimistic in the store and PATCHes
  `/api/chats/[id]` (endpoint already existed, unused until now);
  failure rolls back via `refreshChats` and toasts.
- Export is a new pure lib (`src/lib/senku/export.ts`): the open
  chat exports straight from the live store; any other chat is
  fetched once. Markdown carries the same honesty the timeline
  shows — per-assistant `_tokens · via provider · served from
  cache_` lines, attachment provenance (chars read, truncation,
  method), and source links. JSON is full-fidelity. Filenames are
  sanitized from the title; downloads go through a Blob + revoked
  object URL.
- **Latent touch defect fixed**: the old trash button (and the new
  trigger) used `hidden group-hover:flex` — Tailwind v4 generates
  group-hover inside `@media (hover: hover)`, so on touch devices
  the button was *permanently invisible*: no rename, no delete on
  mobile at all. The trigger now adds `[@media(hover:none)]:flex`
  (always visible when the device cannot hover) plus
  `group-focus-within:flex` (keyboard) and `data-[state=open]:flex`
  (stays visible while its menu is open).

**3. Mobile keyboard viewport.** `export const viewport` in the root
layout ships `interactive-widget=resizes-content` — Android
keyboards resize the page instead of covering the floating input
bar (iOS already follows the visual viewport).

**Stop-generation button**: already shipped in an earlier run
(send square swaps in while streaming, `AbortController.abort()`) —
re-verified end-to-end this run rather than rebuilt.

### Verification (all live, agent-browser)

- **Launch-closed**: fresh load at 1440×900 — no `senku-open`
  class, sidebar width 0; reloaded again mid-session — still
  closed; 390×844 — panel translated off-screen, backdrop inert.
  Toggle opens to 264px with animation intact.
- **3-dot reveal paths**: CSS audit — `group-hover:flex` generated
  (idx 770, after `.hidden` idx 156; specificity (0,2,0) > (0,1,0))
  inside `@media (hover: hover)`; the headless env reports
  `hover:none` so the reveal was proven via the unguarded paths:
  `[@media(hover:none)]:flex` (visible in this env, real mouse
  click) + rule-existence analysis for desktop hover. Menu items
  confirmed by DOM and by VLM screenshot.
- **Rename**: clicked Rename → inline input focused with old title
  selected → typed new title → Enter → row updated instantly, old
  title gone, input closed; PATCH 200; DB shows new title +
  bumped `updatedAt`.
- **Export JSON** (empty test chat): captured via instrumented
  `URL.createObjectURL`/anchor click — filename
  `ZZ renamed by run15.json`, `application/json;charset=utf-8`,
  correct `{title, model, provider, createdAt, exportedAt,
  messages}`.
- **Export Markdown** (real 8-message chat): 2,599 bytes,
  `# title` + provenance header (`Exported from SenkuAPI · date ·
  8 messages · free/glm-5.3 (APInex)`), `## You` /
  `## Assistant — model` sections, `_4,652 tokens · via APInex_`
  footer; first user message byte-identical to the API payload;
  8/8 messages present. Toast "Exported … as Markdown." captured
  live in `[role=status]`.
- **Delete**: clean run — menu → Delete → row gone from UI,
  `DELETE /api/chats/[id]` 200, row gone from DB.
- **Stop**: sent a long-generation prompt — stop square appeared
  71 ms after Enter; atomic in-page click aborted the stream:
  stop gone, send button restored, partial reply retained, zero
  error cards.
- **Regression**: `bun run lint` 0 errors (2 pre-existing script
  warnings); `tsc --noEmit` 14 errors = exact pre-existing
  baseline; dev.log clean; 0 page errors; all 11 real chats
  intact; both test chats + the aborted-essay chat purged.

### Deferred / known trade-offs

- Out-of-band deletions (another tab, direct API) don't
  live-refresh an open sidebar — single-user gateway, in-app
  deletes refresh correctly.
- The 3-dot hover reveal could not be *visually* confirmed in the
  headless CLI (`hover:none` media); it is proven by generated-CSS
  audit (rule, guard, specificity, order) plus the identical
  pattern shipped since the trash button. The touch path is
  directly verified.
- From the same audit, deferred to the backlog as higher-effort
  items: Projects modal with per-project system prompts (top
  candidate — the "No projects" label is still static), TTFT
  badge, reasoning accordions, Canvas/artifacts drawer,
  non-destructive branching, gateway dashboard panel, mobile
  swipe-to-open, `/docs` (not possible under the single-route
  constraint), homepage hero, OG tags.

---

## Run 16 — 2026-11-03: STOP REALLY STOPS — true upstream cancellation + SQLite WAL

**User request (audit "fix" list).** The backend section: (a) when
the user clicks Stop, the backend must cancel the upstream provider
stream (`request.is_disconnected()` equivalent) — otherwise the
provider keeps generating tokens into a dead stream and drains the
key pool; (b) SQLite needs WAL + busy_timeout for concurrent
writes; (c) the `<div inert>` sidebar wrapper looked stuck; (d)
mid-stream key failover on 429/502.

### Diagnosis first (what was real)

- **(c) inert — NOT a defect.** Live-verified: `inert` is present
  exactly while the sidebar is closed (correct a11y — a hidden
  0-width panel must never be focusable), the top-bar toggle that
  OPENS the sidebar lives outside the inert subtree and stays
  fully enabled, and the attribute is removed entirely when open.
  The audit's proposed fix ("default inert to false on desktop
  SSR") would leave a hidden panel in the tab order — a keyboard
  a11y regression. Shipped an INVARIANT comment on the shell div
  instead so future audits don't flag it.
- **(d) key failover — already shipped** (dispatch retry loop +
  key-health circuit breaker: typed auth/transient failures, next
  healthy key retried inside the same turn whenever no deltas were
  emitted). No change needed; re-confirmed by code read.
- **(a) upstream cancellation — REAL and the money leak.** The
  route never observed `req.signal`; the gateway/dispatcher/
  executor had no abort path; `tryProviderStream` only had its own
  25 s inactivity timeout. A stopped turn kept the provider
  generating to completion into a dead pipe.
- **(b) WAL — real.** `journal_mode=delete` (SQLite default),
  no busy_timeout, while SSE persistence + usage accounting + key
  updates + titling all write concurrently.

### What shipped

**1. End-to-end cancellation chain.** `req.signal` (the client's
connection) now threads route → `runChatTurn`/`runDuelTurn` →
`dispatchCompletion` → `tryProviderStream`/`zaiCloudExec`:
- Executor links the client signal into the upstream fetch's
  AbortController — the provider connection is killed at the
  source the moment the consumer is gone. The 25 s stall timeout
  remains for genuine hangs.
- A client-abort is a NEW typed outcome (`reason: "aborted"`,
  carrying the partial text + estimated consumed tokens) —
  **terminal**: never retried with another key, never failed over
  to the cloud (regenerating an answer nobody asked for would be
  the opposite of saving tokens).
- Cloud path (Z.ai SDK) checks the signal between chunks and
  cancels the SDK stream; `revealWords` (cache-hit typing) stops
  typing into a dead pipe.
- **Aborted-turn semantics:** the partial assistant reply IS
  persisted (the timeline keeps exactly what streamed — the DB now
  matches the UI instead of silently holding a longer full answer);
  usage is billed for what was actually consumed (prompt + partial
  estimate — the standard fallback when the provider's usage chunk
  never arrives); the serving key's accumulator rolls forward; the
  confidence-label corrective pass is skipped (no cloud spend on an
  abandoned answer); and the truncated answer **never enters the
  24 h response cache**. Duel lanes: both racing upstreams cancel.

**2. SQLite WAL + busy_timeout.** The database file switched
`delete → wal` (persistent in the file header; done via a one-off
Prisma PRAGMA so no CLI dependency) and the connection URL now
carries `journal_mode=WAL&busy_timeout=5000` so every fresh
connection requests both. Verified live through the running
server: `journal_mode: wal`, `busy_timeout(ms): 5000`. Next dev
reloaded the env cleanly and all APIs kept serving 200.

### Verification (all live)

- **curl kill mid-stream** (900-word Casbah essay, SIGKILL at
  1.8 s): dev.log shows both markers — `[chat/send] client
  disconnected — cancelling upstream generation` and `[gateway]
  turn cancelled by client — persisted 61 chars, 2432 tokens
  billed, cache skipped`. DB: user msg + 61-char assistant partial
  (byte-identical to the deltas the client received), UsageEvent
  on the serving key with partial tokens (591 prompt + 17
  completion, ×4 multiplier applied), ResponseCache rows **64 →
  64** (no row for the truncated answer).
- **UI Stop button**: abort landed 130 ms after send (before the
  first delta) — both markers fired, 0-char partial created no
  ghost message, stop→send swap instant, no error card.
- **Regressions**: full send intact (3.1 s stream, persisted,
  cached); identical resend served from cache (`cached: 1`,
  `tokens: 0`, reveal typing intact); `lint` 0 errors; `tsc` 14
  errors = exact pre-existing baseline (one scoping slip caught
  and fixed during the run); 0 page errors; dev.log clean.
- Test artifacts purged (3 test chats deleted; the user's own
  "What Model Am I Talking To" chat from 16:37 preserved — 12
  chats remain).

### Deferred / known trade-offs

- Aborting before the first token bills the estimated prompt (the
  provider may or may not have started generating — unknowable
  from our side; the estimate is the same fallback used when
  providers omit usage stats).
- The Z.ai SDK accepts `signal` via per-chunk checks rather than a
  native abort option — cancellation is prompt (checked before
  every read) but not instruction-level.
- From the same audit, deferred to the backlog: SSR skeleton
  paint, Tools-rail Canvas/artifacts drawer, reasoning accordions
  (␐/`reasoning_content` normalization), non-destructive
  branching (`parent_message_id`), Projects with scoped system
  prompts, IndexedDB backup, sliding-window context compressor,
  TTFT badge.

---

## Run 17 — 2026-11-03: PRODUCTION POLISH SWEEP — rAF stream throttle · Senku Canvas · paste pills · slash commands · usage honesty

**User request (production-polish spec, five sections).** The
unshipped remainder after Run 16's audit: (1a) re-verify the
`<div inert>` sidebar report at the source; (1b) throttle streamed
markdown/UI updates on `requestAnimationFrame` with a ~32 ms floor
and a guaranteed final flush; (2) activate the dormant
`<aside aria-label="Tools">` rail as a Senku Canvas (code-block
Copy/Wrap/Preview controls, sandboxed html/svg/mermaid previews);
(3) >60-line pastes → removable `Pasted snippet · X lines` pills +
an accessible `/` command popover; (4) `stream_options:
{include_usage}` where supported, estimates clearly marked,
Retry-After respected; (5) full verification, no fake states.

### Diagnosis first

- **(1a) inert — re-proven NOT a defect** (Run 16's audit holds).
  SSR HTML contains exactly ONE `inert`, on the closed sidebar
  wrapper; the control that OPENS it (`aria-label="Open sidebar"`)
  renders outside the subtree and stays interactive; clicking it
  removes `inert`; closing restores it; the Tab order flows
  toggle → palette → rail → textarea and never enters the closed
  panel. No hydration mismatch (React 19 serializes `inert=""`;
  client state matches). Defaulting inert to false pre-hydration
  would put a hidden 0-width panel in the tab order — kept the
  documented invariant instead.
- **(1b) real gap**: every SSE delta ran a full store `set` +
  markdown re-parse. **(2)** real gap: CodeBlock had Copy only,
  rail was stub toasts. **(3)** real gap: pastes flooded the
  textarea; no command palette at the input. **(4)** partial gap:
  `stream_options` never sent, estimates presented as exact, no
  Retry-After. Failover/disconnect/WAL/atomicity: already shipped
  (Runs 1/16) — untouched.

### What shipped

**1. rAF-gated stream rendering (`raf-throttle.ts` + store).**
`StreamFlushScheduler`: deltas accumulate synchronously (data is
never delayed); store patches ride animation frames with a
timestamp-enforced ≥32 ms floor (rAF is the scheduler, timestamps
only the gate; a too-early frame reschedules itself). Terminal
paths are exact: `done`/`error`/`lane_done` CANCEL the pending
frame then write authoritative content; Stop flushes NOW
(synchronous — throttling can never delay cancellation); a stream
that ends without a terminal event gets a safety flush so tail
tokens are never lost and no caret spins forever; `finally`
cancels every scheduled frame. Duel lanes got their own
schedulers; `restart` cancels before resetting so stale content
never flashes back.

**2. Senku Canvas (the Tools aside, activated).** Every supported
code block now has a sticky keyboard-accessible header: Copy (with
copied state + graceful clipboard failure), **Wrap/Unwrap**
(`wrapLongLines`, `aria-pressed`), and **Preview in Tools** —
offered ONLY for `html · svg · mermaid · javascript · python`
labels (+ js/mjs/node/py aliases); unlabeled/unknown blocks are
never inferred safe. The canvas is a 420 px split column on lg+,
a closable full-height overlay below (backdrop + Escape + focus
moved to Close on small screens). Preview/Code tabs share one
source block kept in the store (close/reopen/chat navigation never
lose it). SECURITY: previews render in a srcdoc iframe with
`sandbox=""` (no allow-scripts, no allow-same-origin, no forms) +
CSP `default-src 'none'` (all external network blocked — no CDN
scripts/styles, ever). Mermaid is pre-rendered in the parent via
the locally-bundled `mermaid@12` (lazy dynamic import,
securityLevel `strict`) then independently sanitized (scripts,
foreignObject, on* attrs, script/external URLs stripped) before
entering the iframe — the rendered SVG is static. JavaScript and
Python honestly DO NOT run: they open on the Code tab and the
Preview tab explains that execution is unsupported, never
simulated.

**3. Developer input UX.** Plain-text pastes >60 lines (LF/CRLF
consistent, editor-style counting — exactly 60 stays inline)
become a removable `Pasted snippet · X lines` pill: staged 100 %
client-side (no upload/persist until the user sends), sent exactly
once via the existing attachments pipeline in pill order, capped
by the existing 5-file/size limits with clear errors, honest chip
tooltips ("the pasted snippet, N characters"). The `/` popover:
`/code` (code-focused, no chatter), `/concise` (ultra-brief),
`/search` (reflects the REAL grounded-search pipeline, live On/Off
badge). Keyboard: ↑↓ navigate, Enter/Tab apply, Escape dismisses
(and stays dismissed for that token); IME-composition Enter never
submits or drives the popover (`isComposing`/229 guard — also
fixed for normal sends); `/` mid-word and URLs never trigger.
Applying strips the token (never sent as prompt text), arms a
removable one-shot pill, and the next send carries `style` through
the gateway (CODE/CONCISE system addons; cache-key namespaced per
style; medium+no-style stays byte-identical for cache hits).

**4. Usage honesty + provider hardening.** Provider requests now
send `stream_options:{include_usage:true}` — adaptively: an
endpoint that 400s naming the field is remembered per base URL
(in-memory) and replayed byte-faithfully without it, so providers
that reject the option are never broken (Z.ai SDK path never
sends it — capability-gated). `usageReported` threads through the
executor → gateway → `done` event → store → a persisted
`Message.tokensEstimated` column → the timeline provenance line,
which now reads **"≈ N tokens (estimated)"** whenever the upstream
didn't report usage — an estimate is never presented as exact.
429/503 responses parse `Retry-After` into a bounded (≤3 s) wait
before the next pooled key, skipped entirely when the client is
already gone.

### Verification (all live, agent-browser + suite)

- **Inert (1a)**: SSR HTML audit (exactly one `inert`, on the
  closed wrapper; open-control outside) → click opens (inert
  removed, 264 px panel) → close restores → 8-step Tab walk never
  enters the closed panel.
- **Stream (1b)**: 500-word stream — 412 network deltas → final
  DOM text === `done` payload === DB row (2,939 chars,
  byte-normalized equal); second stream — 286 deltas, **zero
  writes after done** (no stale frames); Stop mid-essay → partial
  retained (785 chars), zero error cards, send restored, both
  cancellation markers in dev.log, DB holds the 843-char partial,
  cache skipped. The visible settle pace after Stop is the
  typewriter's reading rhythm (skippable), not throttle delay —
  the store flush is synchronous.
- **Canvas (2)**: html preview → 420 px static split column,
  iframe `sandbox=""`, NO allow-same-origin, srcdoc CSP
  `default-src 'none'` present; VLM confirms the red-heading/blue-
  box page renders. Mermaid → rendered Start→Choice→End flowchart
  (VLM-confirmed), `<svg>` in srcdoc, zero `<script>`, still
  sandboxed. Code tab shows highlighted source + Copy; tab
  switches preserve the source; close/reopen (rail button,
  `aria-pressed`) keeps it; Escape closes; 390×844 → fixed
  full-height overlay + visible backdrop + focus on Close;
  backdrop click closes. javascript block → opens on Code tab;
  Preview tab shows the honest "doesn't run in the preview"
  notice with NO iframe. Wrap toggle → `aria-pressed` flips,
  `white-space: pre-wrap` applied.
- **Input UX (3)**: 61 LF lines → pill + clean textarea; 61 CRLF
  lines → pill; exactly 60 and 59 → stay inline; 2 pills staged in
  order, removal works; send → request body carries ONE attachment
  with the byte-exact CRLF text, prompt clean, pills cleared;
  persisted user message shows the record (538 chars, CR
  preserved). Slash: bare `/` → 3 options + aria-activedescendant;
  `/co` filters; ↑↓ + Enter applies (token stripped, Concise pill,
  toast); pill X removes; `/search` turns the Search pill on;
  mid-word `a/b` and URLs never trigger; `/` after space does;
  Escape dismisses and stays dismissed. `/code` send → body has
  `style:"code"`, content clean, pill cleared, and the reply led
  with the code block (no chatter).
- **Usage (4)**: live APInex turns report exact usage
  (`tokensEstimated: false` in DB, provenance "4.9k tokens", no ≈);
  the aborted turn also recorded exact usage; cache-hit turns
  carry `tokensEstimated: false` (0 tokens, nothing estimated).
- **Duel regression**: armed duel → both lanes streamed and
  settled (2 Keep buttons), winner pick clean.
- **Suites**: `tests/test_senku.py` — 96/101; the 5 failures are
  environmental, proven independent of this run: `api.oxionai.dev`
  has NO DNS RECORD (every OxionAI turn correctly cloud-fails-over
  → `senku.key=None`) and Test 9 expects a `free/claude-4.6-opus`
  model absent from the current seed. Provider restored to APInex
  after the probe. `lint` 0 errors (2 pre-existing script
  warnings); `tsc --noEmit` **14 errors = exact baseline** (proved
  by stashing the working tree: pristine tree also 14); `bun run
  build` not run (sandbox policy); dev.log clean; 0 page errors;
  all 12 real chats intact; both test chats + duel chat purged.

### Deferred / known trade-offs

- IME guard is code-level (`isComposing`/keyCode 229) — true
  composition can't be simulated headlessly.
- The store-level throttle's flush cadence isn't directly
  observable in the DOM (the typewriter reveal dominates visible
  text changes); its correctness is anchored by architecture
  (single append buffer) + the final-equality/no-stale-write
  proofs.
- Mermaid's parent-side parse is defense-in-depth behind
  securityLevel `strict` + the sanitizer + the script-less
  sandbox; a mermaid CVE would need to defeat three layers.
- Retry-After only in delay-seconds form, capped at 3 s; 402
  remains typed as transient (still retried per Run 1 policy).
- No new automated test files (project convention: live
  characterization via the python suite + agent-browser E2E,
  documented above).

---

## Run 18 — 2026-11-03: Entry flash killed — the composer no longer pops under the top bar and drops on boot

**User report (screenshots).** On entering the app, the composer
"pops up" pinned directly under the top bar with an empty body,
then visibly drops to the bottom once the page settles. Asked to
fix it "with an animation or something".

**Root cause (traced, not guessed).** In `SenkuApp.tsx` the
conversation view wrapper — the ONLY `flex-1` element in the main
column — was gated behind `{booted && …}`. Until `/api/bootstrap`
answered, the column rendered `TopBar → InputBar` with nothing
expandable between them, so the composer spent the boot window
pinned right under the top bar; the moment `booted` flipped, the
flex-1 view mounted and the composer teleported to the bottom.
The welcome content had a calm `senku-view-in` fade-and-rise, but
the composer's drop was an unanimated jump.

**Fix — stabilize first paint, then let the existing animation
carry the moment (3 files):**
- `src/components/senku/SenkuApp.tsx` — the flex-1 view SLOT is
  now rendered unconditionally (keyed by `viewEpoch` as before);
  pre-boot it is an empty expanding slot, so the composer sits in
  its final position from the very first server-rendered paint.
  When boot completes, content mounts into the waiting slot and
  the `senku-view-in` class lands in the same commit → the whole
  view settles in with the existing 260 ms fade-and-rise
  (reduced-motion: instant). Keyed navigation remounts are
  byte-identical to the old behavior (same key, same class once
  booted).
- `src/components/senku/InputBar.tsx` — root gains the one-time
  `senku-input-in` entrance (280 ms, 8 px rise + fade). Purely
  cosmetic: position is already correct at first paint, so it
  eases in, never jumps. Plays once per app load; chat navigation
  never remounts the bar so it never re-runs mid-session.
- `src/app/globals.css` — `senku-input-in` keyframes next to
  `senku-view-in`, plus the `prefers-reduced-motion: reduce`
  override grouped with it.

**Verified (all real):**
- SSR HTML proof: raw server output now contains the flex-1 slot
  between top bar and composer (`topbar < slot < composer` true),
  `senku-input-in` present, `senku-view-in`/welcome content
  correctly absent pre-boot → first paint is the settled layout,
  browser-independent.
- Live zero-jump proof (agent-browser): with the settled page
  measured (composer top = 769 px), the exact pre-boot DOM was
  simulated (slot emptied, class removed) → composer top stayed
  exactly 769 px (`zeroJump: true`). No popup state exists anymore.
- Desktop 1440×900 + mobile 390×844: composer flush at viewport
  bottom (gap 0), slot fills top-bar→composer, welcome visible,
  `senku-view-in` applied after boot; no console/page errors;
  screenshots captured.
- `bun run lint` 0 errors (2 pre-existing script warnings);
  `tsc --noEmit` unchanged baseline — zero new errors in touched
  files.

**Scope discipline:** no new dependencies, no fake loading
states, no route or API changes; `booted` semantics untouched
(failed bootstrap still boots by design — verified live via an
aborted `/api/bootstrap`).

**Follow-up (same report, 19:10 screenshot): the token pill was
the last flashing element.** With the composer anchored, reloads
still showed the pill pop amber `Tokens: 0 / 500k` → green
`Tokens: 96.3k / ∞` when bootstrap landed. Root cause: pre-boot
`limiter` is `null` and `TopBar` fell back to
`pillLabel(0, 500_000)` — a FAKE state that misrepresents the
account for the whole boot window. Fix in `TopBar.tsx` (+ one
reduced-motion rule in `globals.css`):
- Pre-boot the pill renders a neutral pulse SKELETON
  (`TokenPillSkeleton`: `aria-busy`, "Loading usage…", width
  148 px mirroring the settled pill) — no fake numbers, ever.
- When `booted` flips, the real pill mounts (span→button remount
  guarantees it) with the existing `senku-fade-up` settle; later
  `refreshUsage` updates patch in place and never re-animate.
- Verified: SSR HTML contains `senku-pill-loading` + `aria-busy`
  and NO `500k`/`96.3k` anywhere (first paint honest,
  browser-independent); live settled state shows the real pill
  (width 150 vs skeleton 148 → 2 px delta ≈ zero shift), fade-up
  applied, welcome visible, composer still bottom-anchored;
  mobile 390×844 no horizontal overflow; no page errors; lint
  0 errors, no new tsc errors.

---

## Run 19 — 2026-11-03: THE LIVING GATEWAY — welcome screen becomes a live mission-control moment

**User request (standing directive).** "Look at the site first,
then innovate. Make ONE bold change that improves conversions or
the look and feel, not a small tweak. Cook and ship every time."

**Observed first.** agent-browser walkthrough of the live app:
welcome + snapshot of every control; `/api/bootstrap` + `/api/usage`
shapes inspected for real data. Finding: the welcome screen — the
highest-traffic surface — was static and generic, while the
product's actual identity (a LIVE gateway with pooled keys, usage
honesty, per-message provenance) was invisible at first glance.
Conversion gap = trust not shown in the first 3 seconds.

**The bold change (one cohesive piece): the entry moment now
shows the gateway's real pulse.**
- Breathing HEALTH RING around the logo: a conic emerald sweep,
  masked to a hairline circle, rotating 9s/turn — emerald while the
  limiter is quiet, amber (`.senku-pulse-warn`) when the limiter
  itself raises a `warning`. Hidden when limiter data is unknown.
- LIVE STAT STRIP under the clock: `⚡ 96.3k tok today ·
  ∞ 538k all-time · 🔑 2 keys live · APInex` — REAL numbers from
  the bootstrap limiter (`dailyTokens`, `allTimeTokens`,
  `activeKeys`, `providerName`), with tooltips carrying the exact
  figures. Count-ups sweep from the settled value with one rAF
  ease-out (new `src/hooks/use-count-up.ts`), re-sweep smoothly on
  later usage refreshes, jump instantly under reduced-motion, and
  render NOTHING when a value is unknown — the strip never guesses
  and never fakes a digit.
- Cinematic staggered entry: logo bloom (640 ms one-time), headline
  → subtitle → clock → chips → starter cards cascade via
  `senku-fade-up` + per-element `animation-delay` (60–320 ms);
  starter cards gain a warm hover glow. All grouped into the
  `prefers-reduced-motion` block (instant landing).

**Two real bugs found & fixed during verification (not shipped
broken):**
1. `react-hooks/set-state-in-effect` (React 19 lint): the hook's
   first version called setState synchronously in the effect body —
   restructured so every write happens inside the rAF callback
   (the effect only syncs with the external rAF system).
2. CSS cascade defect: `.senku-fade-up` used the `animation:`
   SHORTHAND, which resets `animation-delay` to 0 and, as unlayered
   CSS, silently beat Tailwind's `[animation-delay:…]` utility —
   every stagger in the app was dead at 0 s. Converted to longhand
   (`animation-name/duration/timing/fill-mode`) so the delay
   utilities actually apply. Also caught Turbopack serving a stale
   CSS chunk mid-verification (dev-server restart; verified fresh
   bundle by marker).
3. Bonus: removed the pre-existing `useNow(1000)` tsc baseline
   error while rewriting the file (`useNow()` takes no args).

**Verified (all real):**
- Strip shows exact ground truth vs bootstrap: 96264 → "96.3k",
  538194 → "538k", 2 keys, APInex — matched.
- Count-up sweep proven live: frame-zero sample "0" → settled
  "96.3k" (rAF loop observed in the actual page).
- Stagger delays computed in-browser: chips 0.18/0.24/0.30 s,
  cards 0.14/0.20/0.26/0.32 s, headline 0.06 s; ring animation
  `senku-spin-slow` running; logo bloom applied.
- Desktop 1440×900 + mobile 390×844 screenshots: ring visible,
  strip wraps cleanly on mobile, no horizontal overflow, composer
  still bottom-anchored (Run 18 intact), zero page errors,
  dev.log clean, lint 0 errors, tsc clean in touched files.

**Scope discipline:** no backend changes, no new dependencies,
no fake metrics anywhere (strip hides entirely without limiter
data), reduced-motion fully honored.

---

## Run 20 — 2026-11-03: THE ENGINE BAY — the model lineup becomes a first-class hero of the entry moment

**User request (standing directive).** "Look at the site first,
then innovate. Make ONE bold change that improves conversions or
the look and feel, not a small tweak. Cook and ship every time."

**Observed first.** Full agent-browser walkthrough (desktop 1440×900
+ mobile 390×844): welcome screen (Run 19 pulse), model picker,
sidebar, ⌘K palette, limiter panel, a real streamed answer with
provenance footer, and a starter-card send. Finding: the product's
actual inventory — five live frontier engines, one gateway, all
free — was invisible at the highest-traffic surface. The value prop
was abstract copy ("Pooled key routing…") and the engines hid behind
a small composer dropdown discovered only after the first click.
Conversion gap = the strongest reason to stay wasn't shown when it
matters (the first 10 seconds).

**The bold change (one cohesive piece): the ENGINE BAY.**
- New section on the welcome screen between the stat strip and the
  starters: overline "THE LINEUP" + honest counter `5 engines · one
  gateway · all free` ("all free" prints only when every engine's
  meta tier really is Free).
- One engine card per REAL id from the bootstrap payload's
  `activeProvider.models` (never hardcoded): pretty name from the
  shared `modelMeta` table, strength note (Balanced / Fastest /
  Deep reasoning / Long context / Fast), tier badge. The selected
  engine gets an emerald ring + a `senku-pop` spring check-in
  (new CSS keyframes, reduced-motion covered).
- One click switches the engine via the SAME store field the
  composer picker uses — the composer button mirrors the choice
  instantly, and the next send (starter card or typed) routes to
  the picked engine. Choice → ownership → first send.
- Layout: desktop = even auto-fit grid (`minmax(160px,1fr)`,
  `max-w-4xl`); mobile = edge-peek snap rail (scrollbar hidden via
  new `.senku-no-bar`, the cut-off card is the affordance).
- Honesty: the bay renders NOTHING when `models` hasn't loaded —
  it never invents an inventory. (Verified safe: the store sets
  `models` in the same `set()` that flips `booted`, so the bay is
  present at the welcome's first paint — zero layout shift.)
- Cascade retimed to follow DOM order: headline 60ms → subtitle
  90ms → clock 120ms → stats 170–290ms → engines 330–550ms →
  starters 600–780ms.

**Real defect caught & fixed during verification (not shipped
broken):** first cut truncated two engine names ("Gemini 3.8 Fl…",
"DeepSeek 4.…") — card width 136px minus padding couldn't hold
"DeepSeek 4.1 Flash" and the absolute-positioned check could
collide with long names. Rebuilt the card: badge row always
rendered (even heights), check moved INTO the badge row bottom-right
(name can never collide), cards widened (152px rail / 160px grid,
bay to max-w-4xl). All five names verified untruncated in
screenshots.

**Verified (all real):**
- Selection mirror: clicked the Gemini card →
  `aria-pressed` moved (`geminiPressed:true, glmPressed:false`) AND
  the composer picker label flipped to "Gemini 3.8 Flash|Free" —
  one store field, two surfaces, in sync.
- End-to-end conversion path: with Gemini selected, the "Write
  code" starter fired and the message's provenance footer reads
  "Gemini 3.8 Flash · APInex pool · 3k tokens · cache: miss" — the
  bay genuinely drives sends, not just decoration.
- Restored GLM 5.3 via the bay on a fresh chat — composer mirrors
  back (`GLM 5.3|Free`).
- Mobile 390×844: `document.scrollWidth == 390` (no page overflow),
  rail internally scrollable (scrollWidth 800 > clientWidth 358),
  scrolled to the end → last card "DeepSeek 4.1 Flash" fully
  visible; composer bottom-anchored (Run 18 intact).
- Desktop 1440×900: all five names untruncated, selected ring +
  check, Run 19 pulse strip untouched above the bay.
- Zero page errors, console clean, dev.log clean, lint 0 errors
  (2 pre-existing script warnings), tsc 13 errors = baseline
  (none in touched files).

**Scope discipline:** one file touched on the frontend
(WelcomeScreen.tsx) + two CSS utilities (`senku-pop`,
`senku-no-bar`); no backend changes, no new dependencies, no fake
data anywhere (inventory from the live payload or nothing),
reduced-motion fully honored (`.senku-pop` added to the kill
group), Run 18's zero-jump composer and Run 19's living-gateway
moment both intact.

---

## Run 21 — 2026-11-03: REGENERATE + ANSWER VARIANTS — the missing standard capability (and the lineup revert)

**User request.** "Remove the lineup thing, its breaking the beauty
and redundant… don't make redundant things — only improvements and
upgrades, correcting wrong things and adding useful things, cook
but not break or downgrade."

**Part 1 — the revert (user is right).** Run 20's engine bay was
removed cleanly: WelcomeScreen restored to the Run 19 cascade
(starters back at 140–320ms), `senku-pop` / `senku-no-bar` CSS and
their reduced-motion entries deleted, zero orphan references (rg
verified). The composer picker remains the single owner of model
switching — the welcome stays pure. Lesson logged: on this welcome
screen, adding sections is a DOWNGRADE; the beauty is the restraint.
(Run 20's entry stays above — history is history.)

**Observed first.** Fresh walkthrough post-revert, then a gap scan
against every mainstream chat UI: the app has copy, edit-&-resend,
TTS, Stop, duel, search — but NO regenerate for completed answers.
Retry existed only on the error card. A bad answer had no one-click
second chance — the most standard expectation in chat products, and
a daily-use conversion lever (a disappointing answer is where users
churn).

**The change: REGENERATE with variant history.**
- A refresh icon in the last answer's provenance row: one click
  re-rolls the turn. The current answer is snapshotted FIRST —
  nothing is ever lost.
- A compact `‹ 2/4 ›` navigator appears once a turn has history;
  flipping swaps the answer AND its full receipt (model · pool ·
  tokens · cache · effort) — per-variant honesty, not just text.
- Variants persist (new `variants` JSON + `variantIndex` columns on
  Message, `/api/chat/variant` POST that mirrors the active variant
  into the row's content/model so every existing reader — export,
  search, canvas — stays correct). Chains accumulate across
  sessions and survive reload.
- Server-truth cleanup: regenerate reuses the edit flow's
  `/api/chat/truncate` primitive (messageId only, content
  untouched) to delete the superseded answer row — verified in the
  DB that NO duplicate turns appear after regen + reload.
- Temporary chats: everything works, zero DB writes (regen is
  local-only there, like the sends).
- Errors keep their dedicated Retry card (regenerate hides on
  error/duel/runner-up messages — no overlapping recovery paths).

**Two real bugs caught during verification (fixed before ship):**
1. DUPLICATE-ROW BUG (found by DB inspection, not the UI): the first
   cut dropped the old answer only from the local timeline, leaving
   its row in SQLite — a reload would have shown the same turn
   twice. Exactly the "cook but not break" failure mode the user
   warned about. Fixed via truncate-before-restream; DB now shows
   exactly one assistant row per turn.
2. STALE PRISMA CLIENT: `/api/chat/variant` 500'd with "Unknown
   argument `variants`" — db:push generated a new client but the
   running dev server kept the old one (its SELECTs didn't even
   include the new columns). Dev-server restart fixed it. Lesson:
   after schema changes, restart before trusting runtime results.

**Bonus correction (wrong things):** the 5 pre-existing tsc errors
in `selectChat` (`altContent`/`altModel` not on UIMessage) — the
fetched rows are now properly typed with unknown-narrowing, and the
new variants columns flow through the GET route parsed. **tsc:
13 → 8 errors, zero new.**

**Verified (all real):**
- Send → regenerate → `2/2` nav appears; the fresh answer's receipt
  renders (cache: hit) while variant 1 carries the ORIGINAL receipt
  (2.4k tokens · cache: miss) — flipping swaps both text and receipt.
- DB row: `variantIndex: 1`, `vCount: 2`, per-variant cached flags
  `[false, true]`; exactly one assistant row (no duplicates).
- Reload → sidebar → chat opens with `1/2` + original receipt +
  regenerate available on restored chats; regen there grows the
  chain to `4/4` (`cachedFlags [false,true,false,true]`), still
  exactly one row.
- Temporary chat: regen works, nav `2/2`, 0 DB rows for the turn.
- Mobile 390×844: nav fits, `scrollWidth == 390`, sidebar/chat flows
  intact; desktop welcome byte-identical to Run 19 (lineup gone).
- Hydration check after the one dev-time mismatch: 0 warnings on
  welcome load, welcome reload, chat open, chat reload (the single
  warning was a Turbopack hot-reload artifact, not reproducible).
- lint 0 errors (2 pre-existing script warnings), page errors none,
  dev.log clean.

**Scope discipline:** schema +2 columns, one new small API route,
store actions (`regenerate`, `navigateVariant`) reusing the existing
streamTurn/retryLast/truncate machinery, one meta-row UI addition.
No redesign, no removed features, welcome untouched — pure
capability upgrade on the surface users live on.

---

## Run 22 — 2026-11-03: THE IMAGE FORGE — images are born in the chat

**User request.** "Good job, again look at the site first, then
innovate. Think about the user experience and think outside the box.
Make one bold change that improves conversions or the look and feel,
not a small tweak… don't make redundant things — only improvements
and upgrades, correcting wrong things and adding useful things, cook
but not break or downgrade."

**Observed first.** Fresh walkthrough (welcome intact at Run 19
form, chat flows with Run 21's regenerate verified live, rail
audited). Gap scan against the standing list: the app had text,
search, duels, canvas, files, voice, regenerate — but ZERO image
capability, while both ChatGPT and Gemini generate images in-chat.
Image generation is one of the top reasons people try an AI chat
product at all; for a "personal gateway" it was the single boldest
non-redundant addition available. The studio's Z.ai image engine
(probed first from the backend: 1024² JPEG in 65s, base64 response)
made it real — no pooling tricks, no fakes.

**The change: Image Forge — a full image pipeline in the chat.**
- **Composer Image pill** (between Search and Effort): arms the
  forge for the next send. Mutually exclusive with Search + Duel by
  construction (arming one disarms the others — a send can never be
  ambiguous). Also in the "+" menu, the /image slash command, and
  the ⌘K palette ("Generate an image").
- **Dimensions picker** ("at Landscape" pill while armed): Square
  1024², Portrait 768×1344, Landscape 1344×768, Wide 1440×720 —
  each with an honest use-case hint.
- **Live generating card**: amber shimmer sweep at the chosen aspect
  ratio, floating icon, and a REAL elapsed-seconds counter ("4s ·
  the forge usually takes 30–90s · 1344x768") — the engine is slow,
  so the card proves it's alive. Reduced-motion: static tint.
- **Settled image card**: rounded bordered image, hover-zoom
  affordance, click → fullscreen lightbox (Esc closes), one-click
  download (`?download=1` → Content-Disposition), prompt caption.
- **Honest provenance, per image**: "Image Forge · 1344×768 ·
  121 KB · 27.1s · 0 pool tokens" — the receipt states the engine,
  the dimensions, the file size, the forge duration, and that ZERO
  pooled tokens were spent (the forge runs on the Z.ai image
  engine, never on the pool's keys).
- **Re-rolls keep everything (Run 21 machinery, extended)**:
  regenerate on an image turn snapshots the current image into the
  variant history and re-forges the same prompt + dimensions; the
  ‹ 2/2 › navigator flips between images AND their receipts; the
  variant route now mirrors the active ImageRef into the row's
  `image` column exactly as it mirrors content/model.
- **Persistence, honestly**: `Message.image` (JSON ImageRef — id on
  disk, dims, bytes, ms, prompt). `content` carries a text marker
  ("Generated image — "…" (1344×768)") so search, export (real
  markdown image link), and model history all stay meaningful.
  Image bytes live in `generated-images/` on disk (never in
  SQLite), served by `/api/image/file/[id]` with a strict id
  pattern (traversal-proof, verified 404) and immutable caching.
- **Lifecycle parity with text turns**: Stop aborts the forge (the
  server discards the orphan file — verified: no third file after
  the aborted run); failures render the standard error card with a
  forge-specific "Retry the forge" button (no meaningless
  "Switch model"); temporary chats forge with ZERO DB writes.

**One real bug caught during verification (fixed before ship):**
opening an image chat ADOPTED its stored `model: "image-forge"` as
the composer's model — a text follow-up then requested a model the
pool doesn't have and fell to cloud failover with a wrong receipt
("Image Forge · cloud failover · 1.3k tokens"). Fix: selectChat now
refuses to adopt the pseudo-model (falls back to the default pool
model); the stray test row was corrected in the DB; re-verified:
follow-up renders "GLM 5.3 · APInex pool · 2.7k tokens · cache:
miss". Exactly the "cook but not break" failure mode the user
warned about — caught by reading the receipt, not the screenshot.

**Verified (all real):**
- Armed state: placeholder swaps to "Describe the image to forge…",
  amber pill, "at" dimensions pill, toast.
- Forge: 1344×768 PNG generated (27.1s first, 72.6s re-roll);
  generating card screenshotted mid-count; user bubble shows the
  "Image · 1344x768" badge.
- Receipt: "Image Forge · 1344×768 · 121 KB · 27.1s · 0 pool
  tokens"; DB shows exactly ONE assistant row with the ImageRef.
- Lightbox opens (aria-dialog) and closes via Escape.
- Re-roll → "2/2"; flip back → ORIGINAL image returns with ITS OWN
  receipt (27.1s vs 72.6s); DB: vCount 2, variantIndex 0 mirrored,
  per-variant ms [27134, 72616], still exactly one row.
- Reload → sidebar → chat reopens with image loaded, "1/2" nav,
  receipt restored (immutable file cache hit); refined title
  "Bioluminescent Forest Night" (title pass works for image chats).
- Text follow-up in an image chat: correct GLM 5.3 provenance.
- Temporary chat + Stop: error card "Image generation stopped.
  Retry the forge"; 0 DB rows; no orphan file.
- Mobile 390×844: image card fits (316px), nav visible, no page
  overflow; desktop welcome byte-stable (headline, pills, no
  lineup).
- Hydration: 0 warnings on clean welcome load AND on chat open
  (the two console entries were mid-session Fast-Refresh artifacts
  during editing — non-reproducible on clean loads, matching the
  Run 21 baseline note).
- lint 0 errors (2 pre-existing script warnings); tsc 8 errors =
  exact pre-run baseline, zero new; page errors none; dev.log
  clean (image column flowing through Prisma).

**Scope discipline:** schema +1 column, 2 new API routes (generate
+ file serve), one server lib (SDK call + disk store), store state
(imageMode/imageSize/sendImage) reusing the existing
abort/variant/truncate/title machinery, one pill + one popover +
two cards in the timeline. Welcome untouched, no existing behavior
changed except the mutual-exclusion toggles and the selectChat
pseudo-model guard (both fixes, not regressions).

---

## Run 23 — 2026-11-03: THE GALLERY — images get a history, like chats

**User request.** "Good job, add an images section for displaying
all the images that was generated (like chats history, but image
history). And again, look at the site first, then innovate…
don't make redundant things — only improvements and upgrades,
correcting wrong things and adding useful things, cook but not
break or downgrade."

**Observed first.** Fresh walkthrough (welcome at Run 19 form,
Run 22 forge verified live in the composer). Gap scan: the forge
creates real images, but the moment a conversation scrolls away
those images are UNFINDABLE — buried per-chat, no way to re-view,
re-download or show them later. Chats have a whole history
sidebar; images had nothing. That asymmetry was the single most
requested-shaped gap left, and the user named it directly.

**The change: the Image Gallery — full image history.**
- **Sidebar "Images" row** (right under New chat, the library
  position): amber Images icon + an honest live count badge
  (disk-verified gallery size from bootstrap; +1 the instant a
  forge persists; re-checked after any chat delete). On phones the
  overlay sidebar steps aside the moment the gallery opens.
- **The Gallery view** replaces the conversation area (composer
  hides — it's a destination, not a chat; an in-flight stream keeps
  its Stop button mounted). A true CSS masonry (2→5 columns by
  breakpoint) of EVERY forged image from EVERY saved chat, newest
  first, staggered settle-in, aurora backdrop in the app's
  language. Hover overlay: prompt, birth chat, time-ago.
- **Lightbox with full provenance**: dims · KB · forge seconds ·
  date · position counter; ←/→ walk the whole collection, Esc
  closes; one-click Download; and **"Open in chat"** — lands you
  in the conversation the image was born in (gallery closes,
  timeline opens).
- **Honest listing, by construction**: active images AND re-roll
  variant snapshots are listed (a re-rolled image was still
  forged); temporary chats never appear (no DB rows, same contract
  as chats history); deleted chats take their images with them
  (cascade); a tile only exists while its file exists on disk.
- **Empty state = conversion hook**: "Nothing forged yet" + one
  button — arms Image mode on a fresh chat, composer placeholder
  already asking for the prompt.
- **Wired everywhere it should be, nowhere it shouldn't**: ⌘K
  palette gains "Browse the image gallery"; every navigation (new
  chat / enter chat / mode switch / any send) closes the gallery so
  it can never strand the user; sending FROM the gallery (possible
  only mid-stream) returns to the conversation so the reply is
  visible.

**One real bug caught during verification (fixed before ship):**
flipping a re-rolled image back and forth mirrors the SAME file
into both the active slot and a variant slot (Run 22's variant
mirror) — the first gallery render showed that file twice with
duplicate React keys (console errors, real). Fix: the gallery
counts FILES, not slots — per-message dedupe by image id, active
slot wins. Verified: the forest message's 3 slots → 2 tiles, all
keys unique, console clean.

**Verified (all real):**
- API: `/api/images` → 4 unique images (incl. variant snapshots,
  dedupe proven by DB inspection: same file in active + variant
  slot); `?count=1` and bootstrap `imageCount` agree.
- Desktop: sidebar row + badge "4" → gallery masonry (5 columns
  at 1280, aurora, composer hidden) → lightbox provenance
  "1024×1024 · 103 KB · 27.8s · Mon, Nov 2, 2026 · 1 / 5" →
  ArrowRight flips to 2/5 with ITS OWN receipt (different file,
  KB, seconds) → "Open in chat" lands in the birth chat with the
  composer back.
- Palette: "gallery" fuzzy-match → "Browse the image gallery | 5"
  → opens the gallery.
- End-to-end forge: fresh chat → Image pill armed (placeholder
  swaps) → fox prompt → generating card with live counter →
  settled ~30s → sidebar badge increments 4 → 5 LIVE (no
  refetch) → gallery reopens with 5 tiles, fox FIRST (newest
  first proven).
- Empty state (mock-routed, zero DB touch): "Nothing forged yet"
  + CTA → gallery closes, composer returns, placeholder "Describe
  the image to forge…", aria-pressed=true.
- Mobile 390×844: Images tap closes the overlay sidebar; gallery
  2-column masonry, no horizontal overflow; lightbox image fits
  width, buttons stack clean (VLM-checked).
- Welcome screen: untouched, VLM-verified byte-stable Run 19 form
  (ring, headline, clock, stat chips, 2×2 starters).
- Clean-session console: 0 errors / 0 warnings across load →
  gallery → lightbox → arrows → Esc; lint 0 errors (2 pre-existing
  script warnings); tsc 8 errors = exact baseline, zero new;
  dev.log clean (`GET /api/images 200`).

**Scope discipline:** one new server lib (gallery query + disk
verification) + one new API route (`/api/images`, count mode),
bootstrap +1 field, store +2 fields +4 lines of navigation
hygiene (close-on-nav, close-on-send, count bookkeeping), one new
component (ImageGallery), one sidebar row, one palette action,
SenkuApp render branch. Zero changes to WelcomeScreen, ChatTimeline
behavior, the forge pipeline, or any existing receipt.

---

## COMPETITOR GAP LIST

Standing snapshot of what Claude / ChatGPT / Gemini have that we
have not yet matched or beaten (updated per run; items close as
they ship).

| Gap | Competitor | Status |
| --- | --- | --- |
| File uploads with real content understanding (docs, images) | all three | **BEATEN (Run 9)** — we read text/code/PDF (text-layer) and images (pooled VISION pass: OCR + visual description), AND show per-file extraction provenance (chars read, truncation, method) the incumbents hide; unreadable files are honestly not sent |
| Canvas / artifacts side-panel for long code+docs | ChatGPT, Claude | **MATCHED (Run 17)** — Senku Canvas: per-block Copy/Wrap/Preview controls, sandboxed (script-less, network-less) html/svg/mermaid previews in a split panel; js/py honestly view-only |
| Scheduled prompts / recurring tasks | ChatGPT, Gemini | OPEN |
| Memory across chats | ChatGPT, Claude | OPEN (deliberately: personal gateway, no profile harvesting) |
| Code interpreter / sandboxed execution | ChatGPT | OPEN |
| Image generation in-chat | ChatGPT, Gemini | **MATCHED (Run 22)** — the Image Forge: composer mode + dimensions picker, live elapsed-time generating card, lightbox + download, per-image provenance receipts (dims · KB · seconds · 0 pool tokens) and re-roll variant history with per-image receipts — ChatGPT shows none of that honesty |
| Image history / gallery across chats | ChatGPT (Library/Photos), Gemini (saved images) | **MATCHED (Run 23)** — the Gallery: sidebar Images row with live count, masonry of every forged image from every chat (variant snapshots included, file-deduped), lightbox with full provenance + collection browsing (←/→) + one-click Download + "Open in chat" jump-to-source, empty-state forge CTA |
| Projects / folders with per-project instructions | ChatGPT, Claude | OPEN |
| Voice mode (live duplex conversation) | ChatGPT, Gemini | PARTIAL — we have push-to-talk dictation + read-aloud |
| Deep research (multi-step agentic search) | Gemini, ChatGPT | **MATCHED (Run 8)** — plan → multi-angle retrieve → cross-check, with per-source date/authority audits the incumbents don't surface; every stage streams live |
| Thinking mode / effort levels (fast–medium–deep) | ChatGPT, Claude, Gemini | **BEATEN (Run 8)** — theirs toggles one backend's switch; ours routes to a different pooled ENGINE per level with transparent previews |
| **In-chat model duels** | **none of the three** | **SHIPPED (Run 7) — differentiator** |
| Grounded-answer confidence contract + visible audit | none (Gemini's "double-check" is sentence-level, undated) | SHIPPED (Runs 4+6) — differentiator |
| Per-message provenance (provider/key/tokens/cache) | none | SHIPPED (Runs 1+3) — differentiator |
| Health-aware pooled routing with visible billing | none (single-backend) | SHIPPED (Run 1) — differentiator |
