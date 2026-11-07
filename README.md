<div align="center">

<img src="https://senku.space-z.ai/senku-sparkle.png" alt="Senku Logo" width="80" />

# Senku

**Personal AI Gateway · Agent · Autonomous Core**

[![Live Demo](https://img.shields.io/badge/Live%20App-senku.space--z.ai-blue?style=for-the-badge&logo=vercel)](https://senku.space-z.ai)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?style=for-the-badge&logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-38bdf8?style=for-the-badge&logo=tailwindcss)](https://tailwindcss.com)
[![Bun](https://img.shields.io/badge/Runtime-Bun-fbf0df?style=for-the-badge&logo=bun)](https://bun.sh)
[![Prisma](https://img.shields.io/badge/ORM-Prisma-2D3748?style=for-the-badge&logo=prisma)](https://prisma.io)

</div>

---

## What is Senku?

**Senku** is a self-hosted personal AI gateway that routes your prompts across a pool of frontier models — with health-aware key dispatch, 3-tier token pacing, grounded search, Duel Mode, an effort dial, file understanding, voice, and a full chat UI — all honest about what it consumes and why.

> One gateway. Five frontier engines. All free tier. Every answer tells you exactly which model served it, which key it used, and how many tokens it cost.

---

## ✨ Feature Highlights

### 🔑 Pooled Key Routing & Health-Aware Dispatch
Round-robin across provider keys with an in-memory circuit breaker. Auth failures (401/403) quarantine a key for 10 minutes; transient failures cool down for 60 seconds. The next healthy key picks up — no dropped turns, honest billing to the key that actually served.

### ⚡ 3-Tier Token Pacing
Three budget tiers per provider — daily pace, monthly pool, and lifetime — all windowed to **01:00 Africa/Algiers** (computed, never scheduled). The pill shows today's real usage; the dialog shows all-time. Estimates are marked `≈`, exact counts are exact.

### 🌐 Grounded Search with Source Auditing
Every search result carries a `dateHint` and an authority tier (official → press → reference → blog → forum). The model is told which sources can and cannot support a factual claim. Every answer ends with exactly one `[confirmed]` / `[partial]` / `[stale sources]` confidence badge — rendered as a colored pill, never as bracket text.

### ⚔️ Duel Mode
Two frontier models race the same prompt simultaneously, with a shared search retrieval. Both stream live side-by-side. You click **Keep** on the winner; the loser collapses as a runner-up reference. Auto-challenger picks a different model family by default.

### 🎚️ Effort Dial — Fast / Medium / Deep
- **Fast ⚡** routes to the fastest engine (Gemini 3.8 Flash), with a terse system addon
- **Medium ✦** is byte-identical to your model selection — cache hits still land
- **Deep 🧠** routes to the strongest engine (Qwen 3.8 Max), runs a multi-angle search pipeline (plan → verbatim → parallel angles → 8 merged sources), and structures the answer as Evidence / Disagreements / Gaps

### 📎 Real File Understanding
Files are read **at pick time**, before you send. Per-file chips show exactly what the model will receive:
- **Text/code/CSV/JSON** → UTF-8 extraction with binary sanity gate
- **PDF** → text-layer extraction via `unpdf`; scanned PDFs fail honestly
- **Images** → pooled vision pass (OCR + visual description)

Truncation is marked in-band (`✂`). Unreadable files show a red error and are never sent.

### 🖼️ Senku Canvas
Every code block gets **Copy · Wrap · Preview** controls. Supported previews (`html · svg · mermaid`) open in a sandboxed iframe with `sandbox=""` and `default-src 'none'` CSP — zero external network, zero allow-scripts. Mermaid is pre-rendered server-side via the bundled `mermaid@12` and independently sanitized before entering the iframe.

### 🎤 Voice Core
Voice input mode — hands-free interaction via the voice button in the top bar.

### 🔁 Restart Marker — No Duplicated Answers
If a provider dies mid-stream after partial text has already reached the client, the SSE protocol emits a `restart` event before the cloud takes over. The client clears its buffer — no corrupted partial + full duplicate. The partial is persisted to DB; the cloud re-serves cleanly.

### 🛡️ Self-Healing Database
The Prisma client is wrapped in a `$extends` query extension that catches SQLite `readonly database` errors (codes 8 and 1032), disconnects and reconnects in a single-flight heal, then retries once. A `git stash` or inode replacement under the running server can never permanently kill the pool.

### 🔤 Word-by-Word Typewriter
A `requestAnimationFrame` typewriter gate (30 wps, `MAX_FRAME_DT_MS` = 100) decouples visual pacing from network speed. Click anywhere on streaming text (or the Skip pill) to reveal the full answer. Auto-scroll follows the bottom; scrolling up unpins it. `prefers-reduced-motion` skips the reveal entirely.

### 🧹 Developer Input UX
- Pastes > 60 lines collapse to a removable **Pasted snippet · N lines** pill — staged client-side, sent through the attachments pipeline
- `/` command popover (`/code`, `/concise`, `/search`) with keyboard navigation — applying strips the token and arms a one-shot pill; the resulting system addon namespaces the cache key so medium-no-style hits are unaffected
- IME-composition guard so CJK composers never accidentally submit

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Next.js App                       │
│  WelcomeScreen · ChatTimeline · InputBar · Canvas    │
└──────────────────────┬──────────────────────────────┘
                       │  SSE / JSON
┌──────────────────────▼──────────────────────────────┐
│                   Gateway Layer                      │
│  runChatTurn · runDuelTurn · dispatchCompletion      │
│  ┌─────────────────────────────────────────────┐    │
│  │  Key Health  │  Router  │  Executor         │    │
│  │  circuit     │  round-  │  tryProviderStream│    │
│  │  breaker     │  robin   │  zaiCloudExec     │    │
│  └─────────────────────────────────────────────┘    │
│  Grounding (authority tiers · date hints)            │
│  Search (DDG · cloud · deep multi-angle)             │
│  Attachments (text · pdf · vision)                   │
│  Response Cache (24h · per model · per effort)       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│          Prisma ORM · SQLite WAL (5s timeout)        │
│  Chat · Message · UsageEvent · ResponseCache         │
│  Provider · Key · User                               │
└─────────────────────────────────────────────────────┘
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Framework** | Next.js 16 (App Router, standalone output) |
| **Language** | TypeScript 5 |
| **Runtime** | Bun |
| **Styling** | Tailwind CSS v4 + shadcn/ui + Radix UI |
| **ORM** | Prisma 6 · SQLite (WAL mode, 5s busy timeout) |
| **Auth** | NextAuth.js v4 |
| **State** | Zustand · TanStack Query |
| **Animations** | Framer Motion · custom `requestAnimationFrame` gates |
| **Forms** | React Hook Form + Zod v4 |
| **Markdown** | react-markdown · remark-gfm · react-syntax-highlighter |
| **Diagrams** | mermaid@12 (lazy, `securityLevel: strict`) |
| **PDF** | unpdf (serverless pdf.js) |
| **DnD** | @dnd-kit |
| **Reverse Proxy** | Caddy (Caddyfile included) |
| **Testing** | Python test suite (`tests/test_hermes.py`) |

---

## 📁 Project Structure

```
SenkuAPI/
├── src/
│   ├── app/                  # Next.js App Router (pages, API routes)
│   │   └── api/
│   │       ├── v1/           # OpenAI-compatible completions endpoint
│   │       ├── chat/         # send · duel · title · pick routes
│   │       ├── chats/        # CRUD for chat history
│   │       ├── attachments/  # /extract multipart endpoint
│   │       └── usage/        # limiter snapshot
│   ├── components/senku/     # UI components (ChatTimeline, InputBar, Canvas…)
│   ├── hooks/                # use-count-up, use-sticky-scroll…
│   ├── lib/senku/            # Core gateway logic
│   │   ├── gateway.ts        # runChatTurn / runDuelTurn
│   │   ├── dispatch.ts       # health-aware orchestrator
│   │   ├── executor.ts       # tryProviderStream / zaiCloudExec
│   │   ├── router.ts         # round-robin key picker
│   │   ├── keyhealth.ts      # circuit breaker
│   │   ├── grounding.ts      # date hints + authority tiers
│   │   ├── search.ts         # DDG · cloud · deepSearchDetailed
│   │   ├── attachments.ts    # text · pdf · vision extraction
│   │   ├── limiter.ts        # 3-tier token pacing
│   │   ├── models.ts         # modelMeta · effortModel · autoChallenger
│   │   ├── export.ts         # Markdown / JSON chat export
│   │   └── constants.ts      # system prompts + directives
│   └── store.ts              # Zustand store
├── prisma/                   # Schema + migrations
├── db/                       # DB helpers + seed
├── docs/                     # Internal documentation
├── generated-images/         # Image generation output
├── scripts/                  # One-off experiment scripts
├── examples/websocket/       # WebSocket usage examples
├── tests/                    # Python test suite
├── public/                   # Static assets
├── Caddyfile                 # Reverse proxy config
├── .env.example              # Environment variable template
└── IMPROVEMENTS.md           # Full continuous improvement log (32+ runs)
```

---

## ⚙️ Getting Started

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- Python 3 (for the test suite)
- A database — SQLite works out of the box

### 1. Clone & install

```bash
git clone https://github.com/islamMendjel/SenkuAPI.git
cd SenkuAPI
bun install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Key variables:

```env
DATABASE_URL="file:./db/custom.db"
NEXTAUTH_SECRET="your-secret-here"
NEXTAUTH_URL="http://localhost:3000"
# Provider API keys go in the DB via the admin panel, not in .env
```

### 3. Set up the database

```bash
bun run db:push          # dev: push schema (accepts data loss)
# or
bun run db:migrate       # prod: run migrations
```

### 4. Run the dev server

```bash
bun run dev
```

Open [http://localhost:3000](http://localhost:3000).

> **Note:** After any `prisma db push`, restart the dev server to pick up the regenerated client. Never `git stash` while the dev server is running — the self-healing DB wrapper will recover, but it's cleaner to avoid it.

---

## 🏗️ Building for Production

```bash
bun run build
bun run start
```

The build uses Next.js standalone output — the entire server bundles into `.next/standalone/server.js`.

### With Caddy

```bash
caddy run --config Caddyfile
```

### Starting the dev server safely (double-fork orphan for the sandbox)

```bash
( setsid bun run dev < /dev/null > /dev/null 2>&1 & )
```

---

## 🧪 Running Tests

```bash
bun run test:hermes        # Python integration suite
# or directly:
python3 tests/test_hermes.py
```

The test suite exercises the gateway API end-to-end, including key routing, search grounding, duel mode, effort levels, and attachment extraction.

---

## 📡 OpenAI-Compatible API

Senku exposes a `/api/v1/chat/completions` endpoint compatible with the OpenAI chat completions format, so it can be used as a drop-in backend for any OpenAI-compatible client.

```bash
curl -X POST http://localhost:3000/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "free/glm-5.3",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

The response includes a `senku` metadata field with the serving key, provider, effort level, and failover status.

---

## 🔒 Security Notes

- **Senku Canvas iframes** use `sandbox=""` (no allow-scripts, no allow-same-origin) + `Content-Security-Policy: default-src 'none'`. No external resources can load inside a preview.
- **Mermaid diagrams** are pre-rendered server-side via `mermaid@12` with `securityLevel: 'strict'`, then independently sanitized (scripts, foreignObject, `on*` attributes, external URLs stripped) before entering the iframe.
- **File extraction** runs a binary sanity gate on text files (control-char ratio) so executables are never decoded as text. The `/api/attachments/extract` route sanitizes every field in the returned record — the send route never trusts client JSON.
- **Provider API keys** live in the database, not in `.env`. Key labels are shown in provenance; raw key values are never sent to the client.

---

## 🗺️ Roadmap

The `IMPROVEMENTS.md` file is a detailed, run-by-run engineering log (32+ runs shipped). Current backlog items include:

- Projects with per-project system prompts
- Non-destructive message branching (`parent_message_id`)
- IndexedDB client-side backup
- Sliding-window context compressor
- TTFT (time-to-first-token) badge
- Reasoning accordions for thinking-mode models
- Swipe-to-open sidebar on mobile

---

<div align="center">

Built with obsession by [islamMendjel](https://github.com/islamMendjel)

*Gateway · Agent · Autonomous Core*

</div>
