/**
 * The `ClaudeCodeDeps` a headless node actually has to supply.
 *
 * Every field on `ClaudeCodeDeps` is guarded at its call site with `?.` or an
 * `if`, so a null dep is a supported state rather than a crash -- which is why
 * the list below is short. What is set here is set because leaving it null
 * changes behaviour in a way a headless run cannot recover from, not because the
 * runtime demands it. Everything else is deliberately left null:
 *
 * | Left null                      | Consequence, and why it is acceptable                    |
 * | ------------------------------ | -------------------------------------------------------- |
 * | `mcpWithheldNamesLoader`       | Nothing is withheld; there is no OAuth check to report on |
 * | `extensionPluginsLoader`       | No extensions are installed in a headless node            |
 * | `claudeCodeSettingsLoader`     | The explicit-only host disables filesystem settings       |
 * | `claudeSettingsEnvLoader`      | Filesystem settings and implicit env expansion are disabled |
 * | `shellEnvironmentLoader`       | Only OS/runtime environment locations reach the child     |
 * | `enhancedPathLoader`           | Same: PATH is inherited, not reconstructed from settings  |
 * | `gitContextLoader`             | The turn gets no frozen git snapshot (#1177 is a cache    |
 * |                                | optimization, not a correctness requirement)              |
 * | `additionalDirectoriesLoader`  | No SDK-docs directory to add                              |
 * | `attachmentStagingLoader`      | The CLI takes no attachments                              |
 * | `attachmentDenyRulesLoader`    | Same                                                      |
 * | `imageCompressor`              | Same                                                      |
 * | `extensionFileTypesLoader`     | No extension-registered editors exist                     |
 * | `historyManager`               | No document history; AgentToolHooks skips snapshotting    |
 * | `claudeSettingsPatternSaver`   | "Always allow" has no UI to be clicked in                 |
 * | `claudeSettingsPatternChecker` | Same                                                      |
 */

import { ClaudeCodeProvider } from '@nimbalyst/runtime/ai/server/providers/ClaudeCodeProvider';
import { resolveClaudeBinary } from './nodeHost.js';

export interface ClaudeCodeHostOptions {
  /** Explicit `claude` executable path from the config file, if the user set one. */
  claudeCodePath?: string;
  /**
   * How the node answers a tool-permission question. A headless process has
   * nobody to ask: with no trust checker every tool call falls through to an
   * interactive prompt that will never be answered, and the turn hangs forever.
   */
  trustMode: 'bypass-all';
  mcpServers?: Record<string, unknown>;
  /** Where security-relevant decisions are written. Defaults to stderr. */
  logSecurity?: (message: string, data?: unknown) => void;
}

export function registerClaudeCodeDeps(options: ClaudeCodeHostOptions): void {
  // The runtime's own binary resolution cannot work under the Node build --
  // see `resolveClaudeBinary` for why -- so the host resolves it and hands it
  // over as an explicit custom path. A configured path always wins.
  const binaryPath = options.claudeCodePath ?? resolveClaudeBinary();
  ClaudeCodeProvider.setCustomClaudeCodePathLoader(binaryPath ? () => binaryPath : null);
  ClaudeCodeProvider.setMCPConfigLoader(async () => options.mcpServers ?? {});

  // Configuration validation requires an explicit noninteractive execution policy.
  ClaudeCodeProvider.setTrustChecker(() => ({
    trusted: true,
    mode: options.trustMode,
    // Leave the classifier off: `bypass-all` must mean literal allow-all
    // (issue #628), and the classifier's escalation path ends at a prompt.
    allowAllUsesClassifier: false,
  }));

  ClaudeCodeProvider.setSecurityLogger(
    options.logSecurity
      ?? ((message: string, data?: unknown) => {
        console.error('[security]', message, data ?? '');
      }),
  );
}
