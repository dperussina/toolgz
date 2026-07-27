# Level 4: tools compiled to Python

Branch `experiment/tools-as-code`. **Never run against a model. No accuracy data exists.**

## The idea

Levels 0–3 all derive the map mechanically from your JSON Schema, so they can only ever
rearrange information that is already there. When a catalogue's names collide, there is
nothing left to rearrange — an external 60-tool registry rendered 44 of 60 map lines
identical apart from the name, and the model keyword-matched its way to the wrong tool
3 times out of 3.

Level 4 breaks that ceiling by having a model rewrite the corpus first. Each tool becomes
one line of minified Python whose docstring says what it is for and when to prefer it over
a similar name:

```python
def append_to_article(article_id,section_title,content,append_reason,confidence):"add new end section to article, keeping existing text; prefer over update_article for additions"
```

## Bring your own model

`compileTools()` takes a `complete` function. The library never imports an SDK and never
sees a key, so zero runtime dependencies survives — the dependency is the caller's.

```ts
import { compileTools, compress } from "toolgz";

const { compiled, rejected } = await compileTools(myTools, {
  complete: async ({ system, user }) => yourModelClient.run(system, user),
});
const c = compress(myTools, { level: 4, compiled });
```

Or from the command line, which talks to the provider over `fetch` and therefore also
installs nothing:

```bash
npx toolgz compile --tools ./tools.json --out ./toolmap.json
npx toolgz compile --tools ./tools.json --provider openai --model gpt-5.6-sol
```

## Verification is the library's job

A compiled map that renames a tool or invents a parameter is **worse than no map**: the
model would confidently call something that does not exist, and it would surface as a
wrong dispatch rather than an error. So every line is checked against the real schema
before it is accepted — no rename, no invented parameter, no dropped required parameter,
docstring must be a single quoted string. Failures are retried individually and then
discarded; a discarded tool falls back to a bare signature line and is counted in
`stats.uncompiledTools`. Compilation degrades, it does not lie.

**149/149 compiled and verified** on the real corpus.

## Measured, real tokens (`count_tokens`, `claude-opus-5`, 149 real tools)

| level | tokens | saved | ambiguous map lines |
|---|---:|---:|---:|
| 0 uncompressed | 68,501 | — | — |
| 3 `name+required` | 2,987 | 95.6% | 101/149 |
| 3 `signature` | 8,711 | 87.3% | 56/149 |
| **4 compiled Python** | **12,441** | **81.8%** | **0/149** |

Round trip is 149/149 calling by real function name, with no resolver change — the
separator-insensitive lookup from 0.1.2 already accepted it.

Original JSON is 163,370 characters, 1,096 per tool. Compiled is 27,210, **183 per tool**.

## What was tried and rejected

Two mechanical alternatives were built first and **have been removed** from the branch:

- **`typescript` / `typescript-doc`** — the same idea as a `.d.ts`. Cost 1.8–2× `signature`
  and disambiguated no better, because the enum list was already doing that work and TS
  spells `"a" | "b"` where we spell `a|b`. The notation bought nothing measurable.
- **`signature-doc`** — the compact signature line plus the tool's own truncated first
  sentence. Same token cost as level 4 and reached zero ambiguity too, but the content is
  boilerplate where the corpus is boilerplate: *"[Financial] Accessorial revenue details
  for syncing"*. A compiled line says *"use for aggregates not line-item details"*.

The difference is not size, it is that one of them was written to disambiguate. One
compiled line captured *"blob (blob_container+blob_name) XOR external_url"* — a
mutual-exclusivity constraint **that is not in the schema at all**, so no mechanical style
could have produced it.

## Honest risks

1. **The docstring is a model's assertion about your tools.** Verification covers the
   contract — names, parameters — and cannot check whether *"safer than update_article"*
   is true. On a corpus whose descriptions are wrong or stale, the compiler faithfully
   compresses the wrong thing into something that reads authoritatively.
2. **A compiled map goes stale.** Re-running is manual today; a stale map is a map that
   lies. It needs a freshness check keyed on the corpus before this ships.
3. **Compilation costs a model call per batch.** One-off, but not free, and it must be
   re-run on every registry change.

## Before this can merge

- A tier-0 sweep: level 3 `signature` against level 4, 2 scenarios × 1 rep × 4 providers,
  about 24 runs. Level 4 costs ~1.4× `signature` in tokens, so the question is whether the
  written hints convert into correct picks.
- A staleness check.
- A decision on what happens when `compiled` is partial in production.
