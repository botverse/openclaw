---
name: cc-spawn
description: "Spawn Claude Code sessions via sessions_spawn for coding tasks. Use when: (1) building features, (2) fixing bugs, (3) refactoring code, (4) any coding task in a git repo. NOT for: reading code (use read tool), simple one-liner edits (use edit tool), or tasks outside git repos. Requires Claude Code CLI installed and cc-spawn enabled in OpenClaw config."
metadata: { "openclaw": { "emoji": "🔧" } }
---

# CC Spawn — Claude Code via sessions_spawn

Delegate coding tasks to Claude Code through OpenClaw's `sessions_spawn` tool. CC runs as an isolated subprocess with its own context, tools, and session.

## When to Use

**Use CC spawn for:**

- Building new features or apps
- Fixing bugs (provide the error, repo, and context)
- Refactoring code
- Running tests and fixing failures
- Any multi-file coding work

**Do NOT use CC spawn for:**

- Reading code (use the `read` tool directly)
- Tasks outside a git repo

**Always specify the correct `repo`** — CC must launch in the relevant project directory, not a home directory or unrelated path.

## How to Spawn

```
sessions_spawn(
  task: "Build a REST API for user management with CRUD endpoints",
  repo: "/home/user/myproject",
  mode: "run"
)
```

### Key Parameters

| Parameter | Description                                                          |
| --------- | -------------------------------------------------------------------- |
| `task`    | The coding task — be specific about what to build/fix                |
| `repo`    | Path to the git repo (required for CC)                               |
| `mode`    | `"run"` for one-shot tasks (recommended), `"session"` for persistent |
| `label`   | Optional label for session resume                                    |
| `model`   | Override model (e.g. `"claude-sonnet-4"`)                            |

### What Happens

1. OpenClaw spawns a Claude Code CLI process in the target repo
2. CC gets its own tools (bash, file read/write, search, etc.)
3. Progress events relay back (text, tool use, media)
4. On completion, the result (text + cost + duration) is delivered to your chat
5. Images/documents from tool results are relayed automatically

## Task Writing Tips

Be specific. CC works best with clear, actionable tasks:

```
# ✅ Good
"Fix the login endpoint — it returns 500 when the email contains a +.
The bug is likely in src/auth/validate.ts. Add a test case."

# ❌ Too vague
"Fix the login bug"
```

Include:

- What to build/fix
- Where the relevant code lives (if you know)
- Expected behavior
- Any constraints (don't change X, use library Y)

## Session Intelligence

OpenClaw automatically decides whether to resume an existing session or start fresh. You don't need to manage this — just spawn with a task and repo.

**How it works:** A 5-factor scoring model evaluates all existing sessions for the repo:

| Factor           | Weight        | What it checks                                                                                                                          |
| ---------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Branch match     | 0.25          | Is the session on the same git branch?                                                                                                  |
| Recency          | 0-0.20        | How recently was the session active? (exponential decay)                                                                                |
| Task relevance   | -0.15 to 0.25 | How related is the new task to the session's previous work? (keyword overlap; LLM-scored via Haiku if `ANTHROPIC_API_KEY` is available) |
| Session health   | 0-0.15        | Is the session too large or old?                                                                                                        |
| Context capacity | 0-0.15        | Has the session been compacted? Budget remaining?                                                                                       |

**Score ≥ 0.6** → resume that session. **Below 0.6** → start fresh.

**Hard ceilings** (always start fresh):

- 3+ context compactions
- 70%+ budget consumed
- Unrelated task + 200+ messages

**Labels override scoring** — if you pass `label`, it does a direct lookup instead of scoring:

```
sessions_spawn(
  task: "Continue the auth refactor",
  repo: "/home/user/myproject",
  label: "auth-refactor",
  mode: "run"
)
```

Use labels when you know you want to continue specific work. Otherwise let the scoring decide.

## Completion

CC spawn is push-based — when CC finishes, the result auto-delivers to your chat. **Do not poll** `subagents list` or `sessions_list` in a loop. Only check status on-demand if asked.

## Media Relay

When CC generates images (plots, charts) or reads binary files (PNGs, PDFs), they are automatically relayed to the chat. No special handling needed — CC's tool_result content blocks containing base64 images/documents are extracted and delivered.

## Configuration

CC spawn must be enabled in `openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "subagents": {
        "claudeCode": {
          "enabled": true,
          "repos": {
            "myproject": "/home/user/myproject"
          }
        }
      }
    }
  }
}
```

## Cost & Limits

- CC uses the host's Claude subscription (Max, API key, etc.)
- Set `maxBudgetUsd` in spawn options to cap spend
- Default timeout: 600s (10 min) for one-shot, 30 min idle for persistent
- Per-repo concurrency: max 1 running + 1 queued
