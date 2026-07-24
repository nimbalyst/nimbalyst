/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {ElementNode, LexicalEditor, LexicalNode} from 'lexical';

import {$createListNode, $isListItemNode} from '@lexical/list';
import {$getRoot, $isElementNode} from 'lexical';

/**
 * Special rules for nodes that have parent/child restrictions
 */
type SpecialNodeRule = {
  // If defined, this node must have a parent of this type
  requiredParent?: string;
  // If defined, this node can only contain these child types
  allowedChildren?: string[];
  // If true, this is a shadow root (like table cells)
  isShadowRoot?: boolean;
};

/**
 * Interface for node validation errors
 */
type ValidationError = {
  node: LexicalNode;
  message: string;
};

/**
 * NodeStructureValidator
 *
 * A simple validator for Lexical node structures that focuses only on
 * enforcing special case rules rather than defining all possible relationships.
 */
export class NodeStructureValidator {
  // Registry of special case rules
  private specialRules: Map<string, SpecialNodeRule> = new Map();

  constructor() {
    // Initialize with core Lexical node restrictions
    this.initializeCoreRules();
  }

  /**
   * Initialize core Lexical node restriction rules
   */
  private initializeCoreRules(): void {
    // List structure rules - these are actually important for proper DOM structure
    this.registerRule('listitem', {
      requiredParent: 'list',
      // Note: List items can contain paragraphs, text, other lists, etc. - don't restrict
    });
    this.registerRule('list', {
      allowedChildren: ['listitem'], // Lists should only contain list items
    });

    // Table structure rules - these are critical for proper table rendering
    this.registerRule('tablerow', {
      allowedChildren: ['tablecell'],
      requiredParent: 'table',
    });
    this.registerRule('tablecell', {
      isShadowRoot: true,
      requiredParent: 'tablerow',
      // Note: Table cells can contain any block content - don't restrict
    });
    this.registerRule('table', {
      allowedChildren: ['tablerow'], // Tables should only contain rows
    });

    // Remove restrictive rules for flexible containers
    // Paragraphs, headings, etc. should be able to contain any inline content:
    // - text nodes
    // - links
    // - inline code
    // - emphasis/strong
    // - add/remove nodes (for diff functionality)
    // - etc.

    // If we need to add rules for other strict hierarchies in the future, add them here.
    // Examples might include:
    // - Quote blocks that can only contain certain content
    // - Code blocks that should only contain text
    // But for now, keep it minimal and only enforce what's actually required.
  }

  /**
   * Register a special rule for a node type
   */
  public registerRule(nodeType: string, rule: SpecialNodeRule): void {
    this.specialRules.set(nodeType, rule);
  }

  /**
   * Get special rule for a node type if it exists
   */
  public getRule(nodeType: string): SpecialNodeRule | undefined {
    return this.specialRules.get(nodeType);
  }

  /**
   * Get all registered rules
   */
  public getAllRules(): Map<string, SpecialNodeRule> {
    return this.specialRules;
  }

  /**
   * Validate an entire editor for structural correctness
   */
  public validateEditor(editor: LexicalEditor): ValidationError[] {
    const errors: ValidationError[] = [];

    editor.getEditorState().read(() => {
      const rootNode = $getRoot();
      this.validateNodeRecursively(rootNode, null, errors);
    });

    return errors;
  }

  /**
   * Validate a single node and its children recursively
   */
  private validateNodeRecursively(
    node: LexicalNode,
    parent: LexicalNode | null,
    errors: ValidationError[],
  ): void {
    // Check node's relationship with its parent
    this.validateParentChildRelationship(node, parent, errors);

    // If node is an element, validate its children
    if ('getChildren' in node) {
      const children = (node as ElementNode).getChildren();

      // Validate each child
      for (const child of children) {
        this.validateNodeRecursively(child, node, errors);
      }

      // Validate children against node's allowed children rule
      this.validateChildrenTypes(node as ElementNode, children, errors);
    }
  }

  /**
   * Validate parent-child relationship
   */
  private validateParentChildRelationship(
    node: LexicalNode,
    parent: LexicalNode | null,
    errors: ValidationError[],
  ): void {
    const nodeType = node.getType();
    const rule = this.getRule(nodeType);

    // If this node has a required parent rule, check it
    if (rule && rule.requiredParent) {
      // Node must have a parent
      if (!parent) {
        errors.push({
          message: `${nodeType} must have a parent of type ${rule.requiredParent}, but has no parent`,
          node,
        });
        return;
      }

      // Parent must be of the required type
      const parentType = parent.getType();
      if (parentType !== rule.requiredParent) {
        errors.push({
          message: `${nodeType} must have a parent of type ${rule.requiredParent}, but has parent of type ${parentType}`,
          node,
        });
      }
    }
  }

  /**
   * Validate children types against parent's allowed children
   */
  private validateChildrenTypes(
    node: ElementNode,
    children: Array<LexicalNode>,
    errors: ValidationError[],
  ): void {
    const nodeType = node.getType();
    const rule = this.getRule(nodeType);

    // If this node has allowed children restrictions, check them
    if (rule && rule.allowedChildren && rule.allowedChildren.length > 0) {
      for (const child of children) {
        const childType = child.getType();
        if (!rule.allowedChildren.includes(childType)) {
          errors.push({
            message: `${nodeType} can only contain ${rule.allowedChildren.join(
              ', ',
            )}, but contains ${childType}`,
            node: child,
          });
        }
      }
    }
  }

  /**
   * Get allowed children for a node type
   * Returns an array of node types that are allowed as children, or an empty array if no restrictions
   */
  public getAllowedChildren(nodeType: string): string[] {
    const rule = this.getRule(nodeType);
    if (rule && rule.allowedChildren) {
      return rule.allowedChildren;
    } else {
      // If there's no rule, the allowed children would be any node that doesn't have a required parent
      return Array.from(this.specialRules.keys()).filter((type) => {
        const typeRule = this.specialRules.get(type);
        return !typeRule || !typeRule.requiredParent;
      });
    }
  }

  /**
   * Fix common structural issues
   * Returns true if changes were made
   */
  public fixStructure(editor: LexicalEditor): boolean {
    let changesApplied = false;

    editor.update(
      () => {
        // Fix ListItemNodes not inside a ListNode
        changesApplied = this.fixListItemStructure() || changesApplied;
      },
      {
        discrete: true,
      },
    );

    return changesApplied;
  }

  /**
   * Fix ListItemNodes that aren't properly inside a ListNode
   * Returns true if any changes were made
   */
  public fixListItemStructure(): boolean {
    let changesApplied = false;
    const rootNode = $getRoot();
    const orphanedListItems: Map<ElementNode, Array<LexicalNode>> = new Map();

    // First pass: find all direct ListItem children of non-List nodes
    this.findOrphanedListItems(rootNode, orphanedListItems);

    // Second pass: fix orphaned list items
    orphanedListItems.forEach((listItems, parent) => {
      if (listItems.length > 0) {
        // Create a new ListNode
        const listNode = $createListNode('bullet');

        // Move all ListItems into the ListNode
        for (const listItem of listItems) {
          listNode.append(listItem);
        }

        // Insert the ListNode where the first ListItem was
        parent.append(listNode);

        changesApplied = true;
      }
    });

    return changesApplied;
  }

  /**
   * Recursively find ListItemNodes that aren't inside a ListNode
   */
  private findOrphanedListItems(
    node: LexicalNode,
    orphanedListItems: Map<ElementNode, Array<LexicalNode>>,
  ): void {
    if (!$isElementNode(node)) {
      return;
    }

    const children = node.getChildren();
    const directOrphanedListItems: Array<LexicalNode> = [];

    for (const child of children) {
      if ($isListItemNode(child)) {
        // We found a direct ListItem child of a non-List node
        if (node.getType() !== 'list') {
          directOrphanedListItems.push(child);
        }
      } else if ($isElementNode(child)) {
        // Recursively check child's children
        this.findOrphanedListItems(child, orphanedListItems);
      }
    }

    // If we found orphaned list items, record them
    if (directOrphanedListItems.length > 0) {
      orphanedListItems.set(node, directOrphanedListItems);
    }
  }
}
