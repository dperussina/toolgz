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

## Status: both phases complete

**Phase 1 — the experiment: DONE.** 150 runs, Opus 5, $7.72. Results in `docs/RESULTS.md`,
raw data in `bench/results/*.jsonl`, aggregates in `brain.db`.

**Phase 2 — the library: DONE.** `src/`, 71 tests passing, clean typecheck, publish-ready
`package.json`.

Do not re-run the sweep to "check" it. The aggregates in `docs/RESULTS.md` have been
independently recomputed from the raw JSONL and reproduce exactly.

### What the experiment found

| Arm | Tool block | Avg prompt | Malformed args | Cost |
|---|---:|---:|---:|---:|
| `control` | 10,035 | 41,336 | 0 | $1.86 |
| `signatures` (L1) | 7,322 | 30,475 | 0 | $1.54 |
| `native` (Anthropic) | 1,644 | 16,430 | 0 | $2.19 |
| `hybrid` (L2) | 2,086 | 13,560 | 12 | $1.27 |
| `minified` (L3) | **1,146** | **7,432** | 2 | **$0.86** |

All arms: 48/48 tool calls correct, 0 hallucinated names, 150/150 tasks succeeded.

Four findings that should not be relitigated without new data:

1. **Name minification did not cost accuracy.** The central design worry — that `a3` instead
   of `github_search_issues` would destroy semantic retrieval — did not reproduce, even on
   clusters purpose-built to break it. The model converts recall into retrieval, spending
   ~1.7 lookups and ~0.6 extra turns. *One model, one catalogue — see the caveats.*
2. **Schema flattening (L1) is free.** −26% prompt tokens, zero malformed args, zero extra
   turns, latency slightly better than control. This is the default.
3. **L2 is dominated.** Worse than L3 on every axis, with 6× the malformed args. It stays in
   the API for callers who need real op names on the wire; it is not a stepping stone to L3.
4. **Native tool search costs more money than not compressing** ($2.19 vs $1.86) — server-side
   search runs its own billed inference. Tokens and dollars are separate axes. The library
   *composes* with native search rather than competing with it.

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
Zero runtime dependencies in the shipped package.

```bash
npm test          # 71 unit tests, no network
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
