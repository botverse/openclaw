# RFC: Claude Code Integration v2 — Session Discovery, Project Awareness & Intelligent Session Selection

**Author:** Alfonso de la Osa Enriquez
**Status:** Draft v1.1
**Date:** 2026-02-20
**Supersedes:** RFC v3 "Native Claude Code Agent Spawning for OpenClaw" (2026-02-13)

---

## Changelog (v3 → v2-RFC)

- **New: Session Discovery** — unified view of ALL CC sessions for a repo, regardless of origin
- **New: Project State Awareness** — pre-flight checks before spawning (git, PRs, CI, specs, active sessions)
- **New: Session Selection Model** — decision tree for resume vs fresh session, replacing naive registry lookup
- **New: Source Attribution** — proposal for marking sessions with origin via injected markers
- **New: MCP Bridge Enhancements** — `openclaw_project_status` and `openclaw_session_list` tools
- **New: Context Capacity Factor** — scoring considers token usage, compaction count, and budget consumption with hard ceilings
- **Preserved:** All architecture decisions from v3 (NDJSON streaming, CLI spawn, MCP bridge pattern, session registry, persistent sessions)

---

## Executive Summary

OpenClaw's CC integration (v3 RFC) solved the **mechanics** of spawning Claude Code: NDJSON streaming, session persistence, progress relay, MCP bridge. What it didn't solve is **awareness** — agents can't see project state, can't discover sessions from other sources, and can't intelligently decide whether to resume or start fresh.

This RFC addresses the gap between "CC works" and "CC works _well_". The core insight: **a human opening CC's session dropdown makes a multi-factor decision in ~2 seconds** (task similarity, branch match, recency, session health). Our agents have no equivalent capability. This RFC gives them one.

---

## Problem Statement

### What works today

| Capability                                   | Implementation                                 |
| -------------------------------------------- | ---------------------------------------------- |
| CC spawn with NDJSON streaming               | `runner.ts` → `spawnClaudeCode()`              |
| Session persistence per (agent, repo, label) | `sessions.ts` → `resolveSession()`             |
| Progress relay to chat                       | Periodic summaries + tool use events           |
| MCP bridge (4 tools)                         | Context, memory search, announce, session info |
| Persistent sessions with follow-ups          | `persistent: true`, 30-min idle timeout        |
| CLI management                               | `openclaw cc list/info/attach/kill/costs`      |

### What's missing

1. **No project awareness** — Agent doesn't know what happened in a repo between sessions (commits, branch state, uncommitted changes, open PRs, failing CI)
2. **No cross-source visibility** — Agent only sees its own registry. 153 JSONL session files exist across `~/.claude/projects/` but the agent sees only the ~9 it created
3. **No session discovery for CC** — A spawned CC session can't query "what other sessions exist for this repo?" via MCP
4. **Naive session selection** — `resolveSession()` just looks up the registry entry. No scoring based on task similarity, branch match, recency, or session health
5. **No source attribution** — `userType` is always `"external"` in CC's JSONL. No way to distinguish VSCode vs CLI vs OpenClaw sessions
6. **Coding agent skill is generic** — Doesn't teach agents to check project state before spawning

---

## Research Findings

### CC Native Session Storage Structure

**Location:** `~/.claude/projects/{slug}/` where `slug` = repo path with `/` → `-` (e.g., `-home-fonz-Projects-openclaw`)

**Observed:**

- 153 JSONL files across 5 project directories
- `-home-fonz-Botverse-KYO`: 81 sessions
- `-home-fonz-Projects-openclaw`: 36 sessions (21 main + 15 in subdirs)
- Files named by UUID: `{sessionId}.jsonl`
- Associated directories: `{sessionId}/subagents/`, `{sessionId}/tool-results/`

**JSONL Schema (per-message fields):**

| Field            | Type       | Always Present | Notes                                             |
| ---------------- | ---------- | -------------- | ------------------------------------------------- |
| `sessionId`      | UUID       | Yes            | Session identifier                                |
| `uuid`           | UUID       | Yes            | Message ID                                        |
| `parentUuid`     | UUID\|null | Yes            | Parent message (null for first)                   |
| `timestamp`      | ISO 8601   | Yes            | UTC timestamp                                     |
| `type`           | string     | Yes            | 44 distinct types observed                        |
| `userType`       | string     | Yes            | **Always `"external"`** — useless for attribution |
| `cwd`            | string     | Yes            | Working directory                                 |
| `version`        | string     | Yes            | CC version (e.g., `"2.1.41"`)                     |
| `gitBranch`      | string     | Yes            | Git branch at message time                        |
| `slug`           | string     | Most           | Human-readable ID (`adjective-noun-noun`)         |
| `isSidechain`    | boolean    | Yes            | `true` for subagent messages                      |
| `permissionMode` | string     | Some           | `"default"` or `"bypassPermissions"`              |
| `message.model`  | string     | Assistant only | Model used (e.g., `"claude-opus-4-6"`)            |
| `message.usage`  | object     | Assistant only | Token counts + cache metrics                      |
| `agentId`        | string     | Subagent only  | 7-char hex (e.g., `"aaf8236"`)                    |

**Message types (44 observed):** `user`, `assistant`, `tool_use`, `tool_result`, `progress`, `bash_progress`, `hook_progress`, `agent_progress`, `file-history-snapshot`, `queue-operation`, `thinking`, `system`, `text`, `direct`, `create`, `update`, and more.

**Key finding:** No `claude sessions list` CLI command exists. Session discovery requires filesystem scanning + JSONL parsing. CC's dropdown derives everything from raw JSONL: first user message as "title", file mtime as "last modified", `gitBranch` field for branch.

### Source Attribution Gap

**`userType` is always `"external"`** across all 12,116+ messages examined. No field distinguishes VSCode vs CLI vs OpenClaw. The only reliable OpenClaw detection is:

- `isSidechain: true` + `agentId` field → spawned subagent
- Directory presence of `/subagents/` → child session
- Content fingerprinting (fragile): OpenClaw injects `<previous_session_context>` tags on resume

**Conclusion:** We must inject our own marker to make sessions attributable.

### Current Architecture Gaps

1. **`resolveSession()` is naive** — just looks up registry key, no scoring
2. **`listAllSessions()` exists but is unexposed** — only used by `cc list --all` CLI, not available as MCP tool
3. **`peekSessionHistory()` only extracts text** — skips tool names, git branch changes, cost data
4. **MCP bridge config flags not implemented** — `exposeMemory` and `exposeConversation` flags exist in types but are ignored in the bridge script
5. **No project status gathering** — no git state, PR list, CI status, or spec discovery
6. **Coding agent skill** (285 lines) teaches PTY and parallel work but not session discovery or project assessment

---

## Proposed Architecture

### Overview

```
Agent receives task for repo R
         │
         ▼
  ┌─ Pre-flight: gatherProjectStatus(R) ─┐
  │  • git branch, log, diff, stash       │
  │  • active CC sessions on R            │
  │  • recent sessions from any source    │
  │  • specs/docs presence                │
  └────────────────────────────────────────┘
         │
         ▼
  ┌─ Session Selection: selectSession(task, projectStatus) ─┐
  │  • Score existing sessions by: branch match, recency,   │
  │    task similarity, session health, size                 │
  │  • Decision: resume(sessionId) | fresh | continue       │
  └─────────────────────────────────────────────────────────┘
         │
         ▼
  spawnClaudeCode({ resume?, task, repo })
         │
         ├─ MCP bridge now includes:
         │  • openclaw_project_status  (git + sessions + specs)
         │  • openclaw_session_list    (all sessions for repo)
         │  • openclaw_conversation_context  (existing)
         │  • openclaw_memory_search   (existing)
         │  • openclaw_announce        (existing)
         │  • openclaw_session_info    (existing)
         │
         ▼
  CC runs with full repo + project awareness
```

---

## Section 1: Session Discovery

### Goal

Any agent (or the spawned CC session itself) can see ALL CC sessions for a repository — not just the ones it created. This replicates the human's "session dropdown" capability.

### Design: `discoverSessions(repoPath)`

A new function in `sessions.ts` that merges two data sources:

1. **OpenClaw registries** — `~/.openclaw/agents/*/claude-code-sessions.json` (rich metadata: cost, turns, task history, agent ID)
2. **CC native storage** — `~/.claude/projects/{slug}/*.jsonl` (raw JSONL: first message, branch, mtime, size)

```typescript
// src/agents/claude-code/sessions.ts

interface DiscoveredSession {
  sessionId: string;
  source: "openclaw" | "native-only"; // Attribution
  agentId?: string; // Which OpenClaw agent (if source=openclaw)
  repoPath: string;
  branch: string; // From first JSONL message's gitBranch
  firstMessage: string; // First user message text (session "title")
  lastModified: Date; // File mtime
  messageCount: number; // wc -l of JSONL (approximate)
  fileSizeBytes: number; // Session file size
  totalCostUsd?: number; // From registry (openclaw only)
  totalTurns?: number; // From registry (openclaw only)
  lastTask?: string; // Most recent task (openclaw only)
  label?: string; // Session label (openclaw only)
  slug?: string; // CC's human-readable slug
  permissionMode?: string; // From JSONL metadata
  ccVersion?: string; // CC version from JSONL
  isRunning: boolean; // Check against liveSessions map
  originMarker?: string; // Extracted [openclaw:agent=X] marker if present
  // Context capacity fields (extracted from JSONL scan)
  totalInputTokens?: number; // Sum of message.usage.input_tokens across assistant messages
  totalOutputTokens?: number; // Sum of message.usage.output_tokens
  compactionCount: number; // Number of auto-compaction events detected in JSONL
  budgetUsedPct?: number; // totalCostUsd / maxBudgetUsd (if both known)
}

async function discoverSessions(repoPath: string): Promise<DiscoveredSession[]> {
  const results: DiscoveredSession[] = [];
  const seen = new Set<string>(); // Dedup by sessionId

  // 1. OpenClaw registries (rich metadata)
  const allRegistrySessions = listAllSessions();
  for (const entry of allRegistrySessions) {
    if (path.resolve(entry.repoPath) !== path.resolve(repoPath)) continue;
    seen.add(entry.sessionId);
    results.push({
      sessionId: entry.sessionId,
      source: "openclaw",
      agentId: entry.agentId,
      repoPath: entry.repoPath,
      branch: await extractBranchFromJsonl(repoPath, entry.sessionId),
      firstMessage: await extractFirstMessage(repoPath, entry.sessionId),
      lastModified: new Date(entry.lastResumedAt),
      messageCount: await countJsonlLines(repoPath, entry.sessionId),
      fileSizeBytes: await getSessionFileSize(repoPath, entry.sessionId),
      totalCostUsd: entry.totalCostUsd,
      totalTurns: entry.totalTurns,
      lastTask: entry.taskHistory?.at(-1)?.task,
      label: entry.label,
      slug: await extractSlugFromJsonl(repoPath, entry.sessionId),
      isRunning: isClaudeCodeRunning(repoPath),
    });
  }

  // 2. CC native storage (sessions not in any OpenClaw registry)
  const slug = repoPathToSlug(repoPath);
  const sessionDir = path.join(os.homedir(), ".claude", "projects", slug);
  if (fs.existsSync(sessionDir)) {
    const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const sessionId = path.basename(file, ".jsonl");
      if (seen.has(sessionId)) continue; // Already found in registry

      const filePath = path.join(sessionDir, file);
      const stat = fs.statSync(filePath);
      const header = await parseJsonlHeader(filePath); // First 5 lines

      results.push({
        sessionId,
        source: "native-only",
        repoPath,
        branch: header.gitBranch ?? "unknown",
        firstMessage: header.firstUserMessage ?? "(no message)",
        lastModified: stat.mtime,
        messageCount: header.lineCount,
        fileSizeBytes: stat.size,
        slug: header.slug,
        permissionMode: header.permissionMode,
        ccVersion: header.version,
        isRunning: false, // Not tracked by OpenClaw
        originMarker: header.originMarker, // Extract [openclaw:agent=X] if present
      });
    }
  }

  // Sort: running first, then by lastModified descending
  results.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    return b.lastModified.getTime() - a.lastModified.getTime();
  });

  return results;
}
```

### Helper: `parseJsonlHeader(filePath)`

Reads only the first 5 and last 5 lines of a JSONL file to extract metadata cheaply:

```typescript
interface JsonlHeader {
  gitBranch?: string;
  firstUserMessage?: string;
  slug?: string;
  version?: string;
  permissionMode?: string;
  lineCount: number;
  originMarker?: string; // Extracted from first user message
  // Context capacity metrics
  totalInputTokens: number; // Sum of all assistant message input tokens
  totalOutputTokens: number; // Sum of all assistant message output tokens
  compactionCount: number; // Number of auto-compaction system messages
}

async function parseJsonlHeader(filePath: string): Promise<JsonlHeader> {
  const result: JsonlHeader = {
    lineCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    compactionCount: 0,
  };

  // Read full file for token/compaction accounting
  // (For very large files >10MB, could switch to streaming readline)
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  result.lineCount = lines.length;

  for (let i = 0; i < lines.length; i++) {
    try {
      const msg = JSON.parse(lines[i]);

      // Metadata from first few lines
      if (i < 10) {
        if (!result.gitBranch && msg.gitBranch) result.gitBranch = msg.gitBranch;
        if (!result.slug && msg.slug) result.slug = msg.slug;
        if (!result.version && msg.version) result.version = msg.version;
        if (!result.permissionMode && msg.permissionMode)
          result.permissionMode = msg.permissionMode;
      }

      // Extract first user message as "title"
      if (!result.firstUserMessage && msg.type === "user" && msg.message?.content) {
        const text =
          typeof msg.message.content === "string"
            ? msg.message.content
            : msg.message.content.find((b: any) => b.type === "text")?.text;
        if (text) {
          result.firstUserMessage = text.slice(0, 200);
          const markerMatch = text.match(/\[openclaw:agent=([^\]]+)\]/);
          if (markerMatch) result.originMarker = markerMatch[1];
        }
      }

      // Accumulate token usage from assistant messages
      if (msg.message?.usage) {
        result.totalInputTokens += msg.message.usage.input_tokens ?? 0;
        result.totalOutputTokens += msg.message.usage.output_tokens ?? 0;
      }

      // Detect auto-compaction events
      // CC emits a system message with type "summary" or containing "conversation was compressed"
      if (msg.type === "system" && msg.message?.content) {
        const text =
          typeof msg.message.content === "string"
            ? msg.message.content
            : JSON.stringify(msg.message.content);
        if (text.includes("compress") || text.includes("compact") || text.includes("summary")) {
          result.compactionCount++;
        }
      }
    } catch {
      /* skip non-JSON lines */
    }
  }

  return result;
}
```

### Helper: `repoPathToSlug(repoPath)`

```typescript
function repoPathToSlug(repoPath: string): string {
  // CC uses full path with / replaced by -
  // /home/fonz/Projects/openclaw → -home-fonz-Projects-openclaw
  return repoPath.replace(/\//g, "-");
}
```

**Note:** The existing `resolveSession()` in `sessions.ts` already has a `findCcSessionFile()` helper that tries two slug patterns (basename and full path). The `repoPathToSlug()` here follows the observed pattern from `~/.claude/projects/` directory names.

### Files to change

| File                                 | Change                                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| `src/agents/claude-code/sessions.ts` | Add `discoverSessions()`, `parseJsonlHeader()`, `repoPathToSlug()` |
| `src/agents/claude-code/index.ts`    | Export `discoverSessions`                                          |
| `src/cli/cc-cli.ts`                  | Update `cc list` to use `discoverSessions()` for richer output     |

---

## Section 2: Project State Awareness

### Goal

Before spawning CC (or as an MCP tool during a CC session), gather a structured "project briefing" that answers: what happened in this repo since I last looked?

### Design: `gatherProjectStatus(repoPath)`

```typescript
// src/agents/claude-code/project-status.ts (new file)

interface ProjectStatus {
  repo: {
    path: string;
    name: string; // basename
    isGitRepo: boolean;
  };
  git: {
    currentBranch: string;
    headCommitSha: string;
    headCommitMessage: string;
    uncommittedChanges: string[]; // Short status lines
    stagedChanges: string[];
    stashCount: number;
    recentCommits: GitCommit[]; // Last 10
    untrackedFiles: string[];
  };
  github?: {
    // Only if `gh` CLI available
    openPrs: GithubPr[]; // PRs for current branch + any assigned
    recentPrActivity: GithubPr[]; // PRs merged/updated in last 24h
    failingChecks: GithubCheck[]; // CI failures on current branch
  };
  sessions: {
    active: DiscoveredSession[]; // Currently running CC sessions
    recent: DiscoveredSession[]; // Last 5 sessions (any source)
    ownRecent: DiscoveredSession[]; // Last 3 from requesting agent
  };
  docs: {
    hasClaudeMd: boolean;
    hasSpecs: boolean; // .specs/ directory exists
    specFiles: string[]; // List of .specs/*.md
    hasTodo: boolean; // TODO.md exists
    hasReadme: boolean;
  };
  timestamp: string; // When this status was gathered
}

interface GitCommit {
  sha: string; // Short hash
  message: string; // First line
  author: string;
  date: string; // Relative (e.g., "2 hours ago")
}

interface GithubPr {
  number: number;
  title: string;
  branch: string;
  state: string; // "open", "merged", "closed"
  author: string;
  updatedAt: string;
}

interface GithubCheck {
  name: string;
  status: string; // "failure", "success", "pending"
  conclusion: string;
}
```

### Implementation

```typescript
async function gatherProjectStatus(repoPath: string, agentId?: string): Promise<ProjectStatus> {
  const resolved = path.resolve(repoPath);
  const isGitRepo = fs.existsSync(path.join(resolved, ".git"));

  // Parallel execution — all git commands are independent
  const [branch, headInfo, statusShort, stashList, recentLog, ghPrs, ghChecks, sessions] =
    await Promise.allSettled([
      exec("git branch --show-current", { cwd: resolved }),
      exec("git log -1 --format='%h %s'", { cwd: resolved }),
      exec("git status --short", { cwd: resolved }),
      exec("git stash list", { cwd: resolved }),
      exec("git log --oneline -10 --format='%h|%s|%an|%ar'", { cwd: resolved }),
      exec("gh pr list --json number,title,headRefName,state,author,updatedAt --limit 5", {
        cwd: resolved,
      }),
      exec("gh pr checks --json name,state,conclusion 2>/dev/null", { cwd: resolved }),
      discoverSessions(resolved),
    ]);

  // Parse git output...
  const statusLines = parseSettled(statusShort, "").split("\n").filter(Boolean);
  const staged = statusLines.filter((l) => /^[MADRC]/.test(l));
  const unstaged = statusLines.filter((l) => /^.[MADRC?]/.test(l));
  const untracked = statusLines.filter((l) => l.startsWith("??"));

  const commits = parseSettled(recentLog, "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, message, author, date] = line.split("|");
      return { sha, message, author, date };
    });

  // Parse sessions
  const allSessions = parseSettled(sessions, [] as DiscoveredSession[]);
  const active = allSessions.filter((s) => s.isRunning);
  const recent = allSessions.slice(0, 5);
  const ownRecent = agentId ? allSessions.filter((s) => s.agentId === agentId).slice(0, 3) : [];

  // Check docs
  const hasClaudeMd = fs.existsSync(path.join(resolved, "CLAUDE.md"));
  const specsDir = path.join(resolved, ".specs");
  const hasSpecs = fs.existsSync(specsDir);
  const specFiles = hasSpecs ? fs.readdirSync(specsDir).filter((f) => f.endsWith(".md")) : [];

  return {
    repo: { path: resolved, name: path.basename(resolved), isGitRepo },
    git: {
      currentBranch: parseSettled(branch, "unknown").trim(),
      headCommitSha: commits[0]?.sha ?? "",
      headCommitMessage: commits[0]?.message ?? "",
      uncommittedChanges: unstaged.map((l) => l.trim()),
      stagedChanges: staged.map((l) => l.trim()),
      stashCount: parseSettled(stashList, "").split("\n").filter(Boolean).length,
      recentCommits: commits,
      untrackedFiles: untracked.map((l) => l.replace("?? ", "").trim()),
    },
    github: parseGithubData(ghPrs, ghChecks),
    sessions: { active, recent, ownRecent },
    docs: {
      hasClaudeMd,
      hasSpecs,
      specFiles,
      hasTodo: fs.existsSync(path.join(resolved, "TODO.md")),
      hasReadme: fs.existsSync(path.join(resolved, "README.md")),
    },
    timestamp: new Date().toISOString(),
  };
}
```

### Token Budget

Project status should be cheap to generate and consume:

| Component                         | Estimated tokens | Notes                        |
| --------------------------------- | ---------------- | ---------------------------- |
| Git state (branch, status, stash) | ~100             | Fixed overhead               |
| Recent commits (10)               | ~300             | One line each                |
| GitHub PRs (5)                    | ~200             | Title + branch + state       |
| Session list (5 recent)           | ~400             | ID + branch + task + recency |
| Docs presence                     | ~50              | Boolean flags                |
| **Total**                         | **~1,050**       | Well within budget           |

### Files to create/change

| File                                       | Change                                         |
| ------------------------------------------ | ---------------------------------------------- |
| `src/agents/claude-code/project-status.ts` | **New file** — `gatherProjectStatus()` + types |
| `src/agents/claude-code/index.ts`          | Export `gatherProjectStatus`                   |

---

## Section 3: Session Selection Model

### Goal

Replace the naive `resolveSession()` (which just does a registry lookup) with an intelligent selection function that considers semantic task relevance, branch match, recency, session health, and context capacity.

### Decision Tree

```
selectSession(task, projectStatus, agentId, repoPath, label?)
  │
  ├── Label provided? ──yes──→ resolveSession(agentId, repo, label)
  │                              └── Found? → RESUME(sessionId)
  │                              └── Not found? → FRESH(label)
  │
  ├── Active session on this repo? ──yes──→ QUEUE (existing behavior)
  │
  ├── Discover all sessions for repo
  │   └── Filter to own sessions (same agentId)
  │   └── Score each session
  │
  ├── Best score > RESUME_THRESHOLD (0.6)?
  │   └── yes → RESUME(bestSession.sessionId)
  │   └── no  → FRESH
  │
  └── Return { action, sessionId?, reason }
```

### Task Relevance: LLM-Based Semantic Matching

Keyword overlap (Jaccard similarity) fails at semantic understanding. "Refactor webhook handler" vs "Clean up HTTP endpoint logic" shares zero keywords despite being the same task. "Add OAuth flow" vs "implement authentication" — same problem. Task similarity is a conceptual judgment, not a string comparison.

**Solution:** A single fast LLM call (Haiku/Flash) scores task relevance for all candidate sessions in one batch. Cost: ~$0.001, latency: ~300ms. This replaces the old keyword-based `taskSimilarity` factor with a proper semantic signal.

#### Configuration

The relevance model is configurable per-deployment. Different users may prefer different cost/quality tradeoffs, or may want to use a locally-hosted model.

```typescript
// In agents.defaults.subagents.claudeCode config (openclaw.json)
interface ClaudeCodeConfig {
  // ... existing fields ...

  sessionSelection?: {
    relevanceModel?: string; // Model for task relevance scoring
    // Default: "claude-haiku" (fast, ~$0.001/call)
    // Examples: "gemini-flash", "gpt-4o-mini", "ollama/llama3"
    relevanceMaxTokens?: number; // Max response tokens. Default: 500
    relevanceTimeoutMs?: number; // Timeout for relevance call. Default: 3000
    // On timeout, falls back to keyword matching
    resumeThreshold?: number; // Score threshold for resume vs fresh. Default: 0.6
    enabled?: boolean; // Enable/disable LLM-based relevance entirely. Default: true
    // When false, uses keyword Jaccard as in v1.0
  };
}
```

**Example in `openclaw.json`:**

```json
{
  "agents": {
    "defaults": {
      "subagents": {
        "claudeCode": {
          "enabled": true,
          "maxBudgetUsd": 10,
          "sessionSelection": {
            "relevanceModel": "claude-haiku",
            "relevanceTimeoutMs": 3000,
            "resumeThreshold": 0.6
          }
        }
      }
    }
  }
}
```

Per-agent overrides are supported — an agent that spawns many small tasks might prefer a cheaper/faster model, while one doing complex multi-session work might want a stronger model:

```json
{
  "agents": {
    "tools": {
      "subagents": {
        "claudeCode": {
          "sessionSelection": {
            "relevanceModel": "gemini-flash",
            "relevanceTimeoutMs": 2000
          }
        }
      }
    }
  }
}
```

#### Relevance Prompt

The LLM receives the new task and a numbered list of session descriptions (first message + last task), and returns a relevance score (0.0–1.0) for each:

```typescript
interface TaskRelevanceResult {
  sessionId: string;
  relevance: number; // 0.0 = unrelated, 0.5 = tangentially related, 1.0 = same work
  reasoning: string; // One-line explanation
}

interface SessionSelectionConfig {
  relevanceModel: string; // Default: "claude-haiku"
  relevanceMaxTokens: number; // Default: 500
  relevanceTimeoutMs: number; // Default: 3000
  resumeThreshold: number; // Default: 0.6
  enabled: boolean; // Default: true
}

const DEFAULT_SESSION_SELECTION_CONFIG: SessionSelectionConfig = {
  relevanceModel: "claude-haiku",
  relevanceMaxTokens: 500,
  relevanceTimeoutMs: 3000,
  resumeThreshold: 0.6,
  enabled: true,
};

async function assessTaskRelevance(
  task: string,
  sessions: DiscoveredSession[],
  config: SessionSelectionConfig = DEFAULT_SESSION_SELECTION_CONFIG,
): Promise<TaskRelevanceResult[]> {
  if (sessions.length === 0) return [];

  // If LLM relevance is disabled, fall back to keyword matching
  if (!config.enabled) {
    return sessions.map((s) => keywordFallback(task, s));
  }

  const sessionDescriptions = sessions
    .map((s, i) => {
      const desc = s.lastTask ?? s.firstMessage ?? "(no description)";
      const branch = s.branch ?? "unknown";
      return `${i + 1}. [branch: ${branch}] ${desc}`;
    })
    .join("\n");

  const prompt = `You are scoring task relevance for session selection.

NEW TASK: ${task}

EXISTING SESSIONS:
${sessionDescriptions}

For each session, rate how relevant its previous work is to the new task.
Consider: same feature area? same files likely touched? shared context valuable?
A session about "refactor webhook handler" IS relevant to "fix webhook error handling".
A session about "add OAuth" is NOT relevant to "update README formatting".

Return JSON array: [{"index": 1, "relevance": 0.0-1.0, "reasoning": "one line"}]
Relevance scale: 0.0 = unrelated, 0.3 = tangentially related, 0.6 = related work, 0.9 = same feature/task, 1.0 = exact continuation.`;

  const response = await callLLM({
    model: config.relevanceModel,
    messages: [{ role: "user", content: prompt }],
    maxTokens: config.relevanceMaxTokens,
    temperature: 0,
    timeoutMs: config.relevanceTimeoutMs,
  });

  // Parse response, map back to sessionIds
  const scores = JSON.parse(extractJson(response));
  return scores.map((s: any) => ({
    sessionId: sessions[s.index - 1].sessionId,
    relevance: Math.min(Math.max(s.relevance, 0), 1), // Clamp 0-1
    reasoning: s.reasoning,
  }));
}

// Fallback: keyword Jaccard when LLM is disabled or fails
function keywordFallback(task: string, session: DiscoveredSession): TaskRelevanceResult {
  const taskWords = new Set(
    task
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3),
  );
  const sessionWords = new Set(
    (session.lastTask ?? session.firstMessage ?? "")
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3),
  );
  const intersection = [...taskWords].filter((w) => sessionWords.has(w));
  const union = new Set([...taskWords, ...sessionWords]);
  const jaccard = union.size > 0 ? intersection.length / union.size : 0;
  return {
    sessionId: session.sessionId,
    relevance: Math.min(jaccard * 2, 1), // Scale up: 0.5 Jaccard → 1.0 relevance
    reasoning: `keyword overlap: ${intersection.length}/${union.size} words`,
  };
}
```

**Why batch?** One LLM call for all candidates is cheaper and faster than one per session. With typically 3-5 candidate sessions, the prompt stays under 500 tokens input.

**Fallback chain:** If the LLM call times out or errors → fall back to keyword Jaccard (degraded but functional). If `enabled: false` → always use keyword Jaccard. Never block the spawn flow on a failed relevance check.

#### Relevance Gate

When the LLM scores a session's relevance below 0.1 (unrelated), that session gets a **-0.15 penalty** applied after normal scoring — actively pushing it below the resume threshold. This is the "task relevance gate": even a perfect branch/recency/health match can't overcome an unrelated task.

Additionally, if relevance is below 0.1 AND the session has more than 200 messages, it hits a **soft ceiling** — force fresh. A large session full of unrelated work is pure deadweight that will pollute the new task's context.

### Scoring Function

```typescript
interface SessionScore {
  sessionId: string;
  score: number; // 0.0 - 1.0
  factors: ScoreFactors;
  recommendation: "resume" | "fresh";
  reason: string; // Human-readable explanation
}

interface ScoreFactors {
  branchMatch: number; // 0.0 or 0.25
  recency: number; // 0.0 - 0.20
  taskRelevance: number; // -0.15 - 0.25 (LLM-scored semantic similarity, can go negative as gate)
  sessionHealth: number; // 0.0 - 0.15 (size, error history)
  contextCapacity: number; // 0.0 - 0.15 (token usage, compaction, budget)
}

const RESUME_THRESHOLD = 0.6;

// Hard ceilings — force fresh regardless of score
const HARD_CEILING_COMPACTIONS = 3; // 3+ compactions = context too degraded
const HARD_CEILING_BUDGET_PCT = 0.7; // 70%+ of budget consumed

function scoreSession(
  session: DiscoveredSession,
  task: string,
  currentBranch: string,
  relevance: TaskRelevanceResult, // Pre-computed by assessTaskRelevance()
  maxBudgetUsd?: number,
): SessionScore {
  // --- Hard ceilings: force fresh regardless of other factors ---
  if (session.compactionCount >= HARD_CEILING_COMPACTIONS) {
    return {
      sessionId: session.sessionId,
      score: 0,
      factors: {
        branchMatch: 0,
        recency: 0,
        taskRelevance: 0,
        sessionHealth: 0,
        contextCapacity: 0,
      },
      recommendation: "fresh",
      reason: `Force fresh — session compacted ${session.compactionCount} times (context too degraded)`,
    };
  }

  if (session.budgetUsedPct && session.budgetUsedPct >= HARD_CEILING_BUDGET_PCT) {
    return {
      sessionId: session.sessionId,
      score: 0,
      factors: {
        branchMatch: 0,
        recency: 0,
        taskRelevance: 0,
        sessionHealth: 0,
        contextCapacity: 0,
      },
      recommendation: "fresh",
      reason: `Force fresh — session used ${(session.budgetUsedPct * 100).toFixed(0)}% of budget`,
    };
  }

  // Soft ceiling: unrelated task + large session = force fresh
  if (relevance.relevance < 0.1 && session.messageCount > 200) {
    return {
      sessionId: session.sessionId,
      score: 0,
      factors: {
        branchMatch: 0,
        recency: 0,
        taskRelevance: 0,
        sessionHealth: 0,
        contextCapacity: 0,
      },
      recommendation: "fresh",
      reason: `Force fresh — unrelated task (${relevance.reasoning}) + large session (${session.messageCount} messages)`,
    };
  }

  const factors: ScoreFactors = {
    branchMatch: 0,
    recency: 0,
    taskRelevance: 0,
    sessionHealth: 0,
    contextCapacity: 0,
  };

  // 1. Branch match (0.25) — strongest signal
  if (session.branch === currentBranch) {
    factors.branchMatch = 0.25;
  }

  // 2. Recency (0.0 - 0.20) — exponential decay
  const ageHours = (Date.now() - session.lastModified.getTime()) / (1000 * 60 * 60);
  if (ageHours < 1) factors.recency = 0.2;
  else if (ageHours < 6) factors.recency = 0.16;
  else if (ageHours < 24) factors.recency = 0.12;
  else if (ageHours < 72) factors.recency = 0.08;
  else if (ageHours < 168) factors.recency = 0.04;
  else factors.recency = 0.0; // >1 week: stale

  // 3. Task relevance (−0.15 - 0.25) — LLM-scored semantic similarity
  //    This is the key differentiator from v1: proper semantic matching instead of keyword Jaccard.
  //    Sub-0.1 relevance applies a NEGATIVE score (relevance gate), actively suppressing resume.
  if (relevance.relevance >= 0.6) {
    factors.taskRelevance = 0.25; // Strongly related
  } else if (relevance.relevance >= 0.3) {
    factors.taskRelevance = 0.1 + (relevance.relevance - 0.3) * 0.5; // 0.10–0.25 linear
  } else if (relevance.relevance >= 0.1) {
    factors.taskRelevance = 0.0; // Tangentially related — neutral
  } else {
    factors.taskRelevance = -0.15; // Unrelated — active penalty (gate)
  }

  // 4. Session health (0.0 - 0.15) — penalize huge/old sessions
  let health = 0.15;
  if (session.messageCount > 500) health -= 0.07; // Very large session
  if (session.fileSizeBytes > 5_000_000) health -= 0.04; // >5MB JSONL
  if (ageHours > 168) health -= 0.04; // >1 week old
  factors.sessionHealth = Math.max(health, 0);

  // 5. Context capacity (0.0 - 0.15) — token usage, compaction, budget headroom
  let capacity = 0.15;

  // Compaction penalty: each compaction degrades context quality
  if (session.compactionCount === 1) capacity -= 0.04;
  else if (session.compactionCount === 2) capacity -= 0.09;

  // Budget consumption penalty
  if (session.budgetUsedPct) {
    if (session.budgetUsedPct > 0.5) capacity -= 0.04;
    else if (session.budgetUsedPct > 0.3) capacity -= 0.02;
  }

  // Token density penalty
  const totalTokens = (session.totalInputTokens ?? 0) + (session.totalOutputTokens ?? 0);
  const tokensPerMessage = session.messageCount > 0 ? totalTokens / session.messageCount : 0;
  if (tokensPerMessage > 4000) capacity -= 0.03;

  factors.contextCapacity = Math.max(capacity, 0);

  const score = Math.max(
    0,
    factors.branchMatch +
      factors.recency +
      factors.taskRelevance +
      factors.sessionHealth +
      factors.contextCapacity,
  );

  return {
    sessionId: session.sessionId,
    score,
    factors,
    recommendation: score >= RESUME_THRESHOLD ? "resume" : "fresh",
    reason: buildReason(factors, score, session, relevance),
  };
}

function buildReason(
  factors: ScoreFactors,
  score: number,
  session: DiscoveredSession,
  relevance: TaskRelevanceResult,
): string {
  const parts: string[] = [];
  if (factors.branchMatch > 0) parts.push("same branch");
  if (factors.recency >= 0.16) parts.push("recent");
  else if (factors.recency === 0) parts.push("stale (>1 week)");
  if (factors.taskRelevance >= 0.15) parts.push(`related: ${relevance.reasoning}`);
  else if (factors.taskRelevance < 0) parts.push(`unrelated: ${relevance.reasoning}`);
  if (factors.sessionHealth < 0.08) parts.push("large/unhealthy session");
  if (factors.contextCapacity < 0.08) parts.push("low context capacity");
  if (session.compactionCount > 0) parts.push(`${session.compactionCount}× compacted`);
  if (session.budgetUsedPct && session.budgetUsedPct > 0.3) {
    parts.push(`${(session.budgetUsedPct * 100).toFixed(0)}% budget used`);
  }

  const action = score >= RESUME_THRESHOLD ? "Resume" : "Start fresh";
  return `${action} (score: ${score.toFixed(2)}) — ${parts.join(", ")}`;
}
```

### Integration with `resolveSession()`

The existing `resolveSession()` remains for backward compatibility. A new `selectSession()` wraps it with scoring:

```typescript
interface SessionSelection {
  action: "resume" | "fresh" | "continue" | "queue";
  sessionId?: string;
  reason: string;
  scores?: SessionScore[]; // All scored sessions (for debugging/logging)
}

async function selectSession(
  task: string,
  repoPath: string,
  agentId: string,
  projectStatus: ProjectStatus,
  label?: string,
  maxBudgetUsd?: number,
  selectionConfig: SessionSelectionConfig = DEFAULT_SESSION_SELECTION_CONFIG,
): Promise<SessionSelection> {
  // Labeled sessions: direct lookup
  if (label) {
    const existing = resolveSession(agentId, repoPath, label);
    if (existing)
      return { action: "resume", sessionId: existing, reason: `Labeled session "${label}"` };
    return { action: "fresh", reason: `New labeled session "${label}"` };
  }

  // Active session: queue
  if (projectStatus.sessions.active.length > 0) {
    return { action: "queue", reason: "Active session running on this repo" };
  }

  // Score all own sessions
  const ownSessions = projectStatus.sessions.recent.filter((s) => s.agentId === agentId);
  if (ownSessions.length === 0) {
    return { action: "fresh", reason: "No previous sessions found" };
  }

  // LLM-based semantic relevance — one call for all candidates
  // Model and timeout are configurable via sessionSelection config
  let relevanceResults: TaskRelevanceResult[];
  try {
    relevanceResults = await assessTaskRelevance(task, ownSessions, selectionConfig);
  } catch (err) {
    // Fallback: keyword Jaccard if LLM call fails entirely
    log.warn("Task relevance LLM call failed, falling back to keyword matching", {
      error: err,
      model: selectionConfig.relevanceModel,
    });
    relevanceResults = ownSessions.map((s) => keywordFallback(task, s));
  }

  const relevanceMap = new Map(relevanceResults.map((r) => [r.sessionId, r]));

  const scores = ownSessions.map((s) =>
    scoreSession(
      s,
      task,
      projectStatus.git.currentBranch,
      relevanceMap.get(s.sessionId) ?? {
        sessionId: s.sessionId,
        relevance: 0.5,
        reasoning: "unknown",
      },
      maxBudgetUsd,
    ),
  );
  scores.sort((a, b) => b.score - a.score);

  const best = scores[0];
  if (best.score >= selectionConfig.resumeThreshold) {
    return {
      action: "resume",
      sessionId: best.sessionId,
      reason: best.reason,
      scores,
    };
  }

  return { action: "fresh", reason: best.reason, scores };
}
```

### Files to create/change

| File                                          | Change                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/claude-code/session-selection.ts` | **New file** — `assessTaskRelevance()`, `keywordFallback()`, `scoreSession()`, `selectSession()`, `SessionSelectionConfig`, types |
| `src/agents/claude-code/runner.ts`            | Replace direct `resolveSession()` call with `selectSession()` in `spawnClaudeCode()`; read `sessionSelection` config              |
| `src/agents/claude-code/types.ts`             | Add `sessionSelection` to `ClaudeCodeConfig` type                                                                                 |
| `src/agents/claude-code/index.ts`             | Export `selectSession`                                                                                                            |

---

## Section 4: Source Attribution

### Problem

CC's `userType` field is always `"external"` — no way to distinguish who created a session. This matters because:

- Agent needs to know if a session was its own work or someone else's
- Users want to see "this was done by the kyo agent" vs "I did this in VSCode"
- Cross-agent coordination requires knowing session ownership

### Proposal: Inject Origin Marker in First Message

When OpenClaw spawns a CC session, prepend a machine-readable marker to the first user message:

```typescript
function buildTaskContent(task: string, options: ClaudeCodeSpawnOptions): string {
  const marker = `[openclaw:agent=${options.agentId ?? "unknown"}]`;
  return `${marker}\n\n${task}`;
}
```

**Example first message in JSONL:**

```
[openclaw:agent=main]

Refactor the WHOOP webhook handler to use v2 format. Update tests.
```

### Marker Format

```
[openclaw:agent=<agentId>]
```

- Square brackets for easy regex extraction: `/\[openclaw:agent=([^\]]+)\]/`
- Placed on first line of first user message
- Does NOT affect CC's behavior (it's just text in the prompt)
- Detectable by `parseJsonlHeader()` during session discovery

### Extended Markers (Future)

Could extend to carry more attribution data:

```
[openclaw:agent=main,channel=telegram,user=fonz,task_id=abc123]
```

But keep it minimal for now — just `agent=<id>` is sufficient for session discovery.

### Why Not a Separate Metadata File?

Alternatives considered:

1. **Sidecar file** (`{sessionId}.meta.json`) — CC would ignore it, but adds filesystem clutter
2. **Registry-only attribution** — already works for OpenClaw sessions, but doesn't help when scanning native JSONL
3. **First message marker** — zero-cost, survives CC compaction (first message is always preserved), detectable by any JSONL scanner

The first message marker is the simplest approach that works across all discovery paths.

### Files to change

| File                                 | Change                                                               |
| ------------------------------------ | -------------------------------------------------------------------- |
| `src/agents/claude-code/runner.ts`   | Modify task content assembly to prepend marker                       |
| `src/agents/claude-code/sessions.ts` | `parseJsonlHeader()` extracts `originMarker` from first user message |

---

## Section 5: MCP Bridge Enhancements

### Goal

Give spawned CC sessions the ability to query project state and session history on demand, without shelling out to `git` or scanning filesystems.

### New Tool: `openclaw_project_status`

**Purpose:** CC calls this to understand the current state of the repo it's working in.

**Schema:**

```json
{
  "name": "openclaw_project_status",
  "description": "Returns the current project status including git state, recent commits, open PRs, active sessions, and available documentation. Call this before starting work to understand what's changed.",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Returns:**

```json
{
  "repo": "openclaw",
  "branch": "feat/session-discovery",
  "headCommit": "abc1234 — Add session scoring function",
  "uncommittedChanges": [
    "M src/agents/claude-code/sessions.ts",
    "?? src/agents/claude-code/project-status.ts"
  ],
  "stagedChanges": [],
  "stashCount": 0,
  "recentCommits": [
    {
      "sha": "abc1234",
      "message": "Add session scoring function",
      "author": "fonz",
      "date": "2 hours ago"
    },
    {
      "sha": "def5678",
      "message": "Implement session discovery",
      "author": "fonz",
      "date": "5 hours ago"
    }
  ],
  "activeSessions": [],
  "recentSessions": [
    {
      "sessionId": "abc-123",
      "agent": "main",
      "branch": "feat/session-discovery",
      "lastTask": "Implement session scoring",
      "age": "2h ago"
    }
  ],
  "docs": { "claudeMd": true, "specs": ["auth-flow.md", "session-model.md"], "todo": false },
  "openPrs": [
    {
      "number": 42,
      "title": "Add session discovery",
      "branch": "feat/session-discovery",
      "status": "open"
    }
  ]
}
```

**Implementation in bridge script:**

```javascript
// Inside the generated bridge script (mcp-bridge.ts template)
case "openclaw_project_status": {
  const { execSync } = require("child_process");
  const fs = require("fs");
  const repoPath = CONFIG.repoPath;

  const run = (cmd) => {
    try { return execSync(cmd, { cwd: repoPath, timeout: 5000 }).toString().trim(); }
    catch { return ""; }
  };

  const branch = run("git branch --show-current");
  const headCommit = run("git log -1 --format='%h — %s'");
  const status = run("git status --short").split("\n").filter(Boolean);
  const stashCount = run("git stash list").split("\n").filter(Boolean).length;
  const recentCommits = run("git log --oneline -10 --format='%h|%s|%an|%ar'")
    .split("\n").filter(Boolean)
    .map(l => { const [sha, message, author, date] = l.split("|"); return { sha, message, author, date }; });

  // Check docs
  const docs = {
    claudeMd: fs.existsSync(`${repoPath}/CLAUDE.md`),
    specs: fs.existsSync(`${repoPath}/.specs`)
      ? fs.readdirSync(`${repoPath}/.specs`).filter(f => f.endsWith(".md"))
      : [],
    todo: fs.existsSync(`${repoPath}/TODO.md`),
  };

  // Open PRs (if gh available)
  let openPrs = [];
  try {
    const prJson = run("gh pr list --json number,title,headRefName,state --limit 5");
    if (prJson) openPrs = JSON.parse(prJson);
  } catch {}

  // Session info from registry (baked into CONFIG at bridge creation time)
  const sessions = CONFIG.recentSessions || [];

  return JSON.stringify({
    repo: require("path").basename(repoPath),
    branch,
    headCommit,
    uncommittedChanges: status.filter(l => /^.[MADRC?]/.test(l)),
    stagedChanges: status.filter(l => /^[MADRC]/.test(l)),
    stashCount,
    recentCommits,
    activeSessions: CONFIG.activeSessions || [],
    recentSessions: sessions,
    docs,
    openPrs,
  });
}
```

### New Tool: `openclaw_session_list`

**Purpose:** CC calls this to see all CC sessions for the current repo — its own and others'.

**Schema:**

```json
{
  "name": "openclaw_session_list",
  "description": "Lists all Claude Code sessions for this repository, from any source (this agent, other agents, VSCode, CLI). Use to understand prior work and decide whether to build on existing context.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "include_native": {
        "type": "boolean",
        "description": "Include sessions not spawned by OpenClaw (VSCode, CLI). Default: true"
      }
    },
    "required": []
  }
}
```

**Returns:**

```json
{
  "sessions": [
    {
      "sessionId": "abc-123",
      "source": "openclaw",
      "agent": "main",
      "branch": "feat/session-discovery",
      "firstMessage": "Implement session scoring function for CC integration",
      "lastModified": "2026-02-20T14:30:00Z",
      "messageCount": 45,
      "cost": 1.23,
      "turns": 8,
      "lastTask": "Implement session scoring",
      "isRunning": false
    },
    {
      "sessionId": "def-456",
      "source": "native-only",
      "branch": "main",
      "firstMessage": "Help me debug the webhook handler",
      "lastModified": "2026-02-19T10:00:00Z",
      "messageCount": 120,
      "isRunning": false
    }
  ],
  "total": 2,
  "activeCount": 0
}
```

**Implementation note:** The bridge script needs access to session data. Since the bridge is generated per-spawn, we bake the session list into `CONFIG` at creation time. For session data that changes during the session (like new sessions being created), the bridge can re-scan the registry and filesystem.

However, to keep the bridge lightweight, the heavy lifting (`discoverSessions()`) runs in the OpenClaw runner process and injects results into the bridge config. The bridge tool returns the pre-computed list plus a fresh filesystem check for running sessions.

### Bridge Config Changes

```typescript
// In startMcpBridge() — mcp-bridge.ts
interface McpBridgeConfig {
  // Existing
  task: string;
  agentId: string;
  repoPath: string;
  maxBudgetUsd: number;
  workspaceDir: string;

  // New
  recentSessions: DiscoveredSession[]; // Pre-computed at bridge start
  activeSessions: { sessionId: string; repoPath: string }[];
  projectStatusEnabled: boolean; // Config flag
  sessionListEnabled: boolean; // Config flag
}
```

### Updated Tool Registration

The bridge script's `tools/list` handler adds the two new tools:

```javascript
const tools = [
  // Existing 4 tools
  { name: "openclaw_conversation_context" /* ... */ },
  { name: "openclaw_memory_search" /* ... */ },
  { name: "openclaw_announce" /* ... */ },
  { name: "openclaw_session_info" /* ... */ },
  // New tools
  { name: "openclaw_project_status" /* ... */ },
  { name: "openclaw_session_list" /* ... */ },
];
```

### Files to change

| File                                   | Change                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/claude-code/mcp-bridge.ts` | Add `openclaw_project_status` and `openclaw_session_list` tool handlers to bridge script template; update `McpBridgeConfig` to include session data |
| `src/agents/claude-code/runner.ts`     | Pass `discoverSessions()` results to `startMcpBridge()`                                                                                             |
| `src/agents/claude-code/types.ts`      | Add config flags for new tools                                                                                                                      |

---

## Section 6: Enhanced Coding Agent Skill

### Goal

Update the coding-agent skill to teach agents project assessment before spawning CC.

### Pre-Flight Checklist

Add to `skills/coding-agent/SKILL.md`:

```markdown
## Pre-Flight Assessment

Before spawning a Claude Code session, always assess the project state:

### 1. Check Git State

- What branch am I on? Is it the right branch for this task?
- Are there uncommitted changes? Someone might be mid-work.
- Are there stashed changes that might be relevant?

### 2. Check Existing Sessions

- Is a CC session already running on this repo? (Queue if so)
- Do I have a recent session on the same branch + similar task? (Resume it)
- Did another agent recently work on this repo? (Check their results first)

### 3. Check Project Context

- Does CLAUDE.md exist? (CC will load it automatically)
- Are there .specs/ files relevant to my task?
- What do the last 5 commits say? (Am I duplicating recent work?)

### 4. Decide: Resume or Fresh

- **Resume** when: same branch, similar task, session < 6 hours old, < 200 messages
- **Fresh** when: different branch, unrelated task, session > 24h old or > 500 messages
- **Continue** when: exact same task, just adding follow-up instructions

### Session Management

- Use `label` parameter for parallel workstreams: `label: "refactor"` vs `label: "bugfix"`
- Check `openclaw cc list` output before spawning
- After CC finishes, verify with `git log` that commits landed correctly
```

### Files to change

| File                           | Change                            |
| ------------------------------ | --------------------------------- |
| `skills/coding-agent/SKILL.md` | Add pre-flight assessment section |

---

## Section 7: Implementation Phases

### Phase 1: Session Discovery + Project Status (Core)

**Scope:** New files + modifications to expose session discovery and project status.

**Files:**

1. `src/agents/claude-code/project-status.ts` — **New** — `gatherProjectStatus()`
2. `src/agents/claude-code/session-selection.ts` — **New** — `scoreSession()`, `selectSession()`
3. `src/agents/claude-code/sessions.ts` — **Modified** — Add `discoverSessions()`, `parseJsonlHeader()`, `repoPathToSlug()`
4. `src/agents/claude-code/index.ts` — **Modified** — Export new functions
5. `src/cli/cc-cli.ts` — **Modified** — `cc list` uses `discoverSessions()` for richer output; add `cc status <repo>` command

**Estimated effort:** 2-3 CC sessions

### Phase 2: Source Attribution

**Scope:** Marker injection + extraction.

**Files:**

1. `src/agents/claude-code/runner.ts` — **Modified** — Prepend `[openclaw:agent=X]` to first message
2. `src/agents/claude-code/sessions.ts` — **Modified** — `parseJsonlHeader()` extracts marker

**Estimated effort:** 1 CC session (small change)

### Phase 3: MCP Bridge Enhancements

**Scope:** Two new tools in the MCP bridge.

**Files:**

1. `src/agents/claude-code/mcp-bridge.ts` — **Modified** — Add `openclaw_project_status` and `openclaw_session_list` handlers
2. `src/agents/claude-code/runner.ts` — **Modified** — Pass session discovery data to bridge
3. `src/agents/claude-code/types.ts` — **Modified** — Add config flags

**Estimated effort:** 1-2 CC sessions

### Phase 4: Intelligent Session Selection

**Scope:** Replace naive `resolveSession()` usage with `selectSession()` in spawn flow.

**Files:**

1. `src/agents/claude-code/runner.ts` — **Modified** — Use `selectSession()` in `spawnClaudeCode()`
2. `src/agents/tools/sessions-spawn-tool.ts` — **Modified** — Pass project status to spawn

**Estimated effort:** 1 CC session

### Phase 5: Skill Update

**Scope:** Update coding-agent skill with pre-flight guidance.

**Files:**

1. `skills/coding-agent/SKILL.md` — **Modified** — Add pre-flight assessment section

**Estimated effort:** Manual (skill file update)

---

## Appendix A: CC Session JSONL Schema Reference

Based on empirical analysis of 153 session files across 5 projects.

### Core Fields (present on every message)

```typescript
interface CCJsonlMessage {
  parentUuid: string | null; // null for first message
  isSidechain: boolean; // true for subagent messages
  userType: "external"; // Always "external"
  cwd: string; // Working directory
  sessionId: string; // UUID
  version: string; // CC version (e.g., "2.1.41")
  gitBranch: string; // Git branch at message time
  type: string; // 44+ distinct types
  message: {
    // Varies by type
    role?: "user" | "assistant";
    content?: string | ContentBlock[];
    model?: string; // Assistant only
    usage?: UsageInfo; // Assistant only
    stop_reason?: string | null; // Assistant only
  };
  uuid: string; // Message UUID
  timestamp: string; // ISO 8601 UTC
}
```

### Optional Fields

```typescript
interface CCJsonlOptionalFields {
  slug?: string; // Human-readable session ID (adjective-noun-noun)
  isMeta?: boolean; // Metadata message flag
  permissionMode?: string; // "default" | "bypassPermissions"
  thinkingMetadata?: { maxThinkingTokens: number };
  todos?: TodoItem[]; // From /todo command
  requestId?: string; // API request ID (assistant only)
  toolUseResult?: object; // Tool execution result
  sourceToolAssistantUUID?: string; // Originating assistant message
  agentId?: string; // 7-char hex (subagent only)
}
```

### Special Message Types

| Type                    | Purpose                  | Key Fields                        |
| ----------------------- | ------------------------ | --------------------------------- |
| `queue-operation`       | Session queue management | `operation`, `timestamp`          |
| `file-history-snapshot` | File backup tracking     | `snapshot.trackedFileBackups`     |
| `progress`              | General progress         | `data.type`                       |
| `bash_progress`         | Bash execution progress  | `data.command`                    |
| `hook_progress`         | Hook execution           | `data.hookEvent`, `data.hookName` |
| `agent_progress`        | Subagent activity        | `data`                            |
| `thinking`              | Extended thinking block  | Content in `message.content`      |

---

## Appendix B: Current Architecture Reference

### File Map

| File                     | Lines | Purpose                                         | Key Exports                                                                      |
| ------------------------ | ----- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `runner.ts`              | ~800  | Spawn lifecycle, NDJSON parsing, progress relay | `spawnClaudeCode()`, `sendFollowUpAndWait()`, `stopPersistentSession()`          |
| `sessions.ts`            | ~383  | Registry CRUD, session file discovery           | `resolveSession()`, `saveSession()`, `listAllSessions()`, `peekSessionHistory()` |
| `live-state.ts`          | ~100  | In-memory maps for active/queued spawns         | `activeSpawns`, `liveSessions`, `getAllLiveSessions()`, `killClaudeCode()`       |
| `mcp-bridge.ts`          | ~377  | MCP server generation, announce queue           | `startMcpBridge()`                                                               |
| `protocol.ts`            | ~200  | NDJSON message types, parser                    | `parseOutboundMessage()`, CC\*Message types                                      |
| `types.ts`               | ~150  | Shared types                                    | Config, options, result, progress event types                                    |
| `sessions-spawn-tool.ts` | ~300  | Agent tool for CC spawns                        | Tool handler for `sessions_spawn mode=claude-code`                               |
| `cc-cli.ts`              | ~450  | CLI commands                                    | `list`, `info`, `attach`, `kill`, `costs`                                        |

### Data Flow

```
Agent tool call: sessions_spawn(mode: "claude-code", repo, task)
  │
  ├─ sessions-spawn-tool.ts
  │   ├─ Load CC config from openclaw.json
  │   ├─ Resolve repo path
  │   └─ Fire-and-forget: spawnClaudeCode(options)
  │       │
  │       ├─ runner.ts: executeSpawn()
  │       │   ├─ resolveSession() → sessionId or undefined
  │       │   ├─ peekSessionHistory() → context string
  │       │   ├─ startMcpBridge() → bridge config
  │       │   ├─ buildArgs() → CLI flags
  │       │   ├─ child_process.spawn("claude", args)
  │       │   ├─ Write task to stdin (NDJSON)
  │       │   ├─ Parse stdout (readline + parseOutboundMessage)
  │       │   ├─ Progress relay loop (periodic summaries)
  │       │   └─ Return ClaudeCodeResult
  │       │
  │       ├─ saveSession() / updateSessionStats()
  │       └─ Announce result to chat via callGateway()
  │
  └─ Return { status: "accepted" } immediately
```

### Registry Location

```
~/.openclaw/agents/{agentId}/claude-code-sessions.json
  └─ sessions:
       "repoPath": { sessionId, createdAt, lastResumedAt, totalCostUsd, totalTurns, taskHistory[], label? }
       "repoPath::label": { ... }  // Parallel labeled session
```

### CC Native Storage

```
~/.claude/projects/{slug}/
  ├─ {sessionId}.jsonl              # Main session transcript
  ├─ {sessionId}/
  │   ├─ subagents/
  │   │   └─ agent-{agentId}.jsonl  # Subagent transcripts
  │   └─ tool-results/
  │       └─ {hash}.txt             # Large tool outputs
  └─ ...more sessions
```

---

## Appendix C: Resolved Questions

| #     | Question                                    | Resolution                                                                                                                                                                                                                                                                                                                  |
| ----- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RQ5.1 | What data replicates the dropdown decision? | First message (title), branch, mtime (recency), line count (size), cost (if from registry). Implemented in `discoverSessions()`.                                                                                                                                                                                            |
| RQ5.2 | How to source sessions from all origins?    | Merge OpenClaw registries + native JSONL scan. Dedup by sessionId.                                                                                                                                                                                                                                                          |
| RQ5.3 | What's the decision model?                  | Scoring function with 5 factors: branch match (0.25), recency (0.20), task relevance (0.25, LLM-scored semantic similarity with negative gate for unrelated tasks), session health (0.15), context capacity (0.15). Hard ceilings: 3+ compactions, 70%+ budget, or unrelated + >200 messages = force fresh. Threshold: 0.6. |
| RQ5.4 | What abstraction for the agent?             | Hybrid (Option C): auto-resolve with `selectSession()`, expose data via MCP tools for CC to override.                                                                                                                                                                                                                       |
| RQ5.5 | How stale is a session?                     | CC has auto-compaction (confirmed by `PreCompact` hook). Recency scoring: >1 week = 0 points. >500 messages = health penalty. 3+ compactions = hard ceiling (force fresh). Token density > 4K/message = capacity penalty.                                                                                                   |
| RQ5.6 | What about uncommitted work?                | `gatherProjectStatus()` includes `git status --short` and `git stash list`. Surfaced in both pre-flight and MCP tool.                                                                                                                                                                                                       |
| Q1    | Source attribution                          | `userType` always "external" — useless. Inject `[openclaw:agent=X]` marker in first message.                                                                                                                                                                                                                                |
| Q2    | Tools CC sees when spawned                  | CC sees its native tools + MCP bridge tools. Now adding `openclaw_project_status` and `openclaw_session_list`.                                                                                                                                                                                                              |
| Q3    | Session resume mechanics                    | `--continue` picks most recent for project dir. `--resume <id>` picks specific. CC auto-compacts on context fill. OpenClaw wraps with `selectSession()` scoring.                                                                                                                                                            |

---

## Appendix D: Open Questions (Remaining)

| #   | Question                                               | Notes                                                                                                                                                                                                       |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ~~Should `selectSession()` use LLM judgment?~~         | **Resolved (v1.1):** Yes. Task relevance is now LLM-scored via a fast model (Haiku/Flash). One batched call for all candidates, ~$0.001, ~300ms. Keyword Jaccard kept only as fallback when LLM call fails. |
| 2   | Cache duration for project status?                     | Currently computed fresh each spawn. Could cache for 60s if multiple spawns fire rapidly.                                                                                                                   |
| 3   | Should `openclaw_project_status` re-scan on each call? | Git commands are cheap (~50ms total). Session discovery is heavier (~500ms for 36 JSONL files). Could cache session list, refresh git.                                                                      |
| 4   | Cross-repo session awareness?                          | Agent working on repo A might benefit from knowing about sessions on repo B (shared monorepo). Not addressed in this RFC.                                                                                   |
| 5   | Session handoff protocol?                              | Agent A starts work, goes offline. Agent B should be able to resume A's session. Needs registry update + explicit handoff marker. Deferred.                                                                 |
