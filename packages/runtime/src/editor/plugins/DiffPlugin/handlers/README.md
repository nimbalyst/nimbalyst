# Pluggable Diff Handler System

This directory contains the new pluggable diff handler system for Lexical diff operations. The system allows different node types to have specialized diff handling logic while maintaining proper structural constraints.

## Architecture

The system consists of:

1. **DiffNodeHandler Interface** - Base interface for all handlers
2. **DiffHandlerRegistry** - Central registry for managing handlers
3. **Specialized Handlers** - Node-type specific implementations
4. **Default Handler** - Fallback for basic node types

## Key Benefits

### 🎯 **Proper Structure Handling**
- **ListNode → ListItemNode → Content** relationships are enforced
- No more orphaned ListItemNodes in the root
- Automatic parent creation when needed

### 🔧 **Extensible Design**
- Easy to add new node type handlers
- Clean separation of concerns
- Pluggable architecture

### 🚀 **Better Maintainability**
- Each node type has its own focused handler
- Easier to debug and test specific node behaviors
- Reduced complexity in the main diff algorithm

## Usage

### Basic Usage

```typescript
import { diffHandlerRegistry, ListDiffHandler, DefaultDiffHandler } from './handlers';

// Register handlers
diffHandlerRegistry.register(new ListDiffHandler());
diffHandlerRegistry.register(new DefaultDiffHandler());

// Use in diff operations
const handler = diffHandlerRegistry.findHandler(context);
if (handler) {
  const result = handler.handleUpdate(context);
  // Process result...
}
```

### Creating Custom Handlers

```typescript
import { DiffNodeHandler, DiffHandlerContext, DiffHandlerResult } from './DiffNodeHandler';

export class CustomNodeHandler implements DiffNodeHandler {
  readonly nodeType = 'custom';

  canHandle(context: DiffHandlerContext): boolean {
    return context.liveNode.getType() === 'custom';
  }

  handleUpdate(context: DiffHandlerContext): DiffHandlerResult {
    // Custom update logic
    return { handled: true };
  }

  handleAdd(targetNode, parentNode, position, validator): DiffHandlerResult {
    // Custom add logic
    return { handled: true };
  }

  handleRemove(liveNode, validator): DiffHandlerResult {
    // Custom remove logic
    return { handled: true };
  }
}

// Register the custom handler
diffHandlerRegistry.register(new CustomNodeHandler());
```

## Available Handlers

### ListDiffHandler
- **Handles**: `list` and `listitem` nodes
- **Features**:
  - Ensures ListItemNodes are always inside ListNodes
  - Creates parent ListNodes when needed
  - Proper word-level diffing for list item content
  - Maintains list structure during all operations

### DefaultDiffHandler
- **Handles**: All other node types (fallback)
- **Features**:
  - Text node word-level diffing
  - Element node structure handling
  - Formatting change detection
  - Generic add/remove operations

## Handler Interface

```typescript
interface DiffNodeHandler {
  readonly nodeType: string;
  
  canHandle(context: DiffHandlerContext): boolean;
  handleUpdate(context: DiffHandlerContext): DiffHandlerResult;
  handleAdd(targetNode, parentNode, position, validator): DiffHandlerResult;
  handleRemove(liveNode, validator): DiffHandlerResult;
}
```

## Context and Results

### DiffHandlerContext
```typescript
type DiffHandlerContext = {
  liveNode: LexicalNode;
  sourceNode: SerializedLexicalNode;
  targetNode: SerializedLexicalNode;
  validator: NodeStructureValidator;
  changeType: 'update' | 'add' | 'remove';
};
```

### DiffHandlerResult
```typescript
type DiffHandlerResult = {
  handled: boolean;
  skipChildren?: boolean;
  error?: string;
};
```

## List Handler Example

The ListDiffHandler demonstrates proper structural handling:

```typescript
// Adding a new list item
if (targetNode.type === 'listitem') {
  // Ensure parent is a list node
  let listParent = parentNode;
  
  if (parentNode.getType() !== 'list') {
    // Create a new list if needed
    const newList = $createListNode('bullet');
    parentNode.append(newList);
    listParent = newList;
  }
  
  // Create the list item with proper content
  const newListItem = $createListItemNode();
  const itemText = getNodeContent(targetNode);
  
  if (itemText) {
    newListItem.append($createAddNode(itemText));
  }
  
  listParent.append(newListItem);
  return { handled: true };
}
```

## Integration with Main Diff System

The handlers integrate with the main diff system in `diffUtils.ts`:

1. **Handler Registration** - Handlers are registered at startup
2. **Handler Selection** - The registry finds the appropriate handler for each operation
3. **Fallback Support** - If a specialized handler fails, the system can fall back to default behavior
4. **Structure Validation** - All handlers work with the NodeStructureValidator

## Future Extensions

The system is designed to be easily extensible for:

- **Table Handlers** - Specialized handling for table structures
- **Link Handlers** - Custom logic for link updates
- **Image Handlers** - Media-specific diff operations
- **Custom Node Types** - Any application-specific nodes

## Testing

Each handler should be tested independently:

```typescript
describe('ListDiffHandler', () => {
  test('should handle list item addition', () => {
    const handler = new ListDiffHandler();
    const result = handler.handleAdd(targetListItem, parentNode, 0, validator);
    expect(result.handled).toBe(true);
  });
});
```

This pluggable system solves the structural constraint issues while providing a clean, maintainable architecture for future development. 