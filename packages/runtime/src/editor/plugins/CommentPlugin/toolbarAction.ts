import type { LexicalEditor } from 'lexical';

import type { CommentsConfig } from '../../commenting/types';
import type { FloatingTextToolbarAction } from '../FloatingTextFormatToolbarPlugin/types';
import { OPEN_COMMENT_COMPOSER_COMMAND } from './commands';

export function getCommentToolbarActions(
  comments: CommentsConfig | undefined,
  editor: Pick<LexicalEditor, 'dispatchCommand'>,
): FloatingTextToolbarAction[] {
  if (!comments) return [];

  return [
    {
      id: 'comment',
      label: 'Add comment',
      icon: 'add_comment',
      onSelect: () => {
        editor.dispatchCommand(OPEN_COMMENT_COMPOSER_COMMAND, undefined);
      },
    },
  ];
}
