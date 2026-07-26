# AGENTS.md — ToolCompression

Operating instructions for AI agents working in this repo. Read before touching code.

---

## What this is

A **library**, not an app. It compresses LLM tool definitions so agents burn less context
window per turn. Model- and framework-agnostic: consumers pass in tool schemas, get back a
compact wire representation plus a bidirectional translator.

There is no server, no daemon, no CLI product. The deliverable is an installable package with
a small stable API and documentation.

**The problem is context-window occupancy, not cost.** Tool definitions sit at the front of
the prompt and are cache-eligible, so caching already handles most of the *cost*. It does not
reclaim the 30–50k tokens a large MCP tool set eats before the user types a word. That
reclamation is the product.

---

## Status: shipped, and still being measured

Published as `toolgz` on npm — 0.2.0 at the time of writing. 245 tests, clean typecheck,
zero runtime dependencies.

Six benchmark rounds so far; `docs/RESULTS.md` is the evidence log and the only place
figures live. **Do not restate a number in another document** — that is how the README
came to advertise level 3's savings beside a level-1 code example. Link to RESULTS
instead.

Do not re-run an old sweep to "check" it. Every figure is recomputable from the
committed JSONL with `npx tsx bench/analyze-multi.ts --sweep=<timestamp>`.

### What the experiment found

Headline results live in `docs/RESULTS.md` and are deliberately not duplicated here.
The four findings that should not be relitigated without new data:

1. **Name minification did not cost accuracy.** The central worry — that `a3` instead of
   `github_search_issues` would destroy semantic retrieval — did not reproduce, even on
   clusters purpose-built to break it. The model converts recall into retrieval.
2. **Level 1 is free**: fewer tokens, zero malformed arguments, zero extra turns. It is
   the default, and it saves 13–32%. The 71–85% figures are level 3.
3. **Level 2 is dominated by level 3** on every axis, with more malformed arguments.
4. **Turns dominate map size.** One extra turn is worth ~3,300 prompt tokens; the best
   encoding change available was worth ~550. Six map styles were tried and removed in
   0.2.0 because they were smaller and still worse.

### What is still unmeasured

Do not write these as if they were established:

- **Only Opus 5.** Weaker models are the untested risk for L3 — they may not recover from
  minified codes as gracefully.
- **No long-session scenario.** Cumulative occupancy over 30+ turns, where the product claim
  is strongest, was dropped from round 1 for cost.
- **Statistical power.** 2–4 reps per cell. Enough to see an 82% token gap; not enough to
  resolve a 2% accuracy difference. 100%-vs-100% rules out a *large* penalty, not a small one.
- **Synthetic catalogue.** 100 realistic-but-invented MCP-style tools across 9 namespaces.

---

## Layout

```
src/            the library — no network calls, no runtime deps
  render/       schema flattening, signature lines
  runtime/      argument validation on the decompress path
  providers/    forAnthropic / forOpenAI / forGemini adapters
  recommend.ts  level recommendation from a tool set
bench/          the experiment — network lives here, never in src/
  fixtures/     the 100-tool catalogue
  strategies/   the five arms
  harness/      the runner
  results/      raw JSONL, immutable — never edit or regenerate in place
brain/          SQLite brain (schema.sql, brain.ts) → brain.db
specs/          Spec Kit specs; source of truth when spec and code disagree
docs/RESULTS.md the experiment write-up
docs/           guide, results, generated before/after, constitution
```

---

## Non-negotiables

Full text in `docs/CONSTITUTION.md`. The load-bearing ones:

- **Never break the prompt cache.** Tool definitions render first; any byte change invalidates
  everything after. Sorted keys, stable ordering, no `Date.now()`, no `Math.random()`, no
  locale-dependent formatting in output. A compiler emitting non-deterministic bytes is a
  defect, not a style question. The byte-stability test does not get deleted.
- **Round-trip fidelity is the core invariant.** `decompress(compress(x)) === x` for every tool
  in the corpus.
- **Validate compressed args against the real schema before dispatch.** Dispatcher-based levels
  (L2/L3) lose provider-side constrained decoding — the library replaces that guarantee rather
  than dropping it. This is exactly where the 14 malformed args were caught.
- **Errors must be intelligible to the model.** An unknown name must point at the lookup tool.
- **No silent truncation.** A dropped field, enum, or constraint is surfaced, never discarded.
- **`src/` makes no network calls.** A `fetch` in `src/` is a defect. Network belongs to `bench/`.
- **Never estimate tokens.** Use `messages.count_tokens`. `tiktoken` is OpenAI's tokenizer and
  is wrong for Claude by 15–20%+.
- **Raw results are immutable.** `bench/results/*.jsonl` is evidence. Add new files; never
  rewrite old ones.

---

## Methodology

- **Spec Kit** — a feature gets a spec in `specs/` before it gets code. Spec wins over code
  when they disagree. Spec Kit tooling is not committed — regenerate with `specify init --here` if you want the slash commands.
- **SQLite brain** (`brain.db`) — durable cross-session memory: tasks, decisions *and their
  rationale*, sweeps, per-run results. Query it before asking "what did we decide about X?".
  Tables: `tasks`, `decisions`, `sweeps`, `sweep_results`; views `v_arm_summary`, `v_open_tasks`.
- **TDD** — test first, red → green → refactor. Applies to `src/`, not throwaway bench scaffolding.

---

## Stack

TypeScript / Node 22+, ESM. `tsx` to run, `vitest` to test, `tsc` to build.

### Zero dependencies is a hard constraint, not a preference

The shipped package imports **nothing outside the Node standard library**. No
runtime dependencies, and no native addon. `tests/packaging.test.ts` enforces it:
a declared runtime dependency must be one `src/` actually imports, and today that
set is empty.

Dev-only tooling (`vitest`, `tsx`, provider SDKs for the benchmark) is fine —
those live in `devDependencies` and are not published. The line is `src/`.

**No Rust / native layer.** It was considered and rejected on measurement, not
taste:

- Compression here is string building. There is no hot loop to optimise.
- Measured against `@atlassian/mcp-compressor`, which does use a Rust core: plain
  JS **0.097ms** vs their **0.376ms**. We are ~4x faster *without* Rust, because
  compute was never the bottleneck.
- The cost is not hypothetical. Their native payload is **80MB** across five
  prebuilt `.node` binaries, delivered via the deprecated `prebuild-install`. Our
  whole package is **23.7kB**.

A native addon would trade a real, verifiable differentiator for a speedup nobody
can perceive behind a multi-second LLM round trip.

**Where a dependency will be tempting:** local tokenization. Optimising the map
encoding for a tokenizer wants a tokenizer, and `tiktoken` et al are native. Keep
that work in `bench/` as a devDependency, or use the providers' `count_tokens`
endpoints. It must never reach `src/`.

### Escalate through the tiers; never skip to tier 3

```bash
npm run bench:tier1   # 4 hardest scenarios x 1 rep x 4 providers  ~$3   kills broken ideas
npm run bench:tier2   # 6 scenarios x 2 reps x 4 providers         ~$8   kills marginal ones
npm run bench:tier3   # all 12 scenarios x 3 reps x 4 providers    ~$25  promotes a default
```

**Cut scenarios, cut reps, never cut providers.** Every failure found so far has been
provider-specific and unpredictable by reasoning: bare names died only on grok-4.5,
`grouped` died only on gpt-5.6-sol. A cheap single-provider screen is how you ship a
broken default; all four providers on four scenarios costs a few dollars and catches
it in the first reps.

These exist as scripts because the rule was written down as a decision and then
broken the same day, by launching a 384-run tier-3 sweep containing a brand-new,
behaviourally untested map style. A guideline you have to remember is not a control.

```bash
npm test          # unit tests, no network
npm run build     # tsc → dist/ with .d.ts
npm run bench     # the sweep — COSTS MONEY, ~$4-8 per full run
npm run brain     # brain CLI
npm run test:live # integration tests, hits the API
```

`npm run bench` spends real money. Do not run it to verify a refactor; `npm test` is the
fast path.

---

## Model configuration

Primary: **`claude-opus-5`** ($5/$25 per MTok, 1M context).

- Thinking is **on by default** — omitting `thinking` runs adaptive. `max_tokens` caps
  thinking *plus* response text; size with headroom.
- Do **not** send `temperature` / `top_p` / `top_k` — removed on Opus 5, returns 400.
- Do **not** send `budget_tokens` — removed, returns 400. Use `output_config.effort`.
- Pin `effort` to the **same value across all arms**. Varying it invalidates any comparison.
- Handle `stop_reason: "refusal"` before reading `content`.
- Exact model ID strings only. Never append date suffixes.

Credentials in `.env` (git-ignored): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`XAI_API_KEY`. **Never commit, echo, log, or print a key value.**
