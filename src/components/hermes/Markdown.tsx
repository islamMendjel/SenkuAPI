"use client";

// Hermes — shared markdown renderer for assistant messages.
// Pro code experience: blocks get syntax highlighting, a language
// badge and one-click copy — the surface developers on an AI
// gateway look at the most. Inline code stays subtle zinc.
// Run 26 — remark-gfm: models emit GFM constantly (comparison
// tables, ~~strikethrough~~, task lists, bare URLs). Without the
// plugin a table rendered as raw pipe-text soup; now it renders as
// a real, styled, scrollable table on both the streamed and the
// settled path (StreamedMarkdown delegates to this component).
// Run 36 — THE SANDBOX ALIVE: js/javascript/mjs/node blocks gain a
// Run control — the code executes in a sandboxed iframe (opaque
// origin, no network, 5 s cap) and its console streams into a
// forge-styled panel under the block. Every other language is
// unchanged; nothing here touches the streaming pipeline.

import { memo, useCallback, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, PanelRight, Play, WrapText } from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { HERMES_FORGE } from "@/lib/hermes/forge-theme";
import { useHermes } from "@/lib/store";
import { canonicalPreviewLang } from "@/lib/hermes/canvas-langs";
import { isRunnableJs } from "@/lib/hermes/js-runner";
import { RunConsole, useJsRunner } from "./RunConsole";

/** Markdown fence tag → Prism language id. */
const PRISM_LANG: Record<string, string> = {
  html: "markup",
  xml: "markup",
  svg: "markup",
  vue: "markup",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  node: "javascript",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  yml: "yaml",
  dockerfile: "docker",
  tf: "hcl",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  kts: "kotlin",
  md: "markdown",
};

function resolvePrismLang(lang: string): string {
  const l = lang.toLowerCase();
  return PRISM_LANG[l] ?? l;
}

/** Run 36 — dispatcher: runnable languages get the live variant
 *  (Run control + sandbox console); everything else stays the
 *  static block. Split so runner hooks only exist on runnable
 *  blocks. */
const CodeBlock = memo(function CodeBlock(props: {
  language: string;
  code: string;
}) {
  if (isRunnableJs(props.language)) return <RunnableCodeBlock {...props} />;
  return <StaticCodeBlock {...props} />;
});

/** The static block — the Run 31 forge card. `railExtra` and
 *  `footer` are the live variant's injection points; both default
 *  to nothing, so plain blocks render exactly as before. */
const StaticCodeBlock = memo(function StaticCodeBlock({
  language,
  code,
  railExtra,
  footer,
}: {
  language: string;
  code: string;
  railExtra?: ReactNode;
  footer?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  // Run 17 — line wrapping toggle + Tools-panel preview. The store
  // subscription uses a STABLE selector (the action reference), so
  // streaming store updates never re-render settled code blocks.
  const [wrapped, setWrapped] = useState(false);
  const openCanvas = useHermes((s) => s.openCanvas);
  const previewLang = canonicalPreviewLang(language);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable (permissions) — fail silently
    }
  }, [code]);

  const label = language || "code";

  return (
    <div className="hermes-code my-3 overflow-hidden rounded-xl border border-[#332a1a] bg-[#17130e]">
      {/* sticky header: language badge · wrap · preview-in-Tools · copy.
          Run 31 — the chrome joins the forge: warm-black stage,
          candle-lit header, amber language badge. */}
      <div className="sticky top-0 z-10 flex h-9 items-center justify-between gap-1 border-b border-[#2b2314] bg-[#1e1812] pl-3.5 pr-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-amber-200/60">
          {label}
        </span>
        <div className="flex items-center gap-0.5">
          {railExtra}
          <button
            onClick={() => setWrapped((w) => !w)}
            aria-pressed={wrapped}
            aria-label={wrapped ? "Unwrap lines" : "Wrap lines"}
            title={wrapped ? "Unwrap lines" : "Wrap long lines"}
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
              wrapped
                ? "text-zinc-100"
                : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
            }`}
          >
            <WrapText className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">{wrapped ? "Unwrap" : "Wrap"}</span>
          </button>
          {previewLang && (
            <button
              onClick={() => openCanvas({ language: previewLang, code })}
              aria-label={`Preview this ${previewLang} block in the Tools panel`}
              title="Open in the Senku Canvas (sandboxed preview)"
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
            >
              <PanelRight className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">Preview</span>
            </button>
          )}
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
      </div>

      <SyntaxHighlighter
        language={resolvePrismLang(language)}
        style={HERMES_FORGE}
        PreTag="div"
        wrapLongLines={wrapped}
        customStyle={{
          background: "transparent",
          margin: 0,
          padding: "0.85em 1em",
          fontSize: "12.75px",
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
      {footer}
    </div>
  );
});

/** The live variant (Run 36): a Run control in the rail, the
 *  hidden sandbox iframe, and — after the first run — the forge
 *  console attached under the block. State resets automatically
 *  when the code itself changes (streaming appends). */
function RunnableCodeBlock({
  language,
  code,
}: {
  language: string;
  code: string;
}) {
  const runner = useJsRunner(code);
  return (
    <>
      {runner.sandbox}
      <StaticCodeBlock
        language={language}
        code={code}
        railExtra={
          runner.status === "running" ? null : (
            <button
              onClick={runner.run}
              aria-label="Run this JavaScript in the sandbox"
              title="Run — executes in a sandboxed iframe (no network, 5 s cap)"
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-400/10 hover:text-amber-200"
            >
              <Play className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">Run</span>
            </button>
          )
        }
        footer={runner.hasRun ? <RunConsole runner={runner} /> : null}
      />
    </>
  );
}

/** Extract fenced-code info from the <code> element inside <pre>. */
function extractCode(children: ReactNode): {
  language: string;
  code: string;
} {
  let language = "";
  let content = "";
  if (
    children &&
    typeof children === "object" &&
    "props" in (children as ReactElement)
  ) {
    const el = children as ReactElement<{
      className?: string;
      children?: ReactNode;
    }>;
    language = /language-([\w+-]+)/.exec(el.props.className ?? "")?.[1] ?? "";
    const raw = el.props.children;
    content =
      typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join("") : "";
  }
  return { language, code: content.replace(/\n$/, "") };
}

const MarkdownInner = function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={MARKDOWN_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  );
};

/** Stable component identities: React reconciles the markdown tree
 *  between streaming renders instead of remounting it (only the
 *  growing block re-highlights, completed blocks are memo-skipped). */
const MARKDOWN_COMPONENTS: Components = {
  // <pre> only wraps fenced blocks — replace the whole box
  pre: ({ children }) => {
    const { language, code } = extractCode(children);
    return <CodeBlock language={language} code={code} />;
  },
  // remaining <code> elements are inline
  code: ({ children, className }) => (
    <code className={`hermes-inline-code ${className ?? ""}`}>
      {children}
    </code>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-amber-300/90 underline decoration-amber-300/30 underline-offset-2 hover:text-amber-200"
    >
      {children}
    </a>
  ),
  // Run 26 — GFM tables; Run 30 — the breathing rebuild. The audit's
  // "cramped cells + ghost double-edge" fix: an outer wrapper that
  // owns the rounded border and clips (overflow-hidden), an inner
  // div that scrolls horizontally, and a table with real padding, a
  // calmer header, and a scan-friendly row hover. th/td keep GFM
  // alignment via the style prop.
  table: ({ children }) => (
    <div className="my-3.5 overflow-hidden rounded-xl border border-zinc-800/90 bg-[#17171a]">
      <div className="hermes-scroll overflow-x-auto">
        <table className="w-full min-w-[440px] border-collapse text-[13px] sm:min-w-0">
          {children}
        </table>
      </div>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-[#1b1b1f]">{children}</thead>,
  th: ({ children, style }) => (
    <th
      style={style}
      className="border-b border-zinc-700/80 px-3.5 py-2.5 text-left text-[11.5px] font-semibold tracking-[0.02em] whitespace-nowrap text-zinc-300 [&:not(:last-child)]:border-r [&:not(:last-child)]:border-zinc-800/60"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td
      style={style}
      className="border-b border-zinc-800/50 px-3.5 py-2.5 align-top text-zinc-300 [&:not(:last-child)]:border-r [&:not(:last-child)]:border-zinc-800/40"
    >
      {children}
    </td>
  ),
  tr: ({ children }) => (
    <tr className="transition-colors even:bg-white/[0.02] hover:bg-white/[0.035] [&:last-child>td]:border-b-0">
      {children}
    </tr>
  ),
};

/** Memoized: during streaming only changed messages re-render. */
export const Markdown = memo(MarkdownInner);
