# Experiment: tools as code

Branch `experiment/tools-as-code`. **Not merged, not released, not behaviourally tested.**

## Hypothesis

LLMs have enormous priors for reading typed function declarations and none for our
positional map lines. So rendering the catalogue as a TypeScript `.d.ts` should let the
model pick tools more reliably than `code name required-args`.

This was worth testing because an external 60-tool registry had just shown that when a
map is ambiguous, **legibility beats size**: `mapStyle: "signature"` cost 4x the tokens of
`name+required` and took wrong picks from 3/3 to 0/3.

## What was built

Two new level-3 map styles, plus a third that the results pointed at:

- **`typescript`** — the catalogue as `declare namespace X { function op(a: string, b?: number): void }`,
  grouped by the same `namespaceOf` the rest of the library uses. Enums become string-literal
  unions. Called with the real dotted name, `t(f="github.create_issue", a={…})` — the
  separator-insensitive resolver added in 0.1.2 already accepts that, verified **149/149**
  round trip on the real corpus with no resolver change.
- **`typescript-doc`** — as above plus a one-line JSDoc per function.
- **`signature-doc`** — the *existing* compact signature line plus a short descriptor. Added
  after the first two measurements, for the reason in the verdict.

## Result: the code hypothesis is not supported

Ambiguity is `stats.ambiguousMapLines` — map entries indistinguishable from at least one
other once code and name are removed. Lower is better.

**Their 60-tool `manage_*` registry, the case this was meant to fix:**

| style | chars | vs `signature` | ambiguous | largest group |
|---|---:|---:|---:|---:|
| `name+required` | 2,308 | 20% | 44/60 | 24 |
| `signature` | 11,417 | 100% | 2/60 | 2 |
| **`signature-doc`** | **15,948** | **140%** | **0/60** | **1** |
| `typescript` | 20,222 | 177% | 2/60 | 2 |
| `typescript-doc` | 25,158 | 220% | 0/60 | 1 |

**Our 149-tool real corpus:**

| style | chars | vs `signature` | ambiguous | largest group |
|---|---:|---:|---:|---:|
| `name+required` | 5,721 | 33% | 101/149 | 66 |
| `signature` | 17,469 | 100% | 56/149 | 12 |
| **`signature-doc`** | **28,880** | **165%** | **0/149** | **1** |
| `typescript` | 34,567 | 198% | 54/149 | 11 |
| `typescript-doc` | 47,006 | 269% | 0/149 | 1 |

Two findings, both consistent across corpora:

1. **`typescript` costs 1.8–2x `signature` and disambiguates no better** — 2/60 against
   2/60, 54/149 against 56/149. The TypeScript *notation* buys nothing measurable. What
   was already doing the work in `signature` is the enum list, which it renders as
   `a|b|c` where TS renders `"a" | "b" | "c"` — same information, three times the
   characters.
2. **What closes the gap is the doc comment, not the code.** `typescript-doc` reaches zero
   ambiguous lines — and so does `signature-doc`, at **61–63% of the size**.

So the experiment produced a better candidate than the one it set out to test, and it is
not written in TypeScript.

## What this does not settle

Ambiguity is a proxy for the thing we actually care about. The original hypothesis has a
second limb that offline measurement cannot reach: **typed parameters might reduce
malformed arguments** even where lines are already distinct. `operation: "create" | "list"`
is a constraint a model may honour more reliably than `operation:create|list`. That is a
live-run question, and it is the only remaining reason to test `typescript`.

Nothing here has been run against a model. No accuracy, turn-count or malformed-argument
figure exists for any of the three new styles.

## Proposed next step

A tier-0 sweep on the real suite, arms `signature`, `signature-doc`, `typescript`, 2
scenarios × 1 rep × 4 providers ≈ 24 runs. It answers two questions: whether the doc hint
converts its disambiguation into correct picks, and whether TS types reduce malformed
arguments enough to justify 1.8x.

If `signature-doc` wins, it also resolves an older open item: the `terse` style removed in
0.2.0 was a purpose hint disqualified on a corpus of uniquely-named verb-first tools that
never exhibited this failure mode.

## Status of each style

| style | keep? |
|---|---|
| `signature-doc` | **candidate** — measure live before shipping |
| `typescript` | dominated on size/ambiguity; only a malformed-argument win could save it |
| `typescript-doc` | dominated by `signature-doc` at equal ambiguity |
