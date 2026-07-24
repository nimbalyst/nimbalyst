/**
 * Backend MCP tool registry (main process).
 *
 * Backend modules (utility-process) register MCP tools via the
 * `registerMcpTools` broker. Unlike renderer-declared extension tools (whose
 * handlers run in the renderer and are tracked in `mcpWorkspaceResolver`), these
 * tools are EXECUTED by the backend module itself: the host routes a call back
 * to the module over the typed RPC bridge (`PrivilegedExtensionHost.request`).
 *
 * This module is the in-memory catalog of those tools, keyed by the workspace
 * the registering module was started for. It is intentionally free of electron
 * imports so it can be unit-tested in isolation. The fan-out into the
 * coding-agent / voice tool surfaces and the execution routing live in
 * `httpServer.ts`, `VoiceModeService`, and `tools/backendToolHandler.ts`.
 */

/** A backend-module-provided MCP tool, as advertised + routed by the host. */
export interface BackendToolDefinition {
  /**
   * Advertised, namespaced name shown to agents (e.g.
   * `memory.search_project_knowledge`). Namespaced with the extension's short
   * name to avoid collisions across extensions.
   */
  name: string;
  /**
   * The RPC method name the backend module exposes in its `methods` map. The
   * host invokes this via `PrivilegedExtensionHost.request({ method })`.
   */
  method: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  extensionId: string;
  moduleId: string;
  /** When true, the tool is also exposed to the voice agent (OpenAI Realtime). */
  voiceAgent?: boolean;
  scope?: 'global' | 'editor';
}

/** The raw per-tool shape a backend module sends over `registerMcpTools`. */
export interface RegisterBackendToolInput {
  name: string;
  description?: string;
  inputSchema?: unknown;
  voiceAgent?: boolean;
  scope?: 'global' | 'editor';
}

// Keyed by the workspacePath the registering module was started for.
const backendToolsByWorkspace = new Map<string, BackendToolDefinition[]>();

type ChangeNotifier = (workspacePath: string) => void;
let changeNotifier: ChangeNotifier | null = null;

/**
 * Register a notifier called whenever a workspace's backend tool set changes,
 * so the MCP layer can tell connected sessions to re-fetch their tool list.
 * Set once by `httpServer` at startup; kept here to avoid a hard dependency.
 */
export function setBackendToolsChangeNotifier(fn: ChangeNotifier | null): void {
  changeNotifier = fn;
}

/** Derive the extension short-name used to namespace advertised tool names. */
function extensionShortName(extensionId: string): string {
  const parts = extensionId.split('.');
  return parts[parts.length - 1] || extensionId;
}

function normalizeSchema(raw: unknown): BackendToolDefinition['inputSchema'] {
  const schema = (raw ?? {}) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    type: 'object',
    properties: schema.properties ?? {},
    ...(Array.isArray(schema.required) && schema.required.length > 0
      ? { required: schema.required }
      : {}),
  };
}

/**
 * Replace the tool set a given (extensionId, moduleId) contributes for a
 * workspace. Re-registration is idempotent: prior tools from the same module
 * are dropped first, so a module that re-registers a smaller set doesn't leave
 * stale tools behind. Returns the advertised (namespaced) names registered.
 */
export function registerBackendTools(
  workspacePath: string,
  extensionId: string,
  moduleId: string,
  tools: RegisterBackendToolInput[]
): string[] {
  const shortName = extensionShortName(extensionId);
  const existing = backendToolsByWorkspace.get(workspacePath) ?? [];
  const kept = existing.filter(
    (t) => !(t.extensionId === extensionId && t.moduleId === moduleId)
  );
  const added: BackendToolDefinition[] = tools.map((t) => ({
    name: `${shortName}.${t.name}`,
    method: t.name,
    description: t.description ?? '',
    inputSchema: normalizeSchema(t.inputSchema),
    extensionId,
    moduleId,
    voiceAgent: t.voiceAgent === true,
    scope: t.scope ?? 'global',
  }));
  backendToolsByWorkspace.set(workspacePath, [...kept, ...added]);
  changeNotifier?.(workspacePath);
  return added.map((t) => t.name);
}

/** Remove a module's tools from one workspace (e.g. module stopped/crashed). */
export function clearBackendTools(
  workspacePath: string,
  extensionId: string,
  moduleId: string
): void {
  const existing = backendToolsByWorkspace.get(workspacePath);
  if (!existing) return;
  const kept = existing.filter(
    (t) => !(t.extensionId === extensionId && t.moduleId === moduleId)
  );
  if (kept.length > 0) {
    backendToolsByWorkspace.set(workspacePath, kept);
  } else {
    backendToolsByWorkspace.delete(workspacePath);
  }
  changeNotifier?.(workspacePath);
}

/**
 * Remove a module's tools across ALL workspaces. Used on disable/uninstall
 * where the caller may not know every workspace the module ran in.
 */
export function clearBackendToolsForModule(extensionId: string, moduleId: string): void {
  for (const workspacePath of Array.from(backendToolsByWorkspace.keys())) {
    clearBackendTools(workspacePath, extensionId, moduleId);
  }
}

/** All backend tools registered for a workspace. */
export function getBackendTools(workspacePath: string | undefined): BackendToolDefinition[] {
  if (!workspacePath) return [];
  return backendToolsByWorkspace.get(workspacePath) ?? [];
}

/** Backend tools opted in to the voice agent for a workspace. */
export function getVoiceEnabledBackendTools(
  workspacePath: string | undefined
): BackendToolDefinition[] {
  return getBackendTools(workspacePath).filter((t) => t.voiceAgent === true);
}

/**
 * Resolve an advertised tool name to its registry entry, tolerating name
 * sanitization (dots replaced with underscores by providers that disallow dots
 * — the same reversal `extensionToolHandler` does).
 */
export function findBackendTool(
  workspacePath: string | undefined,
  toolName: string
): BackendToolDefinition | undefined {
  const tools = getBackendTools(workspacePath);
  const direct = tools.find((t) => t.name === toolName);
  if (direct) return direct;
  return tools.find((t) => t.name.includes('.') && t.name.replace(/\./g, '_') === toolName);
}

/**
 * Resolve a tool ONLY if it belongs to `callerExtensionId`. Returns undefined
 * for an unknown tool or one owned by a different extension.
 *
 * This is the isolation gate for the renderer->backend bridge: backend tools are
 * keyed by workspace, not by extension, so a bare name lookup would let one
 * enabled extension invoke another extension's backend tool (e.g.
 * `memory.delete_fact`). The IPC handler must use THIS, not `findBackendTool`,
 * for renderer-originated calls. (The trusted AI-agent / httpServer path is not
 * caller-scoped and continues to use `findBackendTool`.)
 */
export function findOwnedBackendTool(
  workspacePath: string | undefined,
  toolName: string,
  callerExtensionId: string
): BackendToolDefinition | undefined {
  const entry = findBackendTool(workspacePath, toolName);
  if (!entry || entry.extensionId !== callerExtensionId) return undefined;
  return entry;
}

/** Test-only: clear the whole registry. */
export function _resetBackendToolRegistry(): void {
  backendToolsByWorkspace.clear();
  changeNotifier = null;
}
