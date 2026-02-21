# Spec: Claude Code Session Intelligence

**Branch:** `feat/claude-code-spawn-mode`
**Scope:** Session discovery, project awareness, intelligent session selection, source attribution
**Reference:** `RFC-v2.md` (in repo root, remove after merge), `REVIEW.md` findings

---

## Overview

Add intelligence to how OpenClaw selects, resumes, and creates Claude Code sessions. Currently, unlabeled sessions blindly use `--continue` (most recent session) and agents have zero visibility into project state or existing sessions from other sources. This spec adds:

1. Source attribution markers on spawned sessions
2. Cleanup of dead code and duplicates identified in review
3. Cross-source session discovery (OpenClaw registries + native CC JSONL)
4. Project state gathering (git, GitHub, docs, active sessions)
5. Two new MCP bridge tools for spawned CC sessions
6. Intelligent session selection with 5-factor scoring + LLM-based task relevance

---

## Phase 1: Source Attribution + Cleanup

**Zero risk, zero dependencies. Do this first.**

### 1a. Source Attribution

In `runner.ts`, when building the initial message to send via stdin, prepend an origin marker:

```
[openclaw:agent=<agentId>]

<original task text>
```

The marker goes on the first line of the first user message content. It does NOT affect CC behavior — it's just text. But it's detectable by JSONL scanners via regex: `/\[openclaw:agent=([^\]]+)\]/`

**Where to change:** Find where `executeSpawn()` writes the initial task to stdin (the `initMessage` JSON construction). Prepend the marker to the task content string before building the JSON.

Only apply to the initial message, not follow-ups.

### 1b. Cleanup

1. **`exposeMemory` / `exposeConversation` in types.ts** — These `mcpBridge` config flags are declared but never checked in `mcp-bridge.ts`. Remove them from the type. We'll add proper tool control flags in Phase 5.

2. **Duplicate `child.on("error")` in runner.ts** — There are two handlers registered. Consolidate to one that logs, clears timeout, and cleans up state.

3. **Duplicate `normalizeDeliveryContext()` calls in sessions-spawn-tool.ts** — The delivery context is normalized 3 times with identical arguments. `requesterOrigin` is already computed on ~line 114. Reuse it in the later locations (~lines 306, 349) instead of calling `normalizeDeliveryContext()` again.

4. **Export `repoPathToSlug()` from sessions.ts** — Extract the slug algorithm into a proper exported function:

   ```typescript
   export function repoPathToSlug(repoPath: string): string {
     return repoPath.replace(/\//g, "-");
   }
   ```

   The CC JSONL storage uses full path with `/` → `-`. The existing `ccSessionFileExists()` tries multiple strategies because the algorithm wasn't known — now it is. Keep the broad-search fallback in `ccSessionFileExists()` as safety net, but make the primary path use `repoPathToSlug()`.

5. **Add comment about non-functional bridge budget tracking** — In `mcp-bridge.ts`, the bridge tracks `totalCostUsd` and gates on it, but nothing ever updates the value. Add a `// TODO: budget tracking is non-functional — totalCostUsd is never updated` comment.

### Verification

- Spawn a CC session, check the JSONL file's first user message contains `[openclaw:agent=...]`
- Types compile cleanly without `exposeMemory`/`exposeConversation`
- `repoPathToSlug("/home/fonz/Projects/openclaw")` returns `"-home-fonz-Projects-openclaw"`

---

## Phase 2: Session Discovery

**Foundation for everything else. Testable via CLI independently.**

### New types in `types.ts`

```typescript
export interface DiscoveredSession {
  sessionId: string;
  source: "openclaw" | "native-only";
  agentId?: string;
  repoPath: string;
  branch: string;
  firstMessage: string; // First user message text (session "title"), max 200 chars
  lastModified: Date;
  messageCount: number; // Line count of JSONL
  fileSizeBytes: number;
  totalCostUsd?: number; // From registry (openclaw only)
  totalTurns?: number; // From registry (openclaw only)
  lastTask?: string; // Most recent task (openclaw only)
  label?: string; // Session label (openclaw only)
  slug?: string; // CC's human-readable slug (adjective-noun-noun)
  isRunning: boolean;
  originMarker?: string; // Extracted [openclaw:agent=X] if present
  // Context capacity metrics
  totalInputTokens: number;
  totalOutputTokens: number;
  compactionCount: number; // Auto-compaction events detected
  budgetUsedPct?: number; // totalCostUsd / maxBudgetUsd if both known
}
```

### New function: `parseJsonlHeader()` in `sessions.ts`

Extracts metadata from a CC JSONL session file. **Must use streaming readline**, NOT `readFileSync()` — some session files are 50MB+.

**Strategy:**

- Stream first 10 lines for: `gitBranch`, `slug`, `version`, `permissionMode`, first user message text, origin marker
- Stream ALL lines counting: line count, assistant message `usage.input_tokens`/`output_tokens` sums, compaction events (system messages containing "compress"/"compact"/"summary")
- Return `JsonlHeader` with all extracted fields

```typescript
interface JsonlHeader {
  gitBranch?: string;
  firstUserMessage?: string;
  slug?: string;
  version?: string;
  lineCount: number;
  originMarker?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  compactionCount: number;
}
```

**Performance:** Use `readline.createInterface()` on a `fs.createReadStream()`. For line counting + token summing, this is O(n) in file size but constant memory.

### New function: `discoverSessions()` in `sessions.ts`

```typescript
export async function discoverSessions(repoPath: string): Promise<DiscoveredSession[]>;
```

Merges two data sources:

1. **OpenClaw registries** — call existing `listAllSessions()`, filter to matching `repoPath` (use `path.resolve()` for comparison). These have rich metadata (cost, turns, task history, agent ID).

2. **CC native storage** — scan `~/.claude/projects/{slug}/*.jsonl` where slug = `repoPathToSlug(repoPath)`. For each `.jsonl` file not already found in step 1 (dedup by sessionId), call `parseJsonlHeader()`.

For each session, check `isRunning` against the `liveSessions` map from `live-state.ts`.

Sort: running sessions first, then by `lastModified` descending.

### Update `cc list` CLI in `cc-cli.ts`

The existing `cc list` command should use `discoverSessions()` for richer output. Show source (openclaw/native), branch, first message preview, age, message count, cost if known.

Add `cc list --repo <path>` flag to filter to a specific repo.

### Verification

- `openclaw cc list` shows all sessions including ones created from VSCode/CLI
- Sessions from OpenClaw registries show agent ID and cost
- Native-only sessions show branch and first message
- Large JSONL files don't cause memory issues

---

## Phase 3: Project Status

**Can be built in parallel with Phase 2.**

### New file: `src/agents/claude-code/project-status.ts`

```typescript
export interface ProjectStatus {
  repo: { path: string; name: string; isGitRepo: boolean };
  git: {
    currentBranch: string;
    headCommitSha: string;
    headCommitMessage: string;
    uncommittedChanges: string[];
    stagedChanges: string[];
    stashCount: number;
    recentCommits: Array<{ sha: string; message: string; author: string; date: string }>;
  };
  github?: {
    openPrs: Array<{ number: number; title: string; branch: string; state: string }>;
    failingChecks: Array<{ name: string; status: string }>;
  };
  sessions: {
    active: DiscoveredSession[];
    recent: DiscoveredSession[]; // Last 5 from any source
    ownRecent: DiscoveredSession[]; // Last 3 from requesting agent
  };
  docs: {
    hasClaudeMd: boolean;
    hasSpecs: boolean;
    specFiles: string[];
    hasTodo: boolean;
    hasReadme: boolean;
  };
  timestamp: string;
}

export async function gatherProjectStatus(
  repoPath: string,
  agentId?: string,
): Promise<ProjectStatus>;
```

**Implementation:**

- Run git commands in parallel via `Promise.allSettled()` with 5s timeout each
- `gh pr list` and `gh pr checks` are optional (gh may not be installed)
- Call `discoverSessions()` for session data
- Check filesystem for docs

### Verification

- Returns valid status for a git repo
- Works when `gh` CLI is not installed (github field is undefined)
- Doesn't hang on network-less environments

---

## Phase 4: MCP Bridge Enhancements

**Depends on Phases 2 + 3.**

### New tool: `openclaw_project_status`

Add to the bridge script template in `mcp-bridge.ts`. No input parameters. Returns the project status as JSON.

The bridge runs git commands itself (it has access to the repo directory via `CONFIG.repoPath`). Session data is baked into `CONFIG` at bridge creation time.

### New tool: `openclaw_session_list`

Add to the bridge script template. Optional input: `include_native` (boolean, default true). Returns the session list as JSON.

Session data is pre-computed by the runner via `discoverSessions()` and injected into the bridge config. The tool returns this pre-computed list.

### Bridge config changes

Update `startMcpBridge()` call in `runner.ts` to pass:

- `recentSessions: DiscoveredSession[]` — pre-computed at bridge start
- `activeSessions: Array<{ sessionId: string; repoPath: string }>`

### Tool registration

Add both tools to the `tools/list` handler in the bridge script template, alongside the existing 4 tools.

### Verification

- Spawned CC session can call `openclaw_project_status` and get git state
- Spawned CC session can call `openclaw_session_list` and see other sessions
- Existing 4 tools still work

---

## Phase 5: Session Selection

**Most complex phase. Depends on Phases 2 + 3.**

### New file: `src/agents/claude-code/session-selection.ts`

#### Config type (add to `types.ts`)

```typescript
export interface SessionSelectionConfig {
  relevanceModel: string; // Default: "claude-haiku"
  relevanceMaxTokens: number; // Default: 500
  relevanceTimeoutMs: number; // Default: 3000
  resumeThreshold: number; // Default: 0.6
  enabled: boolean; // Default: true — false = keyword fallback only
}
```

Add `sessionSelection?: Partial<SessionSelectionConfig>` to the CC subagent config type. Support per-agent overrides (agent config merges over defaults).

#### Hard ceilings

Before scoring, check two non-negotiable conditions that force a fresh session:

- **3+ compactions** — context too degraded
- **70%+ budget consumed** — not enough runway

Plus a soft ceiling:

- **Task relevance < 0.1 AND session > 200 messages** — large unrelated session is pure deadweight

#### LLM-based task relevance: `assessTaskRelevance()`

One batched call to a fast LLM (configurable via `relevanceModel`) that scores all candidate sessions at once.

**Input:** New task description + numbered list of session descriptions (branch + last task or first message)

**Output:** Per-session relevance score (0.0–1.0) with one-line reasoning

**Fallback chain:**

1. If LLM call fails (timeout, error) → fall back to keyword Jaccard
2. If `enabled: false` → always use keyword Jaccard
3. Never block the spawn flow

The LLM call must use whatever API client is available in the OpenClaw codebase. Look at how other parts of the codebase make LLM API calls and follow the same pattern.

#### Scoring function: `scoreSession()`

Five factors, total max 1.0:

| Factor           | Weight        | Signal                                                                                                                  |
| ---------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Branch match     | 0.25          | Session branch === current git branch                                                                                   |
| Recency          | 0.20          | Exponential decay: <1h=0.20, <6h=0.16, <24h=0.12, <3d=0.08, <1w=0.04, >1w=0                                             |
| Task relevance   | -0.15 to 0.25 | LLM-scored. ≥0.6=full, 0.3-0.6=linear 0.10-0.25, 0.1-0.3=neutral 0, <0.1=**penalty -0.15**                              |
| Session health   | 0.15          | Penalize: >500 msgs (-0.07), >5MB (-0.04), >1 week (-0.04)                                                              |
| Context capacity | 0.15          | Penalize: 1 compaction (-0.04), 2 compactions (-0.09), >50% budget (-0.04), >30% budget (-0.02), >4K tokens/msg (-0.03) |

Resume threshold: configurable, default 0.6.

Score is clamped to minimum 0.

#### Decision function: `selectSession()`

```typescript
export async function selectSession(
  task: string,
  repoPath: string,
  agentId: string,
  projectStatus: ProjectStatus,
  label?: string,
  maxBudgetUsd?: number,
  config?: SessionSelectionConfig,
): Promise<SessionSelection>;
```

Decision tree:

1. Label provided → direct `resolveSession()` lookup. Found = resume, not found = fresh.
2. Active session on repo → queue (existing behavior, preserve)
3. No own sessions → fresh
4. Score all own sessions → best above threshold = resume, otherwise fresh

Return includes: `action` (resume/fresh/queue), `sessionId?`, `reason` (human-readable), `scores?` (for debugging/logging)

#### Integration into `sessions-spawn-tool.ts`

Replace the session-resume-strategy block (~lines 204-221) with a call to `selectSession()`. The result tells us:

- `action: "resume"` → use `--resume <sessionId>`
- `action: "fresh"` → no session flag (fresh spawn)
- `action: "queue"` → existing queue behavior

**Keep labeled sessions using direct `resolveSession()`** — the RFC preserves this path.

**Log the scoring decision** at info level so users can understand why a session was/wasn't resumed.

### Verification

- Unlabeled spawn on same branch + similar task → resumes
- Unlabeled spawn on different branch + unrelated task → fresh
- Labeled spawn → direct lookup (unchanged behavior)
- 3+ compacted session → always fresh regardless of other factors
- LLM timeout → falls back to keyword matching, spawn still works
- `sessionSelection.enabled: false` → pure keyword matching
- Scoring decisions logged with human-readable reasons

---

## Constraints

- **Do NOT modify persistent session handling** (keep-alive, follow-ups, 30-min idle). It's orthogonal to this spec.
- **Do NOT modify per-repo concurrency** (1 running + 1 queued). Preserve existing behavior.
- **Do NOT modify permission relay** (`respondToPermission()`). Orthogonal.
- **Do NOT refactor the bridge from template-literal to .cjs file.** That's a separate effort.
- **Use streaming readline for JSONL parsing**, not `readFileSync()`.
- **Follow existing code patterns** — `require` not `import`, same logging style, same error handling.
- **All new functions must be properly exported** from `index.ts`.

---

## File Change Map

| File                                          | Change                                                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/claude-code/runner.ts`            | Phase 1: source attribution marker. Phase 1: consolidate error handlers. Phase 4: pass discovery data to bridge. Phase 5: accept `selectSession()` result.                              |
| `src/agents/claude-code/sessions.ts`          | Phase 1: export `repoPathToSlug()`. Phase 2: add `discoverSessions()`, `parseJsonlHeader()`.                                                                                            |
| `src/agents/claude-code/types.ts`             | Phase 1: remove dead `exposeMemory`/`exposeConversation`. Phase 2: add `DiscoveredSession`. Phase 3: add `ProjectStatus`. Phase 5: add `SessionSelectionConfig`, add to CC config type. |
| `src/agents/claude-code/mcp-bridge.ts`        | Phase 1: add budget tracking comment. Phase 4: add 2 new tool handlers, update bridge config.                                                                                           |
| `src/agents/claude-code/project-status.ts`    | Phase 3: **new file**.                                                                                                                                                                  |
| `src/agents/claude-code/session-selection.ts` | Phase 5: **new file**.                                                                                                                                                                  |
| `src/agents/claude-code/index.ts`             | All phases: export new functions/types.                                                                                                                                                 |
| `src/agents/tools/sessions-spawn-tool.ts`     | Phase 1: dedup delivery context. Phase 5: replace resume strategy with `selectSession()`.                                                                                               |
| `src/cli/cc-cli.ts`                           | Phase 2: update `cc list` to use `discoverSessions()`.                                                                                                                                  |
