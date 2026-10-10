/**
 * Headless extension that owns the action buttons: `ActionButtonNode`, the
 * ```action and ```new-item fence transformers, and their slash entries. What
 * a click does belongs to the host (`actionButtonHost.ts`).
 */

import {
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  defineExtension,
} from 'lexical';

import { $createActionButtonNode, ActionButtonNode, ACTION_BUTTON_TRANSFORMERS } from '../../plugins/ActionButtonPlugin/ActionButtonNode';
import { INSERT_ACTION_BUTTON_COMMAND } from '../../plugins/ActionButtonPlugin/ActionButtonCommands';
import '../../plugins/ActionButtonPlugin/actionButtonBlockMenu';
import {
  DEFAULT_NEW_ITEM_ACTION_SOURCE,
  DEFAULT_SESSION_ACTION_SOURCE,
} from '../../plugins/ActionButtonPlugin/actionButtonSource';
import { setExtensionContributions } from '../extensionContributionsStore';

const NAME = '@nimbalyst/editor/action-button';

export const ActionButtonExtension = defineExtension({
  name: NAME,
  nodes: [ActionButtonNode],
  register: (editor) =>
    editor.registerCommand(
      INSERT_ACTION_BUTTON_COMMAND,
      (payload) => {
        if (!$isRangeSelection($getSelection())) return false;
        const source = payload.source ?? (payload.kind === 'session' ? DEFAULT_SESSION_ACTION_SOURCE : DEFAULT_NEW_ITEM_ACTION_SOURCE);
        $insertNodes([$createActionButtonNode({ kind: payload.kind, source })]);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});

setExtensionContributions(NAME, {
  markdownTransformers: ACTION_BUTTON_TRANSFORMERS,
  userCommands: [
    {
      title: 'Start session button',
      description: 'A button that starts an agent session with a prompt and this page as context',
      icon: 'smart_button',
      keywords: ['button', 'action', 'session', 'agent', 'prompt', 'run'],
      command: INSERT_ACTION_BUTTON_COMMAND,
      payload: { kind: 'session' },
    },
    {
      title: 'New item button',
      description: 'A button that creates a typed page under this page',
      icon: 'note_add',
      keywords: ['button', 'new', 'item', 'create', 'template', 'page'],
      command: INSERT_ACTION_BUTTON_COMMAND,
      payload: { kind: 'new-item' },
    },
  ],
});
