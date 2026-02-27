/**
 * TGCC Supervisor integration — singleton client and event handlers.
 *
 * Started on gateway startup, stopped on shutdown.
 */

import { execSync } from "node:child_process";
import { loadConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  findSubagentRunByChildSessionKey,

  markExternalSubagentRunComplete,
} from "../subagent-registry.js";
import { runSubagentAnnounceFlow } from "../subagent-announce.js";
import type { SubagentRunRecord } from "../subagent-registry.types.js";
import {
  TgccSupervisorClient,
  type TgccResultEvent,
  type TgccProcessExitEvent,
  type TgccSessionTakeoverEvent,
  type TgccApiErrorEvent,
  type TgccSupervisorClientConfig,
  type TgccAgentStatus,
  type TgccStatusResult,
} from "./client.js";

export type { TgccAgentStatus, TgccStatusResult } from "./client.js";

const log = createSubsystemLogger("tgcc-supervisor");

let client: TgccSupervisorClient | null = null;

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

/** Get the active supervisor client (null if not configured or stopped). */
export function getTgccSupervisorClient(): TgccSupervisorClient | null {
  return client;
}

/** Check if the supervisor client is connected. */
export function isTgccSupervisorConnected(): boolean {
  return client?.isConnected() === true;
}

// ---------------------------------------------------------------------------
// Health status
// ---------------------------------------------------------------------------

export interface TgccHealthStatus {
  configured: boolean;
  connected: boolean;
  agentCount?: number;
  socketPath?: string;
  reconnecting?: boolean;
}

/** Build a health-status snapshot for status tools and heartbeat checks. */
export function getTgccHealthStatus(): TgccHealthStatus {
  const cfg = loadConfig();
  const tgccCfg = cfg.agents?.defaults?.subagents?.claudeCode?.tgccSupervisor;
  if (!tgccCfg?.socket) {
    return { configured: false, connected: false };
  }

  const connected = isTgccSupervisorConnected();
  const agentNames = Object.keys(agentCache);
  return {
    configured: true,
    connected,
    socketPath: tgccCfg.socket,
    agentCount: agentNames.length || undefined,
    reconnecting: !connected && client != null,
  };
}

// ---------------------------------------------------------------------------
// Live agent cache (source of truth: TGCC status command)
// ---------------------------------------------------------------------------

export interface TgccAgentMapping {
  description?: string;
  repo: string;
  type?: "persistent" | "ephemeral";
  state?: "idle" | "active";
}

/** Cached agent list from TGCC. Refreshed on connect and periodically. */
let agentCache: Record<string, TgccAgentMapping> = {};
let agentCacheUpdatedAt = 0;
const AGENT_CACHE_TTL_MS = 60_000; // refresh every 60s max

/** Refresh the agent cache from TGCC status. */
async function refreshAgentCache(): Promise<void> {
  if (!client?.isConnected()) {return;}
  try {
    const result = await client.getStatus();
    const fresh: Record<string, TgccAgentMapping> = {};
    for (const agent of result.agents) {
      fresh[agent.id] = {
        repo: agent.repo,
        type: agent.type,
        state: agent.state,
      };
    }
    agentCache = fresh;
    agentCacheUpdatedAt = Date.now();
    log.info(`agent cache refreshed: ${result.agents.map((a) => a.id).join(", ")}`);
  } catch (err) {
    log.warn(`failed to refresh agent cache: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Get live TGCC agent mappings. Returns cached data, refreshes in background if stale. */
export function getTgccAgentMappings(): Record<string, TgccAgentMapping> {
  // Trigger background refresh if stale
  if (Date.now() - agentCacheUpdatedAt > AGENT_CACHE_TTL_MS) {
    void refreshAgentCache();
  }
  return agentCache;
}

/** Check if a target name matches a known TGCC agent. */
export function isTgccAgent(target: string): boolean {
  return target in agentCache;
}

/** Build a tgcc: child session key. Keyed by agentId only — TGCC owns session state. */
export function buildTgccChildSessionKey(agentId: string): string {
  return `tgcc:${agentId}`;
}

// ---------------------------------------------------------------------------
// Auto-start via systemd
// ---------------------------------------------------------------------------

let autoStartAttempted = false;

/**
 * Attempt to start the TGCC service via systemd if autoStart is configured.
 * Only runs once — subsequent reconnect failures skip this.
 */
function attemptAutoStart(tgccCfg: {
  autoStart?: boolean;
  serviceName?: string;
  [key: string]: unknown;
}): void {
  if (autoStartAttempted) {return;}
  if (!tgccCfg.autoStart) {return;}
  autoStartAttempted = true;

  const service = tgccCfg.serviceName ?? "tgcc";

  try {
    const result = execSync(`systemctl --user is-active ${service}.service 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();

    if (result === "active") {
      log.info(`TGCC service ${service}.service is already active, socket may not be ready yet`);
      return;
    }
  } catch {
    // is-active returns non-zero for inactive/failed — expected
  }

  log.info(`TGCC auto-start: starting ${service}.service via systemd`);

  try {
    execSync(`systemctl --user start ${service}.service`, {
      encoding: "utf-8",
      timeout: 10_000,
    });
    log.info(`TGCC auto-start: ${service}.service started successfully`);
  } catch (err) {
    log.warn(
      `TGCC auto-start: failed to start ${service}.service: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Check if the service is enabled (boot persistence)
  try {
    const enabled = execSync(`systemctl --user is-enabled ${service}.service 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();

    if (enabled !== "enabled") {
      log.info(
        `TGCC service ${service}.service is not enabled for boot. ` +
          `Run: systemctl --user enable ${service}`,
      );
    }
  } catch {
    log.info(
      `TGCC service ${service}.service may not be enabled for boot. ` +
        `Run: systemctl --user enable ${service}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Start the supervisor client if configured. Called on gateway startup. */
export function startTgccSupervisor(): void {
  if (client) {
    log.info("TGCC supervisor client already running");
    return;
  }

  const cfg = loadConfig();
  const tgccCfg = cfg.agents?.defaults?.subagents?.claudeCode?.tgccSupervisor;
  if (!tgccCfg?.socket) {
    log.info("TGCC supervisor not configured (no socket path)");
    return;
  }

  const clientConfig: TgccSupervisorClientConfig = {
    socket: tgccCfg.socket,
    reconnectInitialMs: tgccCfg.reconnectInitialMs,
    reconnectMaxMs: tgccCfg.reconnectMaxMs,
    heartbeatMs: tgccCfg.heartbeatMs,
  };

  client = new TgccSupervisorClient(clientConfig);
  attachEventHandlers(client);

  // On first connection failure, attempt systemd auto-start
  client.on("connectFailed", () => {
    attemptAutoStart(tgccCfg);
  });

  client.start();
  log.info(`TGCC supervisor client started (socket: ${tgccCfg.socket})`);
}

/** Stop the supervisor client. Called on gateway shutdown. */
export function stopTgccSupervisor(): void {
  if (!client) {return;}
  client.stop();
  client = null;
  agentCache = {};
  agentCacheUpdatedAt = 0;
  log.info("TGCC supervisor client stopped");
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function attachEventHandlers(c: TgccSupervisorClient): void {
  c.on("connected", () => void refreshAgentCache());
  c.on("tgcc:result", handleResult);
  c.on("tgcc:process_exit", handleProcessExit);
  c.on("tgcc:session_takeover", handleSessionTakeover);
  c.on("tgcc:api_error", handleApiError);
}

/** Find the active subagent run for a TGCC agent. Keyed by agentId only. */
function findTgccRun(agentId: string): SubagentRunRecord | null {
  const childKey = buildTgccChildSessionKey(agentId);
  return findSubagentRunByChildSessionKey(childKey);
}

function handleResult(event: TgccResultEvent): void {
  log.info(
    `result from ${event.agentId} (${event.is_error ? "error" : "ok"}, cost=$${event.cost_usd?.toFixed(4) ?? "?"})`,
  );

  const run = findTgccRun(event.agentId);
  if (!run) {
    log.info(`no subagent run found for tgcc:${event.agentId}, ignoring result`);
    return;
  }

  const now = Date.now();
  markExternalSubagentRunComplete({
    runId: run.runId,
    outcome: event.is_error ? { status: "error", error: event.text } : { status: "ok" },
    endedAt: now,
  });

  // Announce result back to the requester session
  const cfg = loadConfig();
  const timeoutMs = cfg.agents?.defaults?.subagents?.announceTimeoutMs ?? 30_000;
  void runSubagentAnnounceFlow({
    childSessionKey: run.childSessionKey,
    childRunId: run.runId,
    requesterSessionKey: run.requesterSessionKey,
    requesterDisplayKey: run.requesterSessionKey,
    task: run.task,
    timeoutMs,
    cleanup: "keep",
    roundOneReply: event.text,
    waitForCompletion: false,
    startedAt: run.startedAt ?? run.createdAt,
    endedAt: now,
    outcome: event.is_error ? { status: "error", error: event.text } : { status: "ok" },
    label: run.label,
  }).then((announced) => {
    log.info(`announce flow for ${event.agentId}: ${announced ? "delivered" : "not delivered"}`);
  }).catch((err) => {
    log.warn(`announce flow error for ${event.agentId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function handleProcessExit(event: TgccProcessExitEvent): void {
  log.info(`process_exit from ${event.agentId} (exit=${event.exitCode})`);

  const run = findTgccRun(event.agentId);
  if (!run) {return;}
  if (run.endedAt) {return;}

  markExternalSubagentRunComplete({
    runId: run.runId,
    outcome:
      event.exitCode === 0 ? { status: "ok" } : { status: "error", error: `exit code ${event.exitCode}` },
    endedAt: Date.now(),
  });
}

function handleSessionTakeover(event: TgccSessionTakeoverEvent): void {
  log.info(`session_takeover for ${event.agentId}`);

  const run = findTgccRun(event.agentId);
  if (!run) {return;}

  log.info(`session taken over by another client, run ${run.runId} stays active`);
}

function handleApiError(event: TgccApiErrorEvent): void {
  log.warn(`api_error from ${event.agentId}:${event.sessionId}: ${event.message}`);
  // Phase 1: just log. Could inject as system message into requester session later.
}
