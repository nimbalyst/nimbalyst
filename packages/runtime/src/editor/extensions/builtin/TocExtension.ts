/**
 * Headless extension that owns `TocNode` (the ```toc inline table of
 * contents), its markdown transformer, and `INSERT_TOC_COMMAND`.
 */

import { COMMAND_PRIORITY_EDITOR, defineExtension } from 'lexical';
import { $insertNodeToNearestRoot } from '@lexical/utils';

import { $createTocNode, TocNode, TOC_TRANSFORMER } from '../../plugins/TocPlugin/TocNode';
import { INSERT_TOC_COMMAND } from '../../plugins/TocPlugin/TocCommands';
import '../../plugins/TocPlugin/tocBlockMenu';
import { setExtensionContributions } from '../extensionContributionsStore';

const NAME = '@nimbalyst/editor/toc';

export const TocExtension = defineExtension({
  name: NAME,
  nodes: [TocNode],
  register: (editor) =>
    editor.registerCommand(
      INSERT_TOC_COMMAND,
      () => {
        $insertNodeToNearestRoot($createTocNode());
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});

setExtensionContributions(NAME, {
  markdownTransformers: [TOC_TRANSFORMER],
  userCommands: [
    {
      title: 'Table of Contents',
      description: "Insert a live list of this page's headings",
      icon: 'toc',
      keywords: ['toc', 'table of contents', 'contents', 'outline', 'headings'],
      command: INSERT_TOC_COMMAND,
    },
  ],
});
