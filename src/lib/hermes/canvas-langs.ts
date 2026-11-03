// Hermes — Hermes Canvas language support (Run 17).
//
// ONLY these fence labels (plus their obvious aliases) get a
// "Preview in Tools" control. An unlabeled or unknown-language block
// is NEVER offered for preview — we do not infer that unmarked code
// is safe to render, and we do not guess formats.

export const PREVIEW_LANGS = [
  "html",
  "svg",
  "mermaid",
  "javascript",
  "python",
] as const;

export type PreviewLang = (typeof PREVIEW_LANGS)[number];

const ALIASES: Record<string, PreviewLang> = {
  html: "html",
  svg: "svg",
  mermaid: "mermaid",
  javascript: "javascript",
  js: "javascript",
  mjs: "javascript",
  node: "javascript",
  python: "python",
  py: "python",
};

/** Canonical preview language for a markdown fence label, or null
 *  when the block's language is not previewable. */
export function canonicalPreviewLang(lang: string): PreviewLang | null {
  const key = lang.toLowerCase().trim();
  return ALIASES[key] ?? null;
}

/** True for languages that can only be VIEWED in the canvas (no
 *  browser renderer exists): JavaScript and Python get an honest
 *  "execution is unsupported" notice, never a pretend run. */
export function isViewOnlyLang(lang: PreviewLang): boolean {
  return lang === "javascript" || lang === "python";
}
