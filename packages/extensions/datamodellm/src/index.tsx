/**
 * DatamodelLM Extension
 *
 * A Nimbalyst extension for AI-assisted data modeling with visual
 * entity-relationship diagrams.
 *
 * This extension provides:
 * - A custom editor for .prisma files
 * - Visual canvas with drag-and-drop entities
 * - Crow's foot notation for relationships
 * - AI tools for schema manipulation
 * - Lexical integration for embedding data models in documents
 */

import './styles.css';
import type { ExtensionContext } from '@nimbalyst/extension-sdk';
import { DatamodelLMEditor } from './components/DatamodelLMEditor';
import { DataModelCollabContentAdapter } from './collab/DataModelCollabContentAdapter';

export { DataModelCollabContentAdapter };
import { DataModelCanvas } from './components/DataModelCanvas';
import { aiTools as datamodelAITools } from './aiTools';
import { createDataModelStore } from './store';
import { parsePrismaSchema } from './prismaParser';
import { captureDataModelCanvas } from './utils/screenshotUtils';

// Lexical integration imports
import {
  DataModelNode,
  DATAMODEL_TRANSFORMER,
  DataModelPickerMenuHost,
  showDataModelPickerMenu,
  setDataModelPlatformService,
} from './lexical';

// Export types for consumers
export type {
  Entity,
  Field,
  Relationship,
  Database,
  EntityViewMode,
  DataModelFile,
} from './types';


// Export lexical integration
export * from './lexical';

/**
 * Extension activation
 * Called when the extension is loaded
 */
export async function activate(context: ExtensionContext) {
  context.services.collab.registerContentAdapter(DataModelCollabContentAdapter);
  console.log('[DatamodelLM] Extension activated');

  // Set up the platform service from the host
  // The host exposes the DataModelPlatformService implementation via window.__nimbalyst_extensions
  const hostExtensions = (window as any).__nimbalyst_extensions;
  if (hostExtensions && hostExtensions['@nimbalyst/datamodel-platform-service']) {
    const platformServiceModule = hostExtensions['@nimbalyst/datamodel-platform-service'];
    const service = platformServiceModule.getInstance();

    // Configure the showDataModelPicker method to use our picker menu
    service.showDataModelPicker = showDataModelPickerMenu;

    // Set the platform service for the Lexical integration
    setDataModelPlatformService(service);

    console.log('[DatamodelLM] Platform service initialized');
  } else {
    console.warn('[DatamodelLM] Host platform service not available - Lexical integration will not work');
  }

  // Register screenshot capability with the global screenshot service
  const screenshotServiceModule = (window as any).__nimbalyst_extensions?.['@nimbalyst/screenshot-service'];
  if (screenshotServiceModule?.screenshotService) {
    screenshotServiceModule.screenshotService.register({
      id: 'datamodel',
      fileExtensions: ['.prisma'],
      capture: createDataModelScreenshotCapture(),
    });
    console.log('[DatamodelLM] Registered screenshot capability for .prisma files');
  }
}

/**
 * Create the screenshot capture function for data models.
 * This creates a headless renderer that can capture any .prisma file.
 */
function createDataModelScreenshotCapture() {
  return async (filePath: string): Promise<string> => {
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI?.readFileContent) {
      throw new Error('electronAPI.readFileContent not available');
    }

    // Read the prisma file
    const fileResult = await electronAPI.readFileContent(filePath);
    if (!fileResult?.content) {
      throw new Error(`Failed to read file: ${filePath}`);
    }

    // Parse the content
    let data;
    try {
      data = parsePrismaSchema(fileResult.content);
    } catch (parseError) {
      throw new Error(`Failed to parse prisma schema: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
    }

    // Create store and load data
    const store = createDataModelStore();
    store.getState().loadFromFile(data);

    // Create a fresh container for each capture
    // React Flow needs the container to have real dimensions
    // Position it at 0,0 but behind everything (z-index: -9999) so it's invisible
    // but html2canvas can still capture it
    const headlessContainer = document.createElement('div');
    headlessContainer.id = 'datamodel-headless-container-' + Date.now();
    headlessContainer.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 1280px;
      height: 800px;
      overflow: hidden;
      pointer-events: none;
      z-index: -9999;
    `;
    document.body.appendChild(headlessContainer);

    // Get React from host - use react-dom/client for createRoot
    const React = (window as any).__nimbalyst_extensions?.react as typeof import('react');
    const ReactDOMClient = (window as any).__nimbalyst_extensions?.['react-dom/client'] ||
                           (window as any).__nimbalyst_extensions?.['react-dom'];

    if (!React || !ReactDOMClient) {
      headlessContainer.remove();
      throw new Error('React not available from host');
    }

    // Dynamic import of ReactFlowProvider - it's bundled with the extension
    const { ReactFlowProvider } = await import('@xyflow/react');

    return new Promise<string>((resolve, reject) => {
      // Use createRoot from react-dom/client
      const createRootFn = ReactDOMClient.createRoot || ReactDOMClient.default?.createRoot;
      if (!createRootFn) {
        headlessContainer.remove();
        reject(new Error('createRoot not available'));
        return;
      }

      const root = createRootFn(headlessContainer);

      const cleanup = () => {
        try {
          root.unmount();
        } catch (e) {
          // Ignore unmount errors
        }
        headlessContainer.remove();
      };

      // Create a wrapper component that captures after render
      const CaptureWrapper = () => {
        const containerRef = React.useRef<HTMLDivElement>(null);

        React.useEffect(() => {
          // Wait for React Flow to fully render - it needs time to layout nodes
          const captureTimeout = setTimeout(async () => {
            try {
              const canvasElement = containerRef.current?.querySelector('.react-flow') as HTMLElement;
              if (!canvasElement) {
                cleanup();
                reject(new Error('Could not find React Flow element'));
                return;
              }

              const base64Data = await captureDataModelCanvas(canvasElement);

              cleanup();
              resolve(base64Data);
            } catch (error) {
              cleanup();
              reject(error);
            }
          }, 2500); // Wait 2.5s for React Flow to render

          return () => clearTimeout(captureTimeout);
        }, []);

        return React.createElement(
          'div',
          {
            ref: containerRef,
            style: { width: '100%', height: '100%', background: '#ffffff' },
            className: 'datamodel-editor',
            'data-theme': 'light',
          },
          React.createElement(
            ReactFlowProvider,
            null,
            React.createElement(DataModelCanvas, { store, theme: 'light', screenshotMode: true })
          )
        );
      };

      root.render(React.createElement(CaptureWrapper));
    });
  };
}

/**
 * Extension deactivation
 * Called when the extension is unloaded
 */
export async function deactivate() {
  console.log('[DatamodelLM] Extension deactivated');
}

/**
 * Components exported by this extension
 * These are referenced in the manifest.json
 */
export const components = {
  DatamodelLMEditor,
};

/**
 * AI tools exported by this extension
 * These enable Claude to create and modify data models through conversation.
 */
export const aiTools = datamodelAITools;

/**
 * Lexical nodes exported by this extension
 * These are registered with the editor for embedding data models in documents.
 */
export const nodes = {
  DataModelNode,
};

/**
 * Markdown transformers exported by this extension
 * These handle import/export of data model references in markdown.
 */
export const transformers = {
  DATAMODEL_TRANSFORMER,
};

/**
 * Host components exported by this extension
 * These are mounted at the app level (e.g., picker menus).
 */
export const hostComponents = {
  DataModelPickerMenuHost,
};

/**
 * Slash command handlers exported by this extension
 * These are invoked when the user triggers the corresponding slash command.
 */
export const slashCommandHandlers = {
  handleInsertDataModel: () => {
    showDataModelPickerMenu();
  },
};
