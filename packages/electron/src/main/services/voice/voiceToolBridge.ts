/**
 * Voice Tool Bridge (pure helpers)
 *
 * Converts extension AI-tool definitions (the serialized form stored in the
 * main-process registry) into OpenAI Realtime function-tool schemas, so any
 * extension that opts in with `voiceAgent: true` can expose tools to the voice
 * agent in addition to (or instead of) the coding agent.
 *
 * This module is intentionally pure and free of any electron/ws imports so the
 * conversion + name-sanitization rules can be unit-tested in isolation. The
 * stateful integration (appending schemas to the Realtime session, routing the
 * dispatch back through the existing extension-tool execution path) lives in
 * `RealtimeAPIClient` and `VoiceModeService`.
 */

/**
 * The shape of an extension tool definition as stored in the main-process
 * registry (`ExtensionToolDefinition`). Only the fields the bridge needs are
 * declared here; the real definition carries more.
 */
export interface VoiceCapableToolDefinition {
  /** Namespaced tool name, may contain dots (e.g. `memory.search`). */
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** When true, the tool is exposed to the voice agent. */
  voiceAgent?: boolean;
}

/** A function tool in the OpenAI Realtime session-config shape. */
export interface RealtimeFunctionTool {
  type: 'function';
  /** Realtime-safe name (dots replaced); must match ^[a-zA-Z0-9_-]+$. */
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface VoiceToolSet {
  /** Realtime function-tool schemas to append to the session `tools` array. */
  schemas: RealtimeFunctionTool[];
  /**
   * Maps a realtime-safe tool name back to its original namespaced name, so the
   * dispatcher can hand the namespaced name to the existing extension-tool
   * execution path (which matches against the registered, dotted names).
   */
  nameMap: Map<string, string>;
}

export interface BuildVoiceToolSetOptions {
  /**
   * Realtime names reserved by built-in voice tools (e.g. `submit_agent_prompt`).
   * Extension tools whose sanitized name collides with one of these are skipped
   * so a built-in is never shadowed in the tool list.
   */
  reservedNames?: Set<string>;
}

// OpenAI Realtime function names must match ^[a-zA-Z0-9_-]+$. Dots (used in our
// namespaced tool names) are illegal, so replace any disallowed character.
const DISALLOWED_NAME_CHARS = /[^a-zA-Z0-9_-]/g;

/** Sanitize a namespaced tool name into a Realtime-API-safe function name. */
export function toRealtimeToolName(namespacedName: string): string {
  return namespacedName.replace(DISALLOWED_NAME_CHARS, '_');
}

/** Convert a single extension tool definition into a Realtime function tool. */
export function toRealtimeFunctionTool(tool: VoiceCapableToolDefinition): RealtimeFunctionTool {
  const properties = tool.inputSchema?.properties ?? {};
  const required = tool.inputSchema?.required;
  return {
    type: 'function',
    name: toRealtimeToolName(tool.name),
    description: tool.description,
    parameters: {
      type: 'object',
      properties,
      ...(required && required.length > 0 ? { required } : {}),
    },
  };
}

/**
 * Build the set of Realtime function-tool schemas (plus a reverse name map) for
 * a list of extension tool definitions. Filters to voice-enabled tools, skips
 * reserved/built-in name collisions, and de-dupes tools that sanitize to the
 * same realtime name (first one wins).
 */
export function buildVoiceToolSet(
  tools: VoiceCapableToolDefinition[],
  options: BuildVoiceToolSetOptions = {}
): VoiceToolSet {
  const reserved = options.reservedNames ?? new Set<string>();
  const schemas: RealtimeFunctionTool[] = [];
  const nameMap = new Map<string, string>();

  for (const tool of tools) {
    if (!tool?.voiceAgent) continue;
    const realtimeName = toRealtimeToolName(tool.name);
    if (reserved.has(realtimeName)) continue;
    if (nameMap.has(realtimeName)) continue;
    schemas.push(toRealtimeFunctionTool(tool));
    nameMap.set(realtimeName, tool.name);
  }

  return { schemas, nameMap };
}
