/**
 * GENERATED — do not edit by hand. Regenerate with:
 *   npx tsx bench/generate-policy.ts --sweep=<timestamp>
 *
 * A record of measurements, not a theory of models. Every row was produced by
 * `bench/analyze-multi.ts` scoped to one sweep, compared within a provider, and
 * filtered to effects of at least 5% — same-arm figures moved by more than that
 * between n=4 and n=96 during development, so smaller effects are noise.
 *
 * Hand-maintaining this would rot exactly the way `bench/` and `src/` diverged
 * before. A drift test (tests/policy.test.ts) fails if it disagrees with the
 * committed results.
 *
 * There is deliberately NO occupancy table. Every measured difference on that axis
 * was within ±3.1%, under the floor — so occupancy gets the default, and this file
 * exists only for the `cost` objective. That is a smaller feature than spec 002
 * originally described, and it is what the data supports.
 */
import type { MapStyle } from "./types.js";

export type Objective = "occupancy" | "cost";

export type PolicyEntry = {
  /** Exact model id. Never a family: gpt-5.6-sol says nothing about gpt-5.7. */
  model: string;
  objective: Objective;
  mapStyle: MapStyle;
  /** Percent change against the conservative default. Negative is better. */
  effectPct: number;
  /** Runs behind this row, per arm. */
  n: number;
  /** The sweep it came from, so any row can be re-derived. */
  sweep: string;
  measured: string;
};

/**
 * Tier-3 sweep, 432 runs, 36 per arm per provider, 12 real MCP scenarios × 3 reps.
 * `explicit` was 144/144 tasks; turns and lookups fell on all four providers.
 * Only rows clearing the 5% floor appear.
 */
export const POLICY: readonly PolicyEntry[] = [
  { model: "claude-opus-5", objective: "cost", mapStyle: "explicit", effectPct: -9.0, n: 36, sweep: "2026-07-26T03-07-25", measured: "2026-07-26" },
  { model: "gemini-3.1-pro-preview", objective: "cost", mapStyle: "explicit", effectPct: -15.4, n: 36, sweep: "2026-07-26T03-07-25", measured: "2026-07-26" },
  { model: "gpt-5.6-sol", objective: "cost", mapStyle: "explicit", effectPct: -20.7, n: 36, sweep: "2026-07-26T03-07-25", measured: "2026-07-26" },
  // grok-4.5 is deliberately absent for `cost`: explicit measured +13.2% there, so it
  // falls through to the conservative default. An absent row means "no measured
  // improvement", never "untested".
];

/**
 * (model, mapStyle) pairs measured as unsafe. A caller asking for one is refused and
 * falls back, per the owner's decision (#15) to disallow rather than warn.
 */
export type BrokenEntry = {
  model: string;
  mapStyle: MapStyle;
  reason: string;
  n: number;
  sweep: string;
};

export const BROKEN: readonly BrokenEntry[] = [
  {
    model: "grok-4.5",
    mapStyle: "nocode",
    reason:
      "19% silent failure rate (7 of 36): the model answered with no tool call at all " +
      "— turns=1, no error — across four different scenarios. Same signature that " +
      "disqualified bare names. Intermittent: it passed 12/12 on an earlier sweep.",
    n: 36,
    sweep: "2026-07-26T03-07-25",
  },
];

/** The style used when nothing is known about the model. */
export const CONSERVATIVE_DEFAULT: MapStyle = "name+required";
