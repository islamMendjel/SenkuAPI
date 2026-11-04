# Senku — Personal AI Gateway

A self-hosted AI chat gateway with pooled key routing, multi-model support,
and a full-featured chat UI. Built on Next.js, Bun, and Prisma.

## Features

- **Key pool routing** — round-robin across provider API keys with health-aware
  circuit breaking (quarantines failed keys automatically)
- **Duel Mode** — send one prompt to two models simultaneously, pick the winner
- **Effort Dial** — Fast / Medium / Deep with per-level model routing and
  deep research multi-angle search
- **File attachments** — real extraction (text, PDF text-layer, image OCR via
  vision API) with per-file provenance chips
- **Search grounding** — web search with date/authority auditing, confidence
  labels, and honest partial/stale signals
- **OpenAI-compatible bridge** — `/v1/chat/completions` and `/v1/messages`
  passthrough for external clients
- **Streaming everywhere** — rAF-gated word-by-word typewriter on all paths
  including cache hits and cloud failover
- **SQLite + WAL** — Prisma-managed schema with self-healing connection pool

## Stack

| Layer | Technology |
|---|---|
| Runtime | Bun |
| Framework | Next.js (App Router) |
| Database | SQLite via Prisma |
| Auth | NextAuth v4 |
| UI | React 19, Tailwind v4, Radix UI |
| State | Zustand |
| Validation | Zod v4 |
| Reverse proxy | Caddy |

## Setup

### Prerequisites

- [Bun](https://bun.sh) >= 1.x
- A provider API key (APInex, OxionAI, or any OpenAI-compatible endpoint)

### Install

```bash
git clone https://github.com/islamMendjel/SenkuAPI
cd SenkuAPI
bun install
```

### Configure

```bash
cp .env.example .env
# Edit .env — set NEXTAUTH_SECRET (run: openssl rand -base64 32)
# and your DATABASE_URL
```

### Database

```bash
bun run db:push       # apply schema to a fresh DB
bun run db:generate   # regenerate Prisma client
```

### Run

```bash
bun run dev           # development server on :3000
bun run build         # production build
bun run start         # start production server
```

### Production (with Caddy)

A `Caddyfile` is included. Edit it with your domain, then:

```bash
caddy run --config Caddyfile
```

## Project Structure

```
src/
  app/          # Next.js App Router pages and API routes
  components/   # React components (app-specific and UI primitives)
  lib/
    hermes/     # Core gateway logic
      dispatch.ts     # Key health-aware dispatch orchestrator
      executor.ts     # Provider stream execution
      gateway.ts      # Turn orchestration (normal, duel, effort)
      keyhealth.ts    # In-memory circuit breaker
      router.ts       # Key selection and round-robin
      search.ts       # Web search + deep research pipeline
      grounding.ts    # Date/authority auditing, confidence labels
      attachments.ts  # File extraction (text, PDF, image vision)
      export.ts       # Chat export (Markdown, JSON)
      models.ts       # Model metadata, effort routing, duel challenger
      limiter.ts      # Usage accounting, daily window (01:00 Africa/Algiers)
  services/     # Decoupled microservices (gateway, tree, voice, agent, multimodal)
  hooks/        # Custom React hooks
  store/        # Zustand store
prisma/         # Prisma schema and migrations
db/             # SQLite database (gitignored — created on first run)
examples/       # WebSocket usage examples
tests/          # Python test suite (test_hermes.py)
```

## API

### OpenAI-compatible bridge

- `POST /v1/chat/completions` — OpenAI-compatible completions
- `POST /v1/messages` — Anthropic-compatible messages

Requires `Authorization: Bearer <HERMES_BRIDGE_TOKEN>` if the token is set.

## Notes

- Designed as a single-user personal gateway — SQLite and in-memory circuit
  breaker state are intentional choices for this use case.
- The `IMPROVEMENTS.md` file is a detailed engineering log of every change
  made during development.

## License

Personal project — not licensed for redistribution.
