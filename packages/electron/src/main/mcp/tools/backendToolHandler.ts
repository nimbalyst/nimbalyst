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
import type { BackendToolCallContext, SessionOwner } from '@nimbalyst/extension-sdk';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import {
  findBackendTool,
  findOwnedBackendTool,
  isBackendToolVisibleTo,
  type BackendToolDefinition,
} from '../backendToolRegistry';
import { getPrivilegedExtensionHost } from '../../extensions/PrivilegedExtensionHost';
import { readSessionOwner } from '../../services/extensionSessions/sessionOwnership';

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

/**
 * Who is calling. `panel` is an extension's own renderer (`callBackendTool`):
 * it resolves only that extension's tools, panel-only ones included.
 */
export type BackendToolCaller =
  | { sessionId: string | null; caller: 'agent' | 'voice' }
  | { sessionId: null; caller: 'panel'; extensionId: string };

/** The calling session's owner (any extension), or null when unowned or unknown. */
async function readCallerOwner(sessionId: string | null | undefined): Promise<SessionOwner | null> {
  if (!sessionId) return null;
  try {
    const session = await AISessionsRepository.get(sessionId);
    return readSessionOwner(session?.metadata);
  } catch {
    // A failed lookup reads as unowned: identity is advisory for the handler,
    // and an owned-sessions tool fails closed.
    return null;
  }
}

/**
 * Drop tools the listing session may not see (`audience: 'owned-sessions'`
 * tools of an extension that does not own it). Only reads the session when
 * such a tool is present, so ordinary listings stay free of a DB hit.
 */
export async function filterBackendToolsForSession(
  tools: BackendToolDefinition[],
  sessionId: string | undefined
): Promise<BackendToolDefinition[]> {
  if (!tools.some((t) => t.audience === 'owned-sessions')) return tools;
  const ownerExtensionId = (await readCallerOwner(sessionId))?.extensionId ?? null;
  return tools.filter((t) => isBackendToolVisibleTo(t, ownerExtensionId));
}

export async function handleBackendTool(
  toolName: string,
  originalName: string,
  args: Record<string, unknown> | undefined,
  workspacePath: string | undefined,
  call: BackendToolCaller
): Promise<McpToolResult> {
  if (!workspacePath) {
    return {
      content: [
        { type: 'text', text: 'Error: workspacePath is required to execute backend tools' },
      ],
      isError: true,
    };
  }

  // Agent and voice lookups never resolve a panel-only tool, so an agent that
  // names one gets the same "unknown tool" as for a tool that does not exist.
  const entry =
    call.caller === 'panel'
      ? findOwnedBackendTool(workspacePath, toolName, call.extensionId)
      : findBackendTool(workspacePath, toolName);
  if (!entry) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${originalName}`);
  }

  const callerOwner = await readCallerOwner(call.sessionId);
  // An owned-sessions tool is invisible to every other session and to voice, so
  // a call to it gets the same "unknown tool" as a name that does not exist.
  if (call.caller !== 'panel' && !isBackendToolVisibleTo(entry, callerOwner?.extensionId ?? null)) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${originalName}`);
  }

  const callContext: BackendToolCallContext = {
    sessionId: call.sessionId,
    workspacePath,
    // Only the tool's own extension learns the owner key.
    sessionOwner: callerOwner?.extensionId === entry.extensionId ? callerOwner : null,
    caller: call.caller,
  };

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
      callContext,
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

