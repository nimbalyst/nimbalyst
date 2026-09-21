/**
 * Supported Live WebSocket contract, verified 2026-09-12 against:
 * https://developers.openai.com/api/reference/resources/live
 * https://developers.openai.com/api/docs/guides/live-delegation
 * Wire properties retain OpenAI spelling; local reducer state uses camelCase.
 * This is a supported subset, not a replacement for the entire Responses schema.
 */
export interface LiveFunctionTool {
  type: "function";
  name: string;
  description?: string | null;
  parameters?: Record<string, unknown> | null;
  strict?: boolean | null;
}

export interface LiveSessionConfig {
  model: string;
  instructions?: string | null;
  store?: boolean;
  audio?: {
    format?:
      | { type: "audio/pcm"; rate: 16000 | 24000 }
      | { type: "audio/pcmu" | "audio/pcma"; rate: 8000 };
    output?: { voice?: string | { id: string } };
  };
  input?: Array<{
    type?: "message";
    role: "developer" | "user" | "assistant";
    content: Array<{
      type: "input_text" | "output_text" | "text";
      text: string;
    }>;
  }>;
  delegation?:
    | { type: "client" }
    | {
        type: "responses";
        responses: {
          model: string;
          instructions?: string | null;
          tools?: Array<LiveFunctionTool | { type: "web_search" }>;
          tool_choice?:
            | "auto"
            | "required"
            | "none"
            | { type: "function"; name: string };
          parallel_tool_calls?: boolean;
          max_output_tokens?: number;
          service_tier?: "auto" | "default" | "flex" | "priority";
        };
      }
    | null;
}

/** Configuration snapshot; status remains active even inside session.closed. */
export interface LiveSessionSnapshot {
  id: string;
  model: string;
  expires_at: number;
  status: "active";
  [key: string]: unknown;
}

export interface LiveClientEventMetadata {
  event_id?: string | null;
}
export interface LiveServerEventMetadata {
  event_id: string;
  client_event_id?: string;
}
export interface LiveSessionStartEvent extends LiveClientEventMetadata {
  type: "session.start";
  session: LiveSessionConfig;
}
export interface LiveInputAudioAppendEvent extends LiveClientEventMetadata {
  type: "session.input_audio.append";
  audio: string;
}
export interface LiveResponseItemCreateEvent extends LiveClientEventMetadata {
  type: "response.item.create";
  item:
    | { type: "function_call_output"; call_id: string; output: string }
    | {
        type: "message";
        role: "user";
        content: Array<
          | { type: "input_text"; text: string }
          | {
              type: "input_image";
              image_url: string;
              detail?: "auto" | "low" | "high";
            }
        >;
      };
}
export interface LiveResponseCreateEvent extends LiveClientEventMetadata {
  type: "response.create";
}
export interface LiveSessionCloseEvent extends LiveClientEventMetadata {
  type: "session.close";
}
export type LiveClientEvent =
  | LiveSessionStartEvent
  | LiveInputAudioAppendEvent
  | LiveResponseItemCreateEvent
  | LiveResponseCreateEvent
  | LiveSessionCloseEvent;

export interface LiveSessionStartedEvent extends LiveServerEventMetadata {
  type: "session.started";
  session: LiveSessionSnapshot;
}
/** Primary audio has no event_id or timing; reflected sideband audio may carry timing. */
export interface LiveOutputAudioDeltaEvent {
  type: "session.output_audio.delta";
  delta: string;
  start_ms?: number;
  end_ms?: number;
}
export interface LiveTranscriptDeltaEvent extends LiveServerEventMetadata {
  type: "session.input_transcript.delta" | "session.output_transcript.delta";
  delta: string;
  start_ms: number;
  end_ms: number;
}
export interface LiveDelegationCreatedEvent extends LiveServerEventMetadata {
  type: "session.delegation.created";
  offset_ms: number;
  delegation: {
    type: "delegation";
    id: string;
    target: "client" | "responses";
    response_id?: string;
  };
}
export interface LiveFunctionCallItem {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: "in_progress" | "completed" | "incomplete";
}
export interface LiveResponseLifecycleEvent {
  type:
    | "response.created"
    | "response.completed"
    | "response.failed"
    | "response.incomplete";
  sequence_number: number;
  response: {
    id: string;
    usage?: Record<string, unknown> | null;
    [key: string]: unknown;
  };
}
export interface LiveResponseOutputItemDoneEvent {
  type: "response.output_item.done";
  sequence_number: number;
  output_index: number;
  item: LiveFunctionCallItem | { type: string; [key: string]: unknown };
}
/** Unknown nested events stay opaque and must never become actionable calls. */
export interface LiveResponseEvent extends LiveServerEventMetadata {
  type: "response.event";
  delegation_id?: string | null;
  event: Record<string, unknown> & { type: string };
}
export interface LiveUsageUpdatedEvent extends LiveServerEventMetadata {
  type: "session.usage.updated";
  usage: { seconds: number };
  context_window?: { usage_ratio: number };
}
export type LiveCloseReason =
  | "close_requested"
  | "expired"
  | "content"
  | "remote_hangup"
  | "connection_lost";
export interface LiveSessionClosedEvent extends LiveServerEventMetadata {
  type: "session.closed";
  session: LiveSessionSnapshot;
  reason: LiveCloseReason;
  usage: { seconds: number };
}
export interface LiveErrorEvent extends LiveServerEventMetadata {
  type: "error";
  // The guide explicitly allows null code even though the reference says string.
  error: {
    type: string;
    code: string | null;
    message: string;
    param?: string;
    client_event_id?: string;
  };
}
export type LiveServerEvent =
  | LiveSessionStartedEvent
  | LiveOutputAudioDeltaEvent
  | LiveTranscriptDeltaEvent
  | LiveDelegationCreatedEvent
  | LiveResponseEvent
  | LiveUsageUpdatedEvent
  | LiveSessionClosedEvent
  | LiveErrorEvent;
