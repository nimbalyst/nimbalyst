/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type { JSX } from 'react';
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';

import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin';
import { ClearEditorPlugin } from '@lexical/react/LexicalClearEditorPlugin';
import { ClickableLinkPlugin } from '@lexical/react/LexicalClickableLinkPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HashtagPlugin } from '@lexical/react/LexicalHashtagPlugin';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { HorizontalRulePlugin } from '@lexical/react/LexicalHorizontalRulePlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { SelectionAlwaysOnDisplay } from '@lexical/react/LexicalSelectionAlwaysOnDisplay';
import { TabIndentationPlugin } from '@lexical/react/LexicalTabIndentationPlugin';
import { TablePlugin } from '@lexical/react/LexicalTablePlugin';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { CAN_USE_DOM } from '@lexical/utils';

import { $convertToEnhancedMarkdownString } from './markdown';

import { DEFAULT_EDITOR_CONFIG, type EditorConfig } from './EditorConfig';
import { useSharedHistoryContext } from './context/SharedHistoryContext';
import { getEditorTransformers } from './markdown';
import AutoEmbedPlugin from './plugins/AutoEmbedPlugin';
import CodeActionMenuPlugin from './plugins/CodeActionMenuPlugin';
import CollapsiblePlugin from './plugins/CollapsiblePlugin';
import ComponentPickerPlugin from './plugins/ComponentPickerPlugin';
import DragDropPaste from './plugins/DragDropPastePlugin';
import DraggableBlockPlugin from './plugins/DraggableBlockPlugin';

// TODO: Should we keep emojis?
import EmojiPickerPlugin from './plugins/EmojiPickerPlugin';
import EmojisPlugin from './plugins/EmojisPlugin';

import FloatingLinkEditorPlugin from './plugins/FloatingLinkEditorPlugin';
import FloatingTextFormatToolbarPlugin from './plugins/FloatingTextFormatToolbarPlugin';
import ImagesPlugin from './plugins/ImagesPlugin';
import { LayoutPlugin } from './plugins/LayoutPlugin/LayoutPlugin';
import LinkPlugin from './plugins/LinkPlugin';
import MarkdownShortcutPlugin from './plugins/MarkdownShortcutPlugin';
import MarkdownPastePlugin from './plugins/MarkdownPastePlugin';
import MarkdownCopyPlugin from './plugins/MarkdownCopyPlugin';
import PageBreakPlugin from './plugins/PageBreakPlugin';
import ShortcutsPlugin from './plugins/ShortcutsPlugin';
import SpeechToTextPlugin from './plugins/SpeechToTextPlugin';
import TabFocusPlugin from './plugins/TabFocusPlugin';
import TableCellActionMenuPlugin from './plugins/TableActionMenuPlugin';
import TableCellResizer from './plugins/TableCellResizer';
import TableHoverActionsPlugin from './plugins/TableHoverActionsPlugin';
import ToolbarPlugin from './plugins/ToolbarPlugin';
import TreeViewPlugin from './plugins/TreeViewPlugin';
import SearchReplacePlugin from './plugins/SearchReplacePlugin';
import { DiffPlugin } from './plugins/DiffPlugin';
import ContentEditable from './ui/ContentEditable';
import { AnchorProvider } from './context/AnchorContext';
import { FrontmatterProvider } from './context/FrontmatterContext';
import { $getFrontmatter, $setFrontmatter } from './markdown/FrontmatterUtils';
import { useRuntimeSettings } from './context/RuntimeSettingsContext';
import { PluginManager } from './plugins/PluginManager';
// Use standard Prism-based code highlighting for now
import CodeHighlightPlugin from './plugins/CodeHighlightPlugin';
// Shiki plugin has issues with Vite bundling
// import CodeHighlightShikiPlugin  from './plugins/CodeHighlightShikiPlugin';
import { KanbanBoardPlugin } from './plugins/KanbanBoardPlugin';
import CommentPlugin from "./plugins/CommentPlugin";
// FloatingDocumentActionsPlugin removed - functionality moved to UnifiedEditorHeaderBar in TabEditor
import AutoLinkPlugin from './plugins/AutoLinkPlugin';
import { CollaborationPlugin } from '@lexical/react/LexicalCollaborationPlugin';
import AssetGCPlugin from './plugins/AssetGCPlugin';
import CollabAssetLinkPlugin from './plugins/CollabAssetLinkPlugin';


interface EditorProps {
  config?: EditorConfig;
}


/**
 * Most plugins from the Lexical Playground are included here. Incomplete or plugins that don't make sense for an
 * editor focused on Markdown compatibility are omitted.
 *
 * List of omitted plugins:
 *
 * - AutocompletePlugin: Not relevant for this editor, nor configurable
 * - CommentPlugin: Not relevant for this editor (left in code for now)
 * - ContextPlugin: Not complete
 * - CollaborationPlugin: Not implemented yet (left in code for now)
 * - DocsPlugin: Not relevant for this editor
 * - FigmaPlugin: Not included as it is not relevant for a markdown editor
 * - KeywordsPlugin: Not useful
 * - MentionsPlugin: Not implemented as pluggable
 * - PollPlugin: Not relevant for this editor
 * - TwitterPlugin: Not relevant for this editor
 * - YouTubePlugin: Not relevant for this editor
 *
 *
 *
 */
export default function Editor({config = DEFAULT_EDITOR_CONFIG}: EditorProps): JSX.Element {
  const runtimeSettings = useRuntimeSettings();
  const {historyState} = useSharedHistoryContext();
  const {
    isCodeHighlighted,
    hasLinkAttributes,
    isRichText,
    shouldPreserveNewLinesInMarkdown,
    selectionAlwaysOnDisplay,
    listStrictIndent,
    markdownOnly,
    editable = true,
    onSaveRequest,
    showToolbar = false,
    forceFloatingToolbar = false,
  } = config;


  const isEditable = useLexicalEditable();
  const placeholder = isRichText
    ? 'Enter some rich text...'
    : 'Enter some plain text...';

  const [floatingAnchorElem, setFloatingAnchorElem] =
    useState<HTMLDivElement | null>(null);
  const [isSmallWidthViewport, setIsSmallWidthViewport] =
    useState<boolean>(false);
  const [editor] = useLexicalComposerContext();
  const [activeEditor, setActiveEditor] = useState(editor);
  const [isLinkEditMode, setIsLinkEditMode] = useState<boolean>(false);

  const markdownTransformers = useMemo(
    () => config.markdownTransformers ?? getEditorTransformers(),
    [config.markdownTransformers],
  );

  // Create frontmatter utility functions that use the editor instance
  const frontmatterUtils = useMemo(() => ({
    $getFrontmatter: () => {
      // This will be called from within editor.update() in the plugin
      return $getFrontmatter();
    },
    $setFrontmatter: (data: any) => {
      // This will be called from within editor.update() in the plugin
      $setFrontmatter(data);
    }
  }), []);

  // Expose markdown content getter
  useEffect(() => {
    if (config.onGetContent) {
      const getContent = () => {
        return editor.read(() => {
          return $convertToEnhancedMarkdownString(markdownTransformers);
        });
      };
      config.onGetContent(getContent);
    }
  }, [editor, config.onGetContent, markdownTransformers]);

  // Expose editor instance
  useEffect(() => {
    if (config.onEditorReady) {
      config.onEditorReady(editor);
    }
  }, [editor, config]);

  // Track whether initial load has completed to avoid false dirty state
  const hasCompletedInitialLoadRef = useRef(false);

  // Handle content changes - report dirty state (no serialization)
  useEffect(() => {
    const removeUpdateListener = editor.registerUpdateListener(({dirtyElements, dirtyLeaves}) => {
      // Only trigger if there are actual changes
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;

      // Skip the first update which is the initial content load
      // This prevents false dirty state from content normalization during import
      if (!hasCompletedInitialLoadRef.current) {
        hasCompletedInitialLoadRef.current = true;
        return;
      }

      // Report dirty state - TabEditor handles deduplication
      if (config.onDirtyChange) {
        config.onDirtyChange(true);
      }
    });

    return () => {
      removeUpdateListener();
    };
  }, [editor, config.onDirtyChange]);

  // Ref for the collaboration cursors container - placed inside the editor
  // content area so cursors scroll with the document
  const cursorsContainerRef = useRef<HTMLElement | null>(null);

  // Fade collaboration cursors after inactivity
  const cursorFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const CURSOR_FADE_DELAY_MS = 3000;

  useEffect(() => {
    if (!config.collaboration) return;

    const container = cursorsContainerRef.current;
    if (!container) return;

    // Watch for DOM changes in the cursors container (cursor position updates)
    const observer = new MutationObserver(() => {
      // Cursor positions changed - mark as active
      container.classList.remove('collab-cursors-faded');
      if (cursorFadeTimerRef.current) {
        clearTimeout(cursorFadeTimerRef.current);
      }
      cursorFadeTimerRef.current = setTimeout(() => {
        container.classList.add('collab-cursors-faded');
      }, CURSOR_FADE_DELAY_MS);
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });

    return () => {
      observer.disconnect();
      if (cursorFadeTimerRef.current) {
        clearTimeout(cursorFadeTimerRef.current);
      }
    };
  }, [config.collaboration]);

  const onRef = (_floatingAnchorElem: HTMLDivElement) => {
    if (_floatingAnchorElem !== null) {
      setFloatingAnchorElem(_floatingAnchorElem);
    }
  };

  useEffect(() => {
    const updateViewPortWidth = () => {
      const isNextSmallWidthViewport =
        CAN_USE_DOM && window.matchMedia('(max-width: 1025px)').matches;

      if (isNextSmallWidthViewport !== isSmallWidthViewport) {
        setIsSmallWidthViewport(isNextSmallWidthViewport);
      }
    };
    updateViewPortWidth();
    window.addEventListener('resize', updateViewPortWidth);

    return () => {
      window.removeEventListener('resize', updateViewPortWidth);
    };
  }, [isSmallWidthViewport]);

  return (
    <>
      {isRichText && editable && showToolbar && (
        <ToolbarPlugin
          editor={editor}
          activeEditor={activeEditor}
          setActiveEditor={setActiveEditor}
          setIsLinkEditMode={setIsLinkEditMode}
          markdownOnly={markdownOnly}
          shouldPreserveNewLinesInMarkdown={shouldPreserveNewLinesInMarkdown}
          isCodeHighlighted={isCodeHighlighted}
          markdownTransformers={markdownTransformers}
        />
      )}
      {isRichText && editable && (
        <ShortcutsPlugin
          editor={activeEditor}
          setIsLinkEditMode={setIsLinkEditMode}
          onSaveRequest={onSaveRequest}
        />
      )}
      {/* SearchReplacePlugin disabled - now uses fixed tab header implementation in runtime */}
      {/* {isRichText && editable && <SearchReplacePlugin />} */}
      <div
        className={`editor-container ${(runtimeSettings.settings.showTreeView || config.showTreeView) ? 'tree-view' : ''} ${
          !isRichText ? 'plain-text' : ''
        }`}>
        <DragDropPaste uploadAsset={config.onUploadAsset} />
        {selectionAlwaysOnDisplay && <SelectionAlwaysOnDisplay />}
        <ClearEditorPlugin />
        {floatingAnchorElem && <ComponentPickerPlugin anchorElem={floatingAnchorElem} />}
        <EmojiPickerPlugin />
        <AutoEmbedPlugin />
        {/*<EmojisPlugin />*/}
        <HashtagPlugin />
        <SpeechToTextPlugin />
        <AutoLinkPlugin />

        {/*<CommentPlugin*/}
        {/*  // providerFactory={isCollab ? createWebsocketProvider : undefined}*/}
        {/*/>*/}
        {isRichText ? (
          <>
            {config.collaboration ? (
              <CollaborationPlugin
                id="main"
                providerFactory={config.collaboration.providerFactory}
                shouldBootstrap={config.collaboration.shouldBootstrap}
                username={config.collaboration.username}
                cursorColor={config.collaboration.cursorColor}
                cursorsContainerRef={cursorsContainerRef}
                initialEditorState={config.collaboration.initialEditorState}
              />
            ) : (
              <HistoryPlugin externalHistoryState={historyState} />
            )}
            {/* FloatingDocumentActionsPlugin removed - unified header bar now provides these features */}
            <RichTextPlugin
              contentEditable={
                <div className="editor-scroller" ref={onRef}>
                  {config.documentHeader}
                  <div className="editor">
                    <ContentEditable placeholder={placeholder} />
                    {config.collaboration && (
                      <div ref={cursorsContainerRef as React.RefObject<HTMLDivElement>} className="collab-cursors-container" />
                    )}
                  </div>
                </div>
              }
              ErrorBoundary={LexicalErrorBoundary}
            />
            <MarkdownShortcutPlugin />
            <MarkdownPastePlugin transformers={markdownTransformers} />
            <MarkdownCopyPlugin transformers={markdownTransformers} />
            {isCodeHighlighted && (
              <Suspense fallback={null}>
                <CodeHighlightPlugin />
              </Suspense>
            )}
            <ListPlugin hasStrictIndent={listStrictIndent} />
            <CheckListPlugin />
            <TablePlugin
              hasCellMerge={false}
              hasCellBackgroundColor={false}
              hasHorizontalScroll={false}
            />
            <TableCellResizer />
            <ImagesPlugin
              onImageDoubleClick={config.onImageDoubleClick}
              onImageDragStart={config.onImageDragStart}
              onUploadAsset={config.onUploadAsset}
              resolveImageSrc={config.resolveImageSrc}
            />
            <LinkPlugin hasLinkAttributes={hasLinkAttributes} />
            <ClickableLinkPlugin disabled={isEditable} />
            {/* collab-asset:// anchor clicks: ClickableLinkPlugin is
                disabled in editable mode (so clicks place the cursor
                instead of navigating). For E2E-encrypted attachment links
                we still want a click to open/download the asset. */}
            <CollabAssetLinkPlugin />
            <AssetGCPlugin onAssetReferencesRemoved={config.onAssetReferencesRemoved} />
            <HorizontalRulePlugin />
            <TabFocusPlugin />
            <TabIndentationPlugin maxIndent={7} />
            <CollapsiblePlugin />
            <PageBreakPlugin />
            <LayoutPlugin />
            <DiffPlugin />
            <KanbanBoardPlugin />
            {/* Render any custom plugins including DocumentLinkPlugin when registered */}
            {/* Provide floating anchor element and frontmatter utilities to dynamic plugins */}
            <FrontmatterProvider value={frontmatterUtils}>
              <AnchorProvider value={floatingAnchorElem}>
                <PluginManager />
              </AnchorProvider>
            </FrontmatterProvider>

            {floatingAnchorElem && (
              <>
                <FloatingLinkEditorPlugin
                  anchorElem={floatingAnchorElem}
                  isLinkEditMode={isLinkEditMode}
                  setIsLinkEditMode={setIsLinkEditMode}
                />
                <TableCellActionMenuPlugin
                  anchorElem={floatingAnchorElem}
                  cellMerge={true}
                />
              </>
            )}
            {floatingAnchorElem && (forceFloatingToolbar || !isSmallWidthViewport) && (
              <>
                <DraggableBlockPlugin anchorElem={floatingAnchorElem} />
                <CodeActionMenuPlugin anchorElem={floatingAnchorElem} />
                <TableHoverActionsPlugin anchorElem={floatingAnchorElem} />
                <FloatingTextFormatToolbarPlugin
                  anchorElem={floatingAnchorElem}
                  setIsLinkEditMode={setIsLinkEditMode}
                />
              </>
            )}
          </>
        ) : (
          <>
            <PlainTextPlugin
              contentEditable={<ContentEditable placeholder={placeholder} />}
              ErrorBoundary={LexicalErrorBoundary}
            />
            <HistoryPlugin externalHistoryState={historyState} />
          </>
        )}

      </div>
      {(runtimeSettings.settings.showTreeView || config.showTreeView) && <TreeViewPlugin />}
    </>
  );
}
