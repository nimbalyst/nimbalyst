# Nimbalyst editor extensions

This directory is the source of truth for how the Nimbalyst editor is
composed. The editor is built with `LexicalExtensionComposer` from
`@lexical/react`; every plugin participating in the editor is a
`LexicalExtension` listed in the root extension's `dependencies` array.

## Files

| File | What it owns |
| --- | --- |
| `NimbalystEditorExtensions.ts` | Builds the root extension. Lists every built-in dependency the editor depends on. Adding a plugin means appending a new entry here. |
| `registerBuiltinExtensions.ts` | Side-effect module that imports every built-in extension so its module-level `setExtensionContributions(...)` call runs. Imported by `editor/index.ts` so callers who only touch markdown utilities still see the full transformer set. |
| `extensionContributionsStore.ts` | Per-source registry of `userCommands`, `markdownTransformers`, and dynamic component-picker option providers. Replaces the legacy `pluginRegistry` for the parts that aren't covered by `LexicalExtension.nodes` / `register` / `dependencies`. |
| `extensionLexicalExtensionsStore.ts` | Per-source registry of `LexicalExtension` instances contributed by the renderer extension bridge or by app-level plugins (tracker, mockup, document-link). `NimbalystEditor` reads the merged snapshot and rebuilds the editor when the snapshot reference changes. |
| `extensionEditorComponentsStore.ts` | Per-source registry of React components that need to mount inside `LexicalExtensionComposer` (typeahead menus, dialog hosts, document-path-aware effect components). `Editor.tsx` iterates the store inside the rich-text branch. |
| `builtin/` | One file per built-in Lexical extension: image, page break, collapsible, layout, kanban board, mermaid, diff, table markdown, emoji markdown, plus the headless support extensions (`AutoLink`, `AssetGc`, `CollabAssetLink`, `DragDropPaste`, `MarkdownPaste`, `MarkdownCopy`, `TabFocus`). |

## How a built-in plugin is wired

A typical built-in extension does three things:

1. **Owns its node classes** via `defineExtension({ nodes: [...] })`. The
   Lexical builder topologically resolves them; nothing extra is needed
   for registration.
2. **Owns its commands and listeners** in `register(editor)`. Returning
   a cleanup function disposes them when the editor tears down.
3. **Publishes its markdown transformers and slash-picker entries** at
   module-load time:

   ```ts
   setExtensionContributions('@nimbalyst/editor/page-break', {
     markdownTransformers: [PAGE_BREAK_TRANSFORMER],
   });
   ```

The slash picker and the import/export pipeline read from the
contributions store, so the only place that needs to know about a new
plugin is the one file under `builtin/` plus a line in
`NimbalystEditorExtensions.ts`'s `dependencies` array.

## How a Nimbalyst extension contributes a Lexical plugin

Extensions loaded by the on-disk extension system declare
`contributions.lexicalExtensions: string[]` in their manifest and export
matching `LexicalExtension` instances from their `lexicalExtensions`
module export. The renderer-side bridge in
`packages/electron/src/renderer/extensions/ExtensionPluginBridge.ts`
collects those instances and publishes them through
`setExtensionLexicalExtensions(extensions, sourceName)`. Toggling an
extension on or off rebuilds the editor (per the Phase 7 decision; live
mutation of the extension graph isn't supported by Lexical).

The bridge also publishes the extension's `slashCommands`,
`transformers`, and `nodes` contributions via `setExtensionContributions`
and `setExtensionLexicalExtension` for legacy contribution shapes.

## How a renderer-side React plugin contributes UI

When a plugin genuinely needs to mount inside the editor's React tree
(typeahead menus, dialog state, host-context-aware effects), the
renderer publishes it via `registerExtensionEditorComponent`:

```ts
registerExtensionEditorComponent({
  name: 'document-link',
  Component: DocumentLinkPluginWrapper,
});
```

`Editor.tsx` reads the store via `useExtensionEditorComponents()` and
mounts every entry inside `FrontmatterProvider` / `AnchorProvider` so
the component has access to the editor's React context.

## Migration history

The pre-Phase-7 architecture used three parallel systems:
`PluginRegistry` for nodes/transformers/userCommands, `PluginManager`
for React mounts, and a `LexicalComposer` shell mounting most plugins
as React children. Phase 7.5 deleted all three. Every plugin is now a
`LexicalExtension`, every React UI surface goes through
`registerExtensionEditorComponent`, and the slash-picker reads from
the per-source contributions store.
