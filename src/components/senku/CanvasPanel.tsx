"use client";

// SenkuAPI — Senku Canvas (Run 17): the Tools aside, activated.
//
// Assistant code blocks with a preview in the Tools panel open this
// canvas: a split view beside the chat on wide screens (lg+), a
// closable overlay panel on small ones. Two tabs — Preview and Code
// — over the SAME source block, which is kept in the store so
// close/reopen and chat navigation never lose it.
//
// SECURITY CONTRACT (all model/user-generated code is untrusted):
//   • Previews render inside a srcdoc iframe whose `sandbox` attr is
//     EMPTY — no allow-scripts, no allow-same-origin, no forms, no
//     popups, no top navigation. Arbitrary HTML/JavaScript NEVER
//     executes in a preview.
//   • A restrictive CSP (<meta> in the srcdoc head) blocks ALL
//     external network (default-src 'none') — no CDN scripts or
//     styles, no remote images, no beacons. Only inline styles and
//     data:/blob: images are permitted.
//   • Mermaid diagrams are pre-rendered in the parent via the
//     locally-bundled mermaid package (securityLevel "strict", lazy
//     dynamic import — never a CDN), then the resulting SVG is
//     sanitized (scripts, foreignObject, event handlers and
//     external/script URLs stripped) before it enters the iframe.
//   • JavaScript and Python honestly DO NOT run: the Preview tab
//     explains that execution is unsupported and shows the source.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  Code2,
  Copy,
  Eye,
  FileWarning,
  Loader2,
  X,
} from "lucide-react";
import { useSenku } from "@/lib/store";
import {
  canonicalPreviewLang,
  isViewOnlyLang,
  type PreviewLang,
} from "@/lib/senku/canvas-langs";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { SENKU_FORGE } from "@/lib/senku/forge-theme";

/** Restrictive CSP for every preview document: everything external
 *  is denied; scripts are doubly blocked (CSP + sandbox). */
const PREVIEW_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src data:; connect-src 'none'; " +
  "child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; " +
  "form-action 'none'";

function wrapPreviewDoc(body: string): string {
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">` +
    `<style>html,body{margin:0;padding:14px;background:#0d0d10;color:#e4e4e7;` +
    `font:13px/1.55 ui-sans-serif,system-ui,sans-serif;overflow:auto}` +
    `img,svg,video,canvas{max-width:100%;height:auto}` +
    `body{display:flex;align-items:flex-start;justify-content:center}` +
    `body>*{width:100%}</style></head><body>${body}</body></html>`
  );
}

/** Allowlist-scrub a rendered SVG: DOMParser documents never execute
 *  scripts, so this walk is safe to run on hostile input. Strips
 *  script/foreignObject/iframe/object/embed/link nodes, on* event
 *  attributes, and href/src values pointing at scripts or the
 *  network (mermaid's strict mode should already have escaped
 *  labels — this is the second, independent layer). */
function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  const DANGEROUS_TAGS = new Set([
    "script",
    "foreignobject",
    "iframe",
    "object",
    "embed",
    "link",
  ]);
  const scrub = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (DANGEROUS_TAGS.has(child.tagName.toLowerCase())) {
        child.remove();
        continue;
      }
      scrub(child);
    }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (name === "href" || name === "xlink:href" || name === "src") {
        const v = attr.value.trim().toLowerCase();
        if (
          v.startsWith("javascript:") ||
          v.startsWith("http:") ||
          v.startsWith("https:") ||
          v.startsWith("//")
        ) {
          node.removeAttribute(attr.name);
        }
      }
    }
  };
  scrub(root);
  return new XMLSerializer().serializeToString(root);
}

type MermaidState =
  | { phase: "loading" }
  | { phase: "ready"; svg: string }
  | { phase: "error"; message: string };

export function CanvasPanel() {
  const canvasOpen = useSenku((s) => s.canvasOpen);
  const canvasSource = useSenku((s) => s.canvasSource);
  const closeCanvas = useSenku((s) => s.closeCanvas);

  const source = canvasSource;
  const canonical: PreviewLang | null = source
    ? canonicalPreviewLang(source.language)
    : null;

  // JavaScript/Python open straight on the Code tab — the Preview
  // tab explains why nothing runs. Everything else previews first.
  const initialTab =
    canonical && isViewOnlyLang(canonical) ? ("code" as const) : ("preview" as const);
  const [tab, setTab] = useState<"preview" | "code">(initialTab);
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab, source]);

  // Mermaid rendering (only while its Preview tab is visible).
  const [mmd, setMmd] = useState<MermaidState>({ phase: "loading" });
  useEffect(() => {
    if (!source || canonical !== "mermaid" || tab !== "preview") return;
    let alive = true;
    setMmd({ phase: "loading" });
    (async () => {
      try {
        // Locally-bundled renderer, loaded on demand (no CDN, no
        // remote script). strict securityLevel escapes HTML in
        // labels — combined with the SVG sanitizer below.
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "dark",
          darkMode: true,
        });
        const { svg } = await mermaid.render(
          `senku-canvas-mmd-${Date.now().toString(36)}`,
          source.code
        );
        if (!alive) return;
        setMmd({ phase: "ready", svg: sanitizeSvg(svg) });
      } catch (e) {
        if (!alive) return;
        setMmd({
          phase: "error",
          message: (e as Error).message || "The diagram could not be rendered.",
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [source, canonical, tab]);

  // Escape closes the canvas (keyboard path).
  useEffect(() => {
    if (!canvasOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCanvas();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvasOpen, closeCanvas]);

  // On SMALL screens the canvas is an overlay dialog — move focus to
  // its close button so keyboard users aren't stranded behind it. On
  // wide screens it's a split view; stealing focus there would be
  // rude, so nothing is focused.
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!canvasOpen) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 1023px)").matches
    ) {
      closeRef.current?.focus();
    }
  }, [canvasOpen]);

  if (!canvasOpen) return null;

  return (
    <>
      {/* Overlay backdrop — small screens only */}
      <div
        className="fixed inset-0 z-40 bg-black/60 lg:hidden"
        onClick={closeCanvas}
        aria-hidden
      />
      <aside
        role="complementary"
        aria-label="Senku Canvas — code preview"
        className="senku-canvas-in fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-zinc-800/70 bg-[#141416] shadow-2xl lg:static lg:z-auto lg:h-auto lg:w-[420px] lg:max-w-none lg:shrink-0 lg:shadow-none"
      >
        {/* header: title · language badge · tabs · close */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-800/70 pl-3.5 pr-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
            Canvas
          </span>
          {canonical && (
            <span className="rounded-full border border-zinc-700 bg-zinc-800/60 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-zinc-400">
              {canonical}
            </span>
          )}
          <div
            role="tablist"
            aria-label="Canvas view"
            className="ml-auto flex items-center gap-0.5 rounded-lg bg-zinc-800/50 p-0.5"
          >
            <button
              id="senku-canvas-tab-preview"
              role="tab"
              aria-selected={tab === "preview"}
              aria-controls="senku-canvas-panel"
              onClick={() => setTab("preview")}
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                tab === "preview"
                  ? "bg-zinc-700/80 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Eye className="h-3 w-3" aria-hidden />
              Preview
            </button>
            <button
              id="senku-canvas-tab-code"
              role="tab"
              aria-selected={tab === "code"}
              aria-controls="senku-canvas-panel"
              onClick={() => setTab("code")}
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                tab === "code"
                  ? "bg-zinc-700/80 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Code2 className="h-3 w-3" aria-hidden />
              Code
            </button>
          </div>
          <button
            ref={closeRef}
            onClick={closeCanvas}
            aria-label="Close canvas"
            title="Close canvas (Escape)"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* body */}
        <div
          id="senku-canvas-panel"
          role="tabpanel"
          className="min-h-0 flex-1 overflow-hidden"
        >
          {!source ? (
            <CanvasPlaceholder />
          ) : tab === "code" ? (
            <CodeView language={source.language} code={source.code} />
          ) : canonical === null ? (
            <Notice
              icon={<FileWarning className="h-4 w-4" aria-hidden />}
              title="No renderer for this language"
            >
              The block is labeled “{source.language || "code"}” — previews are
              implemented for html, svg, mermaid, javascript and python only.
              The Code tab shows the exact source.
            </Notice>
          ) : isViewOnlyLang(canonical) ? (
            <Notice
              icon={<FileWarning className="h-4 w-4" aria-hidden />}
              title={`${canonical === "javascript" ? "JavaScript" : "Python"} doesn’t run in the preview`}
            >
              The Canvas sandbox has no script execution — running{" "}
              {canonical} in the browser is unsupported and is not simulated.
              Switch to the Code tab for the full source.
            </Notice>
          ) : canonical === "mermaid" ? (
            mmd.phase === "loading" ? (
              <div className="flex h-full items-center justify-center gap-2 text-[13px] text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Rendering diagram…
              </div>
            ) : mmd.phase === "error" ? (
              <Notice
                icon={<FileWarning className="h-4 w-4" aria-hidden />}
                title="Diagram failed to render"
              >
                {mmd.message} Check the Code tab for the diagram source —
                mermaid syntax errors are the usual cause.
              </Notice>
            ) : (
              <iframe
                title="Sandboxed mermaid preview"
                sandbox=""
                srcDoc={wrapPreviewDoc(mmd.svg)}
                className="h-full w-full border-0 bg-[#0d0d10]"
              />
            )
          ) : (
            // html · svg — static render, zero script execution
            <iframe
              title={`Sandboxed ${canonical} preview`}
              sandbox=""
              srcDoc={wrapPreviewDoc(source.code)}
              className="h-full w-full border-0 bg-[#0d0d10]"
            />
          )}
        </div>
      </aside>
    </>
  );
}

function CanvasPlaceholder() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/60">
        <Eye className="h-5 w-5 text-zinc-500" aria-hidden />
      </div>
      <p className="text-[13px] font-medium text-zinc-300">
        Nothing to preview yet
      </p>
      <p className="max-w-[280px] text-[11.5px] leading-relaxed text-zinc-500">
        Click <span className="text-zinc-300">Preview</span> on any{" "}
        <code className="senku-inline-code">html</code>,{" "}
        <code className="senku-inline-code">svg</code>,{" "}
        <code className="senku-inline-code">mermaid</code>,{" "}
        <code className="senku-inline-code">javascript</code> or{" "}
        <code className="senku-inline-code">python</code> block in a
        conversation — it opens here, sandboxed.
      </p>
    </div>
  );
}

function Notice({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-10 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-300">
        {icon}
      </div>
      <p className="text-[13px] font-medium text-zinc-200">{title}</p>
      <p className="max-w-[320px] text-[11.5px] leading-relaxed text-zinc-500">
        {children}
      </p>
    </div>
  );
}

function CodeView({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable — the code is fully visible for manual copy
    }
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center justify-end border-b border-zinc-800/60 bg-[#141417] px-2">
        <button
          onClick={() => void copy()}
          aria-label={copied ? "Code copied" : "Copy code"}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
            copied
              ? "text-emerald-400"
              : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
          }`}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="senku-scroll min-h-0 flex-1 overflow-auto">
        <SyntaxHighlighter
          language={language.toLowerCase() || "text"}
          style={SENKU_FORGE}
          PreTag="div"
          customStyle={{
            background: "transparent",
            margin: 0,
            padding: "0.85em 1em",
            fontSize: "12.5px",
            lineHeight: 1.65,
          }}
          codeTagProps={{
            style: {
              fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            },
          }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
