/**
 * The level-3 card: what goes in, what goes out, and how it gets called.
 *
 *   npx tsx bench/level3-card.ts
 *
 * Everything on it is real. The "before" JSON is a tool from the committed corpus, the
 * map lines are what `compress()` emits for it, and the round trip at the bottom is an
 * actual `encodeCallForTest` → `resolve` pair. The headline token figures are parsed out
 * of the README's scaling table rather than typed here, the same way `social-card.ts`
 * does it, so the card cannot quietly disagree with the docs.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { compress } from "../src/index.js";
import { REAL_TOOLS } from "./fixtures/real.js";
import type { Tool } from "../src/types.js";

type Theme = {
  surface: string; panel: string; panel2: string; ink: string; ink2: string;
  muted: string; rule: string; accent: string; good: string; caution: string; code: string;
};
const LIGHT: Theme = {
  surface: "#fcfcfb", panel: "#f4f3ee", panel2: "#ecebe4", ink: "#0b0b0b", ink2: "#52514e",
  muted: "#898781", rule: "#dedcd3", accent: "#2a78d6", good: "#006300", caution: "#8a5a00", code: "#2f2e2b",
};
const DARK: Theme = {
  surface: "#141413", panel: "#1f1f1e", panel2: "#292928", ink: "#ffffff", ink2: "#c3c2b7",
  muted: "#8a8983", rule: "#333331", accent: "#5ea1f0", good: "#0ca30c", caution: "#bd8010", code: "#d8d6cf",
};

const FONT = `system-ui,-apple-system,'Segoe UI',sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,monospace`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const W = 1200, H = 700;

// ── real inputs ─────────────────────────────────────────────────────────────
/**
 * Loaded through the canonical export, never re-mapped here.
 *
 * bench/metaphor.ts re-read the JSON with its own mapping and got 45.2% where the
 * corpus of record gives 46.8% — two loaders, two answers, exactly the divergence
 * bench/strategies/index.ts warns about. One loader.
 *
 * `REAL_TOOLS` carries bench-only `ns`/`op` fields, so it is stripped to the shape an
 * MCP client actually hands you before anything is measured against it.
 */
const REAL: Tool[] = (REAL_TOOLS as any[]).map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}));

const c3 = compress(REAL, { level: 3 });

/** The README scaling table is the figure of record for this corpus. Parse, never type. */
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const row = readme.split("\n").find((l) => /^\|\s*149 \(the real corpus\)/.test(l));
if (!row) throw new Error("README scaling table row for 149 tools not found — card would invent figures");
const cells = row.split("|").map((c) => c.replace(/\*/g, "").trim());
const [, , UNCOMPRESSED, LEVEL3, RECLAIMED] = cells;

/** A tool whose JSON is representative: real prose, one parameter, legible at this size. */
const SHOWN = REAL.find((t) => t.name === "get_call_recordings")!;

/** The map lines compress() actually produced, not a mock-up. */
const MAP_LINES = c3.systemPreamble.split("\n").filter((l) => /^[a-z]+\d+\s/.test(l));
const PICK = MAP_LINES.find((l) => l.startsWith("c0 ")) ?? MAP_LINES[0];
const PICK_CODE = PICK.split(" ")[0];
const PICK_NAME = PICK.split(" ")[1];
const SHOWN_CALL = REAL.find((t) => t.name === PICK_NAME)!;

/**
 * Arguments derived from the schema, not invented.
 *
 * The first draft hand-wrote `analysis_type: "summary"`, which is not in that tool's
 * enum — `validate` rejected it and the guard below refused to draw the card. Correct
 * behaviour from the library, and a card that would have shown a call the library does
 * not accept. So the values come from the schema itself.
 */
function argsFor(schema: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of schema?.required ?? []) {
    const prop = schema.properties?.[key] ?? {};
    out[key] = prop.enum?.[0] ?? "…";
  }
  return out;
}
const ARGS = argsFor((SHOWN_CALL as any).input_schema);
const RAW = c3.encodeCallForTest(PICK_NAME, ARGS);
const RESOLVED = c3.resolve(RAW.name, RAW.args);
if (RESOLVED.kind !== "call" || RESOLVED.name !== PICK_NAME) {
  throw new Error(`round trip failed for ${PICK_NAME} — refusing to draw a card that lies`);
}

// ── drawing helpers ─────────────────────────────────────────────────────────
const t_ = (x: number, y: number, s: string, o: Partial<{ size: number; fill: string; weight: string; font: string; anchor: string; ls: string }> = {}) =>
  `<text x="${x}" y="${y}" font-family="${o.font ?? FONT}" font-size="${o.size ?? 13}" ` +
  `font-weight="${o.weight ?? "400"}" fill="${o.fill ?? "#000"}"` +
  `${o.anchor ? ` text-anchor="${o.anchor}"` : ""}${o.ls ? ` letter-spacing="${o.ls}"` : ""}>${esc(s)}</text>`;

/** Hard-wrap monospace to a column count, since SVG will not do it for us. */
const wrapMono = (s: string, cols: number): string[] => {
  const out: string[] = [];
  for (const line of s.split("\n")) {
    if (line.length <= cols) { out.push(line); continue; }
    let cur = "";
    for (const word of line.split(" ")) {
      if (cur && (cur + " " + word).length > cols) { out.push(cur); cur = "      " + word; }
      else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) out.push(cur);
  }
  return out;
};

function beforeJson(): string[] {
  const schema = (SHOWN as any).input_schema ?? (SHOWN as any).inputSchema;
  if (!schema) throw new Error("chosen tool has no schema — the BEFORE panel would understate the block");
  return wrapMono(JSON.stringify({ name: SHOWN.name, description: SHOWN.description, inputSchema: schema }, null, 2), 62).slice(0, 13);
}

function render(t: Theme): string {
  const p: string[] = [`<rect width="${W}" height="${H}" fill="${t.surface}"/>`];

  // ── header ────────────────────────────────────────────────────────────────
  p.push(
    t_(48, 52, "LEVEL 3 — DISPATCHER + CACHED MAP", { size: 13, weight: "700", fill: t.accent, ls: "1.6" }),
    t_(48, 96, "149 tools in. Two tools on the wire.", { size: 36, weight: "700", fill: t.ink }),
    t_(W - 48, 74, RECLAIMED, { size: 52, weight: "700", fill: t.good, anchor: "end" }),
    t_(W - 48, 96, "of the tool block reclaimed", { size: 13, fill: t.ink2, anchor: "end" }),
  );

  const PW = 520, PY = 136, PH = 336;
  const LX = 48, RX = W - 48 - PW;

  // ── before ────────────────────────────────────────────────────────────────
  p.push(
    `<rect x="${LX}" y="${PY}" width="${PW}" height="${PH}" rx="12" fill="${t.panel}"/>`,
    t_(LX + 20, PY + 30, "BEFORE", { size: 12, weight: "700", fill: t.muted, ls: "1.4" }),
    t_(LX + 20, PY + 52, "every tool, in full, on every request", { size: 14, weight: "600", fill: t.ink }),
    `<rect x="${LX + 20}" y="${PY + 66}" width="${PW - 40}" height="216" rx="8" fill="${t.panel2}"/>`,
  );
  beforeJson().forEach((l, i) =>
    p.push(t_(LX + 32, PY + 88 + i * 12.4, l, { size: 9.6, font: MONO, fill: t.code })),
  );
  p.push(
    // Fade, so the reader understands the block continues rather than ends here.
    `<rect x="${LX + 21}" y="${PY + 246}" width="${PW - 42}" height="35" rx="6" fill="${t.panel2}"/>`,
    t_(LX + 32, PY + 268, "…and 148 more tools, every request", { size: 10, font: MONO, fill: t.muted }),
    t_(LX + 20, PY + 308, `${UNCOMPRESSED} prompt tokens`, { size: 17, weight: "700", fill: t.ink }),
    t_(LX + 20, PY + 326, "34% of a 200k window before the user speaks", { size: 11.5, fill: t.ink2 }),
  );

  // ── arrow ─────────────────────────────────────────────────────────────────
  const AX = LX + PW + 16, AY = PY + PH / 2;
  p.push(
    `<circle cx="${AX + 14}" cy="${AY}" r="17" fill="${t.accent}"/>`,
    `<path d="M${AX + 7} ${AY} L${AX + 20} ${AY} M${AX + 15} ${AY - 5} L${AX + 20} ${AY} L${AX + 15} ${AY + 5}" stroke="${t.surface}" stroke-width="2.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    t_(AX + 14, AY + 36, "compress", { size: 10.5, font: MONO, fill: t.muted, anchor: "middle" }),
    t_(AX + 14, AY + 49, "level: 3", { size: 10.5, font: MONO, fill: t.muted, anchor: "middle" }),
  );

  // ── after ─────────────────────────────────────────────────────────────────
  p.push(
    `<rect x="${RX}" y="${PY}" width="${PW}" height="${PH}" rx="12" fill="${t.panel}"/>`,
    t_(RX + 20, PY + 30, "AFTER", { size: 12, weight: "700", fill: t.accent, ls: "1.4" }),
    t_(RX + 20, PY + 52, "two tools, and a map you cache once", { size: 14, weight: "600", fill: t.ink }),

    `<rect x="${RX + 20}" y="${PY + 66}" width="${PW - 40}" height="62" rx="8" fill="${t.panel2}"/>`,
    t_(RX + 32, PY + 84, "ON THE WIRE", { size: 9.5, weight: "700", fill: t.muted, ls: "1.2" }),
    t_(RX + 32, PY + 102, "t(f, a)", { size: 12, font: MONO, fill: t.accent }),
    t_(RX + 110, PY + 102, "dispatch by map code", { size: 11, fill: t.ink2 }),
    t_(RX + 32, PY + 119, "q(c, s)", { size: 12, font: MONO, fill: t.accent }),
    t_(RX + 110, PY + 119, "expand a code, or search the map", { size: 11, fill: t.ink2 }),

    `<rect x="${RX + 20}" y="${PY + 140}" width="${PW - 40}" height="142" rx="8" fill="${t.panel2}"/>`,
    t_(RX + 32, PY + 158, "IN THE SYSTEM PROMPT", { size: 9.5, weight: "700", fill: t.muted, ls: "1.2" }),
    t_(RX + 210, PY + 158, "◆ behind a cache breakpoint", { size: 9.5, weight: "600", fill: t.caution }),
    t_(RX + 32, PY + 178, "<toolmap>", { size: 10.4, font: MONO, fill: t.muted }),
  );
  [MAP_LINES[0], MAP_LINES[2], PICK, MAP_LINES[MAP_LINES.length - 1]].forEach((l, i) =>
    p.push(t_(RX + 32, PY + 195 + i * 15, l.slice(0, 58), { size: 10.4, font: MONO, fill: t.code })),
  );
  p.push(
    t_(RX + 32, PY + 255, `…${MAP_LINES.length - 4} more lines`, { size: 10.4, font: MONO, fill: t.muted }),
    t_(RX + 32, PY + 272, "</toolmap>", { size: 10.4, font: MONO, fill: t.muted }),
    t_(RX + 20, PY + 308, `${LEVEL3} prompt tokens`, { size: 17, weight: "700", fill: t.good }),
    t_(RX + 20, PY + 326, "and it does not grow the way the block did", { size: 11.5, fill: t.ink2 }),
  );

  // ── how it is called ──────────────────────────────────────────────────────
  const FY = PY + PH + 30;
  p.push(
    `<rect x="48" y="${FY}" width="${W - 96}" height="122" rx="12" fill="${t.panel}"/>`,
    t_(68, FY + 27, "HOW IT IS CALLED", { size: 12, weight: "700", fill: t.muted, ls: "1.4" }),
  );
  const steps: [string, string, string][] = [
    ["1", "the model emits", `t(f="${PICK_CODE}", a=${JSON.stringify(ARGS).replace(/","/g, '", "').replace(/":"/g, '": "')})`],
    ["2", "c.resolve() returns", `{ kind: "call", name: "${RESOLVED.name}", args: {…} }`],
    ["3", "your dispatcher runs", `${RESOLVED.name}({…})   ← unchanged`],
  ];
  steps.forEach(([num, label, code], i) => {
    const y = FY + 52 + i * 22;
    p.push(
      `<circle cx="76" cy="${y - 4}" r="8" fill="${i === 2 ? t.good : t.accent}"/>`,
      t_(76, y - 0.5, num, { size: 10, weight: "700", fill: t.surface, anchor: "middle" }),
      t_(92, y, label, { size: 11.5, fill: t.ink2 }),
      t_(232, y, code, { size: 11.6, font: MONO, fill: i === 2 ? t.good : t.code }),
    );
  });

  // ── footer ────────────────────────────────────────────────────────────────
  p.push(
    t_(48, H - 22, "npm install toolgz", { size: 13, weight: "700", fill: t.ink }),
    t_(196, H - 22, "zero runtime dependencies · Apache-2.0 · every figure here generated by running the library", { size: 11, fill: t.muted }),
    // The trade, on the card rather than in the small print, because it is the thing a
    // developer needs to decide about.
    t_(W - 48, H - 22, "validate: true — toolgz checks args against your original schema", { size: 11, fill: t.caution, anchor: "end" }),
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
    `toolgz level 3. Before: 149 MCP tool definitions in full, ${UNCOMPRESSED} prompt tokens. After: two tools on the wire, t and q, plus a cached toolmap in the system prompt, ${LEVEL3} prompt tokens, ${RECLAIMED} reclaimed. The model calls t with a map code, resolve returns the real tool name and arguments, and the dispatcher runs unchanged.`,
  )}">${p.join("")}</svg>`;
}

const OUT = new URL("../docs/img/", import.meta.url).pathname;
for (const [name, theme] of [["light", LIGHT], ["dark", DARK]] as const) {
  const file = `${OUT}level3-card-${name}.svg`;
  writeFileSync(file, render(theme));
  try {
    execFileSync("rsvg-convert", ["-w", String(W * 2), file, "-o", `${OUT}level3-card-${name}.png`]);
  } catch {
    console.warn(`  (rsvg-convert unavailable — wrote SVG only for ${name})`);
  }
}
console.log("wrote docs/img/level3-card-{light,dark}.{svg,png}");
console.log(`  figures parsed from README: ${UNCOMPRESSED} → ${LEVEL3} (${RECLAIMED})`);
console.log(`  round trip verified: ${RAW.name}(${JSON.stringify(RAW.args)}) → ${RESOLVED.name}`);
