# Benchmark results

**Model**: `claude-opus-5`, `output_config.effort: "high"`, `max_tokens: 8000`
**Total**: 150 runs across 10 scenarios · $7.72 · 2026-07-25
**Raw data**: `bench/results/*.jsonl` · **Reproduce**: `npm run bench`

Round 1 measured token savings across five workload shapes. Round 2 existed
only because round 1 could not discriminate on accuracy — every arm scored
100%, which is a failure of the instrument, not evidence of safety. Round 2
used tool clusters built specifically to break name minification.

---

## The arms

A factorial ladder, so each variable is attributable:

| Arm | L0 flatten | L1 defer | ns-collapse | minify |
|---|:-:|:-:|:-:|:-:|
| `control` | – | – | – | – |
| `signatures` | ✓ | – | – | – |
| `native` (Anthropic server-side search) | – | ✓ | – | – |
| `hybrid` | ✓ | ✓ | ✓ | – |
| `minified` | ✓ | ✓ | ✓ | ✓ |

---

## Combined — 150 runs

| Arm | Tool block | Avg prompt | Turns | Lookups | Correct | Hallucinated | Malformed | Latency | Cost |
|---|---:|---:|---:|---:|:-:|---:|---:|---:|---:|
| `control` | 10,035 | 41,336 | 3.5 | 0 | 48/48 | 0 | 0 | 15.4s | $1.86 |
| `signatures` | 7,322 | 30,475 | 3.5 | 0 | 48/48 | 0 | 0 | 14.4s | $1.54 |
| `native` | 1,644 | 16,430 | 3.1 | 0 | 48/48 | 0 | 0 | 16.2s | $2.19 |
| `hybrid` | 2,086 | 13,560 | 4.7 | 1.2 | 48/48 | 0 | **12** | 17.4s | $1.27 |
| **`minified`** | **1,146** | **7,432** | 4.1 | 1.7 | 48/48 | 0 | 2 | **12.9s** | **$0.86** |

Relative to `control`: `minified` is **−89% tool block, −82% prompt tokens,
−54% cost, −16% latency**, at equal accuracy.

---

## Round 1 — token savings by workload shape

5 scenarios × 5 arms × 2 reps, 50 runs, $3.61.

| Arm | Block | Prompt | Turns | Correct | Malformed | Latency | Cost |
|---|---:|---:|---:|:-:|---:|---:|---:|
| `control` | 11,620 | 58,950 | 4.1 | 28/28 | 0 | 14.8s | $0.82 |
| `signatures` | 8,455 | 42,517 | 4.1 | 28/28 | 0 | 15.2s | $0.68 |
| `native` | 1,577 | 23,843 | 4.3 | 28/28 | 0 | 18.3s | $1.08 |
| `hybrid` | 2,295 | 18,883 | 5.6 | 28/28 | 8 | 19.9s | $0.58 |
| `minified` | 1,278 | 12,512 | 5.4 | 28/28 | 2 | 14.9s | $0.45 |

Scenarios: `small-single` (10 tools, 1 call), `large-sparse` (100 tools, 2
calls), `large-dense` (100 tools, 6 calls), `near-duplicates` (20 confusable
tools), `deep-chain` (60 tools, 4 dependent calls).

The savings scale with tool count, as expected. At `large-sparse` — 100 tools,
2 calls, the best case — `minified` used 9,294 prompt tokens against
`control`'s 78,598, a 88% reduction.

---

## Round 2 — accuracy discrimination

5 confusable scenarios × 5 arms × 4 reps, 100 runs, $4.11.

Scenarios were built to break minification specifically: 30-tool clusters where
several tools share a shape and the correct choice turns on the *name*.

- `acc-search-vs-list` — cross-repo query must pick `search_issues`, not `list_issues`
- `acc-comment-vs-update` — adding a note must not mutate the issue body
- `acc-cross-product` — GitHub / Jira / Linear tools side by side; only Linear is correct
- `acc-review-vs-merge` — approve is `create_review(APPROVE)`, not `merge_pull_request`
- `acc-haystack` — the same distinction buried in the full 100-tool catalogue

| Arm | Block | Prompt | Turns | Lookups | Correct | Hallucinated | Malformed | Latency | Cost |
|---|---:|---:|---:|---:|:-:|---:|---:|---:|---:|
| `control` | 9,242 | 32,529 | 3.3 | 0 | 20/20 | 0 | 0 | 15.7s | $1.04 |
| `signatures` | 6,755 | 24,454 | 3.3 | 0 | 20/20 | 0 | 0 | 14.0s | $0.86 |
| `native` | 1,677 | 12,724 | 2.5 | 0 | 20/20 | 0 | 0 | 15.2s | $1.11 |
| `hybrid` | 1,982 | 10,899 | 4.2 | 1.5 | 20/20 | 0 | 4 | 16.1s | $0.69 |
| `minified` | 1,080 | 4,891 | 3.5 | 1.2 | 20/20 | 0 | 0 | 11.9s | $0.41 |

**Minified scored 20/20 with zero hallucinated names and zero malformed
arguments.** It resolved the ambiguity by using its lookup tool 1.2 times per
task — the recovery path did the work the name would otherwise have done.

---

## Findings

### 1. Name minification did not cost accuracy — the design's central worry was wrong

The stated risk was that replacing `github_search_issues` with `a3` would
destroy the model's semantic retrieval index. Across 150 runs including
purpose-built confusable clusters: 48/48 correct, 0 hallucinated names.

The mechanism appears to be the lookup tool. `minified` averaged 1.7 lookups
per task where `signatures` needed none. The model does not lose the ability to
choose correctly; it converts a recall problem into a retrieval problem and
pays roughly 0.6 extra turns for it.

**Caveat, and it matters**: this is one model (Opus 5), one fixture catalogue,
150 runs. Level 3 remains the level to benchmark against your own tasks before
adopting. Weaker models may not recover as gracefully.

### 2. Schema flattening is free

`signatures` cut prompt tokens 26% with zero malformed arguments, zero extra
turns, zero lookups, and latency slightly *better* than control. There is no
measured downside. This is the correct default.

Worth being precise about where the saving comes from: the tool *name* is
about 5 tokens. The JSON Schema envelope — per-property `description` strings,
`additionalProperties`, `$schema` — is the other 400.

### 3. Level 2 is dominated and should not be used

`hybrid` lost to `minified` on every axis:

| | hybrid | minified |
|---|---:|---:|
| prompt tokens | 13,560 | 7,432 |
| malformed args | **12** | 2 |
| latency | 17.4s | 12.9s |
| cost | $1.27 | $0.86 |

Six times the malformed arguments for worse compression. Semantic op names on a
generic dispatcher bought nothing measurable — once you accept a dispatcher you
have already paid the constrained-decoding cost, so keeping readable op names
only adds tokens. Level 2 stays in the API for callers who need real operation
names on the wire; it is not a stepping stone to level 3.

### 4. Malformed arguments are real, and they are a dispatcher cost

`control`, `signatures` and `native` produced **zero** malformed arguments.
`hybrid` and `minified` produced all 14 between them. This confirms the
mechanism predicted up front: routing calls through a generic `object` argument
bag removes the provider's constrained sampler from the loop.

Every one was caught by middleware validation and recovered on retry, which is
why task accuracy stayed at 100% — but the retries are part of why the
dispatcher arms use more turns.

### 5. Anthropic's native tool search costs more money than not compressing

`native` had the second-smallest tool block (1,644) and the **highest total
cost of any arm** — $2.19, above uncompressed $1.86. Server-side search runs
its own inference, billed to you.

Tokens and dollars are separate axes. If the goal is context-window occupancy,
native search is excellent. If the goal is spend, it is the worst option
measured.

This also settles the product question: the library does not compete with
native search, it composes with it (native defers whole schemas; the library
shrinks each one) and it works on providers that have no equivalent.

---

## What these numbers do not establish

- **One model.** Opus 5 only. Weaker models are likely to recover less well
  from minified codes; that is the untested risk.
- **One catalogue.** 100 synthetic-but-realistic MCP-style tools across 9
  namespaces. Real tool sets with worse names or deeply nested schemas may
  behave differently.
- **Statistical power.** 2–4 reps per cell. Enough to see an 82% token
  difference; not enough to resolve a 2% accuracy difference. A 100%-vs-100%
  result rules out a *large* accuracy penalty, not a small one.
- **Latency measured against a live API** with ordinary variance. Treat the
  latency column as directional.
- **No long-session scenario ran.** Cumulative occupancy over 30+ turns —
  where the product claim is strongest — is still unmeasured.

## Next experiments

1. Sonnet 5 and Haiku 4.5 — does level 3 hold on cheaper models?
2. The `long-session` scenario (30+ turns) that round 1 dropped for cost.
3. Level 1 + `defer_loading` composed, versus each alone.
4. A real MCP catalogue rather than the synthetic fixture.
