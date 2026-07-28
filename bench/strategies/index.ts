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
import { readFileSync } from "node:fs";
import { compress } from "../../src/index.js";

/** Committed so the level-4 arm is reproducible without compiling on every sweep. */
const PYTHON_MAP: Record<string, string> = JSON.parse(
  readFileSync(new URL("../fixtures/python-map.json", import.meta.url), "utf8"),
);
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

type LibOpts = {
  level: 0 | 1 | 2 | 3 | 4;
  mapStyle?: MapStyle;
  signaturePrefix?: boolean;
  compiled?: Record<string, string>;
};

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

/** The shipped level-3 default, so the sweep always covers what users get. */
export const minifiedDefault = fromLibrary(
  "minified-default",
  "Arm A (default) · level 3 as shipped",
  { level: 3 },
);

// ── arm-A variants, also library configurations ─────────────────────────────

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
];

/** Arm-A variants, opted into with --variants. */
/** Full signature in the map: trades a larger cached map for fewer lookups. */
export const minifiedSig = fromLibrary(
  "minified-sig",
  "Arm A‴ · minified + full signature in map",
  { level: 3, mapStyle: "signature" },
);

/**
 * The cheap fix for the zero-required blind spot. 44% of real tools declare no
 * required parameters, so their map line is a bare name and models spend a lookup
 * confirming they can be called as-is. `explicit` says so for +275 characters, where
 * naming the optional parameters (mapStyle "optional") cost +3,240 and measured +41%.
 */
export const minifiedExplicit = fromLibrary(
  "minified-explicit",
  "Arm B · mark zero-required tools ()",
  { level: 3, mapStyle: "explicit" },
);

/**
 * Level 1 without the `name(a,b?)` prefix on each description.
 *
 * Offline the prefix is pure cost: it restates the tool name, property names, required
 * list, enums and item types that level 1's retained `input_schema` already carries, and
 * it is 18.5% of the level-1 payload on the real corpus. Dropping it takes real tools
 * from 45.2% to 55.3%, and takes a terse catalogue from -14.4% (inflating) to -0.6%,
 * which is the level-0 floor — so level 1 would stop being able to make things worse.
 *
 * The open question is not size, it is whether a model reads a one-line signature more
 * reliably than the equivalent JSON. At level 1 the schema is present either way, so the
 * prefix may be redundant for the model too — but every arm that measured clean had it,
 * so this arm exists to find out rather than to assume.
 */
export const signaturesNoPrefix = fromLibrary(
  "signatures-noprefix",
  "Arm C′ · L1 without the signature prefix",
  { level: 1, signaturePrefix: false },
);

/**
 * Level 4: the map is minified Python a model compiled from this corpus.
 *
 * The artifact is committed (bench/fixtures/python-map.json) so the arm is reproducible
 * without an API call at run time — compilation is a build step, and re-compiling per
 * sweep would meanevery run measured a slightly different map.
 */
export const compiledPython = fromLibrary(
  "compiled",
  "Arm E · level 4, compiled Python map",
  { level: 4, compiled: PYTHON_MAP },
);

/**
 * Level 1 with the compiled docstrings as descriptions.
 *
 * The interesting arm: provider-side enforcement is fully intact because these are
 * ordinary native tools with real schemas, and the tool block still drops from 41,655
 * tokens to 35,103. The question is behavioural — does a written docstring select as well
 * as the tool's own first sentence?
 */
export const signaturesCompiled = fromLibrary(
  "signatures-compiled",
  "Arm C\u2033 · L1 with compiled descriptions",
  { level: 1, compiled: PYTHON_MAP },
);

export const A_VARIANTS: CompressionStrategy[] = [
  compiledPython,
  signaturesCompiled,
  signaturesNoPrefix,
  minifiedPlus,
  minifiedSig,
  minifiedExplicit,
];

/** Maps each library-backed arm to the configuration it must equal. */
export const LIBRARY_ARM_MAP: { arm: CompressionStrategy; opts: LibOpts }[] = [
  { arm: control, opts: { level: 0 } },
  { arm: signatures, opts: { level: 1 } },
  { arm: hybrid, opts: { level: 2 } },
  { arm: minifiedDefault, opts: { level: 3 } },
  { arm: minifiedPlus, opts: { level: 3, mapStyle: "name+required" } },
  { arm: minifiedSig, opts: { level: 3, mapStyle: "signature" } },
  { arm: minifiedExplicit, opts: { level: 3, mapStyle: "explicit" } },
  { arm: signaturesNoPrefix, opts: { level: 1, signaturePrefix: false } },
  { arm: compiledPython, opts: { level: 4, compiled: PYTHON_MAP } },
  { arm: signaturesCompiled, opts: { level: 1, compiled: PYTHON_MAP } },
];
