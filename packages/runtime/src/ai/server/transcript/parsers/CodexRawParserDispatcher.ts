/**
 * CodexRawParserDispatcher -- per-message dispatcher between the two codex
 * transports' raw parsers.
 *
 * Each codex raw message is tagged at write time with `metadata.transport`
 * (set by `OpenAICodexProvider.storeRawEventIfPresent`):
 *   - undefined / 'sdk' -> SDK exec transport -> CodexRawParser
 *   - 'app-server'      -> app-server transport -> CodexAppServerRawParser
 *
 * The dispatcher holds one instance of each parser so per-batch in-flight maps
 * (synthetic edit-group ID tracking) survive across messages within a batch.
 * `TranscriptTransformer.CURRENT_VERSION` is NOT bumped -- old sessions stay
 * on the SDK parser, new sessions use the app-server parser. See the migration
 * plan for rationale.
 */

import type { RawMessage } from '../TranscriptTransformer';
import type { IRawMessageParser, ParseContext, CanonicalEventDescriptor } from './IRawMessageParser';
import { CodexRawParser } from './CodexRawParser';
import { CodexAppServerRawParser } from './CodexAppServerRawParser';

export class CodexRawParserDispatcher implements IRawMessageParser {
  private readonly sdkParser = new CodexRawParser();
  private readonly appServerParser = new CodexAppServerRawParser();

  async parseMessage(msg: RawMessage, context: ParseContext): Promise<CanonicalEventDescriptor[]> {
    if (msg.hidden) return [];

    const syntheticToolResult = await this.parseNimbalystToolResult(msg, context);
    if (syntheticToolResult) {
      return [syntheticToolResult];
    }

    const transport = msg.metadata?.transport;
    if (transport === 'app-server') {
      return this.appServerParser.parseMessage(msg, context);
    }
    return this.sdkParser.parseMessage(msg, context);
  }

  private async parseNimbalystToolResult(
    msg: RawMessage,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor | null> {
    if (!msg.content.includes('nimbalyst_tool_result')) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (record.type !== 'nimbalyst_tool_result') return null;

    const rawToolUseId =
      typeof record.tool_use_id === 'string'
        ? record.tool_use_id
        : typeof record.id === 'string'
          ? record.id
          : null;
    if (!rawToolUseId) return null;

    let providerToolCallId = rawToolUseId;
    try {
      const existing = await context.findActiveToolCallByRawProviderId(rawToolUseId);
      if (existing?.providerToolCallId) {
        providerToolCallId = existing.providerToolCallId;
      }
    } catch {
      // If alias lookup fails, fall back to the raw id. Existing exact-id
      // matching still handles SDK-style Codex rows.
    }

    const result = record.result;
    const resultText =
      typeof result === 'string'
        ? result
        : result == null
          ? ''
          : JSON.stringify(result);
    const isError = record.is_error === true;

    return {
      type: 'tool_call_completed',
      providerToolCallId,
      status: isError ? 'error' : 'completed',
      result: resultText,
      isError,
    };
  }
}
