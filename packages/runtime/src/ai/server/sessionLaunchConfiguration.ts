import {
  DEFAULT_THINKING_MODE,
  EFFORT_LEVELS,
  normalizeEffortForModel,
  supportedEffortLevelsForModel,
  supportsThinkingModeForModel,
  type EffortLevel,
  type ThinkingMode,
} from './effortLevels';

export const SESSION_LAUNCH_TOOL_SCOPES = ['read', 'write', 'full'] as const;
export const SESSION_LAUNCH_EFFORT_LEVELS = EFFORT_LEVELS.map(({ key }) => key);
export const SESSION_LAUNCH_THINKING_MODES = ['enabled', 'disabled'] as const;

export type SessionLaunchToolScope = (typeof SESSION_LAUNCH_TOOL_SCOPES)[number];
export type SessionLaunchValueSource =
  | 'requested'
  | 'inherited'
  | 'app-default'
  | 'provider-default'
  | 'default';
export type SessionLaunchWorktreeMode = 'existing' | 'new' | 'inherited' | 'none';

export interface RequestedSessionLaunchConfiguration {
  provider: string | null;
  model: string | null;
  effortLevel: EffortLevel | null;
  thinkingMode: ThinkingMode | null;
  toolScope: SessionLaunchToolScope | null;
  inheritModel: boolean;
  isolated: boolean;
  useWorktree: boolean;
  notifyOnComplete: boolean | null;
}

export interface ResolvedSessionLaunchConfiguration {
  provider: string;
  model: string;
  effortLevel: EffortLevel | null;
  thinkingMode: ThinkingMode | null;
  toolScope: SessionLaunchToolScope;
  isolated: boolean;
  worktreeMode: SessionLaunchWorktreeMode;
  notifyOnComplete: boolean;
  sources: {
    provider: SessionLaunchValueSource;
    model: SessionLaunchValueSource;
    effortLevel: SessionLaunchValueSource | null;
    thinkingMode: SessionLaunchValueSource | null;
    toolScope: SessionLaunchValueSource;
  };
}

export interface SessionLaunchConfiguration {
  requested: RequestedSessionLaunchConfiguration;
  resolved: ResolvedSessionLaunchConfiguration;
  effectiveness: 'not-provider-confirmed';
}

export interface ResolveSessionReasoningInput {
  provider: string;
  model: string;
  effortLevel?: unknown;
  thinkingMode?: unknown;
  appDefaultEffortLevel?: EffortLevel;
}

export interface ResolvedSessionReasoning {
  requestedEffortLevel: EffortLevel | null;
  requestedThinkingMode: ThinkingMode | null;
  effortLevel: EffortLevel | null;
  thinkingMode: ThinkingMode | null;
  effortLevelSource: SessionLaunchValueSource | null;
  thinkingModeSource: SessionLaunchValueSource | null;
}

function parseOptionalEffortLevel(value: unknown): EffortLevel | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string'
    || !SESSION_LAUNCH_EFFORT_LEVELS.includes(value as EffortLevel)
  ) {
    throw new Error(
      `Invalid effortLevel ${JSON.stringify(value)}. Expected one of: ${SESSION_LAUNCH_EFFORT_LEVELS.join(', ')}`
    );
  }
  return value as EffortLevel;
}

function parseOptionalThinkingMode(value: unknown): ThinkingMode | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string'
    || !SESSION_LAUNCH_THINKING_MODES.includes(value as ThinkingMode)
  ) {
    throw new Error(
      `Invalid thinkingMode ${JSON.stringify(value)}. Expected one of: ${SESSION_LAUNCH_THINKING_MODES.join(', ')}`
    );
  }
  return value as ThinkingMode;
}

export function parseSessionLaunchToolScope(value: unknown): SessionLaunchToolScope {
  if (value === undefined || value === null) return 'full';
  if (
    typeof value !== 'string'
    || !SESSION_LAUNCH_TOOL_SCOPES.includes(value as SessionLaunchToolScope)
  ) {
    throw new Error(
      `Invalid toolScope ${JSON.stringify(value)}. Expected one of: ${SESSION_LAUNCH_TOOL_SCOPES.join(', ')}`
    );
  }
  return value as SessionLaunchToolScope;
}

/**
 * Validate requested reasoning controls against the resolved provider/model,
 * then resolve application defaults without claiming provider effectiveness.
 */
export function resolveSessionReasoningConfiguration(
  input: ResolveSessionReasoningInput
): ResolvedSessionReasoning {
  const requestedEffortLevel = parseOptionalEffortLevel(input.effortLevel);
  const requestedThinkingMode = parseOptionalThinkingMode(input.thinkingMode);
  const supportsEffort =
    input.provider === 'openai-codex' || input.provider === 'claude-code';
  const supportedEffortLevels = supportsEffort
    ? supportedEffortLevelsForModel(input.model)
    : [];

  if (
    requestedEffortLevel
    && !supportedEffortLevels.some(({ key }) => key === requestedEffortLevel)
  ) {
    const supportedDescription = supportedEffortLevels.length > 0
      ? supportedEffortLevels.map(({ key }) => key).join(', ')
      : 'none';
    throw new Error(
      `effortLevel ${JSON.stringify(requestedEffortLevel)} is not supported for ${input.provider} model ${input.model}. Supported values: ${supportedDescription}`
    );
  }

  const supportsThinkingMode =
    input.provider === 'claude-code' && supportsThinkingModeForModel(input.model);
  if (requestedThinkingMode && !supportsThinkingMode) {
    throw new Error(
      `thinkingMode is not supported for ${input.provider} model ${input.model}`
    );
  }

  let effortLevel: EffortLevel | null = null;
  let effortLevelSource: SessionLaunchValueSource | null = null;
  if (requestedEffortLevel) {
    effortLevel = requestedEffortLevel;
    effortLevelSource = 'requested';
  } else if (supportedEffortLevels.length > 0 && input.appDefaultEffortLevel) {
    effortLevel = normalizeEffortForModel(input.model, input.appDefaultEffortLevel);
    effortLevelSource = 'app-default';
  }

  const thinkingMode = supportsThinkingMode
    ? requestedThinkingMode ?? DEFAULT_THINKING_MODE
    : null;
  const thinkingModeSource = supportsThinkingMode
    ? requestedThinkingMode
      ? 'requested' as const
      : 'provider-default' as const
    : null;

  return {
    requestedEffortLevel,
    requestedThinkingMode,
    effortLevel,
    thinkingMode,
    effortLevelSource,
    thinkingModeSource,
  };
}

export function isSessionLaunchConfiguration(
  value: unknown
): value is SessionLaunchConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<SessionLaunchConfiguration>;
  if (
    !candidate.requested
    || typeof candidate.requested !== 'object'
    || !candidate.resolved
    || typeof candidate.resolved !== 'object'
    || candidate.effectiveness !== 'not-provider-confirmed'
  ) {
    return false;
  }
  const resolved = candidate.resolved as Partial<ResolvedSessionLaunchConfiguration>;
  return Boolean(
    typeof resolved.provider === 'string'
    && typeof resolved.model === 'string'
    && typeof resolved.toolScope === 'string'
    && typeof resolved.isolated === 'boolean'
    && typeof resolved.worktreeMode === 'string'
    && typeof resolved.notifyOnComplete === 'boolean'
    && resolved.sources
    && typeof resolved.sources === 'object'
  );
}
