/**
 * An agent edit to an open Personal typed page goes through the page's mounted
 * body editor. Written to the stored body instead, it lost to the page's own
 * pending autosave: the hook ignores an outside change while a save is pending,
 * then saves the editor's text, which never had the agent's edit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createHeadlessEditor } from '@lexical/headless';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListItemNode, ListNode } from '@lexical/list';
import { CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from 'lexical';
import { $convertFromEnhancedMarkdownString, $convertToEnhancedMarkdownString, getEditorTransformers } from '@nimbalyst/runtime/editor';
import { DiffExtension } from '@nimbalyst/runtime/editor/extensions/builtin/DiffExtension';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';

vi.mock('../../../hooks/useTrackerContentCollab', () => ({
  useTrackerContentCollab: () => ({
    collaboration: null, loading: false, status: 'disconnected', syncProvider: null,
    commentsConfig: null, providerEpoch: 0, bodyCacheMarkdown: null,
  }),
}));
vi.mock('../../../hooks/useColdPaintFallback', () => ({ useColdPaintFallback: () => undefined }));
vi.mock('../../../hooks/useCollabSyncCurtain', () => ({ useCollabSyncCurtain: () => true }));
vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models', () => ({
  globalRegistry: { get: () => ({ sharing: 'personal' }) },
}));

import { useTrackerItemBody, useTrackerTeam } from '../useTrackerItemBody';
import { applyPersonalPageAgentEdit, restorePersonalTypedPageBody } from '../../../services/personalAgentEdit';

const STORED = '# Idea\n\nTables: undecided.\n';

const item = {
  id: 'idea_1', primaryType: 'idea', typeTags: ['idea'], source: 'native', archived: false,
  system: {}, fields: { title: 'Idea' }, fieldUpdatedAt: {}, content: STORED,
} as unknown as TrackerRecord;

function markdownOf(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $convertToEnhancedMarkdownString(getEditorTransformers()));
}

describe('agent edit to an open Personal typed page', () => {
  let saved: string[];
  let snapshots: Array<[string, string, string]>;

  beforeEach(() => {
    vi.useFakeTimers();
    saved = [];
    snapshots = [];
    (window as any).electronAPI = {
      invoke: vi.fn(async (channel: string, key: string, content: string, _type: string, description: string) => {
        if (channel === 'history:create-snapshot') snapshots.push([key, content, description]);
      }),
      documentService: {
        getTrackerItemContent: vi.fn(async () => ({ success: true, content: saved.at(-1) ?? STORED })),
        updateTrackerItemContent: vi.fn(async ({ content }: { content: string }) => {
          saved.push(content);
          return { success: true };
        }),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).electronAPI;
  });

  it('keeps the agent edit and the text typed before it, and restores from history through the editor', async () => {
    const { result, unmount } = renderHook(() => useTrackerItemBody({
      itemId: item.id, item, workspacePath: '/ws', teamOrgId: null, forceFloatingToolbar: false,
    }));
    await act(async () => { await vi.runAllTimersAsync(); });
    const config = result.current.localEditorConfig!;
    expect(config).toBeTruthy();

    // The mounted body editor, wired the way NimbalystEditor wires it.
    const editor = createHeadlessEditor({
      nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode],
      onError: (error) => { throw error; },
    });
    const unregisterDiff = (DiffExtension.register as unknown as (e: LexicalEditor) => () => void)(editor);
    editor.update(() => {
      $getRoot().clear();
      $convertFromEnhancedMarkdownString(config.initialContent ?? '', getEditorTransformers());
    }, { discrete: true });
    config.onGetContent?.(() => markdownOf(editor));
    config.onEditorReady?.(editor);
    editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      if (dirtyElements.size || dirtyLeaves.size) config.onDirtyChange?.(true);
    });

    // A person types; the autosave is pending.
    editor.update(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('Typed just now.')));
    }, { discrete: true });

    const edit = await applyPersonalPageAgentEdit(
      'personal://tracker-content/idea_1',
      [{ oldText: 'Tables: undecided.', newText: 'Tables: one shared DataTable.' }],
      { workspacePath: '/ws' },
    );
    expect(edit, JSON.stringify(edit)).toMatchObject({ success: true });

    await act(async () => { await vi.runAllTimersAsync(); });
    const last = saved.at(-1) ?? '';
    expect(last).toContain('Tables: one shared DataTable.');
    expect(last).toContain('Typed just now.');
    // The text the agent replaced, typing included, is in the page's history.
    expect(result.current.historyKey).toBe('personal-doc://tracker-content/idea_1');
    expect(snapshots).toEqual([['personal-doc://tracker-content/idea_1', expect.stringContaining('Typed just now.'), 'Before agent edit']]);
    expect(snapshots[0]![1]).toContain('Tables: undecided.');

    // Restoring that snapshot goes through the open editor and its autosave.
    await restorePersonalTypedPageBody('idea_1', snapshots[0]![1]);
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(markdownOf(editor)).toContain('Tables: undecided.');
    expect(saved.at(-1)).toContain('Tables: undecided.');

    unregisterDiff();
    unmount();
  });
});

// In the first seconds after launch main cannot read the team directory yet and
// says so with `complete: false`. Reading its null team as "no team" opened a
// team item's body in local mode.
describe('useTrackerTeam while the team lookup is incomplete', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).electronAPI;
  });

  it('stays pending and re-asks until main can answer', async () => {
    const answers = [
      { success: true, team: null, complete: false },
      { success: true, team: { orgId: 'org-1' }, complete: true },
    ];
    const invoke = vi.fn(async (channel: string) => (
      channel === 'team:find-for-workspace' ? answers.shift() : { success: true, members: [] }
    ));
    (window as any).electronAPI = { invoke };

    const { result } = renderHook(() => useTrackerTeam('/ws'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.teamOrgId).toBeUndefined();

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(result.current.teamOrgId).toBe('org-1');
    expect(invoke.mock.calls.filter((c) => c[0] === 'team:find-for-workspace')).toHaveLength(2);
  });
});
