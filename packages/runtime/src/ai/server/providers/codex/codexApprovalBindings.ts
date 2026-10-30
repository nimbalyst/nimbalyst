/**
 * Routes Codex app-server approval requests to Nimbalyst's tool-permission
 * flow (#1884). Before this, no host binding existed and every request was
 * declined without the user seeing it.
 *
 * Each request goes through `ToolPermissionService.requestToolPermission`,
 * which applies the project's mode (Allow everything auto-approves, Allow
 * edits only auto-approves edits) and remembered approvals before prompting.
 * The `ToolPermission` transcript card is logged only when the service really
 * prompts, so auto-approved requests leave no unanswered card behind.
 */
import type {
  CodexAppServerHostBindings,
  CodexApprovalContext,
} from '../../protocols/CodexAppServerProtocol';
import {
  codexApprovalCommandText,
  commandApprovalDecision,
  fileChangeApprovalDecision,
  isShellWrappedCommand,
  permissionsApprovalResponse,
  type CodexPermissionAnswer,
} from '../../protocols/codexAppServer/approvalDecisions';
import type { ToolPermissionService } from '../../permissions/ToolPermissionService';
import { buildToolDescription, generateToolPattern } from '../../permissions/toolPermissionHelpers';
import { getPatternDisplayName } from '../../types';

/** The running turn an approval request belongs to. */
export interface CodexApprovalTurn {
  workspacePath: string;
  permissionsPath: string;
  signal: AbortSignal;
  /**
   * Agent-verified: Codex's automatic reviewer already looked at anything
   * that reaches us, so the user must answer it even though the stored mode
   * is bypass-all.
   */
  agentVerified: boolean;
}

export interface CodexApprovalBindingDeps {
  permissionService: () => ToolPermissionService;
  turnFor: (nimbalystSessionId: string) => CodexApprovalTurn | undefined;
  logAgentMessage: (sessionId: string, content: string) => Promise<void>;
}

interface PromptRequest {
  toolName: string;
  toolInput: Record<string, unknown>;
  rawCommand: string;
  pattern: string;
  toolDescription: string;
  /** Prompts that must not offer "Always" (one-off sandbox grants). */
  suppressAlwaysAllowRule?: boolean;
}

/** `null` means the request could not be put to the user and must be refused. */
type AnswerOrRefusal = CodexPermissionAnswer | 'cancel' | null;

export function createCodexApprovalBindings(deps: CodexApprovalBindingDeps): {
  bindings: CodexAppServerHostBindings;
  /** Call from the permission service's `toolPermission:pending` emit. */
  onPermissionPrompt: (event: { requestId?: string }) => void;
} {
  const cardsByRequestId = new Map<string, { sessionId: string; card: string }>();
  let requestCounter = 0;

  async function ask(context: CodexApprovalContext, prompt: PromptRequest): Promise<AnswerOrRefusal> {
    const sessionId = context.nimbalystSessionId;
    const turn = sessionId ? deps.turnFor(sessionId) : undefined;
    if (!sessionId || !turn) {
      console.error('[CODEX] approval request outside an active turn; refusing', { sessionId, toolName: prompt.toolName });
      return null;
    }
    const requestId = `codex-approval-${sessionId}-${Date.now()}-${++requestCounter}`;
    const isDestructive = true;
    const patternDisplayName = getPatternDisplayName(prompt.pattern);
    cardsByRequestId.set(requestId, {
      sessionId,
      card: JSON.stringify({
        type: 'nimbalyst_tool_use',
        id: requestId,
        name: 'ToolPermission',
        input: {
          ...(prompt.suppressAlwaysAllowRule ? { suppressAlwaysAllowRule: true } : {}),
          requestId,
          toolName: prompt.toolName,
          rawCommand: prompt.rawCommand,
          pattern: prompt.pattern,
          patternDisplayName,
          isDestructive,
          warnings: [],
          workspacePath: turn.workspacePath,
        },
      }),
    });
    try {
      const answer = await deps.permissionService().requestToolPermission({
        requestId,
        sessionId,
        workspacePath: turn.workspacePath,
        permissionsPath: turn.permissionsPath,
        toolName: prompt.toolName,
        toolInput: prompt.toolInput,
        pattern: prompt.pattern,
        patternDisplayName,
        toolDescription: prompt.toolDescription,
        isDestructive,
        signal: turn.signal,
        ...(prompt.suppressAlwaysAllowRule ? { suppressAlwaysAllowRule: true } : {}),
        ...(turn.agentVerified ? { requiresUserDecision: 'escalated' as const } : {}),
      });
      return answer;
    } catch (error) {
      if (turn.signal.aborted) return 'cancel';
      // Untrusted workspace or a broken permission service: refuse, never allow.
      console.error('[CODEX] approval request failed; refusing', { requestId, error });
      return null;
    } finally {
      cardsByRequestId.delete(requestId);
    }
  }

  const bindings: CodexAppServerHostBindings = {
    async approveCommandExecution(params, context) {
      const command = codexApprovalCommandText(params);
      const wrapped = isShellWrappedCommand(command);
      const answer = await ask(context, {
        toolName: 'Bash',
        toolInput: { command, cwd: params.cwd ?? undefined, reason: params.reason ?? undefined },
        rawCommand: command,
        // A still-wrapped command gets the never-remembered compound pattern.
        pattern: wrapped ? `Bash:compound:${params.itemId}` : generateToolPattern('Bash', { command }),
        toolDescription: params.reason ? `${command}\n${params.reason}` : command,
        suppressAlwaysAllowRule: wrapped,
      });
      if (answer === 'cancel') return { decision: 'cancel' };
      if (!answer) return { decision: 'decline' };
      return { decision: commandApprovalDecision(answer, params) };
    },

    async approveFileChange(params, context) {
      const paths = (context.fileChanges ?? []).map((change) => change.path);
      const filePath = paths[0] ?? params.grantRoot ?? context.workspacePath;
      const description = paths.length > 1
        ? `edit ${paths.length} files: ${paths.join(', ')}`
        : buildToolDescription('Edit', { file_path: filePath });
      const answer = await ask(context, {
        toolName: 'Edit',
        toolInput: { file_path: filePath, paths, reason: params.reason ?? undefined },
        rawCommand: description,
        pattern: generateToolPattern('Edit', { file_path: filePath }),
        toolDescription: params.reason ? `${description}\n${params.reason}` : description,
      });
      if (answer === 'cancel') return { decision: 'cancel' };
      if (!answer) return { decision: 'decline' };
      return { decision: fileChangeApprovalDecision(answer) };
    },

    async approvePermissions(params, context) {
      const requested = [
        params.permissions?.network ? 'network access' : null,
        params.permissions?.fileSystem ? 'file system access' : null,
      ].filter(Boolean).join(' and ') || 'additional permissions';
      const description = params.reason ? `Codex requests ${requested}: ${params.reason}` : `Codex requests ${requested}`;
      const answer = await ask(context, {
        toolName: 'CodexPermissions',
        toolInput: { permissions: params.permissions, reason: params.reason },
        rawCommand: description,
        // Sandbox grants are never remembered beyond the session.
        pattern: `CodexPermissions:${params.itemId}`,
        toolDescription: description,
        suppressAlwaysAllowRule: true,
      });
      if (answer === 'cancel' || !answer) return { permissions: {}, scope: 'turn' };
      return permissionsApprovalResponse(answer, params);
    },
  };

  function onPermissionPrompt(event: { requestId?: string }): void {
    const entry = event.requestId ? cardsByRequestId.get(event.requestId) : undefined;
    if (!entry) return;
    void deps.logAgentMessage(entry.sessionId, entry.card);
  }

  return { bindings, onPermissionPrompt };
}
