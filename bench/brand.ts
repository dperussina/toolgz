/**
 * Brand marks and the occupancy graphic.
 *
 *   npx tsx bench/brand.ts
 *
 * Produces, in light and dark:
 *   logo-{light,dark}.svg        icon + wordmark, for READMEs and the site header
 *   icon-{light,dark}.svg        square mark, for avatars and social profiles
 *   favicon.svg                  the mark alone, theme-reactive via a media query
 *   occupancy-{light,dark}.svg   the marketing graphic: what a 200k window looks like
 *
 * The occupancy figures are parsed from the README's scaling and ceiling tables rather
 * than typed here, so the graphic cannot drift from the documented measurements.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

type Theme = {
  surface: string; raised: string; sunken: string; ink: string; ink2: string;
  muted: string; rule: string; accent: string; good: string; heavy: string;
};
const LIGHT: Theme = {
  surface: "#fcfcfb", raised: "#f4f3ee", sunken: "#e7e5dc", ink: "#0b0b0b", ink2: "#52514e",
  muted: "#898781", rule: "#dedcd3", accent: "#2a78d6", good: "#006300", heavy: "#8a5a00",
};
const DARK: Theme = {
  surface: "#141413", raised: "#1f1f1e", sunken: "#2e2e2c", ink: "#ffffff", ink2: "#c3c2b7",
  muted: "#8a8983", rule: "#333331", accent: "#5ea1f0", good: "#0ca30c", heavy: "#bd8010",
};

const FONT = `system-ui,-apple-system,'Segoe UI',Roboto,sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,monospace`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const OUT = new URL("../docs/img/", import.meta.url).pathname;

const png = (file: string, width: number) => {
  try {
    execFileSync("rsvg-convert", ["-w", String(width), file, "-o", file.replace(/\.svg$/, ".png")]);
  } catch {
    console.warn(`  (rsvg-convert unavailable — SVG only for ${file.split("/").pop()})`);
  }
};

// ── figures, parsed not typed ───────────────────────────────────────────────
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

const cellsOf = (rx: RegExp) => {
  const row = readme.split("\n").find((l) => rx.test(l));
  if (!row) throw new Error(`README row not found for ${rx} — the graphic would invent figures`);
  return row.split("|").map((c) => c.replace(/\*/g, "").trim()).filter(Boolean);
};
const num = (s: string) => Number(s.replace(/[^\d]/g, ""));

const scale = cellsOf(/^\|\s*149 \(the real corpus\)/);       // tools | uncompressed | L3 | reclaimed
const UNCOMP = num(scale[1]), L3 = num(scale[2]), RECLAIMED = scale[3];
const ceiling = cellsOf(/^\|\s*200K \(typical frontier cap\)/); // window | uncompressed | with L3
const FIT_RAW = ceiling[1], FIT_L3 = ceiling[2];

const WINDOW = 200_000;
const fmt = (n: number) => n.toLocaleString();

// ── the mark ────────────────────────────────────────────────────────────────
/**
 * Three bars collapsing to a quarter width: many definitions in, a short map out.
 *
 * Deliberately only three shapes. The first draft added inward chevrons and a second
 * column of bars, which was unreadable at 32px — and a favicon that needs 128px to make
 * sense is not a favicon.
 */
function mark(x: number, y: number, size: number, t: Theme, onAccent = true): string {
  const r = size * 0.235;
  const pad = size * 0.22;
  const barH = size * 0.108;
  const gap = (size - pad * 2 - barH * 3) / 2;
  const fg = onAccent ? "#fff" : t.accent;
  const widths = [1, 0.62, 0.26];
  return (
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="${onAccent ? t.accent : "none"}"/>` +
    widths
      .map((w, i) =>
        `<rect x="${x + pad}" y="${y + pad + i * (barH + gap)}" width="${(size - pad * 2) * w}" height="${barH}" rx="${barH / 2}" fill="${fg}"/>`,
      )
      .join("")
  );
}

/** `toolgz` with the compression suffix in the accent, tight but not cramped. */
function wordmark(x: number, baseline: number, size: number, t: Theme): string {
  // One <text> with an inline <tspan>, not two positioned <text> elements. The first
  // version placed "gz" at an estimated width for "tool" and rendered "tool gz" with a
  // visible gap — narrow glyphs. A tspan with no x/dx just continues the run, so the
  // renderer does the kerning.
  return (
    `<text x="${x}" y="${baseline}" font-family="${FONT}" font-size="${size}" ` +
    `font-weight="800" letter-spacing="${-size * 0.03}" fill="${t.ink}">tool` +
    `<tspan fill="${t.accent}">gz</tspan></text>`
  );
}

function logo(t: Theme): string {
  const W = 420, H = 120, s = 72;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="toolgz">` +
    `<rect width="${W}" height="${H}" fill="none"/>` +
    mark(16, 24, s, t) +
    wordmark(16 + s + 22, 84, 52, t) +
    `</svg>`;
}

function icon(t: Theme): string {
  const S = 512;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" role="img" aria-label="toolgz">` +
    mark(0, 0, S, t) + `</svg>`;
}

/** One file that works on either surface, for <link rel="icon">. */
function favicon(): string {
  const S = 64;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">` +
    `<style>.bg{fill:#2a78d6}@media(prefers-color-scheme:dark){.bg{fill:#5ea1f0}}</style>` +
    mark(0, 0, S, LIGHT).replace(`fill="${LIGHT.accent}"`, 'class="bg"') +
    `</svg>`;
}

// ── the occupancy graphic ───────────────────────────────────────────────────
function occupancy(t: Theme): string {
  const W = 1200, H = 620;
  const p: string[] = [`<rect width="${W}" height="${H}" fill="${t.surface}"/>`];
  const T = (x: number, y: number, s: string, o: any = {}) =>
    `<text x="${x}" y="${y}" font-family="${o.font ?? FONT}" font-size="${o.size ?? 13}" font-weight="${o.weight ?? "400"}" fill="${o.fill ?? t.ink}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}${o.ls ? ` letter-spacing="${o.ls}"` : ""}>${esc(s)}</text>`;

  p.push(
    mark(48, 40, 34, t),
    T(92, 64, "toolgz", { size: 21, weight: "800" }),
    T(48, 124, "Your 200k context window, before the user says a word", { size: 32, weight: "700" }),
    T(48, 152, `149 tools from 14 live MCP servers, measured with Anthropic's count_tokens on claude-opus-5.`, { size: 13.5, fill: t.ink2 }),
  );

  // Two part-to-whole bars against the same 200k scale, so the comparison is honest.
  const BX = 48, BW = W - 96, BH = 62;
  const bar = (y: number, label: string, used: number, tone: string, note: string) => {
    const w = Math.max(3, (used / WINDOW) * BW);
    const pctOfWindow = (used / WINDOW) * 100;
    p.push(
      T(BX, y - 12, label, { size: 12.5, weight: "700", fill: t.muted, ls: "1.2" }),
      `<rect x="${BX}" y="${y}" width="${BW}" height="${BH}" rx="8" fill="${t.sunken}"/>`,
      // 2px surface gap so the used segment reads as a distinct mark, not a fill level.
      `<rect x="${BX + 2}" y="${y + 2}" width="${w - 4 > 0 ? w - 4 : 1}" height="${BH - 4}" rx="6" fill="${tone}"/>`,
      T(BX + BW - 14, y + BH / 2 + 5, note, { size: 13, fill: t.ink2, anchor: "end" }),
    );
    // Label inside the segment when it fits, beside it when it does not.
    const inside = w > 210;
    p.push(
      T(inside ? BX + 18 : BX + w + 12, y + BH / 2 - 2, `${fmt(used)} tokens`, {
        size: 15, weight: "700", fill: inside ? "#fff" : t.ink,
      }),
      T(inside ? BX + 18 : BX + w + 12, y + BH / 2 + 16, `${pctOfWindow.toFixed(1)}% of the window`, {
        size: 11.5, fill: inside ? "#fff" : t.muted,
      }),
    );
  };

  bar(210, "UNCOMPRESSED — TOOL DEFINITIONS ALONE", UNCOMP, t.heavy, "the rest is yours");
  bar(330, "AT LEVEL 3", L3, t.accent, "the rest is yours");

  // The consequence, which is the part people feel.
  //
  // Stacked number-over-label columns, not number-then-label on one line: the first
  // version positioned the label with a per-character width estimate and 40px bold
  // digits are wider than the estimate, so it rendered "434uncompressed".
  const CY = 424;
  const cols: [string, string, string][] = [
    [FIT_RAW, "real tools fit uncompressed", t.ink],
    [FIT_L3, "fit at level 3", t.good],
    [RECLAIMED, "of the tool block reclaimed", t.good],
  ];
  p.push(`<rect x="${BX}" y="${CY}" width="${BW}" height="132" rx="12" fill="${t.raised}"/>`,
    T(BX + 26, CY + 30, "HOW MANY REAL TOOLS FIT IN 200K", { size: 12, weight: "700", fill: t.muted, ls: "1.2" }));
  cols.forEach(([n, label, tone], i) => {
    const cx = BX + 26 + i * ((BW - 52) / 3);
    p.push(
      T(cx, CY + 88, n, { size: 42, weight: "800", fill: tone }),
      T(cx, CY + 114, label, { size: 13, fill: t.ink2 }),
    );
  });

  p.push(
    T(48, H - 24, "npm install toolgz", { size: 13.5, weight: "700" }),
    T(196, H - 24, "zero runtime dependencies · Apache-2.0 · raw per-run records committed to the repo", { size: 12, fill: t.muted }),
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
    `A 200,000 token context window shown twice. Uncompressed, 149 MCP tool definitions occupy ${fmt(UNCOMP)} tokens, ${((UNCOMP / WINDOW) * 100).toFixed(1)} percent of the window, before the user says anything. At level 3 the same tools occupy ${fmt(L3)} tokens, ${((L3 / WINDOW) * 100).toFixed(1)} percent. ${FIT_RAW} real tools fit in 200k uncompressed against ${FIT_L3} at level 3, and ${RECLAIMED} of the tool block is reclaimed.`,
  )}">${p.join("")}</svg>`;
}

// ── emit ────────────────────────────────────────────────────────────────────
for (const [name, theme] of [["light", LIGHT], ["dark", DARK]] as const) {
  writeFileSync(`${OUT}logo-${name}.svg`, logo(theme));
  png(`${OUT}logo-${name}.svg`, 840);
  writeFileSync(`${OUT}icon-${name}.svg`, icon(theme));
  png(`${OUT}icon-${name}.svg`, 512);
  writeFileSync(`${OUT}occupancy-${name}.svg`, occupancy(theme));
  png(`${OUT}occupancy-${name}.svg`, 2400);
}
writeFileSync(`${OUT}favicon.svg`, favicon());

console.log("wrote docs/img/{logo,icon,occupancy}-{light,dark}.{svg,png} + favicon.svg");
console.log(`  occupancy parsed from README: ${fmt(UNCOMP)} → ${fmt(L3)} tokens (${RECLAIMED})`);
console.log(`  ceiling parsed from README:   ${FIT_RAW} uncompressed → ${FIT_L3} at level 3`);
console.log(`  occupancy: ${((UNCOMP / WINDOW) * 100).toFixed(1)}% of a 200k window → ${((L3 / WINDOW) * 100).toFixed(1)}%`);
