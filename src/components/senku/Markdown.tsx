"use client";

// SenkuAPI — shared markdown renderer for assistant messages.
// Pro code experience: blocks get syntax highlighting, a language
// badge and one-click copy — the surface developers on an AI
// gateway look at the most. Inline code stays subtle zinc.

import { memo, useCallback, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { Check, Copy, PanelRight, WrapText } from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useSenku } from "@/lib/store";
import { canonicalPreviewLang } from "@/lib/senku/canvas-langs";

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

const CodeBlock = memo(function CodeBlock({
  language,
  code,
}: {
  language: string;
  code: string;
}) {
  const [copied, setCopied] = useState(false);
  // Run 17 — line wrapping toggle + Tools-panel preview. The store
  // subscription uses a STABLE selector (the action reference), so
  // streaming store updates never re-render settled code blocks.
  const [wrapped, setWrapped] = useState(false);
  const openCanvas = useSenku((s) => s.openCanvas);
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
    <div className="senku-code my-3 overflow-hidden rounded-xl border border-zinc-800 bg-[#0d0d10]">
      {/* sticky header: language badge · wrap · preview-in-Tools · copy */}
      <div className="sticky top-0 z-10 flex h-9 items-center justify-between gap-1 border-b border-zinc-800/80 bg-[#141417] pl-3.5 pr-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-zinc-500">
          {label}
        </span>
        <div className="flex items-center gap-0.5">
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
        style={oneDark}
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
    </div>
  );
});

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
    <ReactMarkdown components={MARKDOWN_COMPONENTS}>{content}</ReactMarkdown>
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
    <code className={`senku-inline-code ${className ?? ""}`}>
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
};

/** Memoized: during streaming only changed messages re-render. */
export const Markdown = memo(MarkdownInner);
