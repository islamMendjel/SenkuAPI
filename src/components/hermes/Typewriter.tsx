"use client";

// Hermes — client-side typewriter reveal gate.
//
// Run 10 made every SERVER path stream word-by-word, but the client
// rendered whatever each SSE read() chunk happened to contain —
// network coalescing, React batching and the server's own ~166 wps
// reveal pace let bursts land in a single frame, so answers still
// read as "appeared all at once". Pacing the user can WATCH has to
// live at the DOM layer: this gate buffers whatever arrives (live
// model streams, fast bursts, one-shot cache text) and reveals it at
// a constant, readable WORDS_PER_SECOND on a requestAnimationFrame
// clock — never slower than the model itself, never one big dump.
//
// All state transitions happen inside rAF callbacks or event
// handlers (never synchronously in effects), which keeps the React
// Compiler rules honest and the render path pure.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import { Markdown } from "@/components/hermes/Markdown";
import { SkipForward } from "lucide-react";

/** Typing pace, words per second (product spec: 20–40). One knob. */
export const WORDS_PER_SECOND = 30;

/** Long unbroken runs (CJK text, URLs, hashes) reveal in chunks of at
 *  most this many characters so they still type visibly. */
const WORD_CHUNK_LIMIT = 10;

/** "At the bottom" tolerance for auto-scroll stickiness, in px. */
export const STICK_THRESHOLD_PX = 36;

/** Max milliseconds credited per frame — a background tab (rAF
 *  paused) must not fast-forward the reveal when it comes back. */
const MAX_FRAME_DT_MS = 100;

const WS = /\s/;

/** Advance one word from `from`: absorb the whitespace under the
 *  cursor, then consume one word (capped for unbroken runs). Never
 *  moves backward and never splits a surrogate pair, so slices of
 *  successive positions reassemble the source byte-for-byte. */
function advanceOneWord(text: string, from: number): number {
  const n = text.length;
  let i = from;
  while (i < n && WS.test(text[i]!)) i++;
  const wordStart = i;
  while (i < n && !WS.test(text[i]!) && i - wordStart < WORD_CHUNK_LIMIT) i++;
  return i;
}

export interface TypewriterApi {
  /** Exact prefix of the target revealed so far. */
  revealed: string;
  /** True while the reveal is behind the target. */
  typing: boolean;
  /** Instantly render everything (Skip affordance). */
  skip: () => void;
}

/** Word-by-word reveal gate for one message's content.
 *
 * - Content that never changes (chat history) renders instantly —
 *   only growth observed AFTER mount is animated, so old messages
 *   never replay.
 * - Pure appends type out at WORDS_PER_SECOND; resets (mid-stream
 *   restart), server-truth replacements and confidence-line trims
 *   snap on the next frame via the tick's position clamp — the
 *   effect is presentation, never a correction of the data.
 * - prefers-reduced-motion shows the full text with no animation.
 */
export function useTypewriter(target: string): TypewriterApi {
  const [revealed, setRevealed] = useState(target);
  // prefers-reduced-motion, resolved once at mount (lazy initializer)
  // and kept live via the media-query listener. Drives both the
  // engine branch and the Skip affordance — under reduced motion
  // there is never anything to skip.
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
  );
  const revealedRef = useRef(target);
  const targetRef = useRef(target);
  const budgetRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number | null>(null);

  // Keep the ref mirrors in sync with committed values. Declared
  // before the engine effect so it always sees fresh data. The
  // revealed sync never walks the ref backwards, so progress made by
  // an in-flight rAF tick (ref ahead of the pending commit) is kept.
  useEffect(() => {
    targetRef.current = target;
  }, [target]);
  useEffect(() => {
    if (revealed.length < revealedRef.current.length) return;
    revealedRef.current = revealed;
  }, [revealed]);

  // Keep the reduced-motion preference live (event-driven only —
  // the initial value came from the lazy state initializer).
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq?.addEventListener) return;
    const sync = () => setReduced(mq.matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const finish = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    budgetRef.current = 0;
    lastFrameRef.current = null;
    revealedRef.current = targetRef.current;
    setRevealed(targetRef.current);
  }, []);

  // The reveal engine. The frame clock keeps running across target
  // updates (deltas re-run this effect constantly — resetting it
  // would freeze the budget accrual during fast bursts) and is only
  // zeroed when the gate catches up, so a later burst starts fresh.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (revealedRef.current === target) return; // nothing to reveal

    // No animation machinery at all — defer a full render via a
    // microtask so nothing is ever lost (spec: JS failure falls back
    // to displaying the full text immediately).
    if (typeof requestAnimationFrame !== "function") {
      const full = targetRef.current;
      queueMicrotask(() => {
        revealedRef.current = full;
        setRevealed(full);
      });
      return;
    }

    // prefers-reduced-motion: the full text lands next frame, no
    // word-by-word animation (typing stays false — nothing to skip).
    if (reduced) {
      const id = requestAnimationFrame(() => {
        revealedRef.current = targetRef.current;
        setRevealed(targetRef.current);
      });
      return () => cancelAnimationFrame(id);
    }

    const tick = (now: number) => {
      rafRef.current = null;
      try {
        const last = lastFrameRef.current;
        lastFrameRef.current = now;
        const dt = last == null ? 0 : Math.min(now - last, MAX_FRAME_DT_MS);
        budgetRef.current += (dt / 1000) * WORDS_PER_SECOND;

        const text = targetRef.current;
        let pos = revealedRef.current.length;
        if (pos > text.length || !text.startsWith(revealedRef.current)) {
          // The target was trimmed or replaced under us (done-time
          // confidence-line lift, mid-stream restart, server truth)
          // — snap forward on this frame instead of typing.
          pos = text.length;
        }
        let next = pos;
        while (budgetRef.current >= 1 && next < text.length) {
          next = advanceOneWord(text, next);
          budgetRef.current -= 1;
        }
        if (budgetRef.current > 1) budgetRef.current = 1;
        if (next !== pos) {
          revealedRef.current = text.slice(0, next);
          setRevealed(revealedRef.current);
        }
        if (next < text.length) {
          rafRef.current = requestAnimationFrame(tick);
        } else {
          // caught up — a model slower than WORDS_PER_SECOND is
          // followed at its own pace, never slowed further
          budgetRef.current = 0;
          lastFrameRef.current = null;
        }
      } catch {
        // Any engine failure falls back to showing the full text.
        revealedRef.current = targetRef.current;
        setRevealed(targetRef.current);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [target, reduced]);

  return {
    revealed,
    // Under reduced motion the reveal never lags behind visibly, so
    // the Skip affordance (and the click-to-skip handler) never
    // engage — there is nothing to skip.
    typing: !reduced && revealed.length < target.length,
    skip: finish,
  };
}

/** Markdown body that types itself out word-by-word, with a Skip
 *  affordance while it is behind the live content. Renders exactly
 *  the same markdown as <Markdown/> once caught up. */
export function StreamedMarkdown({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  const { revealed, typing, skip } = useTypewriter(content);
  const hostRef = useRef<HTMLDivElement>(null);

  // Keep the newest word visible — but only while the user has not
  // scrolled up. Stickiness lives on the .hermes-scroll container
  // (maintained by useStickyScroll in ChatTimeline); when the user
  // returns to the bottom, following resumes on the next word.
  useEffect(() => {
    if (!typing) return;
    const host = hostRef.current;
    if (!host) return;
    const scroller = host.closest(".hermes-scroll") as HTMLElement | null;
    if (!scroller || scroller.dataset.hermesStick === "0") return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [revealed, typing]);

  // Clicking anywhere on the streaming text skips — but never hijacks
  // links, code-copy buttons or other interactive markdown children,
  // and never fires over a text selection.
  const onBodyClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!typing) return;
      if (
        (e.target as HTMLElement).closest?.(
          "a,button,input,textarea,select,summary,[contenteditable]"
        )
      ) {
        return;
      }
      if (typeof window !== "undefined" && window.getSelection()?.toString()) {
        return;
      }
      skip();
    },
    [typing, skip]
  );

  return (
    <div
      className="hermes-md"
      ref={hostRef}
      onClick={typing ? onBodyClick : undefined}
    >
      <Markdown content={revealed} />
      {(streaming || typing) && (
        <span className="hermes-caret text-zinc-300" aria-hidden>
          ▍
        </span>
      )}
      {typing && (
        <button
          type="button"
          className="hermes-skip"
          onClick={skip}
          aria-label="Skip typing — show the full answer"
          title="Skip typing"
        >
          <SkipForward aria-hidden />
          Skip
        </button>
      )}
    </div>
  );
}

/** Tracks whether the timeline scroll container is pinned to the
 *  bottom and publishes it (dataset.hermesStick) so every
 *  StreamedMarkdown inside can follow the newest word without prop
 *  drilling. Scrolling up pauses auto-scroll; returning to the
 *  bottom resumes it. */
export function useStickyScroll(
  ref: RefObject<HTMLElement | null>
): RefObject<boolean> {
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
      stick.current = atBottom;
      el.dataset.hermesStick = atBottom ? "1" : "0";
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    return () => el.removeEventListener("scroll", sync);
  }, [ref]);
  return stick;
}
