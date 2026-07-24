# Extension SDK Release Review

Review date: 2026-03-07

Scope:
- `packages/extension-sdk`
- `packages/extension-sdk-docs`
- `packages/extensions/extension-dev-kit`
- runtime host contract in `packages/runtime`

Validation performed:
- `npm pack --dry-run` in `packages/extension-sdk`
- `npm exec vite build` in all three docs examples
- `npx tsc --noEmit` for the `custom-editor` and `ai-tool` examples

## Findings

### 1. High: the documented happy path does not work

The first-run experience for external developers is broken in multiple places:

- The getting started guide shows `createExtensionConfig({})` without the required `entry` option, even though the SDK helper destructures `entry` as required. See [packages/extension-sdk-docs/getting-started.md](./packages/extension-sdk-docs/getting-started.md#L59) and [packages/extension-sdk/src/vite.ts](./packages/extension-sdk/src/vite.ts#L97).
- All three shipped examples call `createExtensionConfig()` with no arguments. See [packages/extension-sdk-docs/examples/minimal/vite.config.ts](./packages/extension-sdk-docs/examples/minimal/vite.config.ts#L1), [packages/extension-sdk-docs/examples/custom-editor/vite.config.ts](./packages/extension-sdk-docs/examples/custom-editor/vite.config.ts#L1), and [packages/extension-sdk-docs/examples/ai-tool/vite.config.ts](./packages/extension-sdk-docs/examples/ai-tool/vite.config.ts#L1).
- Running `npm exec vite build` inside each example fails with `TypeError: Cannot destructure property 'entry' of 'options' as it is undefined`.
- The docs and examples still teach the removed `CustomEditorProps` / `content` / `onChange` API instead of `EditorHostProps`. See [packages/extension-sdk-docs/getting-started.md](./packages/extension-sdk-docs/getting-started.md#L119), [packages/extension-sdk-docs/custom-editors.md](./packages/extension-sdk-docs/custom-editors.md#L11), and [packages/extension-sdk-docs/examples/minimal/src/MinimalEditor.tsx](./packages/extension-sdk-docs/examples/minimal/src/MinimalEditor.tsx#L1).

Impact:
- A developer following the public docs will fail before they get a working extension.
- Even if they work around the Vite config, they will build against the wrong editor contract.

### 2. High: the AI tool docs and examples do not compile against the SDK

The public AI tool contract in docs/examples is still based on deprecated context and result shapes:

- Docs use `ToolContext` with `filePath` and `fileContent`. See [packages/extension-sdk-docs/api-reference.md](./packages/extension-sdk-docs/api-reference.md#L119) and [packages/extension-sdk-docs/ai-tools.md](./packages/extension-sdk-docs/ai-tools.md#L69).
- The SDK marks that shape deprecated and says `fileContent` is not available; the current context is `AIToolContext` with `activeFilePath` and `extensionContext`. See [packages/extension-sdk/src/types/extension.ts](./packages/extension-sdk/src/types/extension.ts#L338).
- The docs examples directly access `context.fileContent` / `context.filePath` and return objects without the required `success` field. See [packages/extension-sdk-docs/examples/custom-editor/src/aiTools.ts](./packages/extension-sdk-docs/examples/custom-editor/src/aiTools.ts#L22) and [packages/extension-sdk-docs/examples/ai-tool/src/index.ts](./packages/extension-sdk-docs/examples/ai-tool/src/index.ts#L22).
- `npx tsc --noEmit` fails for both examples with exactly those errors.

Impact:
- The public AI story is not usable as published.
- The docs currently train developers to write code that fails typecheck and does not match runtime.

### 3. High: the published SDK types have drifted from the actual runtime contract

The SDK package is supposed to be the source of truth, but its types no longer match the host implementation:

- `EditorHost` in the SDK is missing `onThemeChanged`, `onDiffCleared`, and `getConfig`. Compare [packages/extension-sdk/src/types/editor.ts](./packages/extension-sdk/src/types/editor.ts#L91) with [packages/runtime/src/extensions/editorHost.ts](./packages/runtime/src/extensions/editorHost.ts#L68).
- `ExtensionContributions.fileIcons` is typed as an array in the SDK, but the runtime contract uses a record/object. Compare [packages/extension-sdk/src/types/extension.ts](./packages/extension-sdk/src/types/extension.ts#L81) with [packages/runtime/src/extensions/types.ts](./packages/runtime/src/extensions/types.ts#L74).
- The SDK exposes `lexicalNodes`, while the runtime uses `nodes`. Compare [packages/extension-sdk/src/types/extension.ts](./packages/extension-sdk/src/types/extension.ts#L94) with [packages/runtime/src/extensions/types.ts](./packages/runtime/src/extensions/types.ts#L89).
- The SDK omits public runtime contributions entirely: `configuration`, `claudePlugin`, `themes`, `commands`, `hostComponents`, and `defaultEnabled`. See [packages/runtime/src/extensions/types.ts](./packages/runtime/src/extensions/types.ts#L98).
- `ExtensionAITool.scope` is `'global' | 'file'` in the SDK, but `'global' | 'editor'` in runtime. Compare [packages/extension-sdk/src/types/extension.ts](./packages/extension-sdk/src/types/extension.ts#L391) with [packages/runtime/src/extensions/types.ts](./packages/runtime/src/extensions/types.ts#L500).

Impact:
- External developers cannot trust the npm package typings as the canonical API.
- Even correct docs would still be built on an inaccurate type surface.

### 4. Medium: manifest rules are inconsistent across runtime, SDK, docs, and dev tooling

- The docs describe `fileIcons` as an object map, which matches runtime, but the SDK types say array entries with `pattern/icon/color`. Compare [packages/extension-sdk-docs/manifest-reference.md](./packages/extension-sdk-docs/manifest-reference.md#L240) with [packages/extension-sdk/src/types/extension.ts](./packages/extension-sdk/src/types/extension.ts#L147).
- The docs describe slash commands with `name` and `displayName`, but the SDK/runtime use `id` and `title`. Compare [packages/extension-sdk-docs/manifest-reference.md](./packages/extension-sdk-docs/manifest-reference.md#L256) with [packages/extension-sdk/src/types/extension.ts](./packages/extension-sdk/src/types/extension.ts#L169).
- `apiVersion` is optional in SDK/runtime typings, but the extension dev server warns if it is missing. See [packages/extension-sdk/src/types/extension.ts](./packages/extension-sdk/src/types/extension.ts#L30), [packages/runtime/src/extensions/ExtensionLoader.ts](./packages/runtime/src/extensions/ExtensionLoader.ts#L143), and [packages/electron/src/main/mcp/extensionDevServer.ts](./packages/electron/src/main/mcp/extensionDevServer.ts#L139).

Impact:
- The manifest schema is underspecified and self-contradictory.
- Marketplace validation, local dev validation, docs, and TypeScript may disagree on what is valid.

### 5. Medium: version guidance is internally inconsistent

- The SDK package peers on Vite 7 / React plugin 5. See [packages/extension-sdk/package.json](./packages/extension-sdk/package.json#L32).
- The examples and extension-dev-kit templates still pin Vite 5. See [packages/extension-sdk-docs/examples/minimal/package.json](./packages/extension-sdk-docs/examples/minimal/package.json#L12) and [packages/extensions/extension-dev-kit/src/templates.ts](./packages/extensions/extension-dev-kit/src/templates.ts#L46).
- The public manifest examples all use `"apiVersion": "1.0.0"` while the npm package version is `0.1.0`, and there is no public compatibility policy explaining the relationship. See [packages/extension-sdk/package.json](./packages/extension-sdk/package.json#L2) and [packages/extension-sdk-docs/manifest-reference.md](./packages/extension-sdk-docs/manifest-reference.md#L60).

Impact:
- New users will get dependency mismatch warnings and unclear upgrade semantics.
- It is not obvious what constitutes a breaking change in the public API.

### 6. Low: the npm package is bare-bones for a public launch

`npm pack --dry-run` shows the tarball only contains `dist/` and `package.json`. There is no package-level README, no packaged examples, and no obvious public changelog or migration notes in the published artifact.

Impact:
- The npm page will be thin at launch.
- Developers who discover the package from npm alone will not get a usable quick start.

## Recommendations Before Public Launch

1. Pick one canonical source of truth for the public API, then generate the others from it.
2. Treat `packages/extension-sdk` as the authoritative contract and sync it to runtime before publishing.
3. Replace all remaining `CustomEditorProps` and `ToolContext` docs/examples/templates with `EditorHostProps` and `AIToolContext`.
4. Add CI that builds and typechecks every public example against the published SDK package surface.
5. Define and document version policy:
   - SDK package semver
   - `apiVersion` meaning
   - app-to-SDK compatibility guarantees

## Release Checklist

### API and implementation

- [ ] Reconcile `packages/extension-sdk` types with `packages/runtime/src/extensions/*`.
- [ ] Decide the canonical AI tool contract and remove or hard-deprecate conflicting names.
- [ ] Decide the canonical manifest schema and make runtime validation, dev validation, docs, and typings match it.
- [ ] Decide whether `apiVersion` is required; enforce that consistently everywhere.
- [ ] Decide whether `createExtensionConfig` should require `entry` or supply a default; make code and docs agree.
- [ ] Freeze the initial public API and explicitly list anything still alpha-only.

### Docs and examples

- [ ] Rewrite `getting-started.md` to use `EditorHostProps`.
- [ ] Rewrite `custom-editors.md` to use the push/save-request model.
- [ ] Rewrite `ai-tools.md` to use `AIToolContext` and the real result shape.
- [ ] Rewrite `api-reference.md` from actual exported types, not hand-written snippets.
- [ ] Rewrite `manifest-reference.md` from the real manifest schema.
- [ ] Update all three examples so they build and typecheck.
- [ ] Add one example each for:
- [ ] custom editor
- [ ] AI-tool-only extension
- [ ] panel/settings/configuration extension
- [ ] Add a migration note for any internal users who built against older drafts of the API.

### Templates and dev tooling

- [ ] Update `extension-dev-kit` templates to the current editor and tool APIs.
- [ ] Update the `/new-extension` command guidance to match the final public contract.
- [ ] Make the dev-kit scaffold the same package versions you expect public users to install.
- [ ] Add template smoke tests that scaffold, build, and typecheck each template.

### Packaging and publishing

- [ ] Add a package-level README to `packages/extension-sdk`.
- [ ] Verify npm metadata:
- [ ] package name
- [ ] description
- [ ] repository
- [ ] homepage/docs URL
- [ ] bugs URL
- [ ] keywords
- [ ] license
- [ ] Verify the published tarball contents with `npm pack --dry-run`.
- [ ] Publish `@nimbalyst/extension-sdk` to npm from a clean tag.
- [ ] Decide whether docs/examples live in-repo only or should also be published elsewhere.

### Validation and QA

- [ ] Add CI jobs for:
- [ ] `packages/extension-sdk` build/typecheck
- [ ] example build/typecheck
- [ ] template scaffold smoke tests
- [ ] extension install validation through the dev server
- [ ] Test the public flow end to end on a clean machine:
- [ ] install package
- [ ] scaffold extension
- [ ] build extension
- [ ] install extension into Nimbalyst
- [ ] use editor/tool successfully
- [ ] Verify at least one binary/custom editor and one AI-tool-only extension in the shipping app.

### Launch readiness

- [ ] Publish the extension docs to a stable public URL.
- [ ] Publish or link example repos that exactly match the docs.
- [ ] Prepare announcement copy with:
- [ ] what extensions can do
- [ ] current supported contribution types
- [ ] what is stable vs experimental
- [ ] compatibility/version policy
- [ ] Prepare a short migration/known limitations section for launch day.
- [ ] Decide support channels for external developers:
- [ ] GitHub issues
- [ ] Discord/community
- [ ] docs feedback path

## Suggested ship gate

Do not publicly announce the SDK until these are true:

- Every public example builds and typechecks.
- The SDK typings match the host runtime.
- The docs teach the same API the app actually implements.
- A new developer can go from `npm install` to a working extension without internal help.
