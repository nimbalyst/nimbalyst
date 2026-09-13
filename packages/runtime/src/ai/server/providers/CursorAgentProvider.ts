/**
 * Cursor Agent provider.
 *
 * Runs `cursor-agent --resume <chatId> -p <prompt> --output-format stream-json`
 * per turn. See `CursorAgentProtocol` for why this transport was chosen over
 * ACP — in short, it is the only measured surface that reports a pre-edit
 * baseline, which is what earns this provider `'structured'` file-change
 * fidelity in `providerFileTracking.ts`.
 */

import { CursorAgentProtocol } from '../protocols/CursorAgentProtocol';
import { DEFAULT_MODELS } from '../../modelConstants';
import type { AIModel, AIProviderType } from '../types';
import type { MCPServerConfig } from '../../../types/MCPServerConfig';
import type { FileChangeFidelity } from '../providerFileTracking';
import {
  HeadlessCliAgentProvider,
  buildHeadlessChildEnvironment,
  type HeadlessCliAgentDescriptor,
  type HeadlessCliEnvironmentLoaders,
} from './HeadlessCliAgentProvider';

const DESCRIPTOR: HeadlessCliAgentDescriptor = {
  providerName: 'cursor-agent' as AIProviderType,
  displayName: 'Cursor Agent',
  description: 'Cursor CLI agent, driven headlessly over stream JSON',
  executableName: 'cursor-agent',
  // The installer also symlinks `~/.local/bin/agent`, which the Grok installer
  // claims too — whichever ran last wins, so never probe for that name.
  homeRelativeInstallPaths: ['.local/bin/cursor-agent'],
  notInstalledMessage:
    'The Cursor CLI is not installed. Install it with:\n\n'
    + '  curl -fsSL https://cursor.com/install | bash\n\n'
    + 'Then run `cursor-agent login` to authenticate.',
  notLoggedInMessage:
    'Cursor is not logged in. Run `cursor-agent login` in your terminal, then try again.',
  permissionModeMessage:
    'Cursor Agent requires "Allow Edits" permission mode. Its headless mode grants '
    + 'write and shell access for the whole turn with no per-tool approval to '
    + 'intercept, so the turn is gated up front. Change the permission mode in '
    + 'workspace settings.',
};

export class CursorAgentProvider extends HeadlessCliAgentProvider {
  static readonly DEFAULT_MODEL = DEFAULT_MODELS['cursor-agent'];

  protected readonly descriptor = DESCRIPTOR;
  protected readonly protocol: CursorAgentProtocol;

  private static mcpConfigLoader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null = null;
  private static shellEnvironmentLoader: (() => Record<string, string> | null) | null = null;
  private static enhancedPathLoader: (() => string) | null = null;
  private static cursorPathLoader: (() => string | null) | null = null;

  constructor(deps?: { protocol?: CursorAgentProtocol }) {
    super(CursorAgentProvider.loaders());
    this.protocol = deps?.protocol ?? new CursorAgentProtocol();
  }

  private static loaders(): HeadlessCliEnvironmentLoaders {
    return {
      mcpConfigLoader: CursorAgentProvider.mcpConfigLoader,
      shellEnvironmentLoader: CursorAgentProvider.shellEnvironmentLoader,
      enhancedPathLoader: CursorAgentProvider.enhancedPathLoader,
      executablePathLoader: CursorAgentProvider.cursorPathLoader,
    };
  }

  protected getLoaders(): HeadlessCliEnvironmentLoaders {
    return CursorAgentProvider.loaders();
  }

  protected configureProtocol(executablePath: string, env: Record<string, string> | null): void {
    this.protocol.setCursorPath(executablePath);
    this.protocol.setProcessEnv(env);
  }

  protected getDefaultModelId(): string {
    return CursorAgentProvider.DEFAULT_MODEL;
  }

  /**
   * `editToolCall` results carry `beforeFullFileContent` and a unified diff,
   * and `deleteToolCall` reports removals with the file's previous contents —
   * better data than the watcher can infer, so the watcher must not attribute
   * on top of it.
   */
  getFileChangeFidelity(): FileChangeFidelity {
    return 'structured';
  }

  // --- Static injection setters (Electron main process, at startup) ---

  static setMCPConfigLoader(loader: ((workspacePath?: string) => Promise<Record<string, MCPServerConfig>>) | null): void {
    CursorAgentProvider.mcpConfigLoader = loader;
  }

  static setShellEnvironmentLoader(loader: (() => Record<string, string> | null) | null): void {
    CursorAgentProvider.shellEnvironmentLoader = loader;
  }

  static setEnhancedPathLoader(loader: (() => string) | null): void {
    CursorAgentProvider.enhancedPathLoader = loader;
  }

  static setCursorPathLoader(loader: (() => string | null) | null): void {
    CursorAgentProvider.cursorPathLoader = loader;
  }

  /**
   * Cursor's catalog comes from `cursor-agent --list-models`, which reflects
   * the signed-in account's entitlements. Never hand-maintain this list — the
   * account-specific rows would be wrong for most users and would go stale
   * (NIM-1486).
   */
  static async getModels(): Promise<AIModel[]> {
    const command = CursorAgentProvider.cursorPathLoader?.() ?? 'cursor-agent';
    try {
      const { execFile } = await import('child_process');
      const output = await new Promise<string>((resolve, reject) => {
        execFile(command, ['--list-models'], {
          timeout: 15_000,
          encoding: 'utf8',
          env: buildHeadlessChildEnvironment(CursorAgentProvider.loaders()),
        }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
      const models = parseCursorModelList(output);
      if (models.length > 0) {
        return models.map(({ id, name }) => ({
          id: `cursor-agent:${id}`,
          name,
          provider: 'cursor-agent' as AIProviderType,
        }));
      }
    } catch {
      // CLI missing or not logged in -- fall through to the default.
    }
    return [{
      id: DEFAULT_MODELS['cursor-agent'],
      name: 'Auto',
      provider: 'cursor-agent' as AIProviderType,
    }];
  }

  static getDefaultModel(): string {
    return DEFAULT_MODELS['cursor-agent'];
  }
}

/**
 * Parse `cursor-agent --list-models` output.
 *
 * ```
 * Available models
 *
 * auto - Auto (current, default)
 * gpt-5.3-codex - Codex 5.3
 * ```
 */
export function parseCursorModelList(output: string): Array<{ id: string; name: string }> {
  const models: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const match = /^\s*([A-Za-z0-9][\w.:-]*)\s+-\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, id, name] = match;
    if (seen.has(id)) continue;
    seen.add(id);
    // Strip the parenthetical status suffix Cursor appends to the active row.
    models.push({ id, name: name.replace(/\s*\((?:current, )?default\)$/, '') });
  }
  return models;
}
