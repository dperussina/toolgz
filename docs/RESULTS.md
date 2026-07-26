# Benchmark results

**Rounds 1–3** — Anthropic only: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`
**Round 4** — cross-provider: `claude-opus-5`, `gpt-5.6-sol`, `gemini-3.1-pro-preview`, `grok-4.5`
**Settings**: reasoning at high effort on every model that supports it, `max_tokens: 8000`
**Round 5** — same four providers, after hardening the resolver from observed failures
**Total**: 1,212 runs across rounds 1–5 · ~$32 · 2026-07-25
*(plus 458 superseded runs, $13.88 — see `bench/results/superseded/`)*
**Raw data**: `bench/results/*.jsonl`, committed · **Verify**: `npx tsx bench/analyze.ts` (rounds 1–3), `npx tsx bench/analyze-multi.ts` (round 4)
**Reproduce**: `npx tsx bench/harness/run-multi.ts --provider=all --reps=3 --variants` *(costs money)*

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

## Combined — Opus 5, rounds 1 + 2 (150 runs)

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
The same five accuracy scenarios were re-run on Sonnet 5 (2 reps) and Haiku 4.5
(6 reps) — identical fixtures, identical arms — so the only variable is the
model. 200 additional runs, $1.46.

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
| Haiku 4.5 | `control` | 15,217 | 30/30 | 30/30 | 0 |
| Haiku 4.5 | `signatures` | 11,482 | 30/30 | 30/30 | 0 |
| Haiku 4.5 | `native` | 2,906 | **6/30** | **6/30** | 1 |
| Haiku 4.5 | `minified` | 4,578 | 30/30 | 30/30 | 17 |

### Level 3 held on every model tested

60/60 correct calls across three model tiers, zero hallucinated codes. The
predicted failure — a small model unable to work a minified code map — did not
appear even on Haiku 4.5.

The cost of a weaker model shows up as **malformed arguments, not wrong tools**.
On Haiku, `minified` produced 17 malformed arguments across 30 runs — roughly
one every other run, against 3-in-10 on Sonnet and 0 on Opus. **All 30 tasks
still completed**, because every malformed call was caught by schema validation
and recovered on retry.

That is the dispatcher trade behaving exactly as designed, and it makes the
validation layer load-bearing rather than defensive: on a weak model, disabling
it would convert roughly half of all runs from "retried once" into "dispatched
garbage."

### Native tool search failed on Haiku 4.5 — silently

`native` completed **6 of 30 tasks** — a 20% success rate that held exactly
across an initial 10 runs and a 30-run confirmation. On four of five scenarios
it ran a single turn, made zero tool calls, and answered from nothing — ~1,780
prompt tokens, meaning no tool schemas were ever loaded.

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

## Round 4 — all four providers, adapters verified against current docs

Rounds 1–3 were Anthropic only. Round 4 runs the same five accuracy scenarios on four
frontier models, 6 arms × 3 reps each: **360 runs, $10.56**.

### The adapters had to be fixed first, and this invalidated earlier data

Before publishing a cross-provider claim, each adapter was checked against current
official documentation. All three non-Anthropic adapters were wrong, in ways that
mattered:

| Provider | Defect | Consequence |
|---|---|---|
| OpenAI | Forced `reasoning_effort: "none"` because `/v1/chat/completions` rejects tools + reasoning | The arm was not a frontier test at all. Migrated to `/v1/responses`, reasoning at `high`. |
| Google | Sanitiser stripped JSON Schema keywords (`additionalProperties`, `$schema`, `$defs`, `const`, `oneOf`, …) that the Interactions API **accepts** | Measured a schema the library never emits — a correctness bug in the numbers. Migrated to the Interactions API, thinking at `high`. |
| xAI | `reasoning_effort` never set; docs contradict themselves on whether it is supported | Resolved empirically (it is honoured; default is already `high`); now pinned explicitly. |

A measurement flaw of our own was also fixed: cached input was billing at full input
price, overstating cost for providers that cache aggressively. `Provider.priceCachedIn`
now carries the discount.

The pre-fix cross-provider results are in `bench/results/superseded/` and must not be
cited.

### Results

| Provider | Model | Tool block | Prompt tokens | Tasks | Malformed | Latency | Cost |
|---|---|---:|---:|:-:|---:|---:|---:|
| Anthropic | `claude-opus-5` | 9,242 → 1,284 | 32,513 → 5,850 (−82%) | 15/15 | 4 | 14.2s → 13.7s | −76% |
| Google | `gemini-3.1-pro-preview` | 5,264 → 732 | 10,948 → 2,182 (−80%) | 15/15 | 0 | 6.1s → 5.3s | −62% |
| xAI | `grok-4.5` | 6,421 → 775 | 15,201 → 2,988 (−80%) | 15/15 | 1 | 5.6s → 12.8s | −60% |
| OpenAI | `gpt-5.6-sol` | 2,752 → 573 | 7,492 → 2,338 (−69%) | 15/15 | 0 | 6.1s → 6.2s | **+15%** |

Arm shown is level 3 at the shipped default (`mapStyle: "name+required"`) against
uncompressed. Token and dollar magnitudes are **not** comparable across providers —
different tokenizers, different prices. Compare arms within a provider.

### Level 3 wins on every provider

Ordering by prompt tokens is stable in the sense that matters: the level-3 variants beat
level 2, which beats level 1, which beats uncompressed, on all four. The exact ordering
*among* level-3 map styles differs by provider, which is why `analyze-multi.ts` reports
ranking stability rather than averaging it away.

### Bare names fail on grok-4.5 — deterministically

`mapStyle: "name"` scored **57/60** overall: perfect on Anthropic, Google and OpenAI, and
**12/15 on grok-4.5**. The failures were not noise. All three were the same scenario
(`acc-cross-product`), all with `turns=1`, zero tool calls, zero malformed arguments — the
model read the map and answered without dispatching. No error was raised.

`name+required` and `terse` both scored **60/60**. The default is `name+required`, because
it also cut lookup round-trips (0.1–0.7 per task vs 0.4–1.4) and was the fastest or
near-fastest arm on three of four providers.

This is the same failure shape as `defer_loading` on Haiku 4.5 (round 3): when discovery is
*optional*, a model can decline to discover. A bare-name map makes dispatch feel optional in
the same way; naming the arguments makes it concrete.

### Context is reclaimed; money is not

Prompt tokens fell on all four. Cost fell on three and **rose 15% on OpenAI** — the extra
dispatcher turns cost more in reasoning tokens than the smaller prompt recovers.

This is the sharpest correction round 4 makes to the earlier rounds, which measured cost
savings with reasoning effectively off on some arms. **The defensible claim is
context-window occupancy, not spend.** Anyone optimising for bill should measure their own
workload.

### One anomaly, not explained

`minified-plus` on grok-4.5 averaged **12.8s against 5.6s uncompressed** — the only
latency regression anywhere in the sweep, and it contradicts the same arm being fastest on
Anthropic and Google. n=15, so it may be sampling noise or provider-side variance. It is
recorded rather than smoothed over, and wants more reps before anyone relies on
level-3 latency on xAI.

---

## Round 5 — fix what round 4 exposed, then re-measure

Round 4 left two problems: cost **rose 15% on OpenAI**, and malformed arguments
persisted (4 on Anthropic, 1 on xAI for the shipped default). Rather than guess at
causes, the harness was changed to record the rejected calls themselves — the raw
tool name, the arguments the model sent, and the validation message.

### What the diagnostics showed

18 captured rejections, and every root cause was in **this library**, not the models:

| Cause | Share | Fix |
|---|---|---|
| Model passes `query` to a parameter named `q` | 14/18 | Errors now name the likely rename via nearest-name matching. Not auto-remapped — guessing at intent could dispatch wrong data. |
| Model calls the map code *as* the tool name (`b5` instead of `t(f="b5")`) | 1/18 | Accepted. Codes are unique and cannot collide with `t`/`q`, so the form is unambiguous. |
| Model invents a parameter (`per_page` on a tool without it) | 1/18 | Genuinely the model's error; message now surfaces the nearest accepted name. |
| Arguments sent flat rather than nested under `a` | — | Accepted, preferring `a` when both are present. |

Enum case drift (`approve` for `APPROVE`) now shows the exact accepted spelling.

A fourth map style, `signature`
(`a0 github_create_issue(owner,repo,title,body?,labels?)`), was added to test
whether removing `q()` lookups entirely would pay for a larger cached map.

### Results — 420 runs, 7 arms

Shipped default (`mapStyle: "name+required"`) against uncompressed:

| Provider | Tool block | Prompt | Cost | Latency | Tasks | Malformed |
|---|---:|---:|---:|---:|:-:|---:|
| Anthropic | 9,242 → 1,284 | 30,817 → 4,628 (−85%) | −78% | 15.0s → 12.1s | 15/15 | 0 |
| xAI | 6,421 → 775 | 17,522 → 2,663 (−85%) | −70% | 6.1s → 4.6s | 15/15 | 0 |
| Google | 5,264 → 732 | 10,948 → 2,302 (−79%) | −62% | 5.6s → 5.5s | 15/15 | 0 |
| OpenAI | 2,752 → 573 | 7,694 → 2,196 (−71%) | −7% | 6.8s → 5.6s | 15/15 | 0 |

### What changed against round 4

| | Round 4 | Round 5 |
|---|---|---|
| OpenAI cost vs uncompressed | **+15%** | **−7%** |
| Anthropic malformed arguments | 4 | **0** |
| xAI malformed arguments | 1 | **0** |
| xAI latency | 12.8s vs 6.1s baseline | **4.6s** |
| Prompt reduction (worst provider) | −69% | −71% |

Three things worth stating precisely:

**The OpenAI cost fix came from turns, not tokens.** Prompt size barely moved
(−69% → −71%); what changed is that the resolver stopped rejecting recoverable
calls. Each rejection had cost a turn, and each turn cost a fresh round of
reasoning. This is why the round-4 framing — "context is reclaimed, money is not"
— was too pessimistic: some of that cost was our bug, not an inherent trade.

**The xAI latency anomaly was noise.** Round 4 recorded 12.8s against a 5.6s
baseline and offered no explanation. Round 5 shows 4.6s, faster than
uncompressed. Recording it rather than smoothing it over was right, and so was
declining to explain it.

**The default is now the best arm on every provider.** `name+required` has the
smallest prompt on all four, a perfect task rate, and zero malformed arguments.
Bare names remain the only style that has ever failed (14/15 on grok-4.5).

### `signature`: better on OpenAI, worse on xAI

| Provider | default cost | `signature` cost | default latency | `signature` latency |
|---|---:|---:|---:|---:|
| OpenAI | −7% | **−17%** | 5.6s | **4.0s** |
| Google | −62% | −59% | 5.5s | **4.8s** |
| Anthropic | −78% | −76% | 12.1s | **11.2s** |
| xAI | −70% | −47% | 4.6s | 7.4s |

It drives lookups to zero everywhere and is fastest on three of four, but the
larger map costs xAI badly (−72% prompt reduction against the default's −85%).
So it ships as an option, not the default — reach for it on latency- or
turn-sensitive workloads and measure.

### Honest note on the totals

Malformed arguments across *all seven arms* went 29 → 30, essentially unchanged.
The fixes drove the **shipped default** to zero on every provider, and the arms
that still produce errors (`hybrid`, bare-name `minified`, `terse`) are the ones
we do not recommend. Reporting only the default's improvement without this would
overstate what changed.

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

**Round 3 tested this on two cheaper models and it held** — 60/60 across Opus 5,
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
model electing to search. On Haiku 4.5 it completed 6/30 tasks, silently. Native
search is an excellent context-occupancy tool on frontier models and a liability
below that tier.

---

## What these numbers do not establish

- ~~**One model family.**~~ Round 4 added `gpt-5.6-sol`, `gemini-3.1-pro-preview`
  and `grok-4.5`, so the model-agnostic claim is now measured rather than
  asserted. Still four vendors, one language, one synthetic catalogue.
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
   (round 3): yes, 60/60.**
2. ~~A non-Claude model.~~ **Done (round 4).**
3. The `long-session` scenario (30+ turns) that round 1 dropped for cost — the
   product's strongest claim is still its least-measured one.
7. More reps on level-3 latency on grok-4.5, where one arm regressed to 12.8s
   against a 5.6s baseline with no explanation.
8. Cost on OpenAI: whether the +15% closes at lower reasoning effort, since the
   extra turns are what drive it.
4. Level 1 + `defer_loading` composed, versus each alone.
5. A real MCP catalogue rather than the synthetic fixture.
6. ~~More reps on the Haiku `native` result.~~ **Done: 6/30, the 20% rate
   reproduced exactly at 3× the sample.**

---

## Claims not to make

Guard-rails for anyone else writing about this:

- ❌ "80% cheaper" — it is not. The claim is **context-window occupancy**.
- ❌ **Any cost saving on OpenAI.** Verified against sweep `2026-07-25T19-19`: the
  uncompressed distribution there is heavily right-skewed (mean $0.0172, median
  $0.0052), so the `−7%` we used to publish was a mean artifact. By median,
  compression is ~2.5× *dearer* on `gpt-5.6-sol`. The token and latency wins are real;
  the cost win is not. Decision #29.
- ❌ **Any cost figure averaged across providers.** An Anthropic run costs ~10× a
  Gemini/OpenAI/xAI run on this suite, so the mean reports Anthropic and little else.
  One map style measured +7.8% on that mean while being −39% on Gemini and −16% on
  OpenAI. Compare within a provider, or quote the median. `bench/analyze-multi.ts`
  refuses to print the aggregate. Decision #25.
- ❌ **Any figure pooled across sweeps.** Three resolver bugs were fixed mid-session,
  so pooling blends library versions: a pooled task rate of 53/58 once described no
  version of the code that ever existed. The analysis tool requires `--sweep=`.
- ❌ **"Smaller than `@atlassian/mcp-compressor`."** It is not. Measured with
  `count_tokens` on both a real 19-tool MCP set and a 100-tool fixture, their `max`
  mode beat our shipped default on every corpus tested (788 vs 854 tokens; 1,540 vs
  2,191). Our encoder is denser — their `<tool>` format costs ~40% more in tokens than
  our map — but they ship the more aggressive configuration. The defensible claims are
  zero runtime dependencies against their 82 packages and five prebuilt `.node`
  binaries, an L1 that preserves provider-side constrained decoding, and published
  cross-provider accuracy data.
- ❌ "Works on any model" — measured on four frontier models from four vendors.
  Below the frontier tier, argument errors rise sharply (17/30 runs on
  Haiku 4.5, all recovered).
- ❌ "Beats Anthropic's tool search" — it does not beat it on tool-block size.
  It composes with it, and is more reliable below the frontier tier.
- ❌ "Lossless" — at levels 2–3 you give up provider-side constrained decoding.
  The library replaces that guarantee with its own validation; that is a
  trade, not a free lunch.
- ❌ Any figure not in this document. Every number there is
  recomputable from committed data.

