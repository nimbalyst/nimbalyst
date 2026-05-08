/**
 * MockupLM Extension
 *
 * A Nimbalyst extension for creating and editing visual UX mockups using HTML/CSS.
 *
 * This extension provides:
 * - A custom editor for .mockup.html files
 * - Drawing and annotation capabilities
 * - Screenshot capture for AI context
 * - Slider-based diff comparison for changes
 */

import { MockupEditor } from './components/MockupEditor';
import { MockupProjectEditor } from './components/MockupProjectEditor';
import type { ExtensionFileSystemService } from '@nimbalyst/extension-sdk';
import './styles.css';

// Module-level filesystem service, set during activation
let _filesystem: ExtensionFileSystemService | null = null;

export function getFilesystem(): ExtensionFileSystemService {
  if (!_filesystem) throw new Error('[MockupLM] Filesystem not available - extension not activated');
  return _filesystem;
}

/**
 * Extension activation
 * Called when the extension is loaded
 */
export async function activate(context: any) {
  console.log('[MockupLM] Extension activated');
  if (context?.services?.filesystem) {
    _filesystem = context.services.filesystem;
  }
}

/**
 * Extension deactivation
 * Called when the extension is unloaded
 */
export async function deactivate() {
  console.log('[MockupLM] Extension deactivated');
  _filesystem = null;
}

/**
 * Components exported by this extension
 * These are referenced in the manifest.json
 */
export const components = {
  MockupEditor,
  MockupProjectEditor,
};

/**
 * AI tools exported by this extension
 * MockupLM uses the shared capture_editor_screenshot tool from the core MCP server
 */
export const aiTools = {};
