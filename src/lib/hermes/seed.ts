// Hermes — idempotent seed (runs on first API touch).
// Equivalent of migrations.py: creates providers, pooled keys,
// demo chat history and historical usage so the limiter and the
// provider pill have realistic data.

import { db } from "@/lib/db";
import {
  APINEX_BASE_URL,
  APINEX_MODELS,
  APINEX_TEST_KEY,
  OXIONAI_BASE_URL,
  OXIONAI_MODELS,
} from "./constants";

let seeded = false;

function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export async function ensureSeed(): Promise<void> {
  if (seeded) return;

  // ── Providers ──────────────────────────────────────────────
  // models are RUNTIME state (the Sync button / ?sync=1 owns them
  // after first boot) — the upsert's update branch must never
  // overwrite a synced list back to the constants default (that
  // used to wipe it on every module reload / process restart).
  const oxionai = await db.provider.upsert({
    where: { slug: "oxionai" },
    create: {
      name: "OxionAI",
      slug: "oxionai",
      baseUrl: OXIONAI_BASE_URL,
      hasTokenLimit: true,
      tokenLimitPerKey: 500_000,
      tokenMultiplier: 1.0,
      isActive: false,
      models: JSON.stringify(OXIONAI_MODELS),
    },
    update: {
      baseUrl: OXIONAI_BASE_URL,
      hasTokenLimit: true,
      tokenLimitPerKey: 500_000,
      tokenMultiplier: 1.0,
    },
  });

  const apinex = await db.provider.upsert({
    where: { slug: "apinex" },
    create: {
      name: "APInex",
      slug: "apinex",
      baseUrl: APINEX_BASE_URL,
      hasTokenLimit: false, // unlimited tier
      tokenLimitPerKey: 0,
      tokenMultiplier: 4.0,
      isActive: true,
      models: JSON.stringify(APINEX_MODELS),
    },
    update: {
      baseUrl: APINEX_BASE_URL,
      hasTokenLimit: false,
      tokenLimitPerKey: 0,
      tokenMultiplier: 4.0,
    },
  });

  // Exactly ONE provider active at a time (switch rule invariant)
  const activeCount = await db.provider.count({ where: { isActive: true } });
  if (activeCount !== 1) {
    await db.provider.updateMany({ data: { isActive: false } });
    await db.provider.update({
      where: { id: apinex.id },
      data: { isActive: true },
    });
  }

  // ── Pooled keys (round-robin runs over the ACTIVE provider's keys) ──
  const oxionKeys = await db.apiKey.count({ where: { providerId: oxionai.id } });
  if (oxionKeys === 0) {
    await db.apiKey.createMany({
      data: [
        {
          providerId: oxionai.id,
          label: "Pool key #1",
          keyValue: "oxn-live-8f42c1a97e3d5b60f8a2",
          monthKey: monthKey(),
        },
        {
          providerId: oxionai.id,
          label: "Pool key #2",
          keyValue: "oxn-live-2d97be64c08a51f3e77c",
          monthKey: monthKey(),
        },
      ],
    });
  }

  const apinexKeys = await db.apiKey.count({ where: { providerId: apinex.id } });
  if (apinexKeys === 0) {
    await db.apiKey.create({
      data: {
        providerId: apinex.id,
        label: "Test key",
        keyValue: APINEX_TEST_KEY,
        monthKey: monthKey(),
      },
    });
  }

  // NOTE: no seeded usage events — token usage starts at exactly 0
  // and only grows from real traffic (each request metered ×multiplier).

  // ── Demo "Recent" history (realistic titles + content, matching
  //    what the title-refinement pass would produce) ────────────
  const chatCount = await db.chat.count();
  if (chatCount === 0) {
    const demos: { title: string; user: string; assistant: string }[] = [
      {
        title: "Who Are You",
        user: "who r u?",
        assistant:
          "I'm **Hermes** — your personal AI gateway. I route requests to pooled cloud provider keys (currently APInex) with prompt caching and OpenAI compatibility, and I can search the web for fresh, cited answers.",
      },
      {
        title: "Current Date Question",
        user: "what today date month year and time?",
        assistant:
          "I'm grounded in a live clock, so I can answer exactly: it's **Sunday 1 November 2026** in your timezone (Africa/Algiers) — check the timestamp on the welcome screen, it ticks in real time.",
      },
      {
        title: "Best Model Recommendation",
        user: "what's the best model in your pool?",
        assistant:
          "Depends on the job:\n\n- **GLM 5.3** — balanced default, fast\n- **Gemini 3.8 Flash** — fastest responses\n- **Qwen 3.8 Max** — deepest reasoning\n\nAll are on the free tier right now. You can also race two of them with **Duel** and keep the better answer.",
      },
      {
        title: "Debounce Function In TypeScript",
        user: "write a ts debounce function with types",
        assistant:
          "```ts\nfunction debounce<T extends (...args: never[]) => void>(\n  fn: T,\n  wait = 300\n): (...args: Parameters<T>) => void {\n  let timer: ReturnType<typeof setTimeout>;\n  return (...args: Parameters<T>) => {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn(...args), wait);\n  };\n}\n```\n\nReturns a wrapped function that only fires `wait` ms after the last call.",
      },
      {
        title: "Explain Transformers Simply",
        user: "explain transformers like I'm five",
        assistant:
          "Imagine reading a sentence and, for every word, glancing back at ALL the other words to decide which ones matter most. That's **attention** — the trick behind Transformers. Stack enough of those glance-layers, train on oceans of text, and you get a model that predicts what word comes next. Everything else is clever bookkeeping.",
      },
    ];
    let h = 6;
    for (const d of demos) {
      await db.chat.create({
        data: {
          title: d.title,
          model: APINEX_MODELS[(h + 1) % APINEX_MODELS.length],
          provider: "APInex",
          createdAt: new Date(Date.now() - h * 3600 * 1000),
          updatedAt: new Date(Date.now() - h * 3600 * 1000),
          messages: {
            create: [
              { role: "user", content: d.user },
              {
                role: "assistant",
                content: d.assistant,
                model: APINEX_MODELS[(h + 1) % APINEX_MODELS.length],
                provider: "APInex",
                keyLabel: "Test key",
                tokens: 428,
              },
            ],
          },
        },
      });
      h += 5;
    }
  }

  seeded = true;
}
