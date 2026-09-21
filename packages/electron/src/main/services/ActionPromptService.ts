/**
 * Workspace-scoped service for action prompts (ai-actions.md).
 *
 * Reads `<workspacePath>/nimbalyst-local/ai-actions.md` on demand and subscribes
 * to the workspace event bus for live updates. Reads remain authoritative even
 * when native events are missed during watcher recovery (#1524).
 *
 * One service instance per workspace path.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as workspaceEventBus from '../file/WorkspaceEventBus';
import {
  parseActionPromptsFile,
  type ActionPrompt,
  type ActionPromptParseDiagnostic,
  DEFAULT_ACTION_PROMPTS_TEMPLATE,
} from './ActionPromptParser';

const ACTION_PROMPTS_RELATIVE_PATH = 'nimbalyst-local/ai-actions.md';

export interface ActionPromptListResult {
  actions: ActionPrompt[];
  diagnostics: ActionPromptParseDiagnostic[];
  /** Resolved absolute path to ai-actions.md (whether or not it exists). */
  filePath: string;
  /** Whether the file currently exists on disk. */
  fileExists: boolean;
}

type ChangeListener = () => void;

export class ActionPromptService {
  private readonly workspacePath: string;
  private readonly absoluteFilePath: string;
  private subscribed = false;
  private readonly subscriberId: string;
  private readonly changeListeners = new Set<ChangeListener>();

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.absoluteFilePath = path.join(workspacePath, ACTION_PROMPTS_RELATIVE_PATH);
    this.subscriberId = `action-prompt-service:${workspacePath}`;
  }

  getFilePath(): string {
    return this.absoluteFilePath;
  }

  async list(): Promise<ActionPromptListResult> {
    await this.ensureSubscribed();

    let content: string | null = null;
    try {
      content = await fs.readFile(this.absoluteFilePath, 'utf-8');
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        throw err;
      }
      content = null;
    }

    let result: ActionPromptListResult;
    if (content === null) {
      result = {
        actions: [],
        diagnostics: [],
        filePath: this.absoluteFilePath,
        fileExists: false,
      };
    } else {
      const { actions, diagnostics } = parseActionPromptsFile(content);
      result = {
        actions,
        diagnostics,
        filePath: this.absoluteFilePath,
        fileExists: true,
      };
    }

    return result;
  }

  /**
   * Create the file with the default template if it does not exist. Returns
   * the absolute path either way. Safe to call repeatedly.
   */
  async ensureFileExists(): Promise<string> {
    try {
      await fs.access(this.absoluteFilePath);
    } catch {
      const dir = path.dirname(this.absoluteFilePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.absoluteFilePath, DEFAULT_ACTION_PROMPTS_TEMPLATE, 'utf-8');
    }
    return this.absoluteFilePath;
  }

  onChange(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * Reassert the same subscriber ID on each read. The bus deduplicates IDs and
   * owns native recovery; a service-local flag cannot prove registration exists.
   */
  private async ensureSubscribed(): Promise<void> {
    this.subscribed = true;

    const handleFsEvent = (filePath: string) => {
      if (path.resolve(filePath) !== path.resolve(this.absoluteFilePath)) return;
      for (const listener of this.changeListeners) {
        try {
          listener();
        } catch (err) {
          console.error('[ActionPromptService] change listener threw:', err);
        }
      }
    };

    try {
      await workspaceEventBus.subscribe(this.workspacePath, this.subscriberId, {
        onChange: handleFsEvent,
        onAdd: handleFsEvent,
        onUnlink: handleFsEvent,
        // ai-actions.md lives under nimbalyst-local/, which is gitignored —
        // we need structural events for it even when the user has a .gitignore.
        receiveGitignoredStructureEvents: true,
      });
    } catch (err) {
      this.subscribed = false;
      console.error('[ActionPromptService] Failed to subscribe to workspace event bus:', err);
    }
  }

  async dispose(): Promise<void> {
    this.changeListeners.clear();
    if (this.subscribed) {
      this.subscribed = false;
      try {
        workspaceEventBus.unsubscribe(this.workspacePath, this.subscriberId);
      } catch (err) {
        console.error('[ActionPromptService] Failed to unsubscribe:', err);
      }
    }
  }
}

const servicesByWorkspace = new Map<string, ActionPromptService>();

export function getActionPromptService(workspacePath: string): ActionPromptService {
  let service = servicesByWorkspace.get(workspacePath);
  if (!service) {
    service = new ActionPromptService(workspacePath);
    servicesByWorkspace.set(workspacePath, service);
  }
  return service;
}

export async function disposeAllActionPromptServices(): Promise<void> {
  for (const service of servicesByWorkspace.values()) {
    await service.dispose();
  }
  servicesByWorkspace.clear();
}
