/**
 * Benchmark arms.
 *
 * ══ READ THIS BEFORE ADDING AN ARM ══
 *
 * Every arm that corresponds to a library feature is a THIN WRAPPER over
 * `compress()` from `src/`. It must not reimplement compression logic.
 *
 * This rule exists because it was broken once and cost us a result. An earlier
 * version of this file had its own level-3 implementation whose map lines were
 * terse prose descriptors, while `src/` shipped bare tool names. The 150-run
 * Anthropic sweep therefore validated a configuration the library did not ship
 * — the benchmark and the product had silently diverged. Two implementations of
 * one idea can only diverge; the fix is to have one implementation.
 *
 * If you want to benchmark a variation, add an OPTION to the library and wrap
 * it here (see `minifiedTerse` / `minifiedPlus` and `CompressOptions.mapStyle`).
 * Then a winning experiment ships by changing a default, not by porting code.
 *
 * `native` is the one legitimate exception: it is Anthropic's server-side tool
 * search, a competitive baseline rather than a library feature, so there is
 * nothing in `src/` for it to wrap.
 *
 * tests/parity.test.ts enforces the wrapper property.
 */
import { compress } from "../../src/index.js";
import type { MapStyle } from "../../src/types.js";
import type {
  CompressionStrategy,
  CompiledRequest,
  ToolDef,
  Resolution,
} from "../core/types.js";

/** Re-exported so bench code shares the library's renderers, never a copy. */
export {
  signatureLine as signature,
  flattenSchema,
} from "../../src/render/index.js";

type LibOpts = { level: 0 | 1 | 2 | 3; mapStyle?: MapStyle };

/**
 * Wrap a library configuration as an arm.
 *
 * `compress()` is pure and cheap, but it is called on every resolve, so the
 * result is memoised per tool-array identity to keep the run loop tight.
 */
function fromLibrary(
  id: string,
  label: string,
  opts: LibOpts,
): CompressionStrategy {
  const cache = new WeakMap<object, ReturnType<typeof compress>>();
  const get = (tools: ToolDef[]) => {
    let c = cache.get(tools as unknown as object);
    if (!c) {
      c = compress(tools as any, opts);
      cache.set(tools as unknown as object, c);
    }
    return c;
  };

  return {
    id,
    label,
    compile(tools): CompiledRequest {
      const c = get(tools);
      return {
        tools: c.tools as any[],
        systemPreamble: c.systemPreamble,
        cachePreamble: c.cachePreamble,
      };
    },
    resolve(tools, rawName, rawArgs): Resolution {
      const r = get(tools).resolve(rawName, rawArgs);
      // Library errors carry `recoverable`; the bench Resolution does not use it.
      if (r.kind === "error") return { kind: "error", message: r.message };
      return r;
    },
  };
}

// ── the four portable arms, each a library level ────────────────────────────

export const control = fromLibrary("control", "Arm 0 · uncompressed", {
  level: 0,
});

export const signatures = fromLibrary(
  "signatures",
  "Arm C · signature lines (L0)",
  { level: 1 },
);

export const hybrid = fromLibrary(
  "hybrid",
  "Arm B · namespace collapse (L0+L1+ns)",
  { level: 2 },
);

export const minified = fromLibrary(
  "minified",
  "Arm A · minified codes, bare names in map",
  { level: 3, mapStyle: "name" },
);

/** The shipped level-3 default, so the sweep always covers what users get. */
export const minifiedDefault = fromLibrary(
  "minified-default",
  "Arm A (default) · level 3 as shipped",
  { level: 3 },
);

// ── arm-A variants, also library configurations ─────────────────────────────

/**
 * The configuration the original 150-run sweep actually measured, before the
 * divergence was found. Kept so the two can be compared head to head instead
 * of assumed equivalent.
 */
export const minifiedTerse = fromLibrary(
  "minified-terse",
  "Arm A′ · minified, terse descriptors in map",
  { level: 3, mapStyle: "terse" },
);

/**
 * Hardening candidate. Arm A's one measured weakness is malformed arguments —
 * the dispatcher gives up provider-side constrained decoding. Naming the
 * required parameters costs a few tokens per tool against a full schema's ~400.
 */
export const minifiedPlus = fromLibrary(
  "minified-plus",
  "Arm A″ · minified + required args in map",
  { level: 3, mapStyle: "name+required" },
);

// ── native tool search: a baseline, not a library feature ───────────────────

/** Tools kept resident; the rest are deferred and must be searched for. */
const NATIVE_HOT = 5;

export const nativeSearch: CompressionStrategy = {
  id: "native",
  label: "Arm D · Anthropic native tool search",
  compile(tools): CompiledRequest {
    const wire: any[] = [
      {
        type: "tool_search_tool_regex_20251119",
        name: "tool_search_tool_regex",
      },
    ];
    tools.forEach((t, i) => {
      wire.push({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
        // At least one tool must stay non-deferred or the API 400s.
        ...(i < NATIVE_HOT ? {} : { defer_loading: true }),
      });
    });
    return { tools: wire, systemPreamble: "", cachePreamble: false };
  },
  resolve(tools, rawName, rawArgs): Resolution {
    // Server-side search resolves itself; nothing to feed back.
    if (rawName === "tool_search_tool_regex") {
      return { kind: "meta", name: rawName, result: "" };
    }
    return control.resolve(tools, rawName, rawArgs);
  },
};

/** Anthropic-only sweep: includes the native baseline. */
export const ARMS: CompressionStrategy[] = [
  control,
  signatures,
  nativeSearch,
  hybrid,
  minified,
];

/** Arm-A variants, opted into with --variants. */
export const A_VARIANTS: CompressionStrategy[] = [minifiedTerse, minifiedPlus];

/** Maps each library-backed arm to the configuration it must equal. */
export const LIBRARY_ARM_MAP: { arm: CompressionStrategy; opts: LibOpts }[] = [
  { arm: control, opts: { level: 0 } },
  { arm: signatures, opts: { level: 1 } },
  { arm: hybrid, opts: { level: 2 } },
  { arm: minified, opts: { level: 3, mapStyle: "name" } },
  { arm: minifiedDefault, opts: { level: 3 } },
  { arm: minifiedTerse, opts: { level: 3, mapStyle: "terse" } },
  { arm: minifiedPlus, opts: { level: 3, mapStyle: "name+required" } },
];
