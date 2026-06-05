# Extensions

This directory holds built-in extensions and is the practical checklist for what "finished" means when we add a new extension.

Not every extension needs every surface. A panel-only extension does not need file sharing work. A file-based custom editor usually needs more than just a working `manifest.json` and React component.

Start with the core architecture docs:

- [docs/EXTENSION_ARCHITECTURE.md](../../docs/EXTENSION_ARCHITECTURE.md)
- [packages/extension-sdk-docs/custom-editors.md](../extension-sdk-docs/custom-editors.md)
- [packages/marketplace/README.md](../marketplace/README.md)

## Decide The Surface Area First

Before building, decide which kind of extension this is:

- File-based custom editor
- Read-only file viewer
- Panel/tool-only extension
- Host/transcript contribution
- Internal-only extension vs public marketplace extension

That decision determines which checklists below apply.

## Core Editor Checklist

If the extension owns a file type or custom editor:

- Register `contributions.customEditors` in the manifest.
- Use the `EditorHost` contract and prefer `useEditorLifecycle`.
- Respect `host.readOnly`, `host.theme`, save requests, and external file changes.
- Decide whether the editor is text or binary and use `loadContent()` vs `loadBinaryContent()` correctly.
- Decide whether the editor can be embedded or previewed with `createReadOnlyHost`.
- Avoid Electron-only assumptions inside the editor unless the extension is explicitly desktop-only.

Relevant docs:

- [docs/EXTENSION_ARCHITECTURE.md](../../docs/EXTENSION_ARCHITECTURE.md)
- [packages/extension-sdk-docs/custom-editors.md](../extension-sdk-docs/custom-editors.md)

## AI And Host Contributions

If the extension exposes AI tools or transcript/editor contributions:

- Register AI tools explicitly and keep permissions minimal.
- If the extension touches markdown/transcript rendering, register those contributions through the documented runtime surfaces.
- Decide whether the extension needs slash commands, nodes, transformers, picker options, or transcript markdown renderers.

Mobile caveat:

- Desktop loads extension host components fully.
- Mobile transcript/rendering code can understand shared runtime contributions, but mobile does not currently load desktop extensions or mount their host components, so extension-provided transcript contributions are effectively desktop-only unless we add a mobile-specific registration path.

Reference:

- [docs/EXTENSION_ARCHITECTURE.md](../../docs/EXTENSION_ARCHITECTURE.md#contributing-to-the-markdown-editor-and-transcript)

## Collaborative Docs: "Share To Team"

If the file type should work as a shared document, real-time collaborative doc, or shared history item:

- Add `collaboration` metadata on the custom editor contribution where applicable.
- Implement and register a `CollabContentAdapter`.
- Define `documentType`, file extensions, `seedFromFile`, `applyFromFile`, `exportToFile`, and `toPlainText`.
- Add structured edit support only if AI should be able to write to the shared doc safely.
- Add layout migrations when the Y.Doc shape changes.

Without a `CollabContentAdapter`, the document type is missing host-level shared-doc features such as:

- initial share
- re-upload from local source
- export/save-a-copy
- revision history
- search indexing
- AI editing on shared docs

Reference:

- [packages/extension-sdk-docs/custom-editors.md](../extension-sdk-docs/custom-editors.md#making-your-editor-collaborative)

## Browser Share Links: "Share Link"

`Share Link` is a separate surface from collaborative docs. If a local file should render in a browser share link, the extension needs web-viewer work in addition to the desktop editor.

Current requirements:

- Make the file type shareable in [packages/electron/src/renderer/hooks/useFileActions.ts](../electron/src/renderer/hooks/useFileActions.ts).
- Map the file extension to a viewer type in [packages/electron/src/main/ipc/ShareHandlers.ts](../electron/src/main/ipc/ShareHandlers.ts).
- Add the viewer type to the collab worker allowlist and viewer registry in `nimbalyst-collab/packages/collabv3/src/share.ts`.
- Add the extension bundle to `nimbalyst-collab/packages/collabv3/scripts/deploy-viewer-assets.sh`.
- Ensure the rendered component works in a plain browser `createReadOnlyHost` environment with no Electron APIs.

Important constraints:

- Share-link viewers run in a browser shell, not the Electron app.
- Desktop-only dependencies such as `window.electronAPI`, local filesystem access, or local dev-server assumptions will break there.
- Binary file types may need extra pipeline work beyond simple viewer registration.

Use `createReadOnlyHost` when building a dedicated read-only web viewer:

- [docs/EXTENSION_ARCHITECTURE.md](../../docs/EXTENSION_ARCHITECTURE.md#usage-embedded-read-only-panel)

## Mobile

Ask whether the extension is:

- desktop-only by design
- compatible with shared runtime/editor pieces
- worth a dedicated mobile registration path later

Current state:

- Mobile apps do not currently load desktop extensions directly.
- Shared runtime components can reduce future porting work.
- If mobile support matters, avoid tightly coupling the extension to Electron-only APIs and document what a mobile host would need.

This means "works on desktop" is not the same as "works on mobile."

## Marketplace And Release

If the extension is public:

- Fill out marketplace metadata in the manifest: categories, tags, icon, tagline, long description, highlights, file types.
- Add screenshot definitions in the manifest.
- Add real screenshot assets through the marketplace screenshot pipeline.
- Add the extension to [packages/marketplace/release-extensions.txt](../marketplace/release-extensions.txt) only when it is ready for public release.
- Regenerate marketplace packages and the registry through the curated release pipeline in [packages/marketplace/README.md](../marketplace/README.md).

If the extension is not public yet:

- Keep it out of `release-extensions.txt`.
- Do not assume marketplace/website metadata is done later by default.

## Website Metadata

If the extension is public, update the website content in the parallel `nimbalyst-website` repo:

- add or update the extension page in `src/content/extensions/`
- keep `extensionId` aligned with the real manifest ID
- keep screenshots, copy, and install metadata in sync with the marketplace entry

Marketplace release and website presence should be treated as one launch surface, not separate cleanup tasks.

## Validation

Before calling an extension done, verify the surfaces that apply:

- opens the intended file types
- saves and reloads correctly
- handles theme and read-only mode
- supports diff/source mode if declared
- supports shared docs if intended
- supports browser share links if intended
- has marketplace metadata and screenshots if public
- is excluded from the release allowlist if not public

When relevant, test the actual surface instead of assuming architecture implies support. "Custom editor works locally" does not prove collaborative docs, share links, mobile, or marketplace readiness.
