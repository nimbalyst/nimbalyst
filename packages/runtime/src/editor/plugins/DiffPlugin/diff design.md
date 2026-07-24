# Lexical Diff Design

## Overview

The lexical-diff package provides a way to display differences between two versions of a Lexical document. This is particularly challenging due to Lexical's strict node hierarchy requirements and the need to maintain valid editor state while showing additions and removals.

## Core Challenges

### 1. Lexical Node Structure Constraints

Lexical has specific rules about parent-child relationships. For example:
- `ListItemNode` must be a child of `ListNode`
- `TextNode` typically lives inside container nodes like `ParagraphNode` or `ListItemNode`
- `TableCellNode` must be inside `TableRowNode` which must be inside `TableNode`

This means we can't simply wrap any node with an "add" or "remove" marker.

### 2. Displaying Removals

To show a removed list item, we need this exact structure:
```
ListNode
  ListItemNode
    TextNode (original content)
  ListItemNode
    RemoveNode (showing removed content)
```

We can't mark the `ListItemNode` itself as removed - we must replace its text content with `RemoveNode`.

### 3. Custom Nodes

The system needs to handle custom nodes (images, embeds, etc.) that should show visual indicators (like red outlines) when removed, not just text-based diff markers.

## Design Approaches

### Approach 1: Add/Remove Nodes (Current Implementation)

Replace text content with special `AddNode` and `RemoveNode` nodes.

**Pros:**
- Works within Lexical's constraints
- Clear visual representation

**Cons:**
- Only works for text content
- Requires complex logic to maintain structure
- Doesn't handle custom nodes well

### Approach 2: MarkNode Pattern

Similar to Lexical's commenting system - wrap content in marker nodes.

**Pros:**
- Can wrap multiple nodes
- Preserves original structure

**Cons:**
- Very complex wrapping/unwrapping logic
- Still constrained by parent-child rules
- Heavy implementation burden

### Approach 3: NodeState with Reconciler Patch (Proposed)

Use Lexical's NodeState API to add diff state to any node, then patch the reconciler to add CSS classes.

```typescript
// Add state to any node
node.setDiffState({ 
  type: 'added' | 'removed' | 'modified',
  original?: string 
});

// Reconciler adds classes: lexical-diff-added, lexical-diff-removed
// CSS handles the visual representation
```

**Pros:**
- Works for ANY node type generically
- No structural changes needed
- Clean separation of concerns
- Custom nodes can have custom styling

**Cons:**
- Requires patching LexicalReconciler
- NodeState API is relatively new

## Recursive Diffing Strategy

### Two-Phase Application

1. **Phase 1: Root-Level Matching**
   - Use `TreeMatcher` to match root-level nodes
   - Identify which nodes are added, removed, or modified
   - Apply changes at root level

2. **Phase 2: Recursive Matching**
   - For matched container nodes (lists, tables, etc.)
   - Recursively apply TreeMatcher to their children
   - Continue until leaf nodes

### Example: List with Nested Changes

```markdown
Source:
- Item 1
- Item 2
  - Subitem A
  - Subitem B

Target:
- Item 1
- Item 2 modified
  - Subitem A
  - Subitem B modified
  - Subitem C (new)
```

Process:
1. Match root `ListNode` (similarity: ~0.7)
2. Recursively match list items
3. Match "Item 2" → "Item 2 modified"
4. Recursively match subitems
5. Apply changes at each level

## Handler System

To avoid if-statements everywhere, use a pluggable handler system:

```typescript
interface DiffHandler {
  canHandle(node: LexicalNode): boolean;
  applyAdd(node: SerializedLexicalNode, parent: ElementNode): void;
  applyRemove(node: LexicalNode): void;
  applyModify(source: LexicalNode, target: SerializedLexicalNode): void;
}

// Register handlers for different node types
diffHandlerRegistry.register(new ListDiffHandler());
diffHandlerRegistry.register(new TableDiffHandler());
diffHandlerRegistry.register(new CustomNodeDiffHandler());
```

## Implementation Recommendations

### Short Term (Using Add/Remove Nodes)
1. Implement recursive TreeMatcher application
2. Create handler system for different node types
3. Handle basic text content changes

### Long Term (Using NodeState)
1. Implement NodeState-based diff marking
2. Patch LexicalReconciler to add CSS classes
3. Create CSS framework for diff visualization
4. Support custom node styling

### CSS Example for NodeState Approach

```css
/* Text nodes */
.lexical-diff-added {
  background-color: #d1f5d3;
  text-decoration: underline;
}

.lexical-diff-removed {
  background-color: #ffdddd;
  text-decoration: line-through;
}

/* Custom nodes (images, embeds, etc.) */
.lexical-diff-removed[data-lexical-decorator="true"] {
  outline: 3px solid #ff0000;
  opacity: 0.7;
}

.lexical-diff-added[data-lexical-decorator="true"] {
  outline: 3px solid #00ff00;
}
```

## Next Steps

1. Evaluate NodeState API stability and feasibility
2. Prototype reconciler patch for adding classes
3. Design handler registry system
4. Implement recursive matching strategy
5. Create comprehensive test suite for complex structures

## Testing Considerations

- Nested lists with multiple levels
- Mixed content (lists containing different node types)
- Tables with complex cell content
- Custom nodes with decorators
- Position shifts at different nesting levels
- Structural changes (adding/removing nesting levels) 