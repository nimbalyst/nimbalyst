# Changelog

All notable changes to `@nimbalyst/extension-sdk` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The SDK is versioned independently of the Nimbalyst app. Each release declares its minimum compatible app version under the `nimbalyst.minAppVersion` field of `package.json`.

| SDK version | Minimum Nimbalyst app version |
| --- | --- |
| 0.6.0 | 0.78.0 |
| 0.5.0 | 0.70.0 |
| 0.4.0 | 0.70.0 |
| 0.3.0 | 0.70.0 |
| 0.2.2 | 0.58.5 |
| 0.2.1 | 0.58.5 |
| 0.2.0 | 0.58.5 |
| 0.1.5 | 0.58.5 |
| 0.1.0 | 0.58.5 |

## [Unreleased]

## [0.6.0] - 2026-09-14

Requires Nimbalyst 0.78.0, available on the alpha channel at publication, for the complete host API including native screenshots.

### Added

- `CollaborationCommentsService`, `CommentAnchor`, and codec-level `commentAnchors` let collaborative editors mount the platform comment experience and resolve structured anchors both live and headlessly.
- `host.registerViewport()` and `EditorViewport` let an editor expose proportional scroll position to hosts that carry the reader's place between related documents; `createReadOnlyHost()` can receive those registrations.
- `contributions.customEditors[].collaboration.documentType` lets a host identify a collaborative document type from the manifest before its extension bundle and codec are loaded.
- `screenshotService` exposes host-provided element and file screenshots, including unopened documents.
- `PanelHost.getWorkspaceFolders()` and `getPrimaryFolderPath()` expose multiple workspace roots; file-tree helpers accept those roots.
- `EditorHost.getAssetUrl()` and the `assetUrls` capability let media editors stream local files through a host-provided URL.
- The `agents`, `types/editor`, and `git-operation-log` entry points expose agent contracts, editor types, and Git operation selectors.
- `ProtocolSession.appliedModel` and `deliveredMcpServerCount` report the model and MCP servers actually used by an agent.

### Changed

- `CollabCodec` documents file-form fallback for headless agent edits when no structured patch pair exists, while recommending structured edits for minimal concurrent deltas.

### Fixed

- Agent host declarations use a Node-compatible relative import for consumers using Node16 or NodeNext module resolution.

## [0.5.0]

Still runs on Nimbalyst 0.70.0: a host that declares no capabilities is treated as fully capable, so an extension written against this release keeps working on older desktop builds.

### Added

- `host.capabilities` plus `editorHostSupports()` and `editorHostCapabilityGap()` let one editor bundle run in hosts that cannot honour every part of `EditorHost` — check a capability before calling instead of discovering the gap at runtime.
- `AiAgentProviderContribution` declares `supportsSlashCommands`, `supportsSkills`, and `compaction` instead of having the app infer them; all three default to off, so an unclaimed affordance is hidden rather than offered and silently broken.
- `AgentProtocol.compactSession()` is the optional real compaction entry point for a transport that has one.

### Changed

- `host.filePath` is documented as an opaque document identifier — an absolute path on the desktop host, a synthetic URI on a host with no filesystem. Gate anything that touches disk on the `localFileSave` / `projectFileSystem` capabilities.

## [0.4.0]

### Added

- `applyTextDiff()` and `replaceYText()` reduce a whole-string replacement to one contiguous `Y.Text` edit, so a binding no longer has to hand-write the prefix/suffix diff.
- `@nimbalyst/extension-sdk/collab` is a React-free entry point for the collaborative-document helpers, for codecs and codec tests that have no React installed.
- `host.onFindRequested()` routes the app's Find command (Cmd+F) to a custom editor's own find UI.

## [0.3.0]

Requires Nimbalyst 0.70.0 for the new host-provided selection, filesystem, and visibility APIs.

### Added

- `host.setEditorContextItems()` and `EditorContextItem` let node-like editors (diagrams, CAD, electronics) push a list of selected items to the chat as individually removable context chips, instead of a single `setEditorContext` blob.
- `host.fs` (`EditorHostFileSystem`) reads files with SHA-256 version tokens and applies labeled, compare-and-swap grouped writes recorded in document history.
- `host.openExternal()` opens a reviewed HTTPS URL in the operating system's browser without navigating the renderer.
- `host.visible` and `host.onVisibilityChanged()` let editors pause render loops and release GPU resources while mounted but hidden.
- `ExtensionFileSystemService.writeFile()` accepts a `Uint8Array` so extensions can write binary files without corrupting their contents.

## [0.2.2]

### Added

- Host-provided tracker reference chips and pickers let extensions persist stable item keys while using Nimbalyst's live metadata and navigation.

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
