/**
 * Limits on the paste-ready announcement bodies.
 *
 * Hacker News rejected a 4,454-character body with "Please limit text to 4000
 * characters. (This had 4496.)" — 42 more than the file contains, exactly the
 * number of newlines in it. The composer counts each line break as CRLF, so the
 * real budget is `characters + newlines`, and measuring the file the obvious way
 * understates it. That is the kind of detail that is annoying to rediscover while
 * mid-post, so it is asserted here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (name: string) =>
  readFileSync(new URL(`../docs/${name}`, import.meta.url), "utf8").replace(/\n$/, "");

/** What the platform counts: LF is submitted as CRLF, so each newline costs 2. */
const submitted = (text: string) => text.length + (text.match(/\n/g) ?? []).length;

describe("Hacker News body", () => {
  const text = read("ANNOUNCEMENT-hackernews.txt");

  it("fits the 4000-character limit as the composer counts it", () => {
    expect(submitted(text)).toBeLessThanOrEqual(4000);
  });

  it("keeps headroom, so a small edit does not push it over", () => {
    expect(submitted(text)).toBeLessThanOrEqual(3900);
  });

  it("has balanced asterisks", () => {
    // HN italicises *paired* asterisks. An odd count italicises everything from
    // the stray asterisk to the end of the post.
    expect((text.match(/\*/g) ?? []).length % 2).toBe(0);
  });

  it("keeps indented lines short enough not to force horizontal scroll", () => {
    // A 2-space indent is a monospace block on HN, and those do not wrap.
    for (const line of text.split("\n").filter((l) => /^ {2,}\S/.test(l))) {
      expect(line.length, `too wide for an HN code block: ${line}`).toBeLessThan(70);
    }
  });

  it("contains no markdown that HN would render literally", () => {
    for (const pattern of [/\*\*/, /`/, /^#{1,6}\s/m, /\[.+?\]\(.+?\)/, /^\|/m]) {
      expect(pattern.test(text), `renders literally on HN: ${pattern}`).toBe(false);
    }
  });
});

describe("LinkedIn body", () => {
  const text = read("ANNOUNCEMENT-linkedin.txt");

  it("fits the 3000-character limit", () => {
    expect(submitted(text)).toBeLessThanOrEqual(3000);
  });

  it("puts the hook inside the ~210-character truncation window", () => {
    // Past this, the reader sees "…see more" and scrolls on.
    expect(text.slice(0, 210)).toMatch(/tokens/);
  });

  it("contains no markdown at all — LinkedIn supports none", () => {
    for (const pattern of [/\*\*/, /`/, /^#{1,6}\s/m, /\[.+?\]\(.+?\)/, /^\s*[-*]\s/m]) {
      expect(pattern.test(text), `renders literally on LinkedIn: ${pattern}`).toBe(false);
    }
  });
});
