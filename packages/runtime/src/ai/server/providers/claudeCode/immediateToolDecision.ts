export type ToolDecision = { behavior: 'allow' | 'deny'; updatedInput?: any; message?: string };

interface TrustStatus {
  trusted: boolean;
  mode: string | null;
}

interface ResolveImmediateToolDecisionDeps {
  internalMcpTools: readonly string[];
  teamTools: readonly string[];
  trustChecker?: (path: string) => TrustStatus;
  resolveTeamContext: (sessionId: string | undefined) => Promise<string | undefined>;
  handleAskUserQuestion: (
    sessionId: string | undefined,
    input: any,
    options: { signal: AbortSignal; suggestions?: any[]; toolUseID?: string },
    toolUseID?: string
  ) => Promise<ToolDecision>;
  handleExitPlanMode: (
    sessionId: string | undefined,
    input: any,
    options: { signal: AbortSignal; toolUseID?: string },
  ) => Promise<ToolDecision>;
  setCurrentMode: (mode: 'planning' | 'agent' | 'auto') => void;
  getCurrentMode?: () => 'planning' | 'agent' | 'auto' | undefined;
  logSecurity: (message: string, data?: Record<string, unknown>) => void;
}

interface ResolveImmediateToolDecisionParams {
  toolName: string;
  input: any;
  options: { signal: AbortSignal; suggestions?: any[]; toolUseID?: string };
  sessionId: string | undefined;
  pathForTrust: string | undefined;
}

const ALLOW_ALL_FILE_EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'Read', 'Glob', 'Grep', 'LS', 'NotebookEdit'];

export async function resolveImmediateToolDecision(
  deps: ResolveImmediateToolDecisionDeps,
  params: ResolveImmediateToolDecisionParams
): Promise<ToolDecision | null> {
  const { toolName, input, options, sessionId, pathForTrust } = params;

  if (deps.internalMcpTools.includes(toolName)) {
    return { behavior: 'allow', updatedInput: input };
  }

  // In auto mode, MCP server tools and skills are auto-approved. The SDK
  // classifier is the sole decision-maker — if it escalated the call to
  // canUseTool rather than approving silently, it means it wanted user
  // confirmation. But MCP servers are user-configured (trusted by definition)
  // and skills are SDK-native; the CLI auto mode approves these without
  // prompting. Surfacing a Nimbalyst permission widget for `mcp__*` or `Skill`
  // calls would break the contract and frustrate users who chose auto mode.
  if (deps.getCurrentMode?.() === 'auto' && (toolName.startsWith('mcp__') || toolName === 'Skill')) {
    deps.logSecurity('[canUseTool] Auto mode: auto-approving MCP/skill tool:', { toolName });
    return { behavior: 'allow', updatedInput: input };
  }

  if (toolName === 'AskUserQuestion') {
    return deps.handleAskUserQuestion(sessionId, input, options, options.toolUseID);
  }

  if (toolName === 'EnterPlanMode') {
    deps.setCurrentMode('planning');
    return null; // Let SDK handle natively
  }

  if (toolName === 'ExitPlanMode') {
    return deps.handleExitPlanMode(sessionId, input, options);
  }

  if (deps.teamTools.includes(toolName)) {
    if (toolName === 'TeamDelete') {
      const hasExplicitTeam =
        typeof input?.team_name === 'string' && input.team_name.trim().length > 0;
      if (!hasExplicitTeam) {
        const inferredTeam = await deps.resolveTeamContext(sessionId);
        if (inferredTeam) {
          return {
            behavior: 'allow',
            updatedInput: {
              ...input,
              team_name: inferredTeam,
            }
          };
        }
      }
    }
    return { behavior: 'allow', updatedInput: input };
  }

  if (pathForTrust && deps.trustChecker) {
    const trustStatus = deps.trustChecker(pathForTrust);
    if (!trustStatus.trusted) {
      deps.logSecurity('[canUseTool] Workspace not trusted, denying tool:', { toolName });
      return {
        behavior: 'deny',
        message: 'Workspace is not trusted. Please trust the workspace to use AI tools.'
      };
    }

    if (trustStatus.mode === 'bypass-all') {
      deps.logSecurity('[canUseTool] Bypass-all mode, auto-approving tool:', { toolName });
      return { behavior: 'allow', updatedInput: input };
    }

    if (trustStatus.mode === 'allow-all' && ALLOW_ALL_FILE_EDIT_TOOLS.includes(toolName)) {
      deps.logSecurity('[canUseTool] Allow-all mode, auto-approving file tool:', { toolName });
      return { behavior: 'allow', updatedInput: input };
    }
  }

  return null;
}
