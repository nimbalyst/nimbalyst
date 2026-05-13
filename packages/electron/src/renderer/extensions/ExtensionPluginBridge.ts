/**
 * Bridges the ExtensionLoader output into the runtime extension stores
 * so on-disk Nimbalyst extensions can contribute Lexical extensions,
 * markdown transformers, nodes, and slash commands without depending on
 * a private runtime API.
 */

import {
  getExtensionLoader,
  setExtensionContributions,
  setExtensionLexicalExtension,
  setExtensionLexicalExtensions,
  type UserCommand,
} from '@nimbalyst/runtime';
import {
  type AnyLexicalExtensionArgument,
  type Klass,
  type LexicalCommand,
  type LexicalNode,
  createCommand,
  defineExtension,
} from 'lexical';
import type { Transformer } from '@lexical/markdown';
import { logger } from '../utils/logger';

const SOURCE_LEGACY_NODES = '@nimbalyst/extension-loader/legacy-nodes';
const SOURCE_LEGACY_CONTRIBUTIONS = '@nimbalyst/extension-loader/contributions';

// Stable command identities per slash-command ID so re-syncs don't churn
// the editor command registration.
const slashCommands = new Map<string, LexicalCommand<void>>();

/**
 * Handlers indexed by slash command ID. Looked up by the bridge-installed
 * `register()` function inside the synthetic legacy-nodes extension so
 * dispatching a slash command runs the handler from the extension loader.
 */
export const extensionCommandHandlers = new Map<string, () => void>();

function getOrCreateCommand(commandId: string): LexicalCommand<void> {
  let command = slashCommands.get(commandId);
  if (!command) {
    command = createCommand<void>(commandId);
    slashCommands.set(commandId, command);
  }
  return command;
}

/**
 * Sync extension-contributed `LexicalExtension` instances into the
 * editor's extension graph. `NimbalystEditor` reads from the runtime
 * store and rebuilds when the set changes, so toggling an extension on
 * or off rebuilds open editors.
 */
function syncExtensionLexicalExtensions(): void {
  const loader = getExtensionLoader();
  const contributions = loader.getLexicalExtensions();
  // Loader returns `unknown` so we don't pin a Lexical version here. The
  // editor validates the shape at construction time.
  const next = contributions.map((c) => c.extension as AnyLexicalExtensionArgument);
  setExtensionLexicalExtensions(next, SOURCE_LEGACY_CONTRIBUTIONS);
}

/**
 * Sync the legacy node + transformer + slash-command surface contributed
 * by extensions that haven't migrated to `contributions.lexicalExtensions`
 * yet. Nodes are wrapped in a synthetic Lexical extension; transformers
 * and slash-picker entries flow through the contributions store; the
 * slash-command handlers are installed when the synthetic extension is
 * registered against the editor.
 */
function syncLegacyContributions(): void {
  const loader = getExtensionLoader();
  const cmds = loader.getSlashCommands();
  const nodes = loader.getNodes().map((n) => n.nodeClass as Klass<LexicalNode>);
  const transformers = loader.getTransformers().map((t) => t.transformer as Transformer);

  // Build the user-command list for the slash picker.
  const userCommands: UserCommand[] = cmds.map((cmd) => {
    const command = getOrCreateCommand(cmd.contribution.id);
    extensionCommandHandlers.set(cmd.contribution.id, cmd.handler);
    logger.ui.info(
      `[ExtensionPluginBridge] Registered slash command: /${cmd.contribution.title} (${cmd.contribution.id})`,
    );
    return {
      title: cmd.contribution.title,
      description: cmd.contribution.description,
      icon: cmd.contribution.icon,
      keywords: cmd.contribution.keywords,
      command,
    };
  });

  // Synthetic Lexical extension carrying the nodes and (lazily) the
  // slash-command listeners. Registering listeners inside `register()`
  // means they get attached to every editor instance that mounts this
  // extension graph.
  const extension =
    nodes.length === 0 && userCommands.length === 0
      ? undefined
      : defineExtension({
          name: SOURCE_LEGACY_NODES,
          nodes: nodes.length > 0 ? nodes : undefined,
          register: (editor) => {
            const unregisterFns: Array<() => void> = [];
            for (const [commandId, command] of slashCommands) {
              unregisterFns.push(
                editor.registerCommand(
                  command,
                  () => {
                    const handler = extensionCommandHandlers.get(commandId);
                    if (!handler) {
                      console.warn(
                        `[ExtensionPluginBridge] No handler found for command ${commandId}`,
                      );
                      return true;
                    }
                    try {
                      handler();
                    } catch (error) {
                      console.error(
                        `[ExtensionPluginBridge] Error executing handler for ${commandId}:`,
                        error,
                      );
                    }
                    return true;
                  },
                  0,
                ),
              );
            }
            return () => {
              for (const fn of unregisterFns) fn();
            };
          },
        });

  setExtensionLexicalExtension(SOURCE_LEGACY_NODES, extension);
  setExtensionContributions(SOURCE_LEGACY_NODES, {
    markdownTransformers: transformers,
    userCommands,
  });
}

/**
 * Initialize the extension plugin bridge. Call after the extension
 * system has been initialized so loader output is available.
 */
export function initializeExtensionPluginBridge(): void {
  const loader = getExtensionLoader();
  syncLegacyContributions();
  syncExtensionLexicalExtensions();
  loader.subscribe(() => {
    syncLegacyContributions();
    syncExtensionLexicalExtensions();
  });
}

/**
 * Get the LexicalCommand for a slash command ID. Kept for callers that
 * still need to look up command identities by string ID.
 */
export function getExtensionCommand(commandId: string): LexicalCommand<void> | undefined {
  return slashCommands.get(commandId);
}

/**
 * Get all extension commands (used by debug tooling).
 */
export function getAllExtensionCommands(): Map<string, LexicalCommand<void>> {
  return new Map(slashCommands);
}
