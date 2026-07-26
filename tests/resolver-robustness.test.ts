/**
 * Three resolver defects found by benchmarking against real MCP catalogues.
 *
 * All three share a shape: the model made a reasonable inference and the library
 * rejected it. None broke correctness — every task still completed — so they never
 * showed up as failures. They showed up as *wasted turns*, and on a reasoning model
 * a turn is a fresh round of thinking, so they were costing money silently.
 *
 * Measured on 149 real tools from 14 live MCP servers: one extra turn is worth
 * roughly 3,300 prompt tokens, against a whole-map saving of ~550 for the best
 * encoding change. Accepting what the model sends is worth about six times more
 * than any serialization work.
 */
import { describe, it, expect } from "vitest";
import { compress } from "../src/index.js";
import type { Tool } from "../src/types.js";

const TOOLS: Tool[] = [
  {
    name: "gdrive_sheets_append_rows",
    description: "Append rows to a sheet.",
    inputSchema: {
      type: "object",
      properties: { spreadsheet_id: { type: "string" }, range: { type: "string" } },
      required: ["spreadsheet_id", "range"],
    },
  },
  {
    name: "gdrive_sheets_update_range",
    description: "Overwrite an A1 range.",
    inputSchema: {
      type: "object",
      properties: { spreadsheet_id: { type: "string" }, range: { type: "string" } },
      required: ["spreadsheet_id", "range"],
    },
  },
  {
    name: "coding_task_result",
    description: "Get a finished task's output.",
    inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  },
];

const ARGS = { spreadsheet_id: "1AbC", range: "Log!A1:C1" };

describe("a namespace joined with a dot instead of an underscore", () => {
  /**
   * Observed on gpt-5.6-sol: `gdrive.sheets_append_rows` where the real name uses
   * an underscore. Systematically, never anything else — coding.task_result,
   * reverse.geocode, scorecard.lf_daily. Confirmed not to be transport failure:
   * zero of 369 runs in that sweep recorded an error.
   */
  for (const sep of [".", ":", "/", "-", " ", ""]) {
    it(`accepts gdrive${JSON.stringify(sep)}sheets_append_rows`, () => {
      const k = compress(TOOLS, { level: 3 });
      const r = k.resolve("t", { f: `gdrive${sep}sheets_append_rows`, a: ARGS });
      expect(r.kind, `separator ${JSON.stringify(sep)}`).toBe("call");
      if (r.kind === "call") expect(r.name).toBe("gdrive_sheets_append_rows");
    });
  }

  it("works through q() as well as t()", () => {
    const r = compress(TOOLS, { level: 3 }).resolve("q", { c: "coding.task_result" });
    expect(r.kind).toBe("meta");
  });

  it("is case-insensitive", () => {
    const r = compress(TOOLS, { level: 3 }).resolve("t", {
      f: "GDrive.Sheets_Append_Rows",
      a: ARGS,
    });
    expect(r.kind).toBe("call");
  });

  it("applies to every shipped map style", () => {
    for (const mapStyle of ["name+required", "explicit", "signature"] as const) {
      const k = compress(TOOLS, { level: 3, mapStyle });
      const r = k.resolve("t", { f: "gdrive.sheets_append_rows", a: ARGS });
      expect(r.kind, mapStyle).toBe("call");
    }
  });

  it("refuses to guess when two tools normalise identically", () => {
    // `a_b` and `a.b` both normalise to "ab", so NEITHER gets an alias — including
    // the real names themselves. That is the intended trade: a wrong dispatch is
    // far worse than a rejection, and the map code remains an unambiguous handle.
    const clash: Tool[] = [
      { name: "a_b", description: "x", inputSchema: { type: "object", properties: {} } },
      { name: "a.b", description: "y", inputSchema: { type: "object", properties: {} } },
    ];
    const k = compress(clash, { level: 3 });
    expect(k.resolve("t", { f: "ab", a: {} }).kind).toBe("error");
    expect(k.resolve("t", { f: "a_b", a: {} }).kind).toBe("error");
    // The code always works, which is why the map advertises codes.
    expect(k.resolve("t", { f: k.codeFor("a_b"), a: {} }).kind).toBe("call");
  });

  it("resolves an unambiguous real name, which codes-only lookup could not", () => {
    // A genuine improvement, not just tolerance: before this change `f` accepted
    // only a map code, so a model passing the real tool name always failed.
    const k = compress(TOOLS, { level: 3 });
    const r = k.resolve("t", { f: "gdrive_sheets_append_rows", a: ARGS });
    expect(r.kind).toBe("call");
    if (r.kind === "call") expect(r.name).toBe("gdrive_sheets_append_rows");
  });

  it("still rejects a genuinely unknown name, and points at the near miss", () => {
    const r = compress(TOOLS, { level: 3 }).resolve("t", { f: "gdrive.delete_everything", a: {} });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/No map code|Did you mean/);
  });
});

describe("the lookup tool routed through the dispatcher", () => {
  /**
   * Observed on grok-4.5 across every level-3 style including the shipped default:
   * t(f="q", a={s:"lost freight"}) instead of q(s="lost freight"). Our own preamble
   * invites it — "Invoke with t(f=<code>, a={…})" then "Use q to expand a code"
   * reads as everything going through t.
   */
  for (const mapStyle of ["name+required", "explicit", "signature"] as const) {
    it(`${mapStyle}: t(f="q") searches`, () => {
      const r = compress(TOOLS, { level: 3, mapStyle }).resolve("t", {
        f: "q",
        a: { s: "append" },
      });
      expect(r.kind).toBe("meta");
    });

    it(`${mapStyle}: t(f="q") expands`, () => {
      const k = compress(TOOLS, { level: 3, mapStyle });
      const r = k.resolve("t", { f: "q", a: { c: k.codeFor("coding_task_result") } });
      expect(r.kind).toBe("meta");
      if (r.kind === "meta") expect(r.result).toContain("coding_task_result");
    });
  }

  it("accepts the lookup args flat rather than nested under a", () => {
    const r = compress(TOOLS, { level: 3 }).resolve("t", { f: "q", s: "append" } as any);
    expect(r.kind).toBe("meta");
  });

  it("unwraps a dispatcher nested inside itself", () => {
    const k = compress(TOOLS, { level: 3 });
    const r = k.resolve("t", {
      f: "t",
      a: { f: k.codeFor("gdrive_sheets_append_rows"), a: ARGS },
    });
    expect(r.kind).toBe("call");
    if (r.kind === "call") expect(r.name).toBe("gdrive_sheets_append_rows");
  });

  it("does not disturb a normal dispatch", () => {
    const k = compress(TOOLS, { level: 3 });
    const r = k.resolve("t", { f: k.codeFor("gdrive_sheets_update_range"), a: ARGS });
    expect(r.kind).toBe("call");
    if (r.kind === "call") expect(r.name).toBe("gdrive_sheets_update_range");
  });

  it("still rejects a name that is neither a tool nor a meta-tool", () => {
    expect(compress(TOOLS, { level: 3 }).resolve("t", { f: "zzz", a: {} }).kind).toBe("error");
  });
});

describe("namespaceOf contract", () => {
  /**
   * Found by getting it wrong while benchmarking. It takes a name and returns
   * { ns, op }, but returning a bare namespace string is the natural mistake, and it
   * used to fail silently: every tool collapsed into one `undefined` namespace,
   * level 2 emitted a tool with an empty name, and the provider rejected the request
   * with an error pointing nowhere near the cause. At level 3 it was worse than an
   * error — the map filled with "undefined(...)" and still looked like a plausible
   * 37% improvement.
   */
  it("rejects a callback returning a bare string", () => {
    expect(() =>
      compress(TOOLS, { level: 2, namespaceOf: ((n: string) => "gdrive") as any }),
    ).toThrow(/must return \{ ns, op \}/);
  });

  it("names the offending tool and shows a correct example", () => {
    try {
      compress(TOOLS, { level: 2, namespaceOf: ((n: string) => "x") as any });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).toMatch(/coding_task_result|gdrive_sheets/);
      expect(e.message).toContain("ns: serverOf(name)");
    }
  });

  it("rejects an empty ns or op rather than emitting an unnamed tool", () => {
    expect(() =>
      compress(TOOLS, { level: 2, namespaceOf: (() => ({ ns: "", op: "x" })) as any }),
    ).toThrow(/non-empty strings/);
    expect(() =>
      compress(TOOLS, { level: 2, namespaceOf: (() => ({ ns: "a", op: "" })) as any }),
    ).toThrow(/non-empty strings/);
  });

  it("accepts a correct custom namespaceOf", () => {
    const k = compress(TOOLS, {
      level: 2,
      namespaceOf: (name: string) => ({ ns: name.split("_")[0], op: name }),
    });
    expect(k.tools.length).toBeGreaterThan(0);
  });
});
