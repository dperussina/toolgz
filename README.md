<h1>toolgz</h1>

<p><strong>Your agent spends 30–50k tokens of context on tool definitions before the user types a word. toolgz gets ~80% of it back.</strong></p>

<p>
<a href="#measured-results">420-run cross-provider sweep</a> ·
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

Four frontier models, seven strategies, five tool-selection tasks, 3 reps —
**420 runs** on the current sweep, 1,200+ across all rounds. Every raw per-run record is
committed in [`bench/results/`](bench/results/); recompute any figure with
`npx tsx bench/analyze-multi.ts`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/savings-dark.svg">
  <img src="docs/img/savings-light.svg" alt="Prompt tokens saved versus uncompressed tool definitions, by compression level, for each of four providers">
</picture>

| Provider | Model | Tool block | Prompt tokens | Cost | Latency | Tasks |
|---|---|---:|---:|---:|---:|:-:|
| Anthropic | `claude-opus-5` | 9,242 → **1,284** | 30,817 → **4,628** (−85%) | **−78%** | 15.0s → **12.1s** | 15/15 |
| xAI | `grok-4.5` | 6,421 → **775** | 17,522 → **2,663** (−85%) | **−70%** | 6.1s → **4.6s** | 15/15 |
| Google | `gemini-3.1-pro-preview` | 5,264 → **732** | 10,948 → **2,302** (−79%) | **−62%** | 5.6s → **5.5s** | 15/15 |
| OpenAI | `gpt-5.6-sol` | 2,752 → **573** | 7,694 → **2,196** (−71%) | **−7%** | 6.8s → **5.6s** | 15/15 |

Reasoning is enabled on all four at high effort, so this is a like-for-like frontier
comparison. **60/60 tasks completed, zero hallucinated tool names, zero malformed
arguments** — and it is faster than uncompressed on every provider.

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

### Cost, and why it took two rounds to get right

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/cost-dark.svg">
  <img src="docs/img/cost-light.svg" alt="Prompt tokens and cost both reduced on all four providers">
</picture>

The first cross-provider sweep found cost going **up 15% on OpenAI** even while context fell
69%. The dispatcher was spending extra turns, and on a reasoning model every turn pays for a
fresh round of thinking.

So we captured the calls that were being rejected instead of guessing, and found three bugs
in *this library*: models pass `query` to a parameter named `q` (14 of 18 rejections), they
sometimes call the map code as the tool name, and they sometimes pass arguments flat instead
of nested. Fixing all three took OpenAI from **+15% to −7%** and drove malformed arguments to
**zero on every provider**.

OpenAI's −7% is still the smallest saving, and honestly so: reasoning output dominates its
bill, so a smaller prompt moves the total less. **Context-window occupancy remains the
primary claim** — cost follows from it, by an amount that depends on your reasoning settings.

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

If you want to remove those lookups entirely, put the whole signature in the map:

```ts
compress(myTools, { level: 3, mapStyle: "signature" });
// a0 github_create_issue(owner,repo,title,body?,labels?)
```

Measured: lookups drop to zero and it was the **fastest and cheapest** arm on OpenAI (4.0s,
−17% cost). It is slightly larger, and on xAI it was worse than the default, so it is an
option rather than the default.

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
| **[Announcement drafts](docs/ANNOUNCEMENT.md)** | Ready-to-post write-ups for HN and LinkedIn, plus claims *not* to make. |
| **[Releasing](docs/RELEASING.md)** | Publishing to npm over OIDC, with no long-lived token. |

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

- **The size of the cost saving is not the size of the token saving.** Measured 62–78%
  cheaper on three providers but only 7% on OpenAI, where reasoning output dominates the
  bill. The claim is context-window occupancy; cost follows, by a variable amount.
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
Principles specs are checked against: [docs/CONSTITUTION.md](docs/CONSTITUTION.md).

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Apache-2.0 rather than MIT deliberately: it carries an express patent grant and
a patent-retaliation clause, which matters for a library implementing a
technique rather than just glue code, and it is the license most enterprises
prefer in a dependency.
