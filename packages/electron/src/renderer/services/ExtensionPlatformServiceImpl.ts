/**
 * Electron implementation of ExtensionPlatformService.
 *
 * This implementation runs in the renderer process and uses IPC
 * to communicate with the main process for file operations.
 *
 * Module loading uses es-module-shims with import maps to resolve bare
 * specifiers (like 'react') to the host's bundled dependencies. This is
 * more robust than regex-based transformation of minified code.
 */

import type { ExtensionPlatformService, ExtensionModule } from '@nimbalyst/runtime';

// Import host dependencies that will be shared with extensions
// ONLY React and Lexical need to be shared (singleton requirements)
// Extensions should bundle their own utility libraries (zustand, html2canvas, etc.)
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';
import * as jsxDevRuntime from 'react/jsx-dev-runtime';
import { createJsxDevRuntimeBridge } from './jsxDevRuntimeBridge';
import { createReactDomCompat } from './reactDomCompat';

// PDF.js and virtua are shared for the pdf-viewer extension
import * as pdfjsLib from 'pdfjs-dist';
import * as virtua from 'virtua';

// Import Lexical packages for extensions that use Lexical nodes
import * as lexical from 'lexical';
import * as lexicalReact from '@lexical/react/LexicalComposerContext';
import * as lexicalReactEditable from '@lexical/react/useLexicalEditable';
import * as lexicalReactNodeSelection from '@lexical/react/useLexicalNodeSelection';
import * as lexicalUtils from '@lexical/utils';
import * as lexicalMarkdown from '@lexical/markdown';

// Import runtime UI components that extensions can use
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

// Import screenshot service and document path context from runtime
import {
  screenshotService,
  useDocumentPath,
  useEditorLifecycle,
  useCollaborativeEditor,
  COLLAB_INIT_ORIGIN,
  setTranscriptMarkdownContributions,
  clearTranscriptMarkdownContributions,
  TrackerReferenceChip,
  TrackerReferencePicker,
  navigateToTrackerReference,
  useResolvedTrackerReference,
} from '@nimbalyst/runtime';

// yJS singletons shared with extensions: the host's Y.Doc passes by reference
// across the EditorHost.collaboration surface, so `instanceof Y.Doc` checks
// must succeed across the host/extension boundary -- only one yjs instance
// allowed at runtime, same constraint as React. Imported as namespaces to
// suppress tree-shaking in production.
import * as Y from 'yjs';
import * as yProtocolsAwareness from 'y-protocols/awareness';

// Import editor components for sharing with extensions
// MonacoEditor is self-contained; MarkdownEditor uses a configured wrapper
// that wires up platform features (image handling, toolbar)
import { MonacoEditor, MonacoCodeEditor } from '@nimbalyst/runtime/editors';
import { NimbalystMarkdownEditor } from '../components/editors/NimbalystMarkdownEditor';

// Import DataModel platform service for datamodellm extension
import { DataModelPlatformServiceImpl } from './DataModelPlatformServiceImpl';

// Declare importShim global from es-module-shims
declare global {
  function importShim(specifier: string): Promise<any>;
  namespace importShim {
    function addImportMap(map: { imports: Record<string, string> }): void;
  }
}

export class ExtensionPlatformServiceImpl implements ExtensionPlatformService {
  private static instance: ExtensionPlatformServiceImpl | null = null;
  private importMapInitialized = false;

  private constructor() {}

  public static getInstance(): ExtensionPlatformServiceImpl {
    if (!ExtensionPlatformServiceImpl.instance) {
      ExtensionPlatformServiceImpl.instance = new ExtensionPlatformServiceImpl();
    }
    return ExtensionPlatformServiceImpl.instance;
  }

  /**
   * Initialize the import map for extension loading.
   *
   * This creates blob URLs for each host dependency and registers them
   * in an import map so that extensions can use bare specifiers like
   * `import React from 'react'` without any build-time or runtime transformation.
   */
  private initializeImportMap(): void {
    if (this.importMapInitialized) return;

    // Create wrapper modules that re-export from window.__nimbalyst_extensions
    // We still use the window object as the source of truth, but now extensions
    // can import using standard ES module syntax
    this.exposeHostDependencies();

    const imports: Record<string, string> = {};

    // Helper to create a blob URL for a module that re-exports from window
    const createModuleUrl = (key: string, moduleExports: any): string => {
      if (!moduleExports) {
        console.error(`[ExtensionPlatformService] Missing dependency for import map: ${key}`);
        throw new Error(`Missing host dependency: ${key}. App may need restart after code changes.`);
      }
      // Generate export statements for all properties
      const exportNames = Object.keys(moduleExports).filter(
        (name) => name !== 'default' && name !== '__esModule'
      );

      const code = `
// Host dependency: ${key}
const __mod = window.__nimbalyst_extensions["${key}"];
export default __mod;
${exportNames.map((name) => `export const ${name} = __mod?.${name};`).join('\n')}
`;
      const blob = new Blob([code], { type: 'application/javascript' });
      return URL.createObjectURL(blob);
    };

    // Get the shimmed jsx-dev-runtime (created in exposeHostDependencies)
    const w = window as any;
    const deps = w.__nimbalyst_extensions;

    // Register all host dependencies
    imports['react'] = createModuleUrl('react', deps.react);
    imports['react-dom'] = createModuleUrl('react-dom', deps['react-dom']);
    imports['react-dom/client'] = createModuleUrl('react-dom/client', deps['react-dom/client']);
    imports['react/jsx-runtime'] = createModuleUrl('react/jsx-runtime', deps['react/jsx-runtime']);
    imports['react/jsx-dev-runtime'] = createModuleUrl('react/jsx-dev-runtime', deps['react/jsx-dev-runtime']);

    imports['lexical'] = createModuleUrl('lexical', deps.lexical);
    imports['@lexical/react/LexicalComposerContext'] = createModuleUrl(
      '@lexical/react/LexicalComposerContext',
      deps['@lexical/react/LexicalComposerContext']
    );
    imports['@lexical/react/useLexicalEditable'] = createModuleUrl(
      '@lexical/react/useLexicalEditable',
      deps['@lexical/react/useLexicalEditable']
    );
    imports['@lexical/react/useLexicalNodeSelection'] = createModuleUrl(
      '@lexical/react/useLexicalNodeSelection',
      deps['@lexical/react/useLexicalNodeSelection']
    );
    imports['@lexical/utils'] = createModuleUrl('@lexical/utils', deps['@lexical/utils']);
    imports['@lexical/markdown'] = createModuleUrl('@lexical/markdown', deps['@lexical/markdown']);

    imports['pdfjs-dist'] = createModuleUrl('pdfjs-dist', deps['pdfjs-dist']);
    imports['virtua'] = createModuleUrl('virtua', deps.virtua);
    imports['yjs'] = createModuleUrl('yjs', deps.yjs);
    imports['y-protocols/awareness'] = createModuleUrl(
      'y-protocols/awareness',
      deps['y-protocols/awareness'],
    );

    imports['@nimbalyst/editor-context'] = createModuleUrl(
      '@nimbalyst/editor-context',
      deps['@nimbalyst/editor-context']
    );
    imports['@nimbalyst/runtime/ui/icons/MaterialSymbol'] = createModuleUrl(
      '@nimbalyst/runtime/ui/icons/MaterialSymbol',
      deps['@nimbalyst/runtime/ui/icons/MaterialSymbol']
    );
    imports['@nimbalyst/screenshot-service'] = createModuleUrl(
      '@nimbalyst/screenshot-service',
      deps['@nimbalyst/screenshot-service']
    );
    imports['@nimbalyst/datamodel-platform-service'] = createModuleUrl(
      '@nimbalyst/datamodel-platform-service',
      deps['@nimbalyst/datamodel-platform-service']
    );

    // @nimbalyst/runtime - umbrella module that re-exports common extension dependencies
    imports['@nimbalyst/runtime'] = createModuleUrl(
      '@nimbalyst/runtime',
      deps['@nimbalyst/runtime']
    );

    // Register the import map with es-module-shims
    importShim.addImportMap({ imports });

    // console.log('[ExtensionPlatformService] Import map initialized with', Object.keys(imports).length, 'entries');
    this.importMapInitialized = true;
  }

  /**
   * Get the directory where user extensions are installed.
   */
  async getExtensionsDirectory(): Promise<string> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      throw new Error('electronAPI not available');
    }

    return electronAPI.invoke('extensions:get-directory');
  }

  /**
   * Get all extension directories (user extensions + built-in extensions).
   */
  async getAllExtensionsDirectories(): Promise<string[]> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      throw new Error('electronAPI not available');
    }

    return electronAPI.invoke('extensions:get-all-directories');
  }

  /**
   * List all subdirectories in a directory.
   */
  async listDirectories(dirPath: string): Promise<string[]> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      throw new Error('electronAPI not available');
    }

    return electronAPI.invoke('extensions:list-directories', dirPath);
  }

  /**
   * Read a file as text.
   */
  async readFile(filePath: string): Promise<string> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      throw new Error('electronAPI not available');
    }

    return electronAPI.invoke('extensions:read-file', filePath);
  }

  /**
   * Write content to a file.
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      throw new Error('electronAPI not available');
    }

    return electronAPI.invoke('extensions:write-file', filePath, content);
  }

  /**
   * Check if a file exists.
   */
  async fileExists(filePath: string): Promise<boolean> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      console.warn('[ExtensionPlatformService] fileExists: electronAPI not available');
      return false;
    }

    const exists = await electronAPI.invoke('extensions:file-exists', filePath);
    if (!exists) {
      // console.warn(`[ExtensionPlatformService] File not found: ${filePath}`);
    }
    return exists;
  }

  /**
   * Load a JavaScript module from the given path.
   *
   * Extensions are bundled as ES modules with externals for React, Lexical, etc.
   * We use es-module-shims with an import map to resolve bare specifiers.
   * This is more robust than regex-based transformation of minified code.
   */
  async loadModule(modulePath: string): Promise<ExtensionModule> {
    try {
      // console.log('[ExtensionPlatformService] Loading module:', modulePath);

      // Initialize import map on first load
      this.initializeImportMap();

      // Read the module source
      const source = await this.readFile(modulePath);

      // Add cache-busting comment to force reload on restart
      // We can't use query params on blob URLs, so we inject a comment with timestamp
      const cacheBustedSource = `/* t=${Date.now()} */\n${source}`;

      // Create blob URL - NO transformation needed!
      // The import map handles bare specifier resolution
      const blob = new Blob([cacheBustedSource], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);

      try {
        // Use importShim which respects our import map
        const module = await importShim(blobUrl);

        // Normalize to ExtensionModule interface
        const extensionModule: ExtensionModule = {
          activate: module.activate || module.default?.activate,
          deactivate: module.deactivate || module.default?.deactivate,
          components: module.components || module.default?.components || {},
          aiTools: module.aiTools || module.default?.aiTools || [],
          nodes: module.nodes || module.default?.nodes || {},
          transformers: module.transformers || module.default?.transformers || {},
          lexicalExtensions:
            module.lexicalExtensions || module.default?.lexicalExtensions || {},
          hostComponents: module.hostComponents || module.default?.hostComponents || {},
          slashCommandHandlers: module.slashCommandHandlers || module.default?.slashCommandHandlers || {},
          panels: module.panels || module.default?.panels || {},
          settingsPanel: module.settingsPanel || module.default?.settingsPanel || {},
        };

        return extensionModule;
      } finally {
        // Clean up blob URL
        URL.revokeObjectURL(blobUrl);
      }
    } catch (error) {
      // Analyze the error to provide helpful diagnostics
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      // Detect common extension errors and provide specific guidance
      let diagnostics = '';

      if (errorMessage.includes('process is not defined')) {
        diagnostics = `

COMMON ERROR: "process is not defined"
This usually means the extension or one of its dependencies checks for Node.js
environment via "process" which doesn't exist in packaged builds.

FIX: Add this to your vite.config.ts:
  define: { 'process.env.NODE_ENV': JSON.stringify('production') }

This is common with libraries like Three.js that check for Node.js environment.`;
      }

      if (errorMessage.includes('jsxDEV is not a function') ||
          errorMessage.includes('jsx is not a function') ||
          errorMessage.includes('jsxs is not a function')) {
        diagnostics = `

COMMON ERROR: "${errorMessage.includes('jsxDEV') ? 'jsxDEV' : 'jsx/jsxs'} is not a function"
This usually means there's a mismatch between the extension's JSX runtime
configuration and the host's provided shims.

FIX: Ensure your vite.config.ts has:
  esbuild: { jsxDev: false }

And externals include both:
  'react/jsx-runtime',
  'react/jsx-dev-runtime'`;
      }

      if (errorMessage.includes('Cannot find module') ||
          errorMessage.includes('Module not found') ||
          errorMessage.includes('Failed to resolve module')) {
        diagnostics = `

COMMON ERROR: Module resolution failure
The extension tried to import a module that isn't available.

CHECK:
1. All dependencies are listed in package.json
2. React/Lexical should be externalized (not bundled):
   external: ['react', 'react-dom', '@lexical/...']
3. Run "npm run build" after updating dependencies`;
      }

      if (errorMessage.includes('is not a constructor') ||
          errorMessage.includes('is not a function')) {
        diagnostics = `

COMMON ERROR: Incorrect export/import
A class or function is not being exported/imported correctly.

CHECK:
1. Your exports in index.ts use the correct names
2. Named exports vs default exports match between import and export
3. The "components" export is an object mapping names to components`;
      }

      console.error('[ExtensionPlatformService] Failed to load module:', errorMessage);
      if (errorStack) {
        console.error('[ExtensionPlatformService] Stack:', errorStack);
      }
      if (diagnostics) {
        console.error(diagnostics);
      }

      throw new Error(
        `Failed to load extension module from ${modulePath}: ${errorMessage}${diagnostics}`
      );
    }
  }

  /**
   * Expose host dependencies on the window object for extensions to use.
   *
   * IMPORTANT: Only React and Lexical are shared (singleton requirements).
   * Extensions should bundle their own utility libraries (zustand, html2canvas, etc.)
   */
  private exposeHostDependencies(): void {
    const w = window as any;
    if (w.__nimbalyst_extensions) return;

    // React 19 exposes Fragment + jsxDEV from jsx-dev-runtime. Preserve that
    // shape and supply jsxDEV only when a production condition omits it.
    const shimmedJsxDevRuntime = createJsxDevRuntimeBridge(
      jsxDevRuntime,
      jsxRuntime
    );

    // Use the imported modules from the top of this file
    // IMPORTANT: Use namespace imports (* as) to prevent tree-shaking in production builds
    w.__nimbalyst_extensions = {
      // React core - multiple instances break hooks
      react: React,
      // Compat shape: pre-React-19 extension bundles resolve createRoot off
      // the 'react-dom' key (bundled react-dom/client CJS interop), so keep
      // exposing it there even though React 19 moved it to the client entry.
      'react-dom': createReactDomCompat(ReactDOM, ReactDOMClient),
      'react-dom/client': ReactDOMClient,
      'react/jsx-runtime': jsxRuntime,
      'react/jsx-dev-runtime': shimmedJsxDevRuntime,
      // Lexical - extensions contribute nodes to host's editor
      lexical: lexical,
      '@lexical/react/LexicalComposerContext': lexicalReact,
      '@lexical/react/useLexicalEditable': lexicalReactEditable,
      '@lexical/react/useLexicalNodeSelection': lexicalReactNodeSelection,
      '@lexical/utils': lexicalUtils,
      '@lexical/markdown': lexicalMarkdown,
      // PDF.js and virtua for pdf-viewer extension
      // These are accessed directly from __nimbalyst_extensions rather than ES imports
      'pdfjs-dist': pdfjsLib,
      virtua: virtua,
      // yJS - shared instance required so Y.Doc identity matches across the
      // host/extension boundary for collaborative editors. y-protocols/awareness
      // is a submodule export so it gets its own import-map entry below.
      yjs: Y,
      'y-protocols/awareness': yProtocolsAwareness,
      // Document path context for extensions
      '@nimbalyst/editor-context': { useDocumentPath },
      // Runtime UI components
      '@nimbalyst/runtime/ui/icons/MaterialSymbol': { MaterialSymbol },
      // Core services for extensions
      '@nimbalyst/screenshot-service': {
        screenshotService,
      },
      // Extension-specific services
      '@nimbalyst/datamodel-platform-service': {
        DataModelPlatformServiceImpl,
        getInstance: () => DataModelPlatformServiceImpl.getInstance(),
      },
      // @nimbalyst/runtime - umbrella re-export of common extension dependencies
      // Extensions can import { MaterialSymbol, useDocumentPath, useEditorLifecycle, ... } from '@nimbalyst/runtime'
      '@nimbalyst/runtime': {
        MaterialSymbol,
        useDocumentPath,
        useEditorLifecycle,
        useCollaborativeEditor,
        COLLAB_INIT_ORIGIN,
        setTranscriptMarkdownContributions,
        clearTranscriptMarkdownContributions,
        TrackerReferenceChip,
        TrackerReferencePicker,
        navigateToTrackerReference,
        useResolvedTrackerReference,
        // Editor components - extensions can use these instead of bundling their own
        // MarkdownEditor is the configured wrapper with platform features (image handling, toolbar)
        MarkdownEditor: NimbalystMarkdownEditor,
        MonacoEditor,
        // Raw, props-based Monaco wrapper (not EditorHost-integrated). Extensions
        // that drive the editor instance directly use this instead of MonacoEditor
        // (see calc-sheets CalcSheetShareViewer).
        MonacoCodeEditor,
      },
    };

    // console.log('[ExtensionPlatformService] Host dependencies exposed');
  }

  /**
   * Inject CSS styles into the document.
   */
  injectStyles(css: string): () => void {
    const style = document.createElement('style');
    style.setAttribute('data-extension-styles', 'true');
    style.textContent = css;
    document.head.appendChild(style);

    // Return a function to remove the styles
    return () => {
      if (style.parentNode) {
        style.parentNode.removeChild(style);
      }
    };
  }

  /**
   * Resolve a relative path from an extension's root.
   */
  resolvePath(extensionPath: string, relativePath: string): string {
    // Detect the separator used in the extension path
    const isWindows = extensionPath.includes('\\');
    const separator = isWindows ? '\\' : '/';

    // Normalize the relative path to use the same separator as the extension path
    // This handles manifest.main values like "dist/index.js" on Windows
    const normalizedRelative = isWindows
      ? relativePath.replace(/\//g, '\\')
      : relativePath.replace(/\\/g, '/');

    return `${extensionPath}${separator}${normalizedRelative}`;
  }

  /**
   * Get files matching a glob pattern in a directory.
   */
  async findFiles(dirPath: string, pattern: string): Promise<string[]> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      return [];
    }

    return electronAPI.invoke('extensions:find-files', dirPath, pattern);
  }

  /**
   * Check if an extension should be visible based on its required release channel.
   * Extensions with requiredReleaseChannel: 'alpha' are only visible to alpha users.
   */
  async isExtensionVisibleForChannel(requiredChannel: string | undefined): Promise<boolean> {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI) {
      // If we can't check, default to visible (fail open)
      return true;
    }

    return electronAPI.invoke('extensions:is-visible-for-channel', requiredChannel);
  }
}
