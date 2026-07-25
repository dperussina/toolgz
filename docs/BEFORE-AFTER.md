# Before and after — generated, not illustrated

Every block on this page is emitted by `docs/generate-examples.ts`, which
calls the real `compress()` and `resolve()`. Regenerate with:

```bash
npx tsx docs/generate-examples.ts
```

`tests/examples.test.ts` regenerates and compares, so this file cannot drift
from the code that produced it.

toolgz modifies exactly two things: **the tools array** and **the system
prompt**. Nothing else about your request changes. Both are shown in full
below, for the same three tools.

Token counts are from Anthropic's `count_tokens` endpoint on `claude-opus-5`, measured against a 25-token empty baseline (system prompt and a one-character user message, no tools).

---

## The input

Three tools across two namespaces, in the shape an MCP server produces. As sent uncompressed, the request is **1021 tokens**.

```json
[
  {
    "name": "github_create_issue",
    "description": "Create a new issue in a GitHub repository. The issue will be created by the authenticated user.",
    "input_schema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string",
          "description": "The account owner of the repository. Case insensitive."
        },
        "repo": {
          "type": "string",
          "description": "The name of the repository without the .git extension."
        },
        "title": {
          "type": "string",
          "description": "The title of the issue."
        },
        "body": {
          "type": "string",
          "description": "The contents of the issue, in GitHub-flavoured Markdown."
        },
        "labels": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Labels to associate with this issue."
        }
      },
      "required": [
        "owner",
        "repo",
        "title"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "github_search_issues",
    "description": "Search issues and pull requests across all of GitHub using a query string.",
    "input_schema": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "description": "The search query, using GitHub search syntax."
        },
        "sort": {
          "type": "string",
          "enum": [
            "comments",
            "created",
            "updated"
          ],
          "description": "The field to sort results by."
        },
        "per_page": {
          "type": "integer",
          "description": "Number of results per page, maximum 100."
        }
      },
      "required": [
        "q"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "slack_post_message",
    "description": "Post a message to a Slack channel on behalf of the app.",
    "input_schema": {
      "type": "object",
      "properties": {
        "channel": {
          "type": "string",
          "description": "The channel ID or name to post the message to."
        },
        "text": {
          "type": "string",
          "description": "The message text to post."
        },
        "thread_ts": {
          "type": "string",
          "description": "Timestamp of a parent message, to reply in a thread."
        }
      },
      "required": [
        "channel",
        "text"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  }
]
```

And the system prompt, untouched:

```text
You are an operations agent. Use the tools available to you.
```

---

## Level 1 — signature lines (the default)

One native tool per input tool, real names kept. The JSON Schema loses its prose and boilerplate but keeps everything that constrains sampling: types, `enum`, `required`, array item types. The system prompt is **unchanged** — level 1 adds no preamble.

**781 tokens** total, against 1021 uncompressed — the tool block itself goes from 996 tokens to 756, a **24% reduction**.

### Tools array — 3 entries

```json
[
  {
    "name": "github_create_issue",
    "description": "github_create_issue(owner,repo,title,body?,labels?:string[]) — Create a new issue in a GitHub repository.",
    "input_schema": {
      "type": "object",
      "properties": {
        "owner": {
          "type": "string"
        },
        "repo": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "body": {
          "type": "string"
        },
        "labels": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "owner",
        "repo",
        "title"
      ]
    }
  },
  {
    "name": "github_search_issues",
    "description": "github_search_issues(q,sort?:comments|created|updated,per_page?) — Search issues and pull requests across all of GitHub using a query string.",
    "input_schema": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string"
        },
        "sort": {
          "type": "string",
          "enum": [
            "comments",
            "created",
            "updated"
          ]
        },
        "per_page": {
          "type": "integer"
        }
      },
      "required": [
        "q"
      ]
    }
  },
  {
    "name": "slack_post_message",
    "description": "slack_post_message(channel,text,thread_ts?) — Post a message to a Slack channel on behalf of the app.",
    "input_schema": {
      "type": "object",
      "properties": {
        "channel": {
          "type": "string"
        },
        "text": {
          "type": "string"
        },
        "thread_ts": {
          "type": "string"
        }
      },
      "required": [
        "channel",
        "text"
      ]
    }
  }
]
```

### System prompt

Unchanged:

```text
You are an operations agent. Use the tools available to you.
```

### Round trip

What the model emits at this level:

```json
{
  "name": "github_create_issue",
  "args": {
    "owner": "acme",
    "repo": "web",
    "title": "Retry logic drops errors"
  }
}
```

What `resolve()` hands your dispatcher — the original name and arguments:

```json
{
  "kind": "call",
  "name": "github_create_issue",
  "args": {
    "owner": "acme",
    "repo": "web",
    "title": "Retry logic drops errors"
  }
}
```

---

## Level 2 — one tool per namespace

Operations collapse into a compound tool per namespace, with the op names as an `enum` so the sampler still constrains that field. Arguments move into a generic object, which is where provider-side schema enforcement is lost. The system prompt is still unchanged.

**631 tokens** total, against 1021 uncompressed — the tool block itself goes from 996 tokens to 606, a **39% reduction**.

### Tools array — 3 entries

```json
[
  {
    "name": "github",
    "description": "github operations. Call describe_op first if unsure of an op's parameters.",
    "input_schema": {
      "type": "object",
      "properties": {
        "op": {
          "type": "string",
          "enum": [
            "create_issue",
            "search_issues"
          ]
        },
        "args": {
          "type": "object"
        }
      },
      "required": [
        "op",
        "args"
      ]
    }
  },
  {
    "name": "slack",
    "description": "slack operations. Call describe_op first if unsure of an op's parameters.",
    "input_schema": {
      "type": "object",
      "properties": {
        "op": {
          "type": "string",
          "enum": [
            "post_message"
          ]
        },
        "args": {
          "type": "object"
        }
      },
      "required": [
        "op",
        "args"
      ]
    }
  },
  {
    "name": "describe_op",
    "description": "Return the full parameter signature and description for one operation.",
    "input_schema": {
      "type": "object",
      "properties": {
        "ns": {
          "type": "string"
        },
        "op": {
          "type": "string"
        }
      },
      "required": [
        "ns",
        "op"
      ]
    }
  }
]
```

### System prompt

Unchanged:

```text
You are an operations agent. Use the tools available to you.
```

### Round trip

What the model emits at this level:

```json
{
  "name": "github",
  "args": {
    "op": "create_issue",
    "args": {
      "owner": "acme",
      "repo": "web",
      "title": "Retry logic drops errors"
    }
  }
}
```

What `resolve()` hands your dispatcher — the original name and arguments:

```json
{
  "kind": "call",
  "name": "github_create_issue",
  "args": {
    "owner": "acme",
    "repo": "web",
    "title": "Retry logic drops errors"
  }
}
```

---

## Level 3 — dispatcher plus a cached map

Two tools total, regardless of how many you started with: `t` to dispatch and `q` to look up. This is the level that also modifies the system prompt — the map goes there so it sits behind a cache breakpoint.

**618 tokens** total, against 1021 uncompressed — the tool block itself goes from 996 tokens to 593, a **40% reduction**.

### Tools array — 2 entries

```json
[
  {
    "name": "t",
    "description": "Invoke a tool by its map code. Codes are listed in <toolmap> in the system prompt.",
    "input_schema": {
      "type": "object",
      "properties": {
        "f": {
          "type": "string"
        },
        "a": {
          "type": "object"
        }
      },
      "required": [
        "f"
      ]
    }
  },
  {
    "name": "q",
    "description": "Expand a map code to its full name, description and parameter signature (c), or search the map by keyword (s).",
    "input_schema": {
      "type": "object",
      "properties": {
        "c": {
          "type": "string"
        },
        "s": {
          "type": "string"
        }
      }
    }
  }
]
```

### System prompt

```text
You are an operations agent. Use the tools available to you.

<toolmap>
a0 github_create_issue owner,repo,title
a1 github_search_issues q
b0 slack_post_message channel,text
</toolmap>
Each line is: code name required-args. Invoke with t(f=<code>, a={…}). Use q to expand a code before calling if you are unsure of its parameters.
```

### Round trip

What the model emits at this level:

```json
{
  "name": "t",
  "args": {
    "f": "a0",
    "a": {
      "owner": "acme",
      "repo": "web",
      "title": "Retry logic drops errors"
    }
  }
}
```

What `resolve()` hands your dispatcher — the original name and arguments:

```json
{
  "kind": "call",
  "name": "github_create_issue",
  "args": {
    "owner": "acme",
    "repo": "web",
    "title": "Retry logic drops errors"
  }
}
```

---

## The recovery paths, at level 3

These are the outputs your loop feeds back to the model. They are written
for the model to read, not for a log file.

**Missing a required argument** — validated against your *original* schema:

```json
{
  "kind": "error",
  "message": "Missing required parameter \"repo\" for github_create_issue. Required: owner, repo, title.",
  "recoverable": true
}
```

**An invented code:**

```json
{
  "kind": "error",
  "message": "No map code \"zz9\". Search with q(s=…).",
  "recoverable": true
}
```

**The model asking what a code takes** (`q` by code):

```json
{
  "kind": "meta",
  "name": "q",
  "result": "a1 = github_search_issues(q,sort?:comments|created|updated,per_page?) — Search issues and pull requests across all of GitHub using a query string."
}
```

**The model searching the map** (`q` by keyword):

```json
{
  "kind": "meta",
  "name": "q",
  "result": "b0 = slack_post_message(channel,text,thread_ts?)"
}
```

---

## Scale

Three tools is a demo. The saving grows with the tool count, because the
level-3 wire payload is two tools no matter how many you start with:

| tools | level 0 | level 1 | level 2 | level 3 | wire tools at L3 |
|---:|---:|---:|---:|---:|---:|
| 3 | 1,807 | 1,007 | 948 | 688 | 2 |
| 10 | 6,178 | 3,388 | 2,395 | 853 | 2 |
| 30 | 18,081 | 10,101 | 2,555 | 1,320 | 2 |
| 100 | 60,448 | 33,748 | 3,115 | 2,993 | 2 |
| 300 | 181,091 | 101,581 | 4,915 | 8,120 | 2 |

Figures are characters of rendered payload (tools + preamble), which is a
shape argument rather than a billing one — token counts above come from the
provider's own endpoint.

See [RESULTS.md](RESULTS.md) for measured token, accuracy, latency and cost
figures across four providers, and [GUIDE.md](GUIDE.md) for how to wire it up.
