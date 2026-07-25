# toolgz — the complete guide

From `npm install` to a working compressed agent loop. No prior context needed.

If you only have two minutes, read [§1](#1-the-two-minute-version) and stop.

**Contents**

1. [The two-minute version](#1-the-two-minute-version)
2. [What just happened](#2-what-just-happened)
3. [Which level should I use?](#3-which-level-should-i-use)
4. [The agent loop, in full](#4-the-agent-loop-in-full)
5. [Handling the three outcomes](#5-handling-the-three-outcomes)
6. [Provider setup: Anthropic, OpenAI, Google, xAI](#6-provider-setup)
7. [Prompt caching — do this, it's most of the value](#7-prompt-caching)
8. [Composing with Anthropic's native tool search](#8-composing-with-anthropics-native-tool-search)
9. [MCP servers](#9-mcp-servers)
10. [Troubleshooting](#10-troubleshooting)
11. [Benchmarking your own tools](#11-benchmarking-your-own-tools)
12. [API reference](#12-api-reference)

---

## 1. The two-minute version

```bash
npm install toolgz
```

You have tool definitions already. They look like this — the shape every MCP
server and SDK produces:

```ts
const myTools = [
  {
    name: "github_create_issue",
    description: "Create a new issue in a GitHub repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The account owner of the repository." },
        repo:  { type: "string", description: "The name of the repository." },
        title: { type: "string", description: "The title of the issue." },
      },
      required: ["owner", "repo", "title"],
    },
  },
  // …49 more
];
```

Wrap them:

```ts
import { compress, forAnthropic } from "toolgz";

const c = compress(myTools);
const { tools, system } = forAnthropic(c);
```

Send `tools` instead of `myTools`. When the model calls something, translate it
back before you dispatch:

```ts
const r = c.resolve(block.name, block.input);
if (r.kind === "call") await myDispatch(r.name, r.args);   // real name, real args
```

That's it. `myDispatch` receives exactly what it received before — the real tool
name and the real arguments. Nothing downstream changes.

---

## 2. What just happened

`compress()` rewrote your tool definitions into a smaller wire format and gave
you a translator back.

The saving is **not** in the tool names. It's in the JSON Schema envelope. A
realistic tool definition is ~420 tokens, and about 400 of them are prose:

```jsonc
{
  "name": "github_create_pull_request",              // ~6 tokens
  "description": "Create a new pull request…",       // ~25 tokens
  "input_schema": {
    "type": "object",
    "properties": {
      "owner": { "type": "string",
                 "description": "The account owner of the repository." },
      "repo":  { "type": "string",
                 "description": "The name of the repository without .git." },
      // …five more, each with a sentence
    },
    "required": ["owner","repo","title","head","base"],
    "additionalProperties": false,
    "$schema": "http://json-schema.org/draft-07/schema#"   // pure overhead
  }
}
```

At the default level that becomes one line:

```
github_create_pull_request(owner,repo,title,head,base,body?,draft?) — Create a new pull request in a GitHub repository.
```

Types, enums, `required` and array item types all survive, so the provider's
constrained sampler keeps enforcing your schema. Only the prose goes.

**Why this matters:** tool definitions sit at the front of every request. With
15 MCP servers connected you can spend 30–50k tokens of context window before
the user types a character. Caching makes those tokens *cheap*; it does not make
them take up less *room*. Reclaiming the room is the point.

---

## 3. Which level should I use?

Ask the library:

```ts
import { recommendLevel } from "toolgz";

const { level, reason } = recommendLevel(myTools);
console.log(level, reason);
```

It returns 1 or 3, never 2, and always explains itself:

```
3  100 tools across 9 namespaces (11.1 ops each) — deep enough that a single
   dispatcher plus a cached code map beats per-tool definitions. Measured at
   ~82% fewer prompt tokens with no accuracy penalty across Opus 5, Sonnet 5
   and Haiku 4.5, at the cost of roughly 0.6 extra turns and 1.7 lookup calls
   per task. Keep argument validation on…
```

If you'd rather decide yourself:

| Level | What it sends | Real tool names? | Provider schema enforcement | Pick it when |
|:-:|---|:-:|:-:|---|
| **0** | your tools, untouched | yes | yes | you want an A/B control in your own app |
| **1** | one native tool each, signature-line descriptions | yes | **yes** | **default.** Fewer than ~15 tools, or many namespaces with few operations each |
| 2 | one compound tool per namespace | yes | no | you specifically need readable operation names on the wire |
| **3** | one dispatcher + one lookup tool | codes | no | **large, deep tool sets.** Biggest win |

Two things worth internalising:

- **Level 1 is free.** Measured: fewer tokens, zero malformed arguments, zero
  extra turns, latency no worse. There is no reason not to run it.
- **Level 2 is dominated by level 3** on every axis we measured, including
  producing more malformed arguments. It exists for the narrow case where you
  need real operation names visible on the wire. It is not a stepping stone.

Set it explicitly like this:

```ts
const c = compress(myTools, { level: 3 });
```

### Level 3 in one picture

Level 3 sends two tools — `t` (dispatch) and `q` (lookup) — and puts a code map
in your system prompt:

```
<toolmap>
a0 github_create_issue
a1 github_list_issues
b0 slack_post_message
</toolmap>
```

The model calls `t(f="a0", a={owner:"acme", repo:"web", title:"Bug"})`. If it
isn't sure what a code takes, it calls `q(c="a0")` and gets the full signature
and description back. `q(s="pull request")` searches by keyword.

**The trade:** at levels 2 and 3 the model fills a generic `object` argument
bag, so the provider's sampler is no longer enforcing your schema. toolgz
validates against your original schema instead and hands the model back an error
it can act on. This is why `validate` defaults to `true` — leave it on.

If you're on level 3 and want to cut argument errors further, add the required
parameter names to the map:

```ts
compress(myTools, { level: 3, mapStyle: "name+required" });
// map lines become:  a0 github_create_issue owner,repo,title
```

That costs a handful of tokens per tool against a full schema's ~400, and in
measurement it *reduced* total tokens — the model needs fewer lookup round-trips,
so the conversation gets shorter.

---

## 4. The agent loop, in full

A complete, working Anthropic loop. The only additions to a normal loop are the
`compress()` call at the top and the `resolve()` call before dispatch.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { compress, forAnthropic } from "toolgz";

const client = new Anthropic();
const SYSTEM = "You are a helpful operations agent. Use the tools available.";

// 1. Compress once, outside the loop. It is pure and deterministic.
const c = compress(myTools, { level: 3 });
const { tools, system } = forAnthropic(c);

export async function run(userMessage: string) {
  const messages: any[] = [{ role: "user", content: userMessage }];

  for (let turn = 0; turn < 12; turn++) {
    const res = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 8000,
      system: [{ type: "text", text: SYSTEM }, ...(system ?? [])],
      tools: tools as any,
      messages,
    });

    const calls = res.content.filter((b: any) => b.type === "tool_use");
    if (!calls.length) return res;          // model is done

    // 2. Echo the assistant turn back verbatim. On Anthropic this matters:
    //    thinking blocks must be returned unchanged or the model re-reasons.
    messages.push({ role: "assistant", content: res.content });

    const results: any[] = [];
    for (const call of calls) {
      const r = c.resolve(call.name, (call as any).input);

      if (r.kind === "call") {
        const output = await myDispatch(r.name, r.args);   // your real handler
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(output),
        });
      } else if (r.kind === "meta") {
        // The model asked toolgz a lookup question. Answer it; don't dispatch.
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: r.result,
        });
      } else {
        // Bad arguments or an unknown code. The message is written for the
        // model to read — hand it straight back and let it retry.
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: `Error: ${r.message}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: results });
  }
}
```

Three rules that matter:

1. **Call `compress()` once**, outside the loop. Calling it per turn is wasteful
   and, if you vary the options, breaks prompt caching.
2. **Never dispatch on `meta` or `error`.** Only `kind === "call"` is a real
   tool invocation.
3. **Feed errors back rather than throwing.** Recovery is the design; the error
   strings are written for the model.

---

## 5. Handling the three outcomes

`resolve()` returns a discriminated union. Handle all three.

```ts
const r = c.resolve(rawName, rawArgs);

switch (r.kind) {
  case "call":
    // r.name  → the original tool name, e.g. "github_create_issue"
    // r.args  → validated against your original schema
    await myDispatch(r.name, r.args);
    break;

  case "meta":
    // The model used a toolgz lookup tool (q / describe_op).
    // r.result is text to return as the tool result. Do not dispatch.
    reply(r.result);
    break;

  case "error":
    // r.message    → model-readable: names the tool, the parameter, the fix
    // r.recoverable → true when retrying can plausibly succeed
    reply(r.message, { isError: true });
    break;
}
```

What produces each:

| Outcome | Cause | You should |
|---|---|---|
| `call` | valid invocation | dispatch it |
| `meta` | model asked for a definition or searched the map | return `r.result` as the tool result |
| `error` | missing/unknown/wrong-typed argument, or an unknown code | return `r.message` with an error flag |

Argument validation runs against your **original** schema, not the compressed
one, so an `error` here means the call genuinely would not have worked.

---

## 6. Provider setup

The core is provider-neutral. Adapters handle wire shape and cache placement.
They are pure functions and never mutate what you pass them.

### Anthropic

```ts
import { compress, forAnthropic } from "toolgz";

const c = compress(myTools, { level: 3 });
const { tools, system } = forAnthropic(c);          // or { ttl: "1h" }

await client.messages.create({
  model: "claude-opus-5",
  max_tokens: 8000,
  system: [{ type: "text", text: SYSTEM }, ...(system ?? [])],
  tools,
  messages,
});
```

`forAnthropic` places exactly one `cache_control` breakpoint on the last
eligible tool, and skips any tool carrying `defer_loading` because the API
rejects that combination.

### OpenAI

```ts
import { compress, forOpenAI } from "toolgz";

const c = compress(myTools, { level: 3 });
const { tools, systemPreamble } = forOpenAI(c);

await client.chat.completions.create({
  model: "gpt-5.6-sol",
  messages: [
    { role: "system", content: SYSTEM + (systemPreamble ? "\n\n" + systemPreamble : "") },
    ...messages,
  ],
  tools,
});
```

OpenAI's prefix caching is automatic with a ~1024-token floor, so there is no
breakpoint to place — just keep your prefix stable.

> **Note:** on `/v1/chat/completions`, GPT-5.x rejects function tools combined
> with reasoning. If you need both, use `/v1/responses`.

### Google Gemini

```ts
import { compress, forGemini } from "toolgz";

const c = compress(myTools, { level: 3 });
const { tools, systemPreamble } = forGemini(c);

await ai.models.generateContent({
  model: "gemini-3.1-pro-preview",
  contents,
  config: {
    systemInstruction: SYSTEM + (systemPreamble ? "\n\n" + systemPreamble : ""),
    tools,
  },
});
```

`forGemini` strips the JSON Schema keywords Gemini rejects
(`additionalProperties`, `$schema`, `default`, `examples`) recursively.

### xAI

xAI's API is OpenAI-compatible, so use `forOpenAI`:

```ts
import OpenAI from "openai";
import { compress, forOpenAI } from "toolgz";

const client = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: "https://api.x.ai/v1",
});
const { tools, systemPreamble } = forOpenAI(compress(myTools, { level: 3 }));
```

> **Note:** xAI excludes reasoning tokens from `completion_tokens`. If you're
> tracking spend, add `usage.completion_tokens_details.reasoning_tokens`.

---

## 7. Prompt caching

**Read this even if you skip everything else.** Prompt caching is what makes the
per-turn cost of your tool block collapse, and it is easy to break by accident.

Caching is a **prefix match**. Any byte that changes invalidates everything after
it. Tool definitions render first, so a single reordered tool re-bills your whole
prompt.

`compress()` is built for this: it sorts tools by name and emits byte-identical
output for identical input. There is a test asserting it, and that test does not
get deleted.

What breaks caching — check your own code for these:

| Mistake | Why it breaks |
|---|---|
| `new Date().toISOString()` in the system prompt | prefix differs every request |
| a request id or UUID near the top | same |
| building tools from an unsorted `Set`/`Map` | serialization order drifts |
| calling `compress()` with different options per turn | different payload |
| adding or removing a tool mid-conversation | tool block is position 0 |

Verify it's working — don't assume:

```ts
const res = await client.messages.create({ /* … */ });
console.log(res.usage.cache_read_input_tokens);   // should be > 0 after turn 1
```

If that stays `0` across turns with an identical prefix, something upstream is
varying. Diff two rendered request bodies to find it.

---

## 8. Composing with Anthropic's native tool search

Anthropic ships server-side tool search (`tool_search_tool_regex_20251119` plus
`defer_loading: true`). It defers *whole schemas*; toolgz shrinks *each schema*.
They're orthogonal and compose:

```ts
const c = compress(myTools, { level: 1 });
const tools = [
  { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
  ...(c.tools as any[]).map((t, i) => (i < 5 ? t : { ...t, defer_loading: true })),
];
```

Two API constraints: at least one tool must stay non-deferred, and
`cache_control` cannot go on a deferred tool (`forAnthropic` handles the second).

**One measured caveat.** `defer_loading` hides tools until the model *elects to
search*. On Claude Opus 5 it elects reliably — 20/20 tasks. On Haiku 4.5 it
often does not: **6 of 30 tasks**, with four of five scenarios answered in a
single turn and zero tool calls. No error is raised; the request succeeds and the
answer is simply unaided.

A dispatcher doesn't share that failure mode, for a structural reason: `t` and
`q` are ordinary always-visible tools, so the model cannot forget to search —
searching is the only thing on offer. Deferred loading makes discovery
*optional*; a dispatcher makes it *the entry point*.

Rule of thumb: compose with native search on frontier models; prefer level 3
alone below that tier.

---

## 9. MCP servers

MCP tool definitions already match the input shape, so there's nothing to
convert:

```ts
const { tools: mcpTools } = await mcpClient.listTools();
const c = compress(mcpTools, { level: 3 });
```

Aggregating several servers is where the payoff is largest. Namespace the names
so the grouping is meaningful:

```ts
const all = [];
for (const [serverName, client] of servers) {
  const { tools } = await client.listTools();
  all.push(...tools.map((t) => ({ ...t, name: `${serverName}_${t.name}` })));
}

const c = compress(all, { level: 3 });
```

Default namespacing splits on the first `_` or `.`. Override it if your names
don't follow that convention:

```ts
compress(all, {
  level: 3,
  namespaceOf: (name) => {
    const [ns, ...rest] = name.split("::");
    return { ns, op: rest.join("::") };
  },
});
```

---

## 10. Troubleshooting

**The model calls `t` or `q` and my dispatcher explodes.**
You're dispatching on every tool call. Only `kind === "call"` is real; `meta`
and `error` are toolgz's own tools and must be answered, not dispatched. See
[§5](#5-handling-the-three-outcomes).

**`resolve()` returns `error: unknown parameter "x"`.**
The model invented a parameter. Feed `r.message` back as an error tool result —
it names the accepted parameters and the model will retry. This is expected on
levels 2 and 3 and is exactly what validation is for.

**Lots of malformed arguments on a weaker model.**
Expected, and it's formatting rather than tool choice. Two fixes: use
`mapStyle: "name+required"` at level 3 (measured to reduce both errors *and*
total tokens), or drop to level 1, which keeps provider-side schema enforcement.

**`cache_read_input_tokens` is always 0.**
Something in your prefix varies per request. See [§7](#7-prompt-caching).

**Gemini rejects my schema.**
Use `forGemini`, which strips the keywords Gemini won't accept. If a new one
appears, it's a one-line addition to the adapter.

**Savings look small.**
Check tool count and shape with `recommendLevel(myTools)`. Under ~15 tools
there's little to reclaim. Also check `c.stats`:

```ts
console.log(c.stats);
// { level: 3, toolCount: 100, wireToolCount: 2,
//   originalChars: 61461, compressedChars: 2211, savedPct: 96.4 }
```

`savedPct` is a character-count proxy, not a token count — useful for a quick
sanity check, not for billing.

**I need the real token numbers.**
Count them with the provider's own endpoint. Never use `tiktoken` for Claude —
it's OpenAI's tokenizer and is wrong for Claude by 15–20%+.

```ts
const { input_tokens } = await client.messages.countTokens({
  model: "claude-opus-5",
  tools: tools as any,
  system: SYSTEM,
  messages: [{ role: "user", content: "x" }],
});
```

---

## 11. Benchmarking your own tools

Don't take our numbers for your workload — especially at level 3. The repo ships
the harness:

```bash
git clone https://github.com/dperussina/toolgz
cd toolgz && npm install
cp .env.example .env          # add your keys

npm test                      # 107 offline tests, no network, no cost

# one provider, one scenario, cheap
npx tsx bench/harness/run-multi.ts --provider=openai \
  --scenario=acc-search-vs-list --reps=1

# the full comparison (costs money)
npx tsx bench/harness/run-multi.ts --provider=all --reps=3 --variants

npx tsx bench/analyze-multi.ts   # per-arm table + ranking stability
```

To use your own tools and tasks, edit `bench/fixtures/tools.ts` and
`bench/scenarios-accuracy.ts`. A scenario declares its tools, the prompt, and
the expected call, so grading is mechanical rather than model-judged.

Raw per-run JSONL lands in `bench/results/` and is committed, so every published
number can be recomputed rather than trusted.

---

## 12. API reference

### `compress(tools, options?) → CompressResult`

| Option | Type | Default | Notes |
|---|---|---|---|
| `level` | `0 \| 1 \| 2 \| 3` | `1` | see [§3](#3-which-level-should-i-use) |
| `mapStyle` | `"name" \| "name+required" \| "terse"` | `"name"` | level 3 only |
| `namespaceOf` | `(name) => {ns, op}` | split on first `_`/`.` | levels 2–3 grouping |
| `aliasOf` | `(ns) => string` | identity | level 2 tool naming |
| `searchLimit` | `number` | `8` | max results from a `q` search |
| `validate` | `boolean` | `true` | **leave this on** |

Returns:

| Field | Type | Notes |
|---|---|---|
| `tools` | `unknown[]` | send these; Anthropic shape |
| `systemPreamble` | `string` | append to your system prompt; `""` at levels 0–1 |
| `cachePreamble` | `boolean` | whether the preamble should sit behind a breakpoint |
| `resolve(name, args)` | `→ Resolution` | translate a model call back |
| `codeFor(name)` | `→ string` | real name → level-3 code; throws below level 3 |
| `stats` | `CompressStats` | `level`, `toolCount`, `wireToolCount`, `savedPct`, … |

### `recommendLevel(tools, namespaceOf?) → Recommendation`

`{ level, reason, toolCount, namespaceCount, opsPerNamespace }`. Returns 1 or 3.

### Provider adapters

- `forAnthropic(c, { cache?, ttl? })` → `{ tools, system }`
- `forOpenAI(c)` → `{ tools, systemPreamble }`
- `forGemini(c)` → `{ tools, systemPreamble }`

### Renderers (exported for tooling)

- `signatureLine(tool, nameOverride?)` → `"name(a,b?:x|y)"`
- `flattenSchema(schema)` → schema with prose and boilerplate removed
- `countSchemaTokensApprox(value)` → character-count proxy, **not** a token count

---

Measured results and their limits: [RESULTS.md](RESULTS.md).
Methodology and repo conventions: [../AGENTS.md](../AGENTS.md).
