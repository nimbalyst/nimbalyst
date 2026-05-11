/**
 * Root extension for the Nimbalyst editor shell.
 *
 * Phase 7.1 of the Lexical upgrade plan
 * (`nimbalyst-local/plans/lexical-upgrade-and-defork.md`) replaces
 * `LexicalComposer initialConfig={...}` with `LexicalExtensionComposer
 * extension={...}` in `NimbalystEditor.tsx`. This module is the single source of
 * truth for that root extension.
 *
 * Why a root extension instead of `initialConfig`:
 *
 * - `LexicalExtensionComposer` accepts a single root `LexicalExtension`. The
 *   InitialEditorConfig fields it understands (`namespace`, `nodes`, `theme`,
 *   `editable`, `onError`, `$initialEditorState`) are top-level fields on the
 *   extension itself, not under `config`.
 * - Adding a plugin to the editor in Phase 7.2-7.4 means appending an
 *   extension to `dependencies` here, NOT reaching into `Editor.tsx`'s JSX.
 *
 * Today this root extension has an empty `dependencies` list: every plugin is
 * still mounted as a React child inside `<LexicalExtensionComposer>`. As
 * plugins migrate (upstream `HistoryExtension`, headless command-only
 * extensions, etc.), they move into this `dependencies` array and out of
 * `Editor.tsx`.
 */

import {
  configExtension,
  defineExtension,
  type AnyLexicalExtensionArgument,
  type LexicalExtension,
} from 'lexical';
import type { Klass, LexicalNode } from 'lexical';
import {
  ClearEditorExtension,
  HorizontalRuleExtension,
  type InitialEditorStateType,
  TabIndentationExtension,
} from '@lexical/extension';
import { HistoryExtension } from '@lexical/history';
import { LinkExtension } from '@lexical/link';
import { CheckListExtension, ListExtension } from '@lexical/list';
import type { Transformer } from '@lexical/markdown';

import EditorNodes from '../nodes/EditorNodes';
import NimbalystEditorTheme from '../themes/NimbalystEditorTheme';
import { pluginRegistry } from '../plugins/PluginRegistry';
import { validateUrl } from '../utils/url';
import { AssetGcExtension } from './builtin/AssetGcExtension';
import { AutoLinkExtension } from './builtin/AutoLinkExtension';
import { CollabAssetLinkExtension } from './builtin/CollabAssetLinkExtension';
import { DragDropPasteExtension } from './builtin/DragDropPasteExtension';
import { MarkdownCopyExtension } from './builtin/MarkdownCopyExtension';
import { MarkdownPasteExtension } from './builtin/MarkdownPasteExtension';
import { TabFocusExtension } from './builtin/TabFocusExtension';
import type { UploadedEditorAsset } from '../EditorConfig';

export interface NimbalystRootExtensionOptions {
  /** Mirrors `LexicalComposer initialConfig.editable`; defaults to true. */
  editable?: boolean;
  /**
   * Initial editor state. `null` skips bootstrapping (collab mode hydrates
   * from Y.Doc). A function receives the editor for mutation; a string is a
   * serialized EditorState JSON.
   */
  $initialEditorState?: InitialEditorStateType;
  /**
   * Mirrors the prior `<ListPlugin hasStrictIndent={...} />` prop. When true,
   * list indentation follows strict 2-step indent rules.
   */
  listStrictIndent?: boolean;
  /**
   * When true, HistoryExtension is omitted from the extension graph because
   * CollaborationPlugin owns the history surface in collab documents.
   */
  collaboration?: boolean;
  /**
   * When true, `LinkExtension` registers links created via
   * `TOGGLE_LINK_COMMAND` with `target="_blank" rel="noopener noreferrer"`.
   * Mirrors the prior `<LinkPlugin hasLinkAttributes={...} />` prop.
   */
  hasLinkAttributes?: boolean;
  /**
   * Markdown transformers driving the paste/copy extensions. Pass the
   * same array used elsewhere in the editor so paste-as-markdown and
   * copy-as-markdown match the rest of the import/export pipeline.
   */
  markdownTransformers?: Transformer[];
  /**
   * Called (debounced) with `collab-asset://` URIs that disappeared from
   * the live editor state since the last scan. Forwarded to
   * `AssetGcExtension`. When undefined, the extension is idle.
   */
  onAssetReferencesRemoved?: (removedUris: string[]) => void;
  /**
   * Host-supplied uploader invoked on drag-drop / paste of files. When
   * undefined, the DragDropPasteExtension falls back to the electron
   * document-service IPC for images (with a base64 fallback for unsupported
   * runtimes).
   */
  onUploadAsset?: (file: File) => Promise<UploadedEditorAsset>;
  /**
   * Additional `LexicalExtension` instances contributed by Nimbalyst
   * extensions (via `contributions.lexicalExtensions` in their manifest).
   * Appended to the built-in dependency list. Changing this array rebuilds
   * the editor instance, which matches the Phase 7 design decision that
   * enabling/disabling an extension rebuilds the editor.
   */
  extensionDependencies?: readonly AnyLexicalExtensionArgument[];
}

/**
 * Build the root extension for a `LexicalExtensionComposer`. Must be wrapped
 * in `useMemo` (or module scope) by the caller so the editor instance is not
 * recreated on every render.
 */
export function buildNimbalystRootExtension(
  options: NimbalystRootExtensionOptions,
): LexicalExtension<Record<string, never>, '@nimbalyst/editor/root', unknown, unknown> {
  const nodes: Array<Klass<LexicalNode>> = [
    ...EditorNodes,
    ...pluginRegistry.getAllNodes(),
  ];

  // Dependencies replace one-for-one the React plugins previously mounted in
  // Editor.tsx. Phase 7.2 in the upgrade plan.
  const dependencies: AnyLexicalExtensionArgument[] = [
    ClearEditorExtension,
    HorizontalRuleExtension,
    // maxIndent matches the previous `<TabIndentationPlugin maxIndent={7} />`
    configExtension(TabIndentationExtension, { maxIndent: 7 }),
    configExtension(ListExtension, {
      hasStrictIndent: options.listStrictIndent ?? false,
    }),
    CheckListExtension,
    configExtension(LinkExtension, {
      validateUrl,
      attributes: options.hasLinkAttributes
        ? { rel: 'noopener noreferrer', target: '_blank' }
        : undefined,
    }),
    // Nimbalyst headless extensions (Phase 7.3): each was previously a
    // React component mounted in Editor.tsx.
    AutoLinkExtension,
    CollabAssetLinkExtension,
    TabFocusExtension,
    configExtension(DragDropPasteExtension, {
      uploadAsset: options.onUploadAsset,
    }),
    configExtension(AssetGcExtension, {
      onAssetReferencesRemoved: options.onAssetReferencesRemoved,
    }),
    configExtension(MarkdownPasteExtension, {
      transformers: options.markdownTransformers ?? [],
      minConfidenceScore: 15,
    }),
    configExtension(MarkdownCopyExtension, {
      transformers: options.markdownTransformers ?? [],
    }),
  ];

  if (!options.collaboration) {
    // CollaborationPlugin owns the history surface when present; including
    // HistoryExtension alongside would double-track undo/redo.
    dependencies.push(HistoryExtension);
  }

  // Extension-contributed Lexical extensions go last so they can depend on
  // (or override config for) any of the built-ins above.
  if (options.extensionDependencies && options.extensionDependencies.length > 0) {
    dependencies.push(...options.extensionDependencies);
  }

  return defineExtension({
    name: '@nimbalyst/editor/root',
    namespace: 'Nimbalyst',
    nodes,
    theme: NimbalystEditorTheme,
    editable: options.editable ?? true,
    onError: (error: Error) => {
      throw error;
    },
    $initialEditorState: options.$initialEditorState ?? null,
    dependencies,
  });
}
