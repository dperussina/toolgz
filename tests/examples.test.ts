/**
 * Drift guard for docs/BEFORE-AFTER.md.
 *
 * That file claims every block in it is produced by the real library. This
 * suite proves it: the exact serialisations `compress()` and `resolve()` return
 * today must appear verbatim in the committed doc. If someone changes rendering
 * and forgets to regenerate, this fails.
 *
 * Offline — no API calls. The doc's token counts come from a live endpoint and
 * are not asserted here; the structural content is what must not drift.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compress } from "../src/index.js";
import { DEMO_TOOLS } from "../docs/generate-examples.js";

const DOC = readFileSync(
  new URL("../docs/BEFORE-AFTER.md", import.meta.url).pathname,
  "utf8",
);
const SYSTEM = "You are an operations agent. Use the tools available to you.";
const j = (v: unknown) => JSON.stringify(v, null, 2);
const REGEN = "Regenerate with `npx tsx docs/generate-examples.ts`.";

describe("docs/BEFORE-AFTER.md is generated from the real library", () => {
  it("contains the uncompressed input verbatim", () => {
    const before = DEMO_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
    expect(DOC, REGEN).toContain(j(before));
  });

  it.each([1, 2, 3] as const)("contains level %i's tools array verbatim", (level) => {
    expect(DOC, REGEN).toContain(j(compress(DEMO_TOOLS, { level }).tools));
  });

  it("contains the level-3 system prompt verbatim, map included", () => {
    const c = compress(DEMO_TOOLS, { level: 3 });
    expect(c.systemPreamble).not.toBe("");
    expect(DOC, REGEN).toContain(`${SYSTEM}\n\n${c.systemPreamble}`);
  });

  it("states that levels 1 and 2 leave the system prompt alone", () => {
    for (const level of [1, 2] as const) {
      expect(compress(DEMO_TOOLS, { level }).systemPreamble).toBe("");
    }
    expect(DOC).toMatch(/Unchanged:/);
  });

  it.each([1, 2, 3] as const)("contains level %i's round trip verbatim", (level) => {
    const c = compress(DEMO_TOOLS, { level });
    const args = { owner: "acme", repo: "web", title: "Retry logic drops errors" };
    const raw = c.encodeCallForTest("github_create_issue", args);
    expect(DOC, REGEN).toContain(j(raw));
    expect(DOC, REGEN).toContain(j(c.resolve(raw.name, raw.args)));
  });

  it("contains the real recovery-path outputs verbatim", () => {
    const c = compress(DEMO_TOOLS, { level: 3 });
    const cases = [
      c.resolve("t", { f: c.codeFor("github_create_issue"), a: { owner: "acme" } }),
      c.resolve("t", { f: "zz9", a: {} }),
      c.resolve("q", { c: c.codeFor("github_search_issues") }),
      c.resolve("q", { s: "slack" }),
    ];
    for (const r of cases) expect(DOC, REGEN).toContain(j(r));
  });

  it("shows both of the two things the library modifies", () => {
    expect(DOC).toMatch(/### Tools array/);
    expect(DOC).toMatch(/### System prompt/);
  });
});
