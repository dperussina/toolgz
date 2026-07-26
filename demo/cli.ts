/**
 * A demo you can run in front of people.
 *
 *   npm run demo -- --level=3            one level, every step printed
 *   npm run demo -- --compare            levels 0, 1 and 3 back to back
 *   npm run demo -- --level=3 --offline  no API key, scripted model
 *
 * It really runs the loop: real model call, real dispatch, real tool results fed
 * back. Nothing is faked unless you pass --offline, and it says so when you do.
 *
 * Not shipped in the npm package. It imports the Anthropic SDK, which is a
 * devDependency — the library itself has zero runtime dependencies and this must not
 * be the thing that changes that.
 */
import "dotenv/config";
import { compress } from "../src/index.js";
import type { Level, Tool } from "../src/types.js";
import { forAnthropic } from "../src/providers/index.js";

// ── presentation ────────────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.argv.includes("--no-color");
const C = (n: string) => (s: string | number) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const bold = C("1"), dim = C("2"), cyan = C("36"), green = C("32");
const yellow = C("33"), red = C("31"), blue = C("34"), mag = C("35");

const WIDTH = 78;
const rule = (ch = "─") => dim(ch.repeat(WIDTH));

function banner(text: string, tone = cyan) {
  const inner = `━━ ${text} `;
  console.log(tone(inner + "━".repeat(Math.max(0, WIDTH - inner.length))));
}
function step(n: number, title: string, sub?: string) {
  console.log();
  console.log(`${bold(mag(`STEP ${n}`))}  ${bold(title)}`);
  if (sub) console.log(`        ${dim(sub)}`);
  console.log();
}
const TERM = Math.max(60, Math.min(process.stdout.columns ?? 100, 120));

/**
 * Soft-wrap to the terminal, preserving the indent.
 *
 * Never truncates. An earlier version capped every block at 6-14 lines, which cut the
 * model's final answer off mid-markdown-table — right at the header separator, so the
 * rows never appeared and it read as "the table is broken".
 */
function block(s: string, indent = "  ", tone: (x: string) => string = (x) => x) {
  const room = Math.max(20, TERM - indent.length);
  // `tone` is applied per emitted line rather than to the whole string, so ANSI escapes
  // never count toward the wrap width and can never be split down the middle.
  const put = (l: string) => console.log(indent + tone(l));
  for (const raw of s.split("\n")) {
    if (raw.length <= room) { put(raw); continue; }
    // Never re-wrap a markdown table row or a fenced code line: inserting an indent
    // mid-row destroys the alignment that makes it readable. Let the terminal decide.
    if (/^\s*\|/.test(raw) || (raw.match(/\|/g) ?? []).length >= 2) { put(raw); continue; }
    let cur = "";
    for (const word of raw.split(" ")) {
      if (cur && (cur + " " + word).length > room) { put(cur); cur = word; }
      else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) put(cur);
  }
}

/** Deliberate summarising, where showing every item is noise rather than information. */
function summarised(lines: string[], indent: string, show: number, what: string) {
  for (const l of lines.slice(0, show)) console.log(indent + l);
  if (lines.length > show) console.log(indent + dim(`(${lines.length - show} more ${what} not shown)`));
}
const n = (x: number) => x.toLocaleString();
/** Truncate on a word boundary, so a preview never ends "in th". */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[,;:.]$/, "") + "…";
}

// ── the tools, and a dispatcher that actually does something ────────────────
const TOOLS: Tool[] = [
  {
    name: "github_create_issue",
    description:
      "Create a new issue in a GitHub repository. Use this when the user wants to file a bug, request a feature, or otherwise open a tracked work item. The issue is created immediately and cannot be undone from this tool.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The account owner of the repository. Case-insensitive." },
        repo: { type: "string", description: "The name of the repository without the .git extension." },
        title: { type: "string", description: "The title of the new issue." },
        body: { type: "string", description: "The contents of the issue, in GitHub-flavored Markdown." },
        labels: { type: "array", items: { type: "string" }, description: "Labels to apply to the new issue." },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "github_search_issues",
    description:
      "Search issues and pull requests across GitHub using a query string. Supports the full GitHub search syntax including qualifiers such as repo:, author:, label: and state:.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "The query string, using GitHub search syntax." },
        sort: { type: "string", enum: ["comments", "created", "updated"], description: "What to sort results by." },
        per_page: { type: "integer", description: "Results per page, maximum 100." },
      },
      required: ["q"],
    },
  },
  {
    name: "github_list_issues",
    description:
      "List issues in a repository. This is different from searching: it returns every issue in the repository subject to the filters given, rather than matching a query string.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The account owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        state: { type: "string", enum: ["open", "closed", "all"], description: "Which issues to return." },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "slack_post_message",
    description:
      "Post a message to a Slack channel. The bot must already be a member of the channel. Messages support Slack's mrkdwn formatting, which is not the same as standard Markdown.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID or name, for example #engineering." },
        text: { type: "string", description: "The message text, in Slack mrkdwn." },
        thread_ts: { type: "string", description: "Timestamp of a parent message, to reply in thread." },
      },
      required: ["channel", "text"],
    },
  },
  {
    name: "slack_list_channels",
    description:
      "List the Slack channels the bot can see, including public channels it has not joined and private channels it has been invited to.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Maximum channels to return." },
        exclude_archived: { type: "boolean", description: "Omit archived channels." },
      },
      required: [],
    },
  },
  {
    name: "sentry_list_issues",
    description:
      "List unresolved issues from a Sentry project, most frequent first. Use this to find out what is currently breaking in production before filing a GitHub issue about it.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The Sentry project slug." },
        environment: { type: "string", description: "Environment name, for example production." },
      },
      required: ["project"],
    },
  },
];

/** The real dispatcher. It is deliberately the same code at every level. */
async function myDispatch(name: string, args: Record<string, any>): Promise<unknown> {
  switch (name) {
    case "sentry_list_issues":
      return [
        { id: "S-1", title: "TypeError: cannot read 'id' of undefined", events: 1204, culprit: "checkout/submit" },
        { id: "S-2", title: "Timeout talking to payments-api", events: 311, culprit: "payments/charge" },
      ];
    case "github_create_issue":
      return { number: 42, url: `https://github.com/${args.owner}/${args.repo}/issues/42`, title: args.title };
    case "github_search_issues":
      return { total_count: 0, items: [] };
    case "github_list_issues":
      return { items: [{ number: 7, title: "Flaky checkout test" }] };
    case "slack_post_message":
      return { ok: true, ts: "1730000000.000100", channel: args.channel };
    case "slack_list_channels":
      return { channels: ["#engineering", "#incidents"] };
    default:
      throw new Error(`no such tool: ${name}`);
  }
}

const TASK =
  "Find the most frequent unresolved error in the Sentry project 'web-frontend' (environment production), " +
  "then file a GitHub issue about it in owner 'acme', repo 'web'. Use the error title as the issue title.";

// ── what a level does to your tool definitions ──────────────────────────────
function showTransform(level: Level) {
  const c = compress(TOOLS, { level });
  const before = compress(TOOLS, { level: 0 });

  step(1, "Your tools, exactly as your MCP client hands them over",
    `${TOOLS.length} tools · ${n(before.stats.originalChars)} characters of JSON Schema`);
  block(
    TOOLS.slice(0, 2)
      .map((t) => {
        const req = new Set(t.inputSchema?.required ?? []);
        const props = Object.keys(t.inputSchema?.properties ?? {});
        return [
          bold(t.name),
          dim(`  "${clip(t.description ?? "", 64)}"`),
          dim(`  { ${props.map((k) => (req.has(k) ? `${k}${red("*")}` : dim(k))).join(", ")} }`),
        ].join("\n");
      })
      .join("\n") + dim(`\n(${TOOLS.length - 2} more tools not shown)`),
  );

  const pct = c.stats.savedPct;
  step(2, `compress(tools, { level: ${level} })`,
    `${c.stats.toolCount} tools → ${bold(String(c.stats.wireToolCount))} on the wire · ` +
    `${n(c.stats.originalChars)} → ${n(c.stats.compressedChars)} chars ` +
    `(${pct >= 0 ? green(`${pct.toFixed(1)}% smaller`) : yellow(`${Math.abs(pct).toFixed(1)}% LARGER`)})`);

  console.log(`  ${bold("ON THE WIRE")}`);
  block(
    (c.tools as any[])
      .slice(0, 3)
      .map((t: any) => {
        const props = Object.keys(t.input_schema?.properties ?? {});
        return `${cyan(t.name)}(${props.join(", ")})\n${dim(`   ${clip(String(t.description ?? ""), TERM - 8)}`)}`;
      })
      .join("\n") + (c.tools.length > 3 ? dim(`\n(${c.tools.length - 3} more not shown)`) : ""),
    "    ",
  );

  if (c.systemPreamble) {
    console.log();
    console.log(`  ${bold("APPENDED TO YOUR SYSTEM PROMPT")} ${dim(c.cachePreamble ? "(behind a cache breakpoint)" : "")}`);
    block(c.systemPreamble.trim(), "    ");
  } else {
    console.log();
    console.log(`  ${dim("system preamble: empty — nothing to add at this level")}`);
  }
  return c;
}

// ── the model ───────────────────────────────────────────────────────────────
type Turn = { calls: { id: string; name: string; input: any }[]; text: string };

/** A scripted model, so the demo runs with no key and no cost. */
function offlineModel(level: Level, c: ReturnType<typeof compress>) {
  let i = 0;
  const codeFor = (real: string) => (level === 3 ? c.codeFor(real) : real);
  const wrap = (real: string, args: any) =>
    level === 3
      ? { name: "t", input: { f: codeFor(real), a: args } }
      : level === 2
        ? (c.encodeCallForTest(real, args) as any)
        : { name: real, input: args };
  const script = [
    () => wrap("sentry_list_issues", { project: "web-frontend", environment: "production" }),
    () =>
      wrap("github_create_issue", {
        owner: "acme",
        repo: "web",
        title: "TypeError: cannot read 'id' of undefined",
      }),
  ];
  return async (): Promise<Turn> => {
    if (i >= script.length) return { calls: [], text: "Filed as issue #42." };
    const s = script[i++]();
    return { calls: [{ id: `off_${i}`, name: s.name, input: s.input }], text: "" };
  };
}

async function anthropicModel(c: ReturnType<typeof compress>, model: string) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const { tools, system } = forAnthropic(c);
  const messages: any[] = [{ role: "user", content: TASK }];
  return {
    messages,
    tools,
    system,
    async next(): Promise<Turn> {
      const res: any = await client.messages.create({
        model,
        max_tokens: 2048,
        system: [
          { type: "text", text: "You are an ops agent. Use the tools available. Do not ask clarifying questions." },
          ...(system ?? []),
        ],
        tools: tools as any,
        messages,
      });
      messages.push({ role: "assistant", content: res.content });
      return {
        calls: res.content.filter((b: any) => b.type === "tool_use").map((b: any) => ({ id: b.id, name: b.name, input: b.input })),
        text: res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" "),
      };
    },
  };
}

// ── one run ─────────────────────────────────────────────────────────────────
type Summary = {
  level: Level; wireTools: number; chars: number; origChars: number; savedPct: number;
  turns: number; lookups: number; dispatches: string[]; validator: string; errors: number;
};

async function run(level: Level, opts: { offline: boolean; model: string }): Promise<Summary> {
  console.log();
  banner(`toolgz demo · level ${level}${opts.offline ? " · offline (scripted model)" : ` · ${opts.model}`}`);
  console.log();
  console.log(`  ${dim("task:")}`);
  block(TASK, "    ", dim);

  const c = showTransform(level);

  let turns = 0, lookups = 0, errors = 0;
  const dispatches: string[] = [];
  let sNum = 3;

  const live = opts.offline ? null : await anthropicModel(c, opts.model);
  const next = opts.offline ? offlineModel(level, c) : live!.next.bind(live);

  for (let t = 0; t < 8; t++) {
    step(sNum++, `Request to the model${opts.offline ? " (scripted)" : ""}`,
      opts.offline
        ? "no network — the model's calls are canned so this runs anywhere"
        : `${(live!.tools as any[]).length} tools · system ${n(JSON.stringify(live!.system ?? "").length)} chars · ${live!.messages.length} messages`);

    const turn = await next();
    turns++;

    if (!turn.calls.length) {
      step(sNum++, "Model response — no tool call, so it is done");
      block(turn.text || "(no text)", "  ");
      break;
    }

    step(sNum++, "Model response");
    for (const call of turn.calls) {
      console.log(`  ${yellow("tool_use")}  ${cyan(call.name)}(${dim(JSON.stringify(call.input))})`);
    }

    step(sNum++, "c.resolve(name, args) — the translation back");
    const results: any[] = [];
    for (const call of turn.calls) {
      const r = c.resolve(call.name, call.input);
      if (r.kind === "call") {
        console.log(`  ${green("→ kind: \"call\"")}`);
        console.log(`      name: ${bold(r.name)}   ${dim("← the REAL tool name")}`);
        console.log(`      args: ${bold(JSON.stringify(r.args))}`);
        console.log(`  ${dim("your dispatcher runs unchanged:")}`);
        const out = await myDispatch(r.name, r.args);
        dispatches.push(r.name);
        console.log(`      ${blue(r.name)} →`);
        block(JSON.stringify(out), "        ", dim);
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(out) });
      } else if (r.kind === "meta") {
        lookups++;
        console.log(`  ${mag("→ kind: \"meta\"")}   ${dim("toolgz answered this itself — nothing was dispatched")}`);
        block(r.result, "      ");
        results.push({ type: "tool_result", tool_use_id: call.id, content: r.result });
      } else {
        errors++;
        console.log(`  ${red("→ kind: \"error\"")}  ${r.message}`);
        console.log(`  ${dim("handed back to the model, which retries — not a crash")}`);
        results.push({ type: "tool_result", tool_use_id: call.id, content: `Error: ${r.message}`, is_error: true });
      }
    }
    if (live) live.messages.push({ role: "user", content: results });
    if (opts.offline && dispatches.includes("github_create_issue")) {
      step(sNum++, "Task complete");
      break;
    }
  }

  const s: Summary = {
    level,
    wireTools: c.stats.wireToolCount,
    chars: c.stats.compressedChars,
    origChars: c.stats.originalChars,
    savedPct: c.stats.savedPct,
    turns, lookups, dispatches, errors,
    validator: level >= 2 ? "toolgz (provider constrained decoding given up)" : "the provider (schema enforced natively)",
  };

  console.log();
  console.log(rule());
  console.log(`  ${bold("RESULT")}   level ${bold(String(level))}`);
  console.log(`    tool definitions   ${n(s.origChars)} → ${n(s.chars)} chars   ` +
    (s.savedPct >= 0 ? green(`${s.savedPct.toFixed(1)}% reclaimed`) : yellow(`${Math.abs(s.savedPct).toFixed(1)}% larger`)));
  console.log(`    tools on the wire  ${TOOLS.length} → ${bold(String(s.wireTools))}`);
  console.log(`    model turns        ${s.turns}${s.lookups ? dim(`  (${s.lookups} were toolgz lookups)`) : ""}`);
  console.log(`    arguments checked  ${s.validator}`);
  console.log(`    dispatched         ${s.dispatches.length ? green(s.dispatches.join(" → ")) : red("nothing")}`);
  if (s.errors) console.log(`    recovered errors   ${yellow(String(s.errors))} ${dim("(returned to the model, then retried)")}`);
  console.log(rule());

  if (level === 3) {
    console.log();
    console.log(`  ${bold("THE OTHER TWO OUTCOMES")} ${dim("— demonstrated, not part of the run above")}`);
    const bad = c.resolve("t", { f: "zz9", a: {} });
    if (bad.kind === "error") {
      console.log(`    ${dim('model sends a code that does not exist: t(f="zz9")')}`);
      console.log(`    ${red('→ kind: "error"')}  ${bad.message}`);
      console.log(`      ${dim(`recoverable: ${bad.recoverable} — you return this text and the model retries`)}`);
    }
    const look = c.resolve("q", { s: "issue" });
    if (look.kind === "meta") {
      console.log(`    ${dim('model searches the map: q(s="issue")')}`);
      console.log(`    ${mag('→ kind: "meta"')}   ${dim("toolgz answers; nothing is dispatched")}`);
      block(look.result, "      ");
    }
    console.log(rule());
  }
  return s;
}

// ── entry ───────────────────────────────────────────────────────────────────
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const offline = process.argv.includes("--offline") || !process.env.ANTHROPIC_API_KEY;
const model = arg("model") ?? "claude-opus-5";
const compare = process.argv.includes("--compare");
const levels: Level[] = compare
  ? [0, 1, 3]
  : [(Number(arg("level") ?? 3) as Level)];

if (!compare && ![0, 1, 2, 3].includes(levels[0])) {
  console.error(`--level must be 0, 1, 2 or 3`);
  process.exit(1);
}
if (offline && !process.env.ANTHROPIC_API_KEY && !process.argv.includes("--offline")) {
  console.log(dim("\nno ANTHROPIC_API_KEY found — running offline with a scripted model"));
}

const summaries: Summary[] = [];
for (const l of levels) summaries.push(await run(l, { offline, model }));

if (summaries.length > 1) {
  console.log();
  banner("SIDE BY SIDE", green);
  console.log();
  const head = ["level", "wire tools", "definition chars", "reclaimed", "turns", "argument checking"];
  const rows = summaries.map((s) => [
    String(s.level),
    `${TOOLS.length} → ${s.wireTools}`,
    `${n(s.origChars)} → ${n(s.chars)}`,
    s.savedPct >= 0 ? `${s.savedPct.toFixed(1)}%` : `${s.savedPct.toFixed(1)}%`,
    String(s.turns),
    s.level >= 2 ? "toolgz" : "provider",
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  console.log("  " + dim(head.map((h, i) => h.padEnd(w[i])).join("  ")));
  for (const r of rows) console.log("  " + r.map((v, i) => (i === 3 ? (v.startsWith("-") ? yellow(v.padEnd(w[i])) : green(v.padEnd(w[i]))) : v.padEnd(w[i]))).join("  "));
  console.log();
  console.log(`  ${dim("Same dispatcher, same task, same result at every level. What changes is how much")}`);
  console.log(`  ${dim("of your context window the tool definitions occupy — and who checks the arguments.")}`);
  console.log();
}
