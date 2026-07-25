# tool-compression

Shrink LLM tool definitions without making the model dumber.

An agent with 15 MCP servers can burn 30–50k tokens of context window on tool
definitions before the user types a word. This library compresses that block
and translates the model's calls back, so nothing downstream changes.

Model-agnostic, provider-agnostic, zero runtime dependencies, no network calls.

```bash
npm install tool-compression
```

---

## Quick start

```ts
import { compress, forAnthropic } from "tool-compression";

const c = compress(myTools);                    // level 1 by default
const { tools, system } = forAnthropic(c);      // adds the cache breakpoint

const res = await client.messages.create({
  model: "claude-opus-5",
  max_tokens: 8000,
  system: [{ type: "text", text: SYSTEM_PROMPT }, ...(system ?? [])],
  tools,
  messages,
});

for (const block of res.content) {
  if (block.type !== "tool_use") continue;
  const r = c.resolve(block.name, block.input);
  if (r.kind === "call")  await myDispatch(r.name, r.args);  // real name, real args
  if (r.kind === "meta")  feedBack(r.result);                // model asked a lookup question
  if (r.kind === "error") feedBack(r.message, { isError: true });
}
```

`myTools` is whatever your MCP server or SDK already produces — `{ name,
description, inputSchema }`. Both `inputSchema` and `input_schema` are accepted.

---

## Measured results

Claude Opus 5, `effort: "high"`, **150 runs** across 10 scenarios, $7.72.
Raw data in `bench/results/`. Reproduce with `npm run bench`.

| Strategy | Tool block | Avg prompt | Turns | Malformed args | Latency | Cost |
|---|---:|---:|---:|---:|---:|---:|
| uncompressed | 10,035 | 41,336 | 3.5 | 0 | 15.4s | $1.86 |
| **L1 signatures** | 7,322 | 30,475 | 3.5 | 0 | 14.4s | $1.54 |
| Anthropic native search | 1,644 | 16,430 | 3.1 | 0 | 16.2s | $2.19 |
| L2 namespace collapse | 2,086 | 13,560 | 4.7 | **12** | 17.4s | $1.27 |
| **L3 minified** | **1,146** | **7,432** | 4.1 | 2 | **12.9s** | **$0.86** |

Every arm completed every task — 48/48 tool calls correct, zero hallucinated
names anywhere. See [docs/RESULTS.md](docs/RESULTS.md) for the per-scenario
breakdown, the accuracy probe, and what these numbers do **not** establish.

Four things worth pulling out:

- **L3 wins on every axis except turn count.** −89% tool block, −82% prompt
  tokens, −54% cost, and it was the *fastest* arm despite +0.6 turns, because
  each turn is so much smaller.
- **Minification did not cost accuracy.** That was the design's central worry
  and the measurement contradicted it: 48/48 correct across clusters built
  specifically to confuse a code map. The model converts a recall problem into
  a retrieval problem — ~1.7 lookup calls per task — and gets there anyway.
- **L1 is free.** −26% prompt tokens, zero malformed arguments, zero extra
  turns, latency slightly better than control. No measured downside at all.
- **L2 is dominated and Anthropic's native search costs more than not
  compressing.** L2 produced six times L3's malformed arguments for worse
  compression. Native search has the second-smallest tool block but the highest
  bill of any arm — its server-side search runs its own inference. Tokens and
  dollars are not the same axis.

---

## Levels

```ts
compress(tools, { level: 0 | 1 | 2 | 3 })
```

| Level | What it does | Names | Constrained decoding | Use when |
|---|---|---|---|---|
| **0** | Passthrough | real | native | A/B control inside your own app |
| **1** | Flatten JSON Schema to signature lines | real | native | **Default.** Small or sparse tool sets. Zero measured downside. |
| 2 | Collapse namespaces into compound tools | real | middleware | You need real op names on the wire. Otherwise skip — dominated by 3. |
| **3** | Single dispatcher + opaque codes | codes | middleware | **Large, deep tool sets.** Biggest win; costs turns, not accuracy. |

Each level is a superset of the one below. The default is level 1 because a
library should not change your agent's turn profile on `npm install`;
`recommendLevel()` will tell you when level 3 is worth it.

### Level 1 — what actually shrinks

The tool *name* is not the cost. The JSON Schema envelope is.

```jsonc
// before — 420 tokens
{ "name": "github_create_pull_request",
  "description": "Create a new pull request in a GitHub repository.",
  "input_schema": { "type": "object", "properties": {
      "owner": { "type": "string", "description": "The account owner of the repository." },
      "repo":  { "type": "string", "description": "The name of the repository..." },
      /* … */ },
    "required": ["owner","repo","title","head","base"],
    "additionalProperties": false,
    "$schema": "http://json-schema.org/draft-07/schema#" } }
```

```
// after — description becomes one line, schema keeps only what constrains sampling
github_create_pull_request(owner,repo,title,head,base,body?,draft?) — Create a new pull request in a GitHub repository.
```

Enums, types, `required` and item types survive, so the provider's constrained
sampler keeps working. Prose descriptions and `$schema` boilerplate do not.

### Level 3 — the trade

One dispatcher (`t`) plus one lookup tool (`q`). The map lives in your system
prompt behind a cache breakpoint:

```
<toolmap>
a0 github_create_pull_request
a1 github_list_issues
b0 slack_post_message
</toolmap>
```

The model calls `t(f="a0", a={...})`. `q(c="a0")` expands a code to its full
signature and description; `q(s="pull request")` searches.

**What you give up:** provider-side constrained decoding. At levels 2 and 3 the
model fills a generic `object` argument bag, so the sampler is no longer
enforcing your schema. This library validates against the original schema
instead and returns a model-readable error.

That cost is measurable: levels 0, 1 and native search produced **zero**
malformed arguments across 150 runs; levels 2 and 3 produced all 14 between
them. Every one was caught by validation and recovered on retry — which is part
of why the dispatcher levels use more turns.

**What you do not give up, contrary to expectation:** selection accuracy. Level
3 scored 48/48 with zero hallucinated names, including on clusters built
specifically to confuse a code map. Benchmark it on your own tasks before
adopting it — this is one model and one catalogue — but the feared failure mode
did not appear.

---

## Picking a level

```ts
import { recommendLevel } from "tool-compression";

const { level, reason } = recommendLevel(myTools);
console.log(level, reason);
// 3  "100 tools across 9 namespaces (11.1 ops each) — deep enough that a single
//     dispatcher plus a cached code map beats per-tool definitions. Measured at
//     ~82% fewer prompt tokens with no accuracy penalty, at the cost of roughly
//     0.6 extra turns and 1.7 lookup calls per task. If your workload is
//     latency-critical rather than context-critical, drop to level 1."
```

It returns 1 or 3, never 2, and always explains itself. Two crossovers worth
knowing, both measured:

- **The dispatcher's overhead is per-namespace, not per-tool.** A wide, sparse
  set (20 namespaces, 1 op each) is *larger* under namespace collapse than at
  level 1. A deep set is much smaller. Tool count alone predicts the wrong
  level — the threshold is 4 ops per namespace.
- **Level 3 is smallest at every tool count** — but only after the map line was
  reduced to bare names. Carrying prose descriptors in the map made level 3
  *larger* than level 2 at 60 tools.

---

## Providers

```ts
import { forAnthropic, forOpenAI, forGemini } from "tool-compression";
```

| Adapter | Handles |
|---|---|
| `forAnthropic(c, { cache, ttl })` | Places one `cache_control` breakpoint on the last eligible tool. Skips tools carrying `defer_loading` — the API rejects that pairing. |
| `forOpenAI(c)` | Wraps in `{type:"function",function:{…}}`. Drops Anthropic server-side tools. Prefix caching is automatic, so there is no breakpoint to place. |
| `forGemini(c)` | Emits one `functionDeclarations` array, stripping keywords Gemini rejects. |

Adapters are pure functions and never mutate the `CompressResult`.

---

## Composing with Anthropic's native tool search

Anthropic ships server-side tool search (`tool_search_tool_regex_20251119` +
`defer_loading: true`). It defers *whole schemas*; this library shrinks *each
schema*. They are orthogonal — level 1 output can carry `defer_loading` and get
both effects:

```ts
const c = compress(myTools, { level: 1 });
const tools = [
  { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
  ...(c.tools as any[]).map((t, i) => (i < 5 ? t : { ...t, defer_loading: true })),
];
```

Two API constraints: at least one tool must stay non-deferred, and
`cache_control` cannot go on a deferred tool. `forAnthropic()` handles the second.

---

## What this library does not do

- It does not beat native tool search on tool-block size on Anthropic. It
  composes with it, and it works on providers that have no equivalent.
- It does not reduce your bill just because it reduces tokens. Cached tool
  blocks already read at ~0.1×; the win this library targets is **context-window
  occupancy**.
- It does not make level 3 safe. It makes level 3 *measurable*.

---

## API

| Export | |
|---|---|
| `compress(tools, opts?)` | → `CompressResult` |
| `recommendLevel(tools, namespaceOf?)` | → `{ level, reason, toolCount, namespaceCount, opsPerNamespace }` |
| `forAnthropic` / `forOpenAI` / `forGemini` | provider adapters |
| `signatureLine(tool, nameOverride?)` | render one signature |
| `flattenSchema(schema)` | strip prose from a JSON Schema |

`CompressOptions`: `level`, `namespaceOf`, `aliasOf`, `searchLimit`, `validate`.

`CompressResult`: `tools`, `systemPreamble`, `cachePreamble`, `resolve()`,
`codeFor()`, `stats`.

`resolve()` returns a discriminated union — `{kind:"call"|"meta"|"error"}`.
Errors carry `recoverable: boolean` and a message written for the model to read.

---

## Determinism

`compress()` is referentially transparent: same tools in, byte-identical
payload out. Tools are sorted by name, never left in iteration order.

This is a correctness property, not tidiness. Prompt caching is a prefix match —
one reordered tool silently invalidates the cache and erases the savings. There
is a test asserting byte-identical output across calls; it does not get deleted.

---

## Development

```bash
npm test              # 70 unit tests, no network
npm run bench         # full sweep against the live API (~$4, ~25 min)
npm run bench -- --accuracy --reps=4
npm run brain -- report
```

See [AGENTS.md](AGENTS.md) for methodology and
[.specify/memory/constitution.md](.specify/memory/constitution.md) for the
principles specs are checked against.

MIT
