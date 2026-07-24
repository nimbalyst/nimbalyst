import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { usePostHog } from 'posthog-js/react';

interface ExtensionPluginCommand {
  extensionId: string;
  extensionName: string;
  pluginName: string;
  pluginNamespace: string;
  commandName: string;
  description: string;
}

export interface SlashCommandSuggestionsProps {
  /** Session provider - only shows for claude-code */
  provider: string;
  /** Whether the session has any messages */
  hasMessages: boolean;
  /** Workspace path for loading commands */
  workspacePath: string;
  /** Session ID (unused but kept for consistency) */
  sessionId?: string;
  /** Callback when a command is selected */
  onCommandSelect: (command: string) => void;
}

/**
 * Shuffle array using Fisher-Yates algorithm
 */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * SlashCommandSuggestions displays pill buttons for installed extension plugin commands
 * when a Claude Code session is empty.
 *
 * Shows commands from enabled extensions via their Claude plugins.
 * Shows a random selection of up to 3 commands initially, with a "(+X)" pill
 * to expand and show all available commands.
 *
 * Clicking a pill populates the input with the slash command.
 */
export const SlashCommandSuggestions: React.FC<SlashCommandSuggestionsProps> = ({
  provider,
  hasMessages,
  workspacePath,
  onCommandSelect
}) => {
  const posthog = usePostHog();
  const [extensionCommands, setExtensionCommands] = useState<ExtensionPluginCommand[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);

  // Only show for claude-code provider with empty session
  const shouldShow = provider === 'claude-code' && !hasMessages;

  // Fetch commands from extension plugins
  useEffect(() => {
    if (!shouldShow || !workspacePath) {
      setIsLoading(false);
      return;
    }

    const fetchExtensionCommands = async () => {
      setIsLoading(true);
      try {
        const commands = await window.electronAPI.extensions.getClaudePluginCommands();
        setExtensionCommands(commands);
      } catch (error) {
        console.error('[SlashCommandSuggestions] Failed to load extension commands:', error);
        setExtensionCommands([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchExtensionCommands();
  }, [shouldShow, workspacePath]);

  // Unified command type for display
  type UnifiedCommand = {
    type: 'extension';
    name: string;
    description: string;
    sourceId: string;
    sourceName: string;
  };

  // Convert and shuffle extension commands
  const allCommands = useMemo((): UnifiedCommand[] => {
    const unified: UnifiedCommand[] = [];

    // Extension plugin commands are namespaced: pluginNamespace:commandName
    for (const cmd of extensionCommands) {
      unified.push({
        type: 'extension',
        name: `${cmd.pluginNamespace}:${cmd.commandName}`,
        description: cmd.description,
        sourceId: cmd.extensionId,
        sourceName: cmd.extensionName,
      });
    }

    return shuffleArray(unified);
  }, [extensionCommands]);

  // Get commands to display based on expanded state
  const displayCommands = useMemo(() => {
    if (isExpanded || allCommands.length <= 3) {
      return allCommands;
    }
    return allCommands.slice(0, 3);
  }, [allCommands, isExpanded]);

  // Calculate how many additional commands are hidden
  const hiddenCount = allCommands.length - 3;

  const handleCommandClick = useCallback((cmd: UnifiedCommand) => {
    // Track the suggestion click in analytics.
    // PRIVACY NOTE: It's safe to send commandName and sourceId because this component
    // only displays commands from built-in extensions.
    posthog?.capture('slash_command_suggestion_clicked', {
      commandName: cmd.name,
      extensionId: cmd.sourceId,
      commandType: cmd.type,
    });

    onCommandSelect(`/${cmd.name} `);
  }, [onCommandSelect, posthog]);

  const handleExpandClick = useCallback(() => {
    setIsExpanded(true);
  }, []);

  // Don't render if not applicable or no commands
  if (!shouldShow || isLoading || displayCommands.length === 0) {
    return null;
  }

  return (
    <div className="slash-command-suggestions flex flex-col items-center gap-2 px-3 py-2 max-w-4xl mx-auto">
      <div className="slash-command-suggestions-label text-xs font-medium text-[var(--nim-text-faint)]">
        Try a command:
      </div>
      <div className="slash-command-suggestions-pills flex flex-wrap justify-center gap-2">
        {displayCommands.map((cmd) => (
          <div key={cmd.name} className="slash-command-pill-wrapper group relative inline-flex">
            <button
              className="slash-command-pill inline-flex items-center gap-1 px-3 py-1.5 text-[13px] font-medium cursor-pointer rounded-2xl border transition-all duration-150 bg-[var(--nim-bg)] border-[var(--nim-border)] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] hover:text-[var(--nim-text)] active:scale-[0.97]"
              onClick={() => handleCommandClick(cmd)}
            >
              <span className="slash-command-pill-icon font-semibold opacity-80 text-[var(--nim-primary)] group-hover:opacity-100">/</span>
              <span className="slash-command-pill-name whitespace-nowrap">{cmd.name}</span>
            </button>
            {cmd.description && (
              <div
                className="slash-command-tooltip absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 px-3 py-2 text-xs font-normal leading-relaxed text-center whitespace-normal min-w-[200px] max-w-[320px] rounded-lg border z-[100] pointer-events-none opacity-0 invisible transition-[opacity,visibility] duration-150 group-hover:opacity-100 group-hover:visible bg-[var(--nim-bg)] border-[var(--nim-border)] text-[var(--nim-text-muted)] shadow-[0_8px_24px_rgba(0,0,0,0.3)]"
                role="tooltip"
              >
                {cmd.description}
              </div>
            )}
          </div>
        ))}
        {!isExpanded && hiddenCount > 0 && (
          <button
            className="slash-command-pill slash-command-expand-pill inline-flex items-center gap-1 px-3 py-1.5 text-[13px] font-semibold cursor-pointer rounded-2xl border transition-all duration-150 bg-[var(--nim-bg)] border-[var(--nim-border)] text-[var(--nim-text-faint)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] hover:text-[var(--nim-text)] active:scale-[0.97]"
            onClick={handleExpandClick}
          >
            <span className="slash-command-pill-name whitespace-nowrap">+{hiddenCount}</span>
          </button>
        )}
      </div>
    </div>
  );
};
