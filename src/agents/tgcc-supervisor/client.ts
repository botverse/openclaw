/**
 * TgccSupervisorClient — Unix socket client for the TGCC Supervisor Protocol.
 *
 * Connects to TGCC's ctl socket, registers as a supervisor, and provides
 * async methods for interacting with TGCC-managed agents and CC processes.
 *
 * Phase 1: send_message, send_to_cc, status, kill_cc, subscribe, unsubscribe, ping
 */

import crypto from "node:crypto";
import net from "node:net";
import { EventEmitter } from "node:events";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("tgcc-supervisor");

// ---------------------------------------------------------------------------
// Wire protocol types
// ---------------------------------------------------------------------------

export interface SupervisorCommand {
  type: "command";
  requestId: string;
  action: string;
  params?: Record<string, unknown>;
}

export interface SupervisorResponse {
  type: "response";
  requestId: string;
  result?: unknown;
  error?: string;
}

export interface SupervisorEvent {
  type: "event";
  event: string;
  [key: string]: unknown;
}

type WireMessage = SupervisorCommand | SupervisorResponse | SupervisorEvent;

// ---------------------------------------------------------------------------
// Status response types
// ---------------------------------------------------------------------------

export interface TgccAgentStatus {
  id: string;
  type: "persistent" | "ephemeral";
  state: "idle" | "active";
  sessionId: string | null;
  repo: string;
  supervisorSubscribed: boolean;
}

export interface TgccStatusResult {
  agents: TgccAgentStatus[];
  sessions?: Array<{
    id: string;
    agentId: string;
    messageCount?: number;
    totalCostUsd?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Event types emitted by the client
// ---------------------------------------------------------------------------

export interface TgccResultEvent {
  agentId: string;
  sessionId: string;
  text: string;
  cost_usd?: number;
  duration_ms?: number;
  is_error?: boolean;
}

export interface TgccProcessExitEvent {
  agentId: string;
  sessionId: string;
  exitCode: number | null;
}

export interface TgccSessionTakeoverEvent {
  agentId: string;
  sessionId: string;
  exitCode: number | null;
}

export interface TgccApiErrorEvent {
  agentId: string;
  sessionId: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TgccSupervisorClientConfig {
  socket: string;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  heartbeatMs?: number;
}

// ---------------------------------------------------------------------------
// Pending request tracking
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const HEARTBEAT_PONG_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class TgccSupervisorClient extends EventEmitter {
  private config: Required<TgccSupervisorClientConfig>;
  private socket: net.Socket | null = null;
  private connected = false;
  private destroyed = false;
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private lineBuffer = "";

  constructor(config: TgccSupervisorClientConfig) {
    super();
    this.config = {
      socket: config.socket,
      reconnectInitialMs: config.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS,
      reconnectMaxMs: config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
      heartbeatMs: config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    };
    this.reconnectDelay = this.config.reconnectInitialMs;
  }

  // ── Public lifecycle ─────────────────────────────────────────────────

  /** Start connecting to the TGCC ctl socket. */
  start(): void {
    if (this.destroyed) {return;}
    this.connect();
  }

  /** Disconnect and stop reconnecting. */
  stop(): void {
    this.destroyed = true;
    this.clearTimers();
    this.rejectAllPending("Client stopped");
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  /** Whether the client is currently connected and registered. */
  isConnected(): boolean {
    return this.connected;
  }

  // ── Public API methods ───────────────────────────────────────────────

  /**
   * Send a message to any TGCC agent. Spawns CC if not running.
   * Returns the immediate response (sessionId, state), not the CC result.
   */
  async sendMessage(
    agentId: string,
    text: string,
    opts?: { sessionId?: string; subscribe?: boolean },
  ): Promise<{ sessionId: string; state: string; subscribed?: boolean }> {
    const result = await this.sendCommand("send_message", {
      agentId,
      text,
      sessionId: opts?.sessionId,
      subscribe: opts?.subscribe ?? true,
    });
    return result as { sessionId: string; state: string; subscribed?: boolean };
  }

  /** Send a follow-up to an already-running CC process. */
  async sendToCC(agentId: string, text: string): Promise<{ sent: boolean }> {
    const result = await this.sendCommand("send_to_cc", { agentId, text });
    return result as { sent: boolean };
  }

  /** Query agent and session status. */
  async getStatus(agentId?: string): Promise<TgccStatusResult> {
    const params: Record<string, unknown> = {};
    if (agentId) {params.agentId = agentId;}
    const result = await this.sendCommand("status", params);
    return result as TgccStatusResult;
  }

  /** Kill a running CC process. */
  async killCC(agentId: string): Promise<unknown> {
    return this.sendCommand("kill_cc", { agentId });
  }

  /** Subscribe to an agent's CC process events. */
  async subscribe(agentId: string, sessionId?: string): Promise<unknown> {
    const params: Record<string, unknown> = { agentId };
    if (sessionId) {params.sessionId = sessionId;}
    return this.sendCommand("subscribe", params);
  }

  /** Unsubscribe from an agent's CC process events. */
  async unsubscribe(agentId: string): Promise<unknown> {
    return this.sendCommand("unsubscribe", { agentId });
  }

  // ── Connection management ────────────────────────────────────────────

  private connect(): void {
    if (this.destroyed) {return;}

    log.info(`connecting to TGCC ctl socket: ${this.config.socket}`);

    const sock = net.createConnection({ path: this.config.socket });
    this.socket = sock;

    sock.on("connect", () => {
      log.info("connected to TGCC ctl socket");
      this.connected = true;
      this.reconnectDelay = this.config.reconnectInitialMs;
      this.lineBuffer = "";
      this.register();
      this.startHeartbeat();
      this.emit("connected");
    });

    sock.on("data", (data: Buffer) => {
      this.handleData(data);
    });

    sock.on("error", (err: Error) => {
      log.warn(`TGCC socket error: ${err.message}`);
    });

    sock.on("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.clearTimers();
      this.socket = null;
      if (wasConnected) {
        log.info("TGCC socket closed, scheduling reconnect");
        this.emit("disconnected");
      } else {
        // Socket closed before we ever connected (ENOENT, ECONNREFUSED, etc.)
        this.emit("connectFailed");
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.destroyed) {return;}
    if (this.reconnectTimer) {return;}

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.config.reconnectMaxMs);

    log.info(`reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private register(): void {
    // Registration uses the ctl request format (type: "register_supervisor"),
    // NOT the supervisor command format (type: "command", action: ...).
    // Once registered, the connection switches to supervisor mode where
    // commands use {type: "command", action: "..."}.
    this.sendRaw({
      type: "register_supervisor",
      agentId: "openclaw",
      capabilities: ["exec", "notify"],
    } as any); // eslint-disable-line @typescript-eslint/no-explicit-any -- ctl request format, not supervisor command
  }

  // ── Heartbeat ────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendPing();
    }, this.config.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private sendPing(): void {
    if (!this.connected) {return;}

    const requestId = crypto.randomUUID();
    this.sendRaw({
      type: "command",
      requestId,
      action: "ping",
    });

    // Expect pong within timeout
    this.pongTimer = setTimeout(() => {
      log.warn("TGCC pong timeout, forcing reconnect");
      this.forceReconnect();
    }, HEARTBEAT_PONG_TIMEOUT_MS);
    this.pongTimer.unref?.();

    // Register a pending request for pong correlation
    this.pendingRequests.set(requestId, {
      resolve: () => {
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
      },
      reject: () => {},
      timer: setTimeout(() => {
        this.pendingRequests.delete(requestId);
      }, HEARTBEAT_PONG_TIMEOUT_MS + 1_000),
    });
    this.pendingRequests.get(requestId)!.timer.unref?.();
  }

  private forceReconnect(): void {
    this.rejectAllPending("Connection lost");
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.clearTimers();
    this.scheduleReconnect();
  }

  // ── Data parsing ─────────────────────────────────────────────────────

  private handleData(data: Buffer): void {
    this.lineBuffer += data.toString("utf-8");
    const lines = this.lineBuffer.split("\n");
    // Keep the incomplete last line in the buffer
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {continue;}
      try {
        const msg = JSON.parse(trimmed) as WireMessage;
        this.handleMessage(msg);
      } catch {
        log.warn(`failed to parse TGCC message: ${trimmed.slice(0, 200)}`);
      }
    }
  }

  private handleMessage(msg: WireMessage): void {
    if (msg.type === "response") {
      this.handleResponse(msg);
    } else if (msg.type === "event") {
      this.handleEvent(msg);
    } else if (msg.type === "command") {
      // Phase 3: reverse commands from TGCC → OpenClaw
      log.info(`received reverse command: ${msg.action} (not yet implemented)`);
    }
  }

  private handleResponse(msg: SupervisorResponse): void {
    const pending = this.pendingRequests.get(msg.requestId);
    if (!pending) {return;}

    this.pendingRequests.delete(msg.requestId);
    clearTimeout(pending.timer);

    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleEvent(msg: SupervisorEvent): void {
    const eventName = msg.event;
    log.info(`received event: ${String(eventName)} agentId=${String(msg.agentId ?? "?")}`);

    switch (eventName) {
      case "result":
        this.emit("tgcc:result", {
          agentId: msg.agentId,
          sessionId: msg.sessionId,
          text: msg.text,
          cost_usd: msg.cost_usd,
          duration_ms: msg.duration_ms,
          is_error: msg.is_error,
        } as TgccResultEvent);
        break;

      case "process_exit":
        this.emit("tgcc:process_exit", {
          agentId: msg.agentId,
          sessionId: msg.sessionId,
          exitCode: msg.exitCode ?? null,
        } as TgccProcessExitEvent);
        break;

      case "session_takeover":
        this.emit("tgcc:session_takeover", {
          agentId: msg.agentId,
          sessionId: msg.sessionId,
          exitCode: msg.exitCode ?? null,
        } as TgccSessionTakeoverEvent);
        break;

      case "api_error":
        this.emit("tgcc:api_error", {
          agentId: msg.agentId,
          sessionId: msg.sessionId,
          message: msg.message,
        } as TgccApiErrorEvent);
        break;

      case "registered":
        log.info("supervisor registered with TGCC");
        this.emit("registered");
        // Re-sync state after registration
        void this.syncStateAfterConnect();
        break;

      default:
        this.emit(`tgcc:${eventName}`, msg);
        break;
    }
  }

  private async syncStateAfterConnect(): Promise<void> {
    try {
      const status = await this.getStatus();
      this.emit("tgcc:status_sync", status);
    } catch (err) {
      log.warn(`failed to sync state after connect: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Command sending ──────────────────────────────────────────────────

  private sendCommand(action: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        reject(new Error("Not connected to TGCC"));
        return;
      }

      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`TGCC command timeout: ${action}`));
      }, COMMAND_TIMEOUT_MS);
      timer.unref?.();

      this.pendingRequests.set(requestId, { resolve, reject, timer });

      this.sendRaw({
        type: "command",
        requestId,
        action,
        params,
      });
    });
  }

  private sendRaw(msg: Record<string, unknown>): void {
    if (!this.socket || this.socket.destroyed) {return;}
    try {
      this.socket.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      log.warn(`failed to send to TGCC: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Timer management ─────────────────────────────────────────────────

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}
