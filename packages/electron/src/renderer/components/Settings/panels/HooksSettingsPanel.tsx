/**
 * The "Claude Code Hooks" settings page. It lists the hooks in the three
 * settings files, one plain sentence each, and opens the hook editor.
 */

import { useCallback, useEffect, useState } from 'react';

import type { OpenedFile } from '../../../../main/services/hookEditor/HookFileService';
import type { SettingsSource } from '../../../../main/services/hookEditor/hookFiles';
import { openHookDocument, readBlocks, type EventBlock } from '../../../../shared/hookEditor/hookDocument';
import { dialogRef } from '../../../contexts/DialogContext';
import { DIALOG_IDS } from '../../../dialogs/registry';
import type { HookEditorDialogData } from '../../HookEditor/HookEditorDialog';
import { BUTTON, EVENT_TEXT, SETTINGS_TABS, blockName } from '../../HookEditor/hookEditorText';

// Who a hook in each file reaches, shown next to the file's name.
const SCOPE_TEXT: Record<SettingsSource, string> = {
  userSettings: 'You, every project',
  projectSettings: 'Everyone on this project',
  localSettings: 'You, this project',
};

interface FileView {
  source: SettingsSource;
  filePath: string;
  events: EventBlock[];
  problem: string | null;
}

export function HooksSettingsPanel({ workspacePath }: { workspacePath: string }) {
  const [files, setFiles] = useState<FileView[]>([]);

  const load = useCallback(async () => {
    const views = await Promise.all(
      SETTINGS_TABS.map(async ({ source }): Promise<FileView> => {
        try {
          const opened = (await window.electronAPI.invoke('hook-editor:open', workspacePath, source)) as OpenedFile;
          const result = openHookDocument(opened.text, { source, paused: opened.paused });
          return result.ok
            ? { source, filePath: opened.filePath, events: readBlocks(result.document), problem: null }
            : { source, filePath: opened.filePath, events: [], problem: result.reason };
        } catch {
          return { source, filePath: '', events: [], problem: 'Nimbalyst could not read this settings file.' };
        }
      }),
    );
    setFiles(views);
  }, [workspacePath]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEditor = (source: SettingsSource, selectId: string | null) => {
    const data: HookEditorDialogData = { workspacePath, source, selectId, focusPalette: selectId === null, onClosed: () => void load(), onDismiss: () => void load() };
    dialogRef.current?.open(DIALOG_IDS.HOOK_EDITOR, data);
  };

  return (
    <div className="hooks-settings-panel provider-panel flex flex-col" data-testid="hooks-settings-panel">
      <div className="provider-panel-header mb-5 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-1.5 text-[var(--nim-text)]">Claude Code Hooks</h3>
        <p className="provider-panel-description text-[13px] leading-relaxed text-[var(--nim-text-muted)]">
          Hooks run your own commands and checks at set moments in a Claude Code session.
        </p>
      </div>
      {files.map((file) => {
        const tab = SETTINGS_TABS.find((candidate) => candidate.source === file.source)!;
        return (
          <section key={file.source} className="hooks-file mb-6" data-testid={`hooks-file-${file.source}`}>
            <header className="hooks-file-head flex items-center gap-2 mb-1">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap text-[var(--nim-text-faint)]">{tab.name}</h4>
              <span className="hooks-file-scope text-[10px] px-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-tertiary)] whitespace-nowrap text-[var(--nim-text-faint)]">
                {SCOPE_TEXT[file.source]}
              </span>
              <button type="button" className="ml-auto text-xs whitespace-nowrap text-[var(--nim-primary)] hover:underline" data-testid={`hooks-new-${file.source}`} onClick={() => openEditor(file.source, null)}>
                + New hook
              </button>
            </header>
            <div className="hooks-file-path select-text mb-2 truncate font-mono text-[11px] text-[var(--nim-text-faint)]" title={file.filePath}>{file.filePath}</div>
            <div className="hooks-file-list rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
              {file.problem !== null && (
                <div className="flex items-center justify-between gap-4 px-3 py-2.5 text-[13px] text-[var(--nim-warning)]">
                  <span>{file.problem}</span>
                  <button type="button" className={`shrink-0 ${BUTTON.secondary} ${BUTTON.small}`} onClick={() => openEditor(file.source, null)}>
                    Open to restore a backup
                  </button>
                </div>
              )}
              {file.problem === null && file.events.length === 0 && <div className="px-3 py-2.5 text-[13px] text-[var(--nim-text-muted)]">No hooks yet.</div>}
              {file.events.flatMap((event) =>
                event.groups.flatMap((group) =>
                  group.hooks.map((block) => (
                    <div key={block.id} className="hooks-row flex items-center justify-between gap-4 px-3 py-2.5 border-b border-[var(--nim-border)] last:border-b-0">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-[var(--nim-text)]">{blockName(block)}</div>
                        <div className="truncate text-xs text-[var(--nim-text-muted)]">
                          {EVENT_TEXT[event.event as keyof typeof EVENT_TEXT] ?? event.event}
                          {group.matcher !== null && (
                            <>
                              {' · only when '}
                              <code className="px-1 rounded font-mono text-[11px] bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)]">{group.matcher}</code>
                            </>
                          )}
                        </div>
                      </div>
                      <button type="button" className={`shrink-0 ${BUTTON.secondary} ${BUTTON.small}`} data-testid={`hooks-edit-${file.source}-${block.id}`} onClick={() => openEditor(file.source, block.id)}>
                        Edit
                      </button>
                    </div>
                  )),
                ),
              )}
            </div>
          </section>
        );
      })}
      <p className="text-[11.5px] text-[var(--nim-text-faint)]">Changes start in new sessions. Running sessions keep the hooks they started with.</p>
    </div>
  );
}
