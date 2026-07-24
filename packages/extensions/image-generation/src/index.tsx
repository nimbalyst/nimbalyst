/**
 * Image Generation Extension
 *
 * A Nimbalyst extension for AI-powered image generation.
 *
 * This extension provides:
 * - A custom editor for .imgproj files (image generation projects)
 * - AI tool for generating images via MCP
 * - Support for multiple styles: sketches, diagrams, illustrations, etc.
 */

import './styles.css';
import { ImageProjectEditor } from './components/ImageProjectEditor';
import { ImageGenerationSettings } from './components/SettingsPanel';
import { generateImageTool } from './mcp/generateImageTool';

// Export types for consumers
export type {
  ImageProject,
  Generation,
  GeneratedImage,
  ImageStyle,
  AspectRatio,
  ImageProvider,
  GenerationRequest,
  GenerationResult,
} from './types';

/**
 * Extension activation
 * Called when the extension is loaded
 */
export async function activate(context: unknown) {
  console.log('[ImageGen] Extension activated');
  console.log('[ImageGen] Extension context:', context);
}

/**
 * Extension deactivation
 * Called when the extension is unloaded
 */
export async function deactivate() {
  console.log('[ImageGen] Extension deactivated');
}

/**
 * Components exported by this extension
 * These are referenced in the manifest.json
 */
export const components = {
  ImageProjectEditor,
};

/**
 * Settings panel components exported by this extension
 */
export const settingsPanel = {
  ImageGenerationSettings,
};

/**
 * AI tools exported by this extension
 * These enable the coding agent to generate images through conversation.
 */
export const aiTools = [generateImageTool];
