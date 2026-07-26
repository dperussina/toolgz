/**
 * Per-model map-style selection, and the drift guard on the generated table.
 *
 * Every row in src/policy.generated.ts is a measurement, so these tests check two
 * different things: that the *mechanism* behaves as specified, and that the *table*
 * still matches the committed raw results it was derived from. The second is the one
 * that matters long-term — a hand-edited or stale table would rot exactly the way
 * bench/ and src/ diverged before.
 *
 * Source: tier-3 sweep 2026-07-26T03-07-25, 432 runs, 36 per arm per provider.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { compress } from "../src/index.js";
import { POLICY, BROKEN, CONSERVATIVE_DEFAULT } from "../src/policy.generated.js";
import type { Tool } from "../src/types.js";

const TOOLS: Tool[] = [
  { name: "svc_needs_args", description: "x", inputSchema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } },
  { name: "svc_needs_none", description: "y", inputSchema: { type: "object", properties: { limit: { type: "integer" } } } },
];
const style = (o: any) => compress(TOOLS, { level: 3, ...o }).stats.mapStyle;

describe("selection", () => {
  it("is unchanged when no model is given — existing callers must not move", () => {
    expect(style({})).toBe(CONSERVATIVE_DEFAULT);
    expect(compress(TOOLS, { level: 3 }).systemPreamble).toBe(
      compress(TOOLS, { level: 3, mapStyle: CONSERVATIVE_DEFAULT }).systemPreamble,
    );
  });

  it("picks the measured style for a known (model, objective)", () => {
    for (const e of POLICY) {
      expect(style({ model: e.model, objective: e.objective }), `${e.model}/${e.objective}`).toBe(e.mapStyle);
    }
  });

  it("falls back for a known model with no measured win on that objective", () => {
    // grok-4.5 is absent from the cost table because `explicit` measured +13.2%
    // there. Absent means "no measured improvement", never "untested".
    expect(style({ model: "grok-4.5", objective: "cost" })).toBe(CONSERVATIVE_DEFAULT);
  });

  it("defaults to the occupancy objective, which currently has no entries", () => {
    // Every occupancy difference measured was within +/-3.1%, under the 5% floor.
    expect(POLICY.filter((e) => e.objective === "occupancy")).toEqual([]);
    expect(style({ model: "gpt-5.6-sol" })).toBe(CONSERVATIVE_DEFAULT);
  });

  it("treats an unknown model as an absence of evidence, not a prediction", () => {
    expect(style({ model: "some-model-released-next-year" })).toBe(CONSERVATIVE_DEFAULT);
  });

  it("honours an explicit style request", () => {
    expect(style({ mapStyle: "grouped" })).toBe("grouped");
    expect(style({ model: "gpt-5.6-sol", mapStyle: "terse" })).toBe("terse");
  });
});

describe("broken pairs are disallowed, and the fallback is visible", () => {
  it("refuses a measured-unsafe pair and substitutes", () => {
    const c = compress(TOOLS, { level: 3, model: "grok-4.5", mapStyle: "nocode" });
    expect(c.stats.mapStyle).toBe(CONSERVATIVE_DEFAULT);
    expect(c.stats.requestedMapStyle).toBe("nocode");
  });

  it("says why, naming the model and the evidence — never silent", () => {
    const c = compress(TOOLS, { level: 3, model: "grok-4.5", mapStyle: "nocode" });
    expect(c.stats.fallbackReason).toMatch(/grok-4\.5/);
    expect(c.stats.fallbackReason).toMatch(/n=36/);
    expect(c.stats.fallbackReason).toMatch(/sweep 2026-07-26/);
  });

  it("does not throw or write to the console", () => {
    expect(() => compress(TOOLS, { level: 3, model: "grok-4.5", mapStyle: "nocode" })).not.toThrow();
  });

  it("only blocks the measured pair, not the style everywhere", () => {
    expect(style({ model: "gemini-3.1-pro-preview", mapStyle: "nocode" })).toBe("nocode");
    expect(style({ mapStyle: "nocode" })).toBe("nocode");
  });

  it("reports no fallback when nothing was substituted", () => {
    const c = compress(TOOLS, { level: 3, model: "gpt-5.6-sol", objective: "cost" });
    expect(c.stats.fallbackReason).toBeUndefined();
    expect(c.stats.requestedMapStyle).toBeUndefined();
  });
});

describe("the generated table has not drifted from the committed results", () => {
  /** Load every run from the sweep a row cites. */
  const runsFor = (sweep: string) => {
    const out: any[] = [];
    for (const f of readdirSync("bench/results").filter((f) => f.includes(sweep))) {
      for (const l of readFileSync(`bench/results/${f}`, "utf8").split("\n")) {
        if (l.trim()) out.push(JSON.parse(l));
      }
    }
    return out;
  };
  const providerOf = (model: string) =>
    ({ "claude-opus-5": "anthropic", "gemini-3.1-pro-preview": "gemini", "gpt-5.6-sol": "openai", "grok-4.5": "xai" })[model];

  it("every cited sweep is actually committed", () => {
    for (const e of [...POLICY, ...BROKEN]) {
      expect(runsFor(e.sweep).length, `${e.sweep} missing from bench/results`).toBeGreaterThan(0);
    }
  });

  it("every row's run count matches the raw records", () => {
    for (const e of POLICY) {
      const runs = runsFor(e.sweep).filter(
        (r) => r.provider === providerOf(e.model) && r.arm === `minified-${e.mapStyle}`,
      );
      expect(runs.length, `${e.model}/${e.mapStyle}`).toBe(e.n);
    }
  });

  it("every recommended style actually completed every task it cites", () => {
    // A style is never recommended on cost alone; it has to have been reliable.
    for (const e of POLICY) {
      const runs = runsFor(e.sweep).filter(
        (r) => r.provider === providerOf(e.model) && r.arm === `minified-${e.mapStyle}`,
      );
      const ok = runs.filter((r) => r.taskSuccess).length;
      expect(ok, `${e.model}/${e.mapStyle} task rate`).toBe(runs.length);
    }
  });

  it("every broken pair really did fail in the sweep it cites", () => {
    for (const b of BROKEN) {
      const runs = runsFor(b.sweep).filter(
        (r) => r.provider === providerOf(b.model) && r.arm === `minified-${b.mapStyle}`,
      );
      const failures = runs.filter((r) => !r.taskSuccess).length;
      expect(failures, `${b.model}/${b.mapStyle} should have failures on record`).toBeGreaterThan(0);
    }
  });

  it("every row clears the 5% effect-size floor", () => {
    // Below that, same-arm figures moved by more than the effect during development.
    for (const e of POLICY) expect(Math.abs(e.effectPct), e.model).toBeGreaterThanOrEqual(5);
  });

  it("keys on exact model ids, never families", () => {
    for (const e of [...POLICY, ...BROKEN]) expect(e.model).toMatch(/[.\-]\d|\d/);
  });
});
