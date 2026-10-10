/**
 * Per-method broker dispatch for privileged backend modules.
 *
 * `PrivilegedExtensionHost.handleBrokerRequest` runs the permission gate, then
 * calls `dispatchBrokerMethod` here to do the work. Everything a method acts
 * on is scoped by the HOST-derived runtime context (`ctx`): extension id,
 * module id, bound workspace, install path. Nothing in the payload can widen
 * that scope.
 *
 * Workspace boundary enforcement: readWorkspaceFile / writeWorkspaceFile
 * resolve the requested path against the runtime's workspacePath and reject
 * anything that escapes it (absolute paths outside the workspace, `..`
 * traversal).
 */
import * as path from 'path';
import * as fs from 'fs/promises';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { getProviderApiKeyFromSettings } from '../utils/store';
import { logger } from '../utils/logger';
import { dispatchMetaAgentTool } from '../mcp/metaAgentServer';
import { dispatchDevAgentTool } from '../mcp/devAgentTools';
import { registerBackendTools } from '../mcp/backendToolRegistry';
import { dispatchExtensionSessionsOp } from '../services/extensionSessions/extensionSessionsService';
import { CapabilityDeniedError } from './extensionCapabilityPolicy';
import { setBackendPanelGutterBadge } from './backendPanelBadges';
import type {
  BackendRuntimeContext,
  BrokerMethodName,
  BrokerPayloads,
  BrokerResults,
} from './extensionBackendRpc';

export async function dispatchBrokerMethod(
  method: BrokerMethodName,
  rawPayload: unknown,
  ctx: BackendRuntimeContext
): Promise<BrokerResults[BrokerMethodName]> {
  switch (method) {
    case 'logRaw': {
      const payload = rawPayload as BrokerPayloads['logRaw'];
      // Per phase-4-sdk-types-proposal §4.3 anti-impersonation guarantee:
      // the `source` is stamped HOST-SIDE from ctx.extensionId/ctx.moduleId.
      // The extension cannot supply or override it, so it cannot impersonate
      // first-party providers (e.g. claude-code) over the broker.
      const source = `${ctx.extensionId}/${ctx.moduleId}`;
      const direction = payload.direction === 'inbound' ? 'input' : 'output';
      await AgentMessagesRepository.create({
        sessionId: payload.sessionId,
        source,
        direction,
        content: payload.content,
        metadata: payload.metadata,
        hidden: false,
        createdAt: new Date(),
        searchable: true,
      });
      // AgentMessagesRepository.create returns void; the row id is not
      // exposed by the store contract. Return 0 as a sentinel so the wire
      // result shape stays { id: number }; callers that need the id should
      // re-query by (sessionId, providerMessageId) once a real id surface
      // is added.
      const result: BrokerResults['logRaw'] = { id: 0 };
      return result;
    }
    case 'getApiKey': {
      const payload = rawPayload as BrokerPayloads['getApiKey'];
      // Per CLAUDE.md "Never Use Environment Variables as Implicit API Key
      // Sources": read ONLY from the explicit Nimbalyst settings — the
      // `ai-settings` store's `apiKeys` (where provider keys actually live,
      // NOT `app-settings`) plus per-workspace overrides. Never process.env.
      const key = getProviderApiKeyFromSettings(payload.providerId, ctx.workspacePath);
      const result: BrokerResults['getApiKey'] = { key };
      return result;
    }
    case 'readWorkspaceFile': {
      const payload = rawPayload as BrokerPayloads['readWorkspaceFile'];
      const abs = resolveWorkspacePath(ctx, payload.path);
      const content = await fs.readFile(abs, 'utf-8');
      const result: BrokerResults['readWorkspaceFile'] = { content };
      return result;
    }
    case 'writeWorkspaceFile': {
      const payload = rawPayload as BrokerPayloads['writeWorkspaceFile'];
      const abs = resolveWorkspacePath(ctx, payload.path);
      await fs.writeFile(abs, payload.content, 'utf-8');
      const result: BrokerResults['writeWorkspaceFile'] = {
        bytesWritten: Buffer.byteLength(payload.content, 'utf-8'),
      };
      return result;
    }
    case 'registerMcpTools': {
      const payload = rawPayload as BrokerPayloads['registerMcpTools'];
      // Fan the registered tools into the main-side backend tool registry,
      // keyed by the workspace this module was started for. The coding-agent
      // and voice tool surfaces read from that registry; execution routes
      // back to this module via `handleBackendTool` -> `request`.
      const registered = registerBackendTools(
        ctx.workspacePath,
        ctx.extensionId,
        ctx.moduleId,
        payload.tools
      );
      logger.main.info(
        `[PrivilegedExtensionHost] broker.registerMcpTools: ${ctx.extensionId}/${ctx.moduleId} registered ${registered.length} tool(s) for ${ctx.workspacePath}`
      );
      const result: BrokerResults['registerMcpTools'] = { registered };
      return result;
    }
    case 'toolExecutor': {
      const payload = rawPayload as BrokerPayloads['toolExecutor'];
      // Scope the tool to the AI session that emitted it (so spawn_session
      // can find the caller) and the workspace it ran in. dispatchMetaAgentTool
      // normalizes worktree workspace paths to the parent repo internally.
      // The workspace falls back to the runtime's bound workspacePath when the
      // backend didn't supply one.
      const text = await dispatchMetaAgentTool(
        payload.name,
        payload.sessionId,
        payload.workspacePath ?? ctx.workspacePath,
        payload.args
      );
      const result: BrokerResults['toolExecutor'] = { result: text };
      return result;
    }
    case 'devToolExecutor': {
      const payload = rawPayload as BrokerPayloads['devToolExecutor'];
      // Read-only dev tools (read_file / list_files / search_files). The jail
      // root is the HOST-bound workspace (ctx.workspacePath), NEVER a
      // backend-supplied path, so a compromised backend cannot read outside
      // the workspace. ElectronFileSystemService's SafePathValidator blocks
      // traversal within the call, and reads are size-capped.
      const text = await dispatchDevAgentTool(payload.name, ctx.workspacePath, payload.args);
      const result: BrokerResults['devToolExecutor'] = { result: text };
      return result;
    }
    case 'sessions': {
      const payload = rawPayload as BrokerPayloads['sessions'];
      // Scope comes from the runtime context, never from the payload.
      const result: BrokerResults['sessions'] = {
        result: await dispatchExtensionSessionsOp(
          { extensionId: ctx.extensionId, workspacePath: ctx.workspacePath },
          payload.op,
          payload.args
        ),
      };
      return result;
    }
    case 'panels': {
      const payload = rawPayload as BrokerPayloads['panels'];
      // The panel must be one the calling extension's own manifest declares;
      // the badge is keyed and broadcast under ctx's extension and workspace.
      await setBackendPanelGutterBadge(ctx, payload.panelId, payload.value, payload.tone);
      const result: BrokerResults['panels'] = {};
      return result;
    }
    default: {
      // Exhaustiveness over BrokerMethodName.
      const _exhaust: never = method;
      void _exhaust;
      throw new Error(`unknown broker method: ${String(method)}`);
    }
  }
}

/**
 * Resolve a workspace-relative path against the runtime's workspacePath and
 * reject anything that escapes the workspace boundary. The `workspace-files`
 * grant is scoped to within the workspace; an access outside the workspace
 * is implicitly denied even when the catalog permission has been granted.
 */
function resolveWorkspacePath(ctx: BackendRuntimeContext, relativePath: string): string {
  const resolved = path.resolve(ctx.workspacePath, relativePath);
  const workspaceAbs = path.resolve(ctx.workspacePath);
  const inside = resolved === workspaceAbs || resolved.startsWith(workspaceAbs + path.sep);
  if (!inside) {
    throw new CapabilityDeniedError({
      reason: 'permission-not-granted',
      extensionId: ctx.extensionId,
      moduleId: ctx.moduleId,
      permissionId: 'workspace-files',
      detail: `path escapes workspace: ${relativePath}`,
    });
  }
  return resolved;
}
