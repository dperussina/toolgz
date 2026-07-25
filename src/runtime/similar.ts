/**
 * Nearest-name matching for argument-error messages.
 *
 * Motivation, from measurement: across 360 benchmark runs the single most
 * common failure was a model passing `query` to a parameter named `q` — 14 of
 * 18 rejections. Each one burned a turn, and on a reasoning model a wasted turn
 * is a wasted round of thinking, so this is a cost problem as much as a
 * correctness one.
 *
 * We deliberately do NOT auto-remap. Silently moving a value from `query` to
 * `q` would be guessing about caller intent, and a wrong guess dispatches bad
 * data instead of raising. Instead we name the likely fix so the retry lands
 * first time.
 */

/** Levenshtein distance, iterative single-row. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/** `per_page` / `perPage` / `PerPage` all normalise to `perpage`. */
const norm = (s: string) => s.toLowerCase().replace(/[_\-\s]/g, "");

/** Split camelCase and snake_case into lowercase word parts. */
const words = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

/**
 * Similarity in 0–100. Tuned so the cases we actually observed score high:
 * `q`↔`query` (prefix), `pageSize`↔`per_page` (shared word), and unrelated
 * names stay low enough to be filtered out.
 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 100;

  // A short name that prefixes a longer one is the `q`/`query` case.
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (long.startsWith(short) || long.endsWith(short)) return 85;

  const wa = new Set(words(a));
  const wb = new Set(words(b));
  const shared = [...wa].filter((w) => wb.has(w) && w.length > 2).length;
  if (shared) {
    const union = new Set([...wa, ...wb]).size;
    return 50 + Math.round((shared / union) * 30);
  }

  if (long.includes(short) && short.length >= 3) return 60;

  const dist = editDistance(na, nb);
  const ratio = 1 - dist / Math.max(na.length, nb.length);
  return Math.max(0, Math.round(ratio * 55));
}

/**
 * Closest candidate to `name`, or null when nothing is close enough to be worth
 * suggesting. The floor matters: a bad suggestion is worse than none, because
 * the model will act on it.
 */
export function nearest(
  name: string,
  candidates: readonly string[],
  floor = 55,
): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const s = similarity(name, c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return bestScore >= floor ? best : null;
}
