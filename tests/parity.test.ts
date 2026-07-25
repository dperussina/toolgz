/**
 * Benchmark/library parity guard.
 *
 * The benchmark exists to tell us what to ship. That only holds if the arms are
 * the library. This suite fails if anyone reintroduces a bespoke implementation
 * in bench/strategies — which is exactly what happened once: the bench level-3
 * arm rendered terse prose map lines while the library shipped bare names, so a
 * 150-run sweep validated a configuration the product did not have.
 *
 * Do not "fix" a failure here by editing the expectation. Fix the arm to wrap
 * the library, or add the variation as a library option.
 */
import { describe, it, expect } from "vitest";
import { compress } from "../src/index.js";
import {
  ARMS,
  A_VARIANTS,
  LIBRARY_ARM_MAP,
  nativeSearch,
} from "../bench/strategies/index.js";
import { ALL_TOOLS, subset } from "../bench/fixtures/tools.js";

/** Arms with no library counterpart, and why. */
const BENCH_ONLY = new Map([
  [
    "native",
    "Anthropic server-side tool search — a competitive baseline, not a library feature",
  ],
]);

const FIXTURES: { name: string; tools: typeof ALL_TOOLS }[] = [
  { name: "full catalogue (100)", tools: ALL_TOOLS },
  { name: "60-tool subset", tools: subset(60) },
  { name: "10-tool subset", tools: subset(10) },
];

describe("every library-backed arm is byte-identical to its library config", () => {
  for (const { arm, opts } of LIBRARY_ARM_MAP) {
    for (const fx of FIXTURES) {
      it(`${arm.id} === compress(${JSON.stringify(opts)}) on ${fx.name}`, () => {
        const fromArm = arm.compile(fx.tools);
        const fromLib = compress(fx.tools as any, opts);

        expect(JSON.stringify(fromArm.tools)).toBe(JSON.stringify(fromLib.tools));
        expect(fromArm.systemPreamble).toBe(fromLib.systemPreamble);
        expect(fromArm.cachePreamble).toBe(fromLib.cachePreamble);
      });
    }
  }
});

describe("arm registry hygiene", () => {
  const all = [...ARMS, ...A_VARIANTS];

  it("every arm is either library-backed or explicitly bench-only", () => {
    const mapped = new Set(LIBRARY_ARM_MAP.map((e) => e.arm.id));
    const unaccounted = all
      .map((a) => a.id)
      .filter((id) => !mapped.has(id) && !BENCH_ONLY.has(id));
    expect(
      unaccounted,
      `Unaccounted arms: ${unaccounted.join(", ")}. Either wrap the library ` +
        `(add to LIBRARY_ARM_MAP) or document it in BENCH_ONLY with a reason.`,
    ).toEqual([]);
  });

  it("arm ids are unique", () => {
    const ids = all.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the bench-only allowlist stays small — it is the divergence loophole", () => {
    expect(BENCH_ONLY.size).toBeLessThanOrEqual(1);
  });
});

describe("library-backed arms round-trip through the library resolver", () => {
  for (const { arm, opts } of LIBRARY_ARM_MAP) {
    it(`${arm.id} resolves a real call back to the real tool`, () => {
      const tools = subset(60);
      const target = tools.find((t) => t.name === "github_create_pull_request")!;
      // Compress with the ARM'S OWN configuration. Using a fixed mapStyle here
      // silently assumed every level-3 arm shares one code space, which stopped
      // being true once codeless styles existed: they key the map on the real
      // name, so a hard-coded `mapStyle: "name"` sent them a code like "b4".
      const c = compress(tools as any, opts as any);
      // Encode via the library for level 3; for other levels the model would
      // emit the tool name directly.
      const raw =
        arm.id.startsWith("minified")
          ? { name: "t", args: { f: c.codeFor(target.name), a: reqArgs(target) } }
          : arm.id === "hybrid"
            ? { name: target.ns, args: { op: target.op, args: reqArgs(target) } }
            : { name: target.name, args: reqArgs(target) };

      const r = arm.resolve(tools, raw.name, raw.args as any);
      expect(r.kind, `${arm.id}: ${JSON.stringify(r)}`).toBe("call");
      if (r.kind === "call") expect(r.name).toBe(target.name);
    });
  }
});

function reqArgs(t: (typeof ALL_TOOLS)[number]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of t.input_schema.required ?? []) {
    const spec: any = t.input_schema.properties?.[k] ?? { type: "string" };
    out[k] =
      spec.enum?.[0] ??
      (spec.type === "integer" || spec.type === "number"
        ? 1
        : spec.type === "boolean"
          ? true
          : spec.type === "array"
            ? []
            : spec.type === "object"
              ? {}
              : "x");
  }
  return out;
}
