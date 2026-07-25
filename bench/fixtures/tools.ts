/**
 * Realistic MCP-style tool catalog.
 *
 * Source of truth is compact; we expand it into the verbose JSON Schema that a
 * real MCP server actually emits (per-property descriptions, additionalProperties,
 * required arrays). The verbosity is the point — it is what we are measuring.
 */
import type { ToolDef, JsonSchema } from "../core/types.js";

type ParamSpec = {
  name: string;
  type: string;
  desc: string;
  required?: boolean;
  enum?: string[];
  items?: string;
};

type Spec = {
  ns: string;
  op: string;
  desc: string;
  params: ParamSpec[];
};

const P = (
  name: string,
  type: string,
  desc: string,
  required = false,
  extra: Partial<ParamSpec> = {},
): ParamSpec => ({ name, type, desc, required, ...extra });

const specs: Spec[] = [
  // ---- github (18) -------------------------------------------------------
  { ns: "github", op: "create_pull_request", desc: "Create a new pull request in a GitHub repository.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository without the .git extension.",true),P("title","string","The title of the new pull request.",true),P("head","string","The name of the branch where your changes are implemented.",true),P("base","string","The name of the branch you want the changes pulled into.",true),P("body","string","The contents of the pull request, in Markdown."),P("draft","boolean","Whether to create the pull request as a draft.")] },
  { ns: "github", op: "list_pull_requests", desc: "List pull requests in a GitHub repository.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("state","string","Filter by pull request state.",false,{enum:["open","closed","all"]}),P("sort","string","What to sort results by.",false,{enum:["created","updated","popularity"]}),P("per_page","integer","Number of results per page, max 100.")] },
  { ns: "github", op: "get_pull_request", desc: "Get details of a single pull request by number.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("pull_number","integer","The number that identifies the pull request.",true)] },
  { ns: "github", op: "merge_pull_request", desc: "Merge an open pull request.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("pull_number","integer","The number that identifies the pull request.",true),P("merge_method","string","The merge method to use.",false,{enum:["merge","squash","rebase"]})] },
  { ns: "github", op: "create_issue", desc: "Create a new issue in a GitHub repository.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("title","string","The title of the issue.",true),P("body","string","The contents of the issue, in Markdown."),P("labels","array","Labels to associate with this issue.",false,{items:"string"}),P("assignees","array","Logins for users to assign to this issue.",false,{items:"string"})] },
  { ns: "github", op: "list_issues", desc: "List issues in a GitHub repository, filtered by state and labels.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("state","string","Filter by issue state.",false,{enum:["open","closed","all"]}),P("labels","array","Comma-separated list of label names.",false,{items:"string"}),P("since","string","Only issues updated at or after this ISO 8601 timestamp.")] },
  { ns: "github", op: "search_issues", desc: "Search issues and pull requests across GitHub using a query string.", params: [P("q","string","The GitHub search query, using GitHub search syntax.",true),P("sort","string","Sort field for results.",false,{enum:["comments","created","updated"]}),P("order","string","Sort order.",false,{enum:["asc","desc"]}),P("per_page","integer","Number of results per page, max 100.")] },
  { ns: "github", op: "get_issue", desc: "Get details of a single issue by number.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("issue_number","integer","The number that identifies the issue.",true)] },
  { ns: "github", op: "update_issue", desc: "Update an existing issue's title, body, state, or labels.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("issue_number","integer","The number that identifies the issue.",true),P("title","string","The new title of the issue."),P("state","string","The new state of the issue.",false,{enum:["open","closed"]})] },
  { ns: "github", op: "create_issue_comment", desc: "Add a comment to an existing issue or pull request.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("issue_number","integer","The number that identifies the issue.",true),P("body","string","The contents of the comment, in Markdown.",true)] },
  { ns: "github", op: "list_commits", desc: "List commits on a repository branch.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("sha","string","SHA or branch name to start listing commits from."),P("path","string","Only commits containing this file path will be returned."),P("per_page","integer","Number of results per page, max 100.")] },
  { ns: "github", op: "get_commit", desc: "Get a single commit including its diff and stats.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("ref","string","The commit reference: a SHA, branch name, or tag name.",true)] },
  { ns: "github", op: "get_file_contents", desc: "Get the contents of a file or directory in a repository.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("path","string","The path to the file or directory.",true),P("ref","string","The name of the commit, branch, or tag.")] },
  { ns: "github", op: "create_or_update_file", desc: "Create a new file or update an existing file in a repository.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("path","string","The path to the file.",true),P("content","string","The new file content, Base64 encoded.",true),P("message","string","The commit message.",true),P("branch","string","The branch name to commit to.")] },
  { ns: "github", op: "create_branch", desc: "Create a new branch in a repository from a source ref.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("branch","string","The name of the new branch.",true),P("from_branch","string","The source branch to create from.")] },
  { ns: "github", op: "list_workflow_runs", desc: "List GitHub Actions workflow runs for a repository.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("status","string","Filter runs by status.",false,{enum:["queued","in_progress","completed","failure","success"]}),P("branch","string","Filter runs by branch name.")] },
  { ns: "github", op: "get_workflow_run_logs", desc: "Download the logs for a specific GitHub Actions workflow run.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("run_id","integer","The unique identifier of the workflow run.",true)] },
  { ns: "github", op: "create_review", desc: "Create a review on a pull request with comments and an approval state.", params: [P("owner","string","The account owner of the repository.",true),P("repo","string","The name of the repository.",true),P("pull_number","integer","The number that identifies the pull request.",true),P("event","string","The review action to perform.",true,{enum:["APPROVE","REQUEST_CHANGES","COMMENT"]}),P("body","string","The body text of the review.")] },

  // ---- slack (12) --------------------------------------------------------
  { ns: "slack", op: "post_message", desc: "Post a message to a Slack channel.", params: [P("channel","string","The channel ID or name to post to.",true),P("text","string","The message text to post.",true),P("thread_ts","string","Timestamp of the parent message to reply in a thread."),P("blocks","array","Structured Block Kit blocks for rich formatting.",false,{items:"object"})] },
  { ns: "slack", op: "update_message", desc: "Update an existing Slack message.", params: [P("channel","string","The channel ID containing the message.",true),P("ts","string","Timestamp of the message to update.",true),P("text","string","The new message text.",true)] },
  { ns: "slack", op: "delete_message", desc: "Delete a message from a Slack channel.", params: [P("channel","string","The channel ID containing the message.",true),P("ts","string","Timestamp of the message to delete.",true)] },
  { ns: "slack", op: "list_channels", desc: "List channels in the Slack workspace.", params: [P("types","string","Comma-separated channel types to include."),P("limit","integer","Maximum number of channels to return."),P("exclude_archived","boolean","Whether to exclude archived channels.")] },
  { ns: "slack", op: "get_channel_history", desc: "Fetch recent message history from a Slack channel.", params: [P("channel","string","The channel ID to fetch history for.",true),P("limit","integer","Number of messages to return, max 1000."),P("oldest","string","Only messages after this timestamp.")] },
  { ns: "slack", op: "search_messages", desc: "Search for messages across the Slack workspace.", params: [P("query","string","The search query string.",true),P("sort","string","How to sort results.",false,{enum:["score","timestamp"]}),P("count","integer","Number of results to return.")] },
  { ns: "slack", op: "add_reaction", desc: "Add an emoji reaction to a Slack message.", params: [P("channel","string","The channel ID containing the message.",true),P("timestamp","string","Timestamp of the message.",true),P("name","string","The emoji name without colons.",true)] },
  { ns: "slack", op: "list_users", desc: "List all users in the Slack workspace.", params: [P("limit","integer","Maximum number of users to return."),P("include_locale","boolean","Whether to include locale information.")] },
  { ns: "slack", op: "get_user_info", desc: "Get profile information for a specific Slack user.", params: [P("user","string","The user ID to look up.",true)] },
  { ns: "slack", op: "create_channel", desc: "Create a new Slack channel.", params: [P("name","string","The name of the channel to create.",true),P("is_private","boolean","Whether the channel should be private.")] },
  { ns: "slack", op: "invite_to_channel", desc: "Invite users to a Slack channel.", params: [P("channel","string","The channel ID to invite users to.",true),P("users","array","User IDs to invite.",true,{items:"string"})] },
  { ns: "slack", op: "upload_file", desc: "Upload a file to a Slack channel.", params: [P("channels","string","Comma-separated channel IDs to share the file in.",true),P("content","string","The file content as text.",true),P("filename","string","The name of the file."),P("title","string","The title of the file.")] },

  // ---- jira (12) ---------------------------------------------------------
  { ns: "jira", op: "create_issue", desc: "Create a new Jira issue in a project.", params: [P("project_key","string","The key of the project to create the issue in.",true),P("summary","string","A brief summary of the issue.",true),P("issue_type","string","The type of issue to create.",true,{enum:["Bug","Task","Story","Epic"]}),P("description","string","A detailed description of the issue."),P("priority","string","The priority of the issue.",false,{enum:["Highest","High","Medium","Low","Lowest"]}),P("assignee","string","The account ID of the assignee.")] },
  { ns: "jira", op: "update_issue", desc: "Update fields on an existing Jira issue.", params: [P("issue_key","string","The key of the issue to update.",true),P("summary","string","The new summary."),P("description","string","The new description."),P("priority","string","The new priority.",false,{enum:["Highest","High","Medium","Low","Lowest"]})] },
  { ns: "jira", op: "get_issue", desc: "Get full details of a Jira issue by key.", params: [P("issue_key","string","The key of the issue to retrieve.",true),P("fields","array","Specific fields to return.",false,{items:"string"})] },
  { ns: "jira", op: "search_issues", desc: "Search Jira issues using JQL query syntax.", params: [P("jql","string","The JQL query string.",true),P("max_results","integer","Maximum number of results to return."),P("start_at","integer","Index of the first result to return.")] },
  { ns: "jira", op: "transition_issue", desc: "Move a Jira issue to a different workflow status.", params: [P("issue_key","string","The key of the issue to transition.",true),P("transition_id","string","The ID of the transition to perform.",true),P("comment","string","A comment to add with the transition.")] },
  { ns: "jira", op: "add_comment", desc: "Add a comment to a Jira issue.", params: [P("issue_key","string","The key of the issue to comment on.",true),P("body","string","The comment text.",true)] },
  { ns: "jira", op: "list_projects", desc: "List all Jira projects visible to the current user.", params: [P("max_results","integer","Maximum number of projects to return.")] },
  { ns: "jira", op: "get_sprint", desc: "Get details of a specific sprint including its issues.", params: [P("sprint_id","integer","The ID of the sprint.",true)] },
  { ns: "jira", op: "list_sprints", desc: "List sprints for a Jira board.", params: [P("board_id","integer","The ID of the board.",true),P("state","string","Filter sprints by state.",false,{enum:["active","future","closed"]})] },
  { ns: "jira", op: "assign_issue", desc: "Assign a Jira issue to a user.", params: [P("issue_key","string","The key of the issue to assign.",true),P("account_id","string","The account ID of the assignee.",true)] },
  { ns: "jira", op: "link_issues", desc: "Create a link between two Jira issues.", params: [P("inward_issue","string","The key of the inward issue.",true),P("outward_issue","string","The key of the outward issue.",true),P("link_type","string","The type of link to create.",true)] },
  { ns: "jira", op: "get_transitions", desc: "List the workflow transitions available for a Jira issue.", params: [P("issue_key","string","The key of the issue.",true)] },

  // ---- gdrive (10) -------------------------------------------------------
  { ns: "gdrive", op: "search_files", desc: "Search for files in Google Drive by name or content.", params: [P("query","string","The search query string.",true),P("page_size","integer","Maximum number of files to return."),P("order_by","string","Field to sort results by.")] },
  { ns: "gdrive", op: "get_file", desc: "Get metadata for a Google Drive file.", params: [P("file_id","string","The ID of the file.",true),P("fields","string","Comma-separated list of fields to include.")] },
  { ns: "gdrive", op: "download_file", desc: "Download the contents of a Google Drive file as text.", params: [P("file_id","string","The ID of the file to download.",true),P("mime_type","string","The MIME type to export the file as.")] },
  { ns: "gdrive", op: "create_file", desc: "Create a new file in Google Drive.", params: [P("name","string","The name of the file.",true),P("content","string","The content of the file.",true),P("parent_id","string","The ID of the parent folder."),P("mime_type","string","The MIME type of the file.")] },
  { ns: "gdrive", op: "update_file", desc: "Update the contents or metadata of a Google Drive file.", params: [P("file_id","string","The ID of the file to update.",true),P("content","string","The new content of the file."),P("name","string","The new name of the file.")] },
  { ns: "gdrive", op: "delete_file", desc: "Move a Google Drive file to the trash.", params: [P("file_id","string","The ID of the file to delete.",true)] },
  { ns: "gdrive", op: "list_folder", desc: "List the contents of a Google Drive folder.", params: [P("folder_id","string","The ID of the folder to list.",true),P("page_size","integer","Maximum number of files to return.")] },
  { ns: "gdrive", op: "create_folder", desc: "Create a new folder in Google Drive.", params: [P("name","string","The name of the folder.",true),P("parent_id","string","The ID of the parent folder.")] },
  { ns: "gdrive", op: "share_file", desc: "Grant a user permission to access a Google Drive file.", params: [P("file_id","string","The ID of the file to share.",true),P("email","string","The email address of the user.",true),P("role","string","The permission role to grant.",true,{enum:["reader","commenter","writer","owner"]})] },
  { ns: "gdrive", op: "copy_file", desc: "Create a copy of a Google Drive file.", params: [P("file_id","string","The ID of the file to copy.",true),P("name","string","The name for the copied file.")] },

  // ---- stripe (12) -------------------------------------------------------
  { ns: "stripe", op: "create_customer", desc: "Create a new Stripe customer record.", params: [P("email","string","The customer's email address.",true),P("name","string","The customer's full name."),P("description","string","An arbitrary description of the customer."),P("metadata","object","Set of key-value pairs to attach to the customer.")] },
  { ns: "stripe", op: "get_customer", desc: "Retrieve a Stripe customer by ID.", params: [P("customer_id","string","The ID of the customer to retrieve.",true)] },
  { ns: "stripe", op: "list_customers", desc: "List Stripe customers with optional filters.", params: [P("email","string","Filter customers by email address."),P("limit","integer","Number of customers to return, max 100."),P("starting_after","string","Cursor for pagination.")] },
  { ns: "stripe", op: "update_customer", desc: "Update an existing Stripe customer.", params: [P("customer_id","string","The ID of the customer to update.",true),P("email","string","The new email address."),P("name","string","The new name.")] },
  { ns: "stripe", op: "create_charge", desc: "Create a charge against a customer or payment source.", params: [P("amount","integer","Amount in the smallest currency unit, e.g. cents.",true),P("currency","string","Three-letter ISO currency code.",true),P("customer","string","The ID of the customer to charge."),P("description","string","An arbitrary description of the charge.")] },
  { ns: "stripe", op: "create_refund", desc: "Refund a previously created charge, fully or partially.", params: [P("charge_id","string","The ID of the charge to refund.",true),P("amount","integer","Amount to refund in the smallest currency unit."),P("reason","string","The reason for the refund.",false,{enum:["duplicate","fraudulent","requested_by_customer"]})] },
  { ns: "stripe", op: "list_charges", desc: "List charges, optionally filtered by customer.", params: [P("customer","string","Only return charges for this customer."),P("limit","integer","Number of charges to return, max 100.")] },
  { ns: "stripe", op: "create_subscription", desc: "Create a recurring subscription for a customer.", params: [P("customer","string","The ID of the customer to subscribe.",true),P("price_id","string","The ID of the price to subscribe to.",true),P("trial_days","integer","Number of trial days before billing starts.")] },
  { ns: "stripe", op: "cancel_subscription", desc: "Cancel an active Stripe subscription.", params: [P("subscription_id","string","The ID of the subscription to cancel.",true),P("at_period_end","boolean","Whether to cancel at the end of the billing period.")] },
  { ns: "stripe", op: "list_subscriptions", desc: "List subscriptions, optionally filtered by customer or status.", params: [P("customer","string","Only return subscriptions for this customer."),P("status","string","Filter by subscription status.",false,{enum:["active","past_due","canceled","trialing"]})] },
  { ns: "stripe", op: "create_invoice", desc: "Create a draft invoice for a customer.", params: [P("customer","string","The ID of the customer to invoice.",true),P("auto_advance","boolean","Whether Stripe should auto-finalize the invoice.")] },
  { ns: "stripe", op: "get_balance", desc: "Retrieve the current Stripe account balance.", params: [] },

  // ---- aws (12) ----------------------------------------------------------
  { ns: "aws", op: "s3_list_buckets", desc: "List all S3 buckets in the AWS account.", params: [] },
  { ns: "aws", op: "s3_list_objects", desc: "List objects in an S3 bucket under an optional prefix.", params: [P("bucket","string","The name of the S3 bucket.",true),P("prefix","string","Limit results to keys beginning with this prefix."),P("max_keys","integer","Maximum number of keys to return.")] },
  { ns: "aws", op: "s3_get_object", desc: "Download the contents of an S3 object.", params: [P("bucket","string","The name of the S3 bucket.",true),P("key","string","The key of the object to retrieve.",true)] },
  { ns: "aws", op: "s3_put_object", desc: "Upload an object to an S3 bucket.", params: [P("bucket","string","The name of the S3 bucket.",true),P("key","string","The key to store the object under.",true),P("body","string","The content of the object.",true),P("content_type","string","The MIME type of the object.")] },
  { ns: "aws", op: "ec2_list_instances", desc: "List EC2 instances with optional state filtering.", params: [P("region","string","The AWS region to query."),P("state","string","Filter instances by state.",false,{enum:["pending","running","stopping","stopped","terminated"]})] },
  { ns: "aws", op: "ec2_start_instance", desc: "Start a stopped EC2 instance.", params: [P("instance_id","string","The ID of the instance to start.",true),P("region","string","The AWS region of the instance.")] },
  { ns: "aws", op: "ec2_stop_instance", desc: "Stop a running EC2 instance.", params: [P("instance_id","string","The ID of the instance to stop.",true),P("region","string","The AWS region of the instance.")] },
  { ns: "aws", op: "lambda_invoke", desc: "Invoke an AWS Lambda function with a payload.", params: [P("function_name","string","The name or ARN of the Lambda function.",true),P("payload","object","The JSON payload to pass to the function."),P("invocation_type","string","How to invoke the function.",false,{enum:["RequestResponse","Event","DryRun"]})] },
  { ns: "aws", op: "lambda_list_functions", desc: "List Lambda functions in the account.", params: [P("region","string","The AWS region to query."),P("max_items","integer","Maximum number of functions to return.")] },
  { ns: "aws", op: "cloudwatch_get_logs", desc: "Fetch log events from a CloudWatch log group.", params: [P("log_group","string","The name of the log group.",true),P("start_time","integer","Start of the time range, in epoch milliseconds."),P("filter_pattern","string","A filter pattern to apply to the log events.")] },
  { ns: "aws", op: "cloudwatch_get_metrics", desc: "Retrieve CloudWatch metric statistics for a resource.", params: [P("namespace","string","The CloudWatch namespace.",true),P("metric_name","string","The name of the metric.",true),P("period","integer","The granularity in seconds.")] },
  { ns: "aws", op: "iam_list_roles", desc: "List IAM roles in the AWS account.", params: [P("path_prefix","string","Filter roles by path prefix."),P("max_items","integer","Maximum number of roles to return.")] },

  // ---- notion (10) -------------------------------------------------------
  { ns: "notion", op: "search", desc: "Search Notion pages and databases by title.", params: [P("query","string","The text to search for in page and database titles.",true),P("filter_type","string","Restrict results to a single object type.",false,{enum:["page","database"]}),P("page_size","integer","Number of results to return, max 100.")] },
  { ns: "notion", op: "get_page", desc: "Retrieve a Notion page and its properties.", params: [P("page_id","string","The ID of the page to retrieve.",true)] },
  { ns: "notion", op: "create_page", desc: "Create a new Notion page in a parent page or database.", params: [P("parent_id","string","The ID of the parent page or database.",true),P("title","string","The title of the new page.",true),P("content","string","The page body as Markdown.")] },
  { ns: "notion", op: "update_page", desc: "Update properties on an existing Notion page.", params: [P("page_id","string","The ID of the page to update.",true),P("properties","object","The properties to update on the page.",true)] },
  { ns: "notion", op: "append_blocks", desc: "Append content blocks to the end of a Notion page.", params: [P("page_id","string","The ID of the page to append to.",true),P("content","string","The content to append as Markdown.",true)] },
  { ns: "notion", op: "get_block_children", desc: "List the child blocks of a Notion page or block.", params: [P("block_id","string","The ID of the parent block.",true),P("page_size","integer","Number of blocks to return.")] },
  { ns: "notion", op: "query_database", desc: "Query a Notion database with filters and sorts.", params: [P("database_id","string","The ID of the database to query.",true),P("filter","object","The filter conditions to apply."),P("sorts","array","The sort criteria to apply.",false,{items:"object"})] },
  { ns: "notion", op: "create_database", desc: "Create a new Notion database under a parent page.", params: [P("parent_id","string","The ID of the parent page.",true),P("title","string","The title of the database.",true),P("properties","object","The property schema of the database.",true)] },
  { ns: "notion", op: "delete_block", desc: "Archive a Notion block, page, or database.", params: [P("block_id","string","The ID of the block to archive.",true)] },
  { ns: "notion", op: "list_users", desc: "List all users in the Notion workspace.", params: [P("page_size","integer","Number of users to return.")] },

  // ---- linear (8) --------------------------------------------------------
  { ns: "linear", op: "create_issue", desc: "Create a new issue in Linear.", params: [P("team_id","string","The ID of the team to create the issue in.",true),P("title","string","The title of the issue.",true),P("description","string","The issue description in Markdown."),P("priority","integer","Priority from 0 (none) to 4 (low)."),P("assignee_id","string","The ID of the user to assign.")] },
  { ns: "linear", op: "update_issue", desc: "Update an existing Linear issue.", params: [P("issue_id","string","The ID of the issue to update.",true),P("title","string","The new title."),P("state_id","string","The ID of the new workflow state.")] },
  { ns: "linear", op: "get_issue", desc: "Get a single Linear issue by ID or identifier.", params: [P("issue_id","string","The ID or identifier of the issue.",true)] },
  { ns: "linear", op: "search_issues", desc: "Search Linear issues by text query.", params: [P("query","string","The search query string.",true),P("first","integer","Number of results to return.")] },
  { ns: "linear", op: "list_teams", desc: "List all teams in the Linear workspace.", params: [] },
  { ns: "linear", op: "list_projects", desc: "List projects in the Linear workspace.", params: [P("team_id","string","Filter projects by team ID.")] },
  { ns: "linear", op: "create_comment", desc: "Add a comment to a Linear issue.", params: [P("issue_id","string","The ID of the issue to comment on.",true),P("body","string","The comment text in Markdown.",true)] },
  { ns: "linear", op: "list_cycles", desc: "List cycles (sprints) for a Linear team.", params: [P("team_id","string","The ID of the team.",true)] },

  // ---- datadog (6) -------------------------------------------------------
  { ns: "datadog", op: "query_metrics", desc: "Query time-series metrics from Datadog.", params: [P("query","string","The metric query string.",true),P("from","integer","Start of the query window, epoch seconds.",true),P("to","integer","End of the query window, epoch seconds.",true)] },
  { ns: "datadog", op: "list_monitors", desc: "List Datadog monitors, optionally filtered by tag.", params: [P("tags","string","Comma-separated tags to filter by."),P("monitor_tags","string","Comma-separated monitor tags to filter by.")] },
  { ns: "datadog", op: "get_monitor", desc: "Get details of a single Datadog monitor.", params: [P("monitor_id","integer","The ID of the monitor.",true)] },
  { ns: "datadog", op: "mute_monitor", desc: "Mute a Datadog monitor for a period of time.", params: [P("monitor_id","integer","The ID of the monitor to mute.",true),P("end","integer","When the mute should expire, epoch seconds.")] },
  { ns: "datadog", op: "search_logs", desc: "Search Datadog logs with a query and time range.", params: [P("query","string","The log search query.",true),P("from","string","Start of the search window."),P("limit","integer","Maximum number of logs to return.")] },
  { ns: "datadog", op: "create_event", desc: "Post a custom event to the Datadog event stream.", params: [P("title","string","The event title.",true),P("text","string","The event body text.",true),P("alert_type","string","The alert level of the event.",false,{enum:["error","warning","info","success"]})] },
];

function expand(spec: Spec): ToolDef {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  for (const p of spec.params) {
    const prop: any = { type: p.type, description: p.desc };
    if (p.enum) prop.enum = p.enum;
    if (p.items) prop.items = { type: p.items };
    properties[p.name] = prop;
    if (p.required) required.push(p.name);
  }
  return {
    name: `${spec.ns}_${spec.op}`,
    ns: spec.ns,
    op: spec.op,
    description: spec.desc,
    input_schema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    },
  };
}

export const ALL_TOOLS: ToolDef[] = specs.map(expand);

export function toolsByName(names: string[]): ToolDef[] {
  const map = new Map(ALL_TOOLS.map((t) => [t.name, t]));
  return names.map((n) => {
    const t = map.get(n);
    if (!t) throw new Error(`unknown tool in fixture: ${n}`);
    return t;
  });
}

/** Deterministic subset: all tools from the given namespaces, plus padding. */
export function subset(count: number, mustInclude: string[] = []): ToolDef[] {
  const must = toolsByName(mustInclude);
  const rest = ALL_TOOLS.filter((t) => !mustInclude.includes(t.name));
  const picked = [...must, ...rest.slice(0, Math.max(0, count - must.length))];
  // Deterministic ordering — prefix stability matters for cache comparability.
  return picked.sort((a, b) => a.name.localeCompare(b.name));
}
