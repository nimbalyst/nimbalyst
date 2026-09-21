import type { SessionOptions } from '../ProtocolInterface';
import type { ThreadStartParams } from './types';
import { resolveCodexPermissionProfile } from '../codexPermissionProfile';
import { clampEffortLevel, parseEffortLevel } from '../../effortLevels';

export function buildCodexThreadStartParams(options: SessionOptions): ThreadStartParams {
  const permissionProfile = resolveCodexPermissionProfile(
    options.permissionMode,
    options.raw?.agentVerified === true,
  );

  const effortLevel = options.raw?.effortLevel as string | undefined;
  // Clamp to what this model's catalog entry accepts: gpt-5.4/5.5 stop at
  // xhigh, gpt-5.6-luna at max, and only Astra/Sol/Terra reach ultra.
  const reasoningEffortRaw = clampEffortLevel(
    parseEffortLevel(effortLevel ?? 'high'),
    options.model ?? undefined,
  );

  const systemPrompt = (options.raw?.systemPrompt as string | undefined) ?? options.systemPrompt;
  const additionalDirectories = Array.isArray(options.raw?.additionalDirectories)
    ? (options.raw?.additionalDirectories as unknown[]).filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0,
      )
    : [];

  // The free-form `config` object accepts the same dotted-path TOML overrides
  // the SDK transport sends as `--config` flags. We pass through the
  // existing host-computed overrides (which include `mcp_servers`,
  // `model_reasoning_effort`, network access, web_search, etc.) unchanged.
  const config: Record<string, unknown> = {
    ...(options.raw?.codexConfigOverrides as Record<string, unknown> | undefined ?? {}),
    // Reasoning effort always sets; the host's override map may also set it
    // but a literal here is fine since codex resolves these later.
    model_reasoning_effort: reasoningEffortRaw,
  };

  return {
    model: options.model ?? null,
    sandbox: permissionProfile.sandboxMode,
    cwd: options.workspacePath,
    approvalPolicy: permissionProfile.approvalPolicy,
    ...(permissionProfile.approvalsReviewer
      ? { approvalsReviewer: permissionProfile.approvalsReviewer }
      : {}),
    ephemeral: false,
    developerInstructions: systemPrompt,
    config,
    ...(additionalDirectories.length > 0
      ? { config: { ...config, 'sandbox_workspace_write.writable_roots': [...new Set(additionalDirectories)] } }
      : {}),
  };
}
