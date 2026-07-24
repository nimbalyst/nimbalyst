# JSON Viewer Extension Example

A more complete custom editor example that demonstrates:

- Custom editor component with toolbar
- Expand/collapse tree view
- Inline editing of values
- AI tools for programmatic access
- Proper CSS theming

## Features

- **Tree View**: Expand and collapse JSON objects and arrays
- **Inline Editing**: Double-click values to edit them
- **Format/Minify**: Toolbar buttons for formatting
- **AI Tools**: Claude can read and modify JSON data

## Structure

```
custom-editor/
  manifest.json           # Extension metadata with AI tools
  package.json            # Dependencies
  tsconfig.json           # TypeScript config
  vite.config.ts          # Build config
  src/
    index.ts              # Entry point
    aiTools.ts            # AI tool definitions
    styles.css            # Editor styles
    components/
      JsonViewer.tsx      # Main editor component
```

## AI Tools

This extension provides three AI tools:

### json.get_structure
Returns the structure of the JSON showing types at each level.

### json.get_value
Gets a value at a specific path (e.g., `users.0.name`).

### json.set_value
Sets a value at a path. Returns `newContent` to update the file.

## Usage

1. Copy this folder to a new location
2. Run `npm install`
3. Ask Claude: "Build and install my extension from [path]"
4. Create a `.jsonview` file with JSON content
5. Try asking Claude: "What's the structure of this JSON?"

## Key Patterns

### Toolbar Component

```tsx
<div className="json-viewer-toolbar">
  <span className="json-viewer-title">JSON Viewer</span>
  <div className="json-viewer-actions">
    <button onClick={handleFormat}>Format</button>
  </div>
</div>
```

### Recursive Node Rendering

The `JsonNode` component renders itself recursively for nested structures,
tracking depth for indentation and managing expand/collapse state.

### Theme-Compatible CSS

Uses CSS variables like `var(--nim-bg)` that automatically adapt
to light, dark, and crystal-dark themes.

### AI Tool with File Updates

Tools that modify data write through the extension filesystem service:

```typescript
await context.extensionContext.services.filesystem.writeFile(
  context.activeFilePath!,
  JSON.stringify(data, null, 2)
);

return {
  success: true,
  message: 'Updated the JSON file',
};
```

## Customizing

To build your own editor from this example:

1. Replace JSON parsing with your file format
2. Adapt the tree structure for your data model
3. Update AI tools for your specific queries
4. Customize the toolbar for your actions
