# 002 — Per-model default map style

Status: **draft, evidence gathered** · Owner decision: brain decision #15
Supporting evidence: brain decisions #22–#26

## Problem

The library ships one conservative level-3 default (`name+required`) because it is
the only style that survives every provider tested. That makes every model pay the
worst model's tax.

Three independent experiments have now produced the **same provider split**:

| Change | Gemini | OpenAI | Anthropic | xAI |
|---|---|---|---|---|
| generated cheat sheet | lookups 0.50 → **0.00** | worse | worse | worse |
| `mapStyle: "explicit"` | cost **−39%** | cost **−16%** | **+13%** | **+31%** |
| `mapStyle: "nocode"` (occupancy) | −15.2% | −15.5% | −11.6% | −12.2% |

**Gemini and OpenAI reward added map information. Anthropic and xAI do not.**
Anthropic issues ~2 lookups per run regardless of what the map says; xAI issues
*more* when given more. That is a behavioural difference, not a tuning one, and it is
worth −39% on Gemini that a single universal default cannot capture.

## Three findings that change the design

### 1. The table needs an objective, because cost and occupancy disagree

`nocode` beats the default on **occupancy on all four providers** — −11.6% Anthropic,
−15.2% Gemini, −15.5% OpenAI, −12.2% xAI, at 12/12 tasks each with zero malformed and
zero hallucinated names. By **median** cost it is better on Gemini and OpenAI,
identical on xAI, and 2.6% worse on Anthropic. It buys context by spending ~10% more
turns.

So "the best style for model X" is underspecified. Policy is keyed on
`(model, objective)`:

- **`occupancy`** — the default objective. Reclaiming context window is the product's
  claim; prompt caching already handles most of the *cost* but does not reclaim the
  room.
- **`cost`** — opt-in, for callers who care about the bill more than the window.

### 2. Occupancy may need no table at all

`nocode` wins occupancy on **every** provider measured. If that survives tier 3, the
honest conclusion is that occupancy needs a *better default*, not a per-model table —
and the table exists only for the `cost` objective. That is a smaller and better
feature than originally scoped, and it should be allowed to shrink to that.

### 3. Two aggregates are forbidden, and the tooling now enforces it

Both produced wrong conclusions during this work:

- **Cost averaged across providers.** An Anthropic run costs ~10× a
  Gemini/OpenAI/xAI run on this suite, so the mean reports Anthropic. `explicit`
  measures +7.8% on that mean while being −39% on Gemini. A `nocode` figure of
  "−7.1% cost" was **+6% by median**.
- **Pooled sweeps.** Three resolver bugs were fixed mid-session; pooling blends
  library versions, scenario mixes and suites. A pooled `nocode` row read 53/58 tasks
  — describing no version of the code that ever existed.

`bench/analyze-multi.ts` now prints no cross-provider aggregate, requires
`--sweep=<prefix>` to compare arms, and reports a median cost column. Any figure in
this spec must come from that tool, scoped to one sweep. Recorded as decision #25.

## Decision

`compress()` accepts a model id and an optional objective, and selects the best
*measured* style.

1. **Model given, no style** → best known-good style for that `(model, objective)`.
2. **Model given, style given** → honour it, unless that pair is recorded as broken,
   in which case **disallow and fall back** to the best known-good style.
3. **Unknown model** → the conservative default that passes everywhere.
4. **No model** → conservative default. Behaviour unchanged for every existing caller.

Case 2 is the owner's explicit choice over honour-with-a-warning.

```ts
compress(tools, { model: "gemini-3.1-pro-preview" })                    // best occupancy
compress(tools, { model: "gemini-3.1-pro-preview", objective: "cost" }) // -39%: explicit
compress(tools, { mapStyle: "grouped" })                               // you asked, you get it
compress(tools)                                                        // unchanged
```

## Candidate table from measured data

Indicative only — the shipped table is generated, never hand-written.

| Provider | `occupancy` | `cost` |
|---|---|---|
| `gemini-3.1-pro-preview` | `nocode` (−15.2%) | **`explicit`** (−39%) |
| `gpt-5.6-sol` | `nocode` (−15.5%) | **`explicit`** (−16%) |
| `claude-opus-5` | `nocode` (−11.6%) | `name+required` |
| `grok-4.5` | `nocode` (−12.2%) | `name+required` |

## The fallback must be observable

Silent substitution is the failure mode this repo has been bitten by four times:
bench/src divergence; a malformed `namespaceOf` return producing plausible garbage; a
cross-provider mean hiding a −39% win; a pooled task rate describing no real code. So
a fallback is reported, not swallowed:

- `stats.mapStyle` — what was actually used
- `stats.requestedMapStyle` — what the caller asked for, when it differed
- `stats.fallbackReason` — why, naming the model and the evidence

No throw, no console noise by default. Callers and tests can assert on it.

## The policy table is generated, never hand-written

`src/policy.generated.ts` is emitted from committed sweep results. Not a style
preference: a hand-maintained table would rot exactly the way `bench/` and `src/`
diverged before, and the whole value here is that the table is a record of
measurements.

Each entry carries:

- exact model id — **not** a family. `gpt-5.6-sol` failing says nothing certain about
  `gpt-5.7`.
- style, objective, effect size, run count, sweep key, and date
- per-provider figures only; no cross-provider averages

A drift test fails if the generated file disagrees with the committed results,
mirroring the existing docs-in-sync guard.

## Honest limits, to be documented

A lookup table of measured facts with an expiry date, not a theory of models.

- A model absent from the table gets the conservative default. That is an absence of
  evidence, not a prediction.
- Model behaviour changes between versions; entries are timestamped so staleness is
  visible.
- Figures come from one 149-tool real corpus, skewed toward one server
  (`data-sources-mcp`, 51 tools) with a repetitive filter idiom.
- **44% of that corpus declares no required parameters.** That is what makes
  `explicit` effective there, and it may not generalise to catalogues whose schemas
  are mostly required.
- Effect sizes below ~5% should not drive a table entry. Same-arm figures moved by
  more than that between n=4 and n=96 during this work.

## Out of scope

Auto-detecting the model from the caller's SDK client. Too magic, and wrong when a
proxy or gateway sits in between. The caller passes the id.

## Open before implementation

- **Running now:** 3 arms (`plus`, `nocode`, `explicit`) × 6 scenarios × 2 reps × 4
  providers, 144 runs, n=12 per cell — the data the first generated table will be
  built from.
- Whether the cheat sheet earns a Gemini-only row (task #26). It eliminated Gemini's
  lookups at n=4 and was worse everywhere else.
- Tier-3 confirmation before any shipped default changes.
