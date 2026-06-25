# Custom Tool Widgets

The AI transcript view supports custom widgets for specific MCP tools, replacing the generic tool call display with specialized UI components.

## Overview

- **Location**: `packages/runtime/src/ui/AgentTranscript/components/CustomToolWidgets/`
- **Registry**: `CustomToolWidgets/index.ts` - Maps tool names to widget components
- **Integration**: `RichTranscriptView.tsx` checks the registry before rendering generic tool UI

## How to Add a Custom Tool Widget

1. **Create the widget component** in `CustomToolWidgets/` folder:
```typescript
// MyToolWidget.tsx
import React from 'react';
import type { CustomToolWidgetProps } from './index';

export const MyToolWidget: React.FC<CustomToolWidgetProps> = ({
  message,
  isExpanded,
  onToggle,
  workspacePath
}) => {
  const tool = message.toolCall!;
  // Access tool data: tool.name, tool.arguments, tool.result
  return <div>Your custom UI here</div>;
};
```

2. **Create CSS file** for the widget (e.g., `MyToolWidget.css`):
   - Use CSS variables from `PlaygroundEditorTheme.css` for theming
   - Follow existing patterns in `EditorScreenshotWidget.tsx`

3. **Register the widget** in `CustomToolWidgets/index.ts`:
```typescript
import { MyToolWidget } from './MyToolWidget';

export const CUSTOM_TOOL_WIDGETS: CustomToolWidgetRegistry = {
  // Register both base name and MCP-prefixed variants
  'my_tool_name': MyToolWidget,
  'mcp__nimbalyst__my_tool_name': MyToolWidget,
};
```

4. **Export the widget** from `CustomToolWidgets/index.ts`

## Widget Props Interface

```typescript
interface CustomToolWidgetProps {
  message: Message;      // Full message object with toolCall
  isExpanded: boolean;   // For collapsible widgets
  onToggle: () => void;  // Toggle expand/collapse
  workspacePath?: string; // For resolving relative paths
}
```

## Existing Custom Widgets

### EditorScreenshotWidget

Displays captured editor screenshots with a large inline preview and lightbox modal. Works for all editor types (mockups, Excalidraw, code, markdown, CSV, etc.).

- **Tool name**: `capture_editor_screenshot`
- **Shows**: Large inline image, file name, success/error status
- **Features**: Click-to-enlarge lightbox

## Key Files

- `CustomToolWidgets/index.ts` - Registry and helper functions
- `CustomToolWidgets/EditorScreenshotWidget.tsx` - Example widget implementation
- `RichTranscriptView.tsx` - Integration point in renderToolCard

## MCP Tool Name Handling

MCP tools often have prefixed names (e.g., `mcp__nimbalyst__capture_editor_screenshot`). The `getCustomToolWidget()` function handles this automatically by:

1. First checking for an exact match
2. Then stripping `mcp__nimbalyst__` prefix and checking again
3. Then stripping any `mcp__*__` prefix pattern and checking again

This means you only need to register the base tool name, though registering both variants is recommended for clarity.
