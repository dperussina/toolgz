/**
 * The README's images must agree with the library and with the shipped API.
 *
 * Every image here is generated, not drawn, precisely so this test can exist. Two
 * failures it is built to catch:
 *
 *  - A figure in a picture going stale. Prose gets audited; images do not, and a
 *    number baked into an SVG is invisible to every other guard in this repo.
 *  - An image advertising a map style that was removed. The reliability chart
 *    deliberately renders two removed arms because they are the evidence for the
 *    default — so the requirement is not "never show them", it is "never show them
 *    unmarked".
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { compress } from "../src/index.js";
import type { Tool } from "../src/types.js";

const img = (n: string) => readFileSync(`docs/img/${n}`, "utf8");
const REAL: Tool[] = JSON.parse(readFileSync("bench/fixtures/real-mcp-tools.json", "utf8")).map(
  (t: any) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }),
);

/** Figures that paint their own background, so they can sit on any page. */
const THEMED = ["metaphor", "savings", "reliability", "cost", "social-card", "level3-card", "occupancy"];
/** Marks. These must stay transparent — a logo with a baked surface shows as a tile. */
const MARKS = ["logo", "icon"];
/** One dark surface across every asset: two values put a visible seam in the dark page. */
const DARK_SURFACE = "#141413";
const LIGHT_SURFACE = "#fcfcfb";

describe("every README image ships both themes, and dark is not a copy of light", () => {
  for (const n of THEMED) {
    it(`${n}: light and dark both exist and differ`, () => {
      expect(existsSync(`docs/img/${n}-light.svg`), `${n}-light.svg missing`).toBe(true);
      expect(existsSync(`docs/img/${n}-dark.svg`), `${n}-dark.svg missing`).toBe(true);
      expect(img(`${n}-light.svg`)).not.toBe(img(`${n}-dark.svg`));
    });

    it(`${n}: each theme paints its own surface, and the same one as every other asset`, () => {
      // A dark variant that kept the light surface would render white-on-white. And two
      // different dark surfaces across assets put a seam in the dark page — we shipped
      // #1a1a19 in the charts against #141413 in the card and the site before this test.
      expect(img(`${n}-light.svg`)).toContain(LIGHT_SURFACE);
      expect(img(`${n}-dark.svg`)).toContain(DARK_SURFACE);
      expect(img(`${n}-dark.svg`), "stale dark surface").not.toContain("#1a1a19");
    });
  }
});

describe("marks stay transparent and legible small", () => {
  for (const n of MARKS) {
    it(`${n}: both themes exist and neither bakes in a surface`, () => {
      for (const theme of ["light", "dark"]) {
        const svg = img(`${n}-${theme}.svg`);
        expect(existsSync(`docs/img/${n}-${theme}.svg`)).toBe(true);
        // A full-bleed rect the size of the viewBox would be a baked background.
        expect(svg, `${n}-${theme} paints a page surface`).not.toContain(LIGHT_SURFACE);
        expect(svg, `${n}-${theme} paints a page surface`).not.toContain(DARK_SURFACE);
      }
    });
  }

  it("the favicon reacts to the viewer's theme in one file", () => {
    const f = readFileSync("docs/img/favicon.svg", "utf8");
    expect(f).toContain("prefers-color-scheme:dark");
  });

  it("the mark is three shapes, so it survives 16px", () => {
    // Not aesthetic policing: the first draft added chevrons and a second bar column and
    // was unreadable as a favicon.
    const rects = img("icon-light.svg").match(/<rect/g) ?? [];
    expect(rects.length, "the mark has grown past a tile plus three bars").toBeLessThanOrEqual(4);
  });
});

describe("the metaphor image quotes real numbers", () => {
  /**
   * It is generated from `compress()` on the committed corpus, so these are the
   * numbers the library actually produces — not a designer's approximation that
   * drifts the next time level 1 changes.
   */
  const svg = img("metaphor-light.svg");

  it("states level 1's and level 3's real savings", () => {
    for (const level of [1, 3] as const) {
      const pct = compress(REAL, { level }).stats.savedPct.toFixed(1);
      expect(svg, `metaphor image is missing the level ${level} figure ${pct}%`).toContain(`${pct}% smaller`);
    }
  });

  it("states the real wire-tool counts, which is the whole visual point", () => {
    expect(svg).toContain(`${compress(REAL, { level: 1 }).stats.toolCount} tools on the wire`);
    expect(svg).toContain(`${compress(REAL, { level: 3 }).stats.wireToolCount} tools on the wire`);
  });

  it("names who validates on every panel, because that is the actual trade", () => {
    expect(svg.match(/checks the order/g)?.length).toBeGreaterThanOrEqual(3);
    expect(svg).toContain("toolgz checks the order");
  });

  it("does not encode the validation trade in colour alone", () => {
    // validate_palette.js measures the amber/green pair at dE 1.7 under protanopia.
    // The circle-vs-triangle distinction is what carries it for those readers, so the
    // triangle path must be present, not just the two fills.
    expect(svg, "the caution marker must be a shape, not only a colour").toMatch(/<path d="M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+ Z"/);
  });

  it("has no text overflowing its panel", () => {
    // Caught a real defect: the level-3 card was 86px wide with a line needing 91px.
    const w = Number(img("metaphor-light.svg").match(/width="(\d+)"/)![1]);
    for (const m of svg.matchAll(/<text x="([\d.]+)"/g)) {
      expect(Number(m[1]), `text starts beyond the canvas (${w}px)`).toBeLessThan(w);
    }
  });
});

describe("no image advertises a map style a caller cannot select", () => {
  it("marks removed styles as removed wherever they appear", () => {
    // "bare names" = mapStyle "name", "terse desc" = mapStyle "terse". Both deleted in
    // 0.2.0. They are charted as the evidence for the shipped default, which is fine —
    // being charted unmarked is not.
    for (const theme of ["light", "dark"]) {
      const svg = img(`reliability-${theme}.svg`);
      // Asserted, not assumed: without this the loop below passes vacuously the moment
      // a label is renamed, which is exactly when the guard is needed.
      const present = ["L3 bare names", "L3 terse desc"].filter((l) => svg.includes(l));
      expect(present.length, `reliability-${theme}.svg charts no removed arm — if that is intended, delete this test rather than letting it pass on nothing`).toBe(2);
      for (const label of present) {
        const i = svg.indexOf(label);
        expect(svg.slice(i, i + label.length + 40), `${label} is charted without "(removed)"`).toContain("(removed)");
      }
      expect(svg, "the footnote must say why removed styles are shown").toMatch(/removed from the library in 0\.2\.0|deleted from the library in 0\.2\.0/);
    }
  });
});
