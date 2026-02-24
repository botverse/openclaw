/**
 * Stream-JSON protocol types for Claude Code CLI.
 *
 * Core protocol types are re-exported from @fonz/tgcc/protocol.
 * OpenClaw-specific extensions are defined here.
 */

// Re-export core protocol types from the library
export {
  parseCCOutputLine,
  extractAssistantText,
  extractToolUses,
  isStreamTextDelta,
  isStreamThinkingDelta,
  getStreamBlockType,
  createTextMessage,
  createImageMessage,
  createDocumentMessage,
  createInitializeRequest,
  createPermissionResponse,
  serializeMessage,
  type TextContent,
  type ImageContent,
  type ContentBlock,
  type UserMessage,
  type ControlRequestInitialize,
  type PermissionRequest,
  type ControlRequest,
  type ControlResponse,
  type InitEvent,
  type AssistantTextBlock,
  type AssistantToolUseBlock,
  type AssistantThinkingBlock,
  type AssistantContentBlock,
  type AssistantMessage,
  type ToolResultEvent,
  type ResultEvent,
  type ApiErrorEvent,
  type CCOutputEvent,
  type StreamMessageStart,
  type StreamContentBlockStart,
  type StreamContentBlockStartText,
  type StreamContentBlockStartThinking,
  type StreamContentBlockStartToolUse,
  type StreamTextDelta,
  type StreamThinkingDelta,
  type StreamInputJsonDelta,
  type StreamContentBlockDelta,
  type StreamContentBlockStop,
  type StreamMessageStop,
  type StreamInnerEvent,
  type StreamEvent,
} from "@fonz/tgcc/protocol";

// ---------------------------------------------------------------------------
// Back-compat aliases for existing OpenClaw code
// ---------------------------------------------------------------------------

// parseOutboundMessage wraps parseCCOutputLine with OpenClaw-specific types
import { parseCCOutputLine as _parseCCOutputLine } from "@fonz/tgcc/protocol";

/**
 * Parse a CC output line. Handles both core protocol types (via @fonz/tgcc)
 * and OpenClaw-specific extensions (auth_status, system subtypes, etc.).
 */
export function parseOutboundMessage(raw: string): CCOutboundMessage | null {
  // Try the library parser first (handles core types)
  const result = _parseCCOutputLine(raw);
  if (result) {
    return result as unknown as CCOutboundMessage;
  }

  // Fallback: parse OpenClaw-specific types the library doesn't know about
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.type === "string") {
      return parsed as CCOutboundMessage;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OpenClaw-specific protocol extensions
// ---------------------------------------------------------------------------

export type ClaudeCodeUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

// OpenClaw-specific message types that extend the core protocol with
// OpenClaw-only fields (e.g. permissionMode on system messages, hooks, auth).

/** System message — session init, status, hooks, task notifications. */
export type CCSystemMessage =
  | CCSystemInitMessage
  | CCSystemStatusMessage
  | CCSystemHookStartedMessage
  | CCSystemHookProgressMessage
  | CCSystemHookResponseMessage
  | CCSystemTaskNotificationMessage;

export type CCSystemInitMessage = {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  mcp_servers: unknown[];
  model: string;
  permissionMode?: string;
  claude_code_version?: string;
  agents?: string[];
  skills?: string[];
  plugins?: string[];
  uuid: string;
};

export type CCSystemStatusMessage = {
  type: "system";
  subtype: "status";
  status: string | null;
  permissionMode?: string;
  uuid: string;
  session_id: string;
};

export type CCSystemHookStartedMessage = {
  type: "system";
  subtype: "hook_started";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  uuid: string;
  session_id: string;
};

export type CCSystemHookProgressMessage = {
  type: "system";
  subtype: "hook_progress";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output?: string;
  uuid: string;
  session_id: string;
};

export type CCSystemHookResponseMessage = {
  type: "system";
  subtype: "hook_response";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  outcome?: string;
  uuid: string;
  session_id: string;
};

export type CCSystemTaskNotificationMessage = {
  type: "system";
  subtype: "task_notification";
  task_id: string;
  status: "completed" | "failed" | "stopped";
  output_file?: string;
  summary?: string;
  uuid: string;
  session_id: string;
};

/** Assistant message with OpenClaw extensions. */
export type CCAssistantMessage = {
  type: "assistant";
  message: {
    model: string;
    id: string;
    type: "message";
    role: "assistant";
    content: CCContentBlock[];
    stop_reason: "end_turn" | "tool_use" | null;
    usage?: ClaudeCodeUsage;
  };
  session_id: string;
  uuid: string;
};

export type CCContentBlock = CCTextBlock | CCToolUseBlock;

export type CCTextBlock = {
  type: "text";
  text: string;
};

export type CCToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/** User message — tool results echoed back. */
export type CCUserMessage = {
  type: "user";
  message: {
    role: "user";
    content: CCToolResultBlock[];
  };
  uuid: string;
  session_id: string;
};

export type CCToolResultBlock = {
  tool_use_id: string;
  type: "tool_result";
  content: string;
};

/** Result message. */
export type CCResultMessage = {
  type: "result";
  subtype: CCResultSubtype;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error: boolean;
  num_turns?: number;
  stop_reason?: string;
  session_id: string;
  total_cost_usd?: number;
  usage?: ClaudeCodeUsage;
  modelUsage?: Record<string, unknown>;
  permission_denials?: string[];
  uuid: string;
  result?: string;
  errors?: string[];
};

export type CCResultSubtype =
  | "success"
  | "error_during_execution"
  | "error_max_turns"
  | "error_max_budget_usd";

/** Stream event. */
export type CCStreamEvent = {
  type: "stream_event";
  event?: { type?: string; [key: string]: unknown };
  [key: string]: unknown;
};

/** Auth status. */
export type CCAuthStatusMessage = {
  type: "auth_status";
  isAuthenticating: boolean;
  output?: string;
  error?: string | null;
  uuid: string;
  session_id: string;
};

/** Control response. */
export type CCControlResponse = {
  type: "control_response";
  response: {
    subtype: "success" | "error";
    request_id: string;
    response?: Record<string, unknown>;
    error?: string;
    pending_permission_requests?: unknown[];
  };
};

/** Union of all outbound (stdout) message types. */
export type CCOutboundMessage =
  | CCSystemMessage
  | CCAssistantMessage
  | CCUserMessage
  | CCResultMessage
  | CCStreamEvent
  | CCAuthStatusMessage
  | CCControlResponse;

// Inbound types kept for backward compatibility

export type CCUserInput = {
  type: "user";
  message: { role: "user"; content: string };
  uuid: string;
};

export type CCControlRequest = {
  type: "control_request";
  request: CCControlRequestPayload;
  request_id: string;
};

export type CCControlRequestPayload =
  | { subtype: "set_permission_mode"; permissionMode: string }
  | { subtype: "set_model"; model: string }
  | { subtype: "initialize" }
  | { subtype: "mcp_status" };

export type CCKeepAlive = { type: "keep_alive" };

export type CCInboundMessage = CCUserInput | CCControlRequest | CCKeepAlive;
