// Hermes — Rituals engine (Run 34, server-only).
// Scheduled prompts that fire on their own clock, whether or not
// the app is open:
//
//   • each ritual owns ONE dedicated chat (created with it) — every
//     run appends the prompt + the gateway's grounded answer there,
//     so briefs accumulate in one readable thread, and the user can
//     reply inside it to give later runs context;
//   • execution reuses the FULL turn pipeline (runChatTurn): web
//     search, memory, response cache, health-aware key dispatch,
//     usage accounting — a ritual run is billed exactly like a turn
//     the user typed, and its receipts say so;
//   • the schedule advances only AFTER a run settles (ok or error),
//     so downtime catches up (at-least-once) while a failing ritual
//     can never machine-gun the pool every tick;
//   • the user message row is stamped `ritualId` post-persist — the
//     gateway itself stays untouched (zero risk to the live stream).
//
// Clock: schedule fields are interpreted in the owner's timezone
// (USER_TIMEZONE); storage is UTC instants. The math goes through
// Intl so a future timezone change stays correct.

import { db } from "@/lib/db";
import { runChatTurn } from "./gateway";
import {
  RITUAL_MAX_ENTRIES,
  RITUAL_MAX_PROMPT_CHARS,
  RITUAL_MAX_TITLE_CHARS,
  RITUAL_MIN_INTERVAL_MIN,
  USER_TIMEZONE,
  type RitualKind,
} from "./constants";
import type { AttachmentRecord, ChatMessageData, RitualView } from "./types";

// ── Clock math ────────────────────────────────────────────────

const WEEKDAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Minutes-of-week / minutes-of-day / weekday for an instant, in the
 *  owner's timezone (Intl-based: no hardcoded offset, DST-safe for
 *  any zone the constants ever specify). */
function localParts(now: Date): {
  minutesOfDay: number;
  minutesOfWeek: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const weekday = Math.max(
    0,
    WEEKDAY_KEYS.indexOf(get("weekday"))
  ); // -1 (unknown) → 0 is unreachable in practice; clamp for safety
  const hour = parseInt(get("hour"), 10) % 24; // some zones render "24"
  const minute = parseInt(get("minute"), 10);
  const minutesOfDay = hour * 60 + (Number.isFinite(minute) ? minute : 0);
  return { minutesOfDay, minutesOfWeek: weekday * 1440 + minutesOfDay };
}

/** Next UTC instant a schedule fires, counting from `from`. A
 *  daily/weekly time that already passed today counts for its next
 *  occurrence (delta <= 0 rolls a full period forward) — so a run
 *  completing AT 08:00 schedules tomorrow's 08:00, never a second
 *  immediate fire. */
export function computeNextRun(
  kind: string,
  hour: number,
  minute: number,
  weekday: number,
  intervalMin: number,
  from: Date = new Date()
): Date {
  const now = new Date(from.getTime());
  if (kind === "interval") {
    const mins = Math.max(RITUAL_MIN_INTERVAL_MIN, intervalMin);
    return new Date(now.getTime() + mins * 60_000);
  }
  const p = localParts(now);
  if (kind === "weekly") {
    const target = weekday * 1440 + hour * 60 + minute;
    let delta = target - p.minutesOfWeek;
    if (delta <= 0) delta += 10_080;
    return new Date(now.getTime() + delta * 60_000);
  }
  const target = hour * 60 + minute;
  let delta = target - p.minutesOfDay;
  if (delta <= 0) delta += 1440;
  return new Date(now.getTime() + delta * 60_000);
}

// ── Serialization ─────────────────────────────────────────────

type RitualRow = {
  id: string;
  title: string;
  prompt: string;
  chatId: string;
  kind: string;
  hour: number;
  minute: number;
  weekday: number;
  intervalMin: number;
  search: boolean;
  isActive: boolean;
  nextRunAt: Date;
  lastRunAt: Date | null;
  lastStatus: string | null;
  runCount: number;
};

export function ritualView(
  r: RitualRow,
  chatTitle: string
): RitualView {
  return {
    id: r.id,
    title: r.title,
    prompt: r.prompt,
    kind: (r.kind === "weekly" || r.kind === "interval"
      ? r.kind
      : "daily") as RitualKind,
    hour: r.hour,
    minute: r.minute,
    weekday: r.weekday,
    intervalMin: r.intervalMin,
    search: r.search,
    isActive: r.isActive,
    chatId: r.chatId,
    chatTitle,
    nextRunAt: r.nextRunAt.toISOString(),
    lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
    lastStatus: r.lastStatus,
    runCount: r.runCount,
  };
}

/** Every ritual, oldest first (the dialog lists in creation order). */
export async function listRituals(): Promise<RitualView[]> {
  const rows = await db.ritual.findMany({
    orderBy: { createdAt: "asc" },
    include: { chat: { select: { title: true } } },
  });
  return rows.map((r) => ritualView(r, r.chat.title));
}

// ── Input validation (shared by POST + PATCH) ────────────────

export interface RitualInput {
  title: string;
  prompt: string;
  kind: RitualKind;
  hour: number;
  minute: number;
  weekday: number;
  intervalMin: number;
  search: boolean;
}

const KINDS: RitualKind[] = ["daily", "weekly", "interval"];

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** Rebuild + validate a ritual payload field-by-field — the same
 *  never-trust-the-client discipline as sanitizeAttachments. Throws
 *  Error(code) on anything unusable. */
export function sanitizeRitualInput(raw: {
  title?: unknown;
  prompt?: unknown;
  kind?: unknown;
  hour?: unknown;
  minute?: unknown;
  weekday?: unknown;
  intervalMin?: unknown;
  search?: unknown;
}): RitualInput {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) throw Object.assign(new Error("A ritual needs a title"), { code: "bad-title" });
  if (title.length > RITUAL_MAX_TITLE_CHARS)
    throw Object.assign(
      new Error(`Title is limited to ${RITUAL_MAX_TITLE_CHARS} characters`),
      { code: "bad-title" }
    );
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) throw Object.assign(new Error("A ritual needs a prompt"), { code: "bad-prompt" });
  if (prompt.length > RITUAL_MAX_PROMPT_CHARS)
    throw Object.assign(
      new Error(`Prompt is limited to ${RITUAL_MAX_PROMPT_CHARS} characters`),
      { code: "bad-prompt" }
    );
  const kind = KINDS.includes(raw.kind as RitualKind)
    ? (raw.kind as RitualKind)
    : "daily";
  return {
    title,
    prompt,
    kind,
    hour: clampInt(raw.hour, 0, 23, 8),
    minute: clampInt(raw.minute, 0, 59, 0),
    weekday: clampInt(raw.weekday, 0, 6, 1),
    intervalMin: clampInt(raw.intervalMin, RITUAL_MIN_INTERVAL_MIN, 43200, 1440),
    search: raw.search !== false, // grounded by default — briefs want sources
  };
}

// ── Execution ─────────────────────────────────────────────────

interface RitualRuntime {
  __hermesRitualInFlight?: Set<string>;
  __hermesRitualTimer?: ReturnType<typeof setInterval>;
}

const runtime = globalThis as typeof globalThis & RitualRuntime;

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Attachments persisted on a history row (JSON column) — parsed
 *  defensively; malformed rows degrade to "no attachments" instead
 *  of killing the run. */
function parseHistoryAttachments(json: string): AttachmentRecord[] | undefined {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as AttachmentRecord[]) : undefined;
  } catch {
    return undefined;
  }
}

export interface RitualRunOutcome {
  ok: boolean;
  status: string;
  nextRunAt: string;
  chatId: string;
  /** assistant text length — 0 when the turn errored before content */
  chars: number;
}

/** Run one ritual NOW: full gateway turn into its dedicated chat,
 *  then stamp the user row + advance the schedule. Idempotence is
 *  guarded in-memory (a tick and a "Run now" click can never double
 *  fire the same ritual). */
export async function runRitual(id: string): Promise<RitualRunOutcome> {
  const inFlight = (runtime.__hermesRitualInFlight ??= new Set<string>());
  if (inFlight.has(id)) {
    throw Object.assign(new Error("This ritual is already running"), {
      code: "busy",
    });
  }
  inFlight.add(id);
  try {
    const ritual = await db.ritual.findUnique({
      where: { id },
      include: { chat: true },
    });
    if (!ritual) {
      throw Object.assign(new Error("Ritual not found"), { code: "not-found" });
    }

    // History: the chat's last 20 turns, exactly like the client
    // sends them — the user's replies inside a ritual chat give
    // later runs context ("shorter today", follow-ups, …).
    const rows = await db.message.findMany({
      where: { chatId: ritual.chatId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const history: ChatMessageData[] = rows.reverse().map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
      ...(m.role === "user" && m.attachments
        ? { attachments: parseHistoryAttachments(m.attachments) }
        : {}),
    }));

    const result = await runChatTurn({
      chatId: ritual.chatId,
      history,
      content: ritual.prompt,
      model: ritual.chat.model || "",
      search: ritual.search,
      temporary: false,
      persistUser: true,
      effort: "medium",
      emit: () => {
        // no client is listening — events are discarded; tokens,
        // cache and usage accounting still record exactly like a
        // typed turn.
      },
    });

    // Stamp the ritual origin on the persisted user row — the
    // timeline renders its badge from this. (The gateway itself is
    // untouched: zero risk to the live streaming path.)
    if (result.userMessageId) {
      await db.message
        .update({
          where: { id: result.userMessageId },
          data: { ritualId: ritual.id },
        })
        .catch(() => {
          // chat deleted mid-run — the cascade already handled it
        });
    }

    const now = new Date();
    const status =
      `ok · ${result.cached ? "cache hit · 0 tokens" : `${fmtTokens(result.tokens)} tokens`} · ${result.model}`;
    const updated = await db.ritual.update({
      where: { id: ritual.id },
      data: {
        lastRunAt: now,
        lastStatus: status,
        runCount: { increment: 1 },
        nextRunAt: computeNextRun(
          ritual.kind,
          ritual.hour,
          ritual.minute,
          ritual.weekday,
          ritual.intervalMin,
          now
        ),
      },
    });
    return {
      ok: true,
      status,
      nextRunAt: updated.nextRunAt.toISOString(),
      chatId: ritual.chatId,
      chars: result.content.length,
    };
  } catch (e) {
    // A failing ritual still advances its schedule — otherwise it
    // would re-fire every 30 s tick and drain the pool. The error
    // is recorded honestly; "Run now" is always available for a
    // manual retry.
    const err = e as Error;
    try {
      const r = await db.ritual.findUnique({ where: { id } });
      if (r) {
        const now = new Date();
        await db.ritual.update({
          where: { id },
          data: {
            lastRunAt: now,
            lastStatus: `error: ${err.message}`.slice(0, 300),
            nextRunAt: computeNextRun(
              r.kind,
              r.hour,
              r.minute,
              r.weekday,
              r.intervalMin,
              now
            ),
          },
        });
      }
    } catch {
      // ritual gone — nothing to advance
    }
    throw e;
  } finally {
    inFlight.delete(id);
  }
}

/** One scheduler pass: every ACTIVE ritual whose nextRunAt has
 *  passed, oldest-due first, strictly SEQUENTIAL so the key pool is
 *  never hit by a burst of parallel scheduled turns. Returns how
 *  many ran. */
export async function sweepDueRituals(): Promise<number> {
  const due = await db.ritual.findMany({
    where: { isActive: true, nextRunAt: { lte: new Date() } },
    select: { id: true },
    orderBy: { nextRunAt: "asc" },
  });
  let ran = 0;
  for (const r of due) {
    try {
      const outcome = await runRitual(r.id);
      ran++;
      console.log(
        `[rituals] fired ${r.id} — ${outcome.status} (${outcome.chars} chars)`
      );
    } catch (e) {
      console.error(`[rituals] failed ${r.id}:`, (e as Error).message);
    }
  }
  return ran;
}

/** Arm the in-process scheduler (called once from
 *  src/instrumentation.ts on server boot). Singleton-guarded on
 *  globalThis so dev hot-reloads can never stack intervals, and
 *  unref'd so it never holds the process open by itself. */
export function startRitualScheduler(): void {
  if (runtime.__hermesRitualTimer) return;
  const timer = setInterval(() => {
    void sweepDueRituals().catch((e) =>
      console.error("[rituals] sweep error:", (e as Error).message)
    );
  }, 30_000);
  timer.unref?.();
  runtime.__hermesRitualTimer = timer;
  // Catch-up pass shortly after boot: anything that came due while
  // the server was down fires exactly once, then reschedules.
  const boot = setTimeout(() => {
    void sweepDueRituals().catch((e) =>
      console.error("[rituals] boot sweep error:", (e as Error).message)
    );
  }, 8_000);
  boot.unref?.();
  console.log(
    `[rituals] scheduler armed — 30s tick, clock: ${USER_TIMEZONE}, ` +
      `cap: ${RITUAL_MAX_ENTRIES} rituals`
  );
}
