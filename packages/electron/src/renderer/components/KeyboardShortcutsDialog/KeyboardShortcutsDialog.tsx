import React, { useState, useEffect } from 'react';
import { KeyboardShortcuts, getShortcutDisplay } from '../../../shared/KeyboardShortcuts';
import {
  getRegisteredKeybindings,
  subscribeToCommandRegistry,
  type RegisteredKeybinding,
} from '../../extensions/commands/ExtensionCommandRegistry';
import { getExtensionLoader } from '@nimbalyst/runtime';

interface KeyboardShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutGroup {
  title: string;
  shortcuts: Array<{
    label: string;
    shortcut: string;
  }>;
}

type TabId = 'general' | 'editor' | 'extensions';

const IS_MAC = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

/**
 * Convert a manifest key string like "ctrl+shift+g" to the display format
 * compatible with getShortcutDisplay (e.g., "Ctrl+Shift+G").
 */
function formatManifestKey(key: string): string {
  return key
    .split('+')
    .map(part => {
      const lower = part.toLowerCase();
      if (lower === 'ctrl') return 'Ctrl';
      if (lower === 'cmd') return 'Cmd';
      if (lower === 'shift') return 'Shift';
      if (lower === 'alt') return 'Alt';
      if (lower === 'option') return 'Option';
      // Single character keys get uppercased, multi-char stay as-is
      return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('+');
}

/**
 * Build extension shortcut groups from registered keybindings,
 * grouped by extension name.
 */
function buildExtensionShortcutGroups(keybindings: RegisteredKeybinding[]): ShortcutGroup[] {
  if (keybindings.length === 0) return [];

  // Group by extension ID
  const byExtension = new Map<string, RegisteredKeybinding[]>();
  for (const kb of keybindings) {
    const list = byExtension.get(kb.extensionId) ?? [];
    list.push(kb);
    byExtension.set(kb.extensionId, list);
  }

  // Resolve extension names
  const loader = getExtensionLoader();
  const groups: ShortcutGroup[] = [];

  for (const [extensionId, kbs] of byExtension) {
    const ext = loader.getExtension(extensionId);
    const title = ext?.manifest.name ?? extensionId;

    groups.push({
      title,
      shortcuts: kbs.map(kb => ({
        label: kb.commandTitle,
        shortcut: formatManifestKey(kb.key),
      })),
    });
  }

  return groups;
}

export function KeyboardShortcutsDialog({ isOpen, onClose }: KeyboardShortcutsDialogProps) {
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [extensionGroups, setExtensionGroups] = useState<ShortcutGroup[]>([]);

  // Handle Escape key to close dialog
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Subscribe to extension keybinding changes
  useEffect(() => {
    function sync() {
      setExtensionGroups(buildExtensionShortcutGroups(getRegisteredKeybindings()));
    }
    sync();
    const unsubscribe = subscribeToCommandRegistry(sync);
    return unsubscribe;
  }, []);

  if (!isOpen) return null;

  // All general shortcuts are defined in: packages/electron/src/shared/KeyboardShortcuts.ts
  const generalShortcuts: ShortcutGroup[] = [
    {
      title: 'File',
      shortcuts: [
        { label: 'New File / New Session', shortcut: KeyboardShortcuts.file.newFile }, // shared/KeyboardShortcuts.ts:9 - Cmd+N
        { label: 'New Session (any mode)', shortcut: KeyboardShortcuts.file.newSessionGlobal }, // shared/KeyboardShortcuts.ts:11 - Cmd+Shift+N
        { label: 'New Browser Tab', shortcut: KeyboardShortcuts.file.newBrowserTab }, // shared/KeyboardShortcuts.ts:12 - Cmd+Shift+B
        { label: 'Open File', shortcut: KeyboardShortcuts.file.open }, // shared/KeyboardShortcuts.ts:13 - Cmd+O
        { label: 'Open Folder', shortcut: KeyboardShortcuts.file.openFolder }, // shared/KeyboardShortcuts.ts:13 - Cmd+Shift+O
        { label: 'Save', shortcut: KeyboardShortcuts.file.save }, // shared/KeyboardShortcuts.ts:14 - Cmd+S
        { label: 'Close Tab', shortcut: KeyboardShortcuts.file.closeTab }, // shared/KeyboardShortcuts.ts:15 - Cmd+W
        { label: 'Reopen Closed Tab', shortcut: KeyboardShortcuts.file.reopenClosedTab }, // shared/KeyboardShortcuts.ts:16 - Cmd+Shift+T
        { label: 'Close Project', shortcut: KeyboardShortcuts.file.closeProject }, // shared/KeyboardShortcuts.ts:17 - Cmd+Shift+W
        { label: 'Quit', shortcut: KeyboardShortcuts.file.quit }, // shared/KeyboardShortcuts.ts:18 - Cmd+Q
      ],
    },
    {
      title: 'Edit',
      shortcuts: [
        { label: 'Undo', shortcut: KeyboardShortcuts.edit.undo }, // shared/KeyboardShortcuts.ts:23 - Cmd+Z
        { label: 'Redo', shortcut: KeyboardShortcuts.edit.redo }, // shared/KeyboardShortcuts.ts:24 - Cmd+Shift+Z
        { label: 'Cut', shortcut: KeyboardShortcuts.edit.cut }, // shared/KeyboardShortcuts.ts:25 - Cmd+X
        { label: 'Copy', shortcut: KeyboardShortcuts.edit.copy }, // shared/KeyboardShortcuts.ts:26 - Cmd+C
        { label: 'Paste', shortcut: KeyboardShortcuts.edit.paste }, // shared/KeyboardShortcuts.ts:28 - Cmd+V
        { label: 'Paste as Text', shortcut: KeyboardShortcuts.edit.pasteAsText }, // shared/KeyboardShortcuts.ts:29 - Cmd+Shift+V
        { label: 'Select All', shortcut: KeyboardShortcuts.edit.selectAll }, // shared/KeyboardShortcuts.ts:29 - Cmd+A
        { label: 'Find', shortcut: KeyboardShortcuts.edit.find }, // shared/KeyboardShortcuts.ts:30 - Cmd+F
        { label: 'Find Next', shortcut: KeyboardShortcuts.edit.findNext }, // shared/KeyboardShortcuts.ts:31 - Cmd+G
        { label: 'Find Previous', shortcut: KeyboardShortcuts.edit.findPrevious }, // shared/KeyboardShortcuts.ts:32 - Cmd+Shift+G
        { label: 'View Local History', shortcut: KeyboardShortcuts.edit.viewHistory }, // shared/KeyboardShortcuts.ts:34 - Cmd+Y
        { label: 'Approve Current Action', shortcut: KeyboardShortcuts.edit.approve }, // shared/KeyboardShortcuts.ts:35 - Cmd+Enter
        { label: 'Reject Current Action', shortcut: KeyboardShortcuts.edit.reject }, // shared/KeyboardShortcuts.ts:36 - Cmd+Shift+Backspace
        { label: 'Toggle Plan Mode (Claude Code)', shortcut: 'Shift+Tab' }, // AIInput.tsx - toggle between Plan/Agent mode
      ],
    },
    {
      title: 'View',
      shortcuts: [
        { label: 'Files Mode', shortcut: KeyboardShortcuts.view.filesMode }, // shared/KeyboardShortcuts.ts:42 - Cmd+E
        { label: 'Agent Mode', shortcut: KeyboardShortcuts.view.agentMode }, // shared/KeyboardShortcuts.ts:43 - Cmd+K
        { label: 'Session Kanban View', shortcut: KeyboardShortcuts.window.kanbanView }, // shared/KeyboardShortcuts.ts:81 - Cmd+Shift+K
        { label: 'Toggle AI Chat Panel', shortcut: KeyboardShortcuts.view.toggleAIChat }, // shared/KeyboardShortcuts.ts:46 - Cmd+Shift+A
        { label: 'Toggle Bottom Panel', shortcut: KeyboardShortcuts.view.toggleBottomPanel }, // shared/KeyboardShortcuts.ts:47 - Cmd+J
        { label: 'Toggle Terminal Panel', shortcut: KeyboardShortcuts.view.toggleTerminalPanel }, // shared/KeyboardShortcuts.ts:48 - Ctrl+`
        { label: 'Tracker Mode', shortcut: KeyboardShortcuts.view.trackerMode }, // shared/KeyboardShortcuts.ts:49 - Cmd+T
        { label: 'Shared Documents', shortcut: KeyboardShortcuts.view.collabMode }, // shared/KeyboardShortcuts.ts:50 - Cmd+D
        { label: 'Toggle Sidebar', shortcut: KeyboardShortcuts.view.toggleSidebar }, // shared/KeyboardShortcuts.ts:51 - Cmd+B
        { label: 'Navigate Back', shortcut: KeyboardShortcuts.view.navigateBack }, // shared/KeyboardShortcuts.ts:52 - Cmd+[
        { label: 'Navigate Forward', shortcut: KeyboardShortcuts.view.navigateForward }, // shared/KeyboardShortcuts.ts:53 - Cmd+]
        { label: 'Next Tab', shortcut: KeyboardShortcuts.view.nextTab }, // shared/KeyboardShortcuts.ts:56 - Cmd+Option+Right
        { label: 'Previous Tab', shortcut: KeyboardShortcuts.view.prevTab }, // shared/KeyboardShortcuts.ts:57 - Cmd+Option+Left
        { label: 'Actual Size', shortcut: KeyboardShortcuts.view.actualSize }, // shared/KeyboardShortcuts.ts:60 - Cmd+0
        { label: 'Zoom In', shortcut: KeyboardShortcuts.view.zoomIn }, // shared/KeyboardShortcuts.ts:61 - Cmd+Plus
        { label: 'Zoom Out', shortcut: KeyboardShortcuts.view.zoomOut }, // shared/KeyboardShortcuts.ts:62 - Cmd+-
        { label: 'Toggle Full Screen', shortcut: KeyboardShortcuts.view.toggleFullScreen }, // shared/KeyboardShortcuts.ts:70 - Ctrl+Cmd+F
      ],
    },
    {
      title: 'Window',
      shortcuts: [
        { label: 'Project Manager', shortcut: KeyboardShortcuts.window.workspaceManager }, // shared/KeyboardShortcuts.ts:75 - Cmd+P
        { label: 'Switch Project', shortcut: KeyboardShortcuts.window.projectQuickOpen }, // shared/KeyboardShortcuts.ts - Cmd+Shift+P
        { label: 'Session Quick Open', shortcut: KeyboardShortcuts.window.sessionQuickOpen }, // shared/KeyboardShortcuts.ts:77 - Cmd+L
        { label: 'Prompt Quick Open', shortcut: KeyboardShortcuts.window.promptQuickOpen }, // shared/KeyboardShortcuts.ts:78 - Cmd+Shift+L
        { label: 'Content Search', shortcut: KeyboardShortcuts.window.contentSearch }, // shared/KeyboardShortcuts.ts:79 - Cmd+Shift+F
        { label: 'New Worktree', shortcut: KeyboardShortcuts.window.newWorktree }, // shared/KeyboardShortcuts.ts:81 - Cmd+Alt+W
        { label: 'Settings', shortcut: KeyboardShortcuts.window.aiModels }, // shared/KeyboardShortcuts.ts:82 - Cmd+,
        { label: 'Minimize', shortcut: KeyboardShortcuts.window.minimize }, // shared/KeyboardShortcuts.ts:83 - Cmd+M
      ],
    },
  ];

  // Editor shortcuts are defined in: packages/runtime/src/editor/plugins/ShortcutsPlugin/shortcuts.ts
  const editorShortcuts: ShortcutGroup[] = [
    {
      title: 'Text Formatting',
      shortcuts: [
        { label: 'Bold', shortcut: IS_MAC ? '⌘+B' : 'Ctrl+B' }, // shortcuts.ts:48 - BOLD
        { label: 'Italic', shortcut: IS_MAC ? '⌘+I' : 'Ctrl+I' }, // shortcuts.ts:49 - ITALIC
        { label: 'Underline', shortcut: IS_MAC ? '⌘+U' : 'Ctrl+U' }, // shortcuts.ts:50 - UNDERLINE
        { label: 'Strikethrough', shortcut: IS_MAC ? '⌘+Shift+X' : 'Ctrl+Shift+X' }, // shortcuts.ts:31 - STRIKETHROUGH
        { label: 'Insert Link', shortcut: IS_MAC ? '⌘+K' : 'Ctrl+K' }, // shortcuts.ts:51 - INSERT_LINK
        { label: 'Clear Formatting', shortcut: IS_MAC ? '⌘+\\' : 'Ctrl+\\' }, // shortcuts.ts:45 - CLEAR_FORMATTING
      ],
    },
    {
      title: 'Paragraph Formatting',
      shortcuts: [
        { label: 'Normal Text', shortcut: IS_MAC ? '⌘+Opt+0' : 'Ctrl+Alt+0' }, // shortcuts.ts:16 - NORMAL
        { label: 'Heading 1', shortcut: IS_MAC ? '⌘+Opt+1' : 'Ctrl+Alt+1' }, // shortcuts.ts:17 - HEADING1
        { label: 'Heading 2', shortcut: IS_MAC ? '⌘+Opt+2' : 'Ctrl+Alt+2' }, // shortcuts.ts:18 - HEADING2
        { label: 'Heading 3', shortcut: IS_MAC ? '⌘+Opt+3' : 'Ctrl+Alt+3' }, // shortcuts.ts:19 - HEADING3
        { label: 'Numbered List', shortcut: IS_MAC ? '⌘+Shift+7' : 'Ctrl+Shift+7' }, // shortcuts.ts:20 - NUMBERED_LIST
        { label: 'Bullet List', shortcut: IS_MAC ? '⌘+Shift+8' : 'Ctrl+Shift+8' }, // shortcuts.ts:21 - BULLET_LIST
        { label: 'Check List', shortcut: IS_MAC ? '⌘+Shift+9' : 'Ctrl+Shift+9' }, // shortcuts.ts:22 - CHECK_LIST
        { label: 'Code Block', shortcut: IS_MAC ? '⌘+Opt+C' : 'Ctrl+Alt+C' }, // shortcuts.ts:23 - CODE_BLOCK
        { label: 'Quote', shortcut: IS_MAC ? '⌃+Shift+Q' : 'Ctrl+Shift+Q' }, // shortcuts.ts:24 - QUOTE
      ],
    },
    {
      title: 'Text Alignment',
      shortcuts: [
        { label: 'Left Align', shortcut: IS_MAC ? '⌘+Shift+L' : 'Ctrl+Shift+L' }, // shortcuts.ts:37 - LEFT_ALIGN
        { label: 'Center Align', shortcut: IS_MAC ? '⌘+Shift+E' : 'Ctrl+Shift+E' }, // shortcuts.ts:35 - CENTER_ALIGN
        { label: 'Right Align', shortcut: IS_MAC ? '⌘+Shift+R' : 'Ctrl+Shift+R' }, // shortcuts.ts:38 - RIGHT_ALIGN
        { label: 'Justify', shortcut: IS_MAC ? '⌘+Shift+J' : 'Ctrl+Shift+J' }, // shortcuts.ts:36 - JUSTIFY_ALIGN
        { label: 'Indent', shortcut: IS_MAC ? '⌘+]' : 'Ctrl+]' }, // shortcuts.ts:43 - INDENT
        { label: 'Outdent', shortcut: IS_MAC ? '⌘+[' : 'Ctrl+[' }, // shortcuts.ts:44 - OUTDENT
      ],
    },
    {
      title: 'Text Case & Size',
      shortcuts: [
        { label: 'Lowercase', shortcut: IS_MAC ? '⌃+Shift+1' : 'Ctrl+Shift+1' }, // shortcuts.ts:32 - LOWERCASE
        { label: 'Uppercase', shortcut: IS_MAC ? '⌃+Shift+2' : 'Ctrl+Shift+2' }, // shortcuts.ts:33 - UPPERCASE
        { label: 'Capitalize', shortcut: IS_MAC ? '⌃+Shift+3' : 'Ctrl+Shift+3' }, // shortcuts.ts:34 - CAPITALIZE
        { label: 'Increase Font Size', shortcut: IS_MAC ? '⌘+Shift+.' : 'Ctrl+Shift+.' }, // shortcuts.ts:28 - INCREASE_FONT_SIZE
        { label: 'Decrease Font Size', shortcut: IS_MAC ? '⌘+Shift+,' : 'Ctrl+Shift+,' }, // shortcuts.ts:29 - DECREASE_FONT_SIZE
        { label: 'Subscript', shortcut: IS_MAC ? '⌘+,' : 'Ctrl+,' }, // shortcuts.ts:41 - SUBSCRIPT
        { label: 'Superscript', shortcut: IS_MAC ? '⌘+.' : 'Ctrl+.' }, // shortcuts.ts:42 - SUPERSCRIPT
      ],
    },
  ];

  const shortcutGroups = activeTab === 'general'
    ? generalShortcuts
    : activeTab === 'editor'
    ? editorShortcuts
    : extensionGroups;

  return (
    <div
      className="keyboard-shortcuts-dialog-overlay nim-overlay"
      onClick={onClose}
    >
      <div
        className="keyboard-shortcuts-dialog flex flex-col w-[90vw] max-w-[900px] h-[85vh] rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg)] shadow-[0_8px_32px_rgba(0,0,0,0.3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="keyboard-shortcuts-dialog-header flex items-center justify-between px-6 py-5 border-b border-[var(--nim-border)]">
          <h2 className="m-0 text-xl font-semibold text-[var(--nim-text)]">
            Keyboard Shortcuts
          </h2>
          <button
            className="keyboard-shortcuts-dialog-close flex items-center justify-center w-8 h-8 p-0 bg-transparent border-none text-[32px] leading-none text-[var(--nim-text-muted)] cursor-pointer rounded transition-all duration-200 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Tab navigation */}
        <div className="flex gap-1 px-6 pt-4 border-b border-[var(--nim-border)]">
          {(['general', 'editor', 'extensions'] as TabId[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${
                activeTab === tab
                  ? 'bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] border-b-2 border-[var(--nim-primary)]'
                  : 'text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'
              }`}
            >
              {tab === 'general' ? 'General' : tab === 'editor' ? 'Editor Formatting' : 'Extensions'}
            </button>
          ))}
        </div>

        <div className="keyboard-shortcuts-dialog-content overflow-y-auto flex-1 p-6 grid grid-cols-[repeat(auto-fit,minmax(350px,1fr))] gap-8 max-[900px]:grid-cols-1 max-[600px]:p-5 max-[600px]:gap-6">
          {shortcutGroups.length === 0 && activeTab === 'extensions' ? (
            <div className="text-[var(--nim-text-muted)] text-sm">
              No extension keybindings registered. Extensions can contribute keybindings via their manifest.json.
            </div>
          ) : (
            shortcutGroups.map((group) => (
              <div key={group.title} className="keyboard-shortcuts-group flex flex-col gap-3">
                <h3 className="keyboard-shortcuts-group-title m-0 text-sm font-semibold text-[var(--nim-text-muted)] uppercase tracking-[0.5px]">
                  {group.title}
                </h3>
                <div className="keyboard-shortcuts-list flex flex-col gap-1">
                  {group.shortcuts.map((item) => (
                    <div
                      key={item.label}
                      className="keyboard-shortcut-item flex items-center justify-between py-1.5 gap-4"
                    >
                      <span className="keyboard-shortcut-label text-[var(--nim-text)] text-sm flex-1">
                        {item.label}
                      </span>
                      <kbd className="keyboard-shortcut-key bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded px-2.5 py-1 font-sans text-[13px] font-medium text-[var(--nim-text)] whitespace-nowrap shadow-[0_1px_2px_rgba(0,0,0,0.1)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.3)] min-w-[60px] text-center">
                        {getShortcutDisplay(item.shortcut)}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="px-6 py-3 border-t border-[var(--nim-border)] text-[var(--nim-text-muted)] text-xs">
          Press <kbd className="bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded px-1.5 py-0.5 mx-1">Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
