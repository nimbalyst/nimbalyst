/**
 * The markdown transformer set for writing and reading document bodies where
 * no editor runs: the collab worker, the CLI, headless Nimbalyst.
 *
 * It is the built-in half of what `MarkdownCollabContentAdapter` sees in the
 * renderer, as a fixed list instead of the live extension store (which imports
 * React and changes as extensions load). Order matches that adapter: the
 * reference transformers first, then the built-in extension transformers in
 * `registerBuiltinExtensions` order, then `CORE_TRANSFORMERS`.
 *
 * Deliberately absent:
 *   - Extension-donated transformers (math, data models, ...). Their syntax
 *     stays literal text; the editor that owns them upgrades it when it loads.
 *   - Collapsible and kanban-board transformers. Their nodes are not in
 *     `HeadlessBodyNodes`, so the adapter aborts on that markdown today; here
 *     it stays text instead.
 *
 * Table cells convert with this same list. The editor's `TABLE_TRANSFORMER`
 * reads the live store instead: the same built-in transformers, with the
 * reference ones after the extension ones rather than first.
 *
 * Must stay React-, DOM- and CSS-free; `@nimbalyst/markdown-ydoc` bundles it
 * for Workers.
 */
import type { Transformer } from '@lexical/markdown';

import {
  CollabDocumentReferenceTransformer,
  DocumentReferenceTransformer,
  LegacyDocumentReferenceTransformer,
} from '../../plugins/DocumentLinkPlugin/DocumentLinkNode';
import { TrackerReferenceTransformer } from '../../plugins/TrackerLinkPlugin/TrackerReferenceTransformer';
import { CITATION_TRANSFORMER } from '../plugins/CitationPlugin/CitationTransformer';
import { DECISION_TRANSFORMER } from '../plugins/DecisionPlugin/DecisionTransformer';
import { PAGE_MARK_TRANSFORMER } from '../plugins/PageMarkPlugin/PageMarkTransformer';
import { NAMED_PAGE_VIEW_TRANSFORMER } from '../plugins/EmbedPlugin/namedPageView';
import { EMBED_TRANSFORMER } from '../plugins/EmbedPlugin/EmbedTransformer';
import { EMOJI_TRANSFORMER } from '../plugins/EmojisPlugin/EmojiTransformer';
import { IMAGE_TRANSFORMER } from '../plugins/ImagesPlugin/ImageTransformer';
import { MERMAID_TRANSFORMER } from '../plugins/MermaidPlugin/MermaidTransformer';
import { QUADRANT_TRANSFORMER } from '../plugins/QuadrantPlugin/QuadrantTransformer';
import { CHART_TRANSFORMER } from '../plugins/ChartPlugin/ChartTransformer';
import { CODE_EXCERPT_TRANSFORMER } from '../plugins/CodeExcerptPlugin/CodeExcerptTransformer';
import { createCalloutTransformer } from '../plugins/CalloutPlugin/CalloutTransformer';
import { createLayoutTransformer } from '../plugins/LayoutPlugin/LayoutTransformer';
import { TOC_TRANSFORMER } from '../plugins/TocPlugin/TocNodeCore';
import { TRANSCLUSION_TRANSFORMER } from '../plugins/TransclusionPlugin/TransclusionNodeCore';
import { MENTION_TRANSFORMERS } from '../plugins/MentionPlugin/MentionNodeCore';
import { createTabsTransformer } from '../plugins/TabsPlugin/TabsTransformer';
import { ACTION_BUTTON_TRANSFORMERS } from '../plugins/ActionButtonPlugin/ActionButtonNodeCore';
import { PAGE_BREAK_TRANSFORMER } from '../plugins/PageBreakPlugin/PageBreakTransformer';
import { createTableTransformer } from '../plugins/TablePlugin/createTableTransformer';
import { CORE_TRANSFORMERS } from './core-transformers';

const HEADLESS_TABLE_TRANSFORMER = createTableTransformer(() => HEADLESS_BODY_TRANSFORMERS);
const HEADLESS_CALLOUT_TRANSFORMER = createCalloutTransformer(() => HEADLESS_BODY_TRANSFORMERS);
const HEADLESS_LAYOUT_TRANSFORMER = createLayoutTransformer(() => HEADLESS_BODY_TRANSFORMERS);
const HEADLESS_TABS_TRANSFORMER = createTabsTransformer(() => HEADLESS_BODY_TRANSFORMERS);

const HEADLESS_BODY_TRANSFORMERS: Transformer[] = [
  // `[@Name](mailto:...)` would otherwise be claimed by the link and
  // document-reference transformers, which match at the same offset.
  ...MENTION_TRANSFORMERS,
  // A mark that opens with a link starts at the same offset as the link;
  // Lexical keeps the first transformer on a tie.
  PAGE_MARK_TRANSFORMER,
  CITATION_TRANSFORMER,
  // Must precede TrackerReferenceTransformer, whose nimbalyst:// matcher is
  // intentionally broad enough to otherwise claim shared-document links.
  CollabDocumentReferenceTransformer,
  TrackerReferenceTransformer,
  DocumentReferenceTransformer,
  LegacyDocumentReferenceTransformer,
  HEADLESS_CALLOUT_TRANSFORMER,
  CHART_TRANSFORMER,
  CODE_EXCERPT_TRANSFORMER,
  ...ACTION_BUTTON_TRANSFORMERS,
  DECISION_TRANSFORMER,
  HEADLESS_LAYOUT_TRANSFORMER,
  HEADLESS_TABS_TRANSFORMER,
  EMOJI_TRANSFORMER,
  IMAGE_TRANSFORMER,
  MERMAID_TRANSFORMER,
  QUADRANT_TRANSFORMER,
  PAGE_BREAK_TRANSFORMER,
  HEADLESS_TABLE_TRANSFORMER,
  TOC_TRANSFORMER,
  TRANSCLUSION_TRANSFORMER,
  NAMED_PAGE_VIEW_TRANSFORMER,
  EMBED_TRANSFORMER,
  ...CORE_TRANSFORMERS,
];

export function getHeadlessBodyTransformers(): Transformer[] {
  return HEADLESS_BODY_TRANSFORMERS;
}
