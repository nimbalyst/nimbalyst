import { getPatternDisplayName } from '../../types';
import { buildToolDescription, generateToolPattern } from '../../permissions/toolPermissionHelpers';
import { constrainPermissionResponse, permissionPromptHints, type PermissionPromptHints } from '../../permissions/permissionPromptPolicy';
import { hasShellChainingOperators, splitOnShellOperators, stripHeredocs } from '../../permissions/BashCommandAnalyzer';

export type ToolAuthorizationDecision = {
  behavior: 'allow' | 'deny';
  updatedInput?: any;
  message?: string;
};

export interface ToolPermissionOptions extends PermissionPromptHints {
  signal: AbortSignal;
  suggestions?: any[];
  toolUseID?: string;
}

interface ServicePermissionDeps {
  logSecurity: (message: string, data?: Record<string, unknown>) => void;
  logAgentMessage: (sessionId: string, content: string) => Promise<void>;
  requestToolPermission: (options: PermissionPromptHints & {
    requestId: string;
    sessionId: string;
    workspacePath: string;
    permissionsPath: string;
    toolName: string;
    toolInput: any;
    pattern: string;
    patternDisplayName: string;
    toolDescription: string;
    isDestructive: boolean;
    warnings?: string[];
    signal: AbortSignal;
    teammateName?: string;
  }) => Promise<{ decision: 'allow' | 'deny' }>;
}

interface ServicePermissionParams {
  toolName: string;
  input: any;
  options: ToolPermissionOptions;
  sessionId: string;
  workspacePath: string;
  permissionsPath: string | undefined;
  teammateName: string | undefined;
  warnings?: string[];
}

export const COMPOUND_PART_WARNING = 'This is part of a compound command - each part is checked separately';

interface CompoundBashDeps {
  /** True when the sub-command's pattern is approved this session or in settings */
  isPartPreApproved: (pattern: string) => Promise<boolean>;
  /** Run the normal permission prompt for one sub-command */
  authorizePart: (partInput: any, warnings: string[]) => Promise<ToolAuthorizationDecision>;
  logSecurity: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Build the pre-approval check for compound sub-commands. Session approvals
 * live in more than one place: the fallback prompt records them on the
 * provider, ToolPermissionService records them on itself. Both must count,
 * or a part approved for the session prompts again on the next command.
 */
export function createCompoundPartPreApprovalCheck(
  getSessionApprovedPatternSets: () => Array<Set<string> | undefined>,
  settingsChecker: ((workspacePath: string, pattern: string) => Promise<boolean>) | undefined,
  workspacePath: string | undefined
): (pattern: string) => Promise<boolean> {
  return async (pattern) =>
    getSessionApprovedPatternSets().some(set => set?.has(pattern)) ||
    (!!workspacePath && !!settingsChecker && await settingsChecker(workspacePath, pattern));
}

/**
 * Authorize a compound Bash command (&&, ||, ;) one sub-command at a time.
 *
 * This runs from canUseTool, which the SDK calls only after it has combined
 * every PreToolUse hook's decision and applied its own allow rules (which
 * already match each sub-command independently). A command that a user's
 * PreToolUse hook allowed therefore never gets here. It used to run inside
 * Nimbalyst's own PreToolUse hook, where it prompted in parallel with, and
 * regardless of, the user's hooks.
 *
 * Sub-commands approved this session or in settings pass silently; each
 * remaining one gets its own prompt, so "Session"/"Always" save a rule for
 * that sub-command rather than for the whole compound string.
 *
 * Returns null when the command is not compound, or when it has a newline
 * outside a heredoc (shell-quote reads newlines as whitespace, so splitting
 * would glue two commands together); the caller then prompts for the whole
 * command.
 */
export async function authorizeCompoundBashCommand(
  deps: CompoundBashDeps,
  input: any
): Promise<ToolAuthorizationDecision | null> {
  const command = typeof input?.command === 'string' ? input.command : '';
  if (!hasShellChainingOperators(command)) {
    return null;
  }
  if (stripHeredocs(command).trim().includes('\n')) {
    deps.logSecurity('[canUseTool] Multi-line compound command, prompting for the whole command');
    return null;
  }

  for (const subCommand of splitOnShellOperators(command)) {
    const pattern = generateToolPattern('Bash', { command: subCommand });
    if (await deps.isPartPreApproved(pattern)) {
      deps.logSecurity('[canUseTool] Compound sub-command already approved:', { subCommand: subCommand.slice(0, 50), pattern });
      continue;
    }

    deps.logSecurity('[canUseTool] Compound sub-command needs approval:', { subCommand: subCommand.slice(0, 50), pattern });
    const decision = await deps.authorizePart({ ...input, command: subCommand }, [COMPOUND_PART_WARNING]);
    if (decision.behavior !== 'allow') {
      return {
        behavior: 'deny',
        message: decision.message || `Command denied: ${subCommand.slice(0, 50)}`
      };
    }
  }

  return { behavior: 'allow', updatedInput: input };
}

export async function handleToolPermissionWithService(
  deps: ServicePermissionDeps,
  params: ServicePermissionParams
): Promise<ToolAuthorizationDecision> {
  const {
    toolName,
    input,
    options,
    sessionId,
    workspacePath,
    permissionsPath,
    teammateName,
    warnings = []
  } = params;

  try {
    const requestId = `tool-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pattern = generateToolPattern(toolName, input);
    const toolDescription = buildToolDescription(toolName, input);
    const isDestructive = ['Write', 'Edit', 'MultiEdit', 'Bash'].includes(toolName);
    const patternDisplay = getPatternDisplayName(pattern);

    deps.logSecurity('[canUseTool] Requesting permission via ToolPermissionService:', {
      toolName,
      pattern,
      requestId,
    });

    await deps.logAgentMessage(
      sessionId,
      JSON.stringify({
        type: 'nimbalyst_tool_use',
        id: requestId,
        name: 'ToolPermission',
        input: {
          ...permissionPromptHints(options),
          requestId,
          toolName,
          rawCommand: toolName === 'Bash' ? input?.command || '' : toolDescription,
          pattern,
          patternDisplayName: patternDisplay,
          isDestructive,
          warnings,
          workspacePath,
          ...(teammateName && { teammateName }),
        }
      })
    );

    const response = await deps.requestToolPermission({
      ...permissionPromptHints(options),
      requestId,
      sessionId,
      workspacePath,
      permissionsPath: permissionsPath || workspacePath,
      toolName,
      toolInput: input,
      pattern,
      patternDisplayName: patternDisplay,
      toolDescription,
      isDestructive,
      warnings,
      signal: options.signal,
      teammateName,
    });

    if (response.decision === 'allow') {
      return { behavior: 'allow', updatedInput: input };
    }

    return {
      behavior: 'deny',
      message: 'Tool call denied by user'
    };
  } catch (error) {
    deps.logSecurity('[canUseTool] Permission request failed:', {
      toolName,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {
      behavior: 'deny',
      message: error instanceof Error ? error.message : 'Permission request cancelled'
    };
  }
}

interface PendingPermissionEntry {
  resolve: (response: { decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' }) => void;
  reject: (error: Error) => void;
  request: any;
}

interface FallbackPermissionDeps {
  permissions: {
    sessionApprovedPatterns: Set<string>;
    pendingToolPermissions: Map<string, PendingPermissionEntry>;
  };
  logSecurity: (message: string, data?: Record<string, unknown>) => void;
  logAgentMessage: (sessionId: string, content: string) => Promise<void>;
  emit: (event: 'toolPermission:pending' | 'toolPermission:resolved', payload: any) => void;
  pollForPermissionResponse: (sessionId: string, requestId: string, signal: AbortSignal) => Promise<void>;
  savePattern?: (workspacePath: string, pattern: string) => Promise<void>;
  logError: (message: string, error: unknown) => void;
}

interface FallbackPermissionParams {
  toolName: string;
  input: any;
  options: ToolPermissionOptions;
  sessionId: string | undefined;
  workspacePath: string | undefined;
  warnings?: string[];
}

export async function handleToolPermissionFallback(
  deps: FallbackPermissionDeps,
  params: FallbackPermissionParams
): Promise<ToolAuthorizationDecision> {
  const { toolName, input, options, sessionId, workspacePath, warnings = [] } = params;

  const pattern = generateToolPattern(toolName, input);
  if (deps.permissions.sessionApprovedPatterns.has(pattern)) {
    deps.logSecurity('[canUseTool] Pattern already approved this session:', { pattern, toolName });
    return { behavior: 'allow', updatedInput: input };
  }
  if (toolName === 'WebFetch' && deps.permissions.sessionApprovedPatterns.has('WebFetch')) {
    deps.logSecurity('[canUseTool] WebFetch wildcard approved this session:', { toolName });
    return { behavior: 'allow', updatedInput: input };
  }

  const requestId = `tool-${sessionId || 'unknown'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const toolDescription = buildToolDescription(toolName, input);
  const isDestructive = ['Write', 'Edit', 'MultiEdit', 'Bash'].includes(toolName);
  const rawCommand = toolName === 'Bash' ? input?.command || '' : toolDescription;
  const patternDisplay = getPatternDisplayName(pattern);

  deps.logSecurity('[canUseTool] Showing permission prompt (fallback):', {
    toolName,
    toolDescription: toolDescription.slice(0, 100),
    requestId,
  });

  if (sessionId) {
    await deps.logAgentMessage(
      sessionId,
      JSON.stringify({
        type: 'nimbalyst_tool_use',
        id: requestId,
        name: 'ToolPermission',
        input: {
          ...permissionPromptHints(options),
          requestId,
          toolName,
          rawCommand,
          pattern,
          patternDisplayName: patternDisplay,
          isDestructive,
          warnings,
          workspacePath,
        }
      })
    );
  }

  const request = {
    ...permissionPromptHints(options),
    id: requestId,
    toolName,
    rawCommand,
    actionsNeedingApproval: [{
      action: {
        pattern,
        displayName: toolDescription,
        command: toolName === 'Bash' ? input?.command || '' : '',
        isDestructive,
        referencedPaths: [],
        hasRedirection: false,
      },
      decision: 'ask' as const,
      reason: 'Tool requires user approval',
      isDestructive,
      isRisky: toolName === 'Bash',
      warnings,
      outsidePaths: [],
      sensitivePaths: [],
    }],
    hasDestructiveActions: isDestructive,
    createdAt: Date.now(),
  };

  const responsePromise = new Promise<{ decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' }>((resolve, reject) => {
    deps.permissions.pendingToolPermissions.set(requestId, {
      resolve,
      reject,
      request
    });

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        deps.permissions.pendingToolPermissions.delete(requestId);
        reject(new Error('Request aborted'));
      }, { once: true });
    }
  });

  if (sessionId) {
    deps.pollForPermissionResponse(sessionId, requestId, options.signal).catch(() => {});
  }

  deps.emit('toolPermission:pending', {
    requestId,
    sessionId,
    workspacePath,
    request,
    timestamp: Date.now()
  });

  try {
    const response = constrainPermissionResponse(await responsePromise, options);

    deps.logSecurity('[canUseTool] User response received (fallback):', {
      toolName,
      decision: response.decision,
      scope: response.scope,
    });

    const isCompoundCommand = pattern.startsWith('Bash:compound:');
    if (response.decision === 'allow' && response.scope !== 'once' && !isCompoundCommand) {
      if (response.scope === 'always-all' && toolName === 'WebFetch') {
        deps.permissions.sessionApprovedPatterns.add('WebFetch');
        deps.logSecurity('[canUseTool] Added wildcard pattern to session cache:', { pattern: 'WebFetch', scope: response.scope });
      } else {
        deps.permissions.sessionApprovedPatterns.add(pattern);
        deps.logSecurity('[canUseTool] Added pattern to session cache:', { pattern, scope: response.scope });
      }
    }

    if (response.decision === 'allow' && (response.scope === 'always' || response.scope === 'always-all') && workspacePath && !isCompoundCommand) {
      if (deps.savePattern) {
        try {
          const patternToSave = (response.scope === 'always-all' && toolName === 'WebFetch') ? 'WebFetch' : pattern;
          await deps.savePattern(workspacePath, patternToSave);
          deps.logSecurity('[canUseTool] Saved pattern to Claude settings:', { pattern: patternToSave });
        } catch (saveError) {
          deps.logError('[CLAUDE-CODE] Failed to save pattern:', saveError);
        }
      }
    }

    deps.emit('toolPermission:resolved', {
      requestId,
      sessionId,
      response,
      timestamp: Date.now()
    });

    if (response.decision === 'allow') {
      return { behavior: 'allow', updatedInput: input };
    }

    return {
      behavior: 'deny',
      message: 'Tool call denied by user'
    };
  } catch (error) {
    deps.emit('toolPermission:resolved', {
      requestId,
      sessionId,
      response: { decision: 'deny', scope: 'once' },
      timestamp: Date.now()
    });
    deps.logSecurity('[canUseTool] Permission request failed (fallback):', {
      toolName,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {
      behavior: 'deny',
      message: error instanceof Error ? error.message : 'Permission request cancelled'
    };
  }
}
