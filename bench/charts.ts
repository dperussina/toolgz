/**
 * Generate README charts as SVG from real benchmark data.
 *
 *   npx tsx bench/charts.ts
 *
 * Emits light/dark pairs into docs/img/. GitHub strips media queries inside an
 * SVG loaded via <img>, so theme support is two files behind a <picture>
 * element rather than CSS.
 *
 * No plotting dependency: these are a handful of rects and text nodes, and a
 * committed SVG that renders on GitHub beats a build step.
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";

const RESULTS = new URL("./results/", import.meta.url).pathname;
const OUT = new URL("../docs/img/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// ── palette (validated reference instance; see dataviz references/palette.md) ─
type Theme = {
  surface: string;
  ink: string;
  ink2: string;
  muted: string;
  grid: string;
  axis: string;
  series: string;
  warn: string;
  good: string;
};
const LIGHT: Theme = {
  surface: "#fcfcfb",
  ink: "#0b0b0b",
  ink2: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  series: "#2a78d6",
  warn: "#d03b3b",
  good: "#006300",
};
const DARK: Theme = {
  surface: "#1a1a19",
  ink: "#ffffff",
  ink2: "#c3c2b7",
  muted: "#898781",
  grid: "#2c2c2a",
  axis: "#383835",
  series: "#3987e5",
  warn: "#e66767",
  good: "#0ca30c",
};

const FONT = `system-ui,-apple-system,'Segoe UI',sans-serif`;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Wrap text into <tspan> lines. SVG has no auto-wrap, and an unwrapped
 * sentence silently runs off the canvas — which it did on the first render.
 * Width is estimated from an average glyph advance; conservative on purpose.
 */
function wrapText(
  text: string,
  x: number,
  y: number,
  maxW: number,
  size: number,
  fill: string,
  lineH = size * 1.45,
): string {
  const perChar = size * 0.52;
  const maxChars = Math.max(8, Math.floor(maxW / perChar));
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > maxChars) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  const spans = lines
    .map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lineH}">${esc(l)}</tspan>`)
    .join("");
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${fill}">${spans}</text>`;
}

// ── data ────────────────────────────────────────────────────────────────────
type Row = {
  provider: string;
  model: string;
  arm: string;
  scenario: string;
  totalPromptTokens: number;
  toolBlockTokens: number;
  malformedArgs: number;
  hallucinatedNames: number;
  correctToolCalls: number;
  expectedToolCalls: number;
  taskSuccess: boolean;
  turns: number;
  wallMs: number;
  costUsd: number;
};

/**
 * The published charts pin to ONE sweep, and the default is the sweep the README's
 * results table cites.
 *
 * This used to load every file in bench/results and average across them. That silently
 * blended library versions, scenario mixes and two different suites: after the
 * real-MCP suite landed it reported Anthropic's shipped default at 70% saving where
 * the README table says 85%, so the charts and the table beside them disagreed while
 * both claimed to come from the same data. Pooling sweeps is the same error as
 * averaging cost across providers, and bench/analyze-multi.ts already refuses it.
 *
 * Override with --sweep=<timestamp-prefix> to chart a different run.
 */
const DEFAULT_SWEEP = "2026-07-25T19-19";

function load(): Row[] {
  const want =
    process.argv.find((a) => a.startsWith("--sweep="))?.split("=")[1] ?? DEFAULT_SWEEP;
  const rows: Row[] = [];
  const files = readdirSync(RESULTS).filter(
    (f) => f.startsWith("multi-") && f.endsWith(".jsonl") && f.includes(want),
  );
  if (!files.length) {
    throw new Error(
      `no results for sweep "${want}" in ${RESULTS}. ` +
        `Charts must pin to one sweep — pooling blends library versions and suites.`,
    );
  }
  for (const f of files) {
    for (const l of readFileSync(RESULTS + f, "utf8").split("\n")) {
      if (l.trim()) rows.push(JSON.parse(l));
    }
  }
  console.log(`charting sweep ${want} — ${rows.length} runs from ${files.length} files`);
  return rows;
}

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google",
  xai: "xAI",
};
const ARM_LABEL: Record<string, string> = {
  control: "uncompressed",
  signatures: "L1 signatures",
  hybrid: "L2 namespaces",
  minified: "L3 bare names",
  "minified-plus": "L3 default ✓",
  "minified-terse": "L3 terse desc",
  "minified-default": "L3 (default)",
  "minified-sig": "L3 signature",
  native: "native search",
};
const ARM_ORDER = [
  "control",
  "signatures",
  "hybrid",
  "minified-terse",
  "minified",
  "minified-plus",
  "minified-sig",
  "minified-default",
];

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ── chart 1: prompt-token reduction, small multiples per provider ───────────
function chartReduction(rows: Row[], t: Theme): string {
  const providers = [...new Set(rows.map((r) => r.provider))].sort(
    (a, b) =>
      Object.keys(PROVIDER_LABEL).indexOf(a) - Object.keys(PROVIDER_LABEL).indexOf(b),
  );

  const panelW = 300;
  const panelH = 150;
  const labelW = 108;
  const barH = 15;
  const gap = 7;
  const padX = 16;
  const titleH = 34;
  const cols = 2;
  const rowsN = Math.ceil(providers.length / cols);
  const W = padX * 2 + cols * panelW + (cols - 1) * 26;
  const H = 96 + rowsN * (panelH + titleH) + 62;

  const parts: string[] = [];
  parts.push(
    `<defs><pattern id="hatch-${t.surface.slice(1)}" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">` +
      `<rect width="6" height="6" fill="${t.warn}" opacity="0.30"/>` +
      `<line x1="0" y1="0" x2="0" y2="6" stroke="${t.warn}" stroke-width="3"/></pattern></defs>`,
    `<rect width="${W}" height="${H}" fill="${t.surface}"/>`,
    `<text x="${padX}" y="30" font-family="${FONT}" font-size="17" font-weight="600" fill="${t.ink}">Prompt tokens saved vs. uncompressed tool definitions</text>`,
    wrapText(
      "Higher is better. Same 5 tool-selection tasks, 30 confusable tools, 3 reps per arm. \u2713 marks the shipped default.",
      padX, 52, W - padX * 2, 12.5, t.ink2,
    ),
  );

  providers.forEach((p, i) => {
    const cx = padX + (i % cols) * (panelW + 26);
    const cy = 96 + Math.floor(i / cols) * (panelH + titleH);
    const pr = rows.filter((r) => r.provider === p);
    const model = pr[0]?.model ?? "";
    const base = mean(pr.filter((r) => r.arm === "control").map((r) => r.totalPromptTokens));

    const arms = ARM_ORDER.filter((a) => a !== "control" && pr.some((r) => r.arm === a));
    parts.push(
      `<text x="${cx}" y="${cy + 4}" font-family="${FONT}" font-size="13.5" font-weight="600" fill="${t.ink}">${esc(PROVIDER_LABEL[p] ?? p)}</text>`,
      `<text x="${cx + (PROVIDER_LABEL[p] ?? p).length * 8 + 10}" y="${cy + 4}" font-family="${FONT}" font-size="11" fill="${t.muted}">${esc(model)}</text>`,
    );

    const plotX = cx + labelW;
    const plotW = panelW - labelW - 44;

    // recessive gridlines at 25% steps
    for (const pct of [0, 25, 50, 75, 100]) {
      const gx = plotX + (plotW * pct) / 100;
      parts.push(
        `<line x1="${gx}" y1="${cy + 14}" x2="${gx}" y2="${cy + 18 + arms.length * (barH + gap)}" stroke="${pct === 0 ? t.axis : t.grid}" stroke-width="1"/>`,
      );
      if (i >= providers.length - cols) {
        parts.push(
          `<text x="${gx}" y="${cy + 34 + arms.length * (barH + gap)}" font-family="${FONT}" font-size="10.5" fill="${t.muted}" text-anchor="middle">${pct}%</text>`,
        );
      }
    }

    let anyIncomplete = false;
    arms.forEach((arm, j) => {
      const rs = pr.filter((r) => r.arm === arm);
      const v = mean(rs.map((r) => r.totalPromptTokens));
      const red = base ? Math.max(0, ((base - v) / base) * 100) : 0;
      const y = cy + 20 + j * (barH + gap);
      const w = Math.max(1, (plotW * red) / 100);

      // An arm that did not finish every task must not read as a clean win here.
      // Hatched fill + a dagger, so the caveat travels with the bar rather than
      // living only in a different chart.
      const ok = rs.filter((r) => r.taskSuccess).length;
      const incomplete = rs.length > 0 && ok < rs.length;
      if (incomplete) anyIncomplete = true;

      parts.push(
        `<text x="${plotX - 9}" y="${y + barH - 3.5}" font-family="${FONT}" font-size="11.5" fill="${t.ink2}" text-anchor="end">${esc(ARM_LABEL[arm] ?? arm)}${incomplete ? " †" : ""}</text>`,
        `<rect x="${plotX}" y="${y}" width="${w}" height="${barH}" rx="4" fill="${incomplete ? `url(#hatch-${t.surface.slice(1)})` : t.series}"/>`,
        `<text x="${plotX + w + 7}" y="${y + barH - 3.5}" font-family="${FONT}" font-size="11.5" font-weight="600" fill="${incomplete ? t.warn : t.ink}">${red.toFixed(0)}%${incomplete ? ` (${ok}/${rs.length})` : ""}</text>`,
      );
    });
    if (anyIncomplete) {
      parts.push(
        `<text x="${cx}" y="${cy + 52 + arms.length * (barH + gap)}" font-family="${FONT}" font-size="10" fill="${t.warn}">† did not complete every task — see the reliability chart</text>`,
      );
    }
  });

  parts.push(
    wrapText(
      "Token counts are not comparable across providers (different tokenizers). Each panel is measured against its own uncompressed baseline.",
      padX, H - 26, W - padX * 2, 10.5, t.muted,
    ),
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Prompt token savings by compression level, per provider">${parts.join("")}</svg>`;
}

// ── chart 2: reliability of the level-3 map styles ─────────────────────────
function chartReliability(rows: Row[], t: Theme): string {
  const styles = ["minified", "minified-terse", "minified-plus", "minified-sig"];
  const providers = ["anthropic", "gemini", "openai", "xai"];
  const W = 760;
  const cell = 64;
  const rowH = 34;
  const labelW = 168;
  const H = 130 + styles.length * rowH + 58;

  const parts: string[] = [
    `<rect width="${W}" height="${H}" fill="${t.surface}"/>`,
    `<text x="20" y="30" font-family="${FONT}" font-size="17" font-weight="600" fill="${t.ink}">Bare tool names are not always enough signal to dispatch</text>`,
    wrapText(
      "Tasks completed, 15 per cell. Every style saves roughly the same tokens, so reliability is what separates them. The shipped default has never failed; the bare-name map is the only one that has.",
      20, 52, W - 40, 12.5, t.ink2,
    ),
  ];

  providers.forEach((p, i) => {
    parts.push(
      `<text x="${labelW + 20 + i * cell + cell / 2}" y="${92}" font-family="${FONT}" font-size="11" font-weight="600" fill="${t.muted}" text-anchor="middle">${esc((PROVIDER_LABEL[p] ?? p).toUpperCase())}</text>`,
    );
  });

  styles.forEach((arm, j) => {
    const y = 104 + j * rowH;
    parts.push(
      `<text x="${labelW}" y="${y + 20}" font-family="${FONT}" font-size="12.5" fill="${t.ink2}" text-anchor="end">${esc(ARM_LABEL[arm] ?? arm)}</text>`,
    );
    providers.forEach((p, i) => {
      const rs = rows.filter((r) => r.provider === p && r.arm === arm);
      const ok = rs.filter((r) => r.taskSuccess).length;
      const perfect = rs.length > 0 && ok === rs.length;
      const x = labelW + 20 + i * cell;
      parts.push(
        `<rect x="${x + 4}" y="${y + 4}" width="${cell - 10}" height="22" rx="4" fill="${perfect ? t.good : t.warn}" opacity="${perfect ? 0.14 : 0.18}"/>`,
        `<text x="${x + (cell - 6) / 2}" y="${y + 20}" font-family="${FONT}" font-size="12" font-weight="600" fill="${perfect ? t.good : t.warn}" text-anchor="middle">${ok}/${rs.length}</text>`,
      );
    });
    const tot = rows.filter((r) => r.arm === arm);
    const okAll = tot.filter((r) => r.taskSuccess).length;
    parts.push(
      `<text x="${labelW + 20 + providers.length * cell + 16}" y="${y + 20}" font-family="${FONT}" font-size="12.5" font-weight="600" fill="${okAll === tot.length ? t.good : t.warn}">${okAll}/${tot.length}</text>`,
    );
  });

  parts.push(
    `<text x="${labelW + 20 + providers.length * cell + 16}" y="92" font-family="${FONT}" font-size="11" font-weight="600" fill="${t.muted}">TOTAL</text>`,
    ...[
      wrapText(
        "Bare names are the only style that has ever failed, and only on grok-4.5: the model reads the map and answers with zero tool calls, no error raised. Naming the required arguments has never failed on any provider, and is the shipped default.",
        20, H - 40, W - 40, 10.5, t.muted,
      ),
    ],
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Task completion by level-3 map style and provider">${parts.join("")}</svg>`;
}

// ── chart 3: context is always reclaimed; money is not ─────────────────────
function chartCost(rows: Row[], t: Theme): string {
  const providers = ["anthropic", "gemini", "openai", "xai"];
  const W = 760;
  const rowH = 40;
  const labelW = 96;
  const H = 128 + providers.length * rowH + 58;
  const midX = labelW + 300;

  const parts: string[] = [
    `<rect width="${W}" height="${H}" fill="${t.surface}"/>`,
    `<text x="20" y="30" font-family="${FONT}" font-size="17" font-weight="600" fill="${t.ink}">Smaller context on all four — and now cheaper on all four</text>`,
    wrapText(
      "Level 3 at the shipped default vs uncompressed, reasoning enabled on all four. Cost was +15% on OpenAI until the resolver stopped wasting turns on recoverable argument errors.",
      20, 52, W - 40, 12.5, t.ink2,
    ),
    `<text x="${labelW + 20}" y="98" font-family="${FONT}" font-size="11" font-weight="600" fill="${t.muted}">PROMPT TOKENS</text>`,
    `<text x="${midX}" y="98" font-family="${FONT}" font-size="11" font-weight="600" fill="${t.muted}">COST (green = cheaper, red = dearer)</text>`,
  ];

  providers.forEach((p, i) => {
    const y = 112 + i * rowH;
    const pr = rows.filter((r) => r.provider === p);
    const baseTok = mean(pr.filter((r) => r.arm === "control").map((r) => r.totalPromptTokens));
    const armTok = mean(pr.filter((r) => r.arm === "minified-plus").map((r) => r.totalPromptTokens));
    const tokPct = baseTok ? ((baseTok - armTok) / baseTok) * 100 : 0;

    const baseCost = pr.filter((r) => r.arm === "control").reduce((s, r) => s + r.costUsd, 0);
    const armCost = pr.filter((r) => r.arm === "minified-plus").reduce((s, r) => s + r.costUsd, 0);
    const costPct = baseCost ? ((armCost - baseCost) / baseCost) * 100 : 0;
    const saving = costPct <= 0;

    parts.push(
      `<text x="${labelW}" y="${y + 18}" font-family="${FONT}" font-size="12.5" fill="${t.ink2}" text-anchor="end">${esc(PROVIDER_LABEL[p] ?? p)}</text>`,
      `<rect x="${labelW + 20}" y="${y + 4}" width="${Math.max(3, (180 * tokPct) / 100)}" height="16" rx="4" fill="${t.series}"/>`,
      `<text x="${labelW + 26 + (180 * tokPct) / 100}" y="${y + 17}" font-family="${FONT}" font-size="11.5" font-weight="600" fill="${t.ink}">-${tokPct.toFixed(0)}%</text>`,
      // Cost: one right-extending bar of magnitude, colour carries direction and
      // the label carries the sign. A signed axis collided with the column left.
      `<rect x="${midX}" y="${y + 4}" width="${Math.max(3, (140 * Math.abs(costPct)) / 100)}" height="16" rx="4" fill="${saving ? t.good : t.warn}"/>`,
      `<text x="${midX + 6 + (140 * Math.abs(costPct)) / 100}" y="${y + 17}" font-family="${FONT}" font-size="11.5" font-weight="600" fill="${saving ? t.good : t.warn}">${saving ? "" : "+"}${costPct.toFixed(0)}%</text>`,
    );
  });

  parts.push(
    wrapText(
      "OpenAI's -7% is modest because reasoning output dominates its bill, so a smaller prompt moves the total less. Context-window occupancy is still the primary claim; cost follows from it, and by how much depends on your reasoning settings.",
      20, H - 40, W - 40, 10.5, t.muted,
    ),
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Prompt token reduction versus cost change by provider">${parts.join("")}</svg>`;
}

// ── main ────────────────────────────────────────────────────────────────────
const rows = load();
if (!rows.length) {
  console.error("no multi-*.jsonl results found");
  process.exit(1);
}

const charts: [string, (r: Row[], t: Theme) => string][] = [
  ["savings", chartReduction],
  ["reliability", chartReliability],
  ["cost", chartCost],
];

for (const [name, fn] of charts) {
  writeFileSync(`${OUT}${name}-light.svg`, fn(rows, LIGHT));
  writeFileSync(`${OUT}${name}-dark.svg`, fn(rows, DARK));
  console.log(`wrote docs/img/${name}-{light,dark}.svg`);
}

// Print the numbers the README must quote, so prose and charts cannot drift.
const providers = [...new Set(rows.map((r) => r.provider))].sort();
console.log(`\nrows=${rows.length} providers=${providers.join(",")}`);
for (const p of providers) {
  const pr = rows.filter((r) => r.provider === p);
  const base = mean(pr.filter((r) => r.arm === "control").map((r) => r.totalPromptTokens));
  const line = ARM_ORDER.filter((a) => a !== "control" && pr.some((r) => r.arm === a))
    .map((a) => {
      const v = mean(pr.filter((r) => r.arm === a).map((r) => r.totalPromptTokens));
      return `${a} ${(((base - v) / base) * 100).toFixed(0)}%`;
    })
    .join("  ");
  console.log(`  ${p.padEnd(10)} ${line}`);
}
