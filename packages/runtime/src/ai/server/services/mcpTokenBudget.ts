/**
 * MCP token-budget measurement.
 *
 * Reusable instrument for the MCP server consolidation: measure the serialized
 * `ListTools` size of each server endpoint, so the eager (core-only) footprint
 * can be verified before/after the split (target: typical session eager surface
 * ≤ ~8K tokens, down from ~20K). See mcpTopology + the consolidation plan.
 *
 * Token estimation uses the standard ~4-chars-per-token heuristic on the JSON
 * the SDK actually serializes for `tools/list`. It is an estimate, not a
 * tokenizer — good enough to track relative budget movement across phases.
 */

/** Minimal shape of a tool schema as serialized into `ListTools`. */
export interface MeasurableToolSchema {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ServerToolBudget {
  /** Server config-key (mcp__<configKey>__<tool>). */
  configKey: string;
  toolCount: number;
  /** Serialized JSON byte length of this server's `ListTools` tools array. */
  bytes: number;
  /** Estimated tokens (~bytes / CHARS_PER_TOKEN). */
  estTokens: number;
}

export interface ToolBudgetReport {
  servers: ServerToolBudget[];
  totalToolCount: number;
  totalBytes: number;
  totalEstTokens: number;
  /** Estimated tokens charged eagerly (sum of servers in `eagerConfigKeys`). */
  eagerEstTokens: number;
}

/** ~4 chars per token — the conventional rough estimator. */
export const CHARS_PER_TOKEN = 4;

/** Estimate tokens for a string via the chars-per-token heuristic. */
export function estimateTokensForString(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Serialized size + token estimate for one server's tool list. Serializes the
 * exact `{ name, description, inputSchema }` triples the SDK lists.
 */
export function measureToolList(tools: MeasurableToolSchema[]): { bytes: number; estTokens: number } {
  const serialized = JSON.stringify(
    tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  );
  const bytes = serialized.length;
  return { bytes, estTokens: estimateTokensForString(serialized) };
}

/**
 * Build a budget report across servers.
 *
 * @param serverTools  config-key → that server's tool schemas
 * @param eagerConfigKeys  which servers are `alwaysLoad` (charged eagerly)
 */
export function buildToolBudgetReport(
  serverTools: Record<string, MeasurableToolSchema[]>,
  eagerConfigKeys: readonly string[],
): ToolBudgetReport {
  const eager = new Set(eagerConfigKeys);
  const servers: ServerToolBudget[] = [];
  let totalToolCount = 0;
  let totalBytes = 0;
  let totalEstTokens = 0;
  let eagerEstTokens = 0;

  for (const [configKey, tools] of Object.entries(serverTools)) {
    const { bytes, estTokens } = measureToolList(tools);
    servers.push({ configKey, toolCount: tools.length, bytes, estTokens });
    totalToolCount += tools.length;
    totalBytes += bytes;
    totalEstTokens += estTokens;
    if (eager.has(configKey)) eagerEstTokens += estTokens;
  }

  servers.sort((a, b) => b.estTokens - a.estTokens);
  return { servers, totalToolCount, totalBytes, totalEstTokens, eagerEstTokens };
}

/** One-line-per-server human-readable budget table (for test logs / diagnostics). */
export function formatToolBudgetReport(report: ToolBudgetReport): string {
  const lines = report.servers.map(
    (s) => `  ${s.configKey.padEnd(28)} ${String(s.toolCount).padStart(3)} tools  ~${s.estTokens} tok  (${s.bytes} bytes)`,
  );
  lines.push(
    `  ${'TOTAL'.padEnd(28)} ${String(report.totalToolCount).padStart(3)} tools  ~${report.totalEstTokens} tok`,
  );
  lines.push(`  eager (alwaysLoad) surface: ~${report.eagerEstTokens} tok`);
  return lines.join('\n');
}
