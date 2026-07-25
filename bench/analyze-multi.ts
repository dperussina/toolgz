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

const DIR = new URL("./results/", import.meta.url).pathname;
const ORDER = ["control","signatures","native","hybrid","minified-terse","minified","minified-default","minified-plus"];

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
  error?: string;
};

const rows: Row[] = [];
for (const f of readdirSync(DIR).filter((f) => f.startsWith("multi-") && f.endsWith(".jsonl"))) {
  for (const l of readFileSync(DIR + f, "utf8").split("\n")) {
    if (l.trim()) rows.push(JSON.parse(l));
  }
}

const only = process.argv.find((a) => a.startsWith("--provider="))?.split("=")[1];
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
      `${"lat".padStart(8)}${"cost".padStart(9)}`,
  );

  const baseRows = rs.filter((r) => r.arm === "control");
  const basePrompt = baseRows.length
    ? baseRows.reduce((s, r) => s + r.totalPromptTokens, 0) / baseRows.length
    : 0;

  const armStats: { arm: string; prompt: number; ok: number; n: number }[] = [];

  for (const arm of arms) {
    const a = rs.filter((r) => r.arm === arm);
    const n = a.length;
    const avg = (f: (r: Row) => number) => a.reduce((s, r) => s + f(r), 0) / n;
    const sum = (f: (r: Row) => number) => a.reduce((s, r) => s + f(r), 0);
    const correct = sum((r) => r.correctToolCalls);
    const expected = sum((r) => r.expectedToolCalls);
    const ok = sum((r) => (r.taskSuccess ? 1 : 0));
    const prompt = avg((r) => r.totalPromptTokens);
    armStats.push({ arm, prompt, ok, n });

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
        `${(avg((r) => r.wallMs) / 1000).toFixed(1).padStart(7)}s` +
        `${("$" + sum((r) => r.costUsd).toFixed(3)).padStart(9)}`,
    );
  }

  if (basePrompt) {
    const deltas = armStats
      .filter((s) => s.arm !== "control")
      .map((s) => `${s.arm} ${(((s.prompt - basePrompt) / basePrompt) * 100).toFixed(0)}%`);
    console.log(`    vs control: ${deltas.join("  ·  ")}`);
  }

  // Rank by prompt tokens among arms that completed every task.
  const clean = armStats.filter((s) => s.ok === s.n && s.arm !== "control");
  clean.sort((a, b) => a.prompt - b.prompt);
  rank[p] = clean.map((s) => s.arm);
  const dirty = armStats.filter((s) => s.ok !== s.n).map((s) => `${s.arm} (${s.ok}/${s.n})`);
  console.log(
    `    smallest-first among arms with a perfect task rate: ${clean.map((s) => s.arm).join(" < ") || "(none)"}` +
      (dirty.length ? `\n    NOT perfect: ${dirty.join(", ")}` : ""),
  );
}

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
