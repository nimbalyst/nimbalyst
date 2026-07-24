# Electron Packaging

This document describes how the Electron desktop app is packaged today, with emphasis on runtime-sensitive dependencies that cannot safely run from `app.asar`.

## Goals

The packaging setup has two jobs:

1. Build a normal Electron app bundle for macOS, Windows, and Linux.
2. Ensure dynamically loaded SDKs and native CLI binaries are present in the packaged output exactly where the runtime expects them.

The second job matters because several integrations depend on code or binaries that must resolve from the packaged `resources/app.asar.unpacked/node_modules` tree rather than from the virtual `app.asar` filesystem.

## Build Entry Points

The package-level build commands live in `packages/electron/package.json`.

- `npm run build`
  Builds the Electron main/preload bundles and the worker bundle.
- `npm run build:extensions`
  Builds bundled extensions that ship with the app.
- `npm run validate:extra-resources`
  Runs the pre-pack normalization and validation steps.
- `npm run build:mac`, `build:mac:local`, `build:mac:notarized`
  macOS packaging entry points. These route through `build/build-with-env.js`.
- `npm run build:win`, `build:win:arm64`, `build:win:all`
  Windows packaging entry points.
- `npm run build:linux`
  Linux packaging entry point.

`build/build-with-env.js` exists mainly for macOS packaging. Before invoking `electron-builder`, it reruns:

- `build/normalize-extra-resources.js`
- `build/validate-extra-resources.js`

This is important because mac build entry points go through the wrapper directly rather than through `npm run validate:extra-resources`.

## Packaged Layout

The Electron app is packaged with:

- `build.asar = true`
- `build.asarUnpack = [...]`
- `build.files = [...]`
- `build.extraResources = [...]`

These settings serve different purposes.

### `files`

`build.files` controls which files from the app directory are included in the packaged app at all.

This repo explicitly opts out of shipping all of `node_modules` and then adds back a narrow allowlist of packaged dependencies.

Notable explicit entries include:

- `@anthropic-ai/claude-agent-sdk`
- `@anthropic-ai/claude-agent-sdk-*`
- `@openai/codex`
- `@openai/codex-*`
- `@zed-industries/codex-acp`
- `@zed-industries/codex-acp-*`
- `@opencode-ai/sdk`
- `@vscode/ripgrep`
- a small set of supporting JS packages

The intent is to keep the packaged tree small and explicit instead of relying on broad `node_modules` inclusion.

Whether the final packaged output actually contains every runtime-sensitive SDK is enforced later by the post-pack validator.

### `asarUnpack`

`build.asarUnpack` tells `electron-builder` which packaged paths must be written out to `app.asar.unpacked` instead of being kept inside `app.asar`.

This is used for:

- native `.node` modules
- Anthropic SDK packages
- OpenAI SDK packages
- Opencode SDK packages
- ripgrep
- Codex ACP packages
- `heic-decode`

These paths are unpacked because the runtime may need to execute a native binary, load a native module, or resolve package files from a real filesystem path.

### `extraResources`

`build.extraResources` copies files into the final `resources/` directory outside `app.asar`.

This is used for things like:

- `node-pty`
- `@img`
- `@vscode/ripgrep`
- `pglite.wasm` and `pglite.data`
- built-in runtime themes
- bundled assets
- bundled extensions
- generated legal notices

There is also a macOS-specific `build.mac.extraResources` block that explicitly copies platform-specific native packages into:

- `app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-${arch}`
- `app.asar.unpacked/node_modules/@openai/codex-darwin-${arch}`
- `app.asar.unpacked/node_modules/@zed-industries/codex-acp-darwin-${arch}`

## Why `app.asar.unpacked` Matters

Several runtime integrations are not safe if Electron resolves them inside `app.asar`.

Examples:

- Claude Code ultimately needs a real `claude` or `claude.exe` binary path.
- Codex needs a real `codex` or `codex.exe` binary path.
- Codex ACP needs a real `codex-acp` or `codex-acp.exe` binary path.
- Dynamic ESM imports such as the legacy `@openai/codex-sdk` escape hatch and `@opencode-ai/sdk/client` must resolve from the packaged app tree, not from the developer checkout.

If these dependencies are missing, packed into the wrong place, or resolved from the wrong tree, the build may appear healthy but the shipped app will fail only when the feature is exercised.

## Runtime-Sensitive Dependencies

The current packaging checks are centered around these runtime-sensitive dependencies:

- `@anthropic-ai/claude-agent-sdk`
  JS SDK package imported at runtime.
- `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`
  Native Claude CLI binary package.
- `@openai/codex-sdk`
  JS SDK package imported at runtime only for the legacy Codex SDK transport escape hatch; its package tree also anchors the bundled Codex binary used by the default app-server transport.
- `@openai/codex-<platform>-<arch>`
  Native Codex binary package.
- `@zed-industries/codex-acp`
  CLI wrapper package used for path discovery.
- `@zed-industries/codex-acp-<platform>-<arch>`
  Native Codex ACP binary package.
- `@opencode-ai/sdk`
  Dynamically imported SDK package.
- `@vscode/ripgrep`
  Postinstall-fetched runtime binary.
- `node-pty`
  Native module required by the terminal stack.

## Pre-Pack Step 1: Normalize `extraResources`

File: `packages/electron/build/normalize-extra-resources.js`

Problem:

- npm workspace hoisting is not stable enough to assume every dependency always lands in the same `node_modules` directory.
- `electron-builder` treats `extraResources.from` as literal paths.
- If a dependency is present at the alternate workspace location, packaging can silently skip it or fail validation.

What the script does:

- Reads all top-level and platform-specific `extraResources.from` paths.
- Expands `${arch}` using `BUILD_ARCH` when needed.
- If an expected source path is missing but the equivalent package exists at the paired workspace location, creates a symlink at the expected location.

In practice this bridges:

- `packages/electron/node_modules/...`
- repo-root `node_modules/...`

This step only repairs `extraResources` source paths. It does not validate the packaged output.

## Pre-Pack Step 2: Validate `extraResources`

File: `packages/electron/build/validate-extra-resources.js`

Problem:

- `electron-builder` silently skips missing `extraResources` sources.
- A build can otherwise continue and produce a broken artifact.

What the validator checks:

1. Every applicable `extraResources.from` path exists before packaging.
2. Some packages are validated beyond directory existence to confirm the actual binary or native artifact exists.

Additional binary checks currently cover:

- `@vscode/ripgrep`
- `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`
- `@openai/codex-<platform>-<arch>`
- `node-pty`

Platform scoping:

- The script validates top-level `extraResources`.
- It validates only the platform-specific `extraResources` block for the current target platform.
- `BUILD_ARCH` is used to expand `${arch}` for cross-arch builds.

This validator answers:

- "Do the configured packaging inputs exist?"

It does not answer:

- "Did the final packaged app actually contain what runtime resolution needs?"

## Post-Pack Step: Validate the Packaged Output

Files:

- `packages/electron/build/afterPack.js`
- `packages/electron/build/validate-packaged-sdks.js`

This is the critical packaging-output gate.

### `afterPack.js`

`afterPack.js` runs after `electron-builder` has produced the packaged tree.

It performs two kinds of work:

1. Size pruning
2. Output validation

Current pruning behavior:

- Removes non-target ripgrep platform directories vendored by `@anthropic-ai/claude-agent-sdk`.
- Removes non-target `claude-agent-sdk-*` platform packages from `app.asar.unpacked/node_modules/@anthropic-ai`.
- Also removes stray non-target `claude-agent-sdk-*` packages from the asar-side `app/node_modules/@anthropic-ai` tree if present.

After pruning, it invokes `validate-packaged-sdks.js` with the authoritative target platform and arch from `electron-builder`.

Passing `--platform` and `--arch` explicitly is important. The validator refuses to silently fall back to the host machine’s platform/arch because that causes false negatives on cross-arch builds.

### `validate-packaged-sdks.js`

This validator inspects the packaged app itself, not the source tree.

It locates:

- macOS: `Contents/Resources/app.asar.unpacked`
- Windows: `resources/app.asar.unpacked`
- Linux: `resources/app.asar.unpacked` or `app.asar.unpacked`

It then validates two different things.

#### 1. Dynamic ESM imports resolve from the packaged tree

The validator creates an isolated temporary harness under `/tmp` with only one `node_modules` entry: a symlink to the packaged app’s unpacked `node_modules`.

This avoids a false pass where Node walks upward and accidentally resolves a package from the developer checkout.

It currently checks runtime imports for:

- `@anthropic-ai/claude-agent-sdk`
- `@openai/codex-sdk` (legacy SDK transport import check)
- `@opencode-ai/sdk`
- `@opencode-ai/sdk/client`

#### 2. Native binaries exist at the same paths runtime resolution expects

It checks the packaged output for:

- Claude binary:
  `@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude(.exe)`
- Codex binary:
  `@openai/codex-<platform>-<arch>/vendor/<target-triple>/codex/codex(.exe)`
- Codex ACP binary:
  `@zed-industries/codex-acp-<platform>-<arch>/bin/codex-acp(.exe)`

It also verifies that the discovered path is actually executable.

This validator answers:

- "Would the packaged runtime be able to import and spawn the dependencies it needs?"

If any check fails, the build is treated as broken and `afterPack` throws.

## Why There Are Two Validators

The pre-pack validator and post-pack validator solve different failure classes.

### `validate-extra-resources.js`

Detects:

- broken `extraResources.from` paths
- missing pre-pack source directories
- missing binaries inside some source packages

Does not detect:

- whether Electron actually placed the dependency into the packaged tree
- whether ESM resolution works in the packaged output
- whether runtime path resolution would hit the expected packaged location

### `validate-packaged-sdks.js`

Detects:

- missing unpacked `node_modules` output
- missing dynamically imported SDK packages in the packaged app
- missing packaged native binaries
- packages resolving outside the packaged tree

This separation is intentional. Input validation prevents obviously broken builds from starting. Output validation prevents "build green, feature broken in production" releases.

## Platform Notes

### macOS

- mac build entry points go through `build/build-with-env.js`.
- mac has additional platform-specific `extraResources` entries for the Anthropic, Codex, and Codex ACP native packages.
- notarized and local build variants share the same normalization and validation flow before `electron-builder` runs.

### Windows

- Windows packaging uses NSIS installers.
- `build:win` and `build:win:arm64` both run:
  - app build
  - extension build
  - Windows updater config validation
  - `validate:extra-resources`
  - `electron-builder`
- the packaged installer should contain unpacked SDK trees under `resources/app.asar.unpacked/node_modules`.

### Linux

- Linux packaging runs the same pre-pack validation flow.
- `node-pty` gets special validation because Linux may need a source-built binary rather than a prebuilt one.

## Manual Inspection

When debugging a shipped artifact, inspect the packaged output directly rather than reasoning only from config.

Useful approaches:

- Run `packages/electron/build/validate-packaged-sdks.js` against an unpacked app bundle.
- Inspect `resources/app.asar.unpacked/node_modules` in the built artifact.
- On Windows, the NSIS installer can be listed or extracted with archive tooling to confirm the shipped `app.asar.unpacked` contents.

This is the fastest way to separate:

- packaging-output bugs
- runtime path-resolution bugs
- environment-specific install issues

## Source of Truth

The authoritative implementation currently lives in:

- `packages/electron/package.json`
- `packages/electron/build/build-with-env.js`
- `packages/electron/build/normalize-extra-resources.js`
- `packages/electron/build/validate-extra-resources.js`
- `packages/electron/build/afterPack.js`
- `packages/electron/build/validate-packaged-sdks.js`

If packaging behavior changes, update those files first, then update this document to match.
