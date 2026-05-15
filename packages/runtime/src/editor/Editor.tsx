/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type { JSX } from 'react';
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';

import { ClickableLinkPlugin } from '@lexical/react/LexicalClickableLinkPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HashtagPlugin } from '@lexical/react/LexicalHashtagPlugin';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { TablePlugin } from '@lexical/react/LexicalTablePlugin';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { CAN_USE_DOM } from '@lexical/utils';

import { $convertToEnhancedMarkdownString } from './markdown';

import { DEFAULT_EDITOR_CONFIG, type EditorConfig } from './EditorConfig';
import { getEditorTransformers } from './markdown';
import AutoEmbedPlugin from './plugins/AutoEmbedPlugin';
import CodeActionMenuPlugin from './plugins/CodeActionMenuPlugin';
import ComponentPickerPlugin from './plugins/ComponentPickerPlugin';
import DraggableBlockPlugin from './plugins/DraggableBlockPlugin';
import EmojiPickerPlugin from './plugins/EmojiPickerPlugin';
import FloatingLinkEditorPlugin from './plugins/FloatingLinkEditorPlugin';
import FloatingTextFormatToolbarPlugin from './plugins/FloatingTextFormatToolbarPlugin';
import { setImagePluginCallbacks } from './plugins/ImagesPlugin';
import { KanbanBoardPlugin } from './plugins/KanbanBoardPlugin';
import MarkdownShortcutPlugin from './plugins/MarkdownShortcutPlugin';
import ShortcutsPlugin from './plugins/ShortcutsPlugin';
import SpeechToTextPlugin from './plugins/SpeechToTextPlugin';
import TableCellActionMenuPlugin from './plugins/TableActionMenuPlugin';
import TableCellResizer from './plugins/TableCellResizer';
import TableHoverActionsPlugin from './plugins/TableHoverActionsPlugin';
import ToolbarPlugin from './plugins/ToolbarPlugin';
import TreeViewPlugin from './plugins/TreeViewPlugin';
import { SelectionAlwaysOnDisplay } from './plugins/SelectionAlwaysOnDisplayPlugin';
import ListEnterFormatClearPlugin from './plugins/ListEnterFormatClearPlugin';
import ContentEditable from './ui/ContentEditable';
import { AnchorProvider } from './context/AnchorContext';
import { FrontmatterProvider } from './context/FrontmatterContext';
import { $getFrontmatter, $setFrontmatter } from './markdown/FrontmatterUtils';
import { useRuntimeSettings } from './context/RuntimeSettingsContext';
import CodeHighlightPlugin from './plugins/CodeHighlightPlugin';
import { useExtensionEditorComponents } from './extensions/extensionEditorComponentsStore';
import { CollaborationPlugin } from '@lexical/react/LexicalCollaborationPlugin';

interface EditorProps {
  config?: EditorConfig;
}

/**
 * Editor shell. Most plugins are now declared as `LexicalExtension`
 * dependencies in `NimbalystEditorExtensions.ts`; this component only
 * mounts React UI surfaces that genuinely need to live in the React tree
 * (toolbar, floating menus, table UI). Extension-contributed UI plugins
 * mount through `useExtensionEditorComponents()`.
 */
export default function Editor({ config = DEFAULT_EDITOR_CONFIG }: EditorProps): JSX.Element {
  const runtimeSettings = useRuntimeSettings();
  const {
    isCodeHighlighted,
    isRichText,
    shouldPreserveNewLinesInMarkdown,
    selectionAlwaysOnDisplay,
    markdownOnly,
    editable = true,
    onSaveRequest,
    showToolbar = false,
    forceFloatingToolbar = false,
  } = config;

  const isEditable = useLexicalEditable();
  const placeholder = isRichText ? 'Enter some rich text...' : 'Enter some plain text...';

  const [floatingAnchorElem, setFloatingAnchorElem] = useState<HTMLDivElement | null>(null);
  const [isSmallWidthViewport, setIsSmallWidthViewport] = useState<boolean>(false);
  const [editor] = useLexicalComposerContext();
  const [activeEditor, setActiveEditor] = useState(editor);
  const [isLinkEditMode, setIsLinkEditMode] = useState<boolean>(false);

  const markdownTransformers = useMemo(
    () => config.markdownTransformers ?? getEditorTransformers(),
    [config.markdownTransformers],
  );

  // Image plugin uses module-level callback slots so the headless
  // ImagesExtension command handler doesn't need props.
  useEffect(() => {
    setImagePluginCallbacks({
      onImageDoubleClick: config.onImageDoubleClick,
      onImageDragStart: config.onImageDragStart,
      onUploadAsset: config.onUploadAsset,
      resolveImageSrc: config.resolveImageSrc,
    });
  }, [
    config.onImageDoubleClick,
    config.onImageDragStart,
    config.onUploadAsset,
    config.resolveImageSrc,
  ]);

  const frontmatterUtils = useMemo(
    () => ({
      $getFrontmatter: () => $getFrontmatter(),
      $setFrontmatter: (data: unknown) => {
        $setFrontmatter(data as Parameters<typeof $setFrontmatter>[0]);
      },
    }),
    [],
  );

  // Expose markdown content getter
  useEffect(() => {
    if (config.onGetContent) {
      const getContent = () =>
        editor.read(() => $convertToEnhancedMarkdownString(markdownTransformers));
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

  useEffect(() => {
    const removeUpdateListener = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      if (!hasCompletedInitialLoadRef.current) {
        hasCompletedInitialLoadRef.current = true;
        return;
      }
      if (config.onDirtyChange) config.onDirtyChange(true);
    });
    return () => removeUpdateListener();
  }, [editor, config.onDirtyChange]);

  const cursorsContainerRef = useRef<HTMLElement | null>(null);
  const cursorFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const CURSOR_FADE_DELAY_MS = 3000;

  useEffect(() => {
    if (!config.collaboration) return;
    const container = cursorsContainerRef.current;
    if (!container) return;
    const observer = new MutationObserver(() => {
      container.classList.remove('collab-cursors-faded');
      if (cursorFadeTimerRef.current) clearTimeout(cursorFadeTimerRef.current);
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
      if (cursorFadeTimerRef.current) clearTimeout(cursorFadeTimerRef.current);
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
    return () => window.removeEventListener('resize', updateViewPortWidth);
  }, [isSmallWidthViewport]);

  // Renderer-contributed React plugins (DocumentLinkPlugin,
  // AIChatIntegrationPlugin, TrackerPlugin, etc.). Each is registered via
  // `registerExtensionEditorComponent` at app startup.
  const extensionEditorComponents = useExtensionEditorComponents();

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
      <div
        className={`editor-container ${
          runtimeSettings.settings.showTreeView || config.showTreeView ? 'tree-view' : ''
        } ${!isRichText ? 'plain-text' : ''}`}
      >
        {selectionAlwaysOnDisplay && <SelectionAlwaysOnDisplay />}
        {floatingAnchorElem && <ComponentPickerPlugin anchorElem={floatingAnchorElem} />}
        <EmojiPickerPlugin />
        <AutoEmbedPlugin />
        <HashtagPlugin />
        <SpeechToTextPlugin />

        {isRichText ? (
          <>
            {config.collaboration && (
              <CollaborationPlugin
                id="main"
                providerFactory={config.collaboration.providerFactory}
                shouldBootstrap={config.collaboration.shouldBootstrap}
                username={config.collaboration.username}
                cursorColor={config.collaboration.cursorColor}
                cursorsContainerRef={cursorsContainerRef}
                initialEditorState={config.collaboration.initialEditorState}
              />
            )}
            <RichTextPlugin
              contentEditable={
                <div className="editor-scroller" ref={onRef}>
                  {config.documentHeader}
                  <div className="editor">
                    <ContentEditable placeholder={placeholder} />
                    {config.collaboration && (
                      <div
                        ref={cursorsContainerRef as React.RefObject<HTMLDivElement>}
                        className="collab-cursors-container"
                      />
                    )}
                  </div>
                </div>
              }
              ErrorBoundary={LexicalErrorBoundary}
            />
            <MarkdownShortcutPlugin />
            <ListEnterFormatClearPlugin />
            {isCodeHighlighted && (
              <Suspense fallback={null}>
                <CodeHighlightPlugin />
              </Suspense>
            )}
            <TablePlugin
              hasCellMerge={false}
              hasCellBackgroundColor={false}
              hasHorizontalScroll={false}
            />
            <TableCellResizer />
            <ClickableLinkPlugin disabled={isEditable} />
            <KanbanBoardPlugin />

            {/*
              React UI surfaces contributed by extensions or the renderer
              shell. The headless plugin systems (nodes, transformers,
              commands) flow through `LexicalExtension` dependencies in
              `NimbalystEditorExtensions.ts`; this slot is only for
              components that genuinely need a React tree -- typeahead
              menus, dialog hosts, host-context-aware effect plugins.
            */}
            <FrontmatterProvider value={frontmatterUtils}>
              <AnchorProvider value={floatingAnchorElem}>
                {extensionEditorComponents.map(({ name, Component }) => (
                  <Component key={name} />
                ))}
              </AnchorProvider>
            </FrontmatterProvider>

            {floatingAnchorElem && (
              <>
                <FloatingLinkEditorPlugin
                  anchorElem={floatingAnchorElem}
                  isLinkEditMode={isLinkEditMode}
                  setIsLinkEditMode={setIsLinkEditMode}
                />
                <TableCellActionMenuPlugin anchorElem={floatingAnchorElem} cellMerge={true} />
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
          </>
        )}
      </div>
      {(runtimeSettings.settings.showTreeView || config.showTreeView) && <TreeViewPlugin />}
    </>
  );
}
