# Markdown Transformer Architecture

## Overview

The markdown system in Nimbalyst is designed to support both core markdown functionality and plugin-specific extensions. The architecture separates transformers into two categories to prepare for future plugin-based configuration.

## Structure

### Core Transformers (`core-transformers.ts`)
These transformers are always included and handle standard markdown syntax:
- **Horizontal Rules** (`---`, `***`, `___`)
- **Headings** (via Lexical's ELEMENT_TRANSFORMERS)
- **Lists** (ordered and unordered)
- **Blockquotes**
- **Code blocks** and inline code
- **Text formatting** (bold, italic, strikethrough)
- **Links** (standard markdown links)
- **Check lists** (`- [ ]` and `- [x]`)

### Plugin Transformers
These transformers require specific plugins to be loaded:
- **TABLE_TRANSFORMER** - Markdown tables (requires TablePlugin)
- **IMAGE_TRANSFORMER** - Image syntax (requires ImagesPlugin)
- **EMOJI_TRANSFORMER** - `:emoji:` syntax (requires EmojisPlugin)
- **COLLAPSIBLE_TRANSFORMER** - Collapsible sections (requires CollapsiblePlugin)
- **ExcalidrawTransform** - Diagrams (requires ExcalidrawPlugin)

## Supported entry points

All Nimbalyst code converts between markdown and Lexical state through the
**Enhanced** wrappers; do not call `$convertFromMarkdownString` /
`$convertToMarkdownString` from `@lexical/markdown` directly. The wrappers
extract YAML frontmatter, normalize 2-/3-/4-space list indents to a consistent
target before import, encode literal `*`/`_` as HTML numeric character
references on export so upstream's CommonMark importer can re-import them
losslessly, and collapse upstream's TabNodes back to plain `\t` text so the
diff plugin's tree matcher does not have to know about TabNodes.

```ts
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  $convertNodeToEnhancedMarkdownString,
  $convertSelectionToEnhancedMarkdownString,
  getEditorTransformers,
} from '@nimbalyst/runtime/editor';

// Full-document import (frontmatter + normalization)
$convertFromEnhancedMarkdownString(content, getEditorTransformers());

// Full-document export (frontmatter, NCR encoding, diff-aware traversal)
$convertToEnhancedMarkdownString(getEditorTransformers(), {
  shouldPreserveNewLines: true,
});

// Single-node export (e.g. for diff matching, tracker cells)
$convertNodeToEnhancedMarkdownString(getEditorTransformers(), node, true);

// Selection export (e.g. clipboard / "send selection to AI")
$convertSelectionToEnhancedMarkdownString(getEditorTransformers(), selection, true);
```

The electron renderer enforces this with an eslint rule
(`no-restricted-imports` in `packages/electron/eslint.config.mjs`) that blocks
named imports of `$convertFromMarkdownString` and `$convertToMarkdownString`
from `@lexical/markdown`. Streaming AI imports go through
`MarkdownStreamProcessor` which is already a thin wrapper over the same entry
points.

For the deeper rationale (why the `&#42;` encoding is needed, what stays
forked, and what to re-audit on each upstream bump) see
[`FORKED_MARKDOWN_IMPORT.md`](./FORKED_MARKDOWN_IMPORT.md).

## Future Plugin-Based Architecture

In the future, transformers will be dynamically loaded based on configuration:

```typescript
// Example future usage
const config = {
  plugins: [TablePlugin, ImagesPlugin], // User-specified plugins
};

// Transformers would be collected from enabled plugins
const transformers = createTransformers(
  config.plugins.flatMap(p => p.transformers)
);
```

## Migration Path

The current architecture prepares for this transition by:

1. **Separating core from plugin transformers** - Core transformers are in `core-transformers.ts`
2. **Exposing both sets** - `CORE_TRANSFORMERS` and `PLUGIN_TRANSFORMERS` exports
3. **Providing `createTransformers` function** - Preview of future API
4. **Moving transformers to plugins** - Each plugin owns its transformer

## Adding New Transformers

### For Core Markdown Features
Add to `core-transformers.ts` if the feature is:
- Part of standard markdown spec
- Essential for basic editing
- Doesn't require a plugin

### For Plugin Features
1. Create transformer in the plugin directory: `plugins/[PluginName]/[Name]Transformer.ts`
2. Export from plugin's index file
3. Currently: Add to `PLUGIN_TRANSFORMERS` in `markdown/index.ts`
4. Future: Will be auto-registered by plugin system

## Transformer Order

Order matters! More specific transformers should come before general ones:
1. Plugin transformers (more specific)
2. Core transformers (general markdown)

This ensures plugin-specific syntax takes precedence over generic markdown patterns.
