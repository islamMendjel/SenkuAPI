// SenkuAPI — health-aware key dispatch.
// One completion, executed with pool resilience:
//   pick key (skips quarantined keys) → try provider endpoint →
//   on typed failure: mark key health, retry the NEXT pooled key →
//   only when every key failed (or the pool is dry) fail over to
//   the Z.ai cloud runtime. Still 100% cloud, never local.
//
// Guarantees:
//   • A dead key costs at most ONE failed round-trip per turn —
//     never a silently degraded response while healthy keys exist.
//   • Retries only happen when NO deltas were emitted yet, so the
//     client never receives duplicated output.
//   • Hard limiter exhaustion still surfaces the same coded error
//     the gateway always threw (no silent behavior change).

import { tryProviderStream, zaiCloudExec, type ExecResult } from "./executor";
import { noteKeyFailure, noteKeySuccess } from "./keyhealth";
import { pickKey } from "./router";
import type { ChatMessageData } from "./types";

export interface DispatchKey {
  id: string;
  label: string;
  keyValue: string;
}

export interface RoutedExecution {
  exec: ExecResult;
  /** The pooled key that actually served the response — null when
   *  the Z.ai cloud failover served it (no key to bill). */
  key: DispatchKey | null;
  /** How many pooled keys were attempted this turn. */
  attempts: number;
  /** True when the turn ended because the CLIENT disconnected —
   *  `exec.content` is the partial text generated so far. Terminal
   *  state: never retried, never failed over. */
  aborted?: boolean;
}

export interface DispatchParams {
  provider: {
    id: string;
    name: string;
    baseUrl: string | null;
    hasTokenLimit: boolean;
    tokenLimitPerKey: number;
  };
  model: string;
  messages: ChatMessageData[];
  onDelta?: (text: string) => void;
  /** Fired when the Z.ai cloud is about to re-generate the answer
   *  AFTER partial output already streamed from a dead provider.
   *  The cloud re-emits from scratch, so clients that received
   *  deltas MUST clear their accumulated text on this signal —
   *  otherwise they render partial + full (duplicated answer). */
  onRestart?: () => void;
  /** Deep-effort flag: lets the Z.ai cloud THINK before answering
   *  on the failover path. Provider endpoints are unchanged. */
  thinking?: boolean;
  /** Aborts the upstream request the moment the CLIENT disconnects
   *  (Stop button, tab close, navigation) — the pooled keys stop
   *  paying for tokens nobody will ever see. */
  signal?: AbortSignal;
}

export async function dispatchCompletion(
  params: DispatchParams
): Promise<RoutedExecution> {
  const { provider, model, messages, onDelta, onRestart, thinking, signal } = params;
  const tried = new Set<string>();
  // Set when a provider died mid-stream AFTER deltas reached the
  // client — the upcoming cloud re-emission then needs a restart.
  let emittedBeforeCloud = false;

  // The client is already gone (aborted during the search phase) —
  // nothing to generate, nothing to bill, no key to pick.
  if (signal?.aborted) {
    return {
      exec: {
        content: "",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        servedBy: "provider",
        aborted: true,
      },
      key: null,
      attempts: 0,
      aborted: true,
    };
  }

  for (;;) {
    const picked = await pickKey(provider, tried);

    if (!picked.key) {
      // Pool is dry for a HARD reason — preserve the gateway's
      // original coded errors (no-keys / limiter exhaustion).
      if (picked.reason === "no-keys" || picked.reason === "exhausted") {
        const reason =
          picked.reason === "no-keys"
            ? `No active keys configured for ${provider.name}. Add a key in Manage Providers.`
            : `All pooled keys for ${provider.name} are exhausted (monthly/daily/5h-burst ceilings). ` +
              `Switch provider or add keys.`;
        throw Object.assign(new Error(reason), { code: picked.reason });
      }
      // "all-tried": every pooled key was attempted this turn and
      // failed — fall through to the Z.ai cloud below.
      break;
    }

    const key = picked.key;
    tried.add(key.id);

    const attempt = await tryProviderStream({
      baseUrl: provider.baseUrl,
      apiKey: key.keyValue,
      model,
      messages,
      onDelta,
      signal,
    });

    if (attempt.ok) {
      noteKeySuccess(key.id);
      return { exec: attempt.result, key, attempts: tried.size };
    }

    // The CLIENT disconnected mid-stream — terminal. No key retry
    // (nobody is listening), no cloud failover (it would regenerate
    // an answer nobody asked for): bill what this key actually
    // consumed and hand back the partial text.
    if (attempt.reason === "aborted") {
      return {
        exec: attempt.partial,
        key,
        attempts: tried.size,
        aborted: true,
      };
    }

    noteKeyFailure(key.id, attempt.reason === "auth" ? "auth" : "transient");

    // Partial output already reached the client — retrying another
    // key would duplicate it; go straight to the cloud re-emission
    // (identical to the previous single-attempt behavior).
    if (attempt.emitted) {
      emittedBeforeCloud = true;
      break;
    }
  }

  // The cloud regenerates from scratch: tell the client to discard
  // the dead provider's partial text BEFORE the full answer streams,
  // so the turn shows ONE clean answer instead of partial + full.
  if (emittedBeforeCloud) onRestart?.();

  const exec = await zaiCloudExec({
    baseUrl: null,
    apiKey: "",
    model,
    messages,
    onDelta,
    thinking,
    signal,
  });
  return {
    exec,
    key: null,
    attempts: tried.size,
    ...(exec.aborted ? { aborted: true } : {}),
  };
}
