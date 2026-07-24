# Lexical Diff

A package for creating, visualizing, and managing differences in [Lexical](https://lexical.dev/) documents.

## Overview

The `lexical-diff` package provides tools and components for:

- Applying diffs between two Lexical documents
- Visualizing added, removed, and changed content with DiffState metadata
- Accepting and rejecting changes
- Converting markdown diffs to Lexical nodes

## Installation

Install via npm:

```bash
npm install @lexical/diff
```

## Basic Usage

To use diff functionality, you'll need to:

1. Add the DiffPlugin to your editor
2. Use the diff components and hooks to display and manage changes

```jsx
import { DiffPlugin, useDiffCommands, DiffControls } from '@lexical/diff';

// 1. Configure your editor (no special nodes needed - uses DiffState metadata)
const editorConfig = {
  namespace: 'MyEditor',
  theme: {},
  onError: (error) => console.error(error),
  nodes: [
    // your regular nodes...
  ]
};

// 2. Add the DiffPlugin to your editor
function MyEditor() {
  return (
    <LexicalComposer initialConfig={editorConfig}>
      <RichTextPlugin
        contentEditable={<ContentEditable />}
        placeholder={<Placeholder />}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <DiffPlugin />
      
      {/* 3. Add UI controls for managing diffs */}
      <MyDiffControls />
    </LexicalComposer>
  );
}

// Add your own controls or use the built-in components
function MyDiffControls() {
  const { applyDiff, approveDiffs, rejectDiffs, hasDiffs } = useDiffCommands();
  
  return (
    <div>
      {/* Built-in component with approve/reject buttons */}
      <DiffControls 
        approveButtonLabel="Accept All Changes"
        rejectButtonLabel="Reject All Changes"
        onApprove={() => console.log('Changes approved')}
        onReject={() => console.log('Changes rejected')}
      />
      
      {/* Or use the individual components */}
      <div>
        <ApproveButton />
        <RejectButton />
      </div>
      
      {/* Or build your own custom UI */}
      <div>
        <button onClick={() => approveDiffs()}>
          Accept All
        </button>
        <button onClick={() => rejectDiffs()}>
          Reject All
        </button>
        
        {/* Apply a specific diff */}
        <button onClick={() => 
          applyDiff({ 
            type: 'add', 
            newText: 'New content'
          })
        }>
          Insert Content
        </button>
      </div>
    </div>
  );
}
```

## API Reference

### DiffState System

The package uses a DiffState metadata system to track changes on regular Lexical nodes:

- **DiffState Types**: `'added'`, `'removed'`, `'modified'`
- **Functions**: `$setDiffState(node, state)`, `$getDiffState(node)`, `$clearDiffState(node)`

This approach is cleaner and more efficient than using special node types.

### Hooks and Components

#### `useDiffCommands()`

A React hook that provides methods for managing diffs:

```jsx
const { 
  applyDiff,      // Apply a specific diff at cursor
  approveDiffs,   // Accept all diffs in the document
  rejectDiffs,    // Reject all diffs in the document
  hasDiffs        // Check if the document has any diffs
} = useDiffCommands();
```

#### `<DiffPlugin />`

The plugin that registers the diff commands with the editor.

#### `<DiffControls />`

A pre-styled component that displays approve and reject buttons:

```jsx
<DiffControls
  // Optional custom labels
  approveButtonLabel="Accept Changes"
  rejectButtonLabel="Reject Changes"
  
  // Optional styling
  className="my-controls-container"
  approveButtonClassName="my-approve-button"
  rejectButtonClassName="my-reject-button"
  
  // Optional behavior
  hideWhenNoDiffs={true}
  
  // Optional callbacks
  onApprove={() => {}}
  onReject={() => {}}
/>
```

#### `<ApproveButton />` and `<RejectButton />`

Individual buttons for approving or rejecting diffs:

```jsx
<ApproveButton 
  label="Accept Changes"
  className="my-button-class"
  onApprove={() => {}}
  hideWhenNoDiffs={true}
/>

<RejectButton
  label="Reject Changes"
  className="my-button-class"
  onReject={() => {}}
  hideWhenNoDiffs={true}
/>
```

### Commands

The package provides several Lexical commands:

- `APPLY_DIFF_COMMAND` - Apply a specific diff at the current selection
- `APPROVE_DIFF_COMMAND` - Accept all diffs in the document
- `REJECT_DIFF_COMMAND` - Reject all diffs in the document

Example of dispatching commands directly:

```js
editor.dispatchCommand(APPROVE_DIFF_COMMAND, undefined);
```

### Markdown Diff Functions

For working with markdown-based diffs:

- `applyMarkdownDiff(editor, unifiedDiff, transformers)` - Apply a unified diff format to convert markdown with proper node structure
- `diffMarkdown(originalMd, newMd)` - Generate markdown diff chunks
- `applyMarkdownDiffToDocument(editor, originalMd, newMd, transformers)` - Apply the differences between two markdown documents

## Styling Diff Nodes

You can customize the appearance of nodes with diff states by providing theme classes in your editor config:

```jsx
const theme = {
  diffAdded: 'my-add-class',      // Style for nodes with 'added' DiffState
  diffRemoved: 'my-remove-class', // Style for nodes with 'removed' DiffState
  diffModified: 'my-change-class', // Style for nodes with 'modified' DiffState
};

const editorConfig = {
  theme,
  // ...
};
```

Default styling (via CSS):

```css
.my-add-class {
  background-color: #e6f4ea;
  color: #137333;
}

.my-remove-class {
  background-color: #fce8e6;
  color: #c5221f;
  text-decoration: line-through;
}

.my-change-class {
  background-color: #fef7e0;
  color: #b06000;
}
```

## Advanced Usage

### Working with Markdown Diffs

You can apply standard unified diff format to convert between markdown representations:

```jsx
import { applyMarkdownDiff } from '@lexical/diff';
import { TRANSFORMERS } from '@lexical/markdown';

// Apply a unified diff to the editor 
const unifiedDiff = `--- a/doc.md
+++ b/doc.md
@@ -1,3 +1,4 @@
 # Document Title
-This is the original text.
+This is the modified text.
+A new line was added.
 This line remains unchanged.`;

applyMarkdownDiff(editor, unifiedDiff, TRANSFORMERS);
```

### Creating a Custom Diff UI

You can create your own UI for managing diffs:

```jsx
import { $getDiffState } from '@lexical/diff';

function CustomDiffUI() {
  const [editor] = useLexicalComposerContext();
  const { hasDiffs, approveDiffs, rejectDiffs } = useDiffCommands();
  const [diffCount, setDiffCount] = useState(0);
  
  // Count the diffs in the document
  useEffect(() => {
    let count = 0;
    
    editor.getEditorState().read(() => {
      const nodes = editor.getEditorState()._nodeMap;
      for (const [, node] of nodes) {
        const diffState = $getDiffState(node);
        if (diffState === 'added' || diffState === 'removed' || diffState === 'modified') {
          count++;
        }
      }
    });
    
    setDiffCount(count);
  }, [editor]);
  
  if (diffCount === 0) {
    return null;
  }
  
  return (
    <div className="diff-manager">
      <div className="diff-counter">
        {diffCount} changes found
      </div>
      <div className="diff-actions">
        <button onClick={approveDiffs}>Accept All ({diffCount})</button>
        <button onClick={rejectDiffs}>Reject All ({diffCount})</button>
      </div>
    </div>
  );
}
```

### Working with DiffState Programmatically

You can directly work with the DiffState system:

```jsx
import { $setDiffState, $getDiffState, $clearDiffState } from '@lexical/diff';

// Mark a node as added
editor.update(() => {
  const textNode = $createTextNode('New content');
  $setDiffState(textNode, 'added');
  // ... insert the node
});

// Check if a node has diff state
editor.getEditorState().read(() => {
  const diffState = $getDiffState(someNode);
  if (diffState === 'removed') {
    // This node is marked for removal
  }
});

// Clear diff state from a node
editor.update(() => {
  $clearDiffState(someNode);
});
```

## Structure Handling

The diff system ensures proper node structure during diff application, particularly for list items which must be children of list nodes. This maintains Lexical's structural integrity requirements.

Special handling is provided for:
- ListItemNodes containing nodes with 'removed' DiffState: When approving diffs, the system will remove both the content and its parent ListItemNode if empty
- ListItemNodes containing nodes with 'added' DiffState: When rejecting diffs, the system will remove both the content and its parent ListItemNode if it becomes empty

This ensures a clean list structure after both approving and rejecting changes.

## Enhanced Markdown Diffing

The lexical-diff package includes an enhanced diffing implementation that preserves document structure when applying markdown diffs. 

### Key Features:

- **Paragraph Structure Preservation**: Ensures paragraphs maintain their original positions in the document
- **List Structure Preservation**: Properly handles list items and structures 
- **Proper Diff Markers**: Clearly shows additions and removals with DiffState metadata
- **Structure-Aware Diffing**: Uses a two-pass algorithm that considers both content and structure

### Usage:

Import and use the improved diffing implementation:

```js
import {applyMarkdownDiff} from '@lexical/diff';

// Get the original markdown
const originalMarkdown = editor.read(() => {
  return $convertToMarkdownString(transformers);
});

// Parse the unified diff and apply to the editor
applyMarkdownDiff(editor, unifiedDiff, transformers);
```

This implementation addresses key issues with the standard diffing algorithm:

1. Prevents paragraphs from incorrectly moving to the end of the document
2. Ensures list items stay properly contained in their parent lists
3. Preserves the overall document structure while still showing accurate diff markers using DiffState

You can find a full example in `packages/lexical-diff/examples/lorem-ipsum-diff.js`.

## API

### `applyMarkdownDiff(editor, markdownDiff, transformers)`

Applies a unified diff string to a Lexical editor.

**Parameters:**
- `editor`: LexicalEditor - The editor to apply the diff to
- `markdownDiff`: string - A unified diff string (with ---, +++, and @@ markers)
- `transformers`: Transformer[] - Array of markdown transformers

### `applyMarkdownReplace(editor, originalMarkdown, replacements, transformers)`

Applies a set of text replacements to a Lexical editor. This is an alternative to `applyMarkdownDiff` that takes direct text replacements instead of unified diff strings.

**Parameters:**
- `editor`: LexicalEditor - The editor to apply the replacements to
- `originalMarkdown`: string - The original markdown text to apply replacements to
- `replacements`: TextReplacement[] - Array of text replacement objects
- `transformers`: Transformer[] - Array of markdown transformers

**TextReplacement type:**
```typescript
type TextReplacement = {
  oldText: string;
  newText: string;
};
```

**Example:**
```typescript
import { applyMarkdownReplace } from '@lexical/diff';
import { TRANSFORMERS } from '@lexical/markdown';

const originalMarkdown = "This is the original text.";
const replacements = [
  { oldText: 'old text', newText: 'new text' },
  { oldText: 'simple', newText: '**bold**' }
];

applyMarkdownReplace(editor, originalMarkdown, replacements, TRANSFORMERS);
```

This function will:
1. Apply all text replacements to get the target markdown
2. Use the existing diff infrastructure to create nodes with proper DiffState
3. Support approve/reject functionality just like unified diffs

### DiffState Functions

#### `$setDiffState(node, state)`

Sets the diff state on a node.

**Parameters:**
- `node`: LexicalNode - The node to set the state on
- `state`: 'added' | 'removed' | 'modified' - The diff state to set

#### `$getDiffState(node)`

Gets the diff state from a node.

**Parameters:**
- `node`: LexicalNode - The node to get the state from

**Returns:** 'added' | 'removed' | 'modified' | null

#### `$clearDiffState(node)`

Clears the diff state from a node.

**Parameters:**
- `node`: LexicalNode - The node to clear the state from

## License

MIT