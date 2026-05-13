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

import './builtin/AutoLinkExtension';
import './builtin/AssetGcExtension';
import './builtin/CollabAssetLinkExtension';
import './builtin/CollapsibleExtension';
import './builtin/DiffExtension';
import './builtin/DragDropPasteExtension';
import './builtin/EmojiExtension';
import './builtin/ImagesExtension';
import './builtin/KanbanBoardExtension';
import './builtin/LayoutExtension';
import './builtin/MarkdownCopyExtension';
import './builtin/MarkdownPasteExtension';
import './builtin/MermaidExtension';
import './builtin/PageBreakExtension';
import './builtin/TabFocusExtension';
import './builtin/TableMarkdownExtension';
