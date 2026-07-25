/**
 * Accuracy discrimination probe.
 *
 * Round 1 returned 100% task accuracy for every arm, which means those
 * scenarios could not discriminate. Since accuracy is the *entire* risk of
 * name minification, these scenarios are built specifically to break it:
 * dense clusters of confusable tools where exactly one is correct, and where
 * the correct choice turns on a distinction carried by the tool NAME.
 */
import { toolsByName, ALL_TOOLS } from "./fixtures/tools.js";
import type { Scenario } from "./scenarios.js";

const CONFUSABLE = toolsByName([
  "github_list_issues",
  "github_search_issues",
  "github_get_issue",
  "github_update_issue",
  "github_create_issue",
  "github_create_issue_comment",
  "github_list_pull_requests",
  "github_get_pull_request",
  "github_create_pull_request",
  "github_merge_pull_request",
  "github_create_review",
  "jira_search_issues",
  "jira_get_issue",
  "jira_create_issue",
  "jira_update_issue",
  "jira_add_comment",
  "jira_transition_issue",
  "jira_assign_issue",
  "linear_search_issues",
  "linear_get_issue",
  "linear_create_issue",
  "linear_update_issue",
  "linear_create_comment",
  "slack_search_messages",
  "slack_post_message",
  "slack_update_message",
  "notion_search",
  "notion_get_page",
  "gdrive_search_files",
  "gdrive_get_file",
]);

export const ACCURACY_SCENARIOS: Scenario[] = [
  {
    id: "acc-search-vs-list",
    note: "search vs list: cross-repo query must pick search_issues, not list_issues.",
    tools: CONFUSABLE,
    prompt:
      "Across all of the acme organisation's repositories, find open issues mentioning 'memory leak'. Use the query string 'memory leak org:acme state:open'.",
    expected: [{ name: "github_search_issues", args: { q: "memory leak org:acme state:open" } }],
    results: { github_search_issues: '{"total_count":3,"items":[{"number":88}]}' },
    maxTurns: 6,
  },
  {
    id: "acc-comment-vs-update",
    note: "comment vs update: adding a note must not mutate the issue body.",
    tools: CONFUSABLE,
    prompt:
      "Add the note 'reproduced on 22.3, not on 22.2' to GitHub issue 88 in owner=acme repo=web. Do not change the issue's title, body or state.",
    expected: [
      {
        name: "github_create_issue_comment",
        args: { owner: "acme", repo: "web", issue_number: 88 },
      },
    ],
    results: { github_create_issue_comment: '{"id":9001}' },
    maxTurns: 6,
  },
  {
    id: "acc-cross-product",
    note: "Three products with identically-shaped tools; only Linear is correct.",
    tools: CONFUSABLE,
    prompt:
      "In Linear — not GitHub and not Jira — find issues matching the text 'flaky test'. Return the first 10.",
    expected: [{ name: "linear_search_issues", args: { query: "flaky test" } }],
    results: { linear_search_issues: '{"nodes":[{"id":"LIN-4","title":"flaky test"}]}' },
    maxTurns: 6,
  },
  {
    id: "acc-review-vs-merge",
    note: "Approving a PR is create_review(APPROVE), not merge_pull_request.",
    tools: CONFUSABLE,
    prompt:
      "Approve pull request 12 in owner=acme repo=web with the comment 'looks good'. Approve only — do not merge it.",
    expected: [
      {
        name: "github_create_review",
        args: { owner: "acme", repo: "web", pull_number: 12, event: "APPROVE" },
      },
    ],
    results: { github_create_review: '{"id":7,"state":"APPROVED"}' },
    maxTurns: 6,
  },
  {
    id: "acc-haystack",
    note: "Same distinction as acc-search-vs-list but buried in the full 100-tool catalogue.",
    tools: ALL_TOOLS,
    prompt:
      "Across all of the acme organisation's repositories, find open issues mentioning 'memory leak'. Use the query string 'memory leak org:acme state:open'.",
    expected: [{ name: "github_search_issues", args: { q: "memory leak org:acme state:open" } }],
    results: { github_search_issues: '{"total_count":3,"items":[{"number":88}]}' },
    maxTurns: 6,
  },
];
