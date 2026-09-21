/**
 * Managed delegation safety contract, checked 2026-09-12:
 * - Live docs are SILENT on concurrent delegated responses and the uniqueness scope
 *   of call_id across them. The reference describes a unique function-call ID but
 *   does not promise cross-delegation uniqueness. Commands have no response/delegation
 *   address: https://developers.openai.com/api/reference/resources/live
 * - Server handling of results for a superseded/closed delegation in an otherwise
 *   open session is SILENT. Session closure does reject further commands:
 *   https://developers.openai.com/api/docs/guides/live-conversations#usage-and-graceful-close
 * - Application task supersession is not protocol closure. The migration guide says
 *   to return cancelled/superseded outputs for still-pending calls before continuing:
 *   https://developers.openai.com/api/docs/guides/live-migration#preserve-context-and-apply-corrections
 *
 * Therefore SERIALIZATION IS OUR CONSERVATIVE CONSTRAINT, not an API guarantee.
 * A second response.created while a response is collecting or still owes results
 * latches an invalid fault. No newer response implicitly supersedes an older one.
 * Faults/closure hard-block all output; discard unsent outboxes and end/reconcile
 * the session. Never reset the collector within the same live session to clear a
 * fault. Local supersession drops results but does not release the protocol lock.
 *
 * Ready batches carry a local binding; serialize only their wire events. Check the
 * current state before sending, cancel unsent batches on supersession/fault/closure,
 * and call markToolResultsSent only after the entire batch was written in order.
 * It records local send completion, NOT server acknowledgment. A partial send must
 * not be retried blindly. Process one primary socket's events in delivery order.
 */
import type {
  LiveFunctionCallItem,
  LiveResponseCreateEvent,
  LiveResponseItemCreateEvent,
  LiveServerEvent,
  LiveSessionSnapshot,
  LiveTranscriptDeltaEvent,
} from "./liveProtocol";

export type LiveDecodedEvent =
  | { kind: "event"; event: LiveServerEvent }
  | { kind: "unknown"; type: string; raw: unknown }
  | { kind: "invalid"; reason: string; raw: unknown };

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const optionalString = (value: unknown): boolean =>
  value === undefined || string(value);
const snapshot = (value: unknown): value is LiveSessionSnapshot =>
  object(value) &&
  string(value.id) &&
  string(value.model) &&
  number(value.expires_at) &&
  value.status === "active";
const usage = (value: unknown): boolean =>
  object(value) && number(value.seconds);
const functionItem = (value: unknown): value is LiveFunctionCallItem =>
  object(value) &&
  value.type === "function_call" &&
  string(value.id) &&
  string(value.call_id) &&
  string(value.name) &&
  string(value.arguments) &&
  (value.status === undefined ||
    ["in_progress", "completed", "incomplete"].includes(String(value.status)));
const lifecycleTypes = [
  "response.created",
  "response.completed",
  "response.failed",
  "response.incomplete",
];

/** Accept parsed JSON only; the transport owns text/buffer parsing and exceptions. */
export function decode(raw: unknown): LiveDecodedEvent {
  const invalid = (reason: string): LiveDecodedEvent => ({
    kind: "invalid",
    reason,
    raw,
  });
  if (!object(raw) || !string(raw.type))
    return invalid("Expected an event object with a string type");
  let valid: boolean;
  switch (raw.type) {
    case "session.started":
      valid = snapshot(raw.session);
      break;
    case "session.output_audio.delta":
      valid =
        string(raw.delta) &&
        (raw.start_ms === undefined || number(raw.start_ms)) &&
        (raw.end_ms === undefined || number(raw.end_ms));
      // Audio is the documented exception to server event_id metadata.
      return valid
        ? { kind: "event", event: raw as unknown as LiveServerEvent }
        : invalid("Invalid audio delta");
    case "session.input_transcript.delta":
    case "session.output_transcript.delta":
      valid =
        string(raw.delta) &&
        number(raw.start_ms) &&
        number(raw.end_ms) &&
        raw.end_ms >= raw.start_ms;
      break;
    case "session.delegation.created":
      valid =
        number(raw.offset_ms) &&
        object(raw.delegation) &&
        raw.delegation.type === "delegation" &&
        string(raw.delegation.id) &&
        ["client", "responses"].includes(String(raw.delegation.target)) &&
        optionalString(raw.delegation.response_id);
      break;
    case "response.event": {
      const event = raw.event;
      valid =
        (raw.delegation_id == null || string(raw.delegation_id)) &&
        object(event) &&
        string(event.type);
      if (valid && object(event)) {
        if (lifecycleTypes.includes(String(event.type))) {
          valid =
            number(event.sequence_number) &&
            object(event.response) &&
            string(event.response.id) &&
            (event.response.usage == null || object(event.response.usage));
        } else if (
          event.type === "response.output_item.done" ||
          event.type === "response.output_item.added"
        ) {
          valid =
            number(event.sequence_number) &&
            number(event.output_index) &&
            object(event.item) &&
            string(event.item.type) &&
            string(event.item.id);
          if (
            valid &&
            object(event.item) &&
            event.item.type === "function_call"
          )
            valid = functionItem(event.item);
        }
      }
      break;
    }
    case "session.usage.updated":
      valid =
        usage(raw.usage) &&
        (raw.context_window === undefined ||
          (object(raw.context_window) &&
            number(raw.context_window.usage_ratio)));
      break;
    case "session.closed":
      valid =
        snapshot(raw.session) &&
        usage(raw.usage) &&
        [
          "close_requested",
          "expired",
          "content",
          "remote_hangup",
          "connection_lost",
        ].includes(String(raw.reason));
      break;
    case "error":
      valid =
        object(raw.error) &&
        string(raw.error.type) &&
        string(raw.error.message) &&
        (raw.error.code === null || string(raw.error.code)) &&
        optionalString(raw.error.param) &&
        optionalString(raw.error.client_event_id);
      break;
    default:
      return { kind: "unknown", type: raw.type, raw };
  }
  return valid && string(raw.event_id) && optionalString(raw.client_event_id)
    ? { kind: "event", event: raw as unknown as LiveServerEvent }
    : invalid(`Invalid ${raw.type} payload`);
}

export interface LiveResponseIdentity {
  delegationId: string;
  responseId: string;
}
export interface LiveCallIdentity extends LiveResponseIdentity {
  callId: string;
}
export interface LiveCollectedCall extends LiveCallIdentity {
  itemId: string;
  name: string;
  arguments: string;
  output?: string;
}
export interface LiveCollectedResponse extends LiveResponseIdentity {
  status: "collecting" | "completed" | "superseded" | "failed";
  terminal: boolean;
  calls: readonly LiveCollectedCall[];
  dispatched: boolean;
  resultsSent: boolean;
}
export interface LiveToolProtocolError {
  code:
    | "overlappingResponses"
    | "uncorrelatedResponse"
    | "identityConflict"
    | "sessionClosed"
    | "invalidOutbox";
  message: string;
}
export interface LiveToolCallState {
  responses: readonly LiveCollectedResponse[];
  closed: boolean;
  fault?: LiveToolProtocolError;
  seenEventIds: readonly string[];
  /** Composite delegation/item bindings survive completed responses. */
  itemOwners: Readonly<Record<string, string>>;
}
export type LiveToolCollection =
  | {
      status: "valid";
      state: LiveToolCallState;
      calls: readonly LiveCollectedCall[];
    }
  | {
      status: "invalid";
      state: LiveToolCallState;
      calls: readonly [];
      error: LiveToolProtocolError;
    };
export const createToolCallState = (): LiveToolCallState => ({
  responses: [],
  closed: false,
  seenEventIds: [],
  itemOwners: {},
});
const sameResponse = (
  left: LiveResponseIdentity,
  right: LiveResponseIdentity
): boolean =>
  left.responseId === right.responseId &&
  left.delegationId === right.delegationId;
const owesProtocolWork = (response: LiveCollectedResponse): boolean =>
  !response.terminal ||
  (response.status !== "failed" &&
    response.calls.length > 0 &&
    !response.resultsSent);
function invalidToolCollection(
  state: LiveToolCallState,
  error: LiveToolProtocolError
): LiveToolCollection {
  const fault = state.fault ?? error;
  return {
    status: "invalid",
    state: { ...state, fault },
    calls: [],
    error: fault,
  };
}

/** This blocks application results, not backend work; it does not unlock the lane. */
export function supersedeToolCalls(
  state: LiveToolCallState,
  responseId: string
): LiveToolCallState {
  return {
    ...state,
    responses: state.responses.map((response) =>
      response.responseId === responseId
        ? { ...response, status: "superseded" }
        : response
    ),
  };
}

export function reduceToolCalls(
  state: LiveToolCallState,
  event: LiveServerEvent
): LiveToolCollection {
  if (event.type === "session.closed") {
    const next: LiveToolCallState = {
      ...state,
      closed: true,
      responses: state.responses.map((response) => ({
        ...response,
        status: "superseded",
      })),
    };
    return next.fault
      ? invalidToolCollection(next, next.fault)
      : { status: "valid", state: next, calls: [] };
  }
  if (state.fault) return invalidToolCollection(state, state.fault);
  if (event.type !== "response.event")
    return { status: "valid", state, calls: [] };
  if (state.closed)
    return invalidToolCollection(state, {
      code: "sessionClosed",
      message: "Response event received after session finalization",
    });
  const nested = event.event;
  if (
    !lifecycleTypes.includes(nested.type) &&
    nested.type !== "response.output_item.added" &&
    nested.type !== "response.output_item.done"
  )
    return { status: "valid", state, calls: [] };
  if (state.seenEventIds.includes(event.event_id))
    return { status: "valid", state, calls: [] };
  if (!event.delegation_id)
    return invalidToolCollection(state, {
      code: "uncorrelatedResponse",
      message:
        "Cannot establish delegation binding for a response lifecycle or item",
    });
  const delegationId = event.delegation_id;
  let next: LiveToolCallState = {
    ...state,
    seenEventIds: [...state.seenEventIds, event.event_id],
  };
  if (
    nested.type === "response.created" &&
    object(nested.response) &&
    string(nested.response.id)
  ) {
    const binding: LiveResponseIdentity = {
      delegationId,
      responseId: nested.response.id,
    };
    const existing = state.responses.find(
      (response) => response.responseId === binding.responseId
    );
    if (existing)
      return sameResponse(existing, binding)
        ? { status: "valid", state: next, calls: [] }
        : invalidToolCollection(next, {
            code: "identityConflict",
            message: "Response ID changed its delegation binding",
          });
    if (state.responses.some(owesProtocolWork))
      return invalidToolCollection(next, {
        code: "overlappingResponses",
        message:
          "Second response.created before prior response and required result submission finished; concurrency is undocumented",
      });
    next = {
      ...next,
      responses: [
        ...state.responses,
        {
          ...binding,
          status: "collecting",
          terminal: false,
          calls: [],
          dispatched: false,
          resultsSent: false,
        },
      ],
    };
  } else if (
    lifecycleTypes.includes(nested.type) &&
    object(nested.response) &&
    string(nested.response.id)
  ) {
    const binding = { delegationId, responseId: nested.response.id };
    if (!next.responses.some((response) => sameResponse(response, binding)))
      return invalidToolCollection(next, {
        code: "uncorrelatedResponse",
        message: "Terminal response has no matching response.created",
      });
    next = {
      ...next,
      responses: next.responses.map((response) =>
        sameResponse(response, binding) && !response.terminal
          ? {
              ...response,
              terminal: true,
              status:
                response.status === "superseded"
                  ? "superseded"
                  : nested.type === "response.completed"
                  ? "completed"
                  : "failed",
            }
          : response
      ),
    };
  } else if (
    (nested.type === "response.output_item.added" ||
      nested.type === "response.output_item.done") &&
    object(nested.item) &&
    string(nested.item.id)
  ) {
    const item = nested.item;
    const ownerKey = JSON.stringify([delegationId, item.id]);
    const ownerId = state.itemOwners[ownerKey];
    const candidates = next.responses.filter(
      (response) =>
        response.delegationId === delegationId &&
        (ownerId ? response.responseId === ownerId : !response.terminal)
    );
    if (candidates.length !== 1)
      return invalidToolCollection(next, {
        code: "uncorrelatedResponse",
        message: "Cannot establish a unique response binding for output item",
      });
    const response = candidates[0];
    if (response.status !== "collecting" || response.terminal)
      return { status: "valid", state: next, calls: [] };
    next = {
      ...next,
      itemOwners: { ...next.itemOwners, [ownerKey]: response.responseId },
    };
    if (
      nested.type === "response.output_item.done" &&
      functionItem(item) &&
      (item.status === undefined || item.status === "completed") &&
      !response.calls.some(
        (call) => call.callId === item.call_id || call.itemId === item.id
      )
    ) {
      const call: LiveCollectedCall = {
        delegationId,
        responseId: response.responseId,
        callId: item.call_id,
        itemId: item.id,
        name: item.name,
        arguments: item.arguments,
      };
      return {
        status: "valid",
        state: {
          ...next,
          responses: next.responses.map((candidate) =>
            candidate === response
              ? { ...response, calls: [...response.calls, call] }
              : candidate
          ),
        },
        calls: [call],
      };
    }
  }
  return { status: "valid", state: next, calls: [] };
}

export interface LiveToolResultAcceptance {
  state: LiveToolCallState;
  status: "accepted" | "duplicate" | "stale" | "unknown";
}
export function acceptToolResult(
  state: LiveToolCallState,
  identity: LiveCallIdentity,
  output: string
): LiveToolResultAcceptance {
  const response = state.responses.find((candidate) =>
    sameResponse(candidate, identity)
  );
  const call = response?.calls.find(
    (candidate) => candidate.callId === identity.callId
  );
  if (!response || !call) return { state, status: "unknown" };
  if (
    state.closed ||
    state.fault ||
    response.status === "superseded" ||
    response.status === "failed"
  )
    return { state, status: "stale" };
  if (call.output !== undefined || response.dispatched)
    return { state, status: "duplicate" };
  return {
    status: "accepted",
    state: {
      ...state,
      responses: state.responses.map((candidate) =>
        candidate === response
          ? {
              ...response,
              calls: response.calls.map((candidateCall) =>
                candidateCall === call ? { ...call, output } : candidateCall
              ),
            }
          : candidate
      ),
    },
  };
}

export type LiveReadyToolResults =
  | { status: "waiting"; state: LiveToolCallState; events: readonly [] }
  | {
      status: "invalid";
      state: LiveToolCallState;
      events: readonly [];
      error: LiveToolProtocolError;
    }
  | {
      status: "ready";
      state: LiveToolCallState;
      binding: LiveResponseIdentity;
      events: readonly (
        | LiveResponseItemCreateEvent
        | LiveResponseCreateEvent
      )[];
    };
/** Call after collection and result acceptance; the binding is local, never a wire field. */
export function takeReadyToolResults(
  state: LiveToolCallState
): LiveReadyToolResults {
  if (state.fault)
    return { status: "invalid", state, events: [], error: state.fault };
  if (state.closed)
    return {
      status: "invalid",
      state,
      events: [],
      error: {
        code: "sessionClosed",
        message: "Cannot submit results after session finalization",
      },
    };
  const pending = state.responses.filter(owesProtocolWork);
  if (pending.length > 1) {
    const invalid = invalidToolCollection(state, {
      code: "overlappingResponses",
      message: "Multiple unresolved responses cannot be addressed safely",
    });
    return {
      status: "invalid",
      state: invalid.state,
      events: [],
      error: invalid.state.fault!,
    };
  }
  const response = pending[0];
  if (
    !response ||
    response.status !== "completed" ||
    response.dispatched ||
    response.calls.length === 0 ||
    response.calls.some((call) => call.output === undefined)
  )
    return { status: "waiting", state, events: [] };
  return {
    status: "ready",
    binding: {
      delegationId: response.delegationId,
      responseId: response.responseId,
    },
    state: {
      ...state,
      responses: state.responses.map((candidate) =>
        candidate === response ? { ...response, dispatched: true } : candidate
      ),
    },
    events: [
      ...response.calls.map(
        (call): LiveResponseItemCreateEvent => ({
          type: "response.item.create",
          item: {
            type: "function_call_output",
            call_id: call.callId,
            output: call.output!,
          },
        })
      ),
      { type: "response.create" },
    ],
  };
}

/** Entire bound batch was written locally, in order; no server acknowledgment is implied. */
export function markToolResultsSent(
  state: LiveToolCallState,
  binding: LiveResponseIdentity
): LiveToolCallState {
  if (state.fault) return state;
  const response = state.responses.find((candidate) =>
    sameResponse(candidate, binding)
  );
  if (
    state.closed ||
    !response ||
    response.status !== "completed" ||
    !response.dispatched
  ) {
    return {
      ...state,
      fault: {
        code: "invalidOutbox",
        message:
          "Result batch sent after its binding became invalid or before it was ready",
      },
    };
  }
  return {
    ...state,
    responses: state.responses.map((candidate) =>
      candidate === response ? { ...response, resultsSent: true } : candidate
    ),
  };
}

/**
 * Backend accounting fields we keep, and the only ones.
 *
 * The whole `response.usage` object used to be copied through verbatim and sent
 * across IPC to the renderer. Nothing in the inspected flow puts a credential
 * there, but it is an arbitrary provider-shaped object being forwarded on
 * trust, and "we have not seen anything sensitive in it" is not a policy. An
 * allowlist of numeric counters is.
 */
const BACKEND_USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cached_tokens",
  "reasoning_tokens",
] as const;

export type LiveBackendUsageCounters = Partial<
  Record<(typeof BACKEND_USAGE_FIELDS)[number], number>
>;

export interface LiveBackendUsage {
  delegationId: string | null;
  responseId: string;
  usage: Readonly<LiveBackendUsageCounters>;
}

/**
 * Keep the finite numeric counters from a provider usage object, including the
 * two that live one level down in `*_tokens_details`. Everything else is
 * dropped -- an unrecognized field is not accounting.
 */
export function pickBackendUsage(
  usage: Record<string, unknown>
): LiveBackendUsageCounters {
  const flat: Record<string, unknown> = { ...usage };
  for (const details of ["input_tokens_details", "output_tokens_details"]) {
    const nested = usage[details];
    if (object(nested)) Object.assign(flat, nested);
  }
  const picked: LiveBackendUsageCounters = {};
  for (const field of BACKEND_USAGE_FIELDS) {
    const candidate = flat[field];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      picked[field] = candidate;
    }
  }
  return picked;
}
export interface LiveUsageState {
  seconds: number | null;
  contextUsageRatio: number | null;
  finalized: boolean;
  finalizationMissing: boolean;
  backend: readonly LiveBackendUsage[];
}
export const createUsageState = (): LiveUsageState => ({
  seconds: null,
  contextUsageRatio: null,
  finalized: false,
  finalizationMissing: false,
  backend: [],
});
export function reduceUsage(
  state: LiveUsageState,
  event: LiveServerEvent
): LiveUsageState {
  if (event.type === "session.closed")
    return state.finalized
      ? state
      : {
          ...state,
          seconds: event.usage.seconds,
          finalized: true,
          finalizationMissing: false,
        };
  if (event.type === "session.usage.updated" && !state.finalized) {
    // Cumulative duration is monotonic: an older replay must not reduce the bill.
    if (state.seconds !== null && event.usage.seconds < state.seconds)
      return state;
    return {
      ...state,
      seconds: event.usage.seconds,
      contextUsageRatio:
        event.context_window?.usage_ratio ?? state.contextUsageRatio,
    };
  }
  if (
    event.type === "response.event" &&
    ["response.completed", "response.failed", "response.incomplete"].includes(
      event.event.type
    )
  ) {
    const response = event.event.response;
    if (object(response) && string(response.id) && object(response.usage)) {
      const entry: LiveBackendUsage = {
        delegationId: event.delegation_id ?? null,
        responseId: response.id,
        usage: pickBackendUsage(response.usage),
      };
      return {
        ...state,
        backend: [
          ...state.backend.filter(
            (previous) =>
              previous.responseId !== entry.responseId ||
              previous.delegationId !== entry.delegationId
          ),
          entry,
        ],
      };
    }
  }
  return state;
}
/** Call on transport loss OR local finalization timeout, even on a normal close code. */
export function markUsageTransportEnded(state: LiveUsageState): LiveUsageState {
  return state.finalized ? state : { ...state, finalizationMissing: true };
}

export type LiveTranscriptSpeaker = "user" | "assistant";
export interface LiveTranscriptFragment {
  eventId: string;
  delta: string;
  startMs: number;
  endMs: number;
}
export interface LiveTranscriptGroup {
  id: string;
  speaker: LiveTranscriptSpeaker;
  fromMs: number;
  toMs: number | null;
  text: string;
  fragments: readonly LiveTranscriptFragment[];
}
export interface LiveTranscriptState {
  sessionId: string;
  nextId: number;
  groups: readonly LiveTranscriptGroup[];
  seenEventIds: readonly string[];
}
export const createTranscriptState = (
  sessionId: string
): LiveTranscriptState => ({
  sessionId,
  nextId: 1,
  groups: [],
  seenEventIds: [],
});

/**
 * Explicit display boundary (e.g. observed interruption/resumption), NEVER a timer
 * or inferred turn end. Stable rows remain upsert targets, including after splits.
 * The default is one ongoing row per speaker; consumers need not invent boundaries.
 */
export function splitTranscriptGroup(
  state: LiveTranscriptState,
  speaker: LiveTranscriptSpeaker,
  atMs: number
): LiveTranscriptState {
  if (!number(atMs)) return state;
  const group = state.groups.find(
    (candidate) =>
      candidate.speaker === speaker &&
      candidate.fromMs < atMs &&
      (candidate.toMs === null || atMs < candidate.toMs)
  );
  if (!group) return state;
  const earlier = group.fragments.filter((fragment) => fragment.startMs < atMs);
  const later = group.fragments.filter((fragment) => fragment.startMs >= atMs);
  const newGroup: LiveTranscriptGroup = {
    id: `${state.sessionId}:${speaker}:${state.nextId}`,
    speaker,
    fromMs: atMs,
    toMs: group.toMs,
    fragments: later,
    text: later.map((fragment) => fragment.delta).join(""),
  };
  return {
    ...state,
    nextId: state.nextId + 1,
    groups: [
      ...state.groups.map((candidate) =>
        candidate === group
          ? {
              ...group,
              toMs: atMs,
              fragments: earlier,
              text: earlier.map((fragment) => fragment.delta).join(""),
            }
          : candidate
      ),
      newGroup,
    ],
  };
}

/** Upsert groups by id; never persist every returned snapshot as a new utterance. */
export function reduceTranscript(
  state: LiveTranscriptState,
  event: LiveTranscriptDeltaEvent
): LiveTranscriptState {
  if (state.seenEventIds.includes(event.event_id)) return state;
  const speaker: LiveTranscriptSpeaker =
    event.type === "session.input_transcript.delta" ? "user" : "assistant";
  const fragment: LiveTranscriptFragment = {
    eventId: event.event_id,
    delta: event.delta,
    startMs: event.start_ms,
    endMs: event.end_ms,
  };
  const group = state.groups.find(
    (candidate) =>
      candidate.speaker === speaker &&
      candidate.fromMs <= event.start_ms &&
      (candidate.toMs === null || event.start_ms < candidate.toMs)
  );
  const seenEventIds = [...state.seenEventIds, event.event_id];
  if (group)
    return {
      ...state,
      seenEventIds,
      groups: state.groups.map((candidate) =>
        candidate === group
          ? {
              ...group,
              text: group.text + event.delta,
              fragments: [...group.fragments, fragment],
            }
          : candidate
      ),
    };
  return {
    ...state,
    seenEventIds,
    nextId: state.nextId + 1,
    groups: [
      ...state.groups,
      {
        id: `${state.sessionId}:${speaker}:${state.nextId}`,
        speaker,
        fromMs: 0,
        toMs: null,
        text: event.delta,
        fragments: [fragment],
      },
    ],
  };
}
