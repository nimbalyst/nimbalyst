import path from 'path';
import crypto from 'crypto';
import OpenAI from 'openai';
import { BaseAgentProvider } from './BaseAgentProvider';
import { buildUserMessageAddition } from './documentContextUtils';
import { buildClaudeCodeSystemPrompt, buildMetaAgentSystemPrompt, type MetaAgentWorkflowPreset } from '../../prompt';
import { DEFAULT_MODELS } from '../../modelConstants';
import { AIToolCall, AIToolResult } from '../../types';
import {
  ProviderConfig,
  DocumentContext,
  StreamChunk,
  ProviderCapabilities,
  AIModel,
  AIProviderType,
  ModelIdentifier,
  ChatAttachment,
} from '../types';
import { CodexSDKProtocol } from '../protocols/CodexSDKProtocol';
import { CodexAppServerProtocol, type CodexAppServerHostBindings } from '../protocols/CodexAppServerProtocol';
import { AgentProtocol, ProtocolEvent, ProtocolSession } from '../protocols/ProtocolInterface';
import { ToolPermissionService } from '../permissions/ToolPermissionService';
import { PermissionMode, TrustChecker, PermissionPatternSaver, PermissionPatternChecker, SecurityLogger } from './ProviderPermissionMixin';
import { CodexSdkModuleLike, loadCodexSdkModule } from './codex/codexSdkLoader';
import { resolvePackagedCodexBinaryPath } from './codex/codexBinaryPath';
import { McpConfigService } from '../services/McpConfigService';
import { getMcpConfigService, isInternalMcpServerEnabled } from '../services/mcpServerConfig';
import { MCPServerConfig } from '../../../types/MCPServerConfig';
import { safeJSONSerialize } from '../../../utils/serialization';
import { AskUserQuestionPrompt, AskUserQuestionPromptOption } from './shared/askUserQuestionTypes';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';
import { buildCodexToolLookupId } from '../toolLookupIds';
import { reverseCodexPatch, type CodexPatchKind } from './codex/patchReverse';

/**
 * Codex transport selection.
 *
 * - `sdk`: the original `@openai/codex-sdk`-driven `codex exec --experimental-json`
 *   flow. Stable, fully featured. Limitation: file_change events do not carry
 *   the patch diff text, so host-side pre-edit baselines race apply_patch.
 * - `app-server`: drives `codex app-server --listen stdio://` directly via
 *   JSON-RPC v2. Emits the full patch diff per file_change item, which lets us
 *   recover pre-edit content deterministically by reverse-applying hunks. This
 *   is the default end state -- see `nimbalyst-local/plans/codex-app-server-protocol-migration.md`.
 */
export type CodexTransport = 'sdk' | 'app-server';

/**
 * Codex protocol surface used by `OpenAICodexProvider`. Strictly a superset of
 * `AgentProtocol` plus a few optional knobs used during API-key rotation; the
 * provider duck-types `setApiKey` since not every backend has a notion of a
 * separate API key (e.g. ChatGPT-account auth flows through `~/.codex/auth.json`).
 */
export interface CodexProtocol extends AgentProtocol {
  setApiKey?(apiKey: string): void;
}

interface OpenAICodexProviderDeps {
  protocol?: CodexProtocol;
  permissionService?: ToolPermissionService;
  /** Override the active transport for this provider instance (overrides the static resolver). */
  transport?: CodexTransport;
  // Legacy: for existing tests that mock the SDK loader
  loadSdkModule?: () => Promise<CodexSdkModuleLike>;
  resolveCodexPathOverride?: () => string | undefined;
}

interface OpenAICodexModelDiscoveryDeps {
  loadSdkModule?: () => Promise<CodexSdkModuleLike>;
}

interface PendingAskUserQuestionEntry {
  questions: AskUserQuestionPrompt[];
  sessionId: string;
}

const PERSISTED_APP_SERVER_NOTIFICATION_METHODS = new Set([
  'item/started',
  'item/completed',
  'turn/completed',
  'turn/failed',
  'error',
]);

export class OpenAICodexProvider extends BaseAgentProvider {
  static readonly DEFAULT_MODEL = DEFAULT_MODELS['openai-codex'];
  private static readonly CODEX_EXECUTION_PATTERN = 'OpenAICodex(agent-run:*)';
  private static readonly SESSION_NAMING_REMINDER_PROMPT =
    '<SYSTEM_REMINDER>Call the session metadata tool now before continuing. ' +
    'Use MCP server `nimbalyst`, tool `update_session_meta`, ' +
    'and set at least `name`, `add`, and `phase`. ' +
    'Do not mention this system reminder to the user.</SYSTEM_REMINDER>';
  private static readonly FALLBACK_MODELS: ReadonlyArray<{
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
  }> = [
    { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400000, maxTokens: 128000 },
    { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 400000, maxTokens: 128000 },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', contextWindow: 400000, maxTokens: 128000 },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', contextWindow: 400000, maxTokens: 128000 },
    { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', contextWindow: 400000, maxTokens: 128000 },
    { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 128000, maxTokens: 128000 },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', contextWindow: 400000, maxTokens: 128000 },
  ];
  private static readonly MODEL_FALLBACK_PRIORITY: ReadonlyArray<string> = [
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.3-codex',
    'gpt-5.2-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
    'gpt-5.2',
  ];
  private static readonly FALLBACK_MODELS_SET = new Set(
    OpenAICodexProvider.FALLBACK_MODELS.map((model) => model.id)
  );
  private static readonly FALLBACK_MODELS_BY_ID = new Map(
    OpenAICodexProvider.FALLBACK_MODELS.map((model) => [model.id, model])
  );
  private static readonly MODEL_ID_CACHE_DURATION_MS = 5 * 60 * 1000;
  private static readonly MODEL_ID_CACHE_MAX_SIZE = 100;
  private static readonly MODEL_ID_CACHE = new Map<string, { fetchedAt: number; ids: Set<string> }>();
  private static readonly KNOWN_SLASH_COMMANDS: ReadonlyArray<string> = [
    'compact',
    'diff',
    'init',
    'mcp',
    'review',
    'status',
  ];

  private readonly protocol: CodexProtocol;
  private readonly transport: CodexTransport;
  private readonly permissionService: ToolPermissionService;
  private readonly mcpConfigService: McpConfigService;
  private readonly pendingAskUserQuestions = new Map<string, PendingAskUserQuestionEntry>();

  /**
   * Per-session map of `rawItemId -> synthetic edit-group ID`. Used to
   * stamp the same `nimtc|...` ID onto:
   *   1. raw message metadata (`editGroupId`) so CodexRawParser produces
   *      the same canonical providerToolCallId on later reparse, and
   *   2. tool_call streaming chunks (`toolCall.toolUseId`) so
   *      MessageStreamingHandler / SessionFileTracker dedupe and store
   *      the same ID at streaming time.
   *
   * Entries are cleared on item.completed for the corresponding raw item id
   * so a later turn that reuses `item_0` mints a fresh edit-group ID.
   */
  private readonly codexEditGroupIdsBySession = new Map<string, Map<string, string>>();
  private codexEditGroupCounter = 0;

  /**
   * Tracks which Codex `file_change` raw item IDs we've already taken a
   * pre-edit snapshot for, per session. The SDK emits `item.started` for
   * `file_change` twice (second observation has post-edit content), so we
   * dedupe and snapshot only on the first observation.
   */
  private readonly fileChangePreEditSnapshottedIds = new Map<string, Set<string>>();

  /**
   * Per-session dedupe state for app-server notifications that should only be
   * persisted once per turn/item. This protects the transcript pipeline from
   * duplicate `item/started` / `item/completed` / terminal turn notifications
   * without touching streaming text deltas, which can legitimately repeat the
   * same token content.
   */
  private readonly appServerNotificationDeduper = new Map<
    string,
    { turnId: string | null; seenKeys: Set<string> }
  >();

  /**
   * In-memory cache of live `ProtocolSession` objects, keyed by Nimbalyst
   * session id. This is the lifecycle the codex app-server protocol is designed
   * around: one child process per session, reused across turns. Without this
   * cache, every turn calls `protocol.resumeSession` which spawns a *new*
   * child, orphaning the previous one (the protocol does not own the threadId
   * persistence, so it has no way to know it has already spawned a child for
   * this session).
   *
   * `this.sessions` (`ProviderSessionManager`) is a separate, serializable
   * mapping of Nimbalyst session id -> codex thread id; that one persists
   * across Nimbalyst restarts so we can `resumeSession` after a relaunch.
   * `liveProtocolSessions` is in-memory only.
   */
  private readonly liveProtocolSessions = new Map<string, ProtocolSession>();

  // Analytics initialization data, captured during first sendMessage call
  private _initData: {
    model: string;
    mcpServerCount: number;
    isResumedThread: boolean;
    permissionMode: string | null;
    /** Which codex transport drove this session ('sdk' or 'app-server'). */
    transport: CodexTransport;
  } | null = null;

  // Internal Nimbalyst MCP-server enablement (ports, kill-switches, tokens) lives
  // in the shared `mcpServerConfig` registry now — see `getMcpConfigService`.

  // MCP config loader (injected from electron main process)
  // Returns merged user + workspace MCP servers
  private static mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null = null;

  // Claude settings env vars loader (injected from electron main process)
  // Reused by MCP config expansion logic for ${VAR} interpolation
  private static claudeSettingsEnvLoader: (() => Promise<Record<string, string>>) | null = null;

  // Shell environment loader (injected from electron main process)
  // Reused by MCP config expansion logic for ${VAR} interpolation
  private static shellEnvironmentLoader: (() => Record<string, string> | null) | null = null;

  // Enhanced PATH loader (injected from electron main process)
  // Returns a PATH string that includes common CLI installation locations
  // (Homebrew, nvm, volta, etc.) that are missing from Electron's minimal GUI PATH
  private static enhancedPathLoader: (() => string) | null = null;

  // SDK module loader (injected from electron main process for packaged builds)
  // In packaged builds, dynamic import('@openai/codex-sdk') fails because the
  // package isn't resolvable from within app.asar. This loader provides an
  // alternative resolution path using process.resourcesPath.
  private static sdkModuleLoader: (() => Promise<CodexSdkModuleLike>) | null = null;

  // Additional writable directories loader (injected from electron main process).
  // Returns paths like sibling worktrees and the parent project root that the
  // Codex SDK should pass to the CLI as --add-dir entries so workspace-write
  // sandbox does not block edits to those directories. Issue #37 problem 1.
  private static additionalDirectoriesLoader: ((workspacePath: string) => string[]) | null = null;

  // Codex PreToolUse hook config (injected from electron main process).
  // When set, every Codex session is configured with a PreToolUse hook
  // matching `^apply_patch$` that snapshots each affected file's pre-edit
  // content to a per-session sidecar dir BEFORE Codex applies the patch.
  // This is the only way to capture true pre-edit content reliably -- the
  // item.started disk-read races with Codex applying its patch synchronously,
  // especially in the first turn of a freshly-spawned session before
  // FileSnapshotCache has had a chance to seed. See codex PR #18391.
  //
  // Returns the absolute path to the bundled hook script, or undefined when
  // the host hasn't wired this up (e.g., tests or older electron builds).
  private static preEditHookScriptPathResolver: (() => string | undefined) | null = null;

  // Returns the absolute sidecar dir for a given session id. The hook script
  // reads this path from the NIMBALYST_PRE_EDIT_DIR env var and writes one
  // JSON file per affected path. The host reads from the same dir at
  // item.started to populate pre-edit baselines.
  private static preEditSidecarDirResolver: ((sessionId: string) => string | undefined) | null = null;

  // Resolves the active codex transport from settings at provider-construct
  // time. Each new session reads this anew, so a settings change between
  // sessions takes effect on the next session.
  //
  // Defaults to `sdk` when no resolver is registered (back-compat for unit
  // tests and pre-migration code paths).
  private static codexTransportResolver: (() => CodexTransport) | null = null;

  public static setCodexTransportResolver(resolver: (() => CodexTransport) | null): void {
    OpenAICodexProvider.codexTransportResolver = resolver;
  }

  // Host-supplied dispatcher that maps codex's server-to-client approval/
  // dynamic-tool RPCs onto Nimbalyst's permission system. Only consulted for
  // the `app-server` transport.
  private static appServerHostBindings: CodexAppServerHostBindings | null = null;

  public static setAppServerHostBindings(bindings: CodexAppServerHostBindings | null): void {
    OpenAICodexProvider.appServerHostBindings = bindings;
  }

  // Host-supplied auth gate. Returns whether OpenAI auth is currently required
  // (i.e. the user is signed out). Only consulted for the `app-server`
  // transport, before createSession/resumeSession. Lets the provider emit a
  // structured "sign in to continue" error chunk instead of spawning a child
  // that will fail with an opaque 401 from api.openai.com.
  private static codexAuthGate: (() => Promise<{ requiresOpenaiAuth: boolean }>) | null = null;

  public static setCodexAuthGate(gate: (() => Promise<{ requiresOpenaiAuth: boolean }>) | null): void {
    OpenAICodexProvider.codexAuthGate = gate;
  }

  constructor(config?: { apiKey?: string }, deps?: OpenAICodexProviderDeps) {
    super();
    const apiKey = config?.apiKey || '';

    // Resolve transport: explicit dep > registered resolver > default 'sdk'.
    // Captured at construct time; each new provider instance reads the
    // resolver anew so a settings change takes effect on the next session.
    //
    // The in-code default is 'sdk' so unit tests (and any future library
    // consumers) get the SDK transport without needing to spawn a codex
    // binary at construction. The Electron host overrides this via
    // `setCodexTransportResolver` to default to 'app-server' in production,
    // honoring the `aiProviders.openai-codex.transport` setting when set.
    this.transport =
      deps?.transport ?? OpenAICodexProvider.codexTransportResolver?.() ?? 'sdk';

    // Initialize protocol (or use injected for testing)
    // Support legacy loadSdkModule and resolveCodexPathOverride for existing tests
    if (deps?.protocol) {
      this.protocol = deps.protocol;
    } else if (this.transport === 'app-server') {
      this.protocol = new CodexAppServerProtocol({
        apiKey,
        resolveCodexPathOverride: resolvePackagedCodexBinaryPath,
        host: OpenAICodexProvider.appServerHostBindings ?? undefined,
        clientInfo: { name: 'nimbalyst', version: process.env.NIMBALYST_VERSION ?? '0.0.0' },
      });
    } else if (deps?.loadSdkModule || deps?.resolveCodexPathOverride) {
      const loadSdk = deps.loadSdkModule ?? loadCodexSdkModule;
      const resolveCodexPath = deps.resolveCodexPathOverride ?? resolvePackagedCodexBinaryPath;
      this.protocol = new CodexSDKProtocol(apiKey, loadSdk, resolveCodexPath);
    } else {
      this.protocol = new CodexSDKProtocol(
        apiKey,
        OpenAICodexProvider.sdkModuleLoader ?? loadCodexSdkModule,
        resolvePackagedCodexBinaryPath
      );
    }

    // Initialize permission service (or use injected for testing)
    if (deps?.permissionService) {
      this.permissionService = deps.permissionService;
    } else {
      // Validate required dependencies
      if (!BaseAgentProvider.trustChecker) {
        throw new Error('[OpenAICodexProvider] trustChecker must be set via setTrustChecker() before creating provider instances');
      }
      if (!BaseAgentProvider.permissionPatternSaver) {
        throw new Error('[OpenAICodexProvider] permissionPatternSaver must be set via setPermissionPatternSaver() before creating provider instances');
      }
      if (!BaseAgentProvider.permissionPatternChecker) {
        throw new Error('[OpenAICodexProvider] permissionPatternChecker must be set via setPermissionPatternChecker() before creating provider instances');
      }
      // TypeScript doesn't understand that the throw statements guarantee non-null here
      // Use type assertions after validation
      this.permissionService = new ToolPermissionService({
        trustChecker: BaseAgentProvider.trustChecker as TrustChecker,
        patternSaver: BaseAgentProvider.permissionPatternSaver as PermissionPatternSaver,
        patternChecker: BaseAgentProvider.permissionPatternChecker as PermissionPatternChecker,
        securityLogger: BaseAgentProvider.securityLogger ?? undefined,
        emit: this.emit.bind(this),
      });
    }

    this.mcpConfigService = getMcpConfigService({
      mcpConfigLoader: OpenAICodexProvider.mcpConfigLoader,
      claudeSettingsEnvLoader: OpenAICodexProvider.claudeSettingsEnvLoader,
      shellEnvironmentLoader: OpenAICodexProvider.shellEnvironmentLoader,
    });
  }

  getProviderName(): string {
    return 'openai-codex';
  }

  public static setTrustChecker(checker: TrustChecker | null): void {
    BaseAgentProvider.setTrustChecker(checker);
  }

  public static setPermissionPatternSaver(saver: PermissionPatternSaver | null): void {
    BaseAgentProvider.setPermissionPatternSaver(saver);
  }

  public static setPermissionPatternChecker(checker: PermissionPatternChecker | null): void {
    BaseAgentProvider.setPermissionPatternChecker(checker);
  }

  public static setSecurityLogger(logger: SecurityLogger | null): void {
    BaseAgentProvider.setSecurityLogger(logger);
  }

  // Internal MCP-server ports / kill-switches / extension+tracker loaders / auth
  // token are configured once via `configureMcpServers` (shared registry), not
  // per-provider setters.

  public static setMCPConfigLoader(loader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null): void {
    OpenAICodexProvider.mcpConfigLoader = loader;
  }

  public static setClaudeSettingsEnvLoader(loader: (() => Promise<Record<string, string>>) | null): void {
    OpenAICodexProvider.claudeSettingsEnvLoader = loader;
  }

  public static setShellEnvironmentLoader(loader: (() => Record<string, string> | null) | null): void {
    OpenAICodexProvider.shellEnvironmentLoader = loader;
  }

  public static setEnhancedPathLoader(loader: (() => string) | null): void {
    OpenAICodexProvider.enhancedPathLoader = loader;
  }

  public static setAdditionalDirectoriesLoader(loader: ((workspacePath: string) => string[]) | null): void {
    OpenAICodexProvider.additionalDirectoriesLoader = loader;
  }

  public static setSdkModuleLoader(loader: (() => Promise<CodexSdkModuleLike>) | null): void {
    OpenAICodexProvider.sdkModuleLoader = loader;
  }

  public static setPreEditHookScriptPathResolver(resolver: (() => string | undefined) | null): void {
    OpenAICodexProvider.preEditHookScriptPathResolver = resolver;
  }

  public static setPreEditSidecarDirResolver(resolver: ((sessionId: string) => string | undefined) | null): void {
    OpenAICodexProvider.preEditSidecarDirResolver = resolver;
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
    const apiKey = config.apiKey || '';
    if (this.protocol.setApiKey) {
      this.protocol.setApiKey(apiKey);
    }
  }

  private static readonly LEGACY_MODEL_ALIASES = new Set([
    'openai-codex:openai-codex-cli',
    'openai-codex-cli',
    'openai-codex:default',
    'default',
    'openai-codex:cli',
    'cli',
  ]);
  private static readonly MODEL_REPLACEMENTS = new Map<string, string>([
    ['gpt-5', 'gpt-5.2'],
    ['gpt-5-codex', 'gpt-5.4'],
    ['gpt-5.4-codex', 'gpt-5.4'],
    ['gpt-5-codex-mini', 'gpt-5.1-codex-mini'],
    ['gpt-5.2-codex-mini', 'gpt-5.2-codex'],
    ['gpt-5.2-codex-max', 'gpt-5.2-codex'],
    ['gpt-5-codex-max', 'gpt-5.1-codex-max'],
    ['gpt-5.1-codex', 'gpt-5.2-codex'],
    ['gpt-5.3-codex-mini', 'gpt-5.3-codex'],
    ['gpt-5.3-codex-max', 'gpt-5.3-codex'],
    ['codex-mini-latest', 'gpt-5.1-codex-mini'],
  ]);

  /**
   * Normalize a single model ID, mapping legacy aliases to the canonical form.
   */
  static normalizeModelSelection(modelId: string): string {
    const normalized = modelId.trim().toLowerCase();
    if (OpenAICodexProvider.LEGACY_MODEL_ALIASES.has(normalized)) {
      return 'openai-codex:gpt-5.5';
    }

    const parsed = ModelIdentifier.tryParse(modelId);
    const rawModelId = parsed && parsed.provider === 'openai-codex'
      ? parsed.model
      : modelId.replace(/^openai-codex:/, '');
    const replacement = OpenAICodexProvider.MODEL_REPLACEMENTS.get(rawModelId.toLowerCase());
    if (replacement) {
      return ModelIdentifier.create('openai-codex', replacement).combined;
    }

    return modelId;
  }

  /**
   * Normalize an array of model IDs, deduplicating after normalization.
   */
  static normalizeModelSelections(models: string[] | undefined): string[] | undefined {
    if (!Array.isArray(models)) {
      return models;
    }
    const result: string[] = [];
    for (const modelId of models) {
      const mapped = OpenAICodexProvider.normalizeModelSelection(modelId);
      if (!result.includes(mapped)) {
        result.push(mapped);
      }
    }
    return result;
  }

  static async getModels(
    apiKey?: string,
    deps?: OpenAICodexModelDiscoveryDeps,
  ): Promise<AIModel[]> {
    const sdkModels = await OpenAICodexProvider.getModelsFromSdk(apiKey, deps);
    const apiModels = await OpenAICodexProvider.getModelsFromOpenAI(apiKey);
    return OpenAICodexProvider.getPreferredModels(sdkModels, apiModels);
  }

  private static getFallbackModels() {
    return OpenAICodexProvider.FALLBACK_MODELS.map((model) => ({
      id: ModelIdentifier.create('openai-codex', model.id).combined,
      name: model.name,
      provider: 'openai-codex' as AIProviderType,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));
  }

  private static getPreferredModels(...sourceLists: AIModel[][]): AIModel[] {
    const metadataById = new Map<string, AIModel>();

    for (const sourceModels of sourceLists) {
      for (const sourceModel of sourceModels) {
        const rawId = OpenAICodexProvider.toRawModelId(sourceModel.id);
        if (!rawId) {
          continue;
        }
        if (!OpenAICodexProvider.FALLBACK_MODELS_SET.has(rawId)) {
          continue;
        }
        if (!metadataById.has(rawId)) {
          metadataById.set(rawId, sourceModel);
        }
      }
    }

    return OpenAICodexProvider.FALLBACK_MODELS.map((fallbackModel) => {
      const discovered = metadataById.get(fallbackModel.id);
      return {
        id: ModelIdentifier.create('openai-codex', fallbackModel.id).combined,
        name: discovered?.name || fallbackModel.name,
        provider: 'openai-codex' as AIProviderType,
        contextWindow: discovered?.contextWindow ?? fallbackModel.contextWindow,
        maxTokens: discovered?.maxTokens ?? fallbackModel.maxTokens,
      };
    });
  }

  private static async getModelsFromSdk(
    apiKey?: string,
    deps?: OpenAICodexModelDiscoveryDeps,
  ): Promise<AIModel[]> {
    const loadSdk = deps?.loadSdkModule ?? OpenAICodexProvider.sdkModuleLoader ?? loadCodexSdkModule;

    try {
      const sdkModule = await loadSdk();
      const sdkAsAny = sdkModule as any;
      const fetchers: Array<() => Promise<unknown>> = [];

      if (typeof sdkAsAny.listModels === 'function') {
        fetchers.push(() => Promise.resolve(sdkAsAny.listModels()));
      }
      if (typeof sdkAsAny.getModels === 'function') {
        fetchers.push(() => Promise.resolve(sdkAsAny.getModels()));
      }

      try {
        const codex = new sdkModule.Codex(apiKey ? { apiKey } : undefined) as any;
        if (typeof codex?.listModels === 'function') {
          fetchers.push(() => Promise.resolve(codex.listModels()));
        }
        if (typeof codex?.getModels === 'function') {
          fetchers.push(() => Promise.resolve(codex.getModels()));
        }
        if (codex?.models && typeof codex.models.list === 'function') {
          fetchers.push(() => Promise.resolve(codex.models.list()));
        }
      } catch {
        // Client construction can fail when the Codex CLI binary is unavailable.
      }

      // Try all fetchers in parallel, return first successful result
      const results = await Promise.allSettled(fetchers.map((fn) => fn()));
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const mapped = OpenAICodexProvider.mapSdkModelResult(result.value);
          if (mapped.length > 0) {
            return mapped;
          }
        }
      }
    } catch {
      // SDK is optional and may be unavailable in some environments.
      return [];
    }

    return [];
  }

  private static async getModelsFromOpenAI(apiKey?: string): Promise<AIModel[]> {
    if (!apiKey) {
      return [];
    }

    try {
      const availableIds = await OpenAICodexProvider.getAvailableModelIds(apiKey);
      if (availableIds.size === 0) {
        return [];
      }

      const models: AIModel[] = [];

      for (const fallbackModel of OpenAICodexProvider.FALLBACK_MODELS) {
        if (!availableIds.has(fallbackModel.id)) {
          continue;
        }
        models.push({
          id: ModelIdentifier.create('openai-codex', fallbackModel.id).combined,
          name: fallbackModel.name,
          provider: 'openai-codex' as AIProviderType,
          contextWindow: fallbackModel.contextWindow,
          maxTokens: fallbackModel.maxTokens,
        });
      }

      const extraCodexModelIds = Array.from(availableIds)
        .filter((id) => id.toLowerCase().includes('codex') && !OpenAICodexProvider.FALLBACK_MODELS_BY_ID.has(id))
        .sort((a, b) => a.localeCompare(b));

      for (const modelId of extraCodexModelIds) {
        models.push({
          id: ModelIdentifier.create('openai-codex', modelId).combined,
          name: modelId,
          provider: 'openai-codex' as AIProviderType,
        });
      }

      return models;
    } catch {
      // API model listing is best-effort; fall back to static catalog when unavailable.
      return [];
    }
  }

  private static async getAvailableModelIds(apiKey: string): Promise<Set<string>> {
    const cacheKey = OpenAICodexProvider.hashApiKey(apiKey);
    const now = Date.now();
    const cached = OpenAICodexProvider.MODEL_ID_CACHE.get(cacheKey);
    if (cached && now - cached.fetchedAt < OpenAICodexProvider.MODEL_ID_CACHE_DURATION_MS) {
      return cached.ids;
    }

    const openai = new OpenAI({ apiKey });
    const response = await openai.models.list();
    const ids = new Set(response.data.map((model) => model.id));

    // Implement LRU eviction
    if (OpenAICodexProvider.MODEL_ID_CACHE.size >= OpenAICodexProvider.MODEL_ID_CACHE_MAX_SIZE) {
      const oldestKey = OpenAICodexProvider.MODEL_ID_CACHE.keys().next().value;
      if (oldestKey) {
        OpenAICodexProvider.MODEL_ID_CACHE.delete(oldestKey);
      }
    }

    OpenAICodexProvider.MODEL_ID_CACHE.set(cacheKey, { fetchedAt: now, ids });
    return ids;
  }

  private static hashApiKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
  }

  private static mapSdkModelResult(rawModels: unknown): AIModel[] {
    const candidates = OpenAICodexProvider.extractModelCandidates(rawModels);
    const seen = new Set<string>();
    const models: AIModel[] = [];

    for (const candidate of candidates) {
      const normalized = OpenAICodexProvider.normalizeModelCandidate(candidate);
      if (!normalized) {
        continue;
      }
      if (seen.has(normalized.id)) {
        continue;
      }
      seen.add(normalized.id);
      models.push(normalized);
    }

    return models;
  }

  private static toRawModelId(modelId: string): string | null {
    const normalizedSelection = OpenAICodexProvider.normalizeModelSelection(modelId);
    const parsed = ModelIdentifier.tryParse(normalizedSelection);
    const rawModelId = parsed && parsed.provider === 'openai-codex'
      ? parsed.model
      : normalizedSelection.replace(/^openai-codex:/, '');
    return rawModelId || null;
  }

  private static extractModelCandidates(rawModels: unknown): unknown[] {
    if (Array.isArray(rawModels)) {
      return rawModels;
    }

    if (rawModels && typeof rawModels === 'object') {
      const container = rawModels as Record<string, unknown>;
      const candidateKeys = ['data', 'models', 'items'];
      for (const key of candidateKeys) {
        if (Array.isArray(container[key])) {
          return container[key] as unknown[];
        }
      }
    }

    return [];
  }

  private static normalizeModelCandidate(candidate: unknown): AIModel | null {
    const MAX_STRING_LENGTH = 256;
    const MAX_CONTEXT_WINDOW = 10_000_000;
    const MAX_TOKENS = 10_000_000;

    let modelId: string | undefined;
    let modelName: string | undefined;
    let contextWindow: number | undefined;
    let maxTokens: number | undefined;

    if (typeof candidate === 'string') {
      modelId = candidate;
    } else if (candidate && typeof candidate === 'object') {
      const entry = candidate as Record<string, unknown>;
      modelId = OpenAICodexProvider.readStringField(entry, ['id', 'model']);
      modelName = OpenAICodexProvider.readStringField(entry, ['displayName', 'display_name', 'name']);
      contextWindow = OpenAICodexProvider.readNumberField(entry, [
        'contextWindow',
        'context_window',
        'inputTokenLimit',
        'input_token_limit',
      ]);
      maxTokens = OpenAICodexProvider.readNumberField(entry, [
        'maxTokens',
        'max_tokens',
        'outputTokenLimit',
        'output_token_limit',
      ]);
    }

    if (!modelId) {
      return null;
    }

    const trimmed = modelId.trim();
    if (!trimmed || trimmed.length > MAX_STRING_LENGTH) {
      return null;
    }

    const parsed = ModelIdentifier.tryParse(trimmed);
    const rawId = parsed && parsed.provider === 'openai-codex'
      ? parsed.model
      : trimmed.replace(/^openai-codex:/, '');
    if (!rawId || rawId.length > MAX_STRING_LENGTH) {
      return null;
    }

    const validatedName = modelName?.trim();
    if (validatedName && validatedName.length > MAX_STRING_LENGTH) {
      return null;
    }

    if (contextWindow !== undefined && (contextWindow < 0 || contextWindow > MAX_CONTEXT_WINDOW)) {
      return null;
    }

    if (maxTokens !== undefined && (maxTokens < 0 || maxTokens > MAX_TOKENS)) {
      return null;
    }

    return {
      id: ModelIdentifier.create('openai-codex', rawId).combined,
      name: validatedName || rawId,
      provider: 'openai-codex' as AIProviderType,
      contextWindow,
      maxTokens,
    };
  }

  private static readStringField(
    source: Record<string, unknown>,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
    return undefined;
  }

  private static readNumberField(
    source: Record<string, unknown>,
    keys: string[],
  ): number | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
    }
    return undefined;
  }

  static getDefaultModel() {
    return this.DEFAULT_MODEL;
  }

  static getKnownSlashCommands(): string[] {
    return [...OpenAICodexProvider.KNOWN_SLASH_COMMANDS];
  }

  getName(): string {
    return 'openai-codex';
  }

  getDisplayName(): string {
    return 'OpenAI Codex';
  }

  getDescription(): string {
    return 'OpenAI Codex SDK agent provider with tool and streaming support';
  }

  getSlashCommands(): string[] {
    return OpenAICodexProvider.getKnownSlashCommands();
  }

  getProviderSessionData(sessionId: string): any {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return {
      providerSessionId,
      codexThreadId: providerSessionId,
    };
  }

  /**
   * Get initialization data for analytics tracking.
   * Returns session init properties captured during the most recent sendMessage call.
   */
  getInitData(): {
    model: string;
    mcpServerCount: number;
    isResumedThread: boolean;
    permissionMode: string | null;
  } | null {
    return this._initData;
  }

  async handleToolCall(
    toolCall: AIToolCall,
    _options?: {
      sessionId?: string;
      workingDirectory?: string;
    }
  ): Promise<AIToolResult> {
    if (!toolCall.name) {
      return {
        success: false,
        error: 'Tool name is required',
      };
    }

    try {
      const result = await this.executeToolCall(toolCall.name, toolCall.arguments ?? {});
      return {
        success: true,
        result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed';
      return {
        success: false,
        error: message,
        result: (error as any)?.toolResult,
      };
    }
  }

  async cancelStream(_sessionId?: string): Promise<void> {
    this.abort();
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: any[],
    workspacePath?: string,
    attachments?: ChatAttachment[]
  ): AsyncIterableIterator<StreamChunk> {
    if (!workspacePath) {
      yield { type: 'error', error: '[OpenAICodexProvider] workspacePath is required but was not provided' };
      return;
    }

    const agentRole = await this.getAgentRole(sessionId);
    const isMetaAgent = agentRole === 'meta-agent';
    const workflowPreset = isMetaAgent ? await this.getWorkflowPreset(sessionId) : 'default';
    const systemPrompt = this.buildSystemPrompt(documentContext, isMetaAgent, workflowPreset);
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, documentContext);
    const unsupportedAttachmentHints = attachments?.filter(
      (attachment) => attachment.type !== 'image' && attachment.type !== 'document'
    );
    const messageWithAttachmentHints = this.appendAttachmentHints(messageWithContext, unsupportedAttachmentHints);

    // Emit prompt additions for UI
    if (sessionId && (systemPrompt || userMessageAddition || (attachments?.length ?? 0) > 0)) {
      const attachmentSummaries =
        attachments?.map((attachment) => ({
          type: attachment.type,
          filename: attachment.filename || (attachment.filepath ? path.basename(attachment.filepath) : 'unknown'),
          mimeType: attachment.mimeType,
          filepath: attachment.filepath,
        })) ?? [];
      this.emit('promptAdditions', {
        sessionId,
        systemPromptAddition: systemPrompt || null,
        userMessageAddition,
        attachments: attachmentSummaries,
        timestamp: Date.now(),
      });
    }

    // Build prompt with system prompt and user message
    // Note: Never include conversation history when resuming threads - the SDK maintains thread state
    const prompt = this.buildCodexPrompt({
      systemPrompt,
      message: messageWithAttachmentHints,
      messages,
      shouldBootstrapFromHistory: false, // Always false - Codex SDK maintains thread history
    });

    if (sessionId) {
      const metadataToLog: Record<string, unknown> = {};
      if (attachments && attachments.length > 0) {
        metadataToLog.attachments = attachments;
      }
      if (documentContext?.mode) {
        metadataToLog.mode = documentContext.mode;
      }
      await this.logAgentMessageBestEffort(
        sessionId,
        'input',
        prompt,
        Object.keys(metadataToLog).length > 0 ? { metadata: metadataToLog } : undefined
      );
    }

    const permissionsPath = documentContext?.permissionsPath || workspacePath;
    const mcpConfigWorkspacePath = documentContext?.mcpConfigWorkspacePath || workspacePath;
    const abortController = new AbortController();
    this.abortController = abortController;

    let fullText = '';

    try {
      // Check permission using ToolPermissionService
      const permissionDecision = await this.requestCodexTurnPermission(
        sessionId,
        workspacePath,
        permissionsPath,
        abortController.signal
      );

      if (permissionDecision.decision !== 'allow') {
        yield {
          type: 'error',
          error: permissionDecision.reason || 'OpenAI Codex turn denied',
        };
        return;
      }

      // Get or create protocol session.
      //
      // Order of preference:
      //   1. A live cached `ProtocolSession` (same Nimbalyst process, prior
      //      turn already spawned the child). Reuse it -- this is the
      //      "one child per session" invariant the protocol assumes.
      //   2. A persisted thread id (`this.sessions.getSessionId`) from a prior
      //      Nimbalyst process. Call `resumeSession` to attach to it.
      //   3. Otherwise, `createSession`.
      const cachedLiveSession = sessionId ? this.liveProtocolSessions.get(sessionId) : undefined;
      const existingSessionId = this.sessions.getSessionId(sessionId || '');
      // console.log('[CODEX] Session lookup:', {
      //   sessionId,
      //   existingSessionId,
      //   action: cachedLiveSession ? 'REUSE' : (existingSessionId ? 'RESUME' : 'CREATE'),
      // });

      const mcpServers = await this.mcpConfigService.getMcpServersConfig({
        sessionId,
        workspacePath: mcpConfigWorkspacePath,
        profile: isMetaAgent ? 'meta-agent' : 'standard',
      });
      // update_session_meta folds into the eager core `nimbalyst` server (MCP
      // consolidation Phase 5); the naming reminder fires when it's present.
      const hasSessionNamingServer = Object.prototype.hasOwnProperty.call(
        mcpServers,
        'nimbalyst',
      );
      let usedSessionNamingToolThisTurn = false;

      // Build environment for the Codex CLI binary.
      // Electron GUI apps have a minimal process.env (missing docker, homebrew, nvm, etc.).
      // Merge in shell env vars and the enhanced PATH so the Codex agent can see system tools.
      let codexEnv = OpenAICodexProvider.buildCodexEnvironment();

      // Layer session-specific env vars for the PreToolUse hook. The hook
      // script reads NIMBALYST_PRE_EDIT_DIR to know where to write per-path
      // pre-edit snapshots, and ELECTRON_RUN_AS_NODE makes process.execPath
      // (an Electron binary) run as plain Node so we don't have to ship a
      // separate Node runtime. When the resolver isn't wired up (tests, older
      // electron builds) the hook is simply not configured.
      const sidecarDir = sessionId
        ? OpenAICodexProvider.preEditSidecarDirResolver?.(sessionId)
        : undefined;
      if (sidecarDir) {
        const baseEnv: Record<string, string> = codexEnv ? { ...codexEnv } : {};
        if (!codexEnv) {
          // No prior env override -- start from process.env minus undefineds.
          for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
              baseEnv[key] = value;
            }
          }
        }
        baseEnv.NIMBALYST_PRE_EDIT_DIR = sidecarDir;
        baseEnv.ELECTRON_RUN_AS_NODE = '1';
        codexEnv = baseEnv;
        // console.log('[CODEX] Pre-edit hook env configured:', { sessionId, sidecarDir });
      } else if (sessionId) {
        // console.log('[CODEX] Pre-edit hook sidecar dir resolver returned undefined', { sessionId });
      }

      const resolvedModel = await this.getConfiguredModel();

      // Sibling worktrees and the parent project root the agent is allowed to
      // write to, in addition to its workingDirectory. Without this, Codex's
      // workspace-write sandbox blocks orchestrator edits across worktrees and
      // `git rebase --continue` from inside a worktree (the .git common dir
      // sits outside the worktree). Issue #37 problem 1.
      const additionalDirectories = OpenAICodexProvider.additionalDirectoriesLoader
        ? OpenAICodexProvider.additionalDirectoriesLoader(workspacePath)
        : [];

      const sessionOptions = {
        workspacePath,
        model: resolvedModel,
        ...(permissionDecision.permissionMode ? { permissionMode: permissionDecision.permissionMode } : {}),
        mcpServers,
        ...(isMetaAgent ? {
          allowedTools: BaseAgentProvider.META_AGENT_ALLOWED_TOOLS,
          disallowedTools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent'].filter(t => !BaseAgentProvider.META_AGENT_ALLOWED_TOOLS.includes(t)),
        } : {}),
        raw: {
          systemPrompt,
          abortSignal: abortController.signal,
          codexConfigOverrides: this.buildCodexConfigOverrides(mcpServers),
          ...(codexEnv ? { codexEnv } : {}),
          ...(this.config?.effortLevel ? { effortLevel: this.config.effortLevel } : {}),
          ...(this.config?.serviceTier ? { serviceTier: this.config.serviceTier } : {}),
          ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
        },
      };

      // Pre-flight auth check for the app-server transport. The session child
      // can't authenticate on its own when there's no auth.json -- the codex
      // SDK transport surfaces this as an opaque 401 mid-stream, but the
      // app-server transport just hangs on the first turn. Catch it here so
      // the transcript can render a "Sign in to Codex" CTA instead of waiting.
      // Skipped for the SDK transport (no in-app account/* RPC there) and
      // when no gate is wired (tests).
      if (
        this.transport === 'app-server' &&
        !cachedLiveSession &&
        OpenAICodexProvider.codexAuthGate
      ) {
        try {
          const gateResult = await OpenAICodexProvider.codexAuthGate();
          if (gateResult.requiresOpenaiAuth) {
            yield {
              type: 'error',
              error: 'Sign in to OpenAI Codex to continue.',
              isAuthError: true,
              isCodexAuthRequired: true,
            };
            return;
          }
        } catch (err) {
          console.warn('[CODEX] auth gate check failed; continuing without pre-flight:', err);
        }
      }

      let session: ProtocolSession;
      let isResumedThread: boolean;
      if (cachedLiveSession) {
        session = cachedLiveSession;
        isResumedThread = true;
      } else if (existingSessionId) {
        session = await this.protocol.resumeSession(existingSessionId, sessionOptions);
        isResumedThread = true;
      } else {
        session = await this.protocol.createSession(sessionOptions);
        isResumedThread = false;
      }
      // Stash live sessions so future turns on the same Nimbalyst session reuse
      // the same child. Skip when sessionId is absent (anonymous turns -- nothing
      // to key by) and when we just hit the cache (no-op).
      if (sessionId && !cachedLiveSession) {
        this.liveProtocolSessions.set(sessionId, session);
      }

      // Persist a newly created thread ID immediately, before streaming the
      // turn. Codex turns can pause on PromptForUserInput / AskUserQuestion
      // and never reach the terminal `complete` path that historically wrote
      // providerSessionId to the DB. If we wait until turn end, an app restart
      // during that blocked state loses the only resumable thread handle and
      // the next prompt starts a fresh conversation.
      if (sessionId && session.id) {
        if (existingSessionId && session.id !== existingSessionId) {
          throw new Error(
            `[CODEX] Thread resume mismatch: requested resume of ` +
            `"${existingSessionId}" but protocol returned thread "${session.id}". ` +
            `The prior conversation is not loaded. Aborting so the user sees the ` +
            `failure rather than silently starting a fresh thread.`
          );
        }
        if (!existingSessionId) {
          this.sessions.captureSessionId(sessionId, session.id);
        }
      }

      // Store initialization data for analytics (picked up by AIService).
      // `transport` lets us bucket sessions by which codex transport drove
      // them, so we can compare reliability/quality between sdk and app-server
      // during the rollout.
      this._initData = {
        model: resolvedModel,
        mcpServerCount: Object.keys(mcpServers).length,
        isResumedThread,
        permissionMode: permissionDecision.permissionMode ?? null,
        transport: this.transport,
      };

      // console.log('[CODEX] Session after create/resume:', {
      //   sessionId,
      //   protocolSessionId: session.id,
      //   existingSessionId
      // });

      // Create transcript adapter as event parser (returns ParsedItems for the streaming loop).
      // Canonical events are written by the TranscriptTransformer from raw ai_agent_messages.
      const transcriptAdapter = new AgentProtocolTranscriptAdapter(null, sessionId ?? '');

      transcriptAdapter.userMessage(
        prompt,
        documentContext?.mode === 'planning' ? 'planning' : 'agent',
        attachments as any,
      );

      // Send message using protocol -- adapter parses all events
      for await (const event of this.protocol.sendMessage(session, {
        content: prompt,
        attachments,
        sessionId,
        mode: documentContext?.mode || 'agent',
      })) {
        if (abortController.signal.aborted) {
          throw new Error('Operation cancelled');
        }

        // The codex-sdk numbers items per-turn (`item_0`, `item_1`, ...
        // restarting each turn). `codexEditGroupIdsBySession` /
        // `fileChangePreEditSnapshottedIds` are keyed on `(sessionId,
        // rawItemId)` and are normally cleared on the terminal tool_call
        // by `case 'tool_call'` below. Side paths that bypass the main
        // loop -- notably `sendSessionNamingReminder`, which runs its own
        // `for await` over `protocol.sendMessage` and never reaches case
        // 'tool_call' -- can leave stale entries from earlier turns.
        // Drop any prior-turn entry on `item.started` BEFORE the per-event
        // handlers below run; otherwise the next turn's `item.started`
        // would reuse the stale `editGroupId`, causing two tool calls in
        // different turns to share a `providerToolCallId` (the transcript
        // renderer dedupes them, hiding the later one) and the
        // `fileChangePreEditSnapshottedIds` dedup would falsely skip the
        // pre-edit snapshot for the new turn's file_change.
        if (sessionId && event.type === 'raw_event' && event.metadata?.rawEvent) {
          const startedItemId = this.extractCodexRawItemId(event.metadata.rawEvent);
          if (startedItemId && this.getRawEventType(event.metadata.rawEvent) === 'item.started') {
            this.clearCodexEditGroupForItem(sessionId, startedItemId);
          }
        }

        // The pre/post-edit snapshot pipeline diverges per transport:
        //   - SDK transport: `item.started` for `file_change` is the only
        //     deterministic-ish moment to read pre-edit content; disk reads
        //     here race apply_patch and rely on FileSnapshotCache fallbacks.
        //   - App-server transport: `item/completed` carries the full unified
        //     diff text per change. Reading disk at item/completed is always
        //     race-free (the patch is on disk), and reverse-applying the diff
        //     recovers the pre-edit content deterministically.
        //
        // Route by `metadata.transport` set by `CodexAppServerProtocol`.
        const isAppServerEvent = event.type === 'raw_event'
          && (event as { metadata?: { transport?: string } }).metadata?.transport === 'app-server';
        if (isAppServerEvent) {
          try {
            const { preEdit, postEdit } = await this.maybeBuildAppServerFileChangeSnapshots(event, sessionId);
            if (preEdit) yield preEdit;
            if (postEdit) yield postEdit;
          } catch (err) {
            console.warn('[CODEX][APPSERVER] snapshot build failed (non-fatal):', err);
          }
        } else {
          try {
            const preEditChunk = await this.maybeBuildFileChangePreEditSnapshot(event, sessionId);
            if (preEditChunk) yield preEditChunk;
          } catch {
            // never let snapshot work break the stream
          }
          try {
            const postEditChunk = await this.maybeBuildFileChangePostEditSnapshot(event, sessionId);
            if (postEditChunk) yield postEditChunk;
          } catch {
            // never let snapshot work break the stream
          }
        }

        // Store EACH raw event immediately as a separate database row
        if (sessionId) {
          try {
            await this.storeRawEventIfPresent(event, sessionId);
          } catch {
            // DB not available (e.g., tests) -- non-critical, continue streaming
          }
        }

        for (const item of transcriptAdapter.processEvent(event)) {
          switch (item.kind) {
            case 'text':
              // Content rendered from canonical events, but AIService still needs
              // text yields for OS notification body content.
              fullText += item.text;
              yield { type: 'text', content: item.text };
              break;

            case 'tool_call':
              // Content rendered from canonical events -- no StreamChunk yield.
              // Side effects only:
              if (OpenAICodexProvider.isSessionNamingToolCall(item.toolCall.name)) {
                usedSessionNamingToolThisTurn = true;
              }
              this.handleAskUserQuestionToolCall(item.toolCall, sessionId);
              // Stamp the synthetic edit-group ID minted when the corresponding
              // raw_event was logged so MessageStreamingHandler /
              // SessionFileTracker dedupe and persist the same `nimtc|...` ID
              // CodexRawParser will mint when reparsing the raw log.
              if (sessionId && typeof item.toolCall.id === 'string' && item.toolCall.id) {
                const editGroupId = this.lookupCodexEditGroupId(sessionId, item.toolCall.id);
                if (editGroupId) {
                  (item.toolCall as { toolUseId?: string }).toolUseId = editGroupId;
                }
                // A tool_call carrying a result is terminal -- allow a later
                // turn that reuses `item_0` to mint a fresh edit-group ID.
                if (item.toolCall.result !== undefined && item.toolCall.result !== null) {
                  this.clearCodexEditGroupForItem(sessionId, item.toolCall.id);
                }
              }
              // AIService still needs tool_call yields for file tracking / worktree detection
              yield { type: 'tool_call', toolCall: item.toolCall };
              break;

            case 'complete':
              yield {
                type: 'complete',
                content: item.event.content,
                isComplete: true,
                usage: item.event.usage,
                ...(item.event.contextFillTokens !== undefined ? { contextFillTokens: item.event.contextFillTokens } : {}),
                ...(item.event.contextWindow !== undefined ? { contextWindow: item.event.contextWindow } : {}),
              };
              break;

            case 'error':
              yield { type: 'error', error: item.message };
              break;

            case 'raw_event':
            case 'reasoning':
            case 'unknown':
              break;
          }
        }
      }

      // Capture session ID after stream completes as a safety net for older
      // call paths. New threads are now persisted immediately after
      // createSession() succeeds so blocked turns survive restart.
      if (sessionId && session.id) {
        if (session.id !== existingSessionId) {
          // console.log('[CODEX] Saving new thread ID:', {
          //   nimbalystSessionId: sessionId,
          //   codexThreadId: session.id
          // });
          this.sessions.captureSessionId(sessionId, session.id);
        } else {
          // console.log('[CODEX] Thread ID unchanged:', session.id);
        }
      } else if (sessionId && !session.id) {
        console.error('[CODEX] WARNING: Stream completed but thread ID was never captured!');
      }

      if (
        sessionId &&
        !isResumedThread &&
        hasSessionNamingServer &&
        !usedSessionNamingToolThisTurn &&
        !abortController.signal.aborted
      ) {
        await this.sendSessionNamingReminder(session, sessionId);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbort = abortController.signal.aborted || /abort|cancel/i.test(errorMessage);
      if (!isAbort) {
        yield {
          type: 'error',
          error: errorMessage,
        };
        // The child may be dead (RPC timeout, write-to-closed-stdin, codex
        // crash). Drop the cached session so the next turn spawns fresh
        // instead of failing on a stale handle. We leave the persisted
        // threadId in place so the fresh spawn can still resumeSession.
        this.evictLiveProtocolSession(sessionId);
      }
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  /**
   * Drop and kill the cached `ProtocolSession` for a Nimbalyst session, if any.
   * Used on stream errors (likely-dead child) and from `cleanupSession`.
   */
  private evictLiveProtocolSession(sessionId: string | undefined): void {
    if (!sessionId) return;
    const cached = this.liveProtocolSessions.get(sessionId);
    if (!cached) return;
    this.liveProtocolSessions.delete(sessionId);
    try { this.protocol.cleanupSession(cached); }
    catch (err) { console.warn('[CODEX] protocol.cleanupSession threw during eviction:', err); }
  }

  /**
   * Resolve a pending tool permission request
   * Delegates to ToolPermissionService
   */
  resolveToolPermission(
    requestId: string,
    response: { decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' | 'always-all' },
    sessionId?: string,
    respondedBy: 'desktop' | 'mobile' = 'desktop'
  ): void {
    // Resolve via service
    this.permissionService.resolvePermission(requestId, response);

    // Log result for mobile/cross-device polling
    if (sessionId) {
      void this.logAgentMessageBestEffort(
        sessionId,
        'output',
        this.createPermissionResultMessage(requestId, response, respondedBy)
      );
    }
  }

  public resolveAskUserQuestion(
    questionId: string,
    answers: Record<string, string>,
    sessionId?: string,
    respondedBy: 'desktop' | 'mobile' = 'desktop'
  ): boolean {
    const pending = this.pendingAskUserQuestions.get(questionId);
    if (!pending) {
      return false;
    }

    this.pendingAskUserQuestions.delete(questionId);
    this.emit('askUserQuestion:answered', {
      questionId,
      sessionId: sessionId ?? pending.sessionId,
      questions: pending.questions,
      answers,
      respondedBy,
      timestamp: Date.now(),
    });
    return true;
  }

  public rejectAskUserQuestion(questionId: string, _error: Error): void {
    const pending = this.pendingAskUserQuestions.get(questionId);
    if (!pending) {
      return;
    }

    this.pendingAskUserQuestions.delete(questionId);
    this.emit('askUserQuestion:answered', {
      questionId,
      sessionId: pending.sessionId,
      questions: pending.questions,
      answers: {},
      cancelled: true,
      timestamp: Date.now(),
    });
  }

  private handleAskUserQuestionToolCall(
    toolCall: { id?: string; name: string; arguments?: Record<string, unknown>; result?: unknown },
    sessionId?: string
  ): void {
    const normalizedName = OpenAICodexProvider.normalizeMcpToolName(toolCall.name);
    if (normalizedName !== 'AskUserQuestion') {
      return;
    }

    if (!toolCall.id) {
      return;
    }

    const questionId = toolCall.id;
    const questions = OpenAICodexProvider.parseAskUserQuestionQuestions(toolCall.arguments);
    const hasResult = toolCall.result !== undefined && toolCall.result !== null;

    if (!hasResult) {
      if (this.pendingAskUserQuestions.has(questionId)) {
        return;
      }

      this.pendingAskUserQuestions.set(questionId, {
        questions,
        sessionId: sessionId ?? 'unknown',
      });
      this.emit('askUserQuestion:pending', {
        questionId,
        sessionId: sessionId ?? 'unknown',
        questions,
        timestamp: Date.now(),
      });
      return;
    }

    const pending = this.pendingAskUserQuestions.get(questionId);
    if (!pending) {
      return;
    }

    this.pendingAskUserQuestions.delete(questionId);
    this.emit('askUserQuestion:answered', {
      questionId,
      sessionId: sessionId ?? pending.sessionId,
      questions: pending.questions,
      answers: OpenAICodexProvider.extractAskUserQuestionAnswers(toolCall.result),
      cancelled: OpenAICodexProvider.isCancelledAskUserQuestionResult(toolCall.result),
      timestamp: Date.now(),
    });
  }

  private static parseAskUserQuestionQuestions(input: unknown): AskUserQuestionPrompt[] {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return [];
    }

    const rawQuestions = (input as Record<string, unknown>).questions;
    if (!Array.isArray(rawQuestions)) {
      return [];
    }

    const parsed: AskUserQuestionPrompt[] = [];
    for (const question of rawQuestions) {
      if (!question || typeof question !== 'object' || Array.isArray(question)) {
        continue;
      }

      const record = question as Record<string, unknown>;
      const header = typeof record.header === 'string' ? record.header : '';
      const text = typeof record.question === 'string' ? record.question : '';
      const multiSelect = record.multiSelect === true;
      const rawOptions = Array.isArray(record.options) ? record.options : [];

      if (!header || !text || rawOptions.length === 0) {
        continue;
      }

      const options: AskUserQuestionPromptOption[] = [];
      for (const option of rawOptions) {
        if (!option || typeof option !== 'object' || Array.isArray(option)) {
          continue;
        }
        const optionRecord = option as Record<string, unknown>;
        const label = typeof optionRecord.label === 'string' ? optionRecord.label : '';
        const description =
          typeof optionRecord.description === 'string' ? optionRecord.description : '';
        if (!label) {
          continue;
        }
        options.push({ label, description });
      }

      if (options.length === 0) {
        continue;
      }

      parsed.push({
        question: text,
        header,
        options,
        multiSelect,
      });
    }

    return parsed;
  }

  private static extractAskUserQuestionAnswers(result: unknown): Record<string, string> {
    if (!result) {
      return {};
    }

    if (typeof result === 'string') {
      try {
        return OpenAICodexProvider.extractAskUserQuestionAnswers(JSON.parse(result));
      } catch {
        return {};
      }
    }

    if (typeof result !== 'object' || Array.isArray(result)) {
      return {};
    }

    const record = result as Record<string, unknown>;
    if (record.answers && typeof record.answers === 'object' && !Array.isArray(record.answers)) {
      const parsedAnswers: Record<string, string> = {};
      for (const [key, value] of Object.entries(record.answers as Record<string, unknown>)) {
        if (typeof value === 'string') {
          parsedAnswers[key] = value;
        }
      }
      if (Object.keys(parsedAnswers).length > 0) {
        return parsedAnswers;
      }
    }

    if (record.result !== undefined) {
      const nested = OpenAICodexProvider.extractAskUserQuestionAnswers(record.result);
      if (Object.keys(nested).length > 0) {
        return nested;
      }
    }

    if (record.content !== undefined) {
      const nested = OpenAICodexProvider.extractAskUserQuestionAnswers(record.content);
      if (Object.keys(nested).length > 0) {
        return nested;
      }
    }

    return {};
  }

  private static isCancelledAskUserQuestionResult(result: unknown): boolean {
    if (!result) {
      return false;
    }

    if (typeof result === 'string') {
      try {
        return OpenAICodexProvider.isCancelledAskUserQuestionResult(JSON.parse(result));
      } catch {
        return /cancelled|canceled/i.test(result);
      }
    }

    if (typeof result !== 'object' || Array.isArray(result)) {
      return false;
    }

    const record = result as Record<string, unknown>;
    if (record.cancelled === true || record.canceled === true) {
      return true;
    }

    if (record.result !== undefined && OpenAICodexProvider.isCancelledAskUserQuestionResult(record.result)) {
      return true;
    }

    if (record.content !== undefined && OpenAICodexProvider.isCancelledAskUserQuestionResult(record.content)) {
      return true;
    }

    return false;
  }

  private static normalizeMcpToolName(toolName: string): string {
    return toolName.replace(/^mcp__.+?__/, '');
  }

  private static isSessionNamingToolCall(toolName: string): boolean {
    const normalized = OpenAICodexProvider.normalizeMcpToolName(toolName);
    return normalized === 'update_session_meta' || normalized === 'name_session';
  }

  private async sendSessionNamingReminder(
    session: ProtocolSession,
    sessionId: string
  ): Promise<void> {
    console.log('[CODEX] First turn completed without session naming; sending reminder instruction');

    await this.logAgentMessageBestEffort(
      sessionId,
      'input',
      OpenAICodexProvider.SESSION_NAMING_REMINDER_PROMPT,
      {
        hidden: false,
        searchable: false,
        metadata: {
          promptType: 'system_reminder',
          reminderKind: 'session_naming',
        },
      }
    );

    let reminderTriggeredNaming = false;

    for await (const reminderEvent of this.protocol.sendMessage(session, {
      content: OpenAICodexProvider.SESSION_NAMING_REMINDER_PROMPT,
    })) {
      // Tag this reminder turn's persisted output rows as a system reminder so
      // the metadata-based transcript hide covers them. Without the tag they
      // carry only { eventType, codexProvider, transport } and fall back to the
      // exact <SYSTEM_REMINDER> tag regex, which a fragmented streamed tag
      // defeats, leaking the naming nudge into the visible transcript.
      await this.storeRawEventIfPresent(reminderEvent, sessionId, {
        promptType: 'system_reminder',
        reminderKind: 'session_naming',
      });

      if (reminderEvent.type === 'tool_call' && reminderEvent.toolCall) {
        if (OpenAICodexProvider.isSessionNamingToolCall(reminderEvent.toolCall.name)) {
          reminderTriggeredNaming = true;
        }
        this.handleAskUserQuestionToolCall(reminderEvent.toolCall, sessionId);
      }
    }

    if (!reminderTriggeredNaming) {
      console.warn('[CODEX] Session naming reminder turn completed without update_session_meta call');
    }
  }

  abort(): void {
    this.pendingAskUserQuestions.clear();
    // Reject all pending permissions via service
    this.permissionService.rejectAllPending();
    // Call base class abort (handles abortController)
    super.abort();
  }

  /**
   * Release resources for a specific session.
   * Call this when a session is deleted or no longer needed.
   */
  cleanupSession(sessionId: string): void {
    this.evictLiveProtocolSession(sessionId);
    this.sessions.deleteSession(sessionId);
    this.appServerNotificationDeduper.delete(sessionId);
  }

  destroy(): void {
    // Tear down every live ProtocolSession so we don't orphan codex child
    // processes when the provider is replaced (e.g., on API key rotation).
    for (const session of this.liveProtocolSessions.values()) {
      try { this.protocol.cleanupSession(session); }
      catch (err) { console.warn('[CODEX] protocol.cleanupSession threw during destroy():', err); }
    }
    this.liveProtocolSessions.clear();
    this.appServerNotificationDeduper.clear();
    // Clear permission service caches
    this.permissionService.clearSessionCache();
    // Call base class destroy (calls abort, sessions.clear, permissions.clearSessionCache, removeAllListeners)
    super.destroy();
  }

  /**
   * Build system prompt for Codex using the same addendum as Claude Code.
   * Uses buildClaudeCodeSystemPrompt to include Nimbalyst-specific instructions
   * for visual tools, worktrees, session naming, etc.
   */
  protected buildSystemPrompt(documentContext?: DocumentContext, isMetaAgent: boolean = false, workflowPreset: MetaAgentWorkflowPreset = 'default'): string {
    if (isMetaAgent) {
      return buildMetaAgentSystemPrompt('codex', workflowPreset, {
        provider: 'openai-codex',
        model: this.config?.model ?? undefined,
      });
    }

    const hasSessionNaming = isInternalMcpServerEnabled();
    const worktreePath = documentContext?.worktreePath;
    const isVoiceMode = (documentContext as any)?.isVoiceMode;
    const voiceModeCodingAgentPrompt = (documentContext as any)?.voiceModeCodingAgentPrompt;
    // Note: Agent teams are not currently supported for Codex
    const enableAgentTeams = false;

    return buildClaudeCodeSystemPrompt({
      hasSessionNaming,
      toolReferenceStyle: 'codex',
      worktreePath,
      isVoiceMode,
      voiceModeCodingAgentPrompt,
      enableAgentTeams,
    });
  }

  private async getConfiguredModel(): Promise<string> {
    const configured = this.config?.model || OpenAICodexProvider.DEFAULT_MODEL;
    const parsed = ModelIdentifier.tryParse(configured);
    const resolved = parsed ? parsed.model : configured.replace(/^openai-codex:/, '');
    const normalized = resolved.toLowerCase();
    if (normalized === 'openai-codex-cli' || normalized === 'default' || normalized === 'cli') {
      return 'gpt-5.5';
    }

    // Pass the model directly to the Codex SDK without pre-validation.
    // The openai.models.list() API does not include all Codex-available models
    // (e.g., gpt-5.4 works via the SDK but isn't listed in the API).
    // The SDK itself will fail with a proper error if the model doesn't exist.
    return OpenAICodexProvider.MODEL_REPLACEMENTS.get(normalized) || resolved;
  }

  private buildCodexPrompt(options: {
    systemPrompt: string;
    message: string;
    messages?: any[];
    shouldBootstrapFromHistory: boolean;
  }): string {
    // Note: System prompt is now passed via developer_instructions in thread options.
    // Codex SDK handles message formatting internally, so we just pass the raw content.

    // For now, conversation history bootstrapping is always disabled (shouldBootstrapFromHistory = false)
    // because the Codex SDK maintains thread state automatically.
    // If we need history bootstrapping in the future, we can add it here.

    return options.message;
  }

  /**
   * Build a complete environment for the Codex CLI binary.
   * Merges process.env with shell env vars and enhanced PATH so the agent
   * can access system tools (docker, homebrew, nvm, etc.) that are missing
   * from Electron's minimal GUI environment.
   *
   * Returns null if no enhancement is needed (no loaders configured).
   */
  private static buildCodexEnvironment(): Record<string, string> | null {
    let shellEnv: Record<string, string> | null = null;
    let enhancedPath: string | null = null;

    if (OpenAICodexProvider.shellEnvironmentLoader) {
      try {
        shellEnv = OpenAICodexProvider.shellEnvironmentLoader();
      } catch (error) {
        console.warn('[CODEX] Failed to load shell environment:', error);
      }
    }

    if (OpenAICodexProvider.enhancedPathLoader) {
      try {
        enhancedPath = OpenAICodexProvider.enhancedPathLoader();
      } catch (error) {
        console.warn('[CODEX] Failed to load enhanced PATH:', error);
      }
    }

    // Only build custom env if we have something to enhance
    if (!shellEnv && !enhancedPath) {
      return null;
    }

    const env: Record<string, string> = {};

    // Start with process.env (Electron's minimal environment)
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }

    // Layer shell env vars on top (AWS creds, NODE_EXTRA_CA_CERTS, etc.)
    if (shellEnv) {
      Object.assign(env, shellEnv);
    }

    // Set enhanced PATH (includes homebrew, nvm, docker, etc.)
    if (enhancedPath) {
      env.PATH = enhancedPath;
    }

    // Defense-in-depth against silently inheriting API keys the user did not
    // configure in Nimbalyst settings. The main-process bootstrap already
    // strips these from process.env, but shellEnv may re-introduce a shell
    // export, so we force-clear them here. Per-session keys from provider
    // config are injected at the call site, not here.
    // See CLAUDE.md "Never Use Environment Variables as Implicit API Key Sources".
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;

    return env;
  }

  private buildCodexConfigOverrides(
    mcpServers: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    const codexMcpServers: Record<string, Record<string, unknown>> = {};
    const usedServerNames = new Set<string>();

    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      const converted = this.convertServerConfigToCodex(serverConfig as Record<string, unknown>);
      if (converted) {
        const codexServerName = this.toCodexServerName(serverName, usedServerNames);
        codexMcpServers[codexServerName] = converted;
      }
    }

    const configOverrides: Record<string, unknown> = {
      // Codex SDK documents this config flag as the switch for surfacing
      // raw agent reasoning in streamed events.
      show_raw_agent_reasoning: true,
    };

    if (this.config?.serviceTier) {
      configOverrides.service_tier = this.config.serviceTier;
      configOverrides.features = {
        fast_mode: true,
      };
    }

    if (Object.keys(codexMcpServers).length > 0) {
      configOverrides.mcp_servers = codexMcpServers;
    }

    // Register a PreToolUse hook for apply_patch that snapshots pre-edit
    // content to a per-session sidecar BEFORE Codex applies the patch. This
    // sidesteps the item.started race -- by the time we observe item.started
    // in the SDK stream, the patch may already be on disk. The hook fires
    // synchronously inside the codex process before any disk write, so the
    // captured content is guaranteed pre-edit.
    const hookScriptPath = OpenAICodexProvider.preEditHookScriptPathResolver?.();
    if (hookScriptPath) {
      const hookCommand = `"${process.execPath}" "${hookScriptPath}"`;
      configOverrides.hooks = {
        PreToolUse: [
          {
            matcher: '^apply_patch$',
            hooks: [
              {
                type: 'command',
                // ELECTRON_RUN_AS_NODE=1 (set in buildCodexEnvironment when a
                // sidecar dir is configured) lets process.execPath run the
                // script as plain Node. Quoting both paths defensively in case
                // they contain spaces (common on macOS for packaged builds in
                // ~/Applications and ~/Library/Application Support).
                command: hookCommand,
              },
            ],
          },
        ],
      };
      // console.log('[CODEX] PreToolUse hook configured:', { command: hookCommand });
    } else {
      // console.log('[CODEX] PreToolUse hook resolver returned undefined; pre-edit race protection not configured');
    }

    return configOverrides;
  }

  private toCodexServerName(serverName: string, usedServerNames: Set<string>): string {
    // Codex serializes config to TOML; keys with "." become nested path segments.
    // Keep names TOML-bare-key safe to avoid invalid transport parsing errors.
    const base = serverName
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'server';

    let candidate = base;
    let suffix = 2;
    while (usedServerNames.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }

    usedServerNames.add(candidate);
    return candidate;
  }

  private convertServerConfigToCodex(serverConfig: Record<string, unknown>): Record<string, unknown> | null {
    const configTypeRaw = typeof serverConfig.type === 'string'
      ? serverConfig.type.toLowerCase()
      : (typeof serverConfig.transport === 'string' ? serverConfig.transport.toLowerCase() : '');

    const isExplicitRemoteServer = configTypeRaw === 'sse' || configTypeRaw === 'http';
    const isExplicitStdioServer = configTypeRaw === 'stdio';
    const hasUrl = typeof serverConfig.url === 'string' && serverConfig.url.length > 0;
    const hasCommand = typeof serverConfig.command === 'string' && serverConfig.command.length > 0;

    if (isExplicitRemoteServer || (!isExplicitStdioServer && hasUrl && !hasCommand)) {
      if (typeof serverConfig.url !== 'string' || serverConfig.url.length === 0) {
        return null;
      }

      const wrappedRemoteConfig = this.convertRemoteOAuthServerToMcpRemote(serverConfig as MCPServerConfig);
      if (wrappedRemoteConfig) {
        return wrappedRemoteConfig;
      }

      const remoteConfig: Record<string, unknown> = {
        url: serverConfig.url,
      };

      const headers = this.toCodexStringMap((serverConfig.http_headers ?? serverConfig.headers) as unknown);
      if (headers && Object.keys(headers).length > 0) {
        remoteConfig.http_headers = headers;
      }

      if (typeof serverConfig.bearer_token_env_var === 'string' && serverConfig.bearer_token_env_var.length > 0) {
        remoteConfig.bearer_token_env_var = serverConfig.bearer_token_env_var;
      }

      if (typeof serverConfig.startup_timeout_sec === 'number') {
        remoteConfig.startup_timeout_sec = serverConfig.startup_timeout_sec;
      }

      if (typeof serverConfig.tool_timeout_sec === 'number') {
        remoteConfig.tool_timeout_sec = serverConfig.tool_timeout_sec;
      }

      return remoteConfig;
    }

    if (!hasCommand) {
      return null;
    }

    const stdioConfig: Record<string, unknown> = {
      command: serverConfig.command,
    };

    if (Array.isArray(serverConfig.args)) {
      stdioConfig.args = serverConfig.args.filter((arg): arg is string => typeof arg === 'string');
    }

    const env = this.toCodexStringMap(serverConfig.env as unknown);
    if (env && Object.keys(env).length > 0) {
      stdioConfig.env = env;
    }

    if (typeof serverConfig.cwd === 'string' && serverConfig.cwd.length > 0) {
      stdioConfig.cwd = serverConfig.cwd;
    }

    if (typeof serverConfig.startup_timeout_sec === 'number') {
      stdioConfig.startup_timeout_sec = serverConfig.startup_timeout_sec;
    }

    if (typeof serverConfig.tool_timeout_sec === 'number') {
      stdioConfig.tool_timeout_sec = serverConfig.tool_timeout_sec;
    }

    return stdioConfig;
  }

  private convertRemoteOAuthServerToMcpRemote(
    serverConfig: MCPServerConfig
  ): Record<string, unknown> | null {
    if ((serverConfig.type !== 'http' && serverConfig.type !== 'sse') || !serverConfig.url || !serverConfig.oauth) {
      return null;
    }

    const args: string[] = ['-y', 'mcp-remote', serverConfig.url];

    if (serverConfig.oauth.callbackPort) {
      args.push(String(serverConfig.oauth.callbackPort));
    }

    if (serverConfig.oauth.host) {
      args.push('--host', serverConfig.oauth.host);
    }

    if (serverConfig.oauth.transportStrategy) {
      args.push('--transport', serverConfig.oauth.transportStrategy);
    }

    if (serverConfig.oauth.resource) {
      args.push('--resource', serverConfig.oauth.resource);
    }

    if (serverConfig.oauth.authTimeoutSeconds) {
      args.push('--auth-timeout', String(serverConfig.oauth.authTimeoutSeconds));
    }

    const rawHeaders = (serverConfig as Record<string, unknown>).http_headers ?? serverConfig.headers;
    const headers = this.toCodexStringMap(rawHeaders) ?? {};
    for (const key of Object.keys(headers).sort()) {
      args.push('--header', `${key}:${headers[key]}`);
    }

    if (serverConfig.oauth.staticClientMetadata) {
      args.push('--static-oauth-client-metadata', JSON.stringify(serverConfig.oauth.staticClientMetadata));
    }

    const staticClientInfo = this.getMcpRemoteStaticClientInfo(serverConfig.oauth);
    if (staticClientInfo) {
      args.push('--static-oauth-client-info', JSON.stringify(staticClientInfo));
    }

    return {
      command: 'npx',
      args,
    };
  }

  private getMcpRemoteStaticClientInfo(
    oauthConfig: MCPServerConfig['oauth']
  ): Record<string, string> | null {
    if (!oauthConfig) {
      return null;
    }

    if (oauthConfig.staticClientInfo && Object.keys(oauthConfig.staticClientInfo).length > 0) {
      return oauthConfig.staticClientInfo;
    }

    if (!oauthConfig.clientId && !oauthConfig.clientSecret) {
      return null;
    }

    const clientInfo: Record<string, string> = {};
    if (oauthConfig.clientId) {
      clientInfo.client_id = oauthConfig.clientId;
    }
    if (oauthConfig.clientSecret) {
      clientInfo.client_secret = oauthConfig.clientSecret;
    }
    return Object.keys(clientInfo).length > 0 ? clientInfo : null;
  }

  private toCodexStringMap(value: unknown): Record<string, string> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const result: Record<string, string> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (typeof entryValue === 'string') {
        result[key] = entryValue;
      }
    }
    return result;
  }

  /**
   * Strip XML-like tags that could break out of structured prompt sections.
   * This prevents message content from injecting fake </CONVERSATION_HISTORY>,
   * <USER>, etc. tags that would alter the prompt structure.
   *
   * Handles bare tags, tags with attributes, and self-closing variants:
   *   <USER>, </USER>, <USER id="x">, <USER/>, etc.
   */
  private static sanitizeTagContent(content: string): string {
    return content.replace(/<\/?(?:CONVERSATION_HISTORY|USER)\b[^>]*\/?>/gi, '');
  }

  private appendAttachmentHints(message: string, attachments?: ChatAttachment[]): string {
    if (!attachments || attachments.length === 0) {
      return message;
    }

    const attachmentList = attachments
      .map((attachment) => {
        const displayName =
          attachment.filename ||
          (attachment.filepath ? path.basename(attachment.filepath) : attachment.id || 'attachment');
        return `- ${displayName}${attachment.filepath ? ` (${attachment.filepath})` : ''}`;
      })
      .join('\n');

    return `${message}\n\nAttached files:\n${attachmentList}`;
  }

  /**
   * Store a raw protocol event to the database if present in event metadata.
   * Meaningful raw events are stored as separate database rows for Codex event
   * tracking. Transient app-server deltas and status churn are intentionally skipped.
   */
  private async storeRawEventIfPresent(
    event: ProtocolEvent,
    sessionId: string,
    extraMetadata?: Record<string, unknown>
  ): Promise<void> {
    if (event.type !== 'raw_event') {
      return;
    }

    const transport = (event.metadata as { transport?: string } | undefined)?.transport;

    // App-server transport: the protocol emits {method, params} under metadata
    // rather than a single rawEvent. Persist it in a transport-tagged shape so
    // the dispatching parser can pick the right reader.
    if (transport === 'app-server') {
      const method = (event.metadata as { method?: string }).method;
      const params = (event.metadata as { params?: unknown }).params;
      if (!method) return;
      if (!this.shouldPersistAppServerNotification(sessionId, method, params)) {
        return;
      }
      const synthesizedRaw = { method, params };
      const content = JSON.stringify(synthesizedRaw);
      const rawItemId = this.extractAppServerItemId(params);
      const editGroupId = rawItemId
        ? this.getOrMintCodexEditGroupId(sessionId, rawItemId)
        : undefined;
      const metadata: Record<string, unknown> = {
        eventType: method,
        codexProvider: true,
        transport: 'app-server',
        ...extraMetadata,
      };
      if (editGroupId) metadata.editGroupId = editGroupId;
      await this.logAgentMessage(
        sessionId,
        this.getProviderName(),
        'output',
        content,
        metadata,
        false,
        undefined,
        false,
      );
      return;
    }

    // SDK transport (legacy): preserves the existing rawEvent shape.
    if (!event.metadata?.rawEvent) {
      return;
    }

    const { content, usedFallback } = this.serializeRawCodexEvent(event.metadata.rawEvent);
    const rawEventType = this.getRawEventType(event.metadata.rawEvent);

    // Diagnostic: in an app-server-transport session, writing an SDK-shape raw
    // row means some path is double-emitting. Caught it for
    // developer_git_commit_proposal once -- the SDK row collided with the
    // app-server row through the same synthetic edit-group ID and produced a
    // second "Changes Committed" card. Log enough context to locate the
    // emitter the next time it fires.
    if (this.transport === 'app-server') {
      console.warn(
        '[CODEX][SDK-RAW-IN-APPSERVER] unexpected SDK-shape raw_event during app-server transport',
        {
          sessionId,
          rawEventType,
          rawItemId: this.extractCodexRawItemId(event.metadata.rawEvent),
          stack: new Error('sdk-raw emitter').stack?.split('\n').slice(1, 8).join('\n'),
        }
      );
    }

    // Mint or look up the synthetic edit-group ID for this raw event's tool
    // item (if any). Stamping it onto the message metadata makes it the
    // canonical source of the providerToolCallId for both the parser
    // (CodexRawParser.resolveEditGroupId reads msg.metadata.editGroupId) and
    // SessionFileTracker (the chunk yielded a few lines later carries the
    // same ID so both writers store the same toolUseId).
    const rawItemId = this.extractCodexRawItemId(event.metadata.rawEvent);
    const editGroupId = rawItemId
      ? this.getOrMintCodexEditGroupId(sessionId, rawItemId)
      : undefined;

    const metadata: Record<string, unknown> = {
      eventType: rawEventType,
      codexProvider: true,
      rawEventSerializationFallback: usedFallback,
      ...extraMetadata,
    };
    if (editGroupId) {
      metadata.editGroupId = editGroupId;
    }

    await this.logAgentMessage(
      sessionId,
      this.getProviderName(),
      'output',
      content,
      metadata,
      false, // not hidden
      undefined, // no provider message ID
      false // not searchable - raw events are not for search
    );

    // Detect todo_list items and update session metadata so sidebar widgets display them
    this.handleTodoListEvent(event.metadata.rawEvent, sessionId);
  }

  private shouldPersistAppServerNotification(
    sessionId: string,
    method: string,
    params: unknown,
  ): boolean {
    if (!PERSISTED_APP_SERVER_NOTIFICATION_METHODS.has(method)) {
      return false;
    }

    const notificationKey = this.buildAppServerNotificationKey(method, params);
    if (!notificationKey) {
      return true;
    }

    const turnId = this.extractAppServerTurnId(params);
    const existing = this.appServerNotificationDeduper.get(sessionId);
    const state =
      !existing || existing.turnId !== turnId
        ? { turnId, seenKeys: new Set<string>() }
        : existing;

    if (state !== existing) {
      this.appServerNotificationDeduper.set(sessionId, state);
    }

    if (state.seenKeys.has(notificationKey)) {
      return false;
    }

    state.seenKeys.add(notificationKey);
    return true;
  }

  private buildAppServerNotificationKey(method: string, params: unknown): string | null {
    if (!params || typeof params !== 'object') {
      return null;
    }

    const record = params as {
      item?: { id?: unknown };
      turn?: { id?: unknown };
    };
    const turnId = this.extractAppServerTurnId(params) ?? 'no-turn';

    switch (method) {
      case 'item/started':
      case 'item/completed': {
        const itemId = record.item?.id;
        if (typeof itemId !== 'string' || !itemId) {
          return null;
        }
        return `${method}:${turnId}:${itemId}`;
      }
      case 'turn/completed':
      case 'turn/failed': {
        const completedTurnId = record.turn?.id;
        if (typeof completedTurnId !== 'string' || !completedTurnId) {
          return null;
        }
        return `${method}:${completedTurnId}`;
      }
      default:
        return null;
    }
  }

  private extractAppServerTurnId(params: unknown): string | null {
    if (!params || typeof params !== 'object') {
      return null;
    }

    const record = params as {
      turnId?: unknown;
      turn?: { id?: unknown };
    };

    if (typeof record.turnId === 'string' && record.turnId) {
      return record.turnId;
    }

    const turnId = record.turn?.id;
    return typeof turnId === 'string' && turnId ? turnId : null;
  }

  /**
   * Extract the codex item id (e.g. `call_xxx`) from an app-server notification's
   * params payload. Returns undefined for notifications that don't carry an item.
   */
  private extractAppServerItemId(params: unknown): string | undefined {
    if (!params || typeof params !== 'object') return undefined;
    const item = (params as { item?: unknown }).item;
    if (!item || typeof item !== 'object') return undefined;
    const id = (item as { id?: unknown }).id;
    if (typeof id === 'string' && id) return id;
    return undefined;
  }

  /**
   * Extract the raw Codex item id (e.g. `item_0`) from a raw SDK event, if
   * present. Returns null for events that don't carry a tool item (text,
   * thread.started, token_count, etc.).
   */
  private extractCodexRawItemId(rawEvent: unknown): string | null {
    if (!rawEvent || typeof rawEvent !== 'object') return null;
    const record = rawEvent as Record<string, unknown>;
    const item = record.item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const id = (item as Record<string, unknown>).id;
    return typeof id === 'string' && id ? id : null;
  }

  /**
   * Look up the synthetic edit-group ID for a raw Codex item id without
   * minting a new one. Used by the streaming yield path to attach the same
   * `nimtc|...` ID minted by storeRawEventIfPresent (which always runs first
   * for the corresponding raw_event in the protocol stream) onto the
   * tool_call chunk.
   */
  private lookupCodexEditGroupId(sessionId: string, rawItemId: string): string | undefined {
    return this.codexEditGroupIdsBySession.get(sessionId)?.get(rawItemId);
  }

  /**
   * Get the synthetic edit-group ID for the given (sessionId, rawItemId),
   * minting a fresh `nimtc|<encoded>|<Date.now()>|<counter>` ID if no entry
   * exists. The counter is per-provider-instance and ensures distinct IDs
   * even when two raw items log in the same millisecond.
   */
  private getOrMintCodexEditGroupId(sessionId: string, rawItemId: string): string {
    let sessionMap = this.codexEditGroupIdsBySession.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map<string, string>();
      this.codexEditGroupIdsBySession.set(sessionId, sessionMap);
    }
    const existing = sessionMap.get(rawItemId);
    if (existing) return existing;
    const minted = buildCodexToolLookupId(
      rawItemId,
      Date.now(),
      ++this.codexEditGroupCounter,
    );
    sessionMap.set(rawItemId, minted);
    return minted;
  }

  /**
   * Drop the (sessionId, rawItemId) -> syntheticId entry so a later turn
   * that reuses the same raw item id (e.g. `item_0`) mints a fresh ID.
   * Called after the tool_call carrying a result is yielded.
   */
  private clearCodexEditGroupForItem(sessionId: string, rawItemId: string): void {
    const sessionMap = this.codexEditGroupIdsBySession.get(sessionId);
    if (sessionMap) {
      sessionMap.delete(rawItemId);
      if (sessionMap.size === 0) {
        this.codexEditGroupIdsBySession.delete(sessionId);
      }
    }
    const seen = this.fileChangePreEditSnapshottedIds.get(sessionId);
    if (seen) {
      seen.delete(rawItemId);
      if (seen.size === 0) {
        this.fileChangePreEditSnapshottedIds.delete(sessionId);
      }
    }
  }

  /**
   * Build a `pre_edit_snapshot` StreamChunk from a Codex SDK event when it
   * is the FIRST `item.started` observation of a `file_change` for this
   * session. Reads each affected path from disk RIGHT NOW so the host can
   * write a local-history pre-edit tag with the real baseline -- before
   * Codex applies the patch.
   *
   * Returns null when the event is not a first-observation file_change
   * item.started (every other event type, every other tool, and every
   * subsequent observation of the same itemId within this turn).
   *
   * The dedup is defensive against the SDK ever emitting item.started
   * twice; the per-(sessionId, rawItemId) entry is cleared at the top of
   * the main `for await` loop on every `item.started`, so distinct turns
   * that reuse the same raw item id each get their own snapshot.
   */
  private async maybeBuildFileChangePreEditSnapshot(
    event: ProtocolEvent,
    sessionId: string | undefined,
  ): Promise<StreamChunk | null> {
    if (!sessionId) return null;
    const rawAny = (event as { metadata?: { rawEvent?: unknown } })?.metadata?.rawEvent as
      | { type?: string; item?: { type?: string; id?: string; status?: string; changes?: Array<{ path?: string; kind?: string }> } }
      | undefined;
    if (rawAny?.type !== 'item.started') return null;
    const rawItem = rawAny.item;
    if (rawItem?.type !== 'file_change') return null;
    if (!Array.isArray(rawItem.changes) || rawItem.changes.length === 0) return null;
    const itemId = rawItem.id;
    if (typeof itemId !== 'string' || !itemId) return null;

    let seen = this.fileChangePreEditSnapshottedIds.get(sessionId);
    if (!seen) {
      seen = new Set<string>();
      this.fileChangePreEditSnapshottedIds.set(sessionId, seen);
    }
    if (seen.has(itemId)) return null;
    seen.add(itemId);

    const fs = await import('fs');
    const cryptoMod = await import('crypto');
    const pathMod = await import('path');
    const editGroupId = this.getOrMintCodexEditGroupId(sessionId, itemId);
    const sidecarDir = OpenAICodexProvider.preEditSidecarDirResolver?.(sessionId);
    const entries: Array<{ path: string; content: string | null; kind?: string }> = [];
    for (const change of rawItem.changes) {
      const filePath = change?.path;
      if (typeof filePath !== 'string' || !filePath) continue;
      const kind = change?.kind;
      let content: string | null = null;
      // Authoritative source: the PreToolUse hook snapshots each affected
      // path's true pre-edit content to a per-session sidecar BEFORE Codex
      // applies the patch. That sidecar entry beats any disk read, because
      // item.started can race with the patch being applied and disk reads
      // here would capture post-edit content. After consuming, delete the
      // sidecar entry so a later patch on the same path picks up its own
      // hook-captured baseline rather than this stale one.
      if (sidecarDir) {
        const hash = cryptoMod.createHash('sha1').update(filePath).digest('hex');
        const sidecarPath = pathMod.join(sidecarDir, `${hash}.json`);
        try {
          const raw = fs.readFileSync(sidecarPath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.content === 'string') {
            content = parsed.content;
          }
          try {
            fs.unlinkSync(sidecarPath);
          } catch {
            // Best-effort cleanup; staleness is corrected by the next hook fire.
          }
        } catch {
          // Sidecar missing -- hook may not be wired or the patch came in
          // before the hook landed. Fall through to the disk-read path.
        }
      }
      if (content === null) {
        // For new-file creation (kind='add'), Codex writes the file BEFORE
        // emitting item.started -- the opposite of kind='update'. Reading
        // disk now would capture the post-edit body and the diff would come
        // back empty. Force empty baseline for adds; for updates, read the
        // real pre-edit content from disk.
        if (kind === 'add' || kind === 'create' || kind === 'new') {
          content = '';
        } else {
          try {
            content = fs.readFileSync(filePath, 'utf8');
          } catch {
            // ENOENT for an update means the path was relocated or never
            // existed; fall back to empty baseline so the diff still renders.
            content = '';
          }
        }
      }
      entries.push({ path: filePath, content, kind });
    }
    if (entries.length === 0) return null;

    return {
      type: 'pre_edit_snapshot',
      preEditSnapshot: {
        toolUseId: editGroupId,
        entries,
      },
    };
  }

  /**
   * Build a `post_edit_snapshot` StreamChunk from a Codex SDK event when it is
   * an `item.completed` for a `file_change`. Reads each affected path from
   * disk RIGHT NOW so the host can write an `ai-edit` history snapshot
   * carrying the AI's output content. This gives session-aware diffs a stable
   * "after" side that survives later user edits, mirroring Claude's
   * `AgentToolHooks.createTurnEndSnapshots`.
   *
   * Skips `delete` kinds — the file no longer exists on disk, and an empty
   * snapshot would just look like an unrelated truncation.
   */
  private async maybeBuildFileChangePostEditSnapshot(
    event: ProtocolEvent,
    sessionId: string | undefined,
  ): Promise<StreamChunk | null> {
    if (!sessionId) return null;
    const rawAny = (event as { metadata?: { rawEvent?: unknown } })?.metadata?.rawEvent as
      | { type?: string; item?: { type?: string; id?: string; status?: string; changes?: Array<{ path?: string; kind?: string }> } }
      | undefined;
    if (rawAny?.type !== 'item.completed') return null;
    const rawItem = rawAny.item;
    if (rawItem?.type !== 'file_change') return null;
    if (!Array.isArray(rawItem.changes) || rawItem.changes.length === 0) return null;
    const itemId = rawItem.id;
    if (typeof itemId !== 'string' || !itemId) return null;

    const editGroupId = this.lookupCodexEditGroupId(sessionId, itemId);
    if (!editGroupId) return null;

    const fs = await import('fs');
    const entries: Array<{ path: string; content: string; kind?: string }> = [];
    for (const change of rawItem.changes) {
      const filePath = change?.path;
      if (typeof filePath !== 'string' || !filePath) continue;
      const kind = change?.kind;
      // Skip deletes: the path is gone post-apply, and an empty ai-edit
      // snapshot would conflate "file deleted" with "file emptied."
      if (kind === 'delete' || kind === 'remove') continue;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        entries.push({ path: filePath, content, kind });
      } catch {
        // File missing post-apply (race / move / failed patch) — skip silently.
      }
    }
    if (entries.length === 0) return null;

    return {
      type: 'post_edit_snapshot',
      postEditSnapshot: {
        toolUseId: editGroupId,
        entries,
      },
    };
  }

  /**
   * App-server transport pre/post-edit snapshot builder.
   *
   * On `item/completed` for a `fileChange` item, the app-server protocol
   * attaches a `fileChangeBaselines` array to the raw event metadata. Each
   * entry carries the affected path, the patch kind, the full unified-diff
   * text, and a pre-computed `preEditContent` for `add`/`delete` kinds
   * (the `update` kind needs the post-edit content to reverse-apply).
   *
   * This method:
   *   - dedupes per-(session, itemId) so a turn that re-yields the same
   *     item.completed (defensive) doesn't double-write
   *   - reads post-edit content from disk for `update` kinds (race-free
   *     because the patch is definitely on disk at item.completed time)
   *   - reverse-applies the diff via `reverseCodexPatch` to recover pre-edit
   *     content for `update` kinds
   *   - returns both the `pre_edit_snapshot` and `post_edit_snapshot` chunks
   *     so the host's existing `MessageStreamingHandler` plumbing fires
   *     unchanged
   */
  private async maybeBuildAppServerFileChangeSnapshots(
    event: ProtocolEvent,
    sessionId: string | undefined,
  ): Promise<{ preEdit: StreamChunk | null; postEdit: StreamChunk | null }> {
    const empty = { preEdit: null, postEdit: null };
    if (!sessionId) return empty;

    const metadata = (event as { metadata?: Record<string, unknown> }).metadata;
    if (!metadata) return empty;
    const method = metadata.method as string | undefined;
    const params = metadata.params as Record<string, unknown> | undefined;
    if (method !== 'item/completed' || !params) return empty;

    const item = params.item as
      | { id?: string; type?: string; status?: string; changes?: Array<{ path: string; kind: { type: string; move_path?: string | null }; diff: string }> }
      | undefined;
    if (!item || item.type !== 'fileChange') return empty;
    if (!Array.isArray(item.changes) || item.changes.length === 0) return empty;
    const itemId = item.id;
    if (!itemId) return empty;

    // Diagnostic: confirms the app-server pre/post-edit pipeline fired.
    // Keep this terse -- one line per file_change item -- so production logs
    // stay scannable.
    // console.log('[CODEX][APPSERVER] file_change ' + JSON.stringify({
    //   sessionId,
    //   itemId,
    //   kinds: item.changes.map(c => c.kind?.type),
    //   paths: item.changes.map(c => c.path),
    // }));

    // Dedup -- guard against any defensive re-emission of item.completed for
    // the same item id. Reuses the existing per-session set the SDK path uses.
    let seen = this.fileChangePreEditSnapshottedIds.get(sessionId);
    if (!seen) {
      seen = new Set<string>();
      this.fileChangePreEditSnapshottedIds.set(sessionId, seen);
    }
    if (seen.has(itemId)) return empty;
    seen.add(itemId);

    const editGroupId = this.getOrMintCodexEditGroupId(sessionId, itemId);

    const fs = await import('fs');

    const preEntries: Array<{ path: string; content: string | null; kind?: string }> = [];
    const postEntries: Array<{ path: string; content: string; kind?: string }> = [];

    for (const change of item.changes) {
      const filePath = change?.path;
      if (typeof filePath !== 'string' || !filePath) continue;
      const kindStr = change.kind?.type ?? 'update';

      if (kindStr === 'add') {
        // Pre-edit: file did not exist. Post-edit: codex emits the raw final
        // file content as `diff` for adds (not a unified diff).
        preEntries.push({ path: filePath, content: '', kind: 'add' });
        postEntries.push({ path: filePath, content: change.diff ?? '', kind: 'add' });
        continue;
      }

      if (kindStr === 'delete') {
        // Pre-edit: reconstructed from the `-` lines in the diff. Post-edit:
        // the path no longer exists; skip post-edit entry like the SDK path does.
        const result = reverseCodexPatch(change.diff, null, 'delete');
        const preContent = result.ok ? result.preEditContent : null;
        preEntries.push({ path: filePath, content: preContent ?? '', kind: 'delete' });
        continue;
      }

      // 'update' (with optional move_path). Read post-edit content from disk
      // -- at item/completed time the patch is on disk, so this is race-free.
      // For renames, `move_path` is the destination; read THAT and apply the
      // pre-edit content under the ORIGINAL path so the diff makes sense.
      const movePath = change.kind?.move_path ?? null;
      const postPath = typeof movePath === 'string' && movePath ? movePath : filePath;
      let postContent: string;
      try {
        postContent = fs.readFileSync(postPath, 'utf8');
      } catch {
        // File missing post-apply -- skip both sides; nothing useful to write.
        continue;
      }
      const result = reverseCodexPatch(change.diff, postContent, 'update');
      const preContent = result.ok ? (result.preEditContent ?? '') : '';
      preEntries.push({ path: filePath, content: preContent, kind: 'update' });
      postEntries.push({ path: postPath, content: postContent, kind: 'update' });
    }

    const preEdit: StreamChunk | null = preEntries.length === 0
      ? null
      : {
          type: 'pre_edit_snapshot',
          preEditSnapshot: {
            toolUseId: editGroupId,
            entries: preEntries,
            // App-server pre-edit content is reverse-applied from the codex diff
            // against the post-apply disk state. It is deterministic and
            // authoritative -- MessageStreamingHandler must NOT clobber it
            // with whatever FileSnapshotCache observed via chokidar (which on
            // fresh gitignored sessions is the post-edit body, producing
            // all-green diffs).
            authoritative: true,
          },
        };
    const postEdit: StreamChunk | null = postEntries.length === 0
      ? null
      : { type: 'post_edit_snapshot', postEditSnapshot: { toolUseId: editGroupId, entries: postEntries } };

    return { preEdit, postEdit };
  }

  /**
   * Detect Codex todo items and update session metadata with currentTodos.
   * Supports both SDK raw events (`item.type = "todo_list"`) and app-server
   * notifications (`metadata.rawEvent = { method, params: { item: { type:
   * "todoList", ... } } }`).
   */
  private handleTodoListEvent(rawEvent: unknown, sessionId: string): void {
    if (!rawEvent || typeof rawEvent !== 'object') return;

    const record = rawEvent as Record<string, unknown>;
    const nestedParams = record.params;
    const item = record.item
      ?? (
        nestedParams
        && typeof nestedParams === 'object'
        && !Array.isArray(nestedParams)
          ? (nestedParams as Record<string, unknown>).item
          : undefined
      );
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;

    const itemRecord = item as Record<string, unknown>;
    if ((itemRecord.type !== 'todo_list' && itemRecord.type !== 'todoList') || !Array.isArray(itemRecord.items)) return;

    const todos = (itemRecord.items as Array<Record<string, unknown>>)
      .filter(t => t != null && typeof t === 'object')
      .map((t, index) => ({
        id: `codex-todo-${index}`,
        content: typeof t.text === 'string' ? t.text : String(t.text ?? ''),
        activeForm: typeof t.text === 'string' ? t.text : String(t.text ?? ''),
        status: t.completed ? 'completed' as const : 'in_progress' as const,
      }));

    this.emitTodoUpdate(sessionId, todos).catch(err => {
      console.error('[CODEX] Failed to emit todo update:', err);
    });
  }

  /**
   * Update session metadata with current todos.
   * Mirrors ClaudeCodeProvider.emitTodoUpdate for sidebar widget compatibility.
   */
  private async emitTodoUpdate(sessionId: string, todos: Array<{ id: string; content: string; activeForm: string; status: string }>): Promise<void> {
    try {
      const { AISessionsRepository } = await import('../../../storage/repositories/AISessionsRepository');
      const currentSession = await AISessionsRepository.get(sessionId);
      const currentMetadata = currentSession?.metadata || {};

      await AISessionsRepository.updateMetadata(sessionId, {
        metadata: {
          ...currentMetadata,
          currentTodos: todos,
        },
      });

      this.emit('message:logged', {
        sessionId,
        direction: 'output',
      });
    } catch (error) {
      console.error('[CODEX] Failed to update session metadata with todos:', error);
    }
  }

  private getRawEventType(rawEvent: unknown): string {
    if (rawEvent && typeof rawEvent === 'object') {
      const eventType = (rawEvent as Record<string, unknown>).type;
      if (typeof eventType === 'string' && eventType.trim().length > 0) {
        return eventType;
      }
    }
    return 'unknown';
  }

  private serializeRawCodexEvent(rawEvent: unknown): { content: string; usedFallback: boolean } {
    const result = safeJSONSerialize(rawEvent);

    // If the generic fallback was used, enhance it with the raw event type
    if (result.usedFallback) {
      return {
        content: JSON.stringify({
          type: this.getRawEventType(rawEvent),
          valueType: typeof rawEvent,
          fallback: true,
        }),
        usedFallback: true,
      };
    }

    return result;
  }


  /**
   * Request permission for an OpenAI Codex agent turn
   *
   * Uses ToolPermissionService to handle the full permission flow.
   */
  private async requestCodexTurnPermission(
    sessionId: string | undefined,
    workspacePath: string,
    permissionsPath: string,
    signal: AbortSignal
  ): Promise<{ decision: 'allow' | 'deny'; reason?: string; permissionMode?: PermissionMode }> {
    const pathForTrust = permissionsPath || workspacePath;

    // Check trust status
    if (pathForTrust && BaseAgentProvider.trustChecker) {
      const trustStatus = BaseAgentProvider.trustChecker(pathForTrust);

      if (!trustStatus.trusted) {
        this.logSecurity('[OpenAICodexProvider] Workspace not trusted, denying Codex turn', {
          workspacePath: pathForTrust,
        });
        return {
          decision: 'deny',
          reason: 'Workspace is not trusted. Please trust this workspace to use OpenAI Codex.'
        };
      }

      // IMPORTANT: Codex can only be used in "allow-all" or "bypass-all" mode
      // The Codex SDK does not support tool-level permission checks (no canUseTool callback)
      // We can only approve/deny entire turns, not individual tools
      // Therefore, we require users to explicitly opt-in to unrestricted mode
      if (trustStatus.mode === 'bypass-all' || trustStatus.mode === 'allow-all') {
        return { decision: 'allow', permissionMode: trustStatus.mode };
      }

      // Deny Codex in "ask" mode - tool-level permissions are not supported
      this.logSecurity('[OpenAICodexProvider] Codex requires "Allow Edits" permission mode', {
        currentMode: trustStatus.mode,
        workspacePath: pathForTrust,
      });
      return {
        decision: 'deny',
        reason: 'OpenAI Codex requires "Allow Edits" permission mode in Nimbalyst. Please change the permission mode in workspace settings to use Codex.'
      };
    }

    // No trust checker - allow by default (non-Electron environments)
    return { decision: 'allow' };
  }

}
