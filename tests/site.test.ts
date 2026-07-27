/**
 * The GitHub Pages landing page must not disagree with the repository.
 *
 * The page's own footer promises this test exists, which is reason enough for it to. But
 * the real motive is that a marketing page is the furthest artifact from the code and the
 * one nobody re-audits: the figures on it were correct the day they were typed and have
 * no other reason to stay correct.
 *
 * Scope: assets resolve, and every headline number is traceable to the README, which is
 * itself guarded against RESULTS.md and the committed raw records.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { compress } from "../src/index.js";
import { REAL_TOOLS } from "../bench/fixtures/real.js";

const page = readFileSync("docs/index.html", "utf8");
const readme = readFileSync("README.md", "utf8");

describe("assets and links resolve", () => {
  it("every local asset the page references exists", () => {
    const missing: string[] = [];
    for (const m of page.matchAll(/(?:src|srcset|href)="(?!https?:|#|mailto:)([^"]+)"/g)) {
      if (!existsSync(`docs/${m[1]}`)) missing.push(m[1]);
    }
    expect(missing, `broken local references: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not link markdown files, which Pages serves as raw text", () => {
    const raw = [...page.matchAll(/href="(?!https?:)([^"]*\.md)"/g)].map((m) => m[1]);
    expect(raw, `link these to the GitHub blob view instead: ${raw.join(", ")}`).toEqual([]);
  });

  it("ships .nojekyll so Pages serves the directory verbatim", () => {
    expect(existsSync("docs/.nojekyll")).toBe(true);
  });

  it("both themes of every figure are present", () => {
    for (const m of page.matchAll(/img\/([a-z0-9-]+)-light\.svg/g)) {
      expect(existsSync(`docs/img/${m[1]}-dark.svg`), `${m[1]} has no dark variant`).toBe(true);
    }
  });
});

describe("headline figures trace back to the README", () => {
  /** Numbers that would embarrass us if they drifted, and their source of record. */
  const CLAIMS = [
    "30–70k", "~85%", "420", "3,283",
    "9,242", "1,284", "30,817", "4,628", "−85%",
    "6,421", "775", "17,522", "2,663",
    "5,264", "732", "10,948", "2,302", "−79%",
    "2,752", "573", "7,694", "2,196", "−71%",
    "68,536", "3,022", "95.6%", "552,795", "23,880", "95.7%",
    "60/60", "434", "~460",
  ];

  for (const c of CLAIMS) {
    it(`"${c}" also appears in the README`, () => {
      expect(page, `the page does not state ${c}`).toContain(c);
      expect(readme, `${c} is on the landing page but not in the README`).toContain(c);
    });
  }

  it("carries no figure the README has since corrected", () => {
    // 46.8% / 96.6% were measured against a baseline inflated by bench-only ns/op fields.
    for (const stale of ["46.8%", "96.6%", "13–39%"]) {
      expect(page, `stale figure ${stale} on the landing page`).not.toContain(stale);
    }
  });

  it("the level-1 and level-3 character figures match the library", () => {
    // The metaphor figure quotes these, so the page inherits them.
    const asClientGivesIt = (REAL_TOOLS as any[]).map((t) => ({
      name: t.name, description: t.description, input_schema: t.input_schema,
    }));
    for (const level of [1, 3] as const) {
      const pct = compress(asClientGivesIt as any, { level }).stats.savedPct.toFixed(1);
      expect(page, `page alt text should state level ${level} at ${pct}%`).toContain(`${pct}%`);
    }
  });
});

describe("it states the trade, not just the win", () => {
  it("names what levels 2-3 give up", () => {
    expect(page).toMatch(/no longer enforces your schema|constrained decoding/);
    expect(page).toContain("validate");
  });

  it("keeps a section for what the library does not do", () => {
    expect(page).toContain("What this does not do");
    // The four honesty claims that matter most.
    expect(page).toMatch(/only 7% on OpenAI/);
    expect(page).toMatch(/not been proven to improve accuracy/);
    expect(page).toMatch(/Haiku 4\.5/);
    expect(page).toMatch(/not lossless|It is not lossless/i);
  });
});
