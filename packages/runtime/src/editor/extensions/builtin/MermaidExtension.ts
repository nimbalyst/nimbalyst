/**
 * Headless extension that owns `MermaidNode` registration, the markdown
 * transformer, and the `INSERT_MERMAID_COMMAND` handler.
 *
 * Replaces the React `MermaidPlugin` (which was just `() => null` wrapping
 * an effect) and the legacy `PluginPackage` entry from
 * `registerBuiltinPlugins.ts`. The component-picker entry is published into
 * the extension-contributions store so the slash menu still surfaces
 * "Mermaid Diagram" without touching `pluginRegistry`.
 */

import {
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  defineExtension,
} from 'lexical';

import {
  $createMermaidNode,
  MermaidNode,
  type MermaidPayload,
} from '../../plugins/MermaidPlugin/MermaidNode';
import { MERMAID_TRANSFORMER } from '../../plugins/MermaidPlugin/MermaidTransformer';
import { INSERT_MERMAID_COMMAND } from '../../plugins/MermaidPlugin/MermaidCommands';
import { setExtensionContributions } from '../extensionContributionsStore';

const NAME = '@nimbalyst/editor/mermaid';

export const MermaidExtension = defineExtension({
  name: NAME,
  nodes: [MermaidNode],
  register: (editor) =>
    editor.registerCommand(
      INSERT_MERMAID_COMMAND,
      (payload?: MermaidPayload) => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          $insertNodes([$createMermaidNode(payload)]);
        }
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});

setExtensionContributions(NAME, {
  markdownTransformers: [MERMAID_TRANSFORMER],
  userCommands: [
    {
      title: 'Mermaid Diagram',
      description: 'Insert a Mermaid diagram for flowcharts, sequence diagrams, and more',
      icon: 'account_tree',
      keywords: ['mermaid', 'diagram', 'flowchart', 'sequence', 'chart', 'graph', 'uml'],
      command: INSERT_MERMAID_COMMAND,
    },
  ],
});
