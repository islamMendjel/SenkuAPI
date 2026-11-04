# Senku — The Autonomous AI Gateway & Voice Workspace
### Complete Deep-Dive Architectural Specification & Developer Handbook

> **Version:** 1.0.0-alpha  
> **Repository:** [https://github.com/islamMendjel/SenkuAPI](https://github.com/islamMendjel/SenkuAPI)  
> **Status:** Production-Ready Alpha (Microservices Decoupled)  
> **Tech Stack:** Next.js 16 (App Router), React 19, TypeScript 5, Tailwind CSS 4, Prisma ORM, SQLite/libSQL, Zustand, Bun runtime.

---

## Table of Contents

1. [Executive Overview & Core Identity](#1-executive-overview--core-identity)
2. [Microservices Topology & System Architecture](#2-microservices-topology--system-architecture)
   - [`core-gateway`](#1-core-gateway-srcservicesgateway)
   - [`brain-tree`](#2-brain-tree-srcservicestree)
   - [`senku-voice-jarvis`](#3-senku-voice-jarvis-srcservicesvoice)
   - [`exocore-agent`](#4-exocore-agent-srcservicesagent)
   - [`forge-service`](#5-forge-service-srcservicesmultimodal)
3. [Database Schema & Domain Models (Prisma & SQLite)](#3-database-schema--domain-models-prisma--sqlite)
4. [Routing, Key Management & The Living Pool](#4-routing-key-management--the-living-pool)
   - [The Orrery & The Fair Ring (Persistent Cursor & Anti-Drift)](#the-orrery--the-fair-ring)
   - [Self-Healing Circuit Breaker & Living Pool Prober](#self-healing-circuit-breaker--living-pool-prober)
5. [Token Accounting & The 3-Tier Limiter](#5-token-accounting--the-3-tier-limiter)
6. [Conversation Trees & Message Branching (The Fork)](#6-conversation-trees--message-branching-the-fork)
7. [External API Compatibility Bridges (OpenAI & Anthropic)](#7-external-api-compatibility-bridges-openai--anthropic)
   - [OpenAI Bridge (`/v1/chat/completions`)](#openai-bridge)
   - [Anthropic Messages Bridge (`/v1/messages` — Claude Code CLI Support)](#anthropic-messages-bridge)
8. [The Exocore: Agent Orchestrator & Tool Registry](#8-the-exocore-agent-orchestrator--tool-registry)
9. [Multimodal & Interactive Engines](#9-multimodal--interactive-engines)
   - [Cloud Image Forge (Text-to-Image & Gallery)](#cloud-image-forge)
   - [Sandboxed Canvas & JS Execution](#sandboxed-canvas--js-execution)
   - [Dual-Mode Voice Core (ASR & TTS)](#dual-mode-voice-core)
   - [Grounding & Web Search Pipeline](#grounding--web-search-pipeline)
   - [Duel Racing Engine](#duel-racing-engine)
10. [Frontend Architecture & State Machine (Zustand & Components)](#10-frontend-architecture--state-machine)
11. [Developer Cookbook: Setup & Recipes](#11-developer-cookbook)
    - [Prerequisites & Development Setup](#prerequisites--development-setup)
    - [Recipe 1: Adding a New AI Model](#recipe-1-adding-a-new-ai-model)
    - [Recipe 2: Adding a New AI Provider](#recipe-2-adding-a-new-ai-provider)
    - [Recipe 3: Adding a New Agent Tool](#recipe-3-adding-a-new-agent-tool)
    - [Recipe 4: Adding a New Canvas Preview Language](#recipe-4-adding-a-new-canvas-preview-language)
    - [Recipe 5: Modifying the Database Schema](#recipe-5-modifying-the-database-schema)
    - [Recipe 6: Pointing Claude Code CLI to Senku](#recipe-6-pointing-claude-code-cli-to-senku)
12. [Testing, Health Probes & Verification Suite](#12-testing-health-probes--verification-suite)
13. [File Tree & Architectural Map](#13-file-tree--architectural-map)

---

## 1. Executive Overview & Core Identity

**Senku** is an open-source, high-performance, autonomous **AI Gateway, Voice Core, and Conversational Workspace**. Designed to operate 100% locally with zero local GPU compute requirements, Senku acts as an intelligent intermediate layer between users, external developer CLIs, and upstream cloud model providers:

* **Zero-Local-Compute Cloud Routing:** All language model generation, image creation, and search grounding execute entirely in the cloud across pooled provider keys (APInex, OxionAI, Pollinations.ai). No GPU hardware or local model downloads are required.
* **Microservices-Inspired Domain Architecture:** The runtime is decomposed into 5 cleanly decoupled domain services under `src/services/` (`core-gateway`, `brain-tree`, `senku-voice-jarvis`, `exocore-agent`, `forge-service`), communicating via strictly typed interfaces.
* **Autonomous Voice Core ("Jarvis"):** A dedicated, hands-free voice engine running strictly in English with continuous Web Speech API listening, 1,200ms silence detection, user speech interruption handling, and spoken directive routing (`/api/voice/jarvis`).
* **Self-Healing Key Ring:** Pooled upstream keys rotate via round-robin with persistent database cursors (`cursorKeyId`), anti-drift balancing, and an automated background health prober that quarantines failing keys (401/402/403/429) before user requests encounter them.
* **3-Tier Token Pacing:** Strict token budget controls enforce monthly pool allowances, daily pacing targets (computed against Africa/Algiers timezone `01:00 → 01:00`), and rolling 5-hour burst caps for token-limited tiers.
* **Non-Destructive Conversation Trees:** Conversations are directed acyclic graphs, not tapes. Editing any turn creates an immutable sibling branch (`parentMessageId`, `branchIndex`) without deleting old history, enabling full branch navigation (`‹ 1/3 ›`).
* **Universal API Dialect Bridges:** Exposes `/v1/chat/completions` (OpenAI format) and `/v1/messages` (Anthropic format) endpoints. External tools such as **Claude Code CLI** can point directly to Senku via `ANTHROPIC_BASE_URL="http://localhost:3000"`, enjoying pooled key failover and rate management transparently.
* **The Exocore ReAct Agent:** Autonomous multi-turn ReAct execution loop (`/api/agent/run`) equipped with browser-mimicking DuckDuckGo search, safe math evaluation, gateway telemetry introspection, and the Jev AI ensemble arbitrator (`free/jev-1.13` on `/v1/decisions`).
* **Sandboxed Canvas & Execution:** In-browser sandboxed JavaScript execution runner (opaque iframe with CSP `connect-src 'none'`), sanitized Mermaid diagram rendering, and cloud-first text-to-image forge.

---

## 2. Microservices Topology & System Architecture

The Senku architecture is divided into five decoupled domains:

```mermaid
graph TD
    UI[Senku Web UI & Jarvis HUD] --> Gateway[core-gateway: Key Ring & Bridges]
    UI --> Tree[brain-tree: Directed Acyclic Tree]
    UI --> Jarvis[senku-voice-jarvis: Continuous Voice Core]

    Jarvis --> Gateway
    Jarvis --> Agent[exocore-agent: ReAct & Tools]

    Gateway --> Router[Key Orrery & 3-Tier Limiter]
    Gateway --> Cache[Exact-Match SHA-256 Cache]
    Gateway --> Upstream[Cloud Upstream Providers]

    Agent --> Grounding[DuckDuckGo & Wiki Grounding]
    Agent --> Math[Safe Math Evaluator]
    Agent --> Jev[Jev AI Decision Arbitrator]

    UI --> Forge[forge-service: Multimodal & Canvas]
    Forge --> CloudForge[Pollinations Cloud Image Forge]
    Forge --> Sandbox[Sandboxed JS Runner iframe]
```

### 1. `core-gateway` (`src/services/gateway/`)
Handles all upstream network communications, key pool rotation, and protocol bridges:
- **Upstream Dispatch:** Manages active connections to providers (APInex, OxionAI).
- **The Orrery Key Ring:** Persistent round-robin rotation stored via database cursor `cursorKeyId`.
- **Key Health & Circuit Breaker:** Detects upstream rate limits (429), auth failures (401/403), and billing blocks (402), applying progressive backoff quarantines.
- **Exact-Match Prompt Cache:** Calculates SHA-256 hashes of `(prompt + model + systemPrompt)` to return instant zero-token responses (<20ms).
- **Dialect Bridges:** `/v1/chat/completions` (OpenAI) and `/v1/messages` (Anthropic Messages API).

### 2. `brain-tree` (`src/services/tree/`)
Manages conversational state, DAG structures, and SQLite storage:
- **Non-Destructive Branching ("The Fork"):** Edits and regenerations append new sibling messages rather than modifying existing turns.
- **Active Leaf Pointer:** `Chat.activeLeafId` points to the tip of the current conversation branch.
- **Path Resolution:** Reconstructs the chronological transcript from leaf to root via `parentMessageId`.
- **Zero-Lock Database:** SQLite operating with Write-Ahead Logging (`PRAGMA journal_mode = WAL;`, `PRAGMA synchronous = NORMAL;`, `PRAGMA busy_timeout = 5000;`).

### 3. `senku-voice-jarvis` (`src/services/voice/`)
Operates the personal voice assistant subsystem:
- **Continuous English ASR:** Continuous listening using Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`) with `lang = "en-US"`.
- **Silence Auto-Trigger:** Automatically dispatches spoken turns after 1,200ms of user silence.
- **Interrupt Handling:** Immediately halts current speech synthesis (`window.speechSynthesis.cancel()`) when user begins speaking.
- **Directive Classifier (`/api/voice/jarvis`):** Routes spoken queries to mathematical evaluations, Jev AI decision consensus, Exocore tool actions, or general conversation.
- **Interactive Jarvis HUD (`JarvisCore.tsx`):** Ambient audio reactive HUD accessible via header button, Command Palette (`⌘K`), or global shortcut **`⌘J`**.

### 4. `exocore-agent` (`src/services/agent/`)
Executes autonomous multi-step tasks:
- **ReAct Execution Loop:** Multi-turn tool execution with reflection and schema-constrained tool calls.
- **DuckDuckGo Grounding:** Browser-mimicking search scraper returning dated, authority-ranked snippets.
- **Safe Math Evaluation:** Locked expression evaluator without arbitrary JavaScript execution vulnerabilities.
- **Jev AI Ensemble Arbitrator (`/v1/decisions`):** Leverages `free/jev-1.13` to resolve multi-option trade-offs with criteria-weighted ranking.

### 5. `forge-service` (`src/services/multimodal/`)
Delivers multimodal generation and visualization:
- **Cloud-First Image Forge:** Dispatches text-to-image prompts to Pollinations.ai cloud pipelines, streaming image binaries to `generated-images/` with zero local GPU load.
- **Sandboxed JS Canvas Runner:** Executes user JavaScript inside an isolated iframe with CSP `connect-src 'none'`, postMessage console tunneling, and a 5-second execution timeout.

---

## 3. Database Schema & Domain Models (Prisma & SQLite)

The database schema is defined in [prisma/schema.prisma](prisma/schema.prisma) and stored in SQLite at `db/custom.db` (configured via `DATABASE_URL` in `.env`).

```mermaid
erDiagram
    Provider ||--o{ ApiKey : "owns"
    Provider ||--o{ UsageEvent : "logs"
    ApiKey ||--o{ UsageEvent : "accumulates"
    Project ||--o{ Chat : "contains"
    Chat ||--o{ Message : "contains"
    Chat ||--o| Ritual : "dedicated thread"

    Provider {
        string id PK
        string name
        string slug
        string baseUrl
        boolean hasTokenLimit
        int tokenLimitPerKey
        float tokenMultiplier
        boolean isActive
        string models
        int rotationCursor
        string cursorKeyId
    }

    ApiKey {
        string id PK
        string providerId FK
        string label
        string keyValue
        boolean isActive
        int tokensUsedThisMonth
        string monthKey
        datetime lastUsedAt
    }

    Project {
        string id PK
        string name
        string instructions
    }

    Chat {
        string id PK
        string title
        string model
        string provider
        boolean isTemporary
        string projectId FK
        string activeLeafId
    }

    Message {
        string id PK
        string chatId FK
        string role
        string content
        string model
        string provider
        string keyLabel
        int tokens
        boolean tokensEstimated
        boolean cached
        string sources
        string effort
        string attachments
        string altContent
        string altModel
        string variants
        int variantIndex
        string image
        string ritualId
        string parentMessageId
        int branchIndex
    }

    Ritual {
        string id PK
        string title
        string prompt
        string chatId FK
        string kind
        int hour
        int minute
        int weekday
        int intervalMin
        boolean search
        boolean isActive
        datetime nextRunAt
        datetime lastRunAt
        string lastStatus
        int runCount
    }

    UsageEvent {
        string id PK
        string keyId FK
        string providerId FK
        string chatId
        string model
        int promptTokens
        int completionTokens
        int totalTokens
        float multiplier
        boolean cached
    }

    ResponseCache {
        string id PK
        string cacheKey UK
        string model
        string provider
        string content
        int tokens
        datetime expiresAt
    }

    Memory {
        string id PK
        string content
    }
```

---

## 4. Routing, Key Management & The Living Pool

The key management subsystem is located in [src/lib/hermes/router.ts](src/lib/hermes/router.ts), [src/lib/hermes/keyhealth.ts](src/lib/hermes/keyhealth.ts), [src/lib/hermes/pool.ts](src/lib/hermes/pool.ts), and [src/lib/hermes/ring.ts](src/lib/hermes/ring.ts).

### The Orrery & The Fair Ring

1. **Persistent Round-Robin:**
   Keys are ordered by `createdAt ASC` (canonical ring seats). The active seat pointer is tracked in database field `rotationCursor` and anchored by `cursorKeyId`.
2. **Atomic Seat Reservation:**
   Concurrent requests execute key selection under a promise-chain mutex, ensuring concurrent turns each reserve distinct seats and avoid dogpiling a single key.
3. **Anti-Drift Balancing:**
   For token-limited providers, if token spend spreads unevenly across keys, the router calculates `driftPct` and gently steers selection toward under-utilized keys.
4. **The Ring Ledger (`ring.ts`):**
   An in-memory ledger recording confirmed key serves (`keyId`, `label`, `seat`, `tokens`, `model`, `at`). The UI displays these live serves in the Orrery cockpit.
5. **Ring Rehearsal (`/api/usage/rehearse`):**
   A dry-run simulator endpoint that executes test picks without advancing the live rotation cursor, returning a step-by-step audit of why seats would be picked or skipped.

### Self-Healing Circuit Breaker & Living Pool Prober

#### Failure Taxonomy
The circuit breaker in `keyhealth.ts` classifies errors into three distinct states:
* `checkin` (HTTP 402): Upstream requires dashboard daily check-in. Key receives 1 strike and is quarantined for **10 minutes**.
* `auth` (HTTP 401 / 403): Invalid or suspended credential. Key receives 1 strike and is quarantined for **10 minutes**.
* `transient` (HTTP 429, 5xx, or empty network stream): Requires 2 strikes within 5 minutes, resulting in a **60-second cooldown**.

#### The Background Prober (`pool.ts`)
* Arms at boot via [src/instrumentation.ts](src/instrumentation.ts).
* Every **30 seconds**, it executes a lightweight liveness test (`max_tokens: 1`) on unproven or cooldown-expired keys.
* If a key returns `200 OK`, it immediately re-enters the active rotation (`noteKeySuccess`).
* Probes never count toward the user's token usage ledger (`countServe: false`).

---

## 5. Token Accounting & The 3-Tier Limiter

The token pacing engine is defined in [src/lib/hermes/limiter.ts](src/lib/hermes/limiter.ts).

### Unlimited vs Token-Limited Providers
* **APInex:** `hasTokenLimit = false`. Pacing limiter never blocks. Usage is tracked with a `4.0x` multiplier for informational reporting.
* **OxionAI:** `hasTokenLimit = true`. Token budget is enforced strictly across three temporal tiers.

### The Three Tiers (for Token-Limited Providers)

| Tier | Window / Basis | Calculation | Threshold Action |
| :--- | :--- | :--- | :--- |
| **Tier 1: Monthly Pool** | Calendar Month (Reset on 1st of month) | $500{,}000 \times \text{activeKeys}$ | Blocks all requests if monthly accumulator $\ge \text{Limit}$. |
| **Tier 2: Daily Pace** | Usage Day ($01{:}00 \to 01{:}00$ `Africa/Algiers`) | $\frac{\text{Monthly Pool}}{30}$ per day | Soft/hard pace status alerting; enforces daily budget. |
| **Tier 3: 5H Burst** | Rolling 5-Hour Time Window | $2 \times \text{Hourly Average Pace}$ | Prevents rapid exhaustion from automated bursts. |

---

## 6. Conversation Trees & Message Branching (The Fork)

Located in [src/lib/hermes/tree.ts](src/lib/hermes/tree.ts), Senku implements a full directed acyclic graph for chats:

```
             [Message 1: User]
                     │
            [Message 2: Assistant]
                     │
            [Message 3: User]
             /               \
   [Message 4a: Assist]   [Message 4b: Assist (Edited)]
           │                       │
   [Message 5a: User]      [Message 5b: User]
```

### Tree Invariants & Mechanics
1. **Never Overwrite:** Editing or regenerating an assistant response creates a new message row with the same `parentMessageId` and an incremented `branchIndex`.
2. **Active Leaf Pointer:** `Chat.activeLeafId` stores the message ID representing the tip of the currently active branch.
3. **Path Resolution (`resolveActivePath`):** Starting from `activeLeafId`, the engine traverses up through `parentMessageId` to the root, ordering messages chronologically for display.
4. **Timeline Branch Controls:** In [src/components/hermes/ChatTimeline.tsx](src/components/hermes/ChatTimeline.tsx), messages with siblings display branch switchers (`‹ 1/3 ›`), allowing users to jump between alternate realities at any split point.

---

## 7. External API Compatibility Bridges (OpenAI & Anthropic)

Senku allows external tools, IDE extensions, and CLIs to interact with its pooled provider keys.

### OpenAI Bridge
* **Endpoint:** `POST /v1/chat/completions` (and `/api/v1/chat/completions`)
* **Source:** [src/app/v1/chat/completions/route.ts](src/app/v1/chat/completions/route.ts)
* **Functionality:** Accepts standard OpenAI payload formats. Supports raw JSON and SSE streaming (`text/event-stream`). Automatically retries failed upstream pooled keys inside the same open HTTP connection before failing over.

### Anthropic Messages Bridge
* **Endpoint:** `POST /v1/messages`
* **Source:** [src/app/v1/messages/route.ts](src/app/v1/messages/route.ts) and [src/lib/hermes/anthropic-bridge.ts](src/lib/hermes/anthropic-bridge.ts)
* **Purpose:** Enables tools configured for Anthropic (such as **Claude Code CLI**) to use Senku directly.

#### Translation Specification

| Anthropic Concept | Transformed To (OpenAI Upstream) | Returned To Anthropic Client |
| :--- | :--- | :--- |
| `system: string \| Block[]` | System prompt message (`role: "system"`) | Handled internally |
| `role: "user"`, content blocks | Text content merged into user message | Message start / Content delta |
| `tool_use` block | `tool_calls` array in assistant message | `content_block_start(type: "tool_use")` |
| `tool_result` block | Message with `role: "tool"` & `tool_call_id` | Tool execution completed |
| `tools: [{ input_schema }]` | OpenAI `functions` schema format | Tool definitions passed through |
| SSE Stream Format | Translates OpenAI `data: { choices: [...] }` | `message_start` $\to$ `content_block_delta` $\to$ `message_stop` |

---

## 8. The Exocore: Agent Orchestrator & Tool Registry

Located in [src/lib/agent/orchestrator.ts](src/lib/agent/orchestrator.ts) and [src/lib/agent/tools/index.ts](src/lib/agent/tools/index.ts), the **Exocore** is Senku's autonomous ReAct agent loop.

```mermaid
flowchart TD
    Start([User Input with /agent]) --> Prompt[Build Agent System Prompt with Tool Schemas]
    Prompt --> LLM[Dispatch Model Completion via Pooled Keys]
    LLM --> Parse{Is Output a Tool Call?}
    Parse -- "Strict JSON Tool Call" --> Exec[Execute Agent Tool]
    Exec --> Result[Append Tool Result to Message Context]
    Result --> TurnCheck{Turn < MaxTurns?}
    TurnCheck -- Yes --> LLM
    TurnCheck -- "Exceeded (Max 8)" --> Synthesize[Force Synthesis Answer]
    Parse -- "Natural Language Prose" --> FinalAnswer([Stream Final Markdown Answer])
    Synthesize --> FinalAnswer
```

### Registered Tools
1. `web_search`: Executes live search via DuckDuckGo with browser-mimicking headers, clamping results to 3 dated, clean snippets ($\le 300$ chars).
2. `calculator`: Evaluates mathematical expressions using a locked character whitelist (`safeMathEvaluate`), preventing code injection while supporting arithmetic, trigonometric, and power functions.
3. `system_status`: Inspects live gateway telemetry: active provider, rotation cursor, key health statuses, token usage in the last 24h, and total chat counts.
4. `jev_decide`: Invokes the Jev AI ensemble model (`free/jev-1.13` on `/v1/decisions`) to arbitrate between 2 to 8 conflicting options according to user-defined criteria.

---

## 9. Multimodal & Interactive Engines

### Cloud Image Forge
* **Server Logic:** [src/lib/hermes/imagegen.ts](src/lib/hermes/imagegen.ts)
* **Gallery UI:** [src/components/hermes/ImageGallery.tsx](src/components/hermes/ImageGallery.tsx)
* **Zero Local Compute:** Prompts are sent to cloud image generation endpoints (e.g. Pollinations.ai). The generated binary is retrieved via HTTP and saved to disk in `generated-images/` (`img-<timestamp>-<hash>.jpg`).
* **Supported Aspect Ratios:** `square` (1024x1024), `portrait` (768x1024), `landscape` (1024x768), `wide` (1280x720).

### Sandboxed Canvas & JS Execution
* **Canvas Panel:** [src/components/hermes/CanvasPanel.tsx](src/components/hermes/CanvasPanel.tsx)
* **Sandboxed Runner:** [src/lib/hermes/js-runner.ts](src/lib/hermes/js-runner.ts)
* **Preview Languages:** `html`, `svg`, `mermaid`, `javascript`, `python` (syntax-highlighted).
* **Security Model:**
  * Previews render inside an iframe with an empty `sandbox` attribute (disallowing scripts, forms, and popups).
  * Strict CSP: `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:;`.
  * **JavaScript Sandbox:** Executes inside an isolated iframe with `sandbox="allow-scripts"` and CSP `connect-src 'none'`. Network primitives (`fetch`, `XMLHttpRequest`, `WebSocket`) are shadowed with throwing stubs. Console outputs stream via `postMessage` with a 5-second hard execution timeout.

### Dual-Mode Voice Core
* **Jarvis Core Mode:** [src/components/hermes/JarvisCore.tsx](src/components/hermes/JarvisCore.tsx) & [src/app/api/voice/jarvis/route.ts](src/app/api/voice/jarvis/route.ts)
  * Dedicated hands-free English conversational loop (`⌘J`).
  * Continuous speech recognition with automatic silence detection (1,200ms) and interrupt handling.
  * Spoken directive classifier returning clean speakable text and rich Markdown.
* **Full-Screen Voice Overlay:** [src/components/hermes/VoiceInterface.tsx](src/components/hermes/VoiceInterface.tsx)
  * Audio recording via `MediaRecorder` with client-side 16 kHz mono WAV conversion.
  * Server-side transcription (`/api/voice/transcribe`) and TTS (`/api/voice/speak`) with native Web Speech API browser fallbacks.

### Grounding & Web Search Pipeline
* **Source:** [src/lib/hermes/search.ts](src/lib/hermes/search.ts) and [src/lib/hermes/grounding.ts](src/lib/hermes/grounding.ts)
* **Anti-Hallucination Directives:** Without search results, models admit knowledge cutoff limits rather than invent release versions or dates.
* **Grounding Contract:** When search is active, the engine audits authority tiers (official > news > blog > forum/social) and enforces single confidence rating tags (`[confirmed]`, `[partial]`, or `[stale sources]`).

### Duel Racing Engine
* Races two models simultaneously on the same prompt (e.g. `GLM 5.3` vs `Gemini 3.8 Flash`).
* The UI displays streams side-by-side. The user selects the winning answer; the chosen response becomes the primary message, while the runner-up is saved in `altContent` and `altModel` for reference.

---

## 10. Frontend Architecture & State Machine

Senku uses a centralized Zustand store defined in [src/lib/store.ts](src/lib/store.ts) with deferred dynamic loading for secondary components.

### State Topology (`useHermes`)

```mermaid
graph TD
    Store[Zustand Store: useHermes]
    Store --> Bootstrap[Bootstrap & System Data: providers, limiter, models, user]
    Store --> ChatState[Chat & Timeline: messages, activeChatId, viewEpoch, streaming]
    Store --> ComposerState[Composer & Modes: searchEnabled, duelEnabled, effort, imageMode]
    Store --> VoiceState[Voice & Jarvis: jarvisMode, voiceMode, statusDetail]
    Store --> NavState[Navigation & Modals: sidebarOpen, canvas, limiterOpen, providersOpen]
```

### Component Hierarchy

```
src/components/hermes/
├── HermesApp.tsx              # Root shell layout, dynamic code splits, global hotkeys (⌘K, ⌘J)
├── JarvisCore.tsx             # Autonomous Hands-Free Jarvis HUD with audio reactivity
├── Sidebar.tsx                # Left navigation: Project folders, recent chats, user menu
├── TopBar.tsx                 # Header: Sidebar toggle, model indicator, token pill, Jarvis toggle
├── WelcomeScreen.tsx          # Initial view: Sparkle canvas, Living Medallion, prompt starters
├── SparkleField.tsx           # Interactive particle canvas reacting to pointer moves and clicks
├── ChatTimeline.tsx           # Message feed, branch switcher (‹ k/N ›), duel lane views, variants
├── Markdown.tsx               # Markdown formatting, syntax highlighting, runnable JS blocks
├── Typewriter.tsx             # Smooth streaming text renderer using RAF throttling
├── InputBar.tsx               # Chat input composer, slash commands (/agent, /image, /search)
├── CanvasPanel.tsx            # Split-screen tools: HTML, SVG, Mermaid, Sandboxed JS console
├── CommandPalette.tsx         # ⌘K / Ctrl+K modal: Full-text message search across SQLite
├── ProvidersDialog.tsx        # The Orrery cockpit: Key rotation visualizer & health monitors
├── TokenLimiterDialog.tsx     # 3-tier pacing limiter statistics and usage reset details
├── MemoryDialog.tsx           # Global memory management dialog
├── ProjectsDialog.tsx         # Project creation and system prompt instructions editor
├── RitualsDialog.tsx          # Scheduled prompt manager (daily/weekly/interval configurations)
├── ImageGallery.tsx           # Full-screen grid viewer for forged images
└── VoiceInterface.tsx         # Full-screen voice modal
```

---

## 11. Developer Cookbook

### Prerequisites & Development Setup

1. **Prerequisites:**
   * **Bun** ($\ge 1.1$) or **Node.js** ($\ge 20$)
   * **Python 3** (for the automated test suite)
   * **SQLite3**

2. **Quickstart Installation:**
   ```bash
   git clone https://github.com/islamMendjel/SenkuAPI.git
   cd SenkuAPI
   bun install
   cp .env.example .env
   bun run db:generate
   bun run db:push
   bun run dev
   # Accessible at http://localhost:3000
   ```

---

### Recipe 1: Adding a New AI Model

To register a new model (e.g., adding `free/mistral-large-3` to APInex):

1. **Add Model ID to Constants:**
   Open [src/lib/hermes/constants.ts](src/lib/hermes/constants.ts) and add the model string to `APINEX_MODELS`:
   ```typescript
   export const APINEX_MODELS = [
     "free/glm-5.3",
     "free/gemini-3.8-flash",
     "free/mistral-large-3", // <-- Added
     // ...
   ];
   ```

2. **Add Display Metadata & Badge Info:**
   Open [src/lib/hermes/models.ts](src/lib/hermes/models.ts) and add the configuration to `KNOWN`:
   ```typescript
   "free/mistral-large-3": { 
     name: "Mistral Large 3", 
     tier: "Free", 
     note: "General reasoning" 
   },
   ```

3. **Update Active Provider Record in Database:**
   Trigger model sync by hitting `GET /api/models?sync=1` or updating the active provider row in SQLite:
   ```bash
   bunx prisma studio
   ```

---

### Recipe 2: Adding a New AI Provider

To add an upstream provider (e.g. `Groq` or `DeepInfra`):

1. **Update Seed Data:**
   Open [src/lib/hermes/seed.ts](src/lib/hermes/seed.ts) and add an upsert call for your new provider:
   ```typescript
   const groq = await db.provider.upsert({
     where: { slug: "groq" },
     create: {
       name: "Groq",
       slug: "groq",
       baseUrl: "https://api.groq.com/openai/v1",
       hasTokenLimit: true,
       tokenLimitPerKey: 1000000,
       tokenMultiplier: 1.0,
       isActive: false,
       models: JSON.stringify(["llama-3.3-70b-versatile"]),
     },
     update: {
       baseUrl: "https://api.groq.com/openai/v1",
     },
   });
   ```

2. **Configure API Base URL in Constants:**
   Define `GROQ_BASE_URL` in [src/lib/hermes/constants.ts](src/lib/hermes/constants.ts).

3. **UI Switching:**
   Providers can be activated through the **Manage Providers** dialog in the web UI.

---

### Recipe 3: Adding a New Agent Tool

To add a tool to the Exocore Agent (e.g., a `weather_lookup` tool):

1. **Define Tool in [src/lib/agent/tools/index.ts](src/lib/agent/tools/index.ts):**
   ```typescript
   const weatherTool: AgentTool = {
     name: "weather_lookup",
     description: "Get real-time weather information for a specified city.",
     parameters: {
       type: "object",
       properties: {
         city: { type: "string", description: "City name, e.g. London, Tokyo" }
       },
       required: ["city"]
     },
     async execute(args) {
       const city = String(args.city || "").trim();
       if (!city) {
         return { summary: "weather — missing city", detail: "ERROR: city is required" };
       }
       const temp = "21°C, Clear";
       return {
         summary: `weather_lookup("${city}") → ${temp}`,
         detail: `Current weather in ${city}: ${temp}`
       };
     }
   };
   ```

2. **Register in Tool Registry:**
   In `src/lib/agent/tools/index.ts`, append `weatherTool` to the exported array:
   ```typescript
   export const AGENT_TOOLS: AgentTool[] = [
     webSearchTool,
     calculatorTool,
     systemStatusTool,
     jevDecideTool,
     weatherTool, // <-- Added
   ];
   ```

---

### Recipe 4: Adding a New Canvas Preview Language

To add rendering support for a new language (e.g., `graphviz` or `dot`):

1. **Register Language Identifier:**
   Open [src/lib/hermes/canvas-langs.ts](src/lib/hermes/canvas-langs.ts):
   ```typescript
   export const PREVIEW_LANGS = [
     "html",
     "svg",
     "mermaid",
     "javascript",
     "python",
     "graphviz", // <-- Added
   ] as const;

   const ALIASES: Record<string, PreviewLang> = {
     dot: "graphviz",
     graphviz: "graphviz",
   };
   ```

2. **Implement Preview Renderer:**
   In [src/components/hermes/CanvasPanel.tsx](src/components/hermes/CanvasPanel.tsx), add a render branch inside `renderPreviewContent()` handling `"graphviz"`.

---

### Recipe 5: Modifying the Database Schema

1. Edit [prisma/schema.prisma](prisma/schema.prisma) to add your models or columns.
2. Push changes to the SQLite database:
   ```bash
   bun run db:push
   ```
3. Generate the updated Prisma client:
   ```bash
   bun run db:generate
   ```

---

### Recipe 6: Pointing Claude Code CLI to Senku

Senku provides native support for Claude Code CLI using the `/v1/messages` bridge:

```bash
# Terminal 1: Ensure Senku server is running
bun run dev

# Terminal 2: Configure Anthropic SDK / Claude Code to use Senku
export ANTHROPIC_BASE_URL="http://localhost:3000"
export ANTHROPIC_API_KEY="senku-local-key" # Any non-empty string

# Launch Claude Code
claude
```
Claude Code commands and tool usages will route through Senku's active key pool with circuit breaker and failover protections.

---

## 12. Testing, Health Probes & Verification Suite

Senku includes an automated Python 3 test harness in [tests/test_hermes.py](tests/test_hermes.py).

### Running the End-to-End Test Suite

Ensure the local server is running on `localhost:3000`, then execute:

```bash
bun run test:hermes
# or directly:
python3 tests/test_hermes.py
```

### What the Test Suite Verifies:
1. **Bootstrap & System Status:** Probes `/api/bootstrap` to verify active providers, models, and usage counters.
2. **Chat Lifecycle:** Tests conversation creation, streaming generation (SSE validation), and title generation.
3. **Response Caching (Nonce Integrity):** Sends duplicate turns with unique run nonces to verify 0-token cache hits and response times under 20ms.
4. **Conversation Branching (The Fork):** Verifies sibling creation and branch leaf switching via `/api/chat/branch` and `/api/chat/leaf`.
5. **OpenAI Compatibility Bridge:** Directly tests `POST /v1/chat/completions` in JSON and streaming modes.
6. **Anthropic Compatibility Bridge:** Directly tests `POST /v1/messages` with content blocks and tool signatures.
7. **Agent Exocore Execution:** Tests `/api/agent/run` ReAct tool execution with the math calculator and web search.
8. **3-Tier Token Limiter:** Inspects `/api/usage` and checks daily rollover calculations against the Africa/Algiers timezone.

---

## 13. File Tree & Architectural Map

```
.
├── Caddyfile                          # Reverse proxy config for port mapping and SSL
├── components.json                    # UI primitives configuration
├── package.json                       # Scripts and project dependencies
├── next.config.ts                     # Standalone Next.js output and runtime options
├── tailwind.config.ts                 # Tailwind configuration
├── tsconfig.json                      # Path aliases (@/* -> ./src/*)
├── docs/
│   └── SENKU_ARCHITECTURE.md          # Canonical Master Architecture Specification
├── prisma/
│   └── schema.prisma                  # SQLite schema definition
├── db/
│   └── custom.db                      # SQLite database storage file (git-ignored)
├── generated-images/                  # Local storage for forged images (git-ignored)
├── tests/
│   └── test_hermes.py                 # Comprehensive E2E Python verification test suite
├── scripts/
│   ├── gen-pwa-icons.mjs              # Generator script for PWA icons
│   ├── obs-usage-window.mjs           # Utility script for inspecting usage counters
│   └── obs-usage-crosscheck.mjs       # Crosscheck script for usage window math
├── src/
│   ├── instrumentation.ts             # Boot hook for Rituals scheduler & Pool prober
│   ├── app/
│   │   ├── layout.tsx                 # Root layout with theme and metadata
│   │   ├── page.tsx                   # Main entry point mounting HermesApp
│   │   ├── globals.css                # Tailwind 4 styling and theme color definitions
│   │   ├── v1/
│   │   │   ├── chat/completions/      # OpenAI compatible endpoint
│   │   │   ├── messages/              # Anthropic compatible endpoint
│   │   │   └── models/                # Available models listing endpoint
│   │   └── api/
│   │       ├── bootstrap/             # App initialization and initial state payload
│   │       ├── chat/
│   │       │   ├── send/              # Main chat turn SSE streaming route
│   │       │   ├── branch/            # Branch creation and fork management
│   │       │   ├── fork/              # Fork turn action
│   │       │   ├── leaf/              # Set active branch leaf
│   │       │   └── duel/pick/         # Record user choice in Duel mode
│   │       ├── agent/run/             # Exocore ReAct agent loop
│   │       ├── voice/
│   │       │   ├── jarvis/            # Hands-free Jarvis spoken directive endpoint
│   │       │   ├── speak/             # Text-to-speech audio route
│   │       │   └── transcribe/        # Audio transcription route
│   │       ├── memory/                # Persistent memory CRUD
│   │       ├── rituals/               # Scheduled rituals management
│   │       ├── projects/              # Project folders & prompt instructions
│   │       ├── providers/             # Key pool & provider management
│   │       ├── usage/                 # Limiter status & rehearsal endpoints
│   │       └── image/generate/        # Cloud text-to-image forge endpoint
│   ├── services/                      # Microservice Domain Layer
│   │   ├── gateway/                   # core-gateway: Orrery key ring, limiter, cache, bridges
│   │   ├── tree/                      # brain-tree: Message DAG branching, path resolution
│   │   ├── voice/                     # senku-voice-jarvis: Jarvis dispatcher, ASR & TTS
│   │   ├── agent/                     # exocore-agent: ReAct loop, tools, Jev arbitration
│   │   └── multimodal/                # forge-service: Cloud image generation, sandbox runner
│   ├── lib/
│   │   ├── db.ts                      # Prisma client with self-healing SQLite WAL pool
│   │   ├── store.ts                   # Zustand application state store
│   │   ├── agent/
│   │   │   ├── orchestrator.ts        # ReAct agent loop implementation
│   │   │   ├── decisions.ts           # Jev AI ensemble arbitrator
│   │   │   └── tools/                 # Tool definitions (web_search, calculator, status)
│   │   └── hermes/
│   │       ├── router.ts              # Key selection, persistent cursors, anti-drift
│   │       ├── keyhealth.ts           # Circuit breaker failure states & quarantines
│   │       ├── pool.ts                # Background key prober daemon
│   │       ├── ring.ts                # Confirmed serve ledger tracking
│   │       ├── limiter.ts             # 3-tier pacing limiter calculations
│   │       ├── tree.ts                # Message branching and path resolution
│   │       ├── dispatch.ts            # Key retry dispatch and failover handling
│   │       ├── executor.ts            # Upstream HTTP streaming and token estimation
│   │       ├── cache.ts               # Exact-match response caching
│   │       ├── anthropic-bridge.ts    # Anthropic Messages <-> OpenAI translator
│   │       ├── js-runner.ts           # Sandboxed JavaScript runner execution logic
│   │       ├── imagegen.ts            # Cloud image generation adapter
│   │       └── search.ts              # DuckDuckGo search scraping and snippet extraction
│   └── components/
│       ├── ui/                        # Radix UI primitives & UI components
│       └── hermes/                    # Application UI components (JarvisCore, Timeline, Dialogs)
```
