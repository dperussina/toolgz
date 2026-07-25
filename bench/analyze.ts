/**
 * Aggregate benchmark results from raw JSONL.
 *
 * Reads `bench/results/results-*.jsonl` and prints a per-arm summary, grouped
 * by model. Aggregating across models would be meaningless, so results are
 * keyed by the `model` field (older files predate that field and are attributed
 * to claude-opus-5, which is what produced them).
 *
 *   npx tsx bench/analyze.ts                     # every model found
 *   npx tsx bench/analyze.ts --model=claude-sonnet-5
 *   npx tsx bench/analyze.ts --file=<path.jsonl> # one specific sweep
 *
 * This reads only committed evidence — it never calls the API.
 */
import { readdirSync, readFileSync } from "node:fs";

const RESULTS_DIR = new URL("./results/", import.meta.url).pathname;
const ARM_ORDER = ["control", "signatures", "native", "hybrid", "minified"];

type Row = {
  model?: string;
  scenario: string;
  arm: string;
  rep: number;
  toolBlockTokens: number;
  turns: number;
  totalPromptTokens: number;
  cumulativeOccupancy: number;
  metaCalls: number;
  correctToolCalls: number;
  expectedToolCalls: number;
  hallucinatedNames: number;
  malformedArgs: number;
  taskSuccess: boolean;
  wallMs: number;
  costUsd: number;
};

function load(): Row[] {
  const fileArg = process.argv
    .find((a) => a.startsWith("--file="))
    ?.split("=")[1];
  const files = fileArg
    ? [fileArg]
    : readdirSync(RESULTS_DIR)
        .filter((f) => f.startsWith("results-") && f.endsWith(".jsonl"))
        .map((f) => RESULTS_DIR + f);

  const rows: Row[] = [];
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      const r = JSON.parse(s) as Row;
      // Files written before the model field existed were all Opus 5.
      r.model ??= "claude-opus-5";
      rows.push(r);
    }
  }
  return rows;
}

function summarize(model: string, rows: Row[]) {
  const arms = [...new Set(rows.map((r) => r.arm))].sort(
    (a, b) => ARM_ORDER.indexOf(a) - ARM_ORDER.indexOf(b),
  );

  console.log(`\n━━━ ${model} — ${rows.length} runs`);
  const scenarios = [...new Set(rows.map((r) => r.scenario))];
  console.log(
    `    ${scenarios.length} scenarios: ${scenarios.join(", ")}\n`,
  );
  console.log(
    `${"arm".padEnd(12)}${"n".padStart(4)}${"block".padStart(8)}${"prompt".padStart(9)}` +
      `${"turns".padStart(7)}${"look".padStart(6)}${"correct".padStart(10)}` +
      `${"halluc".padStart(8)}${"malf".padStart(6)}${"ok".padStart(8)}` +
      `${"lat".padStart(8)}${"cost".padStart(9)}`,
  );

  const base = rows.filter((r) => r.arm === "control");
  const basePrompt = base.length
    ? base.reduce((s, r) => s + r.totalPromptTokens, 0) / base.length
    : 0;

  for (const arm of arms) {
    const rs = rows.filter((r) => r.arm === arm);
    const n = rs.length;
    const avg = (f: (r: Row) => number) =>
      rs.reduce((s, r) => s + f(r), 0) / n;
    const sum = (f: (r: Row) => number) => rs.reduce((s, r) => s + f(r), 0);

    const correct = sum((r) => r.correctToolCalls);
    const expected = sum((r) => r.expectedToolCalls);
    const ok = sum((r) => (r.taskSuccess ? 1 : 0));

    console.log(
      `${arm.padEnd(12)}${String(n).padStart(4)}` +
        `${avg((r) => r.toolBlockTokens).toFixed(0).padStart(8)}` +
        `${avg((r) => r.totalPromptTokens).toFixed(0).padStart(9)}` +
        `${avg((r) => r.turns).toFixed(1).padStart(7)}` +
        `${avg((r) => r.metaCalls).toFixed(1).padStart(6)}` +
        `${`${correct}/${expected}`.padStart(10)}` +
        `${String(sum((r) => r.hallucinatedNames)).padStart(8)}` +
        `${String(sum((r) => r.malformedArgs)).padStart(6)}` +
        `${`${ok}/${n}`.padStart(8)}` +
        `${(avg((r) => r.wallMs) / 1000).toFixed(1).padStart(7)}s` +
        `${("$" + sum((r) => r.costUsd).toFixed(2)).padStart(9)}`,
    );
  }

  if (basePrompt) {
    console.log(`\n    vs control (prompt tokens):`);
    for (const arm of arms) {
      if (arm === "control") continue;
      const rs = rows.filter((r) => r.arm === arm);
      const p = rs.reduce((s, r) => s + r.totalPromptTokens, 0) / rs.length;
      const pct = ((p - basePrompt) / basePrompt) * 100;
      console.log(`      ${arm.padEnd(12)} ${pct.toFixed(0)}%`);
    }
  }
}

const rows = load();
const only = process.argv.find((a) => a.startsWith("--model="))?.split("=")[1];
const models = [...new Set(rows.map((r) => r.model!))].sort();

for (const m of models) {
  if (only && m !== only) continue;
  summarize(m, rows.filter((r) => r.model === m));
}

if (models.length > 1 && !only) {
  console.log(
    `\n━━━ NOTE: ${models.length} models present. Compare arms *within* a model;\n` +
      `    absolute token and cost figures are not comparable across models\n` +
      `    (different tokenizers and prices).`,
  );
}
console.log();
