/**
 * One sweep, one chart: how the dispatcher levels compare on occupancy and reliability.
 *
 *   npx tsx bench/levels-chart.ts --sweep=<prefix> [--out=levels]
 *
 * Deliberately parameterised by sweep and deliberately separate from bench/charts.ts,
 * which is pinned to the 420-run synthetic sweep. Level 4 could not join that chart: it
 * did not exist when that sweep ran, and pooling sweeps blends library versions — a rule
 * this repo learned the hard way when a pooled task rate described no version of the code
 * that ever existed.
 *
 * So this charts whatever arms are present in ONE sweep, and prints the sweep on the
 * figure so a reader can recompute it.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

type Row = {
  provider: string; model: string; arm: string;
  toolBlockTokens: number; totalPromptTokens: number; turns: number;
  malformedArgs: number; hallucinatedNames: number; taskSuccess: boolean;
  correctToolCalls: number; expectedToolCalls: number;
};

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const SWEEP = arg("sweep");
if (!SWEEP) throw new Error("--sweep=<prefix> is required; pooling sweeps is not allowed");
const OUT = arg("out") ?? "levels";
/**
 * Optional arm filter. The sweep this was built for also contains two `enforceNames` arms
 * that were measured and removed — that evidence belongs in RESULTS.md, not in a figure
 * whose job is helping a reader choose a level. Charting an option nobody can select is
 * the mistake the reliability chart already had to be corrected for.
 */
const ONLY = arg("arms")?.split(",").map((a) => a.trim()).filter(Boolean);

const rows: Row[] = [];
for (const f of readdirSync("bench/results").filter((f) => f.includes(SWEEP))) {
  for (const l of readFileSync(`bench/results/${f}`, "utf8").split("\n")) {
    if (l.trim()) rows.push(JSON.parse(l));
  }
}
if (!rows.length) throw new Error(`no runs found for sweep ${SWEEP}`);

const ARM_LABEL: Record<string, string> = {
  control: "uncompressed",
  signatures: "L1",
  "signatures-compiled": "L1 + compiled",
  hybrid: "L2",
  "minified-plus": "L3",
  "minified-enforced": "L3 + enforceNames",
  compiled: "L4",
  "compiled-enforced": "L4 + enforceNames",
};
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic", gemini: "Google", openai: "OpenAI", xai: "xAI",
};

type Theme = { surface: string; panel: string; ink: string; ink2: string; muted: string; rule: string; series: string; good: string; warn: string };
const LIGHT: Theme = { surface: "#fcfcfb", panel: "#f4f3ee", ink: "#0b0b0b", ink2: "#52514e", muted: "#898781", rule: "#dedcd3", series: "#2a78d6", good: "#006300", warn: "#8a5a00" };
const DARK: Theme = { surface: "#141413", panel: "#1f1f1e", ink: "#ffffff", ink2: "#c3c2b7", muted: "#8a8983", rule: "#333331", series: "#5ea1f0", good: "#0ca30c", warn: "#bd8010" };
const FONT = `system-ui,-apple-system,'Segoe UI',sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,monospace`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const shown = rows.filter((r) => !ONLY || ONLY.includes(r.arm));
const providers = [...new Set(shown.map((r) => r.provider))].sort();
const arms = [...new Set(rows.map((r) => r.arm))]
  .filter((a) => !ONLY || ONLY.includes(a))
  .sort(
  (a, b) => Object.keys(ARM_LABEL).indexOf(a) - Object.keys(ARM_LABEL).indexOf(b),
);

function render(t: Theme): string {
  const W = 940;
  const rowH = 26, headH = 150, panelH = arms.length * rowH + 54;
  const H = headH + providers.length * (panelH + 18) + 56;
  const p: string[] = [`<rect width="${W}" height="${H}" fill="${t.surface}"/>`];
  const T = (x: number, y: number, s: string, o: any = {}) =>
    `<text x="${x}" y="${y}" font-family="${o.font ?? FONT}" font-size="${o.size ?? 12}" font-weight="${o.weight ?? "400"}" fill="${o.fill ?? t.ink}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}>${esc(s)}</text>`;

  const total = shown.length;
  const ok = shown.filter((r) => r.taskSuccess).length;
  const bad = shown.reduce((s, r) => s + r.malformedArgs, 0);
  const hal = shown.reduce((s, r) => s + r.hallucinatedNames, 0);

  p.push(
    T(24, 34, "Dispatcher levels, measured in one sweep", { size: 19, weight: "700" }),
    T(24, 56, `${total} runs · ${providers.length} providers · ${arms.length} arms · sweep ${SWEEP}`, { size: 12, fill: t.ink2 }),
    T(24, 76, `${ok}/${total} tasks completed · ${hal} hallucinated tool names · ${bad} malformed arguments`, { size: 12, fill: t.ink2 }),
    T(24, 100, "Bars are the tool block in prompt tokens — lower is better. Tokens are not comparable across", { size: 11.5, fill: t.muted }),
    T(24, 116, "providers (different tokenizers), so each panel is scaled to its own largest arm.", { size: 11.5, fill: t.muted }),
  );

  let y = headH;
  for (const prov of providers) {
    const pr = shown.filter((r) => r.provider === prov);
    const model = pr[0]?.model ?? prov;
    const maxBlock = Math.max(...arms.map((a) => mean(pr.filter((r) => r.arm === a).map((r) => r.toolBlockTokens))));
    p.push(
      `<rect x="24" y="${y}" width="${W - 48}" height="${panelH}" rx="10" fill="${t.panel}"/>`,
      T(40, y + 26, PROVIDER_LABEL[prov] ?? prov, { size: 13.5, weight: "600" }),
      T(40 + (PROVIDER_LABEL[prov] ?? prov).length * 8 + 12, y + 26, model, { size: 11, fill: t.muted, font: MONO }),
    );
    arms.forEach((arm, i) => {
      const rs = pr.filter((r) => r.arm === arm);
      if (!rs.length) return;
      const block = mean(rs.map((r) => r.toolBlockTokens));
      const barX = 200, barW = (W - 48 - barX - 330) * (block / maxBlock);
      const by = y + 42 + i * rowH;
      const okA = rs.filter((r) => r.taskSuccess).length;
      const malA = rs.reduce((s, r) => s + r.malformedArgs, 0);
      p.push(
        T(barX - 12, by + 12, ARM_LABEL[arm] ?? arm, { size: 11.5, fill: t.ink2, anchor: "end" }),
        `<rect x="${barX}" y="${by + 2}" width="${Math.max(2, barW)}" height="14" rx="4" fill="${t.series}"/>`,
        T(barX + Math.max(2, barW) + 8, by + 13, Math.round(block).toLocaleString(), { size: 11.5, weight: "600" }),
        T(W - 40, by + 13, `${okA}/${rs.length} tasks · ${mean(rs.map((r) => r.turns)).toFixed(1)} turns · ${malA} malformed`, {
          size: 11, fill: malA ? t.warn : t.muted, anchor: "end",
        }),
      );
    });
    y += panelH + 18;
  }
  p.push(T(24, H - 20, "Recompute: npx tsx bench/analyze-multi.ts --sweep=" + SWEEP, { size: 10.5, font: MONO, fill: t.muted }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
    `Tool block size by compression level across ${providers.length} providers, ${total} runs from sweep ${SWEEP}. ${ok} of ${total} tasks completed with ${hal} hallucinated tool names and ${bad} malformed arguments.`,
  )}">${p.join("")}</svg>`;
}

for (const [name, theme] of [["light", LIGHT], ["dark", DARK]] as const) {
  const file = `docs/img/${OUT}-${name}.svg`;
  writeFileSync(file, render(theme));
  try { execFileSync("rsvg-convert", ["-w", "1880", file, "-o", file.replace(/\.svg$/, ".png")]); } catch {}
}
console.log(`wrote docs/img/${OUT}-{light,dark}.svg — ${rows.length} runs, arms: ${arms.map((a) => ARM_LABEL[a] ?? a).join(", ")}`);
