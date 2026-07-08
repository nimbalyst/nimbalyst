/**
 * Execute a backend-module-registered MCP tool.
 *
 * Unlike renderer-declared extension tools (dispatched to the renderer via
 * `mcp:executeExtensionTool` in `extensionToolHandler.ts`), backend tools are
 * executed by the backend module itself: we look the tool up in the backend
 * tool registry and route the call to the module's RPC method via
 * `PrivilegedExtensionHost.request`. This keeps the call in the main↔backend
 * channel (no renderer hop) — important for the voice latency budget.
 */
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { findBackendTool } from '../backendToolRegistry';
import { getPrivilegedExtensionHost } from '../../extensions/PrivilegedExtensionHost';

type McpToolResult = {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
};

/**
 * Returns true if `toolName` matches a backend-registered tool for the
 * workspace. Callers use this to decide whether to route to the backend before
 * falling through to the renderer extension path.
 */
export function isBackendTool(
  toolName: string,
  workspacePath: string | undefined
): boolean {
  return findBackendTool(workspacePath, toolName) !== undefined;
}

export async function handleBackendTool(
  toolName: string,
  originalName: string,
  args: Record<string, unknown> | undefined,
  workspacePath: string | undefined
): Promise<McpToolResult> {
  if (!workspacePath) {
    return {
      content: [
        { type: 'text', text: 'Error: workspacePath is required to execute backend tools' },
      ],
      isError: true,
    };
  }

  const entry = findBackendTool(workspacePath, toolName);
  if (!entry) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${originalName}`);
  }

  try {
    // The tool's RPC execution is not itself a catalog-gated broker capability
    // (the module's own grants gate what it can do inside the handler), so
    // requiredPermission is null. The host throws if the module isn't running.
    const result = await getPrivilegedExtensionHost().request<unknown>({
      extensionId: entry.extensionId,
      moduleId: entry.moduleId,
      workspacePath,
      method: entry.method,
      params: args ?? {},
      requiredPermission: null,
    });

    const text =
      typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: 'text', text }], isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: `Backend tool error\n  Tool: ${entry.name}\n  Extension: ${entry.extensionId}\n\nError: ${message}`,
        },
      ],
      isError: true,
    };
  }
}
