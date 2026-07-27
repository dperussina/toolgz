/**
 * The restaurant explainer: what levels 0, 1 and 3 actually do, without jargon.
 *
 * Generated rather than drawn, for the same reason every other image here is: the
 * figures come from running the library on the committed real corpus, so the picture
 * cannot drift from the code. `npx tsx bench/metaphor.ts`
 *
 * Theme tokens are copied from bench/charts.ts deliberately — dark is a *selected*
 * palette against a dark surface, not an inverted light one.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { compress } from "../src/index.js";
import { REAL_TOOLS } from "./fixtures/real.js";
import type { Tool } from "../src/types.js";

type Theme = {
  surface: string; panel: string; ink: string; ink2: string; muted: string;
  rule: string; series: string; good: string; caution: string;
};
const LIGHT: Theme = {
  surface: "#fcfcfb", panel: "#f4f3ee", ink: "#0b0b0b", ink2: "#52514e",
  muted: "#898781", rule: "#e1e0d9", series: "#2a78d6", good: "#006300", caution: "#8a5a00",
};
const DARK: Theme = {
  surface: "#141413", panel: "#242423", ink: "#ffffff", ink2: "#c3c2b7",
  muted: "#898781", rule: "#2c2c2a", series: "#3987e5", good: "#0ca30c", caution: "#bd8010",
};

const FONT = `system-ui,-apple-system,'Segoe UI',sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,monospace`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── real figures, computed not typed ────────────────────────────────────────
/**
 * One loader, then stripped to the shape an MCP client actually hands you.
 *
 * This file used to re-read the JSON with its own mapping, which is how it came to
 * report 45.2% while the README said 46.8% — the same corpus measured two ways. The
 * difference is that `REAL_TOOLS` carries bench-only `ns`/`op` fields for grouping,
 * worth 4,993 characters of baseline that no real `tools/list` ever returns. Counting
 * them inflates `savedPct`, so they come off before anything is measured.
 */
const REAL: Tool[] = (REAL_TOOLS as any[]).map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}));

const stat = (level: 0 | 1 | 3) => compress(REAL, { level }).stats;
const S0 = stat(0), S1 = stat(1), S3 = stat(3);
const pct = (n: number) => `${n < 0 ? "+" : ""}${Math.abs(n).toFixed(1)}%`;

type Panel = {
  level: string; title: string; caption: string;
  wire: string; saved: string; savedTone: "good" | "muted";
  kitchen: string; kitchenTone: "good" | "caution";
  art: (x: number, y: number, t: Theme) => string;
};

/** A stack of "menu lines" — long bars are prose, short bars are a signature. */
const menuLines = (x: number, y: number, t: Theme, rows: number, widths: number[], dim = false) =>
  Array.from({ length: rows }, (_, i) => {
    const w = widths[i % widths.length];
    return `<rect x="${x}" y="${y + i * 9}" width="${w}" height="4.5" rx="2.25" fill="${
      dim ? t.rule : i % 3 === 0 ? t.ink2 : t.muted
    }" opacity="${dim ? 1 : i % 3 === 0 ? 0.75 : 0.45}"/>`;
  }).join("");

const PANELS: Panel[] = [
  {
    level: "Level 0",
    title: "The menu as written",
    caption:
      "Every dish gets a paragraph about the chef's inspiration. Handed to the model at the start of every single request.",
    wire: `${S0.toolCount} tools on the wire`,
    saved: "nothing saved",
    savedTone: "muted",
    kitchen: "Kitchen checks the order",
    kitchenTone: "good",
    art: (x, y, t) =>
      `<rect x="${x}" y="${y}" width="150" height="132" rx="6" fill="${t.surface}" stroke="${t.rule}" stroke-width="1.5"/>` +
      `<text x="${x + 12}" y="${y + 21}" font-family="${FONT}" font-size="10.5" font-weight="600" fill="${t.ink}">MENU</text>` +
      menuLines(x + 12, y + 32, t, 11, [126, 112, 120, 104, 118]),
  },
  {
    level: "Level 1",
    title: "Same menu, prose cut",
    caption:
      "One line per dish: the name and what it needs. Still a real menu — the model points at a dish by name, and the kitchen checks the order before cooking.",
    wire: `${S1.toolCount} tools on the wire`,
    saved: `${pct(S1.savedPct)} smaller`,
    savedTone: "good",
    kitchen: "Kitchen checks the order",
    kitchenTone: "good",
    art: (x, y, t) =>
      `<rect x="${x}" y="${y}" width="150" height="132" rx="6" fill="${t.surface}" stroke="${t.rule}" stroke-width="1.5"/>` +
      `<text x="${x + 12}" y="${y + 21}" font-family="${FONT}" font-size="10.5" font-weight="600" fill="${t.ink}">MENU</text>` +
      menuLines(x + 12, y + 32, t, 11, [74, 62, 80, 58, 68]),
  },
  {
    level: "Level 3",
    title: "A numbered card and one waiter",
    caption:
      'The model says "number 12, no onions" and the waiter knows what that means. Tiny — but the kitchen no longer checks the order, so toolgz checks it instead.',
    wire: `${S3.wireToolCount} tools on the wire`,
    saved: `${pct(S3.savedPct)} smaller`,
    savedTone: "good",
    kitchen: "toolgz checks the order",
    kitchenTone: "caution",
    art: (x, y, t) => {
      const cardW = 92;
      const wx = x + 126;                 // waiter centre: tray reaches x+102, clear of the card
      return (
        // The card: 8px mono so the longest line clears the box it sits in.
        `<rect x="${x}" y="${y}" width="${cardW}" height="62" rx="6" fill="${t.surface}" stroke="${t.rule}" stroke-width="1.5"/>` +
        ["a0 sheets_append", "a1 sheets_update", "b0 post_message"]
          .map((l, i) => `<text x="${x + 8}" y="${y + 17 + i * 13}" font-family="${MONO}" font-size="8" fill="${t.series}">${esc(l)}</text>`)
          .join("") +
        `<text x="${x + 8}" y="${y + 56}" font-family="${MONO}" font-size="8" fill="${t.muted}">…</text>` +
        // The waiter, from primitives: head, torso, arm, tray.
        `<circle cx="${wx}" cy="${y + 13}" r="7.5" fill="none" stroke="${t.ink2}" stroke-width="1.7"/>` +
        `<path d="M${wx - 10} ${y + 50} L${wx - 7.5} ${y + 27} Q${wx} ${y + 23} ${wx + 7.5} ${y + 27} L${wx + 10} ${y + 50} Z" fill="none" stroke="${t.ink2}" stroke-width="1.7" stroke-linejoin="round"/>` +
        `<path d="M${wx - 7} ${y + 31} L${wx - 17} ${y + 26}" fill="none" stroke="${t.ink2}" stroke-width="1.7" stroke-linecap="round"/>` +
        `<line x1="${wx - 25}" y1="${y + 24}" x2="${wx - 9}" y2="${y + 24}" stroke="${t.series}" stroke-width="2.5" stroke-linecap="round"/>` +
        `<path d="M${wx - 21} ${y + 24} q4 -5 8 0" fill="none" stroke="${t.series}" stroke-width="1.5"/>` +
        // The one cost worth naming on the picture: a lookup, ~half an extra turn.
        `<rect x="${x}" y="${y + 70}" width="150" height="58" rx="6" fill="${t.surface}" stroke="${t.rule}" stroke-width="1.5"/>` +
        `<text x="${x + 9}" y="${y + 87}" font-family="${FONT}" font-size="9.5" font-weight="600" fill="${t.ink}">Needs detail? It asks.</text>` +
        `<text x="${x + 9}" y="${y + 102}" font-family="${MONO}" font-size="8.5" fill="${t.series}">q(c="a0")</text>` +
        `<text x="${x + 9}" y="${y + 118}" font-family="${FONT}" font-size="9" fill="${t.ink2}">"what does a0 come with?"</text>`
      );
    },
  },
];

function render(t: Theme): string {
  const W = 900, H = 470;
  const colW = 276, gap = 16, x0 = 24;
  const p: string[] = [
    `<rect width="${W}" height="${H}" fill="${t.surface}"/>`,
    `<text x="${x0}" y="34" font-family="${FONT}" font-size="19" font-weight="600" fill="${t.ink}">Your tool definitions are a menu handed over at every request</text>`,
    `<text x="${x0}" y="56" font-family="${FONT}" font-size="12.5" fill="${t.ink2}">Figures are the real 149-tool corpus from 14 live MCP servers. Character counts, measured by running the library.</text>`,
  ];

  PANELS.forEach((panel, i) => {
    const x = x0 + i * (colW + gap);
    const y = 78;
    p.push(
      `<rect x="${x}" y="${y}" width="${colW}" height="${H - y - 46}" rx="10" fill="${t.panel}"/>`,
      `<text x="${x + 16}" y="${y + 26}" font-family="${FONT}" font-size="11" font-weight="600" fill="${t.series}" letter-spacing="0.6">${esc(panel.level.toUpperCase())}</text>`,
      `<text x="${x + 16}" y="${y + 46}" font-family="${FONT}" font-size="14" font-weight="600" fill="${t.ink}">${esc(panel.title)}</text>`,
      panel.art(x + 16, y + 62, t),
      wrap(panel.caption, x + 16, y + 212, colW - 32, 11.5, t.ink2),
      `<line x1="${x + 16}" y1="${y + 268}" x2="${x + colW - 16}" y2="${y + 268}" stroke="${t.rule}" stroke-width="1"/>`,
      `<text x="${x + 16}" y="${y + 287}" font-family="${FONT}" font-size="11.5" fill="${t.muted}">${esc(panel.wire)}</text>`,
      `<text x="${x + 16}" y="${y + 305}" font-family="${FONT}" font-size="13" font-weight="600" fill="${panel.savedTone === "good" ? t.good : t.muted}">${esc(panel.saved)}</text>`,
      // Who validates is the actual trade, so it is stated on every panel, never implied.
      //
      // Shape carries it as well as colour. scripts/validate_palette.js measures the
      // amber-vs-green pair at ΔE 1.7 under protanopia — indistinguishable — so a
      // colour-only marker would encode the single most important distinction in this
      // picture in the one channel some readers do not have. Circle = the provider
      // still checks; triangle = you have taken that over.
      panel.kitchenTone === "good"
        ? `<circle cx="${x + 22}" cy="${y + 322}" r="4.5" fill="${t.good}"/>`
        : `<path d="M${x + 22} ${y + 317} L${x + 27} ${y + 326} L${x + 17} ${y + 326} Z" fill="${t.caution}"/>`,
      `<text x="${x + 32}" y="${y + 326}" font-family="${FONT}" font-size="11" fill="${t.ink2}">${esc(panel.kitchen)}</text>`,
    );
  });

  p.push(
    `<text x="${x0}" y="${H - 18}" font-family="${FONT}" font-size="11" fill="${t.muted}">The trade is who checks the order, not whether it gets checked. recommendLevel() picks by block size; you pass its answer in.</text>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
    `Restaurant metaphor for toolgz compression levels. Level 0: the full menu, ${S0.toolCount} tools on the wire, nothing saved, kitchen checks the order. Level 1: the same menu with prose cut, ${S1.toolCount} tools on the wire, ${pct(S1.savedPct)} smaller, kitchen still checks the order. Level 3: a numbered card and one waiter, ${S3.wireToolCount} tools on the wire, ${pct(S3.savedPct)} smaller, toolgz checks the order instead of the provider.`,
  )}">${p.join("")}</svg>`;
}

/** Greedy wrap — no text measurement available, so approximate by character width. */
function wrap(s: string, x: number, y: number, maxW: number, size: number, fill: string): string {
  const perChar = size * 0.52;
  const max = Math.floor(maxW / perChar);
  const lines: string[] = [];
  let cur = "";
  for (const word of s.split(" ")) {
    if (cur && (cur + " " + word).length > max) { lines.push(cur); cur = word; }
    else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  const spans = lines
    .map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : size * 1.42}">${esc(l)}</tspan>`)
    .join("");
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" fill="${fill}">${spans}</text>`;
}

const OUT = new URL("../docs/img/", import.meta.url).pathname;
writeFileSync(`${OUT}metaphor-light.svg`, render(LIGHT));
writeFileSync(`${OUT}metaphor-dark.svg`, render(DARK));
console.log(`wrote docs/img/metaphor-{light,dark}.svg`);
console.log(`  level 0: ${S0.toolCount} wire tools, ${S0.savedPct}%`);
console.log(`  level 1: ${S1.toolCount} wire tools, ${S1.savedPct}%`);
console.log(`  level 3: ${S3.wireToolCount} wire tools, ${S3.savedPct}%`);
