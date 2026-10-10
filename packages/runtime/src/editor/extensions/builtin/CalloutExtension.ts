/**
 * Headless extension owning `CalloutNode`, its markdown transformer (GitHub
 * alert syntax), the `INSERT_CALLOUT_COMMAND` handler, and the keys that let
 * the caret leave a callout: Enter on a trailing empty line steps out,
 * Backspace at the very start unwraps it.
 */

import {
  $createParagraphNode,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_LOW,
  INSERT_PARAGRAPH_COMMAND,
  KEY_BACKSPACE_COMMAND,
  type LexicalNode,
  defineExtension,
} from 'lexical';
import { $findMatchingParent, $insertNodeToNearestRoot, mergeRegister } from '@lexical/utils';

import {
  $createEmptyCalloutNode,
  $isCalloutNode,
  CALLOUT_LABELS,
  CALLOUT_TYPES,
  CalloutNode,
  type CalloutType,
} from '../../plugins/CalloutPlugin/CalloutNode';
import { createCalloutTransformer } from '../../plugins/CalloutPlugin/CalloutTransformer';
import { INSERT_CALLOUT_COMMAND } from '../../plugins/CalloutPlugin/CalloutCommands';
import '../../plugins/CalloutPlugin/calloutBlockMenu';
import { getEditorTransformers } from '../../markdown';
import { setExtensionContributions } from '../extensionContributionsStore';
import '../../plugins/CalloutPlugin/Callout.css';

const NAME = '@nimbalyst/editor/callout';

export const CALLOUT_TRANSFORMER = createCalloutTransformer(getEditorTransformers);

/** The callout directly containing the caret's top-level block, if any. */
function $calloutOfCollapsedSelection(): { callout: CalloutNode; block: LexicalNode } | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const block = $findMatchingParent(
    selection.anchor.getNode(),
    (node) => $isCalloutNode(node.getParent()),
  );
  const callout = block?.getParent();
  return block && $isCalloutNode(callout) ? { callout, block } : null;
}

export const CalloutExtension = defineExtension({
  name: NAME,
  nodes: [CalloutNode],
  register: (editor) =>
    mergeRegister(
      editor.registerCommand(
        INSERT_CALLOUT_COMMAND,
        (type) => {
          const callout = $createEmptyCalloutNode(type ?? 'note');
          $insertNodeToNearestRoot(callout);
          callout.selectStart();
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      // Enter on an empty last paragraph moves it out below the callout.
      editor.registerCommand(
        INSERT_PARAGRAPH_COMMAND,
        () => {
          const hit = $calloutOfCollapsedSelection();
          if (!hit) return false;
          const { callout, block } = hit;
          if (
            !$isParagraphNode(block) ||
            !block.isEmpty() ||
            !block.is(callout.getLastChild()) ||
            callout.getChildrenSize() < 2
          ) {
            return false;
          }
          const paragraph = $createParagraphNode();
          callout.insertAfter(paragraph);
          block.remove();
          paragraph.select();
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
      // Backspace at the start of the first block unwraps the callout.
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        (event) => {
          const hit = $calloutOfCollapsedSelection();
          const selection = $getSelection();
          if (!hit || !$isRangeSelection(selection) || selection.anchor.offset !== 0) return false;
          const { callout, block } = hit;
          if (!block.is(callout.getFirstChild()) || !$isParagraphNode(block)) return false;
          if (block.getFirstDescendant() && selection.anchor.getNode() !== block.getFirstDescendant()) {
            return false;
          }
          event?.preventDefault();
          for (const child of callout.getChildren()) callout.insertBefore(child);
          callout.remove();
          block.selectStart();
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    ),
});

const CALLOUT_ICONS: Record<CalloutType, string> = {
  note: 'info',
  tip: 'lightbulb',
  important: 'campaign',
  warning: 'warning',
  caution: 'report',
};

setExtensionContributions(NAME, {
  markdownTransformers: [CALLOUT_TRANSFORMER],
  userCommands: CALLOUT_TYPES.map((type) => ({
    title: `Callout: ${CALLOUT_LABELS[type]}`,
    description: `Insert a ${CALLOUT_LABELS[type].toLowerCase()} callout`,
    icon: CALLOUT_ICONS[type],
    keywords: ['callout', 'alert', 'admonition', 'note', type],
    command: INSERT_CALLOUT_COMMAND,
    payload: type,
  })),
});
