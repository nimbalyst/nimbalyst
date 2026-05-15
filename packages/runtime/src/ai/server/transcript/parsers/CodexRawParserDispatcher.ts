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
    const transport = msg.metadata?.transport;
    if (transport === 'app-server') {
      return this.appServerParser.parseMessage(msg, context);
    }
    return this.sdkParser.parseMessage(msg, context);
  }
}
