/**
 * Extension AI Tools Bridge
 *
 * Bridges extension-provided AI tools with the runtime's ToolRegistry
 * and exposes them to the MCP server in the main process.
 *
 * When extensions load, their AI tools are:
 * 1. Registered with the local tool registry (for non-Claude-Code providers)
 * 2. Exposed to the main process MCP server via IPC (for Claude Code)
 */

import { toolRegistry, type ToolDefinition } from '../ai/tools';
import { editorRegistry } from '../ai/EditorRegistry';
import { getExtensionLoader } from './ExtensionLoader';
import { getEditorAPI as getCentralEditorAPI, flushEditorSave, getRegisteredPaths } from './ExtensionEditorAPIRegistry';
import type { ExtensionAITool, ExtensionAIToolAccess, AIToolContext, LoadedExtension, ExtensionToolResult } from './types';

// Track which tools were registered by which extension
const extensionToolsMap = new Map<string, string[]>();

// Store tool handlers by namespaced name (for executing tools from MCP calls)
const toolHandlers = new Map<string, {
  tool: ExtensionAITool;
  extension: LoadedExtension;
}>();

/**
 * MCP tool definition format (serializable, no handler)
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  extensionId: string;
  scope: 'global' | 'editor';
  editorFilePatterns?: string[];
  /** Explicit document/editor access mode for this tool. */
  access?: ExtensionAIToolAccess;
  /** Legacy read-only flag. Prefer `access`. */
  readOnly?: boolean;
  /** When true, the tool is also exposed to the voice agent (OpenAI Realtime). */
  voiceAgent?: boolean;
}

const missingAccessWarnings = new Set<string>();

function getNamespacedToolName(extension: LoadedExtension, tool: ExtensionAITool): string {
  return tool.name.includes('.')
    ? tool.name
    : `${extension.manifest.id.split('.').pop()}.${tool.name}`;
}

function resolveToolAccess(tool: ExtensionAITool): ExtensionAIToolAccess {
  if (tool.access) return tool.access;
  if (tool.readOnly) return { kind: 'editor-read' };
  return { kind: 'editor-write' };
}

function warnForMissingAccess(toolName: string, tool: ExtensionAITool): void {
  if (tool.access || tool.readOnly || missingAccessWarnings.has(toolName)) return;
  missingAccessWarnings.add(toolName);
  console.warn(
    `[ExtensionAIToolsBridge] Tool ${toolName} does not declare an access mode. ` +
      'Falling back to editor-write compatibility behavior. Add ' +
      "`access: { kind: 'filesystem' }`, `editor-read`, or `editor-write`."
  );
}

// Callback for notifying about tool changes (set by renderer)
let onToolsChangedCallback: ((tools: MCPToolDefinition[]) => void) | null = null;

/**
 * Set the callback to be called when extension tools change.
 * Used by the renderer to notify the main process via IPC.
 */
export function setOnToolsChangedCallback(callback: (tools: MCPToolDefinition[]) => void): void {
  onToolsChangedCallback = callback;
  // Immediately notify with current tools
  notifyToolsChanged();
}

/**
 * Notify that tools have changed
 */
function notifyToolsChanged(): void {
  if (!onToolsChangedCallback) return;
  const tools = getMCPToolDefinitions();
  onToolsChangedCallback(tools);
}

/**
 * Get all extension tools in MCP format (serializable)
 */
export function getMCPToolDefinitions(): MCPToolDefinition[] {
  const loader = getExtensionLoader();
  if (!loader) return [];

  const tools: MCPToolDefinition[] = [];

  for (const extension of loader.getLoadedExtensions()) {
    if (!extension.enabled) continue;

    const extensionTools = Array.isArray(extension.module.aiTools) ? extension.module.aiTools : [];
    const customEditors = extension.manifest.contributions?.customEditors || [];

    // Get file patterns from custom editors for this extension
    const extensionFilePatterns = customEditors.flatMap((e: { filePatterns: string[] }) => e.filePatterns);

    for (const tool of extensionTools) {
      // Namespace the tool name
      const namespacedName = getNamespacedToolName(extension, tool);

      // Determine file patterns for editor-scoped tools
      const scope = tool.scope || 'editor';
      const editorFilePatterns = scope === 'editor'
        ? (tool.editorFilePatterns || extensionFilePatterns)
        : undefined;

      // Support both 'parameters' and 'inputSchema' field names
      // Also handle missing schema gracefully
      const schema = tool.parameters || (tool as any).inputSchema || { type: 'object', properties: {} };

      tools.push({
        name: namespacedName,
        description: tool.description,
        inputSchema: {
          type: 'object',
          properties: schema.properties || {},
          required: schema.required,
        },
        extensionId: extension.manifest.id,
        scope,
        editorFilePatterns,
        access: resolveToolAccess(tool),
        readOnly: tool.readOnly,
        voiceAgent: tool.voiceAgent === true,
      });
    }
  }

  return tools;
}

// Callbacks for ensuring editors are available for tool execution (set by platform service)
let ensureEditorCallback: ((filePath: string, workspacePath: string) => Promise<void>) | null = null;
let releaseEditorCallback: ((filePath: string) => void) | null = null;

/**
 * Set the callback for ensuring an editor is available for a file.
 * Called by the platform service (HiddenTabManager) to provide on-demand editor mounting.
 */
export function setEnsureEditorCallback(
  ensureEditor: (filePath: string, workspacePath: string) => Promise<void>,
  releaseEditor: (filePath: string) => void
): void {
  ensureEditorCallback = ensureEditor;
  releaseEditorCallback = releaseEditor;
}

// Keep legacy setter for backwards compatibility with existing offscreen system
export function setOffscreenMountCallback(callback: (filePath: string, workspacePath: string) => Promise<void>): void {
  // Wire legacy callback through the new interface
  ensureEditorCallback = callback;
}

/**
 * Execute an extension tool by name.
 * Called when the MCP server receives a tool call from Claude Code.
 *
 * If the tool requires an editor and the file is not currently open,
 * this will automatically mount it offscreen before invoking the tool.
 */
export async function executeExtensionTool(
  toolName: string,
  args: Record<string, unknown>,
  context: { workspacePath?: string; activeFilePath?: string }
): Promise<ExtensionToolResult> {
  const handler = toolHandlers.get(toolName);
  if (!handler) {
    // List available tools to help diagnose the issue
    const availableTools = Array.from(toolHandlers.keys());
    const suggestion = availableTools.length > 0
      ? `Available tools: ${availableTools.join(', ')}`
      : 'No extension tools are currently registered.';

    console.error(`[ExtensionAIToolsBridge] Tool not found: ${toolName}. ${suggestion}`);

    return {
      success: false,
      error: `Extension tool not found: ${toolName}`,
      toolName,
      errorContext: {
        availableTools,
        hint: 'Tool may not be registered, or the extension providing it is not loaded.',
      },
    };
  }

  const extensionId = handler.extension.manifest.id;
  const toolAccess = resolveToolAccess(handler.tool);
  const requiresEditor = toolAccess.kind === 'editor-read' || toolAccess.kind === 'editor-write';
  const shouldFlushEditor = toolAccess.kind === 'editor-write';
  warnForMissingAccess(toolName, handler.tool);

  // Resolve filePath: prefer explicit arg from agent, fall back to session state
  const resolvedFilePath = (args.filePath as string) || context.activeFilePath;

  let ensureEditorError: string | undefined;

  try {
    // Ensure an editor is available only for tools that explicitly need editor
    // state. Filesystem tools operate on latest disk content and must never
    // mount or flush a hidden editor just because a filePath was provided.
    if (requiresEditor && resolvedFilePath && context.workspacePath && ensureEditorCallback) {
      try {
        console.log(`[ExtensionAIToolsBridge] Ensuring editor available for ${resolvedFilePath}`);
        await ensureEditorCallback(resolvedFilePath, context.workspacePath);
      } catch (mountError) {
        ensureEditorError = mountError instanceof Error ? mountError.message : String(mountError);
        console.warn(`[ExtensionAIToolsBridge] Failed to ensure editor:`, mountError);
        // Continue — the editor may already be open in a visible tab
      }
    }

    const editorAPI = requiresEditor && resolvedFilePath ? getCentralEditorAPI(resolvedFilePath) : undefined;

    // If the editor failed to mount AND the API still isn't available,
    // return a diagnostic error instead of letting the tool fail with a vague message.
    if (requiresEditor && resolvedFilePath && !editorAPI && ensureEditorError) {
      const registeredPaths = getRegisteredPaths();
      console.error(
        `[ExtensionAIToolsBridge] Editor mount failed and no API available for ${resolvedFilePath}.`,
        `Mount error: ${ensureEditorError}.`,
        `Registered paths (${registeredPaths.length}):`,
        registeredPaths.length <= 10 ? registeredPaths : registeredPaths.slice(0, 10).concat('...')
      );
      return {
        success: false,
        error: `Failed to initialize editor for ${resolvedFilePath}: ${ensureEditorError}. ` +
          'The file exists but the editor could not mount. Try calling the tool again.',
        extensionId,
        toolName,
        errorContext: {
          resolvedFilePath,
          registeredEditorPaths: registeredPaths,
          ensureEditorError,
          hint: 'The editor initialization timed out or failed. This can happen if the file is very large or the editor extension is still loading.',
        },
      };
    }

    // Log diagnostic info when editor API isn't found despite having a file path
    if (requiresEditor && resolvedFilePath && !editorAPI) {
      const registeredPaths = getRegisteredPaths();
      console.warn(
        `[ExtensionAIToolsBridge] No editor API found for ${resolvedFilePath}.`,
        `Registered paths (${registeredPaths.length}):`,
        registeredPaths.length <= 10 ? registeredPaths : registeredPaths.slice(0, 10).concat('...')
      );
    }

    const aiContext: AIToolContext = {
      workspacePath: context.workspacePath,
      activeFilePath: resolvedFilePath,
      extensionContext: handler.extension.context,
      editorAPI,
    };

    const result = await handler.tool.handler(args, aiContext);

    // Persist only tools that explicitly mutate editor state. Filesystem and
    // editor-read tools never flush editor buffers.
    if (resolvedFilePath && shouldFlushEditor) {
      await flushEditorSave(resolvedFilePath);
    }

    // Release the hidden editor reference (starts TTL countdown)
    if (requiresEditor && resolvedFilePath && releaseEditorCallback) {
      releaseEditorCallback(resolvedFilePath);
    }

    // Ensure the result includes extension metadata
    return {
      ...result,
      extensionId,
      toolName,
    };
  } catch (error) {
    // Release the hidden editor reference on error too
    if (requiresEditor && resolvedFilePath && releaseEditorCallback) {
      releaseEditorCallback(resolvedFilePath);
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error executing extension tool';
    const stack = error instanceof Error ? error.stack : undefined;

    // Detect common errors and provide helpful diagnostics
    let diagnosticHint: string | undefined;

    // Common: accessing wrong context property
    if (errorMessage.includes('filePath') && errorMessage.includes('undefined')) {
      diagnosticHint = 'Tool may be accessing "context.filePath" which does not exist. ' +
        'Use "context.activeFilePath" instead.';
    }

    // Common: accessing properties on undefined context
    if (errorMessage.includes("Cannot read propert") && errorMessage.includes("undefined")) {
      diagnosticHint = 'Tool is accessing a property on an undefined value. ' +
        'Check that context.workspacePath and context.activeFilePath may be undefined ' +
        'when no file is open.';
    }

    // Common: registerAITool wrong API
    if (errorMessage.includes('registerAITool') || errorMessage.includes('registerTool')) {
      diagnosticHint = 'The AI tool registration API is "context.services.ai.registerTool()", ' +
        'not "context.registerAITool()". Tools are registered via the module export, not in activate().';
    }

    // Common: returning wrong format
    if (errorMessage.includes('success') && errorMessage.includes('boolean')) {
      diagnosticHint = 'Tool handlers must return { success: boolean, message?: string, data?: unknown }. ' +
        'Ensure the return value has the correct shape.';
    }

    // Log the full error for debugging
    console.error(`[ExtensionAIToolsBridge] Tool execution failed:`, {
      toolName,
      extensionId,
      error: errorMessage,
      stack,
      diagnosticHint,
      args: JSON.stringify(args).substring(0, 500), // Truncate large args
      context: {
        workspacePath: context.workspacePath,
        activeFilePath: context.activeFilePath,
      },
    });

    return {
      success: false,
      error: errorMessage,
      extensionId,
      toolName,
      stack,
      errorContext: {
        extensionName: handler.extension.manifest.name,
        activeFilePath: context.activeFilePath,
        workspacePath: context.workspacePath,
        hint: diagnosticHint,
      },
    };
  }
}

/**
 * Convert an ExtensionAITool to a ToolDefinition compatible with the runtime registry
 */
function convertExtensionTool(
  extensionId: string,
  tool: ExtensionAITool,
  extension: LoadedExtension
): ToolDefinition {
  // Namespace the tool name with extension ID to avoid conflicts
  const namespacedName = tool.name.includes('.')
    ? tool.name
    : `${extensionId.split('.').pop()}.${tool.name}`;

  // Support both 'parameters' and 'inputSchema' field names
  // Also handle missing schema gracefully
  const schema = tool.parameters || (tool as any).inputSchema || { type: 'object', properties: {} };

  return {
    name: namespacedName,
    description: tool.description,
    parameters: {
      type: 'object',
      properties: schema.properties || {},
      required: schema.required,
    },
    source: 'runtime',
    handler: async (args: Record<string, unknown>) => {
      // Create the AI tool context with active file path from editor registry
      const context: AIToolContext = {
        workspacePath: undefined,
        activeFilePath: editorRegistry.getActiveFilePath() ?? undefined,
        extensionContext: extension.context,
      };

      // Call the extension's tool handler
      const result = await tool.handler(args, context);
      return result;
    },
  };
}

/**
 * Register AI tools from a loaded extension
 */
export function registerExtensionTools(extension: LoadedExtension): void {
  const { manifest, module } = extension;

  // console.info(
  //   `[ExtensionAIToolsBridge] Checking extension ${manifest.id} for AI tools:`,
  //   module.aiTools?.length ?? 0,
  //   'tools found'
  // );

  if (!module.aiTools || !Array.isArray(module.aiTools) || module.aiTools.length === 0) {
    return;
  }

  const registeredTools: string[] = [];

  for (const tool of module.aiTools) {
    try {
      const toolDef = convertExtensionTool(manifest.id, tool, extension);
      toolRegistry.register(toolDef);
      registeredTools.push(toolDef.name);

      // Store handler for MCP execution
      toolHandlers.set(toolDef.name, { tool, extension });

      // console.info(
      //   `[ExtensionAIToolsBridge] Registered tool: ${toolDef.name} from ${manifest.name}`
      // );
    } catch (error) {
      console.error(
        `[ExtensionAIToolsBridge] Failed to register tool ${tool.name} from ${manifest.id}:`,
        error
      );
    }
  }

  if (registeredTools.length > 0) {
    extensionToolsMap.set(manifest.id, registeredTools);
    // Notify about tool changes for MCP
    notifyToolsChanged();
  }
}

/**
 * Unregister AI tools from an extension
 */
export function unregisterExtensionTools(extensionId: string): void {
  const tools = extensionToolsMap.get(extensionId);
  if (!tools) return;

  for (const toolName of tools) {
    toolRegistry.unregister(toolName);
    toolHandlers.delete(toolName);
    // console.info(`[ExtensionAIToolsBridge] Unregistered tool: ${toolName}`);
  }

  extensionToolsMap.delete(extensionId);
  // Notify about tool changes for MCP
  notifyToolsChanged();
}

/**
 * Initialize the AI tools bridge.
 * Call this after extensions are loaded to register all their tools.
 */
export function initializeExtensionAIToolsBridge(): void {
  const loader = getExtensionLoader();
  if (!loader) {
    console.warn('[ExtensionAIToolsBridge] No extension loader available');
    return;
  }

  // Register tools from already-loaded extensions
  const loadedExtensions = loader.getLoadedExtensions();
  for (const extension of loadedExtensions) {
    registerExtensionTools(extension);
  }

  // Listen for future extension loads/unloads
  loader.subscribe(() => {
    // Get current extensions and sync tools
    const currentExtensions = loader.getLoadedExtensions();
    const currentIds = new Set(currentExtensions.map((e) => e.manifest.id));

    // Unregister tools from removed extensions
    for (const extensionId of extensionToolsMap.keys()) {
      if (!currentIds.has(extensionId)) {
        unregisterExtensionTools(extensionId);
      }
    }

    // Register tools from new extensions
    for (const extension of currentExtensions) {
      if (!extensionToolsMap.has(extension.manifest.id)) {
        registerExtensionTools(extension);
      }
    }
  });

  console.info('[ExtensionAIToolsBridge] Initialized');
}

/**
 * Get all tools registered by extensions
 */
export function getExtensionTools(): ToolDefinition[] {
  const allToolNames = new Set<string>();
  for (const tools of extensionToolsMap.values()) {
    tools.forEach((name) => allToolNames.add(name));
  }

  return Array.from(allToolNames)
    .map((name) => toolRegistry.get(name))
    .filter((t): t is ToolDefinition => t !== undefined);
}
