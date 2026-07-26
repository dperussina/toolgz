<h1>toolgz</h1>

<p><strong>Your agent spends 30–70k tokens of context on tool definitions before the user types a word. toolgz gets ~80% of it back.</strong></p>

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
`npx tsx bench/analyze-multi.ts --sweep=<timestamp>`.

**The table below uses a synthetic catalogue** — 100 realistic-but-invented MCP-style
tools across 9 namespaces — because it lets us build deliberately confusable clusters
that a real catalogue may not contain. Two things follow from that, and the first is
uncomfortable:

- Synthetic naming can flatter a compression style. One map style measured −21% on
  this fixture because every tool name carried a `namespace_op` prefix to factor out.
  On real MCP tools, which mostly do not, the same style was worth −1%.
- Real catalogues are **bigger**, so these numbers understate the problem. A corpus of
  **149 tools harvested from 14 live MCP servers** measures **68,494 prompt tokens**
  uncompressed on `claude-opus-5` — more than twice the synthetic fixture, and about a
  third of a 200k context window before the user types anything.

The real corpus is committed at [`bench/fixtures/real-mcp-tools.json`](bench/fixtures/real-mcp-tools.json)
with its own scenario suite (`--suite=real`), and it is the corpus of record for any
claim about real deployments.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/savings-dark.svg">
  <img src="docs/img/savings-light.svg" alt="Prompt tokens saved versus uncompressed tool definitions, by compression level, for each of four providers">
</picture>

| Provider | Model | Tool block | Prompt tokens | Latency | Tasks |
|---|---|---:|---:|---:|:-:|
| Anthropic | `claude-opus-5` | 9,242 → **1,284** | 30,817 → **4,628** (**−85%**) | 15.0s → **12.1s** | 15/15 |
| xAI | `grok-4.5` | 6,421 → **775** | 17,522 → **2,663** (**−85%**) | 6.1s → **4.6s** | 15/15 |
| Google | `gemini-3.1-pro-preview` | 5,264 → **732** | 10,948 → **2,302** (**−79%**) | 5.6s → **5.5s** | 15/15 |
| OpenAI | `gpt-5.6-sol` | 2,752 → **573** | 7,694 → **2,196** (**−71%**) | 6.8s → **5.6s** | 15/15 |

Reasoning is enabled on all four at high effort, so this is a like-for-like frontier
comparison. **60/60 tasks completed, zero hallucinated tool names, zero malformed
arguments** — and it is faster than uncompressed on every provider.

Recompute any figure with
`npx tsx bench/analyze-multi.ts --sweep=2026-07-25T19-19` against the raw per-run
records in [`bench/results/`](bench/results).

### What about cost?

**Cost is not the claim, and we deliberately do not lead with it.** Prompt caching
already makes tool tokens cheap. What caching does not do is give you the *room* back,
and the room is what you run out of.

Cost does usually fall as a side effect, by an amount that depends on your provider
and reasoning settings — and on one of four providers we measured, it does not fall at
all. On `gpt-5.6-sol` the uncompressed cost distribution is heavily right-skewed (mean
$0.0172, median $0.0052), so a few expensive runs make compression look break-even
while the *typical* run gets about 2.5× dearer. We used to publish a "−7% on OpenAI"
figure. It was a mean over a skewed distribution and we withdrew it.

If you do want to optimise the bill, it is one option — and it is a trade, not a
freebie:

```ts
compress(myTools, { level: 3, model: "gpt-5.6-sol", objective: "cost" });
```

| Model | Median cost vs default |
|---|---:|
| `gpt-5.6-sol` | **−20.7%** |
| `gemini-3.1-pro-preview` | **−15.4%** |
| `claude-opus-5` | **−9.0%** |
| `grok-4.5` | **+13.2%** — so it is not enabled there |

From 432 runs, 36 per style per provider, on the real 149-tool corpus. **What you give
up:** a slightly larger cached map (+275 characters), and on `grok-4.5` a worse bill —
which is why that row keeps the default rather than the cost-optimised style. Omit
`objective` and you get the conservative default everywhere, unchanged.

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

### How we found the cost story, and got it wrong twice

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/img/cost-dark.svg">
  <img src="docs/img/cost-light.svg" alt="Prompt tokens and cost, by compression level, for each of four providers">
</picture>

The first cross-provider sweep found cost going **up 15% on OpenAI** even while context
fell 69%. The dispatcher was spending extra turns, and on a reasoning model every turn
pays for a fresh round of thinking.

So we captured the calls being rejected instead of guessing, and found three bugs in
*this library*: models pass `query` to a parameter named `q` (14 of 18 rejections), they
sometimes call the map code as the tool name, and they sometimes pass arguments flat
instead of nested. Fixing all three drove malformed arguments to **zero on every
provider**. Later rounds found three more of the same kind — a namespace joined with a
dot, the lookup tool routed through the dispatcher — all shipped in 0.1.2.

That is the honest shape of this work: **most of the wins came from accepting what
models actually send, not from making the map smaller.** One extra turn is worth ~3,300
prompt tokens; the best encoding change available was worth ~550. Six map styles were
tried and removed in 0.2.0 because they were smaller and still worse.

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

## Optional: let the library pick the map style for your model

Level 3 has several map styles. Which one is cheapest turns out to depend on the
model, so you can hand `compress()` a model id and let it use what was actually
measured:

```ts
compress(myTools, { level: 3, model: "gpt-5.6-sol", objective: "cost" });
```

| Model | Style chosen for `cost` | Measured against the default |
|---|---|---:|
| `gpt-5.6-sol` | `explicit` | **−20.7%** |
| `gemini-3.1-pro-preview` | `explicit` | **−15.4%** |
| `claude-opus-5` | `explicit` | **−9.0%** |
| `grok-4.5` | *default* | `explicit` measured **+13.2%** there |

From a 432-run sweep, 36 runs per style per provider, on the real 149-tool corpus.
`explicit` completed 144/144 tasks and cut lookups on all four providers; only the
*cost* consequence differs by model. The table lives in
[`src/policy.generated.ts`](src/policy.generated.ts), is generated from the committed
results, and a test fails if it drifts from them.

Four things worth knowing:

- **Omitting `model` changes nothing.** Existing behaviour is byte-identical; there
  is a test asserting that.
- **`objective` defaults to `occupancy`, which has no table.** Every style we
  measured landed within ±3.1% of the default on context occupancy — under our 5%
  effect-size floor — so there is nothing to select. Only `cost` has entries.
- **An absent model gets the default.** That is an absence of evidence, not a
  prediction. `gpt-5.6-sol` behaving one way says nothing certain about `gpt-5.7`.
- **`stats` always tells you what was actually used**, so nothing is substituted
  silently:

```ts
const c = compress(myTools, { level: 3, model: "gpt-5.6-sol", objective: "cost" });
c.stats.mapStyle;          // "explicit" — what was used
c.stats.requestedMapStyle; // undefined — you did not ask for a specific style
c.stats.fallbackReason;    // undefined — nothing was substituted
```

There is also a safety valve: if a future sweep finds a `(model, style)` pair that
fails, it is refused and `stats.fallbackReason` says why. **That table is currently
empty** — the one pair ever measured unsafe was `nocode` on `grok-4.5` (19% of runs
answered with no tool call at all), and rather than document a footgun we deleted the
style in 0.2.0.

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
