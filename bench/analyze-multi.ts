/**
 * Aggregate cross-provider results (bench/results/multi-*.jsonl).
 *
 *   npx tsx bench/analyze-multi.ts
 *   npx tsx bench/analyze-multi.ts --provider=openai
 *
 * Compares arms WITHIN each provider. Token and dollar magnitudes are not
 * comparable across providers — different tokenizers, different prices — so
 * the cross-provider claim is about whether the arm *ranking* is stable.
 */
import { readdirSync, readFileSync } from "node:fs";

// --dir lets an archived round be analysed without pooling it with the live
// top-level results, which would average two different library versions.
const dirArg = process.argv.find((a) => a.startsWith("--dir="))?.split("=")[1];
const DIR = dirArg
  ? (dirArg.endsWith("/") ? dirArg : dirArg + "/")
  : new URL("./results/", import.meta.url).pathname;
const ORDER = ["control","signatures","native","hybrid","minified-terse","minified","minified-default","minified-plus","minified-sig"];

type Row = {
  provider: string;
  model: string;
  scenario: string;
  arm: string;
  toolBlockTokens: number;
  turns: number;
  totalPromptTokens: number;
  metaCalls: number;
  correctToolCalls: number;
  expectedToolCalls: number;
  hallucinatedNames: number;
  malformedArgs: number;
  taskSuccess: boolean;
  wallMs: number;
  costUsd: number;
  cumulativeOccupancy?: number;
  error?: string;
  /** Which sweep produced this row — the results filename's timestamp. */
  sweep: string;
};

let rows: Row[] = [];
for (const f of readdirSync(DIR).filter((f) => f.startsWith("multi-") && f.endsWith(".jsonl"))) {
  // multi-<provider>-<timestamp>.jsonl — the timestamp identifies the sweep, and the
  // harness stamps it once per invocation, so every row from a run shares it.
  const sweep = f.replace(/^multi-[a-z]+-/, "").replace(/\.jsonl$/, "");
  for (const l of readFileSync(DIR + f, "utf8").split("\n")) {
    if (l.trim()) rows.push({ ...JSON.parse(l), sweep });
  }
}

const only = process.argv.find((a) => a.startsWith("--provider="))?.split("=")[1];

/**
 * --sweep=<timestamp-prefix> restricts analysis to ONE sweep.
 *
 * Not optional hygiene. Pooling sweeps silently mixes library versions, scenario
 * mixes and suites: this repo fixed three resolver bugs mid-session, so a pooled
 * `minified-nocode` row blends runs whose failures were later fixed, and reports a
 * task rate that describes no version of the code. It is the same error as averaging
 * cost across providers — an aggregate over incommensurable things.
 *
 * Run without it and you get a warning plus a list of the sweeps present.
 */
const sweep = process.argv.find((a) => a.startsWith("--sweep="))?.split("=")[1];
// Sweep identity is the results filename's timestamp, which the harness stamps once
// per invocation — so every row from one run shares it.
const sweepsPresent = [...new Set(rows.map((r) => r.sweep))].sort();
if (sweep) {
  rows = rows.filter((r) => r.sweep.startsWith(sweep));
  if (!rows.length) {
    console.error(`no rows for --sweep=${sweep}. Present:\n  ${sweepsPresent.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`scoped to sweep ${sweep} — ${rows.length} runs\n`);
} else if (sweepsPresent.length > 1) {
  console.log(
    `WARNING: ${sweepsPresent.length} sweeps pooled. Library versions, scenario mixes\n` +
      `and suites differ between them, so arm comparisons below are NOT valid.\n` +
      `Re-run with --sweep=<one of>:\n  ${sweepsPresent.join("\n  ")}\n`,
  );
}
const providers = [...new Set(rows.map((r) => r.provider))].sort();

const rank: Record<string, string[]> = {};

for (const p of providers) {
  if (only && p !== only) continue;
  const rs = rows.filter((r) => r.provider === p);
  const arms = [...new Set(rs.map((r) => r.arm))].sort(
    (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b),
  );
  const model = rs[0]?.model ?? "?";
  console.log(`\n━━━ ${p} · ${model} — ${rs.length} runs`);
  console.log(
    `${"arm".padEnd(15)}${"n".padStart(4)}${"block".padStart(8)}${"prompt".padStart(9)}` +
      `${"turns".padStart(7)}${"look".padStart(6)}${"correct".padStart(10)}` +
      `${"halluc".padStart(8)}${"malf".padStart(6)}${"ok".padStart(9)}` +
      `${"occupy".padStart(8)}${"lat".padStart(8)}${"cost/run".padStart(10)}${"median".padStart(9)}`,
  );

  const baseRows = rs.filter((r) => r.arm === "control");
  const basePrompt = baseRows.length
    ? baseRows.reduce((s, r) => s + r.totalPromptTokens, 0) / baseRows.length
    : 0;

  const median = (xs: number[]) => {
    const v = [...xs].sort((a, b) => a - b);
    if (!v.length) return 0;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const armStats: {
    arm: string; prompt: number; occupancy: number; ok: number; n: number;
  }[] = [];

  for (const arm of arms) {
    const a = rs.filter((r) => r.arm === arm);
    const n = a.length;
    const avg = (f: (r: Row) => number) => a.reduce((s, r) => s + f(r), 0) / n;
    const sum = (f: (r: Row) => number) => a.reduce((s, r) => s + f(r), 0);
    const correct = sum((r) => r.correctToolCalls);
    const expected = sum((r) => r.expectedToolCalls);
    const ok = sum((r) => (r.taskSuccess ? 1 : 0));
    const prompt = avg((r) => r.totalPromptTokens);
    const occupancy = avg((r) => r.cumulativeOccupancy ?? 0);
    armStats.push({ arm, prompt, occupancy, ok, n });

    console.log(
      `${arm.padEnd(15)}${String(n).padStart(4)}` +
        `${avg((r) => r.toolBlockTokens).toFixed(0).padStart(8)}` +
        `${prompt.toFixed(0).padStart(9)}` +
        `${avg((r) => r.turns).toFixed(1).padStart(7)}` +
        `${avg((r) => r.metaCalls).toFixed(1).padStart(6)}` +
        `${`${correct}/${expected}`.padStart(10)}` +
        `${String(sum((r) => r.hallucinatedNames)).padStart(8)}` +
        `${String(sum((r) => r.malformedArgs)).padStart(6)}` +
        `${`${ok}/${n}`.padStart(9)}` +
        `${occupancy.toFixed(0).padStart(8)}` +
        `${(avg((r) => r.wallMs) / 1000).toFixed(1).padStart(7)}s` +
        `${("$" + avg((r) => r.costUsd).toFixed(4)).padStart(10)}` +
        `${("$" + median(a.map((r) => r.costUsd)).toFixed(4)).padStart(9)}`,
    );
  }

  if (basePrompt) {
    const deltas = armStats
      .filter((s) => s.arm !== "control")
      .map((s) => `${s.arm} ${(((s.prompt - basePrompt) / basePrompt) * 100).toFixed(0)}%`);
    console.log(`    vs control: ${deltas.join("  ·  ")}`);
  }

  // Rank among arms that completed every task. Occupancy first, because
  // reclaiming context window is the product's claim — caching already handles most
  // of the cost, but it does not reclaim the room.
  const clean = armStats.filter((s) => s.ok === s.n && s.arm !== "control");
  const byOcc = [...clean].sort((a, b) => a.occupancy - b.occupancy);
  clean.sort((a, b) => a.prompt - b.prompt);
  rank[p] = byOcc.map((s) => s.arm);
  console.log(`    least occupancy first: ${byOcc.map((s) => s.arm).join(" < ") || "(none)"}`);
  const dirty = armStats.filter((s) => s.ok !== s.n).map((s) => `${s.arm} (${s.ok}/${s.n})`);
  console.log(
    `    smallest-first among arms with a perfect task rate: ${clean.map((s) => s.arm).join(" < ") || "(none)"}` +
      (dirty.length ? `\n    NOT perfect: ${dirty.join(", ")}` : ""),
  );
}

console.log(
  "\nNOTE: no cross-provider aggregate is printed, deliberately. An anthropic run\n" +
    "costs ~10x a gemini/openai/xai run on this suite, so a mean over providers\n" +
    "reports anthropic and little else. One arm measured +7.8% on that mean while\n" +
    "being -39% on gemini and -16% on openai. Compare within a provider, or use the\n" +
    "median column. See brain decision #25.",
);
console.log("\n━━━ ranking stability across providers");
const keys = Object.keys(rank);
if (keys.length) {
  const first = JSON.stringify(rank[keys[0]]);
  const stable = keys.every((k) => JSON.stringify(rank[k]) === first);
  for (const k of keys) console.log(`    ${k.padEnd(10)} ${rank[k].join(" < ")}`);
  console.log(
    stable
      ? `\n    STABLE — same ordering on all ${keys.length} providers.`
      : `\n    NOT STABLE — ordering differs by provider. Report this, do not average it away.`,
  );
}
console.log();
