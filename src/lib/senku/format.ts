// SenkuAPI — token formatting helpers (client & server safe)

export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "∞";
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(Math.round(n));
}

export function formatFull(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "Tokens: 500,000 / 500.0k" style used by the top-bar pill. */
export function pillLabel(used: number, limit: number): string {
  return `Tokens: ${formatFull(used)} / ${formatCompact(limit)}`;
}

/** "resets in 4h 12m" / "resets in 43m" / "resets in <1m" — human
 *  countdown to the usage-day rollover (client-safe). */
export function countdownTo(iso: string, now: Date): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "resets any moment";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "resets in <1m";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `resets in ${m}m`;
  return `resets in ${h}h ${m.toString().padStart(2, "0")}m`;
}

/** Line count consistent across LF / CR / CRLF input (Run 17).
 *  Mirrors how editors count: one trailing newline does NOT open a
 *  new line ("a\nb" → 2, "a\n" → 1, "a" → 1, "a\n\n" → 2). Used by
 *  the >60-line pasted-snippet gate. */
export function countLines(text: string): number {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}
