/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type { JSX } from 'react';
import { useMemo, useRef } from 'react';

import { LexicalExtensionComposer } from '@lexical/react/LexicalExtensionComposer';
import { LexicalCollaboration } from '@lexical/react/LexicalCollaborationContext';
import { $convertFromEnhancedMarkdownString } from './markdown';
import {
    $createParagraphNode,
    $createTextNode,
    $getRoot,
    DOMConversionMap,
} from 'lexical';

import { DEFAULT_EDITOR_CONFIG, type EditorConfig } from './EditorConfig';
import { SharedHistoryContext } from './context/SharedHistoryContext';
import { TableContext } from './plugins/TablePlugin/TablePlugin.tsx';
import { ToolbarContext } from './context/ToolbarContext';
import { useTheme } from './context/ThemeContext';
import { RuntimeSettingsProvider } from './context/RuntimeSettingsContext';
import { useResponsiveWidth } from './hooks/useResponsiveWidth';
import Editor from './Editor';
import { buildNimbalystRootExtension } from './extensions/NimbalystEditorExtensions';
import { useExtensionLexicalExtensions } from './extensions/extensionLexicalExtensionsStore';
import { getEditorTransformers } from './markdown';

export interface NimbalystEditorProps {
    config?: EditorConfig;
}

function NimbalystEditor({config}: NimbalystEditorProps): JSX.Element {
    // Merge provided config with defaults
    const mergedConfig = {
        ...DEFAULT_EDITOR_CONFIG,
        ...config
    };

    // Get theme from DOM (set by app-level theme system)
    const { theme, isDark } = useTheme();
    const containerRef = useRef<HTMLDivElement>(null);
    const widthClass = useResponsiveWidth(containerRef);
    const markdownTransformers = useMemo(
        () => mergedConfig.markdownTransformers ?? getEditorTransformers(),
        [mergedConfig.markdownTransformers]
    );

    // Live view of extension-contributed Lexical extensions. The bridge
    // publishes into this store; updates rebuild the editor via the
    // useMemo below.
    const extensionLexicalExtensions = useExtensionLexicalExtensions();

    // The root extension must be stable across renders so the underlying
    // editor instance isn't recreated. We deliberately key only on inputs
    // that should rebuild the editor: collaboration mode toggle, initial
    // content change, editable flag, emptyEditor flag, and the transformer
    // set (markdown imports depend on it).
    //
    // Phase 7.5 will move plugin extensions into `dependencies` here. For
    // now `dependencies: []` -- every plugin still mounts as a React child
    // inside `<LexicalExtensionComposer>` (see Phase 7.1 in
    // `nimbalyst-local/plans/lexical-upgrade-and-defork.md`).
    const rootExtension = useMemo(() => {
        const $initialEditorState = (() => {
            if (mergedConfig.collaboration) {
                // CollaborationPlugin hydrates from Y.Doc; do not bootstrap.
                return null;
            }
            if (mergedConfig.initialContent) {
                return () => {
                    const root = $getRoot();
                    root.clear();
                    $convertFromEnhancedMarkdownString(
                        mergedConfig.initialContent!,
                        markdownTransformers,
                    );
                };
            }
            if (!mergedConfig.emptyEditor) {
                return $createEmptyEditor;
            }
            return null;
        })();

        return buildNimbalystRootExtension({
            editable: mergedConfig.editable,
            $initialEditorState,
            listStrictIndent: mergedConfig.listStrictIndent,
            collaboration: Boolean(mergedConfig.collaboration),
            hasLinkAttributes: mergedConfig.hasLinkAttributes,
            markdownTransformers,
            onAssetReferencesRemoved: mergedConfig.onAssetReferencesRemoved,
            onUploadAsset: mergedConfig.onUploadAsset,
            extensionDependencies: extensionLexicalExtensions,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
        // rebuild keys; we explicitly do not depend on every config field.
    }, [
        mergedConfig.collaboration,
        mergedConfig.initialContent,
        mergedConfig.editable,
        mergedConfig.emptyEditor,
        mergedConfig.listStrictIndent,
        mergedConfig.hasLinkAttributes,
        mergedConfig.onAssetReferencesRemoved,
        mergedConfig.onUploadAsset,
        markdownTransformers,
        extensionLexicalExtensions,
    ]);

    return (
        <div
            ref={containerRef}
            className={`nimbalyst-editor ${widthClass} ${isDark ? 'dark-theme' : ''}`}
            data-theme={theme}
        >
            <RuntimeSettingsProvider>
                <LexicalExtensionComposer extension={rootExtension} contentEditable={null}>
                    <LexicalCollaboration>
                        <SharedHistoryContext>
                            <TableContext>
                                <ToolbarContext>
                                    <div className="editor-shell">
                                        <Editor config={mergedConfig}/>
                                    </div>
                                </ToolbarContext>
                            </TableContext>
                        </SharedHistoryContext>
                    </LexicalCollaboration>
                </LexicalExtensionComposer>
            </RuntimeSettingsProvider>
        </div>
    );
}

function $createEmptyEditor() {
    const root = $getRoot();
    if (root.getFirstChild() === null) {
        const paragraph = $createParagraphNode();
        root.append(paragraph);
    }
}

// Map for HTML paste import
function buildImportMap(): DOMConversionMap {
    const importMap: DOMConversionMap = {};

    // Import text nodes
    importMap['#text'] = () => ({
        conversion: (element: Node) => {
            const textContent = element.textContent;
            if (typeof textContent === 'string' && textContent.trim() !== '') {
                return {node: $createTextNode(textContent)};
            }
            return null;
        },
        priority: 0,
    });

    return importMap;
}

// Export the main component
export { NimbalystEditor };
