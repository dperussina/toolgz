/**
 * Generates the shareable social card (1200x630) for announcements.
 *
 * The figures are parsed out of the README's results table rather than typed in
 * here. That is deliberate: a promo image is exactly the kind of artifact that
 * drifts from reality months later, and the one place people will not check. If
 * the README changes, this regenerates or fails loudly.
 *
 * Palette and mark rules follow the project's dataviz conventions:
 *   - a single data series (tokens after compression), so no legend is needed
 *   - the "before" value is a *track*, not a second series — it is the container
 *     the fill sits in, styled from the gridline token, not a competing hue
 *   - one shared x-scale across providers, so absolute differences stay visible
 *     instead of every row being normalised to full width
 *   - accent #1baf7a validated on surface #1a1a19: lightness band, chroma floor
 *     and >=3:1 contrast all pass
 *
 * Usage: npx tsx bench/social-card.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;

type Row = {
  provider: string;
  model: string;
  before: number;
  after: number;
  pct: number;
  // Kept as strings: Number("15.0") renders as "15", losing the tenths that the
  // README shows and making the card disagree with it.
  latBefore: string;
  latAfter: string;
};

/** Strip markdown emphasis and code ticks from a table cell. */
const plain = (s: string) => s.replace(/[*`]/g, "").trim();
const num = (s: string) => Number(s.replace(/[^0-9.]/g, ""));

function parseReadme(): Row[] {
  const md = readFileSync(`${ROOT}README.md`, "utf8");
  const rows: Row[] = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map(plain);
    // Not a fixed column count: the table has changed shape once already. A row
    // qualifies if it contains the two cells we need, which is the real requirement.
    if (cells.length < 4) continue;
    // Locate cells by CONTENT, not by index. This used to read cells[3] and cells[5],
    // and silently broke the moment the table dropped its Cost column — a documentation
    // generator that depends on column order is a generator that breaks on every edit.
    const m = cells
      .map((c) => c.match(/([\d,]+)\s*→\s*([\d,]+)\s*\(−([\d.]+)%\)/))
      .find(Boolean);
    const l = cells.map((c) => c.match(/([\d.]+)s\s*→\s*([\d.]+)s/)).find(Boolean);
    if (!m || !l) continue;
    rows.push({
      provider: cells[0],
      model: cells[1],
      before: num(m[1]),
      after: num(m[2]),
      pct: Number(m[3]),
      latBefore: l[1],
      latAfter: l[2],
    });
  }
  if (rows.length !== 4) {
    throw new Error(
      `Expected 4 provider rows in README.md, parsed ${rows.length}. ` +
        `The results table shape changed — fix this parser rather than hardcoding numbers.`,
    );
  }
  return rows;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n: number) => n.toLocaleString("en-US");

type Theme = {
  name: string;
  surface: string;
  ink: string;
  secondary: string;
  muted: string;
  track: string;
  accent: string;
};

const THEMES: Theme[] = [
  {
    name: "dark",
    surface: "#1a1a19",
    ink: "#ffffff",
    secondary: "#c3c2b7",
    muted: "#898781",
    track: "#2c2c2a",
    accent: "#1baf7a",
  },
  {
    name: "light",
    surface: "#fcfcfb",
    ink: "#0b0b0b",
    secondary: "#52514e",
    muted: "#898781",
    track: "#e1e0d9",
    accent: "#199e70",
  },
];

const W = 1200;
const H = 630;
const PAD = 56;
const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";
const MONO = "SF Mono, Menlo, DejaVu Sans Mono, monospace";

function card(rows: Row[], t: Theme): string {
  const maxBefore = Math.max(...rows.map((r) => r.before));
  const pcts = rows.map((r) => r.pct);
  const range = `${Math.min(...pcts)}–${Math.max(...pcts)}%`;

  // Bar geometry. The right block holds the -% and the latency delta.
  const barX = 372;
  const barW = 560;
  const rightEdge = W - PAD;
  const rowH = 62;
  const rowsY = 300;
  const barH = 20;

  const bars = rows
    .map((r, i) => {
      const y = rowsY + i * rowH;
      const trackW = Math.max(3, (r.before / maxBefore) * barW);
      const fillW = Math.max(3, (r.after / maxBefore) * barW);
      const mid = y + barH / 2;
      return `
    <text x="${PAD}" y="${y + 7}" font-family="${FONT}" font-size="17" font-weight="600" fill="${t.ink}">${esc(r.provider)}</text>
    <text x="${PAD}" y="${y + 26}" font-family="${FONT}" font-size="13" fill="${t.muted}">${fmt(r.before)} → <tspan fill="${t.accent}" font-weight="700">${fmt(r.after)}</tspan> tokens</text>

    <rect x="${barX}" y="${y}" width="${trackW}" height="${barH}" rx="4" fill="${t.track}"/>
    <rect x="${barX + fillW}" y="${y}" width="2" height="${barH}" fill="${t.surface}"/>
    <rect x="${barX}" y="${y}" width="${fillW}" height="${barH}" rx="4" fill="${t.accent}"/>

    <text x="${rightEdge}" y="${mid + 1}" text-anchor="end" font-family="${FONT}" font-size="21" font-weight="700" fill="${t.accent}">−${r.pct}%</text>
    <text x="${rightEdge}" y="${mid + 19}" text-anchor="end" font-family="${FONT}" font-size="12" fill="${t.muted}">${r.latBefore}s → ${r.latAfter}s</text>`;
    })
    .join("\n");

  const pillW = 232;
  const pillX = rightEdge - pillW;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${t.surface}"/>
  <rect x="0" y="0" width="${W}" height="4" fill="${t.accent}"/>

  <text x="${PAD}" y="80" font-family="${FONT}" font-size="27" font-weight="700" fill="${t.ink}">toolgz</text>

  <rect x="${pillX}" y="57" width="${pillW}" height="34" rx="17" fill="none" stroke="${t.accent}" stroke-width="1.5"/>
  <text x="${pillX + pillW / 2}" y="79" text-anchor="middle" font-family="${MONO}" font-size="15" fill="${t.accent}">npm install toolgz</text>

  <text x="${PAD}" y="152" font-family="${FONT}" font-size="38" font-weight="700" fill="${t.ink}">Your agent burns 30–70k tokens on tool</text>
  <text x="${PAD}" y="196" font-family="${FONT}" font-size="38" font-weight="700" fill="${t.ink}">definitions before the user says a word.</text>

  <text x="${PAD}" y="234" font-family="${FONT}" font-size="16" fill="${t.secondary}">toolgz gives back <tspan fill="${t.accent}" font-weight="700">${range}</tspan> of it at level 3 — and runs faster. Your code still sees the same tool names and arguments.</text>

  <line x1="${PAD}" y1="262" x2="${rightEdge}" y2="262" stroke="${t.track}" stroke-width="1"/>
  <text x="${PAD}" y="283" font-family="${FONT}" font-size="11" letter-spacing="1.2" fill="${t.muted}">PROMPT TOKENS PER REQUEST — UNCOMPRESSED → toolgz</text>
  <text x="${rightEdge}" y="283" text-anchor="end" font-family="${FONT}" font-size="11" letter-spacing="1.2" fill="${t.muted}">SAVED / LATENCY</text>
${bars}

  <line x1="${PAD}" y1="558" x2="${rightEdge}" y2="558" stroke="${t.track}" stroke-width="1"/>
  <text x="${PAD}" y="583" font-family="${FONT}" font-size="14" font-weight="600" fill="${t.ink}">60/60 tasks completed · 0 hallucinated tool names · 0 malformed arguments</text>
  <text x="${PAD}" y="603" font-family="${FONT}" font-size="12" fill="${t.muted}">${esc(rows.map((r) => r.model).join(" · "))} · reasoning at high effort · level 1 (the default) saves 13–39%</text>
  <text x="${rightEdge}" y="583" text-anchor="end" font-family="${MONO}" font-size="13" fill="${t.secondary}">github.com/dperussina/toolgz</text>
  <text x="${rightEdge}" y="603" text-anchor="end" font-family="${FONT}" font-size="12" fill="${t.muted}">Apache-2.0 · zero runtime dependencies</text>
</svg>`;
}

const rows = parseReadme();
mkdirSync(`${ROOT}docs/img`, { recursive: true });

for (const t of THEMES) {
  const svg = card(rows, t);
  const base = `${ROOT}docs/img/social-card-${t.name}`;
  writeFileSync(`${base}.svg`, svg);
  // PNG is what LinkedIn, X and Hacker News actually accept for previews.
  execFileSync("rsvg-convert", [
    `${base}.svg`,
    "-w",
    String(W * 2), // 2x for retina
    "-o",
    `${base}.png`,
  ]);
  console.log(`wrote ${base}.svg + .png`);
}
console.log(
  `parsed from README: ${rows.map((r) => `${r.provider} -${r.pct}%`).join(", ")}`,
);
