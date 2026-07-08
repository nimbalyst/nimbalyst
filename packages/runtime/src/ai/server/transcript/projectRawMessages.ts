/**
 * projectRawMessages -- client-side transcript projection for mobile clients.
 *
 * Mobile clients (iOS/Android WKWebView bundles) receive raw ai_agent_messages
 * via sync but do not have the canonical ai_transcript_events table that
 * desktop builds via TranscriptTransformer. This module runs the same parser
 * pipeline in memory so the mobile transcript renderer produces identical
 * output to desktop.
 *
 * Pipeline: raw messages -> per-provider parser -> descriptors ->
 * processDescriptor -> in-memory event store -> TranscriptProjector ->
 * TranscriptViewMessage[].
 */

import { TranscriptWriter } from './TranscriptWriter';
import { TranscriptProjector, type TranscriptViewMessage } from './TranscriptProjector';
import { InMemoryTranscriptEventStore } from './InMemoryTranscriptEventStore';
import { ClaudeCodeRawParser } from './parsers/ClaudeCodeRawParser';
import { CodexRawParserDispatcher } from './parsers/CodexRawParserDispatcher';
import { CodexACPRawParser } from './parsers/CodexACPRawParser';
import { CopilotRawParser } from './parsers/CopilotRawParser';
import { OpenCodeRawParser } from './parsers/OpenCodeRawParser';
import { VoiceRawParser } from './parsers/VoiceRawParser';
import type { IRawMessageParser, ParseContext } from './parsers/IRawMessageParser';
import type { RawMessage } from './TranscriptTransformer';
import type { TranscriptEvent } from './types';
import { processDescriptor, selectRawParser } from './processDescriptor';

function createParser(provider: string): IRawMessageParser {
  const kind = selectRawParser(provider);
  // Codex has two transports (SDK / app-server) with different output shapes;
  // route per-message via the same dispatcher the server-side transformer uses,
  // otherwise app-server sessions parse with the SDK parser and silently drop
  // every assistant/tool event (the catch in rawMessagesToCanonicalEvents
  // swallows the resulting parse errors, leaving only user prompts visible).
  if (kind === 'codex') return new CodexRawParserDispatcher();
  if (kind === 'codex-acp') return new CodexACPRawParser();
  if (kind === 'copilot') return new CopilotRawParser();
  if (kind === 'opencode') return new OpenCodeRawParser();
  if (kind === 'voice') return new VoiceRawParser();
  return new ClaudeCodeRawParser();
}

/**
 * Parse raw messages into canonical TranscriptEvents in memory.
 * Pure function: no DB, no side effects.
 */
export async function rawMessagesToCanonicalEvents(
  rawMessages: RawMessage[],
  provider: string,
): Promise<TranscriptEvent[]> {
  if (rawMessages.length === 0) return [];

  const sessionId = rawMessages[0].sessionId;
  const store = new InMemoryTranscriptEventStore();
  const writer = new TranscriptWriter(store, provider);
  const parser = createParser(provider);

  writer.seedSequence(1);
  const toolEventIds = new Map<string, number>();
  const subagentEventIds = new Map<string, number>();

  const context: ParseContext = {
    sessionId,
    hasToolCall: (id: string) => toolEventIds.has(id),
    hasSubagent: (id: string) => subagentEventIds.has(id),
    findByProviderToolCallId: (id: string) =>
      store.findByProviderToolCallId(id, sessionId),
    findActiveToolCallByRawProviderId: (rawId: string) =>
      store.findActiveToolCallByRawProviderId(rawId, sessionId),
  };

  for (const msg of rawMessages) {
    try {
      const descriptors = await parser.parseMessage(msg, context);
      for (const desc of descriptors) {
        await processDescriptor(
          writer,
          store,
          msg.sessionId,
          desc,
          toolEventIds,
          subagentEventIds,
        );
      }
    } catch {
      // Skip unparseable messages -- matches server-side transformer behavior
    }
  }

  return store.getAllEvents();
}

/**
 * Parse raw messages and project them to the view model the transcript
 * renderer consumes. Client-side equivalent of desktop's
 * TranscriptProjector.project(events) pipeline.
 */
export async function projectRawMessagesToViewMessages(
  rawMessages: RawMessage[],
  provider: string,
): Promise<TranscriptViewMessage[]> {
  const events = await rawMessagesToCanonicalEvents(rawMessages, provider);
  return TranscriptProjector.project(events).messages;
}
