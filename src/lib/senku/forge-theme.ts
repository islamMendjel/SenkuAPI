// SenkuAPI — Run 31: THE FORGE THEME.
//
// A design audit pointed the VLM critic at the one surface Run 30
// never touched — the code blocks — and scored it 4/10: "the prose
// says we care about every pixel; the code says we installed the
// default theme." The stock oneDark ramp is a COOL spectrum (purple
// keywords #c678dd, cyan functions #61afef) pasted into an amber
// product. For a developer gateway the code block is arguably the
// most on-brand surface possible — this is the in-house replacement.
//
// The ramp ("forge") is Ayu-warm tuned to the brand: functions carry
// the signature amber, keywords warm orange, strings sage, types a
// muted teal, literals soft violet — a proven warm-theme ensemble
// (Ayu/Gruvbox lineage) anchored on the gold identity, over a
// candle-lit warm-black stage.
//
// Prism's alias mechanism maps TSX-specific token names
// (control-flow, nil, generic-function…) onto the standard keys via
// the power-set merge in react-syntax-highlighter; names below are
// ALSO declared explicitly wherever the intended color must not
// depend on the alias du jour. Order matters: within one span the
// LATER class's style wins, so deliberately UNdeclared names (e.g.
// property-access) fall through to the token they accompany.

import type { CSSProperties } from "react";

/** Token → style. Keys are Prism token names (standard + TSX) and the
 *  two base selectors react-syntax-highlighter reads for the <code>
 *  element's base color. */
export const SENKU_FORGE: Record<string, CSSProperties> = {
  // base — warm ivory plain text (the stage: #17130e, see Markdown.tsx)
  'code[class*="language-"]': { color: "#e8e2d2" },
  'pre[class*="language-"]': { color: "#e8e2d2" },

  // comments recede — warm gray-olive, italic (the darkest tier:
  // strings/types/comments live in three distinct values)
  comment: { color: "#6f6657", fontStyle: "italic" },
  prolog: { color: "#6f6657", fontStyle: "italic" },
  doctype: { color: "#6f6657", fontStyle: "italic" },
  cdata: { color: "#6f6657", fontStyle: "italic" },

  // punctuation & operators — sand a clear step below the ivory
  // identifiers (audit calibration: commas must never vanish)
  punctuation: { color: "#93876f" },
  operator: { color: "#93876f" },
  entity: { color: "#93876f" },
  url: { color: "#93876f" },
  arrow: { color: "#93876f" },
  spread: { color: "#93876f" },

  // keywords — warm orange (commands attention, defers amber to functions)
  keyword: { color: "#ef9f4f" },
  "control-flow": { color: "#ef9f4f" },
  module: { color: "#ef9f4f" },
  imports: { color: "#ef9f4f" },
  atrule: { color: "#ef9f4f" },
  tag: { color: "#ef9f4f" },

  // functions & calls — THE brand amber
  function: { color: "#f2b64e" },
  "function-variable": { color: "#f2b64e" },
  "generic-function": { color: "#f2b64e" },
  method: { color: "#f2b64e" },
  dom: { color: "#f2b64e" },

  // types & classes — muted teal (the calm counterpoint; a touch
  // brighter than sage's neighbors for value separation)
  "class-name": { color: "#72c0d4" },
  "maybe-class-name": { color: "#72c0d4" },
  "known-class-name": { color: "#72c0d4" },
  generic: { color: "#72c0d4" },

  // strings — sage (Ayu lineage; the brightest mid-tier)
  string: { color: "#b0c85a" },
  char: { color: "#b0c85a" },
  builtin: { color: "#b0c85a" },
  inserted: { color: "#b0c85a" },
  selector: { color: "#b0c85a" },
  "attr-value": { color: "#b0c85a" },

  // literals — soft violet (numbers, booleans, null, constants)
  boolean: { color: "#bd9ae6" },
  number: { color: "#bd9ae6" },
  constant: { color: "#bd9ae6" },
  symbol: { color: "#bd9ae6" },
  nil: { color: "#bd9ae6" },

  // attributes & properties — gold
  "attr-name": { color: "#dbb063" },
  property: { color: "#dbb063" },

  // the rest
  regex: { color: "#dbb063" },
  important: { color: "#f2b64e", fontWeight: "bold" },
  variable: { color: "#e8e2d2" },
  deleted: { color: "#e06c75" },
  bold: { fontWeight: "bold" },
  italic: { fontStyle: "italic" },
  namespace: { opacity: 0.7 },
};
