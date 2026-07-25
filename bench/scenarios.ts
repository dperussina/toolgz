import { ALL_TOOLS, subset, toolsByName } from "./fixtures/tools.js";
import type { ToolDef } from "./core/types.js";

export type Expected = {
  /** Real (uncompressed) tool name we expect to be invoked. */
  name: string;
  /** Argument keys that must be present with these exact values. */
  args?: Record<string, any>;
};

export type Scenario = {
  id: string;
  tools: ToolDef[];
  prompt: string;
  expected: Expected[];
  /** Canned tool results, keyed by real tool name. */
  results: Record<string, string>;
  maxTurns: number;
  note: string;
};

const R = (o: Record<string, string>) => o;

export const SCENARIOS: Scenario[] = [
  {
    id: "small-single",
    note: "Overhead floor. 10 tools, one call. Does compression cost anything when there is nothing to save?",
    tools: subset(10, ["slack_post_message"]),
    prompt:
      'Post "deploy finished" to the #eng-releases Slack channel.',
    expected: [
      { name: "slack_post_message", args: { text: "deploy finished" } },
    ],
    results: R({ slack_post_message: '{"ok":true,"ts":"1719_00.1"}' }),
    maxTurns: 6,
  },
  {
    id: "large-sparse",
    note: "Best case for compression. 100 tools, 2 calls.",
    tools: ALL_TOOLS,
    prompt:
      "Find the Stripe customer with email ada@example.com, then cancel their active subscription at the end of the billing period. The subscription id is sub_9f2.",
    expected: [
      { name: "stripe_list_customers", args: { email: "ada@example.com" } },
      {
        name: "stripe_cancel_subscription",
        args: { subscription_id: "sub_9f2", at_period_end: true },
      },
    ],
    results: R({
      stripe_list_customers:
        '{"data":[{"id":"cus_77","email":"ada@example.com","name":"Ada L"}]}',
      stripe_cancel_subscription:
        '{"id":"sub_9f2","status":"active","cancel_at_period_end":true}',
    }),
    maxTurns: 10,
  },
  {
    id: "large-dense",
    note: "Worst case. 100 tools, 6 distinct calls across 4 namespaces. Retrieval overhead should eat the savings.",
    tools: ALL_TOOLS,
    prompt: [
      "Do a release check for owner=acme repo=web:",
      "1. list the open pull requests",
      "2. list the workflow runs with status=failure",
      "3. create an issue titled 'Release blocked' describing what you found",
      "4. post a message to the #eng-releases Slack channel linking the issue",
      "5. create a Jira Bug in project OPS with summary 'Release blocked'",
      "6. search Datadog logs for query 'service:web status:error'",
      "Do them in that order, one tool call per step.",
    ].join("\n"),
    expected: [
      { name: "github_list_pull_requests", args: { owner: "acme", repo: "web" } },
      { name: "github_list_workflow_runs", args: { owner: "acme", repo: "web" } },
      { name: "github_create_issue", args: { owner: "acme", repo: "web" } },
      { name: "slack_post_message" },
      { name: "jira_create_issue", args: { project_key: "OPS" } },
      { name: "datadog_search_logs" },
    ],
    results: R({
      github_list_pull_requests: '[{"number":12,"title":"fix: retry logic"}]',
      github_list_workflow_runs:
        '[{"id":991,"status":"failure","name":"ci","branch":"main"}]',
      github_create_issue: '{"number":45,"html_url":"https://gh/acme/web/45"}',
      slack_post_message: '{"ok":true,"ts":"1719_01.4"}',
      jira_create_issue: '{"key":"OPS-301"}',
      datadog_search_logs: '{"logs":[{"msg":"upstream timeout","count":18}]}',
    }),
    maxTurns: 16,
  },
  {
    id: "near-duplicates",
    note: "THE key risk test for minification. Four confusable issue-shaped tools; only one is correct.",
    tools: toolsByName([
      "github_list_issues",
      "github_search_issues",
      "github_get_issue",
      "github_update_issue",
      "jira_search_issues",
      "jira_get_issue",
      "linear_search_issues",
      "linear_get_issue",
      "notion_search",
      "slack_search_messages",
      "github_create_issue",
      "github_create_issue_comment",
      "jira_create_issue",
      "linear_create_issue",
      "github_list_pull_requests",
      "jira_list_projects",
      "linear_list_teams",
      "gdrive_search_files",
      "stripe_list_customers",
      "datadog_search_logs",
    ]),
    prompt:
      "Using GitHub's cross-repository search, find issues matching the query 'memory leak org:acme state:open'. Use the search endpoint, not a per-repo listing.",
    expected: [
      {
        name: "github_search_issues",
        args: { q: "memory leak org:acme state:open" },
      },
    ],
    results: R({
      github_search_issues:
        '{"total_count":2,"items":[{"number":88,"title":"memory leak in worker"}]}',
    }),
    maxTurns: 8,
  },
  {
    id: "deep-chain",
    note: "Argument fidelity through the translation layer. Each call consumes the previous result.",
    tools: subset(60, [
      "github_get_file_contents",
      "github_create_branch",
      "github_create_or_update_file",
      "github_create_pull_request",
    ]),
    prompt: [
      "In owner=acme repo=web:",
      "1. read the file 'config/app.json' on the main branch",
      "2. create a branch named 'bump-timeout' from main",
      "3. write the base64 content 'eyJ0aW1lb3V0IjogNjB9' to 'config/app.json' on that branch with commit message 'chore: bump timeout'",
      "4. open a pull request from 'bump-timeout' into 'main' titled 'chore: bump timeout'",
      "One tool call per step, in order.",
    ].join("\n"),
    expected: [
      {
        name: "github_get_file_contents",
        args: { owner: "acme", repo: "web", path: "config/app.json" },
      },
      {
        name: "github_create_branch",
        args: { owner: "acme", repo: "web", branch: "bump-timeout" },
      },
      {
        name: "github_create_or_update_file",
        args: {
          owner: "acme",
          repo: "web",
          path: "config/app.json",
          content: "eyJ0aW1lb3V0IjogNjB9",
        },
      },
      {
        name: "github_create_pull_request",
        args: {
          owner: "acme",
          repo: "web",
          head: "bump-timeout",
          base: "main",
        },
      },
    ],
    results: R({
      github_get_file_contents:
        '{"path":"config/app.json","content":"eyJ0aW1lb3V0IjogMzB9","sha":"a1b2"}',
      github_create_branch: '{"ref":"refs/heads/bump-timeout"}',
      github_create_or_update_file: '{"commit":{"sha":"c3d4"}}',
      github_create_pull_request: '{"number":46,"state":"open"}',
    }),
    maxTurns: 12,
  },
];
