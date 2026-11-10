// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { CommentsConfig } from '../../../commenting/types';
import { OPEN_COMMENT_COMPOSER_COMMAND } from '../commands';
import { getCommentToolbarActions } from '../toolbarAction';

describe('getCommentToolbarActions', () => {
  it('does not contribute a comment action to local documents', () => {
    const editor = { dispatchCommand: vi.fn() };

    expect(getCommentToolbarActions(undefined, editor)).toEqual([]);
  });

  it('contributes the comment action to shared documents and dispatches its command', () => {
    const editor = { dispatchCommand: vi.fn() };
    const actions = getCommentToolbarActions({} as CommentsConfig, editor);

    expect(actions.map(({ id, label, icon }) => ({ id, label, icon }))).toEqual([
      { id: 'comment', label: 'Add comment', icon: 'add_comment' },
    ]);

    actions[0].onSelect();
    expect(editor.dispatchCommand).toHaveBeenCalledWith(
      OPEN_COMMENT_COMPOSER_COMMAND,
      undefined,
    );
  });

  it('withholds the comment action from a host that reports no comment capability', () => {
    const editor = { dispatchCommand: vi.fn() };
    const capabilities = { read: true, comment: false };
    const comments = {
      getCapabilities: () => capabilities,
    } as unknown as CommentsConfig;

    // A viewer's comment is rejected server-side, so the affordance must not
    // reach them at all.
    expect(getCommentToolbarActions(comments, editor)).toEqual([]);

    // Resolved per call, not snapshotted: regaining access restores the action
    // without the host having to rebuild the config object.
    capabilities.comment = true;
    expect(getCommentToolbarActions(comments, editor)).toHaveLength(1);
  });

  it('offers the action in a read-only editor only to a commenter', () => {
    const editor = { dispatchCommand: vi.fn() };
    const config = (capabilities: { read: boolean; comment: boolean; editBody?: boolean }) =>
      ({ getCapabilities: () => capabilities }) as unknown as CommentsConfig;

    // A commenter's thread writes only the comments array.
    expect(
      getCommentToolbarActions(config({ read: true, comment: true, editBody: false }), editor)[0]
        .availableWhenReadOnly,
    ).toBe(true);
    // Anyone with body rights would write a MarkNode from a read-only view.
    expect(
      getCommentToolbarActions(config({ read: true, comment: true }), editor)[0]
        .availableWhenReadOnly,
    ).toBe(false);
    expect(
      getCommentToolbarActions(config({ read: true, comment: true, editBody: true }), editor)[0]
        .availableWhenReadOnly,
    ).toBe(false);
  });
});
