/**
 * Shared tool-usage types and pure helpers.
 *
 * Keep this file renderer-safe. Main-process persistence lives in
 * ToolUsageService; renderer code (tips, the AI Usage Report) imports these
 * types and the pure parsing/rollup helpers.
 *
 * Tool names arrive in two shapes:
 *   - built-in tools: `Read`, `Bash`, `Grep`, ...
 *   - MCP / extension tools: `mcp__<server>__<tool>` (the tool part may itself
 *     contain `__`, e.g. `mcp__nimbalyst-excalidraw__excalidraw_add_rectangle`).
 */

export interface ParsedToolName {
  /** The full, original tool name (unchanged). */
  toolName: string;
  /** MCP server segment, or null for built-in tools. */
  mcpServer: string | null;
  /** MCP tool segment (everything after the server), or null for built-ins. */
  mcpTool: string | null;
  isMcp: boolean;
}

/** A single tool invocation observed during a response. */
export interface ToolCallObservation {
  name: string;
  isError?: boolean;
  /** Stable provider invocation ID; repeated lifecycle chunks share this ID. */
  invocationId?: string;
}

/** An aggregated per-tool tally, ready to UPSERT into the counter table. */
export interface AggregatedToolUsage {
  toolName: string;
  mcpServer: string | null;
  mcpTool: string | null;
  count: number;
  errorCount: number;
}

/** A rolled-up usage record keyed by {@link rollupKey}, consumed by tips. */
export interface ToolUsageRollupRecord {
  count: number;
  firstUsed: string;
  lastUsed: string;
}

const MCP_PREFIX = 'mcp__';

/**
 * Parse a raw tool name into its built-in vs MCP shape.
 * `mcp__<server>__<tool>` splits into server = first segment, tool = the rest
 * (rejoined with `__` so multi-segment tool names survive round-trip).
 */
export function parseToolName(name: string): ParsedToolName {
  if (typeof name === 'string' && name.startsWith(MCP_PREFIX)) {
    const rest = name.slice(MCP_PREFIX.length);
    const sep = rest.indexOf('__');
    if (sep > 0) {
      const server = rest.slice(0, sep);
      const tool = rest.slice(sep + 2);
      return {
        toolName: name,
        mcpServer: server,
        mcpTool: tool.length > 0 ? tool : null,
        isMcp: true,
      };
    }
    // Malformed (`mcp__server` with no tool segment) -- still treat as MCP.
    return {
      toolName: name,
      mcpServer: rest || null,
      mcpTool: null,
      isMcp: true,
    };
  }
  return { toolName: name, mcpServer: null, mcpTool: null, isMcp: false };
}

/**
 * The rolled-up key tips gate on: built-in tools by their own name, MCP tools
 * collapsed to `mcp:<server>` so `hasUsedTool('mcp:nimbalyst-excalidraw')`
 * answers "used the Excalidraw extension" regardless of which specific tool.
 */
export function rollupKey(parsed: ParsedToolName): string {
  return parsed.isMcp && parsed.mcpServer
    ? `mcp:${parsed.mcpServer}`
    : parsed.toolName;
}

/**
 * Aggregate a list of tool observations from a single response into per-tool
 * tallies keyed by full tool name. Empty/invalid names are skipped.
 */
export function aggregateToolCalls(
  calls: ReadonlyArray<ToolCallObservation>,
): AggregatedToolUsage[] {
  // Providers such as Codex emit both started and completed chunks for one
  // invocation. Keep the last observation so the terminal error state wins.
  const dedupedByInvocation = new Map<string, ToolCallObservation>();
  const anonymous: ToolCallObservation[] = [];
  for (const call of calls) {
    if (
      typeof call?.invocationId === 'string' &&
      call.invocationId.length > 0
    ) {
      dedupedByInvocation.set(call.invocationId, call);
    } else {
      anonymous.push(call);
    }
  }

  const byTool = new Map<string, AggregatedToolUsage>();
  for (const call of [...dedupedByInvocation.values(), ...anonymous]) {
    const name = call?.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    const parsed = parseToolName(name);
    const existing = byTool.get(name);
    if (existing) {
      existing.count += 1;
      if (call.isError) existing.errorCount += 1;
    } else {
      byTool.set(name, {
        toolName: name,
        mcpServer: parsed.mcpServer,
        mcpTool: parsed.mcpTool,
        count: 1,
        errorCount: call.isError ? 1 : 0,
      });
    }
  }
  return Array.from(byTool.values());
}

/** UTC `YYYY-MM-DD` day bucket for a timestamp (defaults to now). */
export function toDayBucket(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** A tool invocation extracted from a raw persisted message during backfill. */
export interface ExtractedTool {
  /** Provider item id used to dedupe streaming duplicates (null if absent). */
  id: string | null;
  name: string;
  isError: boolean;
}

/** Extract tool_use blocks from a claude-code raw SDK message. */
export function extractClaudeTools(parsed: any): ExtractedTool[] {
  const content = parsed?.message?.content;
  if (!Array.isArray(content)) return [];
  const out: ExtractedTool[] = [];
  for (const block of content) {
    if (block?.type === 'tool_use' && typeof block.name === 'string') {
      out.push({
        id: typeof block.id === 'string' ? block.id : null,
        name: block.name,
        isError: false,
      });
    }
  }
  return out;
}

/**
 * Extract tool calls from a codex ACP `item/completed` envelope. Only counts
 * completed items (started/in-progress are duplicates). mcpToolCall becomes
 * `mcp__<server>__<tool>`; commandExecution maps to the `shell` tool.
 */
export function extractCodexTools(parsed: any): ExtractedTool[] {
  const isAppServer = parsed?.method === 'item/completed';
  const isSdk = parsed?.type === 'item.completed';
  if (!isAppServer && !isSdk) return [];

  const item = isAppServer ? parsed?.params?.item : parsed?.item;
  if (!item || typeof item !== 'object') return [];
  const id = typeof item.id === 'string' ? item.id : null;
  const status =
    typeof item.status === 'string' ? item.status.toLowerCase() : '';
  const resultFailed =
    item.result &&
    typeof item.result === 'object' &&
    item.result.success === false;
  const isError =
    Boolean(item.error) ||
    Boolean(resultFailed) ||
    status === 'failed' ||
    status === 'error' ||
    status === 'cancelled' ||
    (typeof item.exit_code === 'number' && item.exit_code !== 0) ||
    (typeof item.exitCode === 'number' && item.exitCode !== 0);

  if (
    (item.type === 'mcpToolCall' || item.type === 'mcp_tool_call') &&
    item.server &&
    item.tool
  ) {
    return [{ id, name: `mcp__${item.server}__${item.tool}`, isError }];
  }
  if (item.type === 'commandExecution' || item.type === 'command_execution') {
    return [{ id, name: 'command_execution', isError }];
  }
  if (item.type === 'fileChange' || item.type === 'file_change') {
    return [{ id, name: 'file_change', isError }];
  }
  if (item.type === 'webSearch' || item.type === 'web_search') {
    return [{ id, name: 'web_search', isError }];
  }
  if (item.type === 'function_call' && typeof item.name === 'string') {
    return [{ id, name: item.name, isError }];
  }
  if (typeof item.name === 'string') {
    return [{ id, name: item.name, isError }];
  }
  return [];
}
