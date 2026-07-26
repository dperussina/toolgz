# Announcement drafts

Two audiences, two registers. Both are honest about the limits, because the
limits are what make the numbers believable — especially on Hacker News, where
an unhedged claim gets dismantled in the first comment.

Repo: https://github.com/dperussina/toolgz
Package: https://www.npmjs.com/package/toolgz
Social image: `docs/img/social-card-dark.png` / `-light.png`

---

## Hacker News — "Show HN"

**Paste-ready body:** [`ANNOUNCEMENT-hackernews.txt`](ANNOUNCEMENT-hackernews.txt)
— plain text, verified against HN's formatting rules. The markdown below is the
source of record for editing; do not paste it.

HN's formatter is not markdown either. It supports only:

| Thing | Behaviour |
|---|---|
| Blank line | paragraph break — the only layout tool |
| `*text*` | *italic*. An unpaired asterisk italicises everything after it |
| 2-space indent | monospace block that **does not wrap** — keep lines < 70 chars |
| Text limit | **4,000 characters, counting each line break as 2** (see below) |
| Bold, headings, tables, real lists | unsupported; render literally |
| URLs | auto-linked |

> **The character limit is stricter than it looks.** HN rejected a 4,454-character
> body with *"Please limit text to 4000 characters. (This had 4496.)"* — 42 more
> than the file contained, exactly its number of newlines. The composer submits LF
> as CRLF, so the real budget is `characters + newlines`. Measuring the file the
> obvious way understates it by one per line. `tests/announcement.test.ts` asserts
> the true figure for both platforms.

**Title** — hard 80-character limit, and HN truncates silently past it. All of
these fit (length in brackets):

> Show HN: toolgz – cut LLM tool-definition tokens ~80% without hurting accuracy [78]

Alternates:
> Show HN: I compressed my agent's tool schemas 80% and was wrong about why [73]
> Show HN: toolgz – 420 runs on whether compressing tool schemas breaks tool use [78]

**How to submit:** Show HN takes a URL *and* text. Put
`https://github.com/dperussina/toolgz` in the url field and the body in the text
field — that way the title links to the repo and your description still appears.
Do not post the body as a separate comment; Show HN posts support both fields.

Register for HN: the engineering narrative is the value here, including the parts
that did not work. An unhedged claim gets dismantled in the first comment, so the
failures and the cost caveat stay in.

**Body:**

If you wire an agent to a few MCP servers, you'll notice tool definitions eating
your context window before the user says anything. Each tool is a JSON Schema
with a sentence of prose per parameter; ~420 tokens each is normal. Fifty tools
is 20k tokens at the front of every request.

toolgz compresses that block and translates the model's calls back, so your
dispatcher receives the same tool name and arguments it did before.

I expected this to fail. The aggressive mode replaces `github_search_issues`
with `a0` and puts a lookup table in the (cached) system prompt, and my strong
prior was that stripping the semantic name would wreck tool selection. So I
built the benchmark to catch that, with deliberately confusable clusters —
`search_issues` vs `list_issues`, comment-vs-update, approve-vs-merge, three
products with identically-shaped tools side by side.

It didn't fail. 420 runs across `claude-opus-5`, `gpt-5.6-sol`,
`gemini-3.1-pro-preview` and `grok-4.5`, reasoning enabled on all four at high
effort:

- Prompt tokens: **−71% to −85%** depending on provider
- Tool-definition block: **−79% to −88%**
- Cost: **−7% to −78%**
- Latency: **faster than uncompressed on all four**
- Tasks completed: **60/60**, zero hallucinated names, zero malformed arguments

The mechanism seems to be that the model converts a recall problem into a
retrieval problem. It doesn't need the name in context; it needs a way to find
it, and it'll spend a lookup call to do so.

Three things I'd want to know if I were reading this:

**1. My first cross-provider run made OpenAI 15% *more* expensive**, and fixing
that taught me the most. Context fell 69% but the bill went up, because the
dispatcher was burning extra turns and on a reasoning model every turn pays for
a fresh round of thinking.

So instead of theorising I made the harness record the calls that were being
rejected. Three bugs, all mine: models pass `query` to a parameter named `q`
(14 of 18 rejections), they sometimes call the map code as the tool name, and
they sometimes pass arguments flat instead of nested. Fixing those took OpenAI
from **+15% to −7%** and drove malformed arguments to **zero on all four
providers**.

Cost still isn't the headline. OpenAI's −7% is the smallest saving because
reasoning output dominates its bill, so a smaller prompt moves the total less.
The claim is context-window occupancy; cost follows by a variable amount.

**2. A bare-name map failed on Grok, deterministically.** Not noise: one
scenario, 3 of 3 attempts, `turns=1`, zero tool calls, no error raised — the
model read the map and answered without dispatching. Adding the required
argument names to each line fixed it, and that is now the default. Bare names
remain the only style that has ever failed. Same shape as failure #3.

**3. Anthropic's own `defer_loading` tool search completed 6/30 tasks on
Haiku 4.5** — silently, for the same reason. Deferred loading makes tool
discovery *optional*; a small model can decline to discover and answer unaided.
A dispatcher makes discovery the entry point, which is a structural difference
rather than a tuning one. On Opus 5, `defer_loading` was a clean 20/20 — this
only shows up below the frontier tier.

What it costs you: at the aggressive level the model fills a generic argument
object, so the provider's constrained sampler no longer enforces your schema.
The library validates against your original schema and hands the model a
readable error instead — the near-miss case now says *"You passed \"query\" — did
you mean \"q\"? Rename it."*, because a vague error costs another turn. On
Haiku 4.5 that path fired on 17 of 30 runs; every one was caught and retried, no
task lost, but that's the real edge.

Every per-run record is committed in the repo, so you can recompute any figure
rather than trust it. The before/after docs are generated by running the library,
with a test asserting they match the code. TypeScript, zero runtime
dependencies, Apache-2.0.

I'd particularly like to be argued with on whether the confusable-tool suite is
actually hard enough, and on the one thing I still can't explain: a map style
that removes all lookups is fastest and cheapest on three providers and
meaningfully worse on xAI.

---

## LinkedIn

Register: sell it. LinkedIn rewards a clear hook, a visible payoff, and something
the reader can act on in ten seconds — not a build log. The engineering narrative
lives in the Hacker News version above, where that audience wants it.

**Image:** attach `docs/img/social-card-dark.png` (1200x630, generated by
`npx tsx bench/social-card.ts` from the README's own results table).

**Do not paste the markdown below.** LinkedIn's composer has no markdown support
at all: `**bold**` renders the asterisks literally, backticks render as backticks,
`#` becomes a hashtag, and `[text](url)` renders as-is. Paste
[`ANNOUNCEMENT-linkedin.txt`](ANNOUNCEMENT-linkedin.txt) instead — same post, plain
text, verified free of markdown syntax. The markdown version below is the source of
record for editing.

What LinkedIn actually honours:

| Thing | Behaviour |
|---|---|
| Line breaks & blank lines | preserved — the only layout tool available |
| Bold / italic / code | **unsupported**; no composer formatting exists |
| Character limit | 3,000 (the plain-text post is ~1,500) |
| Feed truncation | ~210 chars on desktop, fewer on mobile, then "see more" |
| URLs | auto-linkified, but a link in the body suppresses reach |
| Hashtags | fine; 3–5 at the end |
| Unicode (— – →) | renders correctly |

Two consequences worth designing around:

1. **The hook must land in the first ~210 characters**, because that is all a
   scrolling reader sees before "see more."
2. **Put the repo link in the first comment, not the post body.** LinkedIn
   demotes posts with outbound links; a comment costs nothing. The plain-text
   version ends with "Link in the comments." for this reason — post it, then
   immediately comment `https://github.com/dperussina/toolgz`.

Some people fake bold with Unicode characters (𝗹𝗶𝗸𝗲 𝘁𝗵𝗶𝘀). Avoid it: screen
readers read those code points as gibberish, and they are excluded from search
indexing. Structure with line breaks instead.

**Post:**

Your AI agent burns 30,000 tokens before the user types a single word.

Not on thinking. Not on answering. On **tool definitions** — the JSON schemas that
describe what it's allowed to do. Wire up a few MCP servers and that's 30–50k
tokens sitting at the front of every request, forever.

Prompt caching makes those tokens cheap. It doesn't give you the room back.

So I built toolgz. It's on npm as of today.

Two lines to adopt it:

```ts
const { level } = recommendLevel(myTools);   // advice: 1 for a small block, 3 for a big one
const c = compress(myTools, { level });      // your existing MCP/SDK tool array
const { tools, system } = forAnthropic(c);   // send these instead
```

One line to translate the model's call back:

```ts
const r = c.resolve(name, input);   // → real tool name, real arguments
```

Your dispatcher receives exactly what it received before. Nothing downstream
changes.

**Measured on Claude, GPT, Gemini and Grok — reasoning enabled, high effort:**

→ 71–85% fewer prompt tokens (at level 3, on a large tool set)
→ Faster on all four
→ 60/60 tasks completed
→ Zero hallucinated tool names, zero malformed arguments

I built the benchmark specifically to break it — deliberately confusable tools,
near-identical names, three products with identically-shaped operations sitting
side by side. It didn't break.

Every raw benchmark run is committed to the repo, so you can check me rather than
take my word for it.

TypeScript. Zero dependencies. Apache-2.0.

npm install toolgz
→ github.com/dperussina/toolgz

If you're running agents with a lot of tools, I'd love to know whether this holds
on your workload — that's the one thing I can't test from here.

#AI #LLM #AIAgents #MCP #OpenSource #TypeScript

---

## The one-liner

For a tweet, a repo description, or the top of a deck:

> Your agent burns 30–50k context tokens on tool definitions before the user
> types a word. toolgz gets ~80% back — faster and cheaper, on Claude, GPT,
> Gemini and Grok. 420 benchmark runs, no measured accuracy cost.

## What not to say

Guard-rails for anyone else writing about this:

- ❌ "80% cheaper" — the token saving is ~80%; the *cost* saving is 7–78%
  depending on provider. The claim is **context-window occupancy**; cost
  follows by a variable amount.
- ❌ "Works on any model" — measured on four frontier models from four vendors.
  Below the frontier tier, argument errors rise sharply (17/30 runs on
  Haiku 4.5, all recovered).
- ❌ "Beats Anthropic's tool search" — it does not beat it on tool-block size.
  It composes with it, and is more reliable below the frontier tier.
- ❌ "Lossless" — at levels 2–3 you give up provider-side constrained decoding.
  The library replaces that guarantee with its own validation; that is a
  trade, not a free lunch.
- ❌ Any figure not in [RESULTS.md](RESULTS.md). Every number there is
  recomputable from committed data.
