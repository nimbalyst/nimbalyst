/**
 * AI Chat Integration Plugin
 *
 * Registers editor instances with the EditorRegistry to enable:
 * 1. Apply text replacements to the editor using the DiffPlugin
 * 2. Stream markdown content directly into the editor using MarkdownStreamProcessor
 */

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $setDiffState, APPLY_MARKDOWN_REPLACE_COMMAND, type TextReplacement, $hasDiffNodes } from '../../../editor';
import { $getSelection, $isRangeSelection, $getRoot, $isElementNode, LexicalNode } from 'lexical';
import { MarkdownStreamProcessor, getEditorTransformers } from '../../../editor';
import { $isHeadingNode } from '@lexical/rich-text';
import { $convertToEnhancedMarkdownString, $convertNodeToEnhancedMarkdownString } from '../../../editor';
import { editorRegistry } from '../../EditorRegistry';
import { useDocumentPath } from '../../../DocumentPathContext';

/**
 * Find the node key to insert after based on markdown content search
 */
function findInsertionPoint(
  children: LexicalNode[],
  searchMarkdown: string,
  transformers: any[]
): string | undefined {
  // Clean up the search markdown - extract section name if it's multi-line
  const searchLines = searchMarkdown.trim().split('\n');
  let searchTarget = searchLines[0].trim();

  // Remove markdown heading syntax if present
  searchTarget = searchTarget.replace(/^#+\s*/, '').toLowerCase();

  console.log('[streaming] Finding insertion point for:', searchTarget);
  console.log('[streaming] Total children to search:', children.length);

  // First pass: Find exact heading match
  for (let i = 0; i < children.length; i++) {
    const child = children[i];

    if ($isHeadingNode(child)) {
      const headingText = child.getTextContent().toLowerCase().trim();

      if (headingText === searchTarget || headingText.includes(searchTarget)) {
        console.log('[streaming]', `Found heading match at index ${i}: "${headingText}"`);

        // Find the end of this section (last non-empty node before next heading or end)
        let sectionEndIndex = i;
        let lastNonEmptyIndex = i;

        for (let j = i + 1; j < children.length; j++) {
          const node = children[j];

          if ($isHeadingNode(node)) {
            // Found next section, stop here
            console.log('[streaming]', `Found next section at index ${j}`);
            break;
          }

          // Track the last non-empty node in this section
          const nodeText = node.getTextContent().trim();
          if (nodeText.length > 0) {
            lastNonEmptyIndex = j;
            console.log('[streaming]', `Found non-empty node at index ${j}: "${nodeText.substring(0, 30)}"`);
          } else {
            console.log('[streaming]', `Skipping empty node at index ${j}`);
          }

          sectionEndIndex = j;
        }

        // Use the last non-empty node if we found one, otherwise use the section end
        const insertIndex = lastNonEmptyIndex > i ? lastNonEmptyIndex : sectionEndIndex;
        const endNode = children[insertIndex];
        const nodeType = endNode.getType();
        console.log('[streaming]', `Section ends at index ${insertIndex}, node type: ${nodeType}, inserting after: "${endNode.getTextContent().substring(0, 50)}"`);
        return endNode.getKey();
      }
    }
  }

  // Second pass: Look for the search text within any section's markdown content
  console.log('[streaming]', 'No heading match, searching within content...');

  // Convert full document to markdown for searching
  const fullMarkdown = $convertToEnhancedMarkdownString(transformers, { includeFrontmatter: false });
  const searchIndex = fullMarkdown.toLowerCase().indexOf(searchTarget);

  if (searchIndex >= 0) {
    console.log('[streaming]', `Found text in markdown at position ${searchIndex}`);

    // Find which node contains this position
    let currentPos = 0;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const nodeMarkdown = $isElementNode(child)
        ? $convertNodeToEnhancedMarkdownString(transformers, child, true)
        : child.getTextContent();
      const nodeLength = nodeMarkdown.length;

      if (currentPos <= searchIndex && searchIndex < currentPos + nodeLength) {
        // Found the node containing our search text
        console.log('[streaming]', `Text found in node at index ${i}`);

        // If it's a heading, find end of its section
        if ($isHeadingNode(child)) {
          let sectionEndIndex = i;
          for (let j = i + 1; j < children.length; j++) {
            if ($isHeadingNode(children[j])) {
              break;
            }
            sectionEndIndex = j;
          }
          return children[sectionEndIndex].getKey();
        } else {
          // For non-heading nodes, insert after this node
          return child.getKey();
        }
      }
      currentPos += nodeLength + 1; // +1 for newline between nodes
    }
  }

  console.log('[streaming]', 'No matching content found');
  return undefined;
}

/**
 * Plugin component that registers the editor instance with the EditorRegistry
 */
export function AIChatIntegrationPlugin(): null {
  const [editor] = useLexicalComposerContext();
  const { documentPath: contextFilePath } = useDocumentPath();
  const streamProcessorsRef = useRef<Map<string, MarkdownStreamProcessor>>(new Map());
  const streamConfigRef = useRef<Map<string, { startingNodeKey?: string; insertAfter?: string; insertAtEnd?: boolean }>>(new Map());

  useEffect(() => {
    // Get the file path from DocumentPathContext (provided by TabEditor's DocumentPathProvider).
    // Falls back to walking the DOM for backwards compatibility.
    const rootElement = editor.getRootElement();
    const filePath = contextFilePath
      || rootElement?.closest('.multi-editor-instance')?.getAttribute('data-file-path')
      || null;

    // Ensure the window-exposed registry is the same instance we're using.
    // Module bundling can create duplicate singletons; this ensures the test
    // harness (which reads window.__editorRegistry) sees our registrations.
    if (typeof window !== 'undefined') {
      (window as any).__editorRegistry = editorRegistry;
    }

    if (!filePath) {
      // editor may be the diff preview or not yet in the right context
      return;
    }

    const instanceId = `${filePath}::${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const isEditorVisible = (): boolean => {
      const currentRoot = editor.getRootElement();
      if (!currentRoot) return false;

      const style = window.getComputedStyle(currentRoot);
      if (style.display === 'none' || style.visibility === 'hidden') return false;

      const rect = currentRoot.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;

      // offsetParent is null when any ancestor has display:none.
      // position:fixed elements legitimately have null offsetParent.
      return currentRoot.offsetParent !== null || style.position === 'fixed';
    };

    // console.log('[AIChatIntegrationPlugin] Registering editor for:', filePath);

    // Set up focus listener to track active editor
    const handleFocus = () => {
      // console.log('[AIChatIntegrationPlugin] Editor focused:', filePath);
      editorRegistry.setActive(filePath, instanceId);
    };

    // Add focus listener to root element
    rootElement?.addEventListener('focus', handleFocus, true);
    rootElement?.addEventListener('click', handleFocus); // Also handle clicks since editors might not always fire focus

    // Create the editor instance interface
    const editorInstance = {
      instanceId,
      filePath,
      editor,
      isVisible: isEditorVisible,

      hasPendingDiffs: (): boolean => {
        let hasDiffs = false;
        editor.getEditorState().read(() => {
          hasDiffs = $hasDiffNodes(editor);
        });
        return hasDiffs;
      },

      applyReplacements: async (replacements: TextReplacement[], requestId?: string): Promise<{ success: boolean; error?: string }> => {
        if (!replacements || !Array.isArray(replacements)) {
          return { success: false, error: 'Invalid replacements array' };
        }

        try {
          // Create a promise that resolves when the diff application completes
          return await new Promise<{ success: boolean; error?: string }>((resolve) => {
            // Set up listener for the completion event
            // Use requestId to correlate events to this specific request
            const handleComplete = (event: CustomEvent) => {
              // Only handle events for THIS request
              if (requestId && event.detail.requestId !== requestId) {
                return;
              }

              window.removeEventListener('diffApplyComplete', handleComplete as EventListener);

              if (event.detail.success) {
                resolve({ success: true });
              } else {
                resolve({ success: false, error: event.detail.error || 'Diff application failed' });
              }
            };

            window.addEventListener('diffApplyComplete', handleComplete as EventListener);

            // Dispatch the command with requestId attached to the replacements
            // LiveNodeKeyState is set automatically by applyMarkdownReplace via parallel traversal
            const commandPayload = { replacements, requestId };
            console.log('[AIChatIntegrationPlugin] Dispatching APPLY_MARKDOWN_REPLACE_COMMAND', commandPayload);
            console.log('[AIChatIntegrationPlugin] Command object:', APPLY_MARKDOWN_REPLACE_COMMAND);
            const commandSuccess = editor.dispatchCommand(APPLY_MARKDOWN_REPLACE_COMMAND, commandPayload);
            console.log('[AIChatIntegrationPlugin] Command dispatch returned:', commandSuccess);

            if (!commandSuccess) {
              window.removeEventListener('diffApplyComplete', handleComplete as EventListener);
              resolve({ success: false, error: 'Command handler rejected the replacements' });
              return;
            }
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: errorMessage };
        }
      },

      startStreaming: async (config: any): Promise<void> => {
        console.log('[AIChatIntegrationPlugin] Starting streaming for:', filePath, config);

        // Get the starting node key based on insertion point
        let startingNodeKey: string | undefined;

        await editor.update(() => {
          const root = $getRoot();
          const children = root.getChildren();
          const transformers = getEditorTransformers();

          if (config.insertAtEnd) {
            // Insert at the end of the document
            if (children.length > 0) {
              const lastChild = children[children.length - 1];
              startingNodeKey = lastChild.getKey();
              console.log('[streaming] Inserting at end, after node:', lastChild.getTextContent().substring(0, 50));
            }
          } else if (config.insertAfter) {
            // Use our markdown-aware search function
            startingNodeKey = findInsertionPoint(children, config.insertAfter, transformers);

            // If not found, default to end of document
            if (!startingNodeKey && children.length > 0) {
              console.log('[streaming] Could not find insertion point, defaulting to end');
              const lastChild = children[children.length - 1];
              startingNodeKey = lastChild.getKey();
            }
          } else {
            // Fallback to cursor position
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              const anchorNode = selection.anchor.getNode();
              const topLevelNode = anchorNode.getTopLevelElement();
              if (topLevelNode) {
                startingNodeKey = topLevelNode.getKey();
              }
            }
          }
        });

        // Store the configuration for this stream
        streamConfigRef.current.set(config.id, {
          startingNodeKey,
          insertAfter: config.insertAfter,
          insertAtEnd: config.insertAtEnd
        });

        // Create a stream processor
        const mode = config.insertAtEnd ? 'extend' : (config.mode || 'after');
        const processor = new MarkdownStreamProcessor(
          editor,
          getEditorTransformers(),
          startingNodeKey,
          mode,
          (node) => {
            // Mark the streamed node as 'added' in the diff infrastructure
            $setDiffState(node, 'added');
            // console.log('[editor] Node created during streaming and marked as added:', node.getKey());
          }
        );

        streamProcessorsRef.current.set(config.id, processor);
      },

      streamContent: async (streamId: string, content: string): Promise<void> => {
        console.log('[AIChatIntegrationPlugin] Streaming content to:', filePath, { streamId, contentLength: content.length });

        const processor = streamProcessorsRef.current.get(streamId);

        if (processor) {
          await processor.insertWithUpdate(content);
          // console.log('[streaming] Content streamed successfully');
        } else {
          console.error('[streaming] No processor found for stream:', streamId);
        }
      },

      endStreaming: (streamId: string): void => {
        console.log('[AIChatIntegrationPlugin] Ending streaming for:', filePath, streamId);
        streamProcessorsRef.current.delete(streamId);
        streamConfigRef.current.delete(streamId);
      },

      getContent: (): string => {
        let content = '';
        editor.getEditorState().read(() => {
          const transformers = getEditorTransformers();
          content = $convertToEnhancedMarkdownString(transformers, { includeFrontmatter: true });
        });
        return content;
      }
    };

    // Register with the registry
    editorRegistry.register(editorInstance);

    // Check if this editor is currently active (data-active="true")
    const editorContainer = rootElement?.closest('.multi-editor-instance');
    const isActive = editorContainer?.getAttribute('data-active') === 'true';
    if (isActive) {
      // console.log('[AIChatIntegrationPlugin] Registering as active editor:', filePath);
      editorRegistry.setActive(filePath, instanceId);
    }

    // Cleanup on unmount
    return () => {
      editorRegistry.unregister(filePath, instanceId);
      streamProcessorsRef.current.clear();
      streamConfigRef.current.clear();
      rootElement?.removeEventListener('focus', handleFocus, true);
      rootElement?.removeEventListener('click', handleFocus);
    };
  }, [editor, contextFilePath]);

  return null;
}
