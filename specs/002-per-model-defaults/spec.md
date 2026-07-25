# 002 — Per-model default map style

Status: **draft** · Depends on: real-tool sweep (`--suite=real`) completing
Owner decision recorded as brain decision #15.

## Problem

The library ships one conservative level-3 default (`name+required`) because it is
the only style that survives every provider tested. Failures are not general —
they are provider-specific, and different each time:

| Style | claude-opus-5 | gemini-3.1-pro | gpt-5.6-sol | grok-4.5 |
|---|---|---|---|---|
| `name` (bare) | ok | ok | ok | **fails** (3/3, zero tool calls) |
| `grouped` | 36/36 | 12/12 | **32/36**, 137 bad args | pending |
| `name+required` | 36/36 | 12/12 | 36/36 | pending |

So every model pays the worst model's tax. Claude and Gemini both run `grouped`
clean and cheaper; they are subsidising GPT's unwillingness to reconstruct
`namespace_op` into a real tool name.

## Decision

`compress()` accepts a model id and selects the best *measured* style for it.

1. **Model given, no style given** → best known-good style for that model.
2. **Model given, style given** → honour it, unless that pair is recorded as
   broken, in which case **disallow and fall back** to the best known-good style.
3. **Unknown model** → the conservative default that passes everywhere.
4. **No model given** → conservative default. Behaviour is unchanged for every
   existing caller.

Case 2 is the owner's explicit choice over honour-with-a-warning.

## The fallback must be observable

A silent substitution is the failure mode this repo has been bitten by twice
(bench/src divergence; a malformed `namespaceOf` return producing plausible
garbage). So a fallback is reported, not swallowed:

- `stats.mapStyle` — what was actually used
- `stats.requestedMapStyle` — what the caller asked for, when it differed
- `stats.fallbackReason` — why, naming the model and the evidence

No throw, no console noise by default. The caller can assert on it; a test can
assert on it; nobody has to guess what shipped.

## The policy table is generated, never hand-written

`src/policy.generated.ts` is emitted by the analysis script from committed sweep
results. This is not a style preference — a hand-maintained table would rot exactly
the way `bench/` and `src/` diverged before, and the whole value here is that the
table is a record of measurements.

Each entry carries:

- exact model id (**not** a family — `gpt-5.6-sol` failing says nothing certain
  about `gpt-5.7`)
- style, pass rate, run count, malformed-arg count
- the sweep key and date it came from

A drift test fails if the generated file disagrees with the committed results,
mirroring the existing docs-in-sync guard.

## Honest limits, to be documented

This is a lookup table of measured facts with an expiry date, not a theory of
model behaviour. Specifically:

- A model absent from the table gets the conservative default. It is not a
  prediction.
- Model behaviour changes between versions; entries are timestamped so staleness
  is visible.
- Pass rates come from 12 scenarios on one 149-tool real corpus. A different
  workload may differ, which is why an explicit style request is honoured for
  anything not measured as broken.

## Out of scope

Auto-detecting the model from the caller's SDK client. Too magic, and wrong when a
proxy or gateway sits in between. The caller passes the id.
