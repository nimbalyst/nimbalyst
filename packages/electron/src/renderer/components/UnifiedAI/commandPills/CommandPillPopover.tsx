import React, { useEffect, useMemo, useState } from 'react';
import { useSetAtom } from 'jotai';
import { MarkdownRenderer, MaterialSymbol } from '@nimbalyst/runtime';
import { useFloatingMenu, FloatingPortal } from '../../../hooks/useFloatingMenu';
import { openFileInSessionEditorAtom } from '../../../store/atoms/sessionEditors';
import type { SlashCommandEntry } from '../../Typeahead/slashCommandAutocomplete';

interface CommandPillPopoverProps {
  /** The command resolved from the loaded slash-command list. */
  command: SlashCommandEntry;
  /** Viewport rect of the clicked pill, used to anchor the popover. */
  rect: DOMRect;
  workspacePath?: string;
  sessionId?: string;
  provider?: string | null;
  onClose: () => void;
}

interface CommandDetails {
  content?: string;
  filePath?: string;
}

function getCommandIcon(command: SlashCommandEntry): string {
  if (command.kind === 'skill') return 'psychology';
  if (command.source === 'builtin') return 'bolt';
  return 'code';
}

/**
 * Floating card shown when a command pill is clicked. Surfaces the command's
 * description and body (what it runs) and, for file-backed commands, a button to
 * open the source `.md` in the session editor. Built-in/provider-native commands
 * have no body or file, so only their description is shown.
 */
export const CommandPillPopover: React.FC<CommandPillPopoverProps> = ({
  command,
  rect,
  workspacePath,
  sessionId,
  provider,
  onClose,
}) => {
  const openFileInSessionEditor = useSetAtom(openFileInSessionEditorAtom);
  const [details, setDetails] = useState<CommandDetails>({
    content: command.content,
    filePath: command.filePath,
  });
  const [loading, setLoading] = useState(false);

  // Anchor the floating card to the clicked pill's rect.
  const reference = useMemo(
    () => ({ getBoundingClientRect: () => rect }),
    [rect]
  );

  const { refs, floatingStyles, getFloatingProps } = useFloatingMenu({
    placement: 'top-start',
    offsetPx: 6,
    reference,
    open: true,
    onOpenChange: (next) => {
      if (!next) onClose();
    },
  });

  // Lazily fetch the body/path for entries that arrive without it (e.g. native
  // skills). Built-ins legitimately have neither, so skip them.
  useEffect(() => {
    if (command.content || command.source === 'builtin' || !workspacePath) return;
    let cancelled = false;
    setLoading(true);
    window.electronAPI
      .invoke('slash-command:get', {
        workspacePath,
        commandName: command.name,
        provider: provider ?? 'claude-code',
      })
      .then((entry: { content?: string; filePath?: string } | null) => {
        if (cancelled || !entry) return;
        setDetails((prev) => ({
          content: prev.content ?? entry.content,
          filePath: prev.filePath ?? entry.filePath,
        }));
      })
      .catch((error) => {
        console.error('[CommandPillPopover] Failed to load command details:', error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [command.name, command.content, command.source, workspacePath, provider]);

  const handleOpenFile = () => {
    if (details.filePath && sessionId) {
      openFileInSessionEditor({ sessionId, filePath: details.filePath });
    }
    onClose();
  };

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        {...getFloatingProps()}
        className="command-pill-popover z-[1000] w-[360px] max-w-[min(360px,90vw)] flex flex-col overflow-hidden rounded-lg border border-nim bg-nim-secondary text-[var(--nim-text)] shadow-lg"
      >
        <div className="command-pill-popover-header flex items-center gap-2 px-3 py-2 border-b border-nim">
          <MaterialSymbol icon={getCommandIcon(command)} size={18} className="shrink-0 text-nim-muted" />
          <span className="font-semibold text-sm truncate">/{command.name}</span>
          {command.argumentHint && (
            <span className="text-xs text-nim-faint truncate">{command.argumentHint}</span>
          )}
        </div>

        {command.description && (
          <div className="command-pill-popover-description px-3 py-2 text-[13px] leading-snug text-nim-muted border-b border-nim select-text">
            {command.description}
          </div>
        )}

        {details.content ? (
          <div className="command-pill-popover-body px-3 py-2 max-h-[280px] overflow-y-auto text-[13px] select-text">
            <MarkdownRenderer content={details.content} />
          </div>
        ) : loading ? (
          <div className="command-pill-popover-loading px-3 py-3 text-xs text-nim-faint">Loading…</div>
        ) : null}

        {details.filePath && sessionId && (
          <div className="command-pill-popover-footer flex items-center justify-end px-3 py-2 border-t border-nim">
            <button
              type="button"
              className="command-pill-open-file inline-flex items-center gap-1.5 rounded-md border border-nim bg-nim px-2.5 py-1.5 text-[13px] text-nim cursor-pointer transition-colors duration-150 hover:bg-nim-hover"
              onClick={handleOpenFile}
            >
              <MaterialSymbol icon="open_in_new" size={16} />
              Open file
            </button>
          </div>
        )}
      </div>
    </FloatingPortal>
  );
};
