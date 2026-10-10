/**
 * Node set for the headless (main-process) Lexical editor that seeds tracker
 * body Y.Docs from markdown (see `MainBodyDocService` /
 * `HeadlessLexicalYDoc`).
 *
 * Why this exists separately from `EditorNodes`:
 *   `EditorNodes` deliberately OMITS every node that a renderer editor
 *   extension registers (list, link, auto-link, horizontal rule, image, ...).
 *   In the renderer those nodes arrive through the composed extension graph
 *   (`buildNimbalystRootExtension`). The headless seeder can't build that graph
 *   — it would pull DOM-only extension code into the main process — so it took
 *   only `EditorNodes`. The result: any body whose markdown produced a node
 *   outside that minimal set (e.g. a GitHub issue with a bullet list) threw
 *   "Node list is not registered" inside `$convertFromEnhancedMarkdownString`,
 *   which aborts the whole conversion, so the body Y.Doc was never seeded and
 *   the collaborative editor mounted empty.
 *
 * This list adds the node CLASSES that the core + built-in markdown
 * transformers (`getEditorTransformers()`) can emit, plus portable nodes that a
 * renderer can already have persisted into the shared Y.Doc. Each class must
 * remain main-safe: renderer-only implementations are injected separately and
 * `decorate()` is never called headlessly. Nodes with no markdown syntax
 * (kanban, collapsible, layout) are intentionally excluded: markdown can't
 * produce them.
 *
 * Kept in sync by `headlessBodyNodes.test.ts`, which converts representative
 * markdown and asserts no "not registered" error escapes.
 *
 * The graph must also stay React-, DOM- and CSS-free: the collab worker and
 * the CLI load it through `@nimbalyst/markdown-ydoc`. Decorator nodes are
 * therefore imported from their `*Core.ts` modules, never the `.tsx` ones that
 * attach the editor's decorator (see `nodeDecoratorSlot.ts`).
 */

import type { Klass, LexicalNode } from 'lexical';
import { ListNode, ListItemNode } from '@lexical/list';
import { LinkNode, AutoLinkNode } from '@lexical/link';
import { HorizontalRuleNode } from '@lexical/extension';

import EditorNodes from './EditorNodes';
import { ImageNode } from '../plugins/ImagesPlugin/ImageNodeCore';
import { PageBreakNode } from '../plugins/PageBreakPlugin/PageBreakNodeCore';
import { MermaidNode } from '../plugins/MermaidPlugin/MermaidNodeCore';
import { QuadrantNode } from '../plugins/QuadrantPlugin/QuadrantNodeCore';
import { ChartNode } from '../plugins/ChartPlugin/ChartNodeCore';
import { CodeExcerptNode } from '../plugins/CodeExcerptPlugin/CodeExcerptNodeCore';
import { CalloutNode } from '../plugins/CalloutPlugin/CalloutNode';
import { LayoutContainerNode } from '../plugins/LayoutPlugin/LayoutContainerNode';
import { LayoutItemNode } from '../plugins/LayoutPlugin/LayoutItemNode';
import { TocNode } from '../plugins/TocPlugin/TocNodeCore';
import { TransclusionNode } from '../plugins/TransclusionPlugin/TransclusionNodeCore';
import { MentionNode } from '../plugins/MentionPlugin/MentionNodeCore';
import { TabPanelNode, TabsNode } from '../plugins/TabsPlugin/TabsNodes';
import { ActionButtonNode } from '../plugins/ActionButtonPlugin/ActionButtonNodeCore';
import { DecisionNode } from '../plugins/DecisionPlugin/DecisionNodeCore';
import { EmbeddedFileNode } from '../plugins/EmbedPlugin/EmbeddedFileNodeCore';
import { DocumentReferenceNode } from '../../plugins/DocumentLinkPlugin/DocumentLinkNode';
import { TrackerReferenceNode } from '../../plugins/TrackerLinkPlugin/TrackerReferenceNodeCore';
import { PageMarkNode } from '../plugins/PageMarkPlugin/PageMarkNode';
import { CitationNode } from '../plugins/CitationPlugin/CitationNodeCore';

const HeadlessBodyNodes: Array<Klass<LexicalNode>> = [
  ...EditorNodes,
  ListNode,
  ListItemNode,
  LinkNode,
  AutoLinkNode,
  HorizontalRuleNode,
  PageBreakNode,
  ImageNode,
  MermaidNode,
  QuadrantNode,
  ChartNode,
  CodeExcerptNode,
  CalloutNode,
  LayoutContainerNode,
  LayoutItemNode,
  TocNode,
  TransclusionNode,
  MentionNode,
  TabsNode,
  TabPanelNode,
  ActionButtonNode,
  DecisionNode,
  EmbeddedFileNode,
  DocumentReferenceNode,
  TrackerReferenceNode,
  PageMarkNode,
  CitationNode,
];

export default HeadlessBodyNodes;
export { HeadlessBodyNodes };
