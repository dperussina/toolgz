# Benchmark results

**Models**: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`
**Settings**: `effort: "high"` (Opus/Sonnet; Haiku rejects it), `max_tokens: 8000`
**Total**: 250 runs · $8.03 · 2026-07-25
**Raw data**: `bench/results/*.jsonl` (committed) · **Verify**: `npx tsx bench/analyze.ts`
**Reproduce**: `npm run bench -- --accuracy --reps=2 --model=<id>` *(costs money)*

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

## Round 3 — does it hold on cheaper models?

Round 2 named weaker models as the single biggest untested risk for level 3.
The same five accuracy scenarios were re-run on Sonnet 5 and Haiku 4.5 —
identical fixtures, identical arms, 2 reps — so the only variable is the model.
100 additional runs, $0.31.

`effort` is pinned to `high` on Opus 5 and Sonnet 5. **Haiku 4.5 rejects
`output_config.effort` with a 400, so it runs unpinned.** That is a real
configuration difference between the Haiku column and the other two; treat
cross-model absolute numbers as indicative, and compare *arms within a model*.

| Model | Arm | Prompt | Correct | Tasks OK | Malformed |
|---|---|---:|:-:|:-:|---:|
| Opus 5 | `control` | 32,529 | 20/20 | 20/20 | 0 |
| Opus 5 | `signatures` | 24,454 | 20/20 | 20/20 | 0 |
| Opus 5 | `native` | 12,724 | 20/20 | 20/20 | 0 |
| Opus 5 | `minified` | 4,891 | 20/20 | 20/20 | 0 |
| Sonnet 5 | `control` | 23,121 | 10/10 | 10/10 | 0 |
| Sonnet 5 | `signatures` | 15,100 | 10/10 | 10/10 | 0 |
| Sonnet 5 | `native` | 8,839 | 10/10 | 10/10 | 0 |
| Sonnet 5 | `minified` | 4,708 | 10/10 | 10/10 | 3 |
| Haiku 4.5 | `control` | 15,604 | 10/10 | 10/10 | 0 |
| Haiku 4.5 | `signatures` | 11,480 | 10/10 | 10/10 | 0 |
| Haiku 4.5 | `native` | 2,764 | **2/10** | **2/10** | 1 |
| Haiku 4.5 | `minified` | 4,713 | 10/10 | 10/10 | 6 |

### Level 3 held on every model tested

40/40 correct calls across three model tiers, zero hallucinated codes. The
predicted failure — a small model unable to work a minified code map — did not
appear even on Haiku 4.5.

The cost of a weaker model shows up as **malformed arguments, not wrong tools**:
0 → 3 → 6 for `minified` as the model gets weaker. Every one was caught by
schema validation and recovered on retry. This is the dispatcher trade behaving
exactly as designed, and it is why the validation layer is not optional.

### Native tool search failed on Haiku 4.5 — silently

`native` completed **2 of 10 tasks**. On four of five scenarios it ran a single
turn, made zero tool calls, and answered from nothing — ~1,780 prompt tokens,
meaning no tool schemas were ever loaded.

The mechanism: `defer_loading` hides tools until the model *chooses* to search.
Haiku 4.5 frequently does not choose to. There is no error — the request
succeeds, the model replies, and the reply is unaided. A silent wrong answer is
a worse failure mode than a loud one.

The library's dispatcher does not have this failure mode, and the reason is
structural rather than incidental: `t` (dispatch) and `q` (lookup) are ordinary,
always-visible tools. The model cannot forget to search, because searching is
the only thing available. Deferred loading makes discovery *optional*; a
dispatcher makes it *the entry point*.

This is the strongest argument for the library on Anthropic specifically, and it
only appears below the frontier tier — at Opus 5, `native` scored a clean 20/20.

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

**Round 3 tested this on two cheaper models and it held** — 40/40 across Opus 5,
Sonnet 5 and Haiku 4.5, zero hallucinated codes. What degrades with model
strength is argument formatting, not tool choice (see round 3).

**Caveat, and it matters**: one fixture catalogue, three models from a single
family. Level 3 remains the level to benchmark against your own tasks before
adopting, and a non-Claude model is still untested.

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

**Round 3 added a second, sharper caveat**: native search also depends on the
model electing to search. On Haiku 4.5 it completed 2/10 tasks, silently. Native
search is an excellent context-occupancy tool on frontier models and a liability
below that tier.

---

## What these numbers do not establish

- **One model family.** Opus 5, Sonnet 5 and Haiku 4.5 — all Claude. No
  GPT/Gemini/Grok data, so the model-agnostic claim rests on the design being
  provider-neutral, not on measurement.
- **Haiku ran without an effort pin** (the API rejects `effort` on it), so that
  column differs from the others by more than the model.
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

1. ~~Sonnet 5 and Haiku 4.5 — does level 3 hold on cheaper models?~~ **Done
   (round 3): yes, 40/40.**
2. A non-Claude model (GPT/Gemini), which would be the first real test of the
   model-agnostic claim.
3. The `long-session` scenario (30+ turns) that round 1 dropped for cost — the
   product's strongest claim is still its least-measured one.
4. Level 1 + `defer_loading` composed, versus each alone.
5. A real MCP catalogue rather than the synthetic fixture.
6. More reps on the Haiku `native` result. 2/10 across 5 scenarios is a large
   effect and unlikely to be noise, but it rests on 10 runs.
