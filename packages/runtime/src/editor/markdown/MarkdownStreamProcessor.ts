/**
 * Copyright (c) Nimbalyst, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// eslint-disable no-console
import {createHeadlessEditor} from '@lexical/headless';
import {$findMatchingParent} from '@lexical/utils';
import {
  $createParagraphNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $isTextNode,
  $parseSerializedNode,
  ElementNode,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedEditorState,
  TextNode,
} from 'lexical';

import {
  Transformer,
  TRANSFORMERS,
} from '@lexical/markdown';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  $convertNodeToEnhancedMarkdownString,
} from './index';

export type InsertMode = 'extend' | 'after';

/**
 * Architecture Overview:
 *
 * The MarkdownStreamProcessor is a utility for handling streaming markdown insertion into a Lexical editor.
 * It manages the complex process of converting markdown text into Lexical nodes while maintaining proper
 * document structure and handling incremental updates.
 *
 * Key Components:
 * 1. Node Management
 *    - Tracks a working node (workingNodeKey) that serves as the current insertion point
 *    - Maintains boundaries (startingNodeKey and nextNodeKey) to control where content is inserted
 *    - Handles both insertion and replacement modes
 *
 * 2. Markdown Processing
 *    - Processes markdown text incrementally, line by line
 *    - Uses a headless editor instance to convert markdown to Lexical nodes
 *    - Maintains state of previously processed text to handle partial updates
 *
 * 3. Node Tree Updates
 *    - Recursively updates the node tree to maintain proper structure
 *    - Handles both text nodes and element nodes differently
 *    - Preserves node relationships and formatting
 *
 * 4. Extension Points
 *    - Provides an onNodeCreated callback for apps to set custom metadata
 *    - Supports custom transformers for markdown conversion
 *
 * Usage Flow:
 * 1. Initialize with an editor instance and optional transformers
 * 2. Set insertion boundaries if needed (startingNodeKey, nextNodeKey)
 * 3. Call insert() with markdown text to process
 * 4. The utility handles converting markdown to nodes and updating the editor
 *
 * The utility is particularly useful for:
 * - Streaming markdown insertion (e.g., from AI completions)
 * - Incremental updates to existing markdown content
 * - Maintaining proper document structure during complex insertions
 */

// Move getNearestRootChild to lexical-utils
function getNearestRootChild(node: LexicalNode): ElementNode | null {
  let current: LexicalNode | null = node;
  while (current !== null) {
    const parent: LexicalNode | null = current.getParent();
    if (parent === null || $isRootOrShadowRoot(parent)) {
      return $isElementNode(current) ? current : null;
    }
    current = parent;
  }
  return null;
}

function $isDescendantOf(node: LexicalNode, parent: LexicalNode): boolean {
  return (
    $findMatchingParent(
      node,
      (n: LexicalNode) => n.getKey() === parent.getKey(),
    ) !== null
  );
}

/**
 * Creates a headless editor instance from an existing LexicalEditor, configured with the same namespace and nodes.
 * @param editor
 */
export function createHeadlessEditorFromEditor(
  editor: LexicalEditor,
): LexicalEditor {
  const headlessEditor = createHeadlessEditor({
    namespace: editor._createEditorArgs?.namespace || 'headless-editor',
    nodes: editor._createEditorArgs?.nodes || [],
  });

  return headlessEditor;
}

/**
 * Converts a markdown string to a JSON representation of the editor state.
 * @param editor
 * @param transformers - Array of transformers to use for conversion
 * @param markdown - The markdown content to convert
 */
export function markdownToJSONSync(
  editor: LexicalEditor,
  transformers: Transformer[],
  markdown: string,
): SerializedEditorState {
  const headlessEditor = createHeadlessEditorFromEditor(editor);

  headlessEditor.update(
    () => {
      $convertFromEnhancedMarkdownString(
        markdown,
        transformers,
        undefined,
        true,
        false
      );
    },
    {discrete: true},
  );

  return headlessEditor.getEditorState().toJSON();
}

/*
 * This utility manages the insertion of content into the editor
 * It works with streaming markdown that is translated incrementally into lexical nodes that are then merged into the editor.
 *
 * It has two modes, one where it is inserting content into a location in the document and one where it is updating or replacing the content between two nodes.
 *
 * During updates, it has to recursively reconstruct the lexical node tree from the incremental markdown
 *
 * Starting Node is either a root or shadow root child to append after, or a root or shadow root who's children are to be replaced.
 *
 */
export class MarkdownStreamProcessor {
  private editor: LexicalEditor;
  private transformers: Transformer[];

  // === BOUNDARY CONTROL ===
  // The node where streaming operations begin (first node that can be modified)
  startingNodeKey: NodeKey | null;

  // The node that marks the end boundary (content after this node should be preserved)
  // When null, streaming can modify content all the way to the end of the document
  nextNodeKey: NodeKey | null;

  // === INCREMENTAL STATE ===
  // The accumulated markdown text from all streaming operations so far
  // This grows with each insertInternal() call and gets parsed to determine new DOM structure
  private previousText: string;

  // The markdown representation of the CURRENT working area being modified
  // This represents the markdown that corresponds to the nodes between startingNodeKey and nextNodeKey
  private currentRootChildMarkdown: string;

  // === CURRENT WORKING POSITION ===
  // The node where the NEXT streaming operation should start from
  // This typically advances forward as content is streamed and may be reset by insertNodes()
  private workingNodeKey: NodeKey | null;

  // === MODE CONTROL ===
  // Controls whether to extend existing content or insert after a node
  private insertMode: InsertMode;

  // === DEBUG & CALLBACKS ===
  private isVerbose: boolean = false;
  private onNodeCreated?: (node: LexicalNode) => void;

  constructor(
    editor: LexicalEditor,
    transformers?: Transformer[],
    startingNodeKey?: NodeKey,
    insertMode: InsertMode = 'after',
    onNodeCreated?: (node: LexicalNode) => void,
  ) {
    this.editor = editor;
    this.transformers = transformers || TRANSFORMERS;
    this.startingNodeKey = null;
    this.nextNodeKey = null;
    this.previousText = '';
    this.currentRootChildMarkdown = '';
    this.workingNodeKey = null;
    this.insertMode = insertMode;
    this.onNodeCreated = onNodeCreated;
    this.initializeContext(startingNodeKey);
  }

  verbose(verbose: boolean): MarkdownStreamProcessor {
    this.isVerbose = verbose;
    return this;
  }

  async initializeContext(startingNodeKey?: NodeKey): Promise<void> {
    if (this.editor._updating) {
      this.internalInitialize(startingNodeKey);
    } else {
      await this.editor.update(
        () => {
          this.internalInitialize(startingNodeKey);
        },
        {discrete: true},
      );
    }
  }

  internalInitialize(startingNodeKey?: NodeKey): void {
    // If a starting node key is provided, use it
    if (startingNodeKey) {
      const startingNode = $getNodeByKey(startingNodeKey);
      if (!startingNode) {
        throw new Error(`Node with key ${startingNodeKey} not found`);
      }

      if (this.insertMode === 'after') {
        // Insert-after mode: create placeholder after the target node
        // CRITICAL: Capture the next sibling BEFORE inserting placeholder!
        const originalNextSibling = startingNode.getNextSibling();

        const placeholder = $createParagraphNode();
        startingNode.insertAfter(placeholder);

        this.startingNodeKey = placeholder.getKey();
        this.workingNodeKey = placeholder.getKey();
        // Preserve everything from the original next sibling onwards
        this.nextNodeKey = originalNextSibling?.getKey() || null;
        this.currentRootChildMarkdown = '';
        this.previousText = '';
      } else {
        // Extend mode: existing behavior - continue from the target node
        this.startingNodeKey = startingNodeKey;
        this.workingNodeKey = startingNodeKey;

        // Automatically set nextNodeKey to preserve content after insertion point
        const nextSibling = startingNode.getNextSibling();
        this.nextNodeKey = nextSibling ? nextSibling.getKey() : null;

        const markdown = $isElementNode(startingNode)
          ? $convertNodeToEnhancedMarkdownString(this.transformers, startingNode, true)
          : '';

        this.currentRootChildMarkdown = markdown;
        this.previousText = this.currentRootChildMarkdown;
      }
      return;
    }

    // If no starting node key is provided, we append after the last meaningful content
    const rootChildren = $getRoot().getChildren();

    const lastChild = rootChildren[rootChildren.length - 1];

    if (lastChild) {
      // We'll append AFTER this meaningful content, starting from this node only
      this.startingNodeKey = lastChild.getKey();
      this.workingNodeKey = lastChild.getKey();
      this.nextNodeKey = null;

      // Get the markdown for just the starting node, not the entire document
      const markdown = $convertNodeToEnhancedMarkdownString(
        this.transformers,
        lastChild as ElementNode,
        true,
      );

      this.currentRootChildMarkdown = markdown;
      this.previousText = this.currentRootChildMarkdown;
      return; // Exit early, don't continue to selection-based logic
    }

    // Fallback to original selection-based logic
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
      // Handle no selection case - at this point lastChild is undefined
      const paragraph = $createParagraphNode();
      $getRoot().append(paragraph);
      paragraph.selectEnd();
    }

    const newSelection = $getSelection();
    if ($isRangeSelection(newSelection)) {
      let rootChild = getNearestRootChild(newSelection.anchor.getNode());

      if (!rootChild) {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        // paragraph.selectEnd();
        rootChild = paragraph;
      }

      // if there is no next sibling, we create one to avoid overwriting people typing below
      let nextSibling = rootChild.getNextSibling();

      if (!nextSibling) {
        const paragraph = $createParagraphNode();
        rootChild.insertAfter(paragraph);
        nextSibling = paragraph;
      }

      this.startingNodeKey = rootChild?.getKey();
      this.workingNodeKey = rootChild?.getKey();
      this.nextNodeKey = nextSibling.getKey();

      let markdown = $convertNodeToEnhancedMarkdownString(
        this.transformers,
        rootChild as ElementNode,
        true,
      );

      // Ensure proper trailing newlines for block elements to avoid concatenation
      if (
        markdown &&
        rootChild &&
        (rootChild.getType() === 'heading' ||
          rootChild.getType() === 'paragraph' ||
          rootChild.getType() === 'list')
      ) {
        if (!markdown.endsWith('\n\n')) {
          markdown += markdown.endsWith('\n') ? '\n' : '\n\n';
        }
      }

      this.currentRootChildMarkdown = markdown;
      this.previousText = this.currentRootChildMarkdown;
    }
  }

  /*
   * Controls how far down the content will be replaced by the new content
   */
  setNextNodeKey(nextNodeKey: NodeKey | null) {
    this.nextNodeKey = nextNodeKey;
  }

  async $insert(text: string): Promise<void> {
    if (!text) {
      return;
    }

    await this.insertInternal(text);
  }

  async insertWithUpdate(text: string): Promise<void> {
    try {
      await this.editor.update(
        () => {
          this.insertInternal(text);
        },
        {discrete: true},
      );
    } catch (e) {
      console.error(`Error inserting text ${text}:`, e);
      // Handle the error as needed
    }
  }

  async insertInternal(text: string): Promise<void> {
    // this seems to throw an error
    // $addUpdateTag('skip-dom-selection');

    const lines = text.split(/(?<=\n)/);
    let accumulatedMarkdown = this.previousText;

    for (const line of lines) {
      accumulatedMarkdown += line;
      const importedEditorStateJSON = markdownToJSONSync(
        this.editor,
        this.transformers,
        accumulatedMarkdown,
      );
      const workingNode = this.workingNodeKey
        ? $getNodeByKey(this.workingNodeKey)
        : null;

      if (!workingNode) {
        if (this.isVerbose) {
          console.error(
            '[MarkdownStreamProcessor] No working node found, aborting insertion',
          );
        }
        return;
      }

      const newNodes: LexicalNode[] =
        importedEditorStateJSON.root.children.map($parseSerializedNode);

      const nextSiblings = workingNode.getNextSiblings();
      const nextElementIndex = nextSiblings.findIndex(
        (node) => node.getKey() === this.nextNodeKey,
      );
      const targetSiblings =
        nextElementIndex === -1
          ? nextSiblings
          : nextSiblings.slice(0, nextElementIndex);

      const currentNodes = [workingNode, ...targetSiblings];

      // Don't call onNodeCreated here - it will be called recursively
      // within updateNodes when nodes are actually inserted/replaced

      const newWorkingNode = this.updateNodes(
        workingNode,
        newNodes,
        currentNodes,
      );
      if (newWorkingNode) {
        this.workingNodeKey = newWorkingNode.getKey();
      }
    }

    this.previousText += text;
  }

  private updateNodeRecursively(
    currentNode: LexicalNode,
    newNode: LexicalNode,
  ): LexicalNode {
    if ($isTextNode(currentNode) && $isTextNode(newNode)) {
      this.updateTextNode(currentNode, newNode);
    } else if (
      $isElementNode(currentNode) &&
      $isElementNode(newNode) &&
      currentNode.getType() === newNode.getType()
    ) {
      this.updateElementNode(currentNode, newNode);
    } else if ($isRootOrShadowRoot(currentNode) && $isElementNode(newNode)) {
      // Special case: when targeting a shadow root (like CollapsibleContentNode),
      // insert the new content inside it instead of replacing the shadow root itself
      currentNode.clear(); // Remove existing content
      // Call onNodeCreated recursively for the new node and all its descendants
      this.callOnNodeCreatedRecursively(newNode);
      currentNode.append(newNode); // Add new content inside
      return currentNode; // Return the shadow root, not the replacement
    } else {
      let replaceSelection = false;
      if ($isRangeSelection($getSelection())) {
        const selection = $getSelection();
        if (
          $isRangeSelection(selection) &&
          $isDescendantOf(selection.anchor.getNode(), currentNode)
        ) {
          replaceSelection = true;
        }
      }
      // When replacing a node with a different type, we need to call onNodeCreated
      // for the new node and all its descendants (e.g., when text becomes a table)
      this.callOnNodeCreatedRecursively(newNode);
      const replacedNode = currentNode.replace(newNode);

      if (replaceSelection) {
        newNode.selectEnd();
      }
      return replacedNode;
    }
    return currentNode;
  }

  private updateNodes(
    startingNode: LexicalNode,
    newNodes: LexicalNode[],
    currentNodes: LexicalNode[],
  ) {
    let currentIndex = 0;
    let newStartingNode = startingNode;
    let lastInsertedNode = startingNode;

    // Debug output for table processing
    if (this.isVerbose) {
      console.log('--- updateNodes ---');
      console.log(
        'Current nodes:',
        currentNodes.map((n) => ({
          key: n.getKey(),
          text: n.getTextContent().substring(0, 50),
          type: n.getType(),
        })),
      );
      console.log(
        'New nodes:',
        newNodes.map((n) => ({
          key: n.getKey(),
          text: n.getTextContent().substring(0, 50),
          type: n.getType(),
        })),
      );
    }

    // Special handling for shadow roots: all new nodes should go inside them
    if ($isRootOrShadowRoot(startingNode)) {
      // Replace all content with the new structure from markdown parsing
      startingNode.clear();
      newNodes.forEach((node) => {
        // Call onNodeCreated recursively for each node and all its descendants
        this.callOnNodeCreatedRecursively(node);
        startingNode.append(node);
        if (this.isVerbose) {
          console.log('Appended node to shadow root:', {
            key: node.getKey(),
            type: node.getType(),
          });
        }
      });
      return startingNode;
    }

    for (let i = 0; i < newNodes.length; i++) {
      const newNode = newNodes[i];
      const currentNode = currentNodes[currentIndex];

      if (!currentNode) {
        // Call onNodeCreated recursively for new nodes being inserted
        this.callOnNodeCreatedRecursively(newNode);
        lastInsertedNode.insertAfter(newNode);
        lastInsertedNode = newNode;
      } else {
        const updatedNode = this.updateNodeRecursively(currentNode, newNode);
        if (i === 0) {
          newStartingNode = updatedNode;
        }
        lastInsertedNode = updatedNode;
        currentIndex++;
      }
    }

    while (currentIndex < currentNodes.length) {
      const nodeToRemove = currentNodes[currentIndex];
      if (this.isVerbose) {
        console.log('Removing node:', {
          key: nodeToRemove.getKey(),
          type: nodeToRemove.getType(),
        });
      }
      nodeToRemove.remove();
      currentIndex++;
    }

    return newStartingNode;
  }

  private updateTextNode(currentNode: TextNode, newNode: TextNode) {
    let nodeModified = false;
    
    if (currentNode.getTextContent() !== newNode.getTextContent()) {
      currentNode.setTextContent(newNode.getTextContent());
      nodeModified = true;
    }
    if (currentNode.getFormat() !== newNode.getFormat()) {
      currentNode.setFormat(newNode.getFormat());
      nodeModified = true;
    }
    if (currentNode.getStyle() !== newNode.getStyle()) {
      currentNode.setStyle(newNode.getStyle());
      nodeModified = true;
    }
    
    // Only call onNodeCreated if the node was actually modified
    if (nodeModified) {
      this.onNodeCreated?.(currentNode);
    }
  }

  private updateElementNode(currentNode: ElementNode, newNode: ElementNode) {
    const currentChildren = currentNode.getChildren();
    const newChildren = newNode.getChildren();

    let currentChildIndex = 0;
    for (let i = 0; i < newChildren.length; i++) {
      const newChild = newChildren[i];
      const currentChild = currentChildren[currentChildIndex];

      if (!currentChild) {
        // When appending new children, we need to call onNodeCreated recursively
        // to ensure all new nodes (including deeply nested ones like table cells) 
        // get marked with diff state
        this.callOnNodeCreatedRecursively(newChild);
        currentNode.append(newChild);
      } else {
        this.updateNodeRecursively(currentChild, newChild);
        currentChildIndex++;
      }
    }

    while (currentChildIndex < currentChildren.length) {
      currentChildren[currentChildIndex].remove();
      currentChildIndex++;
    }
  }

  private callOnNodeCreatedRecursively(node: LexicalNode) {
    // Call onNodeCreated for this node
    this.onNodeCreated?.(node);
    
    // If it's an element node, recursively call for all children
    if ($isElementNode(node)) {
      const children = node.getChildren();
      for (const child of children) {
        this.callOnNodeCreatedRecursively(child);
      }
    }
  }

  insertNodes(nodes: LexicalNode[]) {
    const workingNode = this.workingNodeKey
      ? $getNodeByKey(this.workingNodeKey)
      : null;

    if (!workingNode || nodes.length === 0) {
      return;
    }

    // Insert the custom nodes RIGHT BEFORE the nextNodeKey boundary
    // This ensures they go after all streamed content but before untouchable content
    const nextBoundaryNode = this.nextNodeKey
      ? $getNodeByKey(this.nextNodeKey)
      : null;

    let lastInsertedNode = workingNode;
    nodes.forEach((node) => {
      // Call onNodeCreated recursively for custom inserted nodes and all their descendants
      this.callOnNodeCreatedRecursively(node);
      if (nextBoundaryNode) {
        // Insert before the boundary node (e.g., "Section Two")
        nextBoundaryNode.insertBefore(node);
      } else {
        // No boundary, insert after current working node
        lastInsertedNode.insertAfter(node);
      }
      lastInsertedNode = node;
    });

    // Reset the processor state to continue streaming after the inserted nodes:
    // CRITICAL: nextNodeKey should NEVER be changed - it's the immutable boundary!
    // Only reset the starting/working positions to continue streaming before the boundary

    if (this.nextNodeKey) {
      // Create a placeholder paragraph to stream into, positioned just before the boundary
      const boundaryNode = $getNodeByKey(this.nextNodeKey);
      const placeholderParagraph = $createParagraphNode();
      if (boundaryNode) {
        boundaryNode.insertBefore(placeholderParagraph);
      } else {
        lastInsertedNode.insertAfter(placeholderParagraph);
      }
      this.startingNodeKey = placeholderParagraph.getKey();
      this.workingNodeKey = placeholderParagraph.getKey();
      // NOTE: this.nextNodeKey is NEVER changed - it remains the original boundary!
    } else {
      // No boundary exists, can stream to end of document
      const placeholderParagraph = $createParagraphNode();
      lastInsertedNode.insertAfter(placeholderParagraph);
      this.startingNodeKey = placeholderParagraph.getKey();
      this.workingNodeKey = placeholderParagraph.getKey();
      // NOTE: this.nextNodeKey remains null since there was no boundary
    }

    // 3. Reset accumulated markdown to empty since we're starting fresh after the custom nodes
    this.currentRootChildMarkdown = '';
    this.previousText = '';

    if (this.isVerbose) {
      console.log(
        'insertNodes: Reset processor state after custom node insertion',
        {
          insertedNodeCount: nodes.length,
          newStartingNodeKey: this.startingNodeKey,
          newWorkingNodeKey: this.workingNodeKey,
          originalWorkingNodeKey: workingNode.getKey(),
          preservedNextNodeKey: this.nextNodeKey,
          previousTextBeforeReset: this.previousText.substring(0, 200) + '...',
        },
      );
    }
  }

  appendNodes(nodes: LexicalNode[]) {
    const workingNode = this.workingNodeKey
      ? $getNodeByKey(this.workingNodeKey)
      : null;
    if (!workingNode) {
      return;
    }

    nodes.forEach((node) => {
      workingNode.insertAfter(node);
    });
  }
}
