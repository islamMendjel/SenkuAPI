// Hermes — THE SANDBOX ALIVE (Run 36): in-browser JavaScript
// execution for assistant code blocks.
//
// The browser IS the interpreter: user code runs inside a srcdoc
// iframe whose sandbox attribute is `allow-scripts` ONLY — an
// OPAQUE origin (no cookies, no localStorage, no same-origin API
// access, no DOM of ours). A restrictive CSP then denies every
// network primitive (connect-src 'none' — fetch/XHR/WebSocket/
// EventSource cannot leave), and the bootstrap shadows the same
// APIs with honest throwing stubs so a blocked call is a CLEAR
// error, never a silent CSP violation.
//
// Console contract: log/info/warn/error (+ table/time/timeEnd
// fallbacks) stream to the parent via postMessage, stringified
// INSIDE the sandbox so nothing but plain text ever crosses the
// boundary. Uncaught errors and unhandled rejections stream as
// error lines. `done` carries the elapsed time; a 5 s hard cap in
// the parent reaps infinite loops and hung programs.

/** Hard cap for one sandbox run, measured from run start. */
export const RUNNER_TIMEOUT_MS = 5000;

const RUNNABLE_ALIASES = new Set(["js", "javascript", "mjs", "node"]);

/** True when a fenced block's language is runnable in the sandbox. */
export function isRunnableJs(lang: string): boolean {
  return RUNNABLE_ALIASES.has(lang.toLowerCase().trim());
}

export type RunLevel = "log" | "info" | "warn" | "error" | "system";
export type RunStatus = "idle" | "running" | "ok" | "error" | "timeout";

export interface RunLine {
  level: RunLevel;
  text: string;
}

/** Shape of every message the sandbox posts to its parent. */
type SandboxMessage =
  | { hermes: "run"; kind: "log"; level: RunLevel; text: string }
  | { hermes: "run"; kind: "clear" }
  | { hermes: "run"; kind: "error"; text: string; elapsedMs?: number }
  | { hermes: "run"; kind: "done"; elapsedMs: number };

/** Guard for the parent side of the postMessage contract. */
export function isSandboxMessage(data: unknown): data is SandboxMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { hermes?: unknown }).hermes === "run"
  );
}

/** The sandbox CSP: the user's inline script may run (that IS the
 *  feature), `unsafe-eval` powers the AsyncFunction compile with
 *  real syntax-error diagnostics, and NOTHING may connect out. */
const RUNNER_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; " +
  "media-src data:; connect-src 'none'; child-src 'none'; " +
  "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Serializer used INSIDE the sandbox: plain-text rendering of any
 *  argument, circular-safe, depth-capped, width-truncated. */
const SERIALIZE_FN = `
var __seen;
function __ser(v, d) {
  try {
    if (v === null) return "null";
    var t = typeof v;
    if (t === "string") return d ? JSON.stringify(v) : v;
    if (t === "number" || t === "boolean" || t === "undefined") return String(v);
    if (t === "bigint") return String(v) + "n";
    if (t === "symbol") return v.toString();
    if (t === "function") return "[function " + (v.name || "anonymous") + "]";
    if (v instanceof Error) return v.stack || (v.name + ": " + v.message);
    if (__seen.has(v)) return "[circular]";
    if (d > 3) return Array.isArray(v) ? "[\u2026]" : "{\u2026}";
    __seen.add(v);
    if (Array.isArray(v)) {
      if (v.length > 100) return "[" + v.slice(0, 100).map(function (x) { return __ser(x, d + 1); }).join(", ") + ", \u2026 +" + (v.length - 100) + "]";
      return "[" + v.map(function (x) { return __ser(x, d + 1); }).join(", ") + "]";
    }
    if (v instanceof Map) {
      var m = [];
      v.forEach(function (val, key) { if (m.length < 100) m.push(__ser(key, d + 1) + " => " + __ser(val, d + 1)); });
      return "Map(" + v.size + ") {" + m.join(", ") + "}";
    }
    if (v instanceof Set) {
      var s = [];
      v.forEach(function (val) { if (s.length < 100) s.push(__ser(val, d + 1)); });
      return "Set(" + v.size + ") {" + s.join(", ") + "}";
    }
    var keys = Object.keys(v);
    var body = keys.slice(0, 50).map(function (k) { return JSON.stringify(k) + ": " + __ser(v[k], d + 1); });
    if (keys.length > 50) body.push("\u2026 +" + (keys.length - 50) + " more");
    var tag = (v.constructor && v.constructor.name && v.constructor.name !== "Object") ? v.constructor.name + " " : "";
    return tag + "{" + body.join(", ") + "}";
  } catch (e) {
    return "[unserializable]";
  }
}
function __fmt(args) {
  var out = [];
  for (var i = 0; i < args.length && i < 12; i++) {
    __seen = new WeakSet();
    out.push(__ser(args[i], 0));
  }
  for (; i < args.length; i++) out.push("\u2026");
  var text = out.join(" ");
  return text.length > 400 ? text.slice(0, 400) + "\u2026" : (text || "(empty)");
}
`;

/** The sandbox document: CSP, console bridge, honest network
 *  stubs, error capture, and the user code compiled as an
 *  AsyncFunction (top-level await works; syntax errors land in
 *  the catch and stream as ordinary error lines). */
export function buildRunnerDoc(code: string): string {
  // The payload rides in a JSON <script type="application/json">
  // block — `<` escaped so "</script>" inside user code can never
  // terminate the host tag, and line separators for JSON safety.
  const payload = JSON.stringify(code)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${RUNNER_CSP}">
</head><body>
<script id="hermes-payload" type="application/json">${payload}</script>
<script>
(function () {
  "use strict";
  var post = function (msg) {
    msg.hermes = "run";
    try { parent.postMessage(msg, "*"); } catch (e) {}
  };
  ${SERIALIZE_FN}
  var bridged = function (level) {
    return function () { post({ kind: "log", level: level, text: __fmt(arguments) }); };
  };
  console.log = bridged("log");
  console.info = bridged("info");
  console.warn = bridged("warn");
  console.error = bridged("error");
  console.debug = console.log;
  console.trace = function () { post({ kind: "log", level: "warn", text: "trace\\n" + new Error().stack }); };
  console.table = function (data) { post({ kind: "log", level: "log", text: __ser(data, 0) }); };
  var timers = {};
  console.time = function (label) { timers[label || "default"] = performance.now(); };
  console.timeEnd = function (label) {
    var k = label || "default";
    var t0 = timers[k];
    if (t0 !== undefined) {
      delete timers[k];
      post({ kind: "log", level: "info", text: k + ": " + (Math.round((performance.now() - t0) * 100) / 100) + " ms" });
    }
  };
  console.clear = function () { post({ kind: "clear" }); };
  // Modals are sandboxed away — turn them into honest log lines.
  window.alert = function (msg) { __seen = new WeakSet(); post({ kind: "log", level: "info", text: "[alert] " + __ser(msg, 0) }); };
  window.confirm = function (msg) { post({ kind: "log", level: "warn", text: "[confirm] " + String(msg) + " → false (sandbox)" }); return false; };
  window.prompt = function (msg) { post({ kind: "log", level: "warn", text: "[prompt] " + String(msg) + " → null (sandbox)" }); return null; };
  // Network is disabled at the CSP layer; these stubs make the
  // contract LOUD instead of a silent violation.
  var blocked = function (name) {
    return function () {
      throw new Error(name + " is disabled in the Hermes sandbox — no network from user code.");
    };
  };
  window.fetch = blocked("fetch");
  window.XMLHttpRequest = blocked("XMLHttpRequest");
  window.WebSocket = blocked("WebSocket");
  window.EventSource = blocked("EventSource");
  window.importScripts = blocked("importScripts");
  window.open = blocked("window.open");
  // Error capture. ONE message ends an errored run: fail() posts
  // the text WITH the elapsed time (no second "done"-ish post), so
  // the parent sees exactly one terminal error per run. Errors
  // arriving after a settled run are late lines, not a new result.
  var doneSent = false;
  var elapsed = function () {
    return Math.round((performance.now() - t0) * 100) / 100;
  };
  var fail = function (text) {
    if (doneSent) {
      post({ kind: "error", text: text });
      return;
    }
    doneSent = true;
    post({ kind: "error", text: text, elapsedMs: elapsed() });
  };
  window.onerror = function (m, s, line, col) {
    fail(m + " (line " + line + (col ? ":" + col : "") + ")");
    return true;
  };
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    fail("Unhandled rejection: " + ((r && r.message) ? r.message : __ser(r, 0)));
  });
  // Compile + run.
  var t0 = performance.now();
  var finish = function () {
    if (doneSent) return;
    doneSent = true;
    post({ kind: "done", elapsedMs: elapsed() });
  };
  var codeText = JSON.parse(document.getElementById("hermes-payload").textContent);
  var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    var fn = new AsyncFunction('"use strict";' + codeText);
    Promise.resolve(fn()).then(
      function () { finish(); },
      function (e) { fail((e && e.message) ? e.message : String(e)); }
    );
  } catch (e) {
    fail((e && e.message) ? e.message : String(e));
  }
})();
</script></body></html>`;
}

/** Human timing for the status chip: "123 ms" / "1.24 s". */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
