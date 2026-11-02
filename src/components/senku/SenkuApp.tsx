"use client";

// SenkuAPI — app shell: sidebar · main (top bar, chat, input) · tool rail.
// Global ⌘K / Ctrl+K opens the command palette.
//
// Run 13 — the sidebar is ALWAYS mounted so it can animate open and
// closed (width + slide on desktop, slide + backdrop on mobile). It
// opens three ways:
//   • click the top-bar toggle → PINNED (stays open until clicked shut)
//   • rest the cursor on the toggle  → PEEK (opens with no click at
//     all; slides away again once the cursor moves off)
//   • on touch screens the click toggle works exactly as before
// Conversation navigation (new chat / enter a chat / delete the
// current chat) remounts the view wrapper keyed by the store's
// viewEpoch, so the whole conversation settles in with one calm
// transition instead of popping in.

import { useEffect, useRef, useState } from "react";
import { useSenku } from "@/lib/store";
import { Sidebar } from "@/components/senku/Sidebar";
import { RightRail } from "@/components/senku/RightRail";
import { CanvasPanel } from "@/components/senku/CanvasPanel";
import { TopBar } from "@/components/senku/TopBar";
import { WelcomeScreen } from "@/components/senku/WelcomeScreen";
import { ChatTimeline, TemporaryBanner } from "@/components/senku/ChatTimeline";
import { ImageGallery } from "@/components/senku/ImageGallery";
import { InputBar } from "@/components/senku/InputBar";
import { TokenLimiterDialog } from "@/components/senku/TokenLimiterDialog";
import { ProvidersDialog } from "@/components/senku/ProvidersDialog";
import { CommandPalette } from "@/components/senku/CommandPalette";

/** Hover-peek timings (Run 13).
 * OPEN — how long the cursor must rest on the toggle before the
 *        sidebar peeks open (filters drive-by hovers).
 * CLOSE — grace period after the cursor leaves the toggle or the
 *         sidebar before it slides away (lets the cursor travel
 *         between the two without the panel collapsing mid-trip). */
const SIDEBAR_PEEK_OPEN_MS = 140;
const SIDEBAR_PEEK_CLOSE_MS = 320;

/** Hover-peek only makes sense with a real pointer. */
function canHoverPeek(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
}

export function SenkuApp() {
  const {
    booted,
    bootstrap,
    messages,
    sidebarOpen,
    setSidebarOpen,
    temporary,
    viewEpoch,
    // Run 23 — the Gallery replaces the conversation view; the
    // composer hides while browsing (a running stream keeps its Stop
    // button mounted — an in-flight forge is always abortable).
    galleryOpen,
    streaming,
  } = useSenku();
  const [limiterOpen, setLimiterOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ── Sidebar hover-peek (transient) vs pinned (store) ──
  // `peek` opens the panel while the cursor is around; `sidebarOpen`
  // is the sticky, clicked state. Effective open = either.
  const [peek, setPeek] = useState(false);
  const [animReady, setAnimReady] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = sidebarOpen || peek;

  useEffect(() => {
    void bootstrap();
    // Run 15: the sidebar starts CLOSED on every screen (store
    // default) — nothing to force shut on mount anymore.
  }, [bootstrap]);

  // Transitions stay OFF until after the first paint — the initial
  // hydration state must never animate (e.g. the mobile
  // default-closed sidebar would otherwise visibly slide shut).
  useEffect(() => {
    let alive = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => alive && setAnimReady(true))
    );
    return () => {
      alive = false;
    };
  }, []);

  // A sidebar that closed under the cursor may still hold focus
  // (e.g. its search field) — hand focus back, like any flyout.
  useEffect(() => {
    if (open) return;
    const el = shellRef.current;
    const active = document.activeElement;
    if (el && active instanceof HTMLElement && el.contains(active)) {
      active.blur();
    }
  }, [open]);

  const clearPeekTimer = () => {
    if (peekTimer.current) {
      clearTimeout(peekTimer.current);
      peekTimer.current = null;
    }
  };
  useEffect(() => clearPeekTimer, []);

  /** Cursor came to rest on the top-bar toggle → peek open. */
  const onToggleHoverIn = () => {
    if (sidebarOpen || !canHoverPeek()) return; // pinned, or touch
    clearPeekTimer();
    peekTimer.current = setTimeout(() => setPeek(true), SIDEBAR_PEEK_OPEN_MS);
  };
  /** Cursor left the toggle — maybe into the sidebar, so grace first. */
  const onToggleHoverOut = () => {
    if (sidebarOpen) return; // pinned stays put
    clearPeekTimer();
    peekTimer.current = setTimeout(() => setPeek(false), SIDEBAR_PEEK_CLOSE_MS);
  };
  /** Cursor entered the sidebar itself — cancel any pending close. */
  const onShellHoverIn = () => clearPeekTimer();
  /** Cursor left the sidebar — peek folds away (pinned never does). */
  const onShellHoverOut = () => {
    if (sidebarOpen) return;
    clearPeekTimer();
    peekTimer.current = setTimeout(() => setPeek(false), SIDEBAR_PEEK_CLOSE_MS);
  };

  /** Toggle click: peeking → PIN it open (one click keeps it), open →
   *  close, closed → open. One button, no surprises. */
  const toggleSidebar = () => {
    clearPeekTimer();
    if (peek && !sidebarOpen) {
      setPeek(false);
      setSidebarOpen(true);
    } else {
      setPeek(false);
      setSidebarOpen(!open);
    }
  };
  const collapseSidebar = () => {
    clearPeekTimer();
    setPeek(false);
    setSidebarOpen(false);
  };

  // Global ⌘K / Ctrl+K hotkey for the command palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="senku-root flex h-dvh w-full overflow-hidden">
      {/* Backdrop — mobile only (md:hidden); fades with the panel.
          pointer-events are off while closed, so it never blocks. */}
      <div
        className={`senku-backdrop fixed inset-0 z-30 bg-black/60 md:hidden ${
          animReady ? "senku-anim" : ""
        } ${open ? "senku-open" : ""}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden
      />

      {/* Sidebar shell — always mounted so open/close can animate.
          Mobile: fixed overlay sliding in from the left. Desktop:
          in-flow column whose width animates 0 ↔ 264px (the chat
          reflows smoothly). Inert while closed so focus and screen
          readers never wander into the hidden panel.

          INVARIANT (audited Run 16): `inert` while CLOSED is
          deliberate and correct — a hidden (0-width / off-screen)
          panel must never be focusable or clickable. The control
          that OPENS the sidebar (top-bar toggle) lives OUTSIDE this
          subtree and stays fully enabled, so the panel can never be
          "locked out": closed+inert → toggle (outside, active) →
          open+focusable. React 19 serializes the boolean `inert`
          attribute correctly in SSR, and it is removed entirely the
          moment `open` flips true. Do NOT default inert to false on
          the server render — that would leave a hidden panel in the
          tab order and break keyboard accessibility. */}
      <div
        ref={shellRef}
        inert={!open}
        onMouseEnter={onShellHoverIn}
        onMouseLeave={onShellHoverOut}
        className={`senku-sidebar fixed inset-y-0 left-0 z-40 md:relative md:z-auto ${
          animReady ? "senku-anim" : ""
        } ${open ? "senku-open" : ""}`}
      >
        {/* Inner panel keeps its full 264px width — the shell clips
            it, so nothing inside ever squishes mid-animation. */}
        <div className="senku-sidebar-inner h-full">
          <Sidebar
            onManageProviders={() => setProvidersOpen(true)}
            onCollapse={collapseSidebar}
          />
        </div>
      </div>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          sidebarOpen={open}
          onToggleSidebar={toggleSidebar}
          onSidebarHoverIn={onToggleHoverIn}
          onSidebarHoverOut={onToggleHoverOut}
          onOpenLimiter={() => setLimiterOpen(true)}
          onOpenPalette={() => setPaletteOpen(true)}
        />

        {/* Conversation view — keyed by the store's viewEpoch (bumped
            by newChat / selectChat / deleteChat-of-current), so every
            navigation remounts the whole view and it settles in with
            one calm fade-and-rise. Keyed remount never happens
            mid-stream: sending a message doesn't touch the epoch.

            Run 18 — the flex-1 SLOT is now rendered even before the
            bootstrap round-trip answers. It used to be gated on
            `booted`, and since it is the only flex-1 in this column
            the composer spent the boot window pinned right under the
            top bar, then visibly dropped to the bottom the moment
            bootstrap landed. With the slot always present the
            composer sits in its final position from the very first
            paint; when boot completes the content mounts into the
            waiting slot and settles in with the existing
            senku-view-in fade (reduced-motion: instant). */}
        <div
          key={viewEpoch}
          className={`flex min-h-0 flex-1 flex-col ${
            booted ? "senku-view-in" : ""
          }`}
        >
          {booted && temporary && <TemporaryBanner />}

          {/* Run 23 — the Gallery is a destination view, parallel to
              the conversation: image history with full provenance and
              jump-to-chat. Every navigation (new chat / enter chat /
              send / mode switch) closes it — see the store. */}
          {booted &&
            (galleryOpen ? (
              <ImageGallery />
            ) : messages.length === 0 ? (
              <WelcomeScreen />
            ) : (
              <ChatTimeline />
            ))}
        </div>

        {(!galleryOpen || streaming) && <InputBar />}
      </div>

      {/* Senku Canvas (Run 17) — split view on wide screens, overlay
          panel on small ones. Mounted between the chat and the rail
          so the conversation reflows, never overlaps. */}
      <CanvasPanel />

      <RightRail onOpenSettings={() => setProvidersOpen(true)} />

      {/* Command palette — mounted fresh on every open so state
          always starts clean (⌘K toggles it globally) */}
      {paletteOpen && (
        <CommandPalette
          onOpenChange={setPaletteOpen}
          onOpenLimiter={() => setLimiterOpen(true)}
          onManageProviders={() => setProvidersOpen(true)}
        />
      )}
      <TokenLimiterDialog
        open={limiterOpen}
        onOpenChange={setLimiterOpen}
        onManageProviders={() => setProvidersOpen(true)}
      />
      <ProvidersDialog open={providersOpen} onOpenChange={setProvidersOpen} />

      {/* keep `temporary` referenced for aria live region */}
      <span className="sr-only" aria-live="polite">
        {temporary ? "Temporary chat mode is on" : "Temporary chat mode is off"}
      </span>
    </div>
  );
}
