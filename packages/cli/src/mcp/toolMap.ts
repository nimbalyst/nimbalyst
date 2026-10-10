/**
 * The tools `nim mcp` serves, and what a call returns.
 *
 * The list is fixed for the life of the process: Claude Code reads `tools/list`
 * once per session, so a tool that cannot run right now stays listed and
 * answers with what would make it work, rather than disappearing.
 *
 * Tool names and input schemas are meant to come from the shared contract
 * (`@nimbalyst/collab-protocol` `pageToolContract.ts`) so the same skill text
 * reads the same against desktop, the remote server and this one. Claude Code
 * namespaces tools by server, so sharing names with `nimbalyst-team` is fine.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: readonly string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

export interface McpToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export type McpToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

export interface McpTool {
  definition: McpToolDefinition;
  call: McpToolHandler;
}

/** The server that owns team data. Named in refusals so the agent can retry there. */
export const REMOTE_SERVER_NAME = 'nimbalyst-team';

/**
 * Thrown by a tool whose call targets team data. Team scope has one write path,
 * the remote server; `nim mcp` never reads or writes team items locally.
 */
export class TeamScopeRefusal extends Error {
  constructor(readonly toolName: string) {
    super(
      `${toolName}: this targets team data, which nim mcp does not handle. ` +
        `Call \`${toolName}\` on the \`${REMOTE_SERVER_NAME}\` server instead.`,
    );
    this.name = 'TeamScopeRefusal';
  }
}

export function textResult(value: unknown, isError = false): McpToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

export class ToolMap {
  private readonly tools = new Map<string, McpTool>();

  register(tool: McpTool): this {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`nim mcp: tool registered twice: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
    return this;
  }

  definitions(): McpToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  get(name: string): McpTool | undefined {
    return this.tools.get(name);
  }
}
