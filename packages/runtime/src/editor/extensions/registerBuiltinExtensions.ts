/**
 * Side-effect module: importing this file runs every built-in extension's
 * module-level `setExtensionContributions` call so the extension
 * contributions store (markdown transformers, slash-picker entries) is
 * fully populated before any editor mounts.
 *
 * `editor/index.ts` imports this so that consumers who only touch
 * markdown utilities (e.g. headless transcript processors) still see the
 * complete transformer set without having to instantiate an editor.
 */

// Import order is transformer order. A page mark (`[sentence]{decided}`) that
// opens with a link starts at the same offset as that link, and Lexical keeps
// the first transformer on a tie, so marks and citations go first.
import './builtin/PageMarkExtension';
import './builtin/CitationExtension';
import './builtin/ActionButtonExtension';
import './builtin/AutoLinkExtension';
import './builtin/AssetGcExtension';
import './builtin/CalloutExtension';
import './builtin/ChartExtension';
import './builtin/CodeExcerptExtension';
import './builtin/CollabAssetLinkExtension';
import './builtin/CollapsibleExtension';
import './builtin/DecisionExtension';
import './builtin/DiffExtension';
import './builtin/DragDropPasteExtension';
import './builtin/EmojiExtension';
import './builtin/ImagesExtension';
import './builtin/KanbanBoardExtension';
import './builtin/LayoutExtension';
import './builtin/MarkdownCopyExtension';
import './builtin/MarkdownPasteExtension';
import './builtin/MentionExtension';
import './builtin/MermaidExtension';
import './builtin/PageBreakExtension';
import './builtin/QuadrantExtension';
import './builtin/TabFocusExtension';
import './builtin/TableMarkdownExtension';
import './builtin/TabsExtension';
import './builtin/TocExtension';
import './builtin/TransclusionExtension';
