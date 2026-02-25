/**
 * Claude Code streaming NDJSON runner.
 *
 * Wraps @fonz/tgcc CCProcess with OpenClaw-specific wiring:
 * - MCP bridge for context injection
 * - Progress relay to chat
 * - Session persistence
 * - NDJSON debug logging
 * - Per-repo concurrency queue
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CCProcess, type CCProcessOptions, type CCUserConfig } from "@fonz/tgcc";
import {
  createTextMessage,
  extractAssistantText,
  extractToolUses,
  type AssistantMessage,
  type InitEvent,
  type ResultEvent,
  type StreamInnerEvent,
  type PermissionRequest,
  type CCOutputEvent,
} from "@fonz/tgcc/protocol";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveClaudeBinary } from "./binary.js";
import { activeSpawns, queuedSpawns, liveSessions, type LiveSession } from "./live-state.js";
import { startMcpBridge, type McpBridgeHandle } from "./mcp-bridge.js";
import { peekSessionHistory, resolveSession, saveSession, updateSessionStats } from "./sessions.js";
import type {
  ClaudeCodePermissionMode,
  ClaudeCodeResult,
  ClaudeCodeSpawnOptions,
} from "./types.js";

const log = createSubsystemLogger("agent/claude-code");

// ---------------------------------------------------------------------------
// NDJSON debug logger
// ---------------------------------------------------------------------------

const NDJSON_LOG_DIR = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "logs",
  "claude-code-ndjson",
);

function createNdjsonLogger(repoPath: string) {
  try {
    fs.mkdirSync(NDJSON_LOG_DIR, { recursive: true });
  } catch {
    /* best-effort */
  }
  const repoLabel = path.basename(repoPath);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(NDJSON_LOG_DIR, `${repoLabel}_${ts}.ndjson`);
  const stream = fs.createWriteStream(filePath, { flags: "a" });
  log.info(`NDJSON debug log: ${filePath}`);
  return {
    log(dir: string, data: unknown) {
      stream.write(`${JSON.stringify({ dir, ts: Date.now(), data })}\n`);
    },
    close() {
      stream.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Permission mode mapping
// ---------------------------------------------------------------------------

function mapPermissionMode(mode?: ClaudeCodePermissionMode): CCUserConfig["permissionMode"] {
  switch (mode) {
    case "bypassPermissions":
      return "dangerously-skip";
    case "acceptEdits":
      return "acceptEdits";
    case "plan":
      return "plan";
    case "default":
    case "delegate":
    case "dontAsk":
    default:
      return "default";
  }
}

// ---------------------------------------------------------------------------
// Progress relay
// ---------------------------------------------------------------------------

type ProgressState = {
  lastRelayAt: number;
  intervalMs: number;
  enabled: boolean;
  includeToolUse: boolean;
  lastToolName: string | undefined;
  lastActivityText: string;
  accumulatedCostUsd: number;
  accumulatedTurns: number;
  timer: ReturnType<typeof setInterval> | null;
};

function createProgressState(options: ClaudeCodeSpawnOptions): ProgressState {
  const relay = options.progressRelay;
  return {
    lastRelayAt: Date.now(),
    intervalMs: (relay?.intervalSeconds ?? 30) * 1_000,
    enabled: relay?.enabled !== false,
    includeToolUse: relay?.includeToolUse !== false,
    lastToolName: undefined,
    lastActivityText: "",
    accumulatedCostUsd: 0,
    accumulatedTurns: 0,
    timer: null,
  };
}

function buildProgressSummary(
  progress: ProgressState,
  repoPath: string,
  startedAt: number,
): string {
  const elapsedSec = Math.round((Date.now() - startedAt) / 1_000);
  const elapsed =
    elapsedSec < 60 ? `${elapsedSec}s` : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
  const cost =
    progress.accumulatedCostUsd > 0 ? `, $${progress.accumulatedCostUsd.toFixed(2)}` : "";
  const turns = progress.accumulatedTurns > 0 ? `, ${progress.accumulatedTurns} turns` : "";
  const repoLabel = path.basename(repoPath);
  const lastAction =
    progress.includeToolUse && progress.lastToolName
      ? `\n   Last action: ${progress.lastToolName}`
      : "";
  return `[${repoLabel}] Claude Code working... (${elapsed}${cost}${turns})${lastAction}`;
}

// ---------------------------------------------------------------------------
// MCP config file helper
// ---------------------------------------------------------------------------

function writeMcpConfigFile(mcpConfig: Record<string, unknown>): string {
  const tmpDir = path.join(os.tmpdir(), "openclaw-mcp-bridge");
  fs.mkdirSync(tmpDir, { recursive: true });
  const configPath = path.join(tmpDir, `mcp-config-${Date.now()}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { "openclaw-bridge": mcpConfig } }));
  return configPath;
}

// ---------------------------------------------------------------------------
// Persistent idle timeout (30 min)
// ---------------------------------------------------------------------------

export const PERSISTENT_IDLE_MS = 30 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Core spawn
// ---------------------------------------------------------------------------

async function executeSpawn(options: ClaudeCodeSpawnOptions): Promise<ClaudeCodeResult> {
  const repoPath = path.resolve(options.repo);
  if (!fs.existsSync(path.join(repoPath, ".git"))) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }

  const binaryPath = resolveClaudeBinary(options.binaryPath);
  const agentId = options.agentId ?? "default";
  const persistent = options.persistent === true;

  // Session context for resume
  let sessionContext = "";
  const sessionToResume = options.resume;
  if (sessionToResume || options.continueSession) {
    const peekId = sessionToResume ?? resolveSession(agentId, repoPath, options.label);
    if (peekId) {
      sessionContext = peekSessionHistory(repoPath, peekId, {
        maxMessages: 8,
        maxChars: 4000,
      });
      if (sessionContext) {
        log.info(`peeked session ${peekId}: ${sessionContext.length} chars of context`);
      }
    }
  }

  // MCP bridge
  let bridge: McpBridgeHandle | null = null;
  let mcpConfigPath: string | undefined;
  if (options.mcpBridge?.enabled !== false) {
    try {
      bridge = await startMcpBridge(options);
      mcpConfigPath = writeMcpConfigFile(bridge.mcpConfig);
    } catch (err) {
      log.warn(`MCP bridge failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Build CCProcess options
  const userConfig: CCUserConfig = {
    model: options.model ?? "",
    repo: repoPath,
    maxTurns: 200, // CC default; budget caps the real limit
    idleTimeoutMs: persistent ? PERSISTENT_IDLE_MS : 5 * 60 * 1_000,
    hangTimeoutMs: 5 * 60 * 1_000,
    permissionMode: mapPermissionMode(options.permissionMode),
  };

  const ccOptions: CCProcessOptions = {
    agentId,
    userId: options.label ?? "default",
    ccBinaryPath: binaryPath,
    userConfig,
    mcpConfigPath,
    sessionId: sessionToResume ?? options.sessionId,
    continueSession: options.continueSession ?? !!sessionToResume,
  };

  // Env manipulation: CCProcess copies process.env at spawn time.
  // We temporarily modify it and restore immediately after start().
  const envBackup: Record<string, string | undefined> = {};
  const setTempEnv = (key: string, value: string | undefined) => {
    envBackup[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  const restoreEnv = () => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  // Critical env overrides
  setTempEnv("CLAUDECODE", undefined); // prevent nested session detection
  setTempEnv("ANTHROPIC_API_KEY", undefined);
  if (options.maxBudgetUsd != null) {
    setTempEnv("CLAUDE_CODE_MAX_BUDGET_USD", String(options.maxBudgetUsd));
  }

  const cc = new CCProcess(ccOptions);
  log.info(
    `spawning claude-code via CCProcess: repo=${repoPath} ` +
      `${options.continueSession ? "continue=true" : `resume=${sessionToResume ?? "none"}`} ` +
      `model=${options.model ?? "default"}`,
  );

  await cc.start();
  restoreEnv();

  // Track in OpenClaw state
  const startedAt = Date.now();
  const ndjsonLog = createNdjsonLogger(repoPath);
  const progress = createProgressState(options);

  const liveSession: LiveSession = {
    child: null as unknown as import("node:child_process").ChildProcess,
    sessionId: undefined,
    repoPath,
    startedAt,
    accumulatedCostUsd: 0,
    accumulatedTurns: 0,
    lastToolName: undefined,
    lastActivityText: "",
    results: [],
    persistent,
    pendingFollowUp: null,
    persistentIdleTimer: null,
  };

  // CCProcess manages its own child process internally.
  // For activeSpawns compatibility, we store a sentinel.
  // The kill/query functions need updating to work with CCProcess.
  liveSessions.set(repoPath, liveSession);

  // Global timeout (non-persistent only)
  const timeoutSeconds = options.timeoutSeconds ?? 600;
  let globalTimeout: ReturnType<typeof setTimeout> | null = null;
  if (!persistent) {
    globalTimeout = setTimeout(() => {
      log.warn(`claude-code global timeout after ${timeoutSeconds}s`);
      cc.kill();
    }, timeoutSeconds * 1_000);
  }

  // Progress relay timer
  if (progress.enabled && options.onProgress) {
    progress.timer = setInterval(() => {
      const summary = buildProgressSummary(progress, repoPath, startedAt);
      options.onProgress?.({ kind: "progress_summary", summary });
      if (bridge) {
        for (const msg of bridge.drainAnnouncements()) {
          options.onProgress?.({ kind: "text", text: msg });
        }
      }
    }, progress.intervalMs);
  }

  // ── Promise plumbing ──
  let resultResolve: (r: ClaudeCodeResult) => void;
  let resultReject: (e: Error) => void;
  let resolved = false;
  const resultPromise = new Promise<ClaudeCodeResult>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });

  const cleanup = () => {
    if (globalTimeout) {
      clearTimeout(globalTimeout);
    }
    if (progress.timer) {
      clearInterval(progress.timer);
    }
    ndjsonLog.close();
    liveSessions.delete(repoPath);
    activeSpawns.delete(repoPath);
    if (mcpConfigPath) {
      try {
        fs.unlinkSync(mcpConfigPath);
      } catch {
        /* ignore */
      }
    }
    if (bridge) {
      bridge.stop().catch(() => {});
    }
  };

  const resolveWith = (result: ClaudeCodeResult) => {
    if (resolved && !persistent) {
      return;
    }
    if (!resolved) {
      resolved = true;
      if (!persistent) {
        cleanup();
      }
      resultResolve(result);
    }
    // Persistent mode: push to results, resolve pending follow-ups
    if (persistent) {
      liveSession.results.push(result);
      if (liveSession.pendingFollowUp) {
        liveSession.pendingFollowUp.resolve(result);
        liveSession.pendingFollowUp = null;
      }
      options.onProgress?.({ kind: "result", result });
    }
  };

  // ── Wire CCProcess events ──

  cc.on("output", (event: CCOutputEvent) => {
    ndjsonLog.log("stdout", event);
  });

  cc.on("init", (event: InitEvent) => {
    liveSession.sessionId = event.session_id;
    log.info(`claude-code session init: sessionId=${event.session_id} model=${event.model}`);
    options.onProgress?.({ kind: "status", sessionId: event.session_id });
  });

  cc.on("assistant", (event: AssistantMessage) => {
    progress.accumulatedTurns += 1;
    liveSession.accumulatedTurns = progress.accumulatedTurns;

    // Reset global timeout on real activity
    if (globalTimeout) {
      clearTimeout(globalTimeout);
      globalTimeout = setTimeout(() => {
        log.warn(`claude-code global timeout after ${timeoutSeconds}s`);
        cc.kill();
      }, timeoutSeconds * 1_000);
    }

    const text = extractAssistantText(event);
    if (text) {
      progress.lastActivityText = text.slice(0, 200);
      liveSession.lastActivityText = progress.lastActivityText;
      options.onProgress?.({ kind: "text", text });
    }

    for (const toolUse of extractToolUses(event)) {
      progress.lastToolName = toolUse.name;
      liveSession.lastToolName = toolUse.name;
      options.onProgress?.({ kind: "tool_use", toolName: toolUse.name, input: toolUse.input });
    }
  });

  cc.on("stream_event", (_event: StreamInnerEvent) => {
    // Stream events are logged via 'output' handler.
    // Could extract partial text here for finer-grained progress.
  });

  cc.on("result", (event: ResultEvent) => {
    if (globalTimeout) {
      clearTimeout(globalTimeout);
    }

    const resultObj: ClaudeCodeResult = {
      success: event.subtype === "success",
      sessionId: event.session_id ?? cc.sessionId ?? "",
      result: event.result ?? progress.lastActivityText ?? "",
      totalCostUsd: event.total_cost_usd ?? 0,
      durationMs: event.duration_ms ?? Date.now() - startedAt,
      durationApiMs: event.duration_api_ms ?? 0,
      numTurns: event.num_turns ?? progress.accumulatedTurns,
      usage: event.usage ?? { input_tokens: 0, output_tokens: 0 },
      permissionDenials: [],
      errors: [],
    };

    progress.accumulatedCostUsd = resultObj.totalCostUsd;
    liveSession.accumulatedCostUsd = resultObj.totalCostUsd;

    // Persist session
    const sessionId = resultObj.sessionId;
    if (sessionId) {
      saveSession(agentId, repoPath, sessionId, {
        task: options.task,
        costUsd: resultObj.totalCostUsd,
        label: options.label,
      });
      updateSessionStats(
        agentId,
        repoPath,
        { turns: resultObj.numTurns, costUsd: resultObj.totalCostUsd },
        options.label,
      );
    }

    resolveWith(resultObj);

    if (!persistent) {
      // Kill process after result in one-shot mode
      cc.kill();
    }
  });

  cc.on("permission_request", (event: PermissionRequest) => {
    const req = event.request;
    const toolName = req.tool_name;
    const description = `Tool: ${toolName}`;
    options.onProgress?.({
      kind: "permission_request",
      toolName,
      description,
      requestId: event.request_id,
    });
    options.onPermissionRequest?.({ toolName, description, requestId: event.request_id });

    // Auto-approve in bypass mode
    if (options.permissionMode === "bypassPermissions") {
      cc.respondToPermission(event.request_id, true);
    }
  });

  cc.on("error", (err: Error) => {
    log.error(`CC process error: ${err.message}`);
    if (!resolved) {
      resolved = true;
      cleanup();
      resultReject(err);
    }
  });

  cc.on("exit", (code: number | null, signal: string | null) => {
    log.info(`CC process exited: code=${code} signal=${signal}`);

    if (!resolved) {
      // Process exited without a result — synthesize one if we have any activity
      if (progress.accumulatedTurns > 0) {
        resolveWith({
          success: true,
          sessionId: cc.sessionId ?? "",
          result: progress.lastActivityText || "(completed — result message missing from CC CLI)",
          totalCostUsd: progress.accumulatedCostUsd,
          durationMs: Date.now() - startedAt,
          durationApiMs: 0,
          numTurns: progress.accumulatedTurns,
          usage: { input_tokens: 0, output_tokens: 0 },
          permissionDenials: [],
          errors: ["CC CLI did not emit result message. Synthesized from process exit."],
        });
      } else {
        resolved = true;
        cleanup();
        resultReject(
          new Error(
            `Claude Code process exited without a result message (code=${code}, signal=${signal}).`,
          ),
        );
      }
    } else if (persistent) {
      // Persistent session ended
      cleanup();
      if (liveSession.pendingFollowUp) {
        liveSession.pendingFollowUp.reject(new Error("Persistent session ended"));
        liveSession.pendingFollowUp = null;
      }
    }

    drainQueue(repoPath);
  });

  cc.on("hang", () => {
    log.warn("CC process detected as hung by CCProcess");
    // CCProcess will kill the process; the exit handler above will resolve/reject.
  });

  cc.on("media", (media: { kind: string; media_type: string; data: string }) => {
    options.onProgress?.({ kind: "media", media });
  });

  cc.on("api_error", (event: { error: { message?: string; status?: number } }) => {
    log.warn(`CC API error: ${event.error.message ?? "unknown"} (status ${event.error.status})`);
  });

  // ── Send the task ──
  const marker = `[openclaw:agent=${agentId}]`;
  let taskContent = `${marker}\n\n${options.task}`;
  if (sessionContext) {
    taskContent = [
      marker,
      "",
      "<previous_session_context>",
      sessionContext,
      "</previous_session_context>",
      "",
      options.task,
    ].join("\n");
  }
  cc.sendMessage(createTextMessage(taskContent));

  // Store CCProcess reference for follow-up/kill operations
  liveSession._ccProcess = cc;

  return resultPromise;
}

// ---------------------------------------------------------------------------
// Queue management
// ---------------------------------------------------------------------------

function drainQueue(repoPath: string): void {
  const queued = queuedSpawns.get(repoPath);
  if (!queued) {
    return;
  }
  queuedSpawns.delete(repoPath);
  executeSpawn(queued.options).then(queued.resolve, queued.reject);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn a Claude Code CLI session.
 * Enforces per-repo concurrency: max 1 running + 1 queued.
 */
export async function spawnClaudeCode(options: ClaudeCodeSpawnOptions): Promise<ClaudeCodeResult> {
  const repoPath = path.resolve(options.repo);

  if (activeSpawns.has(repoPath) || liveSessions.has(repoPath)) {
    if (queuedSpawns.has(repoPath)) {
      throw new Error(
        `Claude Code is already running and queued for ${repoPath}. ` +
          "Wait for the current run to finish.",
      );
    }
    log.info(`claude-code already running for ${repoPath}, queuing request`);
    return new Promise<ClaudeCodeResult>((resolve, reject) => {
      queuedSpawns.set(repoPath, { resolve, reject, options });
    });
  }

  return executeSpawn(options);
}

/**
 * Send a follow-up message to a persistent Claude Code session and wait for the result.
 */
export function sendFollowUpAndWait(
  repoPath: string,
  message: string,
  timeoutMs?: number,
): Promise<ClaudeCodeResult> {
  const resolved = path.resolve(repoPath);
  const session = liveSessions.get(resolved);
  if (!session?.persistent) {
    return Promise.reject(new Error(`No persistent session for ${resolved}`));
  }
  const cc = session?._ccProcess as CCProcess | undefined;
  if (!cc || cc.state !== "active") {
    return Promise.reject(new Error(`Session not active for ${resolved}`));
  }
  if (session.pendingFollowUp) {
    return Promise.reject(new Error("A follow-up is already pending"));
  }

  return new Promise<ClaudeCodeResult>((resolve, reject) => {
    session.pendingFollowUp = { resolve, reject };

    if (timeoutMs != null && timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (session.pendingFollowUp?.reject === reject) {
          session.pendingFollowUp = null;
          reject(new Error(`Follow-up timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      const origResolve = resolve;
      const origReject = reject;
      session.pendingFollowUp = {
        resolve: (r) => {
          clearTimeout(timer);
          origResolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          origReject(e);
        },
      };
    }

    cc.sendMessage(createTextMessage(message));
    log.info(`follow-up (with wait) sent to persistent session on ${resolved}`);
  });
}

/**
 * Send a follow-up message to a running Claude Code session.
 */
export function sendFollowUp(repoPath: string, message: string): boolean {
  const resolved = path.resolve(repoPath);
  const session = liveSessions.get(resolved);
  const cc = session?._ccProcess as CCProcess | undefined;
  if (!cc || cc.state !== "active") {
    return false;
  }

  cc.sendMessage(createTextMessage(message));
  log.info(`follow-up message sent to session on ${resolved}`);
  return true;
}

/**
 * Stop a persistent Claude Code session.
 */
export function stopPersistentSession(repoPath: string): boolean {
  const resolved = path.resolve(repoPath);
  const session = liveSessions.get(resolved);
  if (!session) {
    return false;
  }
  if (session.persistentIdleTimer) {
    clearTimeout(session.persistentIdleTimer);
    session.persistentIdleTimer = null;
  }
  if (session.pendingFollowUp) {
    session.pendingFollowUp.reject(new Error("Persistent session stopped"));
    session.pendingFollowUp = null;
  }
  const cc = session?._ccProcess as CCProcess | undefined;
  if (cc) {
    cc.kill();
  }
  return true;
}

/**
 * Respond to a permission request from a running Claude Code session.
 */
export function respondToPermission(repoPath: string, requestId: string, allow: boolean): boolean {
  const resolved = path.resolve(repoPath);
  const session = liveSessions.get(resolved);
  const cc = session?._ccProcess as CCProcess | undefined;
  if (!cc || cc.state !== "active") {
    return false;
  }

  cc.respondToPermission(requestId, allow);
  log.info(`permission response sent: requestId=${requestId} allow=${allow}`);
  return true;
}

// Query/kill functions re-exported from live-state for barrel compatibility.
export {
  killClaudeCode,
  isClaudeCodeRunning,
  getLiveSession,
  getAllLiveSessions,
} from "./live-state.js";
