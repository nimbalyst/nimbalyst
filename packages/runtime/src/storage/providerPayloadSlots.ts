/**
 * providerPayloadSlots -- the single place that knows WHERE a provider chunk
 * keeps its heavy payloads.
 *
 * Three passes shrink agent messages, each with a different policy:
 *
 *   - `syncContentTruncator`           elide to a marker so a message fits the
 *                                      mobile sync ceiling
 *   - `slimClaudeCodeChunkForStorage`  drop dead weight at write time
 *   - `toolOutputRetention`            tombstone aged output to reclaim disk
 *
 * They each used to carry their own idea of the chunk shape, and they drifted.
 * The retention rewriter -- the newest of the three -- never learned about the
 * top-level `tool_use_result` sidecar (71% of claude-code tool-row bytes on the
 * measured install) and its codex matcher required `$.params.item`, a path that
 * zero of 4,000 sampled codex rows actually use. The result was a reclaim pass
 * that reported 0 bytes against 1,020,087 candidate rows while ~2.5 GB sat in
 * slots it could not see. See NIM-3661.
 *
 * This module holds the shape knowledge once. Policy stays with each caller:
 * a slot says "there is a payload here", not "delete it".
 *
 * ## Mutation
 *
 * `set()` writes THROUGH to the chunk the slot was built from. Callers that
 * must not mutate their input clone first -- `tombstoneClaudeCodeChunk` does.
 *
 * ## Surgical vs broad
 *
 * Two deliberately different strategies, matching what the sync truncator
 * already settled on:
 *
 *   - `tool_use_result` and MCP `result` objects are walked BROADLY (every
 *     key), because every field on them is duplicate or derived state that no
 *     transcript consumer reads.
 *   - codex `item` and ACP `rawOutput` are walked SURGICALLY (named output
 *     fields only), because those records interleave payload with forensics --
 *     `command`, `cwd`, `exit_code`, `call_id` -- that must survive so the tool
 *     card can still say what ran.
 */
import { isImageBlock } from '../utils/contentBytes';

export type PayloadSlotKind =
  /** `message.content[i].content`, as a string or a text block within an array. */
  | 'claudeToolResult'
  /**
   * A whole image block inside a tool result's content array (claude
   * `message.content[i].content[j]`, codex `item.result.content[j]`). Its own
   * kind because an image is replaced as a block, not as a string, and so a
   * caller has to opt in by kind rather than receive it as ordinary output.
   */
  | 'toolResultImage'
  /**
   * `tool_use_result.<key>` -- the Edit/Write/Read sidecar. When the sidecar is
   * an array or a string (the MCP tool-result copy) the slot is the whole
   * `tool_use_result`.
   */
  | 'claudeToolUseResult'
  /** `message.content[i].signature` on a thinking block (~12 KB of base64). */
  | 'claudeThinkingSignature'
  /** `(item | params.item).<aggregated_output | output | ...>`. */
  | 'codexItemField'
  /** `(item | params.item).result`, or a key/text block within it. */
  | 'codexItemResult'
  /** `update.rawOutput.<stdout | stderr | ...>` on the ACP transport. */
  | 'acpRawOutput'
  /** Top-level `result` on Nimbalyst's own tool-result envelope. */
  | 'nimbalystToolResult'
  /** Whole-file or command output on a headless-agent tool result. */
  | 'headlessAgentToolResult'
  /** `result`, and the written body in `args.content`, on a Gemini tool row. */
  | 'geminiToolRow';

export interface PayloadSlot {
  /** Stable dotted path, for diagnostics and test assertions. */
  readonly path: string;
  readonly kind: PayloadSlotKind;
  /** Current value at this slot. Reads through to the chunk. */
  readonly value: unknown;
  /** Replace the value. Mutates the chunk this slot was built from. */
  set(next: unknown): void;
}

function makeSlot(
  kind: PayloadSlotKind,
  path: string,
  container: Record<string | number, unknown>,
  key: string | number,
): PayloadSlot {
  return {
    kind,
    path,
    get value() {
      return container[key];
    },
    set(next: unknown) {
      container[key] = next;
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isTextBlock(v: unknown): v is Record<string, unknown> & { text: string } {
  return isPlainObject(v) && v.type === 'text' && typeof v.text === 'string';
}

// ---------------------------------------------------------------------------
// claude-code
// ---------------------------------------------------------------------------

function collectClaudeSlots(chunk: Record<string, unknown>, out: PayloadSlot[]): void {
  const message = chunk.message;
  if (isPlainObject(message) && Array.isArray(message.content)) {
    (message.content as unknown[]).forEach((block, i) => {
      if (!isPlainObject(block)) return;

      if (block.type === 'thinking' && typeof block.signature === 'string' && block.signature.length > 0) {
        out.push(makeSlot('claudeThinkingSignature', `message.content[${i}].signature`, block, 'signature'));
        return;
      }

      if (block.type !== 'tool_result') return;

      const content = block.content;
      if (typeof content === 'string') {
        out.push(makeSlot('claudeToolResult', `message.content[${i}].content`, block, 'content'));
        return;
      }
      if (!Array.isArray(content)) return;

      (content as unknown[]).forEach((item, j) => {
        // Offered under its own kind. Aged screenshots were 600 MB of one
        // measured install (2,005 blocks, 314 KB average), kept forever
        // because this used to offer no slot for them at all.
        if (isImageBlock(item)) {
          out.push(makeSlot(
            'toolResultImage',
            `message.content[${i}].content[${j}]`,
            content as unknown as Record<number, unknown>,
            j,
          ));
          return;
        }
        if (isTextBlock(item)) {
          out.push(makeSlot(
            'claudeToolResult',
            `message.content[${i}].content[${j}].text`,
            item as Record<string, unknown>,
            'text',
          ));
        }
      });
    });
  }

  // The sidecar that started all this: a sibling of `message`, holding the
  // entire pre-edit file plus a duplicate of the edit already recorded on the
  // tool_use CALL. Walked broadly -- nothing here is read by the transcript.
  const tur = chunk.tool_use_result;
  if (isPlainObject(tur)) {
    for (const key of Object.keys(tur)) {
      out.push(makeSlot('claudeToolUseResult', `tool_use_result.${key}`, tur, key));
    }
  } else if (Array.isArray(tur) || typeof tur === 'string') {
    // The MCP form: a second copy of the result's content array (or text).
    // Rows written before the write path learned to drop it still carry the
    // screenshot twice. One slot for the whole value.
    out.push(makeSlot('claudeToolUseResult', 'tool_use_result', chunk, 'tool_use_result'));
  }
}

// ---------------------------------------------------------------------------
// codex (app-server, SDK events, and the ACP transport)
// ---------------------------------------------------------------------------

/**
 * Payload fields on a codex `item`. Named rather than walked broadly because
 * an item interleaves output with the forensics the tool card renders.
 * Both casings are live: SDK events use snake_case, app-server uses camelCase.
 */
const CODEX_ITEM_OUTPUT_FIELDS = ['aggregated_output', 'aggregatedOutput', 'output'] as const;

/** Payload fields inside an ACP `update.rawOutput` record. */
const ACP_OUTPUT_FIELDS = ['stdout', 'stderr', 'output', 'aggregated_output', 'aggregatedOutput'] as const;

function collectCodexSlots(chunk: Record<string, unknown>, out: PayloadSlot[]): void {
  // `{type:'item.completed', item}` (SDK events, the common shape on disk) and
  // `{method, params:{item}}` (app-server) are both live. The retention pass
  // used to accept only the second, which matched nothing.
  const params = chunk.params;
  const item = chunk.item ?? (isPlainObject(params) ? params.item : undefined);
  const itemPath = chunk.item !== undefined ? 'item' : 'params.item';

  if (isPlainObject(item)) {
    for (const field of CODEX_ITEM_OUTPUT_FIELDS) {
      if (field in item) {
        out.push(makeSlot('codexItemField', `${itemPath}.${field}`, item, field));
      }
    }

    const result = item.result;
    if (typeof result === 'string') {
      out.push(makeSlot('codexItemResult', `${itemPath}.result`, item, 'result'));
    } else if (isPlainObject(result)) {
      if (Array.isArray(result.content)) {
        (result.content as unknown[]).forEach((block, j) => {
          if (isImageBlock(block)) {
            out.push(makeSlot(
              'toolResultImage',
              `${itemPath}.result.content[${j}]`,
              result.content as unknown as Record<number, unknown>,
              j,
            ));
            return;
          }
          if (isTextBlock(block)) {
            out.push(makeSlot(
              'codexItemResult',
              `${itemPath}.result.content[${j}].text`,
              block as Record<string, unknown>,
              'text',
            ));
          }
        });
      } else {
        // A structured MCP result. Walked broadly -- same reasoning as the
        // claude sidecar: the transcript renders the call, not this.
        for (const key of Object.keys(result)) {
          out.push(makeSlot('codexItemResult', `${itemPath}.result.${key}`, result, key));
        }
      }
    }
  }

  // ACP: `{type:'session/update', update:{rawOutput:{... stdout}}}`.
  const update = chunk.update;
  if (!isPlainObject(update)) return;
  const rawOutput = update.rawOutput;

  if (typeof rawOutput === 'string') {
    out.push(makeSlot('acpRawOutput', 'update.rawOutput', update, 'rawOutput'));
    return;
  }
  if (!isPlainObject(rawOutput)) return;

  for (const field of ACP_OUTPUT_FIELDS) {
    if (field in rawOutput) {
      out.push(makeSlot('acpRawOutput', `update.rawOutput.${field}`, rawOutput, field));
    }
  }
}

// ---------------------------------------------------------------------------
// Nimbalyst's own envelope -- appears under BOTH claude-code and codex sources
// ---------------------------------------------------------------------------

function collectNimbalystSlots(chunk: Record<string, unknown>, out: PayloadSlot[]): void {
  if (chunk.type === 'nimbalyst_tool_result' && 'result' in chunk) {
    out.push(makeSlot('nimbalystToolResult', 'result', chunk, 'result'));
  }
  // `nimbalyst_tool_use` is a tool CALL -- name and arguments. Never a slot.
}

/**
 * Heavy payloads on a headless-agent record.
 *
 * These are the fields that carry whole files: Cursor's edit results embed the
 * complete before and after contents of the file it changed (and a deleted
 * file's entire previous contents), and Grok's `rawOutput` carries a read
 * file's text plus a shell command's stdout as a byte array. Left unwalked,
 * one large-file edit can push a single row past the row budget.
 *
 * Trimming these is safe for file tracking: the pre-edit baseline is captured
 * into a history tag while the turn streams, not read back out of the raw row
 * afterwards. What the raw row still owes is the transcript rendering, and a
 * clamped tool result renders the same as Codex's does.
 */
/**
 * Gemini's tool row: `{name, args, result}`.
 *
 * Two slots, and both matter. `result` is a whole file read or a directory
 * listing; `args.content` is the entire body of a `write_file`, which is the
 * larger of the two on any real edit. Without these the truncator has no
 * shrinkable slot and has to elide the whole row, which costs mobile the tool
 * card rather than just its payload.
 */
function collectGeminiSlots(chunk: Record<string, unknown>, out: PayloadSlot[]): void {
  if ('result' in chunk) {
    out.push(makeSlot('geminiToolRow', 'result', chunk, 'result'));
  }
  const args = chunk.args;
  if (isPlainObject(args) && 'content' in args) {
    out.push(makeSlot('geminiToolRow', 'args.content', args, 'content'));
  }
}

function collectHeadlessAgentSlots(chunk: Record<string, unknown>, out: PayloadSlot[]): void {
  // Grok: {type:'tool_call_update', rawOutput:{...}}
  const rawOutput = chunk.rawOutput;
  if (isPlainObject(rawOutput)) {
    for (const key of ['content', 'content_concise', 'raw_output', 'output', 'output_for_prompt'] as const) {
      if (key in rawOutput) {
        out.push(makeSlot('headlessAgentToolResult', `rawOutput.${key}`, rawOutput, key));
      }
    }
    const fileContent = rawOutput.FileContent;
    if (isPlainObject(fileContent)) {
      for (const key of ['content', 'content_concise', 'raw_output'] as const) {
        if (key in fileContent) {
          out.push(makeSlot('headlessAgentToolResult', `rawOutput.FileContent.${key}`, fileContent, key));
        }
      }
    }
  }

  // Cursor: {type:'tool_call', tool_call:{<name>ToolCall:{result:{success:{...}}}}}
  const toolCall = chunk.tool_call;
  if (!isPlainObject(toolCall)) return;
  for (const [callKey, callValue] of Object.entries(toolCall)) {
    if (!callKey.endsWith('ToolCall') || !isPlainObject(callValue)) continue;
    const result = callValue.result;
    if (!isPlainObject(result)) continue;
    const success = result.success;
    if (!isPlainObject(success)) continue;
    for (const key of ['content', 'beforeFullFileContent', 'afterFullFileContent', 'prevContent'] as const) {
      if (key in success) {
        out.push(makeSlot(
          'headlessAgentToolResult',
          `tool_call.${callKey}.result.success.${key}`,
          success,
          key,
        ));
      }
    }
  }
}

function isCodexSource(source: string): boolean {
  return source.startsWith('openai-codex')
    || source.startsWith('copilot-cli')
    || source.startsWith('opencode');
}

/**
 * Every heavy-payload slot in one parsed provider chunk.
 *
 * Returns an empty array for a shape this module does not recognize -- callers
 * then leave the row alone rather than guessing, which is what keeps an
 * unknown provider's transcript from being silently corrupted.
 */
export function providerPayloadSlots(chunk: unknown, source: string): PayloadSlot[] {
  if (!isPlainObject(chunk)) return [];

  const out: PayloadSlot[] = [];
  collectNimbalystSlots(chunk, out);

  if (source.startsWith('claude-code')) {
    collectClaudeSlots(chunk, out);
  } else if (isCodexSource(source)) {
    collectCodexSlots(chunk, out);
  } else if (source.startsWith('grok-build') || source.startsWith('cursor-agent')) {
    // The turn-final assistant row uses Codex's `item.completed` shape, so it
    // walks with the Codex collector; everything else is these agents' own.
    collectCodexSlots(chunk, out);
    collectHeadlessAgentSlots(chunk, out);
  } else if (source.startsWith('antigravity-gemini-agent') || source.startsWith('gemini-antigravity')) {
    // Both spellings: the second is what rows written while Gemini shipped as
    // an extension carry (`gemini-antigravity/antigravity-server`).
    collectGeminiSlots(chunk, out);
  }

  return out;
}
