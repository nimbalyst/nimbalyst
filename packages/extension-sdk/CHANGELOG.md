# Changelog

All notable changes to `@nimbalyst/extension-sdk` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The SDK is versioned independently of the Nimbalyst app. Each release declares its minimum compatible app version under the `nimbalyst.minAppVersion` field of `package.json`.

| SDK version | Minimum Nimbalyst app version |
| --- | --- |
| 0.2.1 | 0.58.5 |
| 0.2.0 | 0.58.5 |
| 0.1.5 | 0.58.5 |
| 0.1.0 | 0.58.5 |

## [Unreleased]

## [0.2.1]

### Added

- `ExtensionAITool.access` declares whether a tool uses filesystem, editor-read, or editor-write access; `readOnly` remains as a compatibility alias.
- `useCollaborativeEditor` accepts `{ codec, bind }` so an editor's pure collab codec is defined once and shared with the host's headless seeding; the previous `createBinding`/`initializeFromContent` config keeps working.
- `CollaborationContext.flushWithAck` (server-persisted flush) and optional `hasUndecodedContent`.

### Fixed

- The first-open seed no longer runs from empty initial content or when the transport skipped payloads it could not decode — both cases wrote a default document over the shared room's real content.

## [0.2.0]

Adds opt-in collaborative editing for custom editors. Backwards-compatible: extensions built against 0.2.0 continue to work on older Nimbalyst hosts -- the collaboration hook detects the absence of `host.collaboration` and reports `isCollaborative: false` so the editor falls back to local-only editing.

### Added

- `useCollaborativeEditor(host, options)` hook for wiring a custom editor to a shared Y.Doc through `host.collaboration`. Handles binding lifecycle, awareness, status, and the empty-doc seed path.
- `CollaborationContext` type on `EditorHost.collaboration` exposing the Y.Doc, awareness, doc id, local user info, and connection status.
- Manifest field `contributions.customEditors[].collaboration = { supported: boolean, awarenessFields?: string[] }` so extensions declare collab support and the awareness shape they publish.
- `yjs` and `y-protocols` declared as optional peer dependencies, externalized by the host so a single Y.Doc instance is shared with the rest of Nimbalyst (mismatched copies fragment the document).

### Notes

- Existing extensions need no changes; if `collaboration.supported` is absent the editor continues to be loaded as before.
- See `docs/COLLABORATION_GUIDE.md` for the binding pattern (Excalidraw and CSV are reference implementations).

## [0.1.5]

First release published via GitHub Actions Trusted Publishing (OIDC). No API changes from 0.1.0.

(0.1.1 through 0.1.4 were tagged but never reached the registry while we were diagnosing the publish workflow. Those tags have been retired.)

## [0.1.0] - Initial release

Initial public release of the Nimbalyst extension SDK.

### Added

- `EditorHost` and `EditorHostProps` contract for custom editor extensions
- `useEditorLifecycle` hook for editor load/save/dirty/theme handling
- `ExtensionAITool`, `AIToolContext`, `ExtensionToolResult` types for AI tool extensions
- `ExtensionContext`, `ExtensionManifest`, `ExtensionContributions` for the extension manifest schema
- `PanelContribution`, `PanelExport`, `PanelHost` for non-file-based panels
- `SettingsPanelContribution`, `SettingsPanelProps` for extension settings panels
- `ThemeContribution` and `ThemeColors` for custom theme extensions
- `createExtensionConfig` Vite helper at `@nimbalyst/extension-sdk/vite`
- `createManifestValidationPlugin` Vite plugin to validate build output against `manifest.json`
- `mergeExtensionConfig` for extending the base Vite config
- Tailwind preset at `@nimbalyst/extension-sdk/tailwind`
- Testing utilities at `@nimbalyst/extension-sdk/testing`
- `ROLLUP_EXTERNALS`, `REQUIRED_EXTERNALS`, `EXTERNAL_PATTERNS` constants for the externals system
- `MaterialSymbol` re-export, `createReadOnlyHost`, `clipboard`, and document-path utilities

### Notes

- Several legacy aliases (`CustomEditorProps`, `ToolContext`, `ToolResult`, `AIToolDefinition`, `FileIconContribution`, `LexicalNodeContribution`) are exported for migration but marked `@deprecated`. They will be removed in a future major version.
- Requires Vite 7+ and React 18 or 19 (declared as optional peer dependencies).
