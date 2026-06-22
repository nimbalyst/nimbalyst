/**
 * Register the Extension System with its Electron-specific platform service.
 *
 * This sets up the ExtensionPlatformService implementation that provides
 * the Electron-specific functionality for loading extensions, and
 * initializes the extension loader.
 */

import {
  setExtensionPlatformService,
  initializeExtensions,
  initializeExtensionAIToolsBridge,
  setOnToolsChangedCallback,
  getMCPToolDefinitions,
  executeExtensionTool,
  setEnabledStateProvider,
  setConfigurationServiceProvider,
  screenshotService,
  getExtensionLoader,
  setOffscreenMountCallback,
  setEnsureEditorCallback,
} from '@nimbalyst/runtime';
import { ExtensionPlatformServiceImpl } from '../services/ExtensionPlatformServiceImpl';
import { initializeExtensionEditorBridge } from '../extensions/ExtensionEditorBridge';
import { initializeExtensionPluginBridge } from '../extensions/ExtensionPluginBridge';
import { initializeExtensionDocumentHeaderBridge, syncExtensionDocumentHeaders } from '../extensions/ExtensionDocumentHeaderBridge';
import { syncExtensionEditors } from '../extensions/ExtensionEditorBridge';
import { initializeExtensionThemeBridge } from '../extensions/ExtensionThemeBridge';
import { initializeExtensionAgentProviderSync } from '../store/extensionAgentProviderSync';
import { hiddenTabManager } from '../services/HiddenTabManager';

// Track workspace path for MCP tool registration
let currentWorkspacePath: string | null = null;

// Track if screenshot IPC listener is set up
let screenshotListenerSetup = false;

// Track if extension dev listeners are set up
let extensionDevListenersSetup = false;

// Track if editor screenshot listener is set up
let editorScreenshotListenerSetup = false;

// Track if extension status listener is set up
let extensionStatusListenerSetup = false;

// Track if extension tool execution listener is set up
let extensionToolListenerSetup = false;

// Track if renderer eval listener is set up
let rendererEvalListenerSetup = false;

// Track if extension test listeners are set up
let extensionTestListenersSetup = false;

/**
 * Set up IPC listener for screenshot capture requests from main process.
 * Uses the generic screenshotService to route requests to the appropriate capability.
 */
function setupScreenshotIPCListener(): void {
  if (screenshotListenerSetup) return;
  screenshotListenerSetup = true;

  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.on) {
    console.warn('[ExtensionSystem] electronAPI.on not available for screenshot listener');
    return;
  }

  electronAPI.on('screenshot:capture', async (data: { requestId: string; filePath: string }) => {
    console.log(`[ExtensionSystem] Screenshot capture request for: ${data.filePath}`);

    try {
      const base64Data = await screenshotService.capture(data.filePath);

      // Send result back to main process
      await electronAPI.invoke('screenshot:result-' + data.requestId, {
        requestId: data.requestId,
        success: true,
        imageBase64: base64Data,
      });
    } catch (error) {
      console.error('[ExtensionSystem] Screenshot capture failed:', error);

      // Send error result back to main process
      await electronAPI.invoke('screenshot:result-' + data.requestId, {
        requestId: data.requestId,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  console.log('[ExtensionSystem] Screenshot IPC listener set up');
}

/**
 * Set up IPC listeners for extension development hot-loading.
 * These receive messages from the main process to reload/unload extensions.
 */
function setupExtensionDevListeners(): void {
  if (extensionDevListenersSetup) return;
  extensionDevListenersSetup = true;

  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.extensions?.onDevReload || !electronAPI?.extensions?.onDevUnload) {
    console.warn('[ExtensionSystem] Extension dev API not available');
    return;
  }

  // Listen for extension reload requests
  electronAPI.extensions.onDevReload(async (data: { extensionId: string; extensionPath: string }) => {
    console.log(`[ExtensionSystem] Received dev-reload request for ${data.extensionId} from ${data.extensionPath}`);

    try {
      const loader = getExtensionLoader();
      const result = await loader.loadExtensionFromPath(data.extensionPath);

      if (result.success) {
        console.log(`[ExtensionSystem] Successfully reloaded extension ${data.extensionId}`);
        // The ExtensionLoader notifies listeners, which triggers sync functions
        // But we'll call them explicitly to ensure the bridges are updated
        syncExtensionEditors();
        syncExtensionDocumentHeaders();
      } else {
        console.error(`[ExtensionSystem] Failed to reload extension ${data.extensionId}: ${result.error}`);
      }
    } catch (error) {
      console.error(`[ExtensionSystem] Error reloading extension ${data.extensionId}:`, error);
    }
  });

  // Listen for extension unload requests
  electronAPI.extensions.onDevUnload(async (data: { extensionId: string }) => {
    console.log(`[ExtensionSystem] Received dev-unload request for ${data.extensionId}`);

    try {
      const loader = getExtensionLoader();
      await loader.unloadExtension(data.extensionId);
      console.log(`[ExtensionSystem] Successfully unloaded extension ${data.extensionId}`);
      // The ExtensionLoader notifies listeners, which triggers sync functions
      syncExtensionEditors();
      syncExtensionDocumentHeaders();
    } catch (error) {
      console.error(`[ExtensionSystem] Error unloading extension ${data.extensionId}:`, error);
    }
  });

  console.log('[ExtensionSystem] Extension dev IPC listeners set up');
}

/**
 * Set up IPC listener for editor screenshot capture requests.
 * Captures screenshots of any editor content (not just mockups).
 */
function setupEditorScreenshotListener(): void {
  if (editorScreenshotListenerSetup) return;
  editorScreenshotListenerSetup = true;

  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.on) {
    console.warn('[ExtensionSystem] electronAPI.on not available for editor screenshot listener');
    return;
  }

  electronAPI.on('editor:capture-screenshot', async (data: { requestId: string; filePath?: string; selector?: string }) => {
    console.log(`[ExtensionSystem] Editor screenshot capture request:`, data);

    try {
      // Find the editor element to capture
      let targetElement: HTMLElement | null = null;
      let selectorUsed = '';

      if (data.selector) {
        // Capture specific element if selector provided
        targetElement = document.querySelector(data.selector);
        selectorUsed = data.selector;
        if (!targetElement) {
          throw new Error(`Element not found for selector: ${data.selector}`);
        }
      } else if (data.filePath) {
        // Find the editor by file path - TabEditor has data-file-path attribute
        const editorWrapper = document.querySelector(`[data-file-path="${data.filePath}"]`) as HTMLElement | null;
        if (editorWrapper) {
          // Try to find the best element to capture within this editor
          const contentSelectors = [
            '.editor-content',
            '.spreadsheet-editor',
            '.excalidraw-editor',
            '.custom-editor',
          ];
          for (const selector of contentSelectors) {
            const content = editorWrapper.querySelector(selector) as HTMLElement | null;
            if (content) {
              const rect = content.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                targetElement = content;
                selectorUsed = `[data-file-path] ${selector}`;
                break;
              }
            }
          }
          // Fall back to the wrapper itself if no content found
          if (!targetElement) {
            const rect = editorWrapper.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              targetElement = editorWrapper;
              selectorUsed = `[data-file-path="${data.filePath}"]`;
            }
          }
        }
      }

      // Fallback: try generic selectors if file path didn't work
      if (!targetElement) {
        const fallbackSelectors = [
          '.multi-editor-instance .editor-content',
          '.multi-editor-instance .spreadsheet-editor',
          '.multi-editor-instance .excalidraw-editor',
          '.multi-editor-instance .custom-editor',
          '.multi-editor-instance',
          '.tab-editor-content',
          '.editor',
        ];

        outerLoop:
        for (const selector of fallbackSelectors) {
          const elements = document.querySelectorAll(selector) as NodeListOf<HTMLElement>;
          for (const el of elements) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              targetElement = el;
              selectorUsed = selector;
              break outerLoop;
            }
          }
        }
      }

      if (!targetElement) {
        // Collect diagnostic info about what we found
        const diagnostics: string[] = [];

        // Check file path selector first
        if (data.filePath) {
          const filePathSelector = `[data-file-path="${data.filePath}"]`;
          const editorByPath = document.querySelector(filePathSelector) as HTMLElement | null;
          if (editorByPath) {
            const rect = editorByPath.getBoundingClientRect();
            diagnostics.push(`${filePathSelector}: found (${rect.width}x${rect.height})`);
          } else {
            diagnostics.push(`${filePathSelector}: not found - file may not be open in a tab`);
          }
        }

        const diagnosticSelectors = [
          '.multi-editor-instance .editor-content',
          '.multi-editor-instance .spreadsheet-editor',
          '.multi-editor-instance .excalidraw-editor',
          '.multi-editor-instance .custom-editor',
          '.multi-editor-instance',
          '.tab-editor-content',
          '.editor',
        ];
        for (const selector of diagnosticSelectors) {
          const elements = document.querySelectorAll(selector) as NodeListOf<HTMLElement>;
          if (elements.length > 0) {
            const visibleCount = Array.from(elements).filter(el => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }).length;
            diagnostics.push(`${selector}: ${elements.length} found, ${visibleCount} visible`);
          } else {
            diagnostics.push(`${selector}: not found`);
          }
        }
        throw new Error(`No editor element found to capture. Diagnostics:\n${diagnostics.join('\n')}`);
      }

      // Log element info for debugging
      const rect = targetElement.getBoundingClientRect();
      console.log(`[ExtensionSystem] Capturing element:`, {
        selector: selectorUsed,
        tagName: targetElement.tagName,
        className: targetElement.className,
        boundingRect: { width: rect.width, height: rect.height },
        scrollDimensions: { width: targetElement.scrollWidth, height: targetElement.scrollHeight },
      });

      // Dynamically import html2canvas
      const html2canvas = (await import('html2canvas')).default;

      // Use bounding rect dimensions if scroll dimensions are 0
      const captureWidth = targetElement.scrollWidth || rect.width;
      const captureHeight = targetElement.scrollHeight || rect.height;

      if (captureWidth === 0 || captureHeight === 0) {
        throw new Error(`Element has zero dimensions (${captureWidth}x${captureHeight}). The editor may not be visible.`);
      }

      // Capture the element
      const canvas = await html2canvas(targetElement, {
        backgroundColor: null,
        scale: 2, // Higher resolution
        useCORS: true,
        allowTaint: true,
        logging: false,
        windowWidth: captureWidth,
        windowHeight: captureHeight,
      });

      // Validate canvas dimensions
      if (canvas.width === 0 || canvas.height === 0) {
        throw new Error(`Canvas has zero dimensions (${canvas.width}x${canvas.height}). The editor element may not be visible or rendered.`);
      }

      // Convert to base64
      const dataUrl = canvas.toDataURL('image/png');
      const base64Data = dataUrl.split(',')[1];

      // Validate that we got actual image data
      if (!base64Data || base64Data.length === 0) {
        throw new Error('Canvas produced empty image data. This may indicate a rendering issue with the editor element.');
      }

      console.log(`[ExtensionSystem] Editor screenshot captured successfully (${canvas.width}x${canvas.height}, ${base64Data.length} bytes)`);

      // Send result back to main process - use send since main uses ipcMain.once
      electronAPI.send(data.requestId, {
        success: true,
        imageBase64: base64Data,
        mimeType: 'image/png'
      });
    } catch (error) {
      console.error('[ExtensionSystem] Editor screenshot capture failed:', error);

      // Send error result back to main process - use send since main uses ipcMain.once
      electronAPI.send(data.requestId, {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  console.log('[ExtensionSystem] Editor screenshot IPC listener set up');
}

/**
 * Set up IPC listener for extension status queries.
 * Returns information about loaded extensions including their contributions.
 */
function setupExtensionStatusListener(): void {
  if (extensionStatusListenerSetup) return;
  extensionStatusListenerSetup = true;

  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.on) {
    console.warn('[ExtensionSystem] electronAPI.on not available for extension status listener');
    return;
  }

  electronAPI.on('extension:get-status', async (data: { extensionId: string; responseChannel: string }) => {
    console.log(`[ExtensionSystem] Extension status query for: ${data.extensionId}`);

    try {
      const loader = getExtensionLoader();
      const extension = loader.getExtension(data.extensionId);

      if (!extension) {
        // Extension not found - use send instead of invoke since main uses ipcMain.once
        electronAPI.send(data.responseChannel, {
          error: 'Extension not found',
          status: 'not_installed'
        });
        return;
      }

      // Get extension manifest for contributions info
      const manifest = extension.manifest;
      const contributions = {
        customEditors: manifest.contributions?.customEditors || [],
        aiTools: manifest.contributions?.aiTools || [],
        newFileMenu: manifest.contributions?.newFileMenu || [],
      };

      // Extension is loaded if we found it
      const status = extension.enabled ? 'loaded' : 'disabled';

      // Use send instead of invoke since main uses ipcMain.once
      electronAPI.send(data.responseChannel, {
        status,
        contributions,
        manifest: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
        }
      });
    } catch (error) {
      console.error('[ExtensionSystem] Extension status query failed:', error);

      electronAPI.send(data.responseChannel, {
        error: error instanceof Error ? error.message : String(error),
        status: 'error'
      });
    }
  });

  console.log('[ExtensionSystem] Extension status IPC listener set up');
}

/**
 * Serialize a value for returning to the MCP renderer_eval tool.
 * Handles special types like DOM elements, functions, etc.
 */
function serializeEvalResult(result: unknown): string {
  try {
    if (result === undefined) {
      return 'undefined';
    } else if (result === null) {
      return 'null';
    } else if (typeof result === 'function') {
      return `[Function: ${(result as { name?: string }).name || 'anonymous'}]`;
    } else if (result instanceof Element) {
      const html = result.outerHTML;
      return html.substring(0, 1000) + (html.length > 1000 ? '...' : '');
    } else if (result instanceof NodeList || result instanceof HTMLCollection) {
      return `[${result.constructor.name}: ${result.length} items]`;
    } else if (typeof result === 'object') {
      const json = JSON.stringify(result, null, 2);
      if (json.length > 10000) {
        return json.substring(0, 10000) + '\n... (truncated)';
      }
      return json;
    } else {
      return String(result);
    }
  } catch {
    return `[Unserializable: ${typeof result}]`;
  }
}

/**
 * Set up IPC listener for renderer eval requests.
 * Executes JavaScript expressions in the renderer context for debugging.
 * Only active in development mode.
 */
function setupRendererEvalListener(): void {
  if (rendererEvalListenerSetup) return;
  rendererEvalListenerSetup = true;

  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.on) {
    console.warn('[ExtensionSystem] electronAPI.on not available for renderer eval listener');
    return;
  }

  electronAPI.on('renderer:eval', async (data: { expression: string; responseChannel: string }) => {
    console.log('[ExtensionSystem] Renderer eval request');

    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
        ...args: string[]
      ) => () => Promise<unknown>;

      // Compile as an async function to support await expressions and
      // multi-statement snippets without relying on eval().
      let asyncEval: () => Promise<unknown>;
      try {
        asyncEval = new AsyncFunction(`return (${data.expression});`);
      } catch (syntaxErr) {
        if (syntaxErr instanceof SyntaxError) {
          asyncEval = new AsyncFunction(data.expression);
        } else {
          throw syntaxErr;
        }
      }

      const result = await asyncEval();

      electronAPI.send(data.responseChannel, {
        value: serializeEvalResult(result)
      });
    } catch (error) {
      console.error('[ExtensionSystem] Renderer eval failed:', error);

      electronAPI.send(data.responseChannel, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
    }
  });

  console.log('[ExtensionSystem] Renderer eval IPC listener set up');
}

/**
 * Set up IPC listeners for extension test tools (open-file, ai-tool).
 * These support the extension_test_open_file and extension_test_ai_tool MCP tools.
 */
function setupExtensionTestListeners(): void {
  if (extensionTestListenersSetup) return;
  extensionTestListenersSetup = true;

  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.on || !electronAPI?.send) {
    console.warn('[ExtensionSystem] electronAPI not available for extension test listeners');
    return;
  }

  // Handle extension_test_open_file requests
  electronAPI.on('extension-test:open-file', async (data: {
    filePath: string;
    waitForExtension?: string;
    timeout: number;
    responseChannel: string;
  }) => {
    // console.log('[ExtensionSystem] Extension test: open file', data.filePath);

    try {
      // Use the E2E-exposed handleWorkspaceFileSelect to open the file.
      // This switches to Files mode, loads file content, and creates a tab
      // with the correct extension editor.
      const handler = (window as any).__handleWorkspaceFileSelect;
      if (handler) {
        await handler(data.filePath);
      } else {
        console.warn('[ExtensionSystem] __handleWorkspaceFileSelect not available');
      }

      // If we need to wait for a specific extension editor to render
      if (data.waitForExtension) {
        const selector = `[data-extension-id="${data.waitForExtension}"]`;
        const startTime = Date.now();
        const pollInterval = 100;

        while (Date.now() - startTime < data.timeout) {
          const container = document.querySelector(selector);
          if (container) {
            electronAPI.send(data.responseChannel, {
              extensionId: data.waitForExtension,
            });
            return;
          }
          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        electronAPI.send(data.responseChannel, {
          error: `Timed out waiting for extension editor: ${data.waitForExtension}`,
        });
      } else {
        // Just wait a moment for the tab to render
        await new Promise(resolve => setTimeout(resolve, 300));
        electronAPI.send(data.responseChannel, {});
      }
    } catch (error) {
      electronAPI.send(data.responseChannel, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle extension_test_ai_tool requests
  electronAPI.on('extension-test:ai-tool', async (data: {
    extensionId: string;
    toolName: string;
    args: Record<string, unknown>;
    filePath?: string;
    workspacePath?: string;
    responseChannel: string;
  }) => {
    // console.log('[ExtensionSystem] Extension test: AI tool', data.extensionId, data.toolName);

    try {
      // Build the full tool name as the bridge expects it
      // Extension tools are namespaced: "extensionShortName.toolName"
      const extensionShortName = data.extensionId.split('.').pop() || data.extensionId;
      const fullToolName = `${extensionShortName}.${data.toolName}`;

      const context = {
        workspacePath: data.workspacePath,
        activeFilePath: data.filePath,
      };

      const result = await executeExtensionTool(fullToolName, data.args, context);

      electronAPI.send(data.responseChannel, { data: result });
    } catch (error) {
      electronAPI.send(data.responseChannel, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  });

  // console.log('[ExtensionSystem] Extension test IPC listeners set up');
}

/**
 * Set the workspace path for extension tool registration.
 * Should be called when workspace changes (including rail switches in
 * multi-project mode — every new path needs its own tool registration).
 */
export function setExtensionWorkspacePath(workspacePath: string | null): void {
  const previous = currentWorkspacePath;
  currentWorkspacePath = workspacePath;

  // Register extension tools for every new workspace we see. The previous
  // implementation only fired on the first non-null assignment, which left
  // additional rail-warm projects without their MCP tools registered.
  if (
    workspacePath &&
    workspacePath !== previous &&
    window.electronAPI?.registerExtensionTools
  ) {
    const tools = getMCPToolDefinitions();
    if (tools.length > 0) {
      console.log(`[ExtensionSystem] Registering ${tools.length} extension tools for workspace: ${workspacePath}`);
      window.electronAPI.registerExtensionTools(workspacePath, tools);
    }
  }
}

/**
 * Register the Extension System with its platform service.
 * Should be called once during app initialization.
 *
 * This is an async function because extension discovery and loading
 * involves file system operations.
 */
export async function registerExtensionSystem(): Promise<void> {
  // Set up the platform service
  const service = ExtensionPlatformServiceImpl.getInstance();
  setExtensionPlatformService(service);

  // Set up the enabled state provider to query persisted enabled state from main process
  // Pass defaultEnabled so main process can use it for first-time extensions
  setEnabledStateProvider(async (extensionId: string, defaultEnabled?: boolean) => {
    return window.electronAPI.extensions.getEnabled(extensionId, defaultEnabled);
  });

  // Set up the configuration service provider for extension settings
  setConfigurationServiceProvider({
    get: async (extensionId: string, key: string): Promise<unknown> => {
      const config = await window.electronAPI.extensions.getConfig(extensionId);
      return config[key];
    },
    getAll: async (extensionId: string): Promise<Record<string, unknown>> => {
      return window.electronAPI.extensions.getConfig(extensionId);
    },
    set: async (extensionId: string, key: string, value: unknown, scope?: 'user' | 'workspace'): Promise<void> => {
      await window.electronAPI.extensions.setConfig(extensionId, key, value, scope);
    },
  });

  // Discover and load extensions
  // This will scan the extensions directory and load any valid extensions
  try {
    await initializeExtensions();

    // Initialize the bridge to register custom editors from extensions
    initializeExtensionEditorBridge();

    // Initialize the plugin bridge to register slash commands, nodes, and transformers
    initializeExtensionPluginBridge();

    // Initialize the document header bridge to register extension-contributed document headers
    initializeExtensionDocumentHeaderBridge();

    // Initialize the theme bridge so extension-contributed themes propagate
    // to the main process for theme:list and active-theme reconciliation.
    initializeExtensionThemeBridge();

    // Set up IPC listener for screenshot capture requests
    setupScreenshotIPCListener();

    // Set up IPC listeners for extension development hot-loading
    setupExtensionDevListeners();

    // Set up IPC listener for editor screenshot capture requests
    setupEditorScreenshotListener();

    // Set up IPC listener for extension status queries
    setupExtensionStatusListener();

    // Set up IPC listener for renderer eval requests (dev mode only)
    setupRendererEvalListener();

    // Set up IPC listeners for extension test tools (dev mode only)
    setupExtensionTestListeners();

    // Initialize the AI tools bridge to register extension tools with the tool registry
    initializeExtensionAIToolsBridge();

    // Keep extension-contributed agent provider ids registered with
    // ModelIdentifier as extensions load / re-scan / unload (not only at
    // startup), so a provider enabled after launch is recognized immediately.
    initializeExtensionAgentProviderSync();

    // Expose extension tools bridge on window in dev mode for Playwright page.evaluate() access
    if (process.env.NODE_ENV !== 'production') {
      (window as any).__nimbalyst_extension_tools__ = {
        executeExtensionTool,
        getMCPToolDefinitions,
      };
    }

    // Set up hidden editor mounting for AI tools.
    // When an agent calls an editor-scoped tool for a file that isn't open,
    // HiddenTabManager mounts the editor in a hidden container in the main window.
    hiddenTabManager.initialize();
    setEnsureEditorCallback(
      (filePath: string, workspacePath: string) => hiddenTabManager.ensureEditor(filePath, workspacePath),
      (filePath: string) => hiddenTabManager.release(filePath)
    );

    // Set up callback to notify main process when extension tools change
    setOnToolsChangedCallback((tools) => {
      if (currentWorkspacePath && window.electronAPI?.registerExtensionTools) {
        console.log(`[ExtensionSystem] Registering ${tools.length} extension tools for workspace: ${currentWorkspacePath}`);
        window.electronAPI.registerExtensionTools(currentWorkspacePath, tools);
      }
    });

    // Set up IPC listener for extension tool execution
    if (!extensionToolListenerSetup && window.electronAPI?.onExecuteExtensionTool && window.electronAPI?.sendExtensionToolResult) {
      extensionToolListenerSetup = true;
      const sendResult = window.electronAPI.sendExtensionToolResult;
      window.electronAPI.onExecuteExtensionTool(async (data) => {
        const { toolName, args, resultChannel, context } = data;
        console.log(`[ExtensionSystem] Executing extension tool: ${toolName}`);

        try {
          const result = await executeExtensionTool(toolName, args, context);
          // Result already includes extensionId, toolName, stack, and errorContext from the bridge
          sendResult(resultChannel, result);
        } catch (error) {
          // This catch handles errors that occur outside the tool handler itself
          // (e.g., in the IPC layer or executeExtensionTool wrapper)
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const stack = error instanceof Error ? error.stack : undefined;

          console.error(`[ExtensionSystem] Error executing tool ${toolName}:`, error);

          sendResult(resultChannel, {
            success: false,
            error: errorMessage,
            toolName,
            stack,
            errorContext: {
              layer: 'extension-system-ipc',
              hint: 'Error occurred in the IPC layer before reaching the tool handler.',
            },
          });
        }
      });
    }
  } catch (error) {
    console.error('[ExtensionSystem] Failed to initialize extensions:', error);
    // Don't throw - extensions failing shouldn't prevent the app from starting
  }
}
