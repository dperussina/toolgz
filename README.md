<h1>toolgz</h1>

<p><strong>Your agent spends 30–50k tokens of context on tool definitions before the user types a word. toolgz gets ~80% of it back.</strong></p>

<p>
<a href="#measured-results">720 benchmark runs</a> ·
4 frontier models ·
zero runtime dependencies ·
<a href="docs/BEFORE-AFTER.md">generated before/after</a>
</p>

```bash
npm install toolgz
```

---

## The problem

You connect a few MCP servers. Each ships 20–50 tools. Every tool is a JSON Schema with a
sentence of prose per parameter. That block renders at the **front of every single request**.

A realistic tool definition is ~420 tokens, and roughly 400 of them are prose the model
doesn't need in order to pick correctly. Fifty tools is 20k tokens. A hundred is 40k.

Prompt caching makes those tokens *cheap*. It does not make them take up less *room*.
Reclaiming the room is what this does.

## The fix, in three lines

```ts
import { compress, forAnthropic } from "toolgz";

const c = compress(myTools);                  // your existing MCP/SDK tool array
const { tools, system } = forAnthropic(c);    // send these instead
```

Then translate the model's call back before you dispatch:

```ts
const r = c.resolve(block.name, block.input);
if (r.kind === "call") await myDispatch(r.name, r.args);   // real name, real args
```

`myDispatch` gets exactly what it got before. **Nothing downstream changes.**

---

## Measured results

Four frontier models, six strategies, five tool-selection tasks, 3 reps —
**360 runs** on the current sweep (720 including the earlier Anthropic-only rounds).
Every raw per-run record is committed in [`bench/results/`](bench/results/); recompute any
figure with `npx tsx bench/analyze-multi.ts`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/savings-dark.svg">
  <img src="docs/img/savings-light.svg" alt="Prompt tokens saved versus uncompressed tool definitions, by compression level, for each of four providers">
</picture>

| Provider | Model | Tool block | Prompt tokens | Tasks |
|---|---|---:|---:|:-:|
| Anthropic | `claude-opus-5` | 9,242 → **1,284** | 32,513 → **5,850** (−82%) | 15/15 |
| Google | `gemini-3.1-pro-preview` | 5,264 → **732** | 10,948 → **2,182** (−80%) | 15/15 |
| xAI | `grok-4.5` | 6,421 → **775** | 15,201 → **2,988** (−80%) | 15/15 |
| OpenAI | `gpt-5.6-sol` | 2,752 → **573** | 7,492 → **2,338** (−69%) | 15/15 |

Reasoning is enabled on all four at high effort, so this is a like-for-like frontier
comparison. **60/60 tasks completed, zero hallucinated tool names.**

### It does not make the model worse

That was the thing to disprove, and we tried hard to. The task suite is built from
deliberately confusable tool clusters — `search_issues` vs `list_issues`, comment-vs-update,
approve-vs-merge, the same three products side by side — where the correct choice turns on
the tool name that compression takes away.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/reliability-dark.svg">
  <img src="docs/img/reliability-light.svg" alt="Task completion by level-3 map style and provider, showing bare names failing on grok-4.5">
</picture>

The model doesn't lose the ability to choose — it converts a recall problem into a retrieval
problem and looks up what it needs. The default map style exists because of the red cell:
bare tool names failed on `grok-4.5` **deterministically**, 3 of 3 attempts on one scenario,
answering with zero tool calls and no error raised. Naming the required arguments fixed it.

### Be honest about cost

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/cost-dark.svg">
  <img src="docs/img/cost-light.svg" alt="Prompt token reduction always positive; cost change negative on three providers and positive on OpenAI">
</picture>

Context is always reclaimed. **Money is not.** On three providers the bill drops 60–76%. On
OpenAI it goes **up 15%** — the dispatcher's extra turns cost more in reasoning tokens than
the smaller prompt saves.

If your constraint is context window, this wins everywhere. If your constraint is spend,
measure it on your own workload first.

---

## Which level to use

Ask the library. It returns 1 or 3, never 2, and explains itself:

```ts
import { recommendLevel } from "toolgz";
const { level, reason } = recommendLevel(myTools);
```

| Level | Sends | Real names | Provider schema enforcement | Use when |
|:-:|---|:-:|:-:|---|
| **1** | one native tool each, signature-line descriptions | yes | **yes** | **default.** Small or wide-and-sparse tool sets. Zero measured downside. |
| 2 | one compound tool per namespace | yes | no | you need readable op names on the wire. Otherwise skip. |
| **3** | one dispatcher + one lookup tool | codes | no | **large, deep tool sets.** The 80% number above. |

*(Level 0 is a passthrough, for A/B testing inside your own app.)*

**Level 1 is free** — measured: fewer tokens, zero malformed arguments, zero extra turns,
latency no worse. **Level 2 is dominated by level 3** on every axis, including producing more
malformed arguments; it is not a stepping stone.

### What level 3 actually looks like

Two tools on the wire regardless of how many you start with, and a map in the system prompt
behind a cache breakpoint:

```
<toolmap>
a0 github_create_issue owner,repo,title
a1 github_search_issues q
b0 slack_post_message channel,text
</toolmap>
```

The model calls `t(f="a0", a={…})`, and `q(c="a0")` expands a code to its full signature when
it needs the optional parameters.

**The trade:** at levels 2–3 the model fills a generic argument object, so the provider's
sampler no longer enforces your schema. toolgz validates against your *original* schema and
returns a model-readable error instead. That is why `validate` defaults to on — leave it on.

**Every artifact above is generated by running the library** — see
**[docs/BEFORE-AFTER.md](docs/BEFORE-AFTER.md)** for the full tools array and system prompt,
before and after, at every level, with real token counts and a live encode → decode round
trip. A test asserts that file matches the code, so it cannot drift.

---

## Documentation

| | |
|---|---|
| **[Complete guide](docs/GUIDE.md)** | Install → working agent loop. Per-provider setup for all four, prompt caching, MCP aggregation, troubleshooting. Start here. |
| **[Before / after](docs/BEFORE-AFTER.md)** | Generated, not illustrated. Both artifacts toolgz modifies, at every level. |
| **[Full results](docs/RESULTS.md)** | Every number, the methodology, and what it does **not** establish. |

## Providers

```ts
import { forAnthropic, forOpenAI, forOpenAIResponses, forGemini } from "toolgz";
```

Pure functions; they never mutate what you pass them.

| Adapter | Endpoint | Handles |
|---|---|---|
| `forAnthropic` | Messages API | Places one `cache_control` breakpoint; skips deferred tools, which the API rejects |
| `forOpenAIResponses` | `/v1/responses` | Flat tool shape. **Required if you want tools *and* reasoning** |
| `forOpenAI` | `/v1/chat/completions` | Nested tool shape |
| `forGemini` | `generateContent` | One `functionDeclarations` array |

xAI is OpenAI-compatible — use `forOpenAI` with `baseURL: "https://api.x.ai/v1"`.

---

## What this does not do

- **It does not reduce your bill just because it reduces tokens.** Measured: cheaper on
  three providers, 15% dearer on OpenAI. The claim is context-window occupancy.
- **It does not beat Anthropic's native tool search on tool-block size.** It composes with
  it, works where there is no equivalent, and is more reliable below the frontier tier —
  `defer_loading` completed only 6/30 tasks on Haiku 4.5, silently, because it lets the model
  *choose* whether to discover tools. A dispatcher makes discovery the entry point.
- **It has not been measured on a non-frontier model at level 3.** On Haiku 4.5, argument
  errors rose sharply (17 of 30 runs) — all caught and retried, no task lost, but that is the
  known edge.
- **It is not magic on ten tools.** Under ~15 tools there is little to reclaim;
  `recommendLevel()` will tell you so.

## Determinism

`compress()` is referentially transparent: same tools in, byte-identical payload out. Tools
are sorted, never left in iteration order.

This is a correctness property, not tidiness — prompt caching is a prefix match, so one
reordered tool silently re-bills your whole prompt. There is a test asserting byte-stability,
and it does not get deleted.

## Development

```bash
npm test        # 131 tests, offline, no cost
npm run build   # tsc → dist/ with .d.ts

npx tsx bench/harness/run-multi.ts --provider=all --reps=3 --variants   # costs money
npx tsx bench/analyze-multi.ts
npx tsx docs/generate-examples.ts
```

Methodology and repo conventions: [AGENTS.md](AGENTS.md).
Principles specs are checked against: [.specify/memory/constitution.md](.specify/memory/constitution.md).

MIT
