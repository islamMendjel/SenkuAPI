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
