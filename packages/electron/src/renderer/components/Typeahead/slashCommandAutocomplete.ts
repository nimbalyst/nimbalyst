import type { TypeaheadOption } from './GenericTypeahead';
import type { SlashTypeaheadScope } from './typeaheadUtils';
import { supportsWorkspaceSlashWorkflowProvider } from '../../../shared/agentWorkflowProviders';

export interface SlashCommandEntry {
  name: string;
  description?: string;
  argumentHint?: string;
  source: 'builtin' | 'project' | 'user' | 'plugin';
  kind?: 'command' | 'skill';
}

export function supportsWorkspaceSlashCommands(provider?: string | null): boolean {
  return supportsWorkspaceSlashWorkflowProvider(provider);
}

export async function fetchSlashCommandEntries(options: {
  workspacePath?: string;
  sessionId?: string;
  provider?: string | null;
}): Promise<SlashCommandEntry[]> {
  const { workspacePath, sessionId, provider } = options;
  const resolvedProvider = provider ?? 'claude-code';

  if (!workspacePath || !supportsWorkspaceSlashCommands(resolvedProvider)) {
    return [];
  }

  try {
    const workflowResult = await window.electronAPI.invoke('ai:getAgentWorkflows', {
      workspacePath,
      sessionId,
      provider: resolvedProvider,
    });
    if (workflowResult?.success && Array.isArray(workflowResult.workflows)) {
      return workflowResult.workflows;
    }
  } catch (workflowError) {
    console.warn('[slashCommandAutocomplete] Failed to get agent workflows:', workflowError);
  }

  return [];
}

function getCommandIcon(command: SlashCommandEntry): string {
  if (command.kind === 'skill') {
    return 'psychology';
  }

  if (command.source === 'builtin') {
    const builtinIcons: Record<string, string> = {
      'compact': 'compress',
      'clear': 'delete_sweep',
      'context': 'info',
      'cost': 'payments',
      'diff': 'difference',
      'init': 'restart_alt',
      'mcp': 'hub',
      'output-style:new': 'palette',
      'pr-comments': 'comment',
      'release-notes': 'description',
      'todos': 'checklist',
      'review': 'rate_review',
      'security-review': 'security',
      'status': 'info',
    };
    return builtinIcons[command.name] || 'bolt';
  }

  if (command.source === 'plugin') {
    return 'extension';
  }

  return 'code';
}

function scoreCommand(name: string, query: string): number {
  const lowerName = name.toLowerCase();
  const lowerQuery = query.toLowerCase();

  if (lowerName === lowerQuery) return 100;
  if (lowerName.startsWith(lowerQuery)) return 80;

  const wordBoundaryRegex = new RegExp(`(?:^|[\\s_-])${lowerQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  if (wordBoundaryRegex.test(lowerName)) return 60;
  if (lowerName.includes(lowerQuery)) return 40;

  return 0;
}

function getCommandSection(command: SlashCommandEntry): string {
  if (command.kind === 'skill') {
    if (command.source === 'project') return 'Project Skills';
    if (command.source === 'plugin') return 'Plugin Skills';
    return 'User Skills';
  }

  if (command.source === 'builtin') return 'Built-in Commands';
  if (command.source === 'project') return 'Project Commands';
  if (command.source === 'plugin') return 'Extension Commands';
  return 'User Commands';
}

export function buildSlashCommandOptions(
  commands: SlashCommandEntry[],
  query: string,
  scope: SlashTypeaheadScope
): TypeaheadOption[] {
  const hasQuery = query.length > 0;

  return commands
    .filter(command => {
      if (scope === 'commands') {
        return true;
      }

      return command.source !== 'builtin';
    })
    .map(command => ({
      command,
      score: scoreCommand(command.name, query),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ command }) => ({
      id: command.name,
      label: command.argumentHint
        ? `/${command.name} ${command.argumentHint}`
        : `/${command.name}`,
      description: command.description || `Execute ${command.name} command`,
      icon: getCommandIcon(command),
      section: hasQuery ? undefined : getCommandSection(command),
      data: command,
    }));
}
