/**
 * TranscriptWriter -- shared service for writing canonical transcript events.
 *
 * Provider adapters call this to produce canonical events. It owns sequence
 * assignment, searchable flag decisions, and stateful row updates.
 */

import type {
  ITranscriptEventStore,
  TranscriptEvent,
  TranscriptEventType,
  UserMessagePayload,
  AssistantMessagePayload,
  SystemMessagePayload,
  ToolCallPayload,
  ToolProgressPayload,
  InteractivePromptPayload,
  SubagentPayload,
  TurnEndedPayload,
} from './types';

export class TranscriptWriter {
  private seededSequence: number | null = null;

  // Tracks the most recently written canonical event for the current session
  // so streaming assistant_message chunks can be coalesced into a single row
  // instead of producing one event per token. Loaded lazily from the store on
  // the first call so we coalesce across batches (each `processNewMessages`
  // call constructs a fresh writer).
  private lastEventBySession = new Map<string, LastEventState | null>();

  constructor(
    private store: ITranscriptEventStore,
    private provider: string,
  ) {}

  /**
   * Seed the in-memory sequence counter for bulk operations.
   * When seeded, insertEvent uses and increments the counter instead of
   * querying the DB each time. Safe during single-threaded bulk transforms.
   */
  seedSequence(startSequence: number): void {
    this.seededSequence = startSequence;
  }

  // ---------------------------------------------------------------------------
  // Message events (non-stateful)
  // ---------------------------------------------------------------------------

  async appendUserMessage(
    sessionId: string,
    text: string,
    options?: {
      mode?: 'agent' | 'planning' | 'auto';
      inputType?: 'user' | 'system_message';
      attachments?: UserMessagePayload['attachments'];
      createdAt?: Date;
    },
  ): Promise<TranscriptEvent> {
    const payload: UserMessagePayload = {
      mode: options?.mode ?? 'agent',
      inputType: options?.inputType ?? 'user',
      ...(options?.attachments ? { attachments: options.attachments } : {}),
    };

    return this.insertEvent(sessionId, {
      eventType: 'user_message',
      searchableText: text,
      searchable: true,
      payload: payload as unknown as Record<string, unknown>,
      createdAt: options?.createdAt,
    });
  }

  async appendAssistantMessage(
    sessionId: string,
    text: string,
    options?: {
      mode?: 'agent' | 'planning' | 'auto';
      createdAt?: Date;
      thinking?: string;
      thinkingSignature?: string;
      model?: string;
    },
  ): Promise<TranscriptEvent> {
    const mode = options?.mode ?? 'agent';
    const hasExtras =
      options?.thinking !== undefined ||
      options?.thinkingSignature !== undefined ||
      options?.model !== undefined;

    // Coalesce streaming chunks: if the previous event in this session is
    // also an assistant_message with the same mode/subagent, append to it
    // rather than inserting a new row. ACP and similar streaming protocols
    // emit one chunk per token; without this we'd persist thousands of
    // single-token events per session.
    //
    // Skip coalescing when the new chunk carries thinking/model metadata --
    // those need to land on their own event so the renderer can place them
    // in the correct part of the turn.
    const last = hasExtras ? null : await this.loadLastEvent(sessionId);
    if (
      last &&
      last.eventType === 'assistant_message' &&
      last.subagentId === null &&
      last.mode === mode
    ) {
      const mergedText = (last.searchableText ?? '') + text;
      await this.store.updateEventText(last.id, mergedText);
      last.searchableText = mergedText;
      const refreshed = await this.store.getEventById(last.id);
      return refreshed ?? this.toTranscriptEvent(sessionId, last);
    }

    const payload: AssistantMessagePayload = {
      mode,
      ...(options?.thinking !== undefined ? { thinking: options.thinking } : {}),
      ...(options?.thinkingSignature !== undefined
        ? { thinkingSignature: options.thinkingSignature }
        : {}),
      ...(options?.model !== undefined ? { model: options.model } : {}),
    };

    return this.insertEvent(sessionId, {
      eventType: 'assistant_message',
      searchableText: text,
      searchable: true,
      payload: payload as unknown as Record<string, unknown>,
      createdAt: options?.createdAt,
    });
  }

  async appendSystemMessage(
    sessionId: string,
    text: string,
    options?: {
      systemType?: SystemMessagePayload['systemType'];
      statusCode?: string;
      isAuthError?: boolean;
      reminderKind?: string;
      deniedToolName?: string;
      deniedReason?: string;
      deniedReasonType?: string;
      deniedInput?: Record<string, unknown>;
      searchable?: boolean;
      createdAt?: Date;
    },
  ): Promise<TranscriptEvent> {
    const payload: SystemMessagePayload = {
      systemType: options?.systemType ?? 'status',
      ...(options?.statusCode ? { statusCode: options.statusCode } : {}),
      ...(options?.isAuthError ? { isAuthError: true } : {}),
      ...(options?.reminderKind ? { reminderKind: options.reminderKind } : {}),
      ...(options?.deniedToolName ? { deniedToolName: options.deniedToolName } : {}),
      ...(options?.deniedReason ? { deniedReason: options.deniedReason } : {}),
      ...(options?.deniedReasonType ? { deniedReasonType: options.deniedReasonType } : {}),
      ...(options?.deniedInput ? { deniedInput: options.deniedInput } : {}),
    };

    return this.insertEvent(sessionId, {
      eventType: 'system_message',
      searchableText: text,
      searchable: options?.searchable ?? true,
      payload: payload as unknown as Record<string, unknown>,
      createdAt: options?.createdAt,
    });
  }

  // ---------------------------------------------------------------------------
  // Tool call events (stateful -- create then update)
  // ---------------------------------------------------------------------------

  async createToolCall(
    sessionId: string,
    params: {
      toolName: string;
      toolDisplayName: string;
      description?: string | null;
      arguments: Record<string, unknown>;
      targetFilePath?: string | null;
      mcpServer?: string | null;
      mcpTool?: string | null;
      providerToolCallId?: string | null;
      subagentId?: string | null;
      createdAt?: Date;
    },
  ): Promise<TranscriptEvent> {
    const payload: ToolCallPayload = {
      toolName: params.toolName,
      toolDisplayName: params.toolDisplayName,
      status: 'running',
      description: params.description ?? null,
      arguments: params.arguments,
      targetFilePath: params.targetFilePath ?? null,
      mcpServer: params.mcpServer ?? null,
      mcpTool: params.mcpTool ?? null,
    };

    return this.insertEvent(sessionId, {
      eventType: 'tool_call',
      searchableText: null,
      searchable: false,
      payload: payload as unknown as Record<string, unknown>,
      providerToolCallId: params.providerToolCallId ?? null,
      subagentId: params.subagentId ?? null,
      createdAt: params.createdAt,
    });
  }

  async updateToolCall(
    eventId: number,
    update: {
      status: 'completed' | 'error';
      result?: string;
      isError?: boolean;
      exitCode?: number;
      durationMs?: number;
      changes?: Array<{ path: string; patch: string }>;
    },
  ): Promise<void> {
    const existing = await this.store.getEventById(eventId);
    if (!existing) {
      throw new Error(`TranscriptWriter: event ${eventId} not found`);
    }
    await this.store.mergeEventPayload(eventId, update as unknown as Record<string, unknown>);
  }

  async appendToolProgress(
    sessionId: string,
    params: {
      parentEventId: number;
      toolName: string;
      elapsedSeconds: number;
      progressContent: string;
      subagentId?: string | null;
      createdAt?: Date;
    },
  ): Promise<TranscriptEvent> {
    const payload: ToolProgressPayload = {
      toolName: params.toolName,
      elapsedSeconds: params.elapsedSeconds,
      progressContent: params.progressContent,
    };

    return this.insertEvent(sessionId, {
      eventType: 'tool_progress',
      searchableText: null,
      searchable: false,
      payload: payload as unknown as Record<string, unknown>,
      parentEventId: params.parentEventId,
      subagentId: params.subagentId ?? null,
      createdAt: params.createdAt,
    });
  }

  // ---------------------------------------------------------------------------
  // Interactive prompt events (stateful -- create then update)
  // ---------------------------------------------------------------------------

  async createInteractivePrompt(
    sessionId: string,
    payload: InteractivePromptPayload,
    options?: {
      subagentId?: string | null;
      createdAt?: Date;
    },
  ): Promise<TranscriptEvent> {
    return this.insertEvent(sessionId, {
      eventType: 'interactive_prompt',
      searchableText: null,
      searchable: false,
      payload: payload as unknown as Record<string, unknown>,
      subagentId: options?.subagentId ?? null,
      createdAt: options?.createdAt,
    });
  }

  async updateInteractivePrompt(
    eventId: number,
    update: Partial<InteractivePromptPayload>,
  ): Promise<void> {
    const existing = await this.store.getEventById(eventId);
    if (!existing) {
      throw new Error(`TranscriptWriter: event ${eventId} not found`);
    }
    await this.store.mergeEventPayload(eventId, update as unknown as Record<string, unknown>);
  }

  // ---------------------------------------------------------------------------
  // Subagent events (stateful -- create then update)
  // ---------------------------------------------------------------------------

  async createSubagent(
    sessionId: string,
    params: {
      subagentId: string;
      agentType: string;
      teammateName?: string | null;
      teamName?: string | null;
      teammateMode?: string | null;
      model?: string | null;
      reasoningEffort?: string | null;
      color?: string | null;
      isBackground?: boolean;
      prompt: string;
      createdAt?: Date;
    },
  ): Promise<TranscriptEvent> {
    const payload: SubagentPayload = {
      agentType: params.agentType,
      status: 'running',
      teammateName: params.teammateName ?? null,
      teamName: params.teamName ?? null,
      teammateMode: params.teammateMode ?? null,
      model: params.model ?? null,
      reasoningEffort: params.reasoningEffort ?? null,
      color: params.color ?? null,
      isBackground: params.isBackground ?? false,
      prompt: params.prompt,
    };

    return this.insertEvent(sessionId, {
      eventType: 'subagent',
      searchableText: null,
      searchable: false,
      payload: payload as unknown as Record<string, unknown>,
      subagentId: params.subagentId,
      createdAt: params.createdAt,
    });
  }

  async updateSubagent(
    eventId: number,
    update: {
      status: 'completed';
      resultSummary?: string;
      toolCallCount?: number;
      durationMs?: number;
      model?: string | null;
      reasoningEffort?: string | null;
    },
  ): Promise<void> {
    const existing = await this.store.getEventById(eventId);
    if (!existing) {
      throw new Error(`TranscriptWriter: event ${eventId} not found`);
    }
    await this.store.mergeEventPayload(eventId, {
      status: update.status,
      ...(update.resultSummary !== undefined ? { resultSummary: update.resultSummary } : {}),
      ...(update.toolCallCount !== undefined ? { toolCallCount: update.toolCallCount } : {}),
      ...(update.durationMs !== undefined ? { durationMs: update.durationMs } : {}),
      ...(update.model !== undefined ? { model: update.model } : {}),
      ...(update.reasoningEffort !== undefined ? { reasoningEffort: update.reasoningEffort } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Turn boundary
  // ---------------------------------------------------------------------------

  async recordTurnEnded(
    sessionId: string,
    params: {
      contextFill: TurnEndedPayload['contextFill'];
      contextWindow: number;
      cumulativeUsage: TurnEndedPayload['cumulativeUsage'];
      contextCompacted?: boolean;
      subagentId?: string | null;
      createdAt?: Date;
    },
  ): Promise<TranscriptEvent> {
    const payload: TurnEndedPayload = {
      contextFill: params.contextFill,
      contextWindow: params.contextWindow,
      cumulativeUsage: params.cumulativeUsage,
      contextCompacted: params.contextCompacted ?? false,
    };

    return this.insertEvent(sessionId, {
      eventType: 'turn_ended',
      searchableText: null,
      searchable: false,
      payload: payload as unknown as Record<string, unknown>,
      subagentId: params.subagentId ?? null,
      createdAt: params.createdAt,
    });
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async insertEvent(
    sessionId: string,
    fields: {
      eventType: TranscriptEventType;
      searchableText: string | null;
      searchable: boolean;
      payload: Record<string, unknown>;
      parentEventId?: number | null;
      providerToolCallId?: string | null;
      subagentId?: string | null;
      createdAt?: Date;
    },
  ): Promise<TranscriptEvent> {
    // When seeded (bulk transform), use in-memory counter to avoid N round-trips.
    // Otherwise query DB for safe concurrent writes.
    let sequence: number;
    if (this.seededSequence != null) {
      sequence = this.seededSequence++;
    } else {
      sequence = await this.store.getNextSequence(sessionId);
    }

    const event = await this.store.insertEvent({
      sessionId,
      sequence,
      createdAt: fields.createdAt ?? new Date(),
      eventType: fields.eventType,
      searchableText: fields.searchableText,
      searchable: fields.searchable,
      payload: fields.payload,
      parentEventId: fields.parentEventId ?? null,
      subagentId: fields.subagentId ?? null,
      provider: this.provider,
      providerToolCallId: fields.providerToolCallId ?? null,
    });

    // Refresh the coalesce-anchor for this session so the next call sees
    // whatever we just wrote (including non-assistant events that should
    // break the assistant_message coalesce chain).
    this.lastEventBySession.set(sessionId, {
      id: event.id,
      eventType: event.eventType,
      searchableText: event.searchableText,
      mode: (event.payload as { mode?: 'agent' | 'planning' })?.mode,
      subagentId: event.subagentId,
    });

    return event;
  }

  private async loadLastEvent(sessionId: string): Promise<LastEventState | null> {
    if (this.lastEventBySession.has(sessionId)) {
      return this.lastEventBySession.get(sessionId) ?? null;
    }

    const tail = await this.store.getTailEvents(sessionId, 1);
    const event = tail[tail.length - 1] ?? null;
    const state: LastEventState | null = event
      ? {
          id: event.id,
          eventType: event.eventType,
          searchableText: event.searchableText,
          mode: (event.payload as { mode?: 'agent' | 'planning' })?.mode,
          subagentId: event.subagentId,
        }
      : null;
    this.lastEventBySession.set(sessionId, state);
    return state;
  }

  private toTranscriptEvent(sessionId: string, state: LastEventState): TranscriptEvent {
    // Fallback used only when the store can't return the refreshed event.
    return {
      id: state.id,
      sessionId,
      sequence: 0,
      createdAt: new Date(),
      eventType: state.eventType,
      searchableText: state.searchableText,
      searchable: true,
      payload: { mode: state.mode } as Record<string, unknown>,
      parentEventId: null,
      subagentId: state.subagentId,
      provider: this.provider,
      providerToolCallId: null,
    };
  }
}

interface LastEventState {
  id: number;
  eventType: TranscriptEventType;
  searchableText: string | null;
  mode: 'agent' | 'planning' | 'auto' | undefined;
  subagentId: string | null;
}
