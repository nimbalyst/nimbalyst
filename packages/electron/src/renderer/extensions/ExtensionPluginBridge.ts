/**
 * Extension Plugin Bridge
 *
 * Bridges the ExtensionLoader with the PluginRegistry,
 * automatically registering slash commands, nodes, and transformers
 * from loaded extensions.
 */

import {
  getExtensionLoader,
  pluginRegistry,
  setExtensionLexicalExtensions,
  type PluginPackage,
} from '@nimbalyst/runtime';
import type { LexicalCommand, Klass, LexicalNode } from 'lexical';
import type { AnyLexicalExtensionArgument } from 'lexical';
import type { Transformer } from '@lexical/markdown';
import { createCommand } from 'lexical';
import { logger } from '../utils/logger';
import ExtensionCommandsPlugin from '../plugins/ExtensionCommandsPlugin';

// Store created commands for reuse
const extensionCommands = new Map<string, LexicalCommand<void>>();

// Plugin name for extension-contributed items
const EXTENSION_PLUGIN_NAME = 'ExtensionContributions';

/**
 * Get or create a LexicalCommand for a slash command ID.
 * Commands are cached to maintain identity across syncs.
 */
function getOrCreateCommand(commandId: string): LexicalCommand<void> {
  let command = extensionCommands.get(commandId);
  if (!command) {
    command = createCommand<void>(commandId);
    extensionCommands.set(commandId, command);
  }
  return command;
}

/**
 * Sync extension-contributed `LexicalExtension` instances into the editor's
 * extension graph (Phase 7.6). `NimbalystEditor` reads from the runtime
 * store and rebuilds when the set changes; toggling an extension on/off
 * therefore rebuilds open editors.
 */
function syncExtensionLexicalExtensions(): void {
  const loader = getExtensionLoader();
  const contributions = loader.getLexicalExtensions();
  // Loader returns `unknown` so we don't pin a Lexical version here. The
  // editor validates the shape at construction time.
  const next = contributions.map(
    (c) => c.extension as AnyLexicalExtensionArgument,
  );
  setExtensionLexicalExtensions(next);
}

/**
 * Sync all extension contributions with the plugin registry.
 * This registers slash commands from all enabled extensions.
 */
export function syncExtensionPlugins(): void {
  const loader = getExtensionLoader();
  const slashCommands = loader.getSlashCommands();
  const nodes = loader.getNodes();
  const transformers = loader.getTransformers();

  // console.log(
  //   `[ExtensionPluginBridge] Syncing ${slashCommands.length} slash command(s), ` +
  //   `${nodes.length} node(s), ${transformers.length} transformer(s)`
  // );
  //
  // if (nodes.length > 0) {
  //   console.log('[ExtensionPluginBridge] Nodes:', nodes.map(n => n.nodeName));
  // }
  //
  // logger.ui.info(
  //   `[ExtensionPluginBridge] Syncing ${slashCommands.length} slash command(s), ` +
  //   `${nodes.length} node(s), ${transformers.length} transformer(s)`
  // );

  // Build the plugin package with all extension contributions
  const extensionPlugin: PluginPackage = {
    name: EXTENSION_PLUGIN_NAME,
    // The plugin component that registers command handlers
    Component: ExtensionCommandsPlugin,
    // Convert slash commands to user commands
    userCommands: slashCommands.map((cmd) => {
      const command = getOrCreateCommand(cmd.contribution.id);
      return {
        title: cmd.contribution.title,
        description: cmd.contribution.description,
        icon: cmd.contribution.icon,
        keywords: cmd.contribution.keywords,
        command,
        // The payload is undefined - the handler will be invoked directly
      };
    }),
    // Add nodes from extensions
    nodes: nodes.map((n) => n.nodeClass as Klass<LexicalNode>),
    // Add transformers from extensions
    transformers: transformers.map((t) => t.transformer as Transformer),
  };

  // Register the plugin (overwrites previous registration)
  pluginRegistry.register(extensionPlugin);

  // Set up command handlers
  // Note: We need to register command listeners for each slash command
  // This is done via the editor's registerCommand in the actual plugin component
  // For now, we store the handlers so they can be called when commands are dispatched
  for (const cmd of slashCommands) {
    const commandId = cmd.contribution.id;
    const handler = cmd.handler;

    // Store handler in a global map for the command listener to find
    extensionCommandHandlers.set(commandId, handler);

    logger.ui.info(
      `[ExtensionPluginBridge] Registered slash command: /${cmd.contribution.title} (${commandId})`
    );
  }
}

// Store handlers for extension commands
export const extensionCommandHandlers = new Map<string, () => void>();

/**
 * Get the LexicalCommand for a slash command ID.
 * Used by the command listener plugin to look up commands.
 */
export function getExtensionCommand(commandId: string): LexicalCommand<void> | undefined {
  return extensionCommands.get(commandId);
}

/**
 * Get all extension commands (for registering listeners in the editor).
 */
export function getAllExtensionCommands(): Map<string, LexicalCommand<void>> {
  return new Map(extensionCommands);
}

/**
 * Initialize the extension plugin bridge.
 * Call this after the extension system is initialized.
 */
export function initializeExtensionPluginBridge(): void {
  const loader = getExtensionLoader();

  // Initial sync of both legacy PluginPackage path and the new Lexical
  // extension contributions store.
  syncExtensionPlugins();
  syncExtensionLexicalExtensions();

  // Subscribe to changes
  loader.subscribe(() => {
    syncExtensionPlugins();
    syncExtensionLexicalExtensions();
  });

  // logger.ui.info('[ExtensionPluginBridge] Initialized');
}
