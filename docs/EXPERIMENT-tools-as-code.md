# Experiment: tools as code

> **Read the second half first.** The mechanical TypeScript transliteration below was a
> misreading of the brief and it lost. The idea that worked is **AI-compiled minified
> Python**, at the end.

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


---

# Part 2: AI-compiled minified Python — the idea that worked

The brief was not "transliterate the schema into code". It was: **have a model rewrite the
corpus as minified Python, where the docstring says how the tool is actually leveraged.**
That is a different thing, and it wins.

## How it works

`bench/compile-python.ts` is a **build step**, not a runtime one — the library has zero
runtime dependencies and cannot call a model. It batches the corpus to Claude and asks for
exactly one line per tool:

```python
def append_to_article(article_id,section_title,content,append_reason,confidence):"add new section to end of existing article; safer than update_article which replaces"
```

Required parameters bare, optional as `=0`, and the docstring carrying purpose plus *when
to prefer this over a similarly named tool*. The result is passed to
`compress(tools, { level: 3, mapStyle: "python", compiled })`.

**Every emitted line is verified against the real schema before it is accepted**: the tool
may not be renamed, no parameter may be invented, no required parameter may be dropped, and
the docstring must be a single quoted string. A line that fails is retried individually and
then discarded rather than shipped. A discarded tool falls back to a mechanical signature
line and is counted in `stats.uncompiledTools`, so partial compilation degrades instead of
breaking. **149/149 compiled and verified on the real corpus.**

## Measured, real tokens (`count_tokens`, `claude-opus-5`)

| style | tokens | saved vs L0 | % of 200k | ambiguous lines |
|---|---:|---:|---:|---:|
| L0 uncompressed | 68,501 | — | 34.3% | — |
| `name+required` | 2,987 | 95.6% | 1.5% | 101/149 |
| `signature` | 8,711 | 87.3% | 4.4% | 56/149 |
| **`python`** | **12,441** | **81.8%** | **6.2%** | **0/149** |
| `signature-doc` | 12,802 | 81.3% | 6.4% | 0/149 |
| `typescript-doc` | 18,781 | 72.6% | 9.4% | 0/149 |

**`python` is the cheapest style that carries semantics** — narrowly under `signature-doc`
and 34% under `typescript-doc`, at zero ambiguous lines. Round trip is 149/149 calling by
real function name, again with no resolver change.

## Why it beats `signature-doc`, which costs about the same

Size is a tie; content is not. `signature-doc` truncates the tool's own first sentence,
which on this corpus is frequently boilerplate — *"[Financial] Accessorial revenue details
for syncing"*. The compiled line is written to disambiguate:

- *"yearly accessorial charge rollup …; **use for aggregates not line-item details**"*
- *"add new section to end of existing article; **safer than update_article which replaces**"*
- *"Gemini multimodal on Azure blob **OR** url (pass one); analysis_type:vision|audio|document|code_execution"*

The last one states a mutual-exclusivity constraint **that is not in the schema at all**.
No mechanical style can produce that, because the information is not there to transform.

## What is still unmeasured

No model has been run against this. Zero accuracy, turn-count or malformed-argument data
exists. Two specific risks a live run has to answer:

1. **The compiled docstring is an assertion by a model about another tool.** Verification
   covers the contract — names, parameters — but nothing checks that *"safer than
   update_article"* is true. A confidently wrong hint is worse than no hint.
2. Compilation is a one-off cost that must be re-run whenever the registry changes, and a
   stale compiled map is a map that lies. It needs a freshness check keyed on the corpus.

## Proposed next step

Tier-0: arms `signature`, `signature-doc`, `python`, 2 scenarios × 1 rep × 4 providers,
about 24 runs. `python` and `signature-doc` cost the same, so the comparison isolates
exactly one variable — whether an AI-written disambiguating hint beats a truncated first
sentence.
