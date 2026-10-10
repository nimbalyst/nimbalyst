/**
 * Headless extension that owns the code excerpt block: `CodeExcerptNode`, its
 * ```excerpt fence transformer, and the slash entry that inserts one. The
 * inserted block asks for `path#L10-L40` and quotes the lines itself.
 */

import {
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  defineExtension,
} from 'lexical';

import { $createCodeExcerptNode, CodeExcerptNode } from '../../plugins/CodeExcerptPlugin/CodeExcerptNode';
import { CODE_EXCERPT_TRANSFORMER } from '../../plugins/CodeExcerptPlugin/CodeExcerptTransformer';
import { INSERT_CODE_EXCERPT_COMMAND } from '../../plugins/CodeExcerptPlugin/CodeExcerptCommands';
import '../../plugins/CodeExcerptPlugin/codeExcerptBlockMenu';
import { setExtensionContributions } from '../extensionContributionsStore';

const NAME = '@nimbalyst/editor/code-excerpt';

export const CodeExcerptExtension = defineExtension({
  name: NAME,
  nodes: [CodeExcerptNode],
  register: (editor) =>
    editor.registerCommand(
      INSERT_CODE_EXCERPT_COMMAND,
      (payload) => {
        if (!$isRangeSelection($getSelection())) return false;
        $insertNodes([$createCodeExcerptNode(payload)]);
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});

setExtensionContributions(NAME, {
  markdownTransformers: [CODE_EXCERPT_TRANSFORMER],
  userCommands: [
    {
      title: 'Code excerpt',
      description: 'Quote lines from a file in this repo and see when they change',
      icon: 'code_blocks',
      keywords: ['code', 'excerpt', 'snippet', 'quote', 'source', 'lines', 'file', 'spec'],
      command: INSERT_CODE_EXCERPT_COMMAND,
    },
  ],
});
