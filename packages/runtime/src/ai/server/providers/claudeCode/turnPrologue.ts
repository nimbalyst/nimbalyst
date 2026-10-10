/**
 * The setup half of `ClaudeCodeProvider.sendMessage()`: everything between the
 * caller's arguments and the first chunk off the SDK.
 *
 * Split in two because the original code is split in two by a `try`:
 *
 *   `resolveTurnPaths` / `prepareTurnAttachments` run BEFORE the try block, so a
 *                        throw escapes sendMessage instead of becoming an error
 *                        chunk. They read the arguments and return the derived
 *                        values; the provider performs its own field
 *                        assignments at the call site, where they stay visible.
 *
 *   `buildTurnQuery`     runs INSIDE the try, so a throw here becomes the
 *                        error/complete pair the epilogue emits. It needs a lot
 *                        of the provider, which arrives as an explicit
 *                        `TurnQueryHost` object literal rather than `this`.
 *
 * Neither yields. That is the reason they can be ordinary async functions while
 * the epilogue and chunk loop have to be async generators.
 */

import os from 'os';
import path from 'path';

import type { DocumentContext } from '../../types';
import type { MetaAgentWorkflowPreset } from '../../../prompt';
import { describeUnusableWorkspacePath } from '../workspacePreconditions';
import { findAttachmentDenyRule } from '../../attachments/attachmentDenyMatcher';
import {
  appendFailedAttachmentNotice,
  appendLargeAttachmentInstructions,
  buildMessageWithDocumentContext,
  prepareClaudeCodeAttachments,
  type PreparedClaudeAttachments,
} from './messagePreparation';
import { ClaudeCodeDeps } from './dependencyInjection';
import { resolveEffectiveSessionMode } from './resolveEffectiveSessionMode';
import { ClaudeCodeTranscriptAdapter } from './ClaudeCodeTranscriptAdapter';
import { buildSdkOptions, type BuildSdkOptionsDeps, type BuildSdkOptionsResult } from './sdkOptionsBuilder';
import { SDK_NATIVE_TOOLS } from './toolPolicy';
import type { TurnState } from './turnState';

/** Text attachments above this go to a file on disk instead of inline in the prompt. */
const LARGE_ATTACHMENT_CHAR_THRESHOLD = 10000;

/** Rolling cap on captured subprocess stderr. */
const MAX_STDERR_LINES = 50;

type SessionMode = 'planning' | 'agent' | 'auto';

type TrustStatus = {
  trusted: boolean;
  mode: 'ask' | 'allow-all' | 'bypass-all' | null;
  allowAllUsesClassifier?: boolean;
};

export interface ResolvedTurnPaths {
  /**
   * Session mode after the trust-level upgrade. The provider assigns this to
   * both `currentMode` and `requestedMode`.
   */
  currentMode: SessionMode;
  /** The path the trust lookup used; worktree sessions point at the parent project. */
  pathForTrust: string | undefined;
  /** Parent-project path for permission lookups (worktree sessions). */
  permissionsPath: string | undefined;
  /** Parent-project path for MCP config lookup — `.mcp.json` is keyed by it. */
  mcpConfigWorkspacePath: string | undefined;
}

/**
 * Resolve the turn's session mode and the paths derived from documentContext.
 *
 * Synchronous on purpose: the provider assigns `currentMode` / `pathForTrust`
 * from it before the first await of the turn, which is where they were assigned
 * when this lived inline.
 */
export function resolveTurnPaths(params: {
  documentContext?: DocumentContext;
  workspacePath?: string;
  /** `BaseAgentProvider.trustChecker`, passed in so this stays free of provider statics. */
  trustChecker: ((workspacePath: string) => TrustStatus) | null;
}): ResolvedTurnPaths {
  const { documentContext, workspacePath, trustChecker } = params;

  // Trust-level upgrade: when workspace permission is "Allow All" (internal
  // mode 'bypass-all') and session mode is 'agent', the session is upgraded
  // to 'auto' so the SDK classifier handles permissions instead of Nimbalyst
  // bypassing everything. This is now OPT-IN per workspace (issue #628): by
  // default "Allow All" means literal allow-all and no upgrade happens. Plan
  // mode is never upgraded — it always uses the SDK's native read-only
  // enforcement.
  let currentMode: SessionMode = (documentContext as any)?.mode || 'agent';
  const pathForTrust = (documentContext as any)?.permissionsPath || workspacePath;
  if (currentMode === 'agent' && pathForTrust && trustChecker) {
    currentMode = resolveEffectiveSessionMode(currentMode, trustChecker(pathForTrust));
  }

  return {
    currentMode,
    pathForTrust,
    // For worktree sessions these point at the parent project: permissions are
    // looked up there, and `.mcp.json` / `~/.claude.json` project entries are
    // keyed by the parent path. Both arrive via documentContext from AIService.
    permissionsPath: (documentContext as any)?.permissionsPath || workspacePath,
    mcpConfigWorkspacePath: (documentContext as any)?.mcpConfigWorkspacePath || workspacePath,
  };
}

export interface PreparedTurnAttachments {
  staging: { root: string; mode: 'temp' | 'workspace' | 'custom' };
  /** Set when the attachment staging directory matches a deny rule, for the pre-flight notice. */
  preflightAttachmentDenyRule: string | null;
  imageContentBlocks: PreparedClaudeAttachments['imageContentBlocks'];
  documentContentBlocks: PreparedClaudeAttachments['documentContentBlocks'];
  largeAttachmentFilePaths: PreparedClaudeAttachments['largeAttachmentFilePaths'];
  failedAttachments: PreparedClaudeAttachments['failedAttachments'];
}

/**
 * Stage the turn's attachments: compress images, spill oversized text to disk,
 * and pre-flight the staging directory against the workspace deny rules.
 *
 * Runs outside sendMessage's try block, matching the original placement: a
 * failure staging attachments is a caller-visible throw, not a streamed error.
 */
export async function prepareTurnAttachments(params: {
  sessionId?: string;
  workspacePath?: string;
  attachments?: any[];
}): Promise<PreparedTurnAttachments> {
  const { sessionId, workspacePath, attachments } = params;

  const staging = workspacePath && ClaudeCodeDeps.attachmentStagingLoader
    ? ClaudeCodeDeps.attachmentStagingLoader(workspacePath)
    : { root: os.tmpdir(), mode: 'temp' as const };

  let preflightAttachmentDenyRule: string | null = null;
  if (attachments?.length && workspacePath && ClaudeCodeDeps.attachmentDenyRulesLoader) {
    try {
      const denyRules = await ClaudeCodeDeps.attachmentDenyRulesLoader(workspacePath);
      preflightAttachmentDenyRule = findAttachmentDenyRule(
        path.join(staging.root, 'nimbalyst-attachment-preflight'),
        denyRules,
      );
    } catch (error) {
      console.warn('[CLAUDE-CODE] Attachment deny pre-flight failed:', error);
    }
  }

  const {
    imageContentBlocks,
    documentContentBlocks,
    largeAttachmentFilePaths,
    failedAttachments,
  } = await prepareClaudeCodeAttachments({
    attachments,
    largeAttachmentCharThreshold: LARGE_ATTACHMENT_CHAR_THRESHOLD,
    imageCompressor: ClaudeCodeDeps.imageCompressor || undefined,
    stagingRoot: staging.root,
    stagingMode: staging.mode,
    sessionId,
  });

  return {
    staging,
    preflightAttachmentDenyRule,
    imageContentBlocks,
    documentContentBlocks,
    largeAttachmentFilePaths,
    failedAttachments,
  };
}

/**
 * The `ClaudeCodeProvider` members `buildTurnQuery` actually uses.
 *
 * An object literal of this type is built at the call site, so a missed or
 * renamed member is a compile error rather than a runtime `undefined is not a
 * function` on a path that only some turns take.
 */
export interface TurnQueryHost {
  /** 'meta-agent' selects the restricted tool set and prompt. */
  getAgentRole(sessionId?: string): Promise<'standard' | 'meta-agent'>;
  getWorkflowPreset(sessionId?: string): Promise<MetaAgentWorkflowPreset>;
  /** Resolves and freezes the git snapshot; must be awaited before buildSystemPrompt (#1177). */
  ensureGitContext(workspacePath?: string): Promise<void>;
  /** Resolves and freezes `metadata.sessionDirective`; must be awaited before buildSystemPrompt. */
  ensureSessionDirective(sessionId?: string): Promise<void>;
  buildSystemPrompt(
    documentContext: DocumentContext | undefined,
    enableAgentTeams: boolean,
    isMetaAgent: boolean,
    workflowPreset: MetaAgentWorkflowPreset,
  ): string;
  emit(event: string, payload: unknown): void;
  withPromptProvenanceMetadata(documentContext?: DocumentContext): Record<string, any>;
  logAgentMessage(
    sessionId: string,
    provider: string,
    direction: 'input' | 'output',
    content: string,
    metadata?: Record<string, any>,
    hidden?: boolean,
    providerMessageId?: string,
    searchable?: boolean,
  ): Promise<void>;

  // --- forwarded straight into buildSdkOptions ------------------------------
  resolveModelVariant(): string;
  getMcpServersSnapshot(params: {
    sessionId?: string;
    workspacePath: string;
    profile?: 'standard' | 'meta-agent';
  }): Promise<Record<string, any>>;
  createCanUseToolHandler(sessionId?: string, workspacePath?: string, permissionsPath?: string): any;
  toolHooksService: BuildSdkOptionsDeps['toolHooksService'];
  teammateManager: BuildSdkOptionsDeps['teammateManager'];
  sessions: BuildSdkOptionsDeps['sessions'];
  config: BuildSdkOptionsDeps['config'];
  abortController: AbortController;
  currentMode: SessionMode | undefined;
  /** `BaseAgentProvider.META_AGENT_ALLOWED_TOOLS` (a protected static). */
  metaAgentAllowedTools: readonly string[];
  /**
   * Publish the prompt controller and helper method on the provider the moment
   * buildSdkOptions returns, not when this function does. `abort()` and the
   * stream-closed diagnostics read `promptController`, and the input logging
   * below awaits — so a later assignment would leave the previous turn's
   * controller visible across that await.
   */
  publishSdkResult(result: BuildSdkOptionsResult): void;
}

export interface BuildTurnQueryParams {
  documentContext?: DocumentContext;
  sessionId?: string;
  workspacePath?: string;
  attachments?: any[];
  paths: ResolvedTurnPaths;
  prepared: PreparedTurnAttachments;
}

export interface TurnQuerySetup extends BuildSdkOptionsResult {
  /** Null when there is no session to attribute the transcript to. */
  transcriptAdapter: ClaudeCodeTranscriptAdapter | null;
  /** Captured before the input logging, so diagnostics measure the whole turn. */
  queryStartTime: number;
  /** True when the meta-agent tool restrictions were applied. */
  isMetaAgent: boolean;
}

/**
 * Rewrite the prompt, build the system prompt and SDK options, log the turn's
 * input, and return everything the caller needs to start `query()`.
 *
 * Mutates `state.message`, `state.isSlashCommand` and `state.spawnDiagContext`.
 */
export async function buildTurnQuery(
  host: TurnQueryHost,
  state: TurnState,
  params: BuildTurnQueryParams,
): Promise<TurnQuerySetup> {
  const { documentContext, sessionId, workspacePath, attachments, paths, prepared } = params;

  // Append document context to message using pre-built prompts from DocumentContextService
  // Skip adding system message if the prompt starts with a slash command
  state.isSlashCommand = state.message.trimStart().startsWith('/');
  const messageWithContext = buildMessageWithDocumentContext({
    message: state.message,
    isSlashCommand: state.isSlashCommand,
    documentContextPrompt: (documentContext as any)?.documentContextPrompt,
    editingInstructions: (documentContext as any)?.editingInstructions,
  });
  const userMessageAddition = messageWithContext.userMessageAddition;
  state.message = messageWithContext.messageWithContext;

  // Add large attachment file paths to system message
  // These are text attachments over 10k chars that were written to /tmp
  state.message = appendLargeAttachmentInstructions(state.message, prepared.largeAttachmentFilePaths);
  state.message = appendFailedAttachmentNotice(state.message, prepared.failedAttachments);

  // Load env vars from ~/.claude/settings.json early so they're available for both
  // system prompt building (agent teams flag) and SDK environment setup
  let settingsEnv: Record<string, string> = {};
  if (ClaudeCodeDeps.claudeSettingsEnvLoader) {
    try {
      settingsEnv = await ClaudeCodeDeps.claudeSettingsEnvLoader();
    } catch (error) {
      console.warn('[CLAUDE-CODE] Failed to load settings env vars:', error);
    }
  }

  // Load shell environment vars (AWS credentials, NODE_EXTRA_CA_CERTS, etc.)
  // These fill in env vars that are missing from Electron's minimal environment
  // when launched from Dock/Finder instead of terminal
  let shellEnv: Record<string, string> = {};
  if (ClaudeCodeDeps.shellEnvironmentLoader) {
    try {
      shellEnv = ClaudeCodeDeps.shellEnvironmentLoader() || {};
    } catch (error) {
      console.warn('[CLAUDE-CODE] Failed to load shell environment:', error);
    }
  }

  // Build system prompt (no longer contains document context)
  const enableAgentTeams = settingsEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1';
  const isMetaAgent = (await host.getAgentRole(sessionId)) === 'meta-agent';
  const workflowPreset = isMetaAgent ? await host.getWorkflowPreset(sessionId) : 'default';
  // Resolve-and-freeze the git snapshot before the (synchronous) prompt
  // build. First turn pays the git call; every later turn reads the frozen
  // value, which is what keeps the prompt byte-stable (#1177).
  // workspacePath is the CLI's cwd (see buildSdkOptions), so it is also the
  // repo the suppressed CLI block would have described.
  await host.ensureGitContext(workspacePath);
  await host.ensureSessionDirective(sessionId);
  const systemPrompt = host.buildSystemPrompt(documentContext, enableAgentTeams, isMetaAgent, workflowPreset);

  // Note: Attachments (images/documents) are NOT added to the message text.
  // They're sent as separate content blocks via the API's multimodal format.
  // We only show what's actually appended to the user's text message.

  // Emit prompt additions for debugging UI
  // Only emit for user-initiated messages, not hidden/auto-triggered commands like /context
  // This prevents auto-commands from overwriting the user's prompt additions data
  const hasAttachments = attachments && attachments.length > 0;
  if (!state.hideMessages && sessionId && (systemPrompt || userMessageAddition || hasAttachments)) {
    // Build attachment summaries (don't include full base64 data, just metadata)
    const attachmentSummaries = attachments?.map(att => ({
      type: att.type,
      filename: att.filename || (att.filepath ? path.basename(att.filepath) : 'unknown'),
      mimeType: att.mimeType,
      filepath: att.filepath
    })) || [];

    host.emit('promptAdditions', {
      sessionId,
      systemPromptAddition: systemPrompt || null,
      userMessageAddition: userMessageAddition,
      attachments: attachmentSummaries,
      timestamp: Date.now()
    });
  }

  // Require a workspace path that still exists on disk. Without this the
  // Agent SDK spawns into a dead cwd and misreports the ENOENT as a
  // libc/musl mismatch on the bundled binary.
  const unusableWorkspace = describeUnusableWorkspacePath(workspacePath);
  if (unusableWorkspace || !workspacePath) {
    throw new Error(unusableWorkspace ?? 'No project folder is set for this session.');
  }

  // Build SDK options (settings, MCP config, env, session resumption, prompt input)
  const sdkResult = await buildSdkOptions(
    {
      resolveModelVariant: () => host.resolveModelVariant(),
      getMcpServersSnapshot: (options) => host.getMcpServersSnapshot(options),
      createCanUseToolHandler: (sid, wp, pp) => host.createCanUseToolHandler(sid, wp, pp),
      toolHooksService: host.toolHooksService,
      teammateManager: host.teammateManager,
      sessions: host.sessions,
      config: host.config,
      abortController: host.abortController,
    },
    {
      message: state.message,
      workspacePath,
      sessionId,
      documentContext,
      settingsEnv,
      shellEnv,
      systemPrompt,
      currentMode: host.currentMode,
      imageContentBlocks: prepared.imageContentBlocks,
      documentContentBlocks: prepared.documentContentBlocks,
      permissionsPath: paths.permissionsPath,
      mcpConfigWorkspacePath: paths.mcpConfigWorkspacePath,
      isMetaAgent,
    }
  );
  host.publishSdkResult(sdkResult);
  const { options } = sdkResult;
  state.spawnDiagContext = { binaryPath: options.pathToClaudeCodeExecutable, cwd: options.cwd };

  // Meta-agent: the profile-specific MCP map was frozen by buildSdkOptions
  // through getMcpServersSnapshot; only native-tool restrictions remain here.
  if (isMetaAgent) {
    const allowedSet = new Set(host.metaAgentAllowedTools);
    const blockedNativeTools = SDK_NATIVE_TOOLS.filter(t => !allowedSet.has(t));
    (options as any).allowedTools = host.metaAgentAllowedTools;
    (options as any).disallowedTools = blockedNativeTools;
    (options as any).blockedTools = blockedNativeTools;
  }

  const queryStartTime = Date.now();

  // Log the raw input to the SDK (include attachments and mode in metadata for UI restoration)
  if (sessionId) {
    const metadataToLog: Record<string, any> = host.withPromptProvenanceMetadata(documentContext);
    if (attachments && attachments.length > 0) {
      metadataToLog.attachments = attachments;
    }
    if (documentContext?.mode) {
      metadataToLog.mode = documentContext.mode;
    }
    const teammateMatch = state.message.match(/^\[Teammate message from "([^"]+)"\]/);
    if (teammateMatch) {
      metadataToLog.messageType = 'teammate_message_injected';
      metadataToLog.teammateName = teammateMatch[1];
    }
    await host.logAgentMessage(sessionId, 'claude-code', 'input', JSON.stringify({
      prompt: state.message,
      options: {
        model: options.model,
        cwd: options.cwd,
        resume: options.resume,
        systemPrompt: options.systemPrompt,
        settingSources: options.settingSources,
        mcpServers: options.mcpServers ? Object.keys(options.mcpServers) : [],
        allowedTools: options.allowedTools,
        disallowedTools: options.disallowedTools,
        permissionMode: options.permissionMode,
        thinking: options.thinking
      }
    }), metadataToLog, state.hideMessages, undefined, true /* searchable */);

    if (prepared.preflightAttachmentDenyRule && !state.hideMessages) {
      const firstAttachment = attachments?.[0];
      await host.logAgentMessage(sessionId, 'claude-code', 'output', JSON.stringify({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Read',
        tool_input: { file_path: firstAttachment?.filepath ?? prepared.staging.root },
        decision_reason: `Attachment staging matches ${prepared.preflightAttachmentDenyRule}`,
        decision_reason_type: 'rule',
        message: `Claude Code may be unable to read ${firstAttachment?.filename ?? 'this attachment'} because ${prepared.preflightAttachmentDenyRule} denies its staging directory.`,
        is_attachment_staging_denied: true,
        attachment_path: firstAttachment?.filepath ?? prepared.staging.root,
        attachment_filename: firstAttachment?.filename ?? 'attachment',
        attachment_staging_mode: prepared.staging.mode,
        attachment_deny_rule: prepared.preflightAttachmentDenyRule,
        attachment_detection: 'preflight',
      }), undefined, false, undefined, true);
    }
  }

  // Create transcript adapter as chunk parser (returns ParsedItems for the streaming loop).
  // Canonical events are written by the TranscriptTransformer from raw ai_agent_messages.
  const transcriptAdapter = sessionId
    ? new ClaudeCodeTranscriptAdapter(null, sessionId)
    : null;

  // Canonical transcript: user message
  transcriptAdapter?.userMessage(
    state.message,
    documentContext?.mode === 'planning' ? 'planning' : 'agent',
    attachments as any,
  );

  // Wire up stderr capture so process exit errors include diagnostic context.
  options.stderr = (data: string) => {
    state.stderrLines.push(data);
    if (state.stderrLines.length > MAX_STDERR_LINES) {
      state.stderrLines.shift();
    }
    // Log stderr in real-time for diagnostics (native binary crashes)
    const trimmed = data.trim();
    if (trimmed) {
      console.warn(`[CLAUDE-CODE-STDERR] ${trimmed.substring(0, 300)}`);
    }
  };

  return { ...sdkResult, transcriptAdapter, queryStartTime, isMetaAgent };
}
