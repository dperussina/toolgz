# Examples

Five runnable programs, in the order worth reading them. **Every one runs offline** — no
API key, no network, no cost. Run any of them straight from a clone:

```bash
npx tsx examples/01-minimal.ts
```

They are not illustrative sketches. `tests/examples-run.test.ts` executes all five with
every API key blanked and fails if any exits non-zero, prints nothing, or emits
`undefined` / `NaN` / `[object Object]`. So an example that drifts out of date is a
failing build, not a bug report from you.

> Writing `01-minimal.ts` is what caught a bad `savedPct` metric that had shipped in
> 0.2.7 — it printed `-20.1%` on two tools where the real figure was `-4.9%`. Reverted in
> 0.2.8. That is the argument for keeping examples executable.

| | File | What it shows |
|:-:|---|---|
| 1 | [`01-minimal.ts`](01-minimal.ts) | The smallest useful thing: `recommendLevel` → `compress` → `resolve` |
| 2 | [`02-agent-loop.ts`](02-agent-loop.ts) | The full loop against a scripted model, covering all three `resolve()` outcomes |
| 3 | [`03-mcp-servers.ts`](03-mcp-servers.ts) | 149 real tools from 14 MCP servers, at all four levels |
| 4 | [`04-providers.ts`](04-providers.ts) | The four provider envelopes, and two gotchas that cost real debugging time |
| 5 | [`05-per-model.ts`](05-per-model.ts) | Per-model style selection, and reading `stats` to see what actually happened |

---

## 1. `01-minimal.ts` — the three lines

Two GitHub tools, compressed, then a model call translated back to a real dispatch.

It also demonstrates the thing people get wrong most often:

```
compress(myTools)            -> level 1
compress(myTools, {level:3}) -> level 3
```

**`recommendLevel()` advises; it does not act.** `compress(tools)` is level 1 forever —
two tools or five hundred. You pass the level in yourself. See
[Which level to use](../README.md#which-level-to-use) for why that is deliberate.

Note the output reads `estimated saving: -7.7%`. **Negative is correct here** and the
example keeps it rather than picking flattering inputs: on two tools, level 1's signature
line costs more than the prose it replaces. Compression needs something to compress.

## 2. `02-agent-loop.ts` — the shape every integration takes

The model is scripted, so the loop is deterministic and free, and it deliberately walks
through all three kinds `resolve()` can return:

```
turn 1  META   reply with: a0 = scorecard_lf(week?) …
turn 2  ERROR  return to model: No map code "bad-code". Search with q(s=…).
         recoverable: true
turn 3  CALL   scorecard_lf_daily -> {"ok":true,"rows":412,…}
```

The `ERROR` turn is the point of the example. A bad code is **not** a crash — you hand
the message back to the model as a tool result and it recovers on the next turn. That
recovery path is what makes level 3 safe on weaker models, where argument formatting
degrades but tool *choice* does not.

Branch on `r.kind` and you have handled everything:

```ts
const r = c.resolve(block.name, block.input);
if (r.kind === "call") await myDispatch(r.name, r.args);   // real name, real args
else if (r.kind === "meta") reply(r.result);               // library answered; no dispatch
else reply(`Error: ${r.message}`);                         // model retries
```

## 3. `03-mcp-servers.ts` — real tools, all four levels

MCP's `tools/list` returns `{ name, description, inputSchema }` per tool, which is
exactly what `compress()` takes. **There is no adapter layer.** This one uses the 149
tools committed in `bench/fixtures`, harvested from 14 live MCP servers:

```
  level 0: 149 tools on the wire, 163520 chars, savedPct -0.1%
  level 1: 149 tools on the wire,  89574 chars, savedPct 45.2%
  level 2:  64 tools on the wire,  17443 chars, savedPct 89.3%
  level 3:   2 tools on the wire,   5721 chars, savedPct 96.5%
```

Real MCP tools average ~460 tokens each, so this block is 68,494 tokens — **34% of a
200k window before the user says anything.** These figures come from a real corpus
rather than generated fixtures, which matters: verbose MCP prose gives level 1 more to
strip, so it saves 45% here against 13–32% on synthetic tools.

The example also checks for names that collide once namespaces are stripped, because
that is the hazard when you merge catalogues from independent servers.

## 4. `04-providers.ts` — four envelopes, two gotchas

Each provider wants a different shape; the adapters do the translation. Two things are
*demonstrated* here rather than described, because both are easy to get wrong and the
error messages point nowhere near the cause:

**OpenAI has two incompatible tool shapes.** `/v1/chat/completions` takes the nested
`{type, function:{…}}`; `/v1/responses` takes a **flat** `{type, name, …}`. If you set
reasoning effort on GPT-5.x you need `/v1/responses`, and therefore `forOpenAIResponses`.

**Gemini returns one wrapper object, not one tool per tool.** Count
`tools[0].functionDeclarations.length`, never `tools.length`.

It also shows the three schema forms Gemini rejects with a 400, repaired automatically:

```
    tags  {"type":"array"} -> {"type":"array","items":{}}
    depth {"type":"number","enum":[1,2,3]} -> {"type":"number"}
    the dropped enum is still enforced by resolve():
      depth=99 -> error: Invalid value for "depth" …
```

The last line is the part that matters: a constraint stripped to satisfy Gemini is still
enforced, by us, against your original schema. Nothing is silently dropped.

## 5. `05-per-model.ts` — the measured policy table

Level 3 can encode its map several ways, and which is cheapest depends on the model. Pass
a `model` and toolgz uses what was actually measured:

```
  claude-opus-5            explicit       -9%    n=36
  gemini-3.1-pro-preview   explicit       -15.4% n=36
  gpt-5.6-sol              explicit       -20.7% n=36
  anything absent falls back to name+required
```

Three properties of that table are worth internalising:

- **An absent model means "no measured improvement", never "untested."** `grok-4.5` is
  missing on purpose — `explicit` measured **+13.2%** there.
- **It is keyed on exact model ids, never families.** A result for `gpt-5.6-sol` says
  nothing about `gpt-5.7`.
- **`occupancy` has no entries at all.** Every difference measured on that axis was
  within ±3.1%, under the 5% effect-size floor, so it gets the default. The feature
  shrank to the one objective the data supported.

This is also the one thing the library picks for you, and only when you pass `model` — a
map style is a pure encoding choice, so a better one cannot change your results. The
*level* can, which is why that stays your explicit call.

The example ends by reading `stats`, which always reports what was actually used:

```
  mapStyle          explicit
  requestedMapStyle (you did not ask for one)
  fallbackReason    (nothing was substituted)
```

If toolgz ever substitutes a style, those last two fields say so and why. **No
substitution is silent** — that rule exists because silent fallbacks burned this project
four separate times.

> `savedPct` is a **character** saving and runs a few points optimistic against tokens.
> Measure with your provider's own counter for anything you publish, and never use
> `tiktoken` for Claude — it is OpenAI's tokenizer and is wrong for Claude by 15–20%+.

---

## Where to go next

- **[Main README](../README.md)** — the levels explained from scratch, provider setup,
  prompt caching, troubleshooting, full API reference
- **[docs/BEFORE-AFTER.md](../docs/BEFORE-AFTER.md)** — the complete tools array and
  system prompt, before and after, at every level, with real token counts. Generated by
  running the library, and a test asserts it matches
- **[docs/RESULTS.md](../docs/RESULTS.md)** — every benchmark round, including the ideas
  that were measured and killed
