import { getPatternDisplayName } from '../../types';
import { buildToolDescription, generateToolPattern } from '../../permissions/toolPermissionHelpers';

export type ToolAuthorizationDecision = {
  behavior: 'allow' | 'deny';
  updatedInput?: any;
  message?: string;
};

interface ToolPermissionOptions {
  signal: AbortSignal;
  suggestions?: any[];
  toolUseID?: string;
}

interface ServicePermissionDeps {
  logSecurity: (message: string, data?: Record<string, unknown>) => void;
  logAgentMessage: (sessionId: string, content: string) => Promise<void>;
  requestToolPermission: (options: {
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
    teammateName
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
          requestId,
          toolName,
          rawCommand: toolName === 'Bash' ? input?.command || '' : toolDescription,
          pattern,
          patternDisplayName: patternDisplay,
          isDestructive,
          warnings: [],
          workspacePath,
          ...(teammateName && { teammateName }),
        }
      })
    );

    const response = await deps.requestToolPermission({
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
      warnings: [],
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
}

export async function handleToolPermissionFallback(
  deps: FallbackPermissionDeps,
  params: FallbackPermissionParams
): Promise<ToolAuthorizationDecision> {
  const { toolName, input, options, sessionId, workspacePath } = params;

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
          requestId,
          toolName,
          rawCommand,
          pattern,
          patternDisplayName: patternDisplay,
          isDestructive,
          warnings: [],
          workspacePath,
        }
      })
    );
  }

  const request = {
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
      warnings: [],
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
    const response = await responsePromise;

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
