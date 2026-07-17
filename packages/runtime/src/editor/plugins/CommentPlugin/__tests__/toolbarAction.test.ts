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
});
