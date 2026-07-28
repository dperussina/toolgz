# Benchmark results

**Rounds 1–3** — Anthropic only: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`
**Round 4** — cross-provider: `claude-opus-5`, `gpt-5.6-sol`, `gemini-3.1-pro-preview`, `grok-4.5`
**Settings**: reasoning at high effort on every model that supports it, `max_tokens: 8000`
**Round 5** — same four providers, after hardening the resolver from observed failures
**Round 6** — real MCP tools: 149 tools from 14 live servers, replacing the synthetic fixture
**Total**: 4,031 runs across rounds 1–12, in 30 sweeps · 2026-07-25/27 (counted from the committed JSONL, not estimated)
*(plus 458 superseded runs, $13.88 — see `bench/results/superseded/`)*
**Raw data**: `bench/results/*.jsonl`, committed · **Verify**: `npx tsx bench/analyze-multi.ts --sweep=<timestamp>` — the `--sweep` flag is required, because pooling runs blends library versions

> **Arm names in rounds 1–5 include map styles removed in 0.2.0** — `minified`
> (`mapStyle: "name"`) and `minified-terse` among them. Those rows are the historical
> record and are left intact; they are not a menu of current options. The three styles
> the library still offers are `name+required`, `explicit` and `signature`.
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

`mapStyle: "name"` (removed in 0.2.0) scored **57/60** overall: perfect on Anthropic, Google and OpenAI, and
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

**The default was the best arm on every provider in round 5.** `name+required` had the
smallest prompt on all four, a perfect task rate, and zero malformed arguments. Bare
names were the only style that had failed (14/15 on grok-4.5).

> **Revised by round 6.** At tier 3 on real MCP tools (432 runs, 36 per arm per
> provider), `explicit` was the only arm at 144/144 — the default lost one task on
> grok-4.5 — and it cut median cost on three of four providers (−20.7% openai, −15.4%
> gemini, −9.0% anthropic) while costing 13.2% more on grok-4.5. The default remains the
> shipped default; `explicit` is selected per-model via `objective: "cost"`. And `nocode`
> joined bare names on the list of styles that have failed, with a 19% silent failure
> rate on grok-4.5.

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

## Round 6 — real MCP tools, and the corpus becomes the benchmark of record

Rounds 1–5 all used one synthetic catalogue. Round 6 replaced it, because the fixture
turned out to flatter at least one compression style: `grouped` measured **−21%** on
the fixture purely because every tool name carried a `namespace_op` prefix to factor
out, and **−1%** on real MCP tools, which mostly do not.

**The corpus.** 149 tools harvested from 14 live MCP servers by speaking MCP over
stdio (`initialize` → `tools/list`) and recording exactly what each advertised.
Committed at `bench/fixtures/real-mcp-tools.json`, with 12 scenarios in
`bench/scenarios-real.ts` built on confusable pairs that already existed in the
catalogue — ten weekly/daily twins separated only by a `_daily` suffix, rollup vs
`_detail`, `order_path` vs `order_path_financial`, Sheets overwrite vs append.

**Uncompressed it is 68,494 prompt tokens on `claude-opus-5`** — more than twice the
synthetic fixture, and about a third of a 200k window before the user types anything.

### The dominant cost driver is lookups, not map size

Measured across 658 runs: target tools with **zero required parameters** averaged
**1.42 lookups and 4.26 turns**, against **0.42 and 2.79** for tools with required
parameters. That is 3.4× the lookups. **44% of the real corpus (66 of 149 tools)
declares no required parameters**, so their map line is a bare name — indistinguishable
from a tool whose parameters were omitted.

For scale: one extra turn is worth roughly **3,300 prompt tokens** (within-scenario,
controlled), against a whole-map saving of ~550 for the best encoding change tried.
**Map-size work is worth about one sixth of a turn.** That single ratio explains every
encoding result in this round.

### Tier 3 — 432 runs, 36 per arm per provider

| Arm | Tasks | Result |
|---|---|---|
| `explicit` | **144/144** | turns and lookups down on **all four** providers |
| `name+required` | 143/144 | the shipped default |
| `nocode` | 137/144 | **19% failure rate on grok-4.5** |

`explicit` marks zero-required tools `()` for +275 characters — it states the fact the
model lacks, rather than naming the parameters (which cost 13× more and measured +41%).

Median cost against the default: **OpenAI −20.7%, Gemini −15.4%, Anthropic −9.0%,
xAI +13.2%**. Occupancy was a wash everywhere (±3.1%, under the 5% floor).

### `nocode` — the result that mattered most

It beat the default on **occupancy on all four providers** (−11.6% to −15.5%) and is
**not shippable**. At tier 3 it failed 7 of 36 xAI runs, and **all seven were silent**:
`turns=1`, no tool call, no error, the model answering unaided. Four different
scenarios, so not scenario-specific.

It had passed 12/12 on xAI in an earlier sweep. **The intermittency is the finding** —
a candidate can clear a tier-2 gate and still be broken, which is why the ladder keeps
all four providers at every tier and why occupancy alone never justifies a default.

### Method corrections forced by this round

Three of them, each having produced a confidently wrong answer first:

- **Cost was being averaged across providers.** An Anthropic run costs ~10× the others
  here, so the mean reported Anthropic. One style read +7.8% on that mean while being
  −39% on Gemini. `analyze-multi.ts` no longer prints the aggregate.
- **Results were being pooled across sweeps.** Three resolver bugs were fixed
  mid-round; a pooled task rate of 53/58 described no version of the code that ever
  existed. `--sweep=` is now required.
- **The charts had the same pooling bug**, and would have published 70% where the
  results table says 85%. They now pin to one sweep.

---

### Round 6b — scale invariance, and a cliff we could not reach

Two experiments after tier 3, both on the real corpus.

**Compression is scale-invariant.** Measured with `count_tokens` and confirmed against
live API calls on `claude-opus-5`, scaling the 149-tool corpus by replication:

| Tools | Uncompressed | Level 3 | Reclaimed |
|---:|---:|---:|---:|
| 149 | 68,536 | 3,022 | 95.6% |
| 435 | 199,822 | 8,690 | 95.7% |
| 800 | 368,826 | 16,006 | 95.7% |
| 1,200 | 552,795 | 23,880 | 95.7% |

Both the uncompressed block and the map grow linearly in tool count, so the ratio holds.
Real MCP tools measure **~460 tokens each**, against ~393 in Sakizli's published
benchmark — real catalogues are ~17% heavier than synthetic ones.

Practical ceiling per window: **17 tools at 8K, 71 at 32K, 434 at 200K.** That last
figure independently corroborates the same paper's ~494-tool overflow threshold, measured
on lighter tools — two separate measurements within ~15%.

**The enablement cliff is not reachable with our providers.** Sakizli reports a binary
enablement effect: at 8K with 28 tools, uncompressed schemas overflow and EM collapses to
2.6%, while compression restores it (+20.5pp); at 32K, four of five models show ≤1pp,
making the effect budget-driven rather than intrinsic.

We tried to reproduce it. Uncompressed requests **ran successfully** at 149, 435 and 800
tools (368,826 tokens) on `claude-opus-5`, selecting the correct tool every time. On a 1M
window, overflow needs ~2,173 tools. All four providers we test have windows far larger
than the corpus requires, so the overflow regime is unreachable; the paper used 1.5B–32B
local models over Ollama at 8K/16K/32K.

Recorded as blocked rather than concluded. **We have not shown that compression improves
accuracy and do not claim it** — every result we have is from the regime where the paper
predicts no effect.

*Measurement note:* the first probe reported level 3 using 110 input tokens, which looked
like a broken adapter. `usage.input_tokens` **excludes cached tokens**, and the Anthropic
adapter places a `cache_control` breakpoint on the map — the preamble was in
`cache_creation_input_tokens`. Total occupancy is
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Second time this
session a partial read of a multi-field measurement produced a wrong conclusion.

---

### Round 6c — three Gemini schema rejections found on real tools

Found while probing provider tool-count limits, not by looking for it. Gemini rejects the
**entire request** if one declaration is invalid, so a single non-conforming tool anywhere
in a catalogue breaks every call. All three forms are present in the committed 149-tool
corpus and none were handled:

| Form | Occurrences | Example | Error |
|---|---:|---|---|
| array with no `items` | 7 tools | `analyze_consolidation.shipments` | `properties[shipments].items: missing field` |
| `enum` on a non-string type | 1 | `deep_research.depth` = `{number, enum:[1,2,3]}` | `Invalid value at ...properties[2]` |
| union type | 1 | `send_email_with_attachments.cc` = `["string","array"]` | needs a single type string |

Each repair was chosen empirically rather than guessed. For the missing `items`, Gemini
accepts `{}`, `{type:"string"}` and `{type:"object"}` — we emit `{}` because the source
schema does not say what the items are and inventing a type would make the model send
strings where the API may want objects, converting a loud rejection into silent bad data.

The dropped `enum` does not lose the constraint: `validateArgs` checks against the original
schema before dispatch at every level, so `depth: 99` is still rejected. The check moves
from provider-side to library-side.

Verified against the live API at levels 0–3 on all 149 tools, then pinned with 16 offline
tests. Two of those exist to stop the guard rotting: one asserts the fixture still contains
all three forms (otherwise the guards pass against nothing), and one asserts the dropped
enum is still enforced. Removing the fix produces 6 failures.

### Round 6d — provider tool-count caps

A hard limit unrelated to context, found by binary search (rejections are free):

| Provider | Max tools accepted | Past it |
|---|---:|---|
| xAI `grok-4.5` | **350** | `400 Maximum tools limit reached` |
| OpenAI `gpt-5.6-sol` | 1,200+ | no cap found in range |
| Anthropic `claude-opus-5` | 1,200+ | no cap found in range |
| Google `gemini-3.1-pro-preview` | 1,200+ | no cap found in range |

**Compression defeats the xAI cap outright.** Level 3 puts two tools on the wire whatever
the catalogue size, so 351, 1,000 and 5,000-tool catalogues all succeed where uncompressed
fails at 351. This is the one hard enablement effect reachable with our providers — not the
context-overflow cliff, which needs small-window models we do not test.

*Measurement correction:* the first pass reported Gemini capping at 4 tools. That was a
schema rejection on the 5th tool misread as a count limit by the binary search. There is no
Gemini tool cap. Verify the error text before trusting a threshold.

---

### Round 6e — recommendLevel was giving the wrong answer for our own corpus

Found while verifying defaults, not by benchmarking. `recommendLevel` gated level 3 on
`opsPerNamespace >= 4`. That is a **level-2** question: level 2 pays dispatcher overhead
per namespace, so its shape matters there. Level 3 uses one flat dispatcher and does not
care about namespaces at all.

Real MCP tool names are verb-first (`probe_url`, `discover_api`), so splitting on the first
underscore yields many tiny namespaces — the 149-tool corpus has **63 namespaces at 2.4 ops
each**. The rule therefore returned **level 1 at 41,648 tokens** where level 3 measures
**2,980**, leaving ~38,700 tokens unclaimed on our own flagship corpus.

Measured crossover, real tools, `count_tokens`:

| Tools | Level 1 | Level 3 | Smaller |
|---:|---:|---:|---|
| 5 | 1,178 | 635 | L3 |
| 15 | 3,584 | 844 | L3 |
| 40 | 10,436 | 1,201 | L3 |
| 149 | 41,648 | 2,980 | L3 |

**Level 3 is smaller at every count tested, down to 5 tools.** Size never argues for level
1. What argues for level 1 is that it keeps the provider's own argument validation, which
levels 2–3 give up — so the threshold is now absolute (≈4,000 tokens of level-1 block)
rather than a shape test. Below it, the saving is not worth losing provider-side checking;
above it, reclaiming the block is.

The block is now sized by asking the library what level 1 would actually emit. An earlier
version of the fix rebuilt the schema by hand, kept full descriptions where level 1 emits a
signature line, and overshot by ~34%; the estimate now tracks the real count within 2.4%
(42,654 estimated against 41,648 measured).

---

## Round 7 — the level-1 signature prefix, and a fourth provider split

Sweeps `2026-07-26T16-31-21` (tier 0, 16 runs) and `2026-07-26T16-37-11` (tier 1, 64
runs). Real suite, 149 tools, `--arms=signatures,signatures-noprefix`.

### The question

Level 1 prepends `name(a,b?) — ` to every description while keeping the full
`input_schema`. That prefix restates the tool name, the property names, the required
list, the enums and the item types — all of which the retained schema already carries.
It is **18.5% of the level-1 payload** on the real corpus.

An external reviewer had measured level 1 *inflating* a terse catalogue by ~15%, which
is what prompted this: the prefix is the whole reason it can inflate.

Offline, removing it is strictly better on size:

| Fixture | with prefix | without | Δ |
|---|---:|---:|---:|
| 149 real tools (characters) | 45.2% | **55.3%** | +10.1pp |
| 14 real tools | 59.0% | **65.2%** | +6.2pp |
| 50 terse tools | −14.4% | **−0.6%** | +13.8pp |
| 100 terse tools, 8 properties | −24.3% | **−0.3%** | +24.0pp |

Note the floor: **−0.6% is level 0's own figure** (`c.tools` is Anthropic-shaped and
`input_schema` is one character longer than `inputSchema`). Without the prefix, level 1
can no longer make a payload bigger — at worst it does nothing.

### What the live runs said

Size is not the question, though. Every arm that ever measured clean had the prefix, and
a one-line signature may simply be easier for a model to read than the equivalent JSON.

Tier 1, n=8 per arm per provider, **64/64 tasks, zero hallucinated names, zero malformed
arguments on both arms**:

| Provider | Block | Prompt | Median cost | Turns | Latency |
|---|---:|---:|---:|---|---:|
| `gemini-3.1-pro-preview` | −18.5% | −17.8% | **−15.3%** | 2.00 → 2.00 | +0.4% |
| `gpt-5.6-sol` | −26.0% | −33.6% | **−13.8%** | 2.38 → 2.13 | −2.4% |
| `grok-4.5` | −18.2% | −17.9% | **−17.2%** | 3.00 → 3.00 | −10.9% |
| `claude-opus-5` | −18.3% | **−2.0%** | **+3.8%** | **3.88 → 4.63** | −0.1% |

**On Anthropic the block shrinks 18% and the saving is spent on extra turns.** Not one
outlier — per-run turns went `4 4 5 5 3 4 3 3` with the prefix and `6 5 6 4 5 5 3 3`
without, so 6 of 8 runs needed ≥5 turns against 2 of 8. One turn is worth ~3,300 prompt
tokens on this suite, which is most of what an 18% block reduction buys.

This is the **fourth** time the same split has appeared: Gemini and OpenAI reward
information density changes, Anthropic and xAI often do not. Here xAI sides with Gemini,
which is new.

### Decision

**The default does not move.** `signaturePrefix` ships as an option defaulting to
`true` — every published level-1 figure was measured with it, and flipping a default on
n=8 with one provider contradicting is exactly the mistake the tier ladder exists to
prevent.

What it plausibly earns is a **per-model policy row** rather than a global default,
alongside `mapStyle`. That needs tier 2 to establish whether the Anthropic turn
increase is real: +19% clears the 5% effect floor and the per-run pattern is
consistent, but n=8 is n=8.

**Open**: tier 2 on `claude-opus-5` specifically, which is the contested cell. At
~$0.83/run it is the expensive one to answer, and the answer decides default-flip
versus policy-row versus option-only.

## Round 8 — level 4 on its own, and two bugs only a model could find

Sweeps `2026-07-27T21-22-18` (smoke, 8 runs), `2026-07-27T21-29-52` (full, 144 runs) and
`2026-07-27T21-52-59` (xAI re-run, 36 runs). Real suite, 149 tools, **level 4 only** — the
brief was to test level 4, not to re-litigate levels 0–3.

Level 4 is level 3's dispatcher with the mechanical map replaced by minified Python that a
model compiled from the corpus ahead of time. See
[EXPERIMENT-tools-as-code.md](EXPERIMENT-tools-as-code.md).

### Result: 144/144 tasks, 156/156 correct calls, zero hallucinated names

| provider | n | block | prompt | turns | lookups | correct | halluc | malformed | tasks |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `claude-opus-5` | 36 | 12,562 | 41,339 | 3.2 | 0.2 | 39/39 | 0 | 0 | 36/36 |
| `gemini-3.1-pro-preview` | 36 | 9,040 | 19,776 | 2.1 | 0.0 | 39/39 | 0 | 0 | 36/36 |
| `gpt-5.6-sol` | 36 | 7,131 | 16,186 | 2.2 | 0.1 | 39/39 | 0 | 0 | 36/36 |
| `grok-4.5` | 36 | 8,929 | 30,137 | 3.2 | 0.8 | 39/39 | 0 | **3** | 36/36 |

Lookups are near zero on three providers, which is the point of putting semantics in the
map: the model rarely needs to ask what a tool is for.

### Bug 1 — `=0` meant "optional" to me and "number" to every model

The smoke run scored 8/8 tasks with **3 malformed arguments across 3 of the 4 providers**,
all the same call:

```
compiled:   def scorecard_lf_daily(...,latest_snapshot_only=0,...)
model sent: {"latest_snapshot_only": 1}
rejected:   must be a boolean
```

`=0` was shorthand for "this parameter is optional". In Python a default value is a type
declaration, so it reads as "this parameter is a number" — and three providers
independently read it correctly and produced the same wrong call.

Changed the compile prompt to `name=None` and recompiled. The identical eight calls then
produced **zero** malformed arguments, and grok-4.5's turns fell 6 → 2. Cost: +2,171
characters over 149 tools.

**No offline measurement could have found this.** Size and ambiguity were both unchanged
by the convention. Only a model reading the map exposed it.

### Bug 2 — level 4 has no codes, but the dispatcher still asked for one

Of the three malformed arguments left in the 144-run sweep, two were grok-4.5 calling
`q(c="a2")` — inventing a map code. Level 4 identifies tools by real function name and
emits no codes at all, but `t` and `q` still described themselves in terms of "map codes",
so the model reasonably concluded codes existed and made one up.

Made the dispatcher wording level-aware — *"Invoke a tool by its function name, exactly as
declared in the Python block"* — and re-ran all 36 grok-4.5 runs: **malformed 3 → 1, and
the invented-code failures stopped entirely.**

### What is left, and it is not a map defect

The single remaining malformed argument is grok-4.5 sending `csv_mode: true` to a tool that
does not accept it. `csv_mode` is a real parameter on several sibling tools in this corpus,
so the model generalised it. Validation caught it and the run recovered. That is the
failure mode `validate` exists for, and it is not specific to level 4.

### A hazard found by auditing the compiled corpus, not by running it

Ten compiled docstrings name a sibling tool — the highest-value hints in the map, and the
only claims verification cannot check. Two of them point somewhere wrong:

- `profile_file` → *"before **execute_coding_task**"*, which is **not in this corpus**. The
  source description referenced a tool from a wider registry and the compiler carried it
  faithfully.
- `gdrive_sheets_update_range` → *"append_rows"*, a truncated name; the real tool is
  `gdrive_sheets_append_rows`.

`compileTools` now reports `danglingReferences` and the CLI prints a `CHECK` line for each.
It reports rather than rejects: the check only fires on redirect phrases ("use X",
"before X", "instead of X"), because docstrings legitimately mention columns and parameters
that look like tool names. On the real corpus it flags exactly those two, with no false
positives.

### Standing

Level 4 is behaviourally sound on this corpus: **180 runs, every task completed, zero
hallucinated tool names, one recovered malformed argument.** It is still branch-only, and
what it has not been tested against is a corpus whose descriptions are wrong — where the
compiler would faithfully compress an untruth into something that reads authoritatively.

## Round 9 — can a dispatcher have provider-side enforcement?

Sweep `2026-07-28T00-12-20`, 24 runs, 3 scenarios × 4 providers × 1 rep.

### The question, and the part of it that is closed

Levels 2, 3 and 4 give up provider-side constrained decoding because the wire carries
`t(f, a)` with a generic `a` — the sampler cannot enforce a schema it was not given, and
not giving it the schema is the compression.

The only construct that would express per-tool enforcement on a dispatcher is a
discriminated union on `f`. **The Anthropic API rejects it outright:**

```
tools.0.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf
at the top level
```

Measured anyway before finding that out: **+112,488 characters**, which is more than level
1 costs. So argument enforcement on a dispatcher is closed, on two independent grounds.

### What is available: `enforceNames`

Constraining `f` to an `enum` of real tool names is legal, cheap, and works at **levels 3
and 4** because they share a dispatcher.

| | tokens | enforcement |
|---|--:|---|
| level 4 | 12,567 | none — toolgz validates |
| level 4 + `enforceNames` | 13,980 | tool name |

+1,413 tokens, about 11%. It fixes a failure we have not observed — zero hallucinated names
in 180 runs — so what it buys is the *kind* of guarantee, not a measured improvement.

### What the question actually turned up: `compiled` at level 1

The compiled map was built to replace level 3's map. It is worth more on a level that keeps
the schema, because there the docstring replaces prose without giving anything up.

> **Superseded by Round 11.** "Without giving anything up" was wrong. The saving came from
> dropping the signature prefix, and level 1 strips per-property descriptions, so that
> prefix is the only place the parameter inventory appears in prose. An external team
> measured the cost at 8.9 to 13.4 points of selection accuracy. Kept as written because
> the error is the finding.

| | tokens | vs level 0 | enforcement |
|---|--:|--:|---|
| level 0 | 68,501 | — | full |
| level 1 | 41,655 | 39.2% | full |
| **level 1 + `compiled`** | **35,103** | **48.8%** | **full** |

**16% under level 1 with provider-side enforcement completely intact.**

A first attempt made it *larger* — 91,546 characters against 89,574 — because
`signaturePrefix` defaults on and was prepending a signature alongside the docstring. The
parameters are already in the schema directly below. The prefix now defaults off for a
compiled line.

### Behaviour, 24 runs

| arm | providers | correct | hallucinated | malformed | tasks | lookups |
|---|--:|--:|--:|--:|--:|--:|
| `signatures-compiled` (L1 + compiled) | 4 | 12/12 | 0 | 0 | 12/12 | 0.0 |
| `compiled-enforced` (L4 + enforceNames) | 4 | 12/12 | 0 | 0 | 12/12 | 0.0 |

Clean on both, on every provider. **n=3 per cell — this is a tier-0 smoke, not proof.** It
establishes that neither option breaks anything, not that either is better.

### Standing

Both are opt-in and both default off. Level 1, 3 and 4 output is byte-identical without
them: 89,574 / 5,721 / 30,079 characters, unchanged.

Open: whether `compiled` at level 1 should become a recommendation, which needs reps at
tier 1 or above. And whether `enforceNames` is worth 11% for a guarantee against something
that has not happened in 180 runs.

## Round 10 — level 3 against level 4, and enforceNames measured and removed

Sweeps `2026-07-28T00-24-06` (96 runs, level 1) and `2026-07-28T01-23-31` (192 runs, the
dispatcher levels). Real suite, 149 tools, 6 scenarios × 2 reps × 4 providers.

### `enforceNames` — built, measured, removed

Constraining the dispatcher's `f` to an `enum` of real tool names is the only provider-side
enforcement a dispatcher can carry. It is legal, unlike argument enforcement, which needs a
discriminated union the Anthropic API rejects outright.

It cost more than it was worth on every axis:

| provider | level 3 | + enforceNames | level 4 | + enforceNames |
|---|--:|--:|--:|--:|
| `claude-opus-5` | 2,980 | 4,393 **+47%** | 12,560 | 13,973 +11% |
| `gemini-3.1-pro-preview` | 1,748 | 2,978 **+70%** | 9,037 | 10,267 +14% |
| `gpt-5.6-sol` | 1,477 | 2,488 **+68%** | 7,128 | 8,139 +14% |
| `grok-4.5` | 1,780 | 2,845 **+60%** | 8,926 | 9,991 +12% |

The enum is the same 3,189 characters everywhere; it is simply most of level 3's map.

**And it caused the only two failures in 192 runs**, both on grok-4.5 at level 3:

```
xai · minified-enforced · real-status-vs-result  turns=1 correct=0/1 halluc=0 bad=0
xai · minified-enforced · real-transit-vs-route  turns=1 correct=0/1 halluc=0 bad=0
```

One turn, **zero tool calls, no error raised** — the model read the tools and answered. That
is the signature that disqualified the `nocode` map style in 0.2.0, on the same provider.

Against that: **zero hallucinated tool names on any arm, in any of the 192 runs.** It was
preventing nothing. Paying up to 70% of the map to reintroduce a known silent-failure mode
against a threat that has never materialised is not a trade, so the option is gone.

### Level 3 against level 4, in one sweep

The first legal comparison — Round 8 measured level 4 alone, and pooling sweeps is
forbidden here for good reason.

| provider | L3 block | L4 block | L3 turns | L4 turns | L3 lookups | L4 lookups |
|---|--:|--:|--:|--:|--:|--:|
| `claude-opus-5` | 2,980 | 12,560 | 4.1 | **3.3** | 1.5 | **0.5** |
| `gemini-3.1-pro-preview` | 1,748 | 9,037 | 2.3 | **2.0** | 0.3 | **0.0** |
| `gpt-5.6-sol` | 1,477 | 7,128 | 2.3 | **2.0** | 0.1 | **0.0** |
| `grok-4.5` | 1,780 | 8,926 | 2.7 | 2.7 | 0.7 | **0.2** |

**96/96 tasks on both arms, zero hallucinated names, one malformed argument.**

Level 3 is smaller on every provider. Level 4 buys some of it back in turns and lookups —
on Anthropic, 0.8 fewer turns and a third of the lookups. At ~3,300 prompt tokens per turn
that recovers roughly a quarter of the 9,580-token gap, not all of it.

**So level 3 stays the default.** Level 4 is for the case it was built for: a catalogue
whose names collide, where level 3's map carries nothing but names. `stats.ambiguousMapLines`
is how you tell.

### Level 1 with a compiled map

96 runs, `signatures` against `signatures-compiled` in one sweep.

| provider | L1 block | + compiled | saved |
|---|--:|--:|--:|
| `claude-opus-5` | 41,648 | 35,096 | 15.7% |
| `gemini-3.1-pro-preview` | 26,913 | 22,874 | 15.0% |
| `gpt-5.6-sol` | 15,922 | 12,655 | 20.5% |
| `grok-4.5` | 27,691 | 23,725 | 14.3% |

**96/96 tasks, 48/48 correct calls, zero hallucinated, zero malformed on both arms.** A
written docstring selects exactly as reliably as the tool's own first sentence, and
provider-side enforcement is untouched because these are still native tools with real
schemas.

Cheaper by median on three providers. **Anthropic is the exception**: turns went 3.4 → 4.1
and total prompt tokens rose slightly despite the smaller block. That is the second time
Anthropic has spent a block saving on extra turns — the first was `signaturePrefix` in
Round 7 — so it is a pattern to watch rather than noise, though n=12 cannot settle it.

**Kept**, as an option. It is the only thing in the library that reduces the tool block
without giving up a guarantee.

### A harness bug this round exposed

Two Gemini runs recorded `toolBlockTokens: 0` because `measureToolBlock` threw and the
initialised zero was written anyway. Averaged in, they dragged a mean from 10,267 to 8,556
and made an option that only *adds* bytes appear 5% cheaper — a figure that was briefly
reported before the payload was inspected directly. A failed measurement now records
`null`, so it is absent rather than counted as zero.

## Round 11 — an external team measures 0.5.0, and two claims fall

Not our sweep. A team ran `toolgz@0.5.0` against a live 60-tool registry, 45 runs per arm
per provider on `claude-opus-4-8` and Kimi, and reported back. Their numbers, our
reproductions.

### The level-1 compiled claim was false

0.5.0 shipped `compiled` at level 1 describing it as *"the only option that reduces the
block without giving anything up"*. It gave up the parameter inventory.

| | tokens | Opus accuracy | Kimi accuracy | malformed (Opus) |
|---|--:|--:|--:|--:|
| level 1 | 21,356 | **68.9%** | **57.8%** | **0** |
| level 1 + compiled | **17,401** | 60.0% | 44.4% | 4 |

Level 1 strips every per-property `description` — verified on their registry: 0 of 7
properties on `execute_coding_task` carry one, at both L1 and L1c. The signature prefix is
therefore the only place the parameter inventory appears in prose, and the compiled
docstring **replaced** it rather than joining it. Their model then invented `includeCharts`
and `filename`, parameters that exist on no tool, on the arm that had been the only one in
their entire experiment with zero malformed arguments.

Reproduced on our corpus:

| | chars | vs plain L1 | inventory |
|---|--:|--:|:-:|
| plain level 1 | 89,574 | — | yes |
| + compiled (0.5.0 default) | 75,004 | −16.3% | **no** |
| + compiled + `signaturePrefix` | 91,546 | +2.2% | yes |

> Figures in this table predate a later change: `signatureLine` now renders object and
> untyped-array shapes, adding 123 characters across the corpus, so plain level 1 reads
> 89,697 and 45.1% rather than 89,574 and 45.2%. The comparison is unaffected.

**The 16% was the inventory.** No configuration keeps both — they measured
`signaturePrefix: true` at 3.9% *dearer* than plain level 1 on their registry, and it is
2.2% dearer here. Fixed in 0.5.1 by defaulting the prefix back on.

Their enforcement check confirmed the other half of the claim, which was true: on
`manage_operatives`, 36 properties, 6 enum-constrained parameters and an identical
`required` array at L0, L1 and L1c. Byte-identical. Level 1 with a compiled map really does
keep everything the provider was validating.

### `verifyCompiledLine` permitted an under-described interface

Their words: it *"correctly refuses invented parameters, but it doesn't require a compiled
line to mention the parameters that exist"*. Correct — it refuses an invented parameter and
a dropped **required** one, and permits dropping optional ones. A docstring covering one of
seven parameters passed verification and still degraded selection.

Zero occurrences on our 149-tool corpus, which is the point: the compiler follows the
prompt and nothing was enforcing it. `compileTools` now reports `incompleteSignatures`.

### BEFORE-AFTER.md contradicted its own table

Separately found while auditing. The prose read *"the saving grows with the tool count,
because the level-3 wire payload is two tools no matter how many you start with"* — directly
above a table showing level 2 at 4,915 characters against level 3's 8,120 at 300 tools.

Level 3 sends two tools, but its **map grows one line per tool**. Measured:

| tools | level 2 | level 3 | |
|---:|--:|--:|---|
| 100 | 3,833 | 3,420 | L3 smaller by 11% |
| 300 | 7,033 | 9,420 | **L2 smaller by 25%** |
| 600 | 11,833 | 18,420 | **L2 smaller by 36%** |

Level 2 overtakes level 3 between 100 and 300 tools. Four documents said "level 2 is
dominated by level 3" without qualification; it is dominated **on accuracy** — 16 malformed
arguments against zero over 60 runs each — not on size at scale. This closes a task open
since a colleague first reported the shape.

### Their recommendation, which we agree with

L3 with `mapStyle: "signature"` at 5,522 tokens beats level 1 + compiled at 17,401 on both
cost and accuracy, on both their providers. Level 1 + compiled is the cheapest arm that
keeps real tool names on the wire **and** full schema enforcement — which matters only if
opaque dispatcher names are a problem for audit or logging.

Note for anyone re-running their comparison on 0.5.1: their L1c arm will now measure around
22,000 tokens rather than 17,401, because the inventory is back by default.

## Round 12 — shapes derived, not guessed

Sweeps `2026-07-28T03-21-16` (144 runs, the falsification test) and `2026-07-28T12-19-30`
(96 runs, verifying the leaner map). New suite: `bench/scenarios-shape.ts`.

### The question, and a suite built to answer it

An external team measured every level-4 argument rejection across two providers and two
independent compiled artifacts: **77% container-type errors, 23% bad enum values, nothing
else.** That is a claim about the map — a parameter shown as a bare name gives the model no
way to know it wants `[{…}]` rather than a string.

Every other suite here measures tool *selection*. This one names the tool in the prompt, so
selection is trivial and **the only way to fail is sending the wrong shape**: an array of
objects, nested objects as coordinates, an array of arrays, three containers in one call, an
enum value.

### Falsified in the right direction

144 runs, 6 scenarios × 2 reps × 4 providers × 3 arms.

| arm | n | malformed | lookups/run | shapes in map? |
|---|--:|--:|--:|:-:|
| `compiled` (level 4) | 48 | **0** | 0.08 | yes |
| `minified-sig` (level 3, signature) | 48 | **0** | 0.31 | yes |
| `minified-plus` (level 3, default) | 48 | **3** | 0.77 | **no** |

Every rejection landed on the one arm whose map shows no shapes, on three different
providers:

```
gemini · compute_route   Parameter "origin" must be an object.
xai    · compute_route   Parameter "origin" must be an object.
openai · analyze_blob    Unknown parameter "url". Accepted: … external_url …
```

Two container-type errors and one wrong parameter name — the same two classes, in the same
proportion. **The mechanism is confirmed.** Note also that the shape-blind arm spent
**0.77 lookups per run against 0.08**: it was not merely riskier, it was going to ask, and
still got three wrong.

**What this does not establish:** that the fix improved *our* level 4, which was already at
~0 malformed. There is no improvement to show against a clean baseline. What changed is that
level 4 is now in the shapes-present group *by construction* rather than by luck.

### Two mechanical gaps this exposed

`signatureLine` rendered **0 of 33** object parameters with any shape marker, and 8 arrays
with untyped items — `analyze_consolidation(shipments, truckSpecs)` for an array of objects
and an object. `{}` and `[]` cost **123 characters across the whole corpus** and take
coverage to 73/73 arrays and 33/33 objects. Level 1 moved 45.2% → 45.1%.

The degraded path was worse: a tool that fails verification fell back to a bare list of
required names, making it the single shape-blind line in an otherwise complete map, with an
array among them. The fallback now derives its signature too.

### Then the model stopped being asked for shapes at all

Since the signature is derived, restating shapes in the docstring is pure duplication. The
compile prompt now forbids it:

| | chars | per tool | level-4 map |
|---|--:|--:|--:|
| prompt asks for shapes | 33,395 | 224 | 35,027 |
| **shapes derived, prose only** | **26,762** | **181** | **28,489** |

**20% off the artifact, 19% off the map**, with coverage unchanged because it no longer
depends on the model. Verified over 96 further runs: **zero malformed arguments, zero
rejections, 96/96 tasks.**

> **The size effect does not generalize, and this write-up first stated it as if it did.**
> The external team measured the opposite direction on their catalogue: level 4's wire went
> **+14.7%** (6,309 → 7,239 tokens) where ours went down. Both are correct, and the reason is
> what the *old* compile happened to write. Ours spelled shapes into the docstrings, so
> deriving them made the prose redundant and removing it more than paid for the signature.
> Theirs named 0 of 52 arrays and 0 of 39 objects, so there was no duplication to remove and
> deriving adds all of it. **Coverage goes to 100% either way; the byte direction depends on
> your artifact.** On theirs, level 4 went from 14% dearer than level 3 with `signature` to
> 29% dearer — which strengthens the same verdict rather than changing it.
>
> They also falsified their own §13 prediction, that level 4 would become strictly better
> than level 3 once docstrings carried shapes. At n=45 on Opus it did not: 64.4% against
> 71.1%, for 1,639 more tokens, with every level-4 miss inside one confusable cluster. Three
> tasks at n=45 settles nothing on its own, but it does not support the prediction either.
> Their Kimi arm is the strongest result in the round: **15 malformed arguments to zero**, on
> a corpus that — unlike ours — had a failing baseline to improve.

```
def analyze_consolidation(shipments:[],truckSpecs:{}):"group shipments by destination to find truck-fill consolidation opportunities"
```

### A defect the round exposed by accident

Inspecting the artifact 0.6.0 shipped showed **148 of 149 tools**. The missing one was not a
model failure: `from` is a Python reserved word, so `def send(from=None)` is a SyntaxError,
and the only legal spelling is a trailing `**{"from":None}`. The old compile wrote the
SyntaxError and the verifier **accepted** it; the new compile wrote the correct form and the
verifier **rejected** it as an invented parameter. Three tools in the corpus have such a
parameter, all email senders, and `from`/`to` date ranges make this ordinary in real
catalogues.

Fixed in 0.6.1: level 4 renders keyword-named parameters as `**{"from":None}` (`...` if
required) keeping the wire name exactly, one parser replaces the three that each read
`**{…}` as zero parameters, and the verifier now rejects the invalid form and names the fix.
The corpus compiles **149/149** for the first time. Old artifacts need no action — the bad
lines fail verification and degrade to a derived signature, which is what
`stats.staleCompiledTools` is for.

### The verdict does not move

`minified-sig` matched level 4 on argument quality — zero malformed on both — at **6,065
average block tokens against 8,707**. The external team's recommendation of level 3 with
`mapStyle: "signature"` over level 4 survives this round and is strengthened by it: the
cheaper arm is equally safe.

Level 4 remains the answer to ambiguity, not to argument quality.

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

### 3. Level 2 is dominated on accuracy and should not be used for that reason

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

