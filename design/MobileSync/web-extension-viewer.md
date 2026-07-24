---
planStatus:
  planId: plan-web-extension-viewer
  title: Read-Only Extension Editors on the Web (Cloudflare Share Viewer)
  status: in-development
  planType: system-design
  priority: medium
  owner: ghinkle
  stakeholders: []
  tags:
    - sharing
    - cloudflare
    - extensions
    - read-only
    - web-viewer
  created: "2026-03-18"
  updated: "2026-03-24T00:00:00.000Z"
  progress: 100
---
# Read-Only Extension Editors on the Web

## Implementation Progress

- [x] Add `readOnly?: boolean` to EditorHost interface in extension-sdk
- [x] Create `createReadOnlyHost` factory in extension-sdk
- [x] Add viewer_type support to collabv3 share upload endpoint (D1 migration + header handling)
- [x] Create extension viewer shell HTML generator in collabv3
- [x] Add static asset route for /viewer/* in collabv3 Worker
- [x] Update ShareHandlers.ts to detect and send viewer_type for extension files
- [x] Create viewer asset deployment script

## Problem

When users share files via Nimbalyst's share system, the viewer page currently renders content as static HTML in a sandboxed iframe. This works for sessions and markdown, but files that use extension custom editors (`.excalidraw`, `.datamodel`, `.mockup.html`, `.csv`) lose their native rendering. An Excalidraw diagram shared as a link should render as an interactive (read-only) Excalidraw canvas, not a JSON blob.

## Vision

A lightweight "web runtime" hosted on Cloudflare that can load blessed Nimbalyst extension bundles and render them read-only in the browser. The same React components that power the desktop editor render the shared content on the web -- pixel-perfect fidelity with no Electron dependency.

```
User shares .excalidraw file
  -> Desktop encrypts content, uploads to R2
  -> Recipient opens share URL
  -> Worker serves viewer shell + extension viewer bundle
  -> Browser decrypts content, loads Excalidraw extension in read-only mode
  -> Recipient sees the actual diagram, not JSON
```

## Architecture

### How Extensions Work Today (Electron)

Understanding this is key to designing the web equivalent:

1. **Extension bundles** are ES modules (`dist/index.js`) built with Vite
2. Extensions declare **externals** (React, Lexical, `@nimbalyst/runtime`) -- these are NOT bundled
3. At runtime, the host exposes externals via `window.__nimbalyst_extensions` object
4. **es-module-shims** resolves bare specifiers (`import React from 'react'`) through an import map pointing to blob URLs that re-export from the window object
5. Extensions export a `components` map -- the host looks up the component name from the manifest and renders it with `{ host: EditorHost }` props
6. `useEditorLifecycle(host, { applyContent, getCurrentContent, parse, serialize })` handles the content loading/saving lifecycle

The critical insight: **extensions are already platform-agnostic React components**. They communicate with the host exclusively through `EditorHost`. If we provide a web-compatible `EditorHost` shim, the same bundle runs on the web.

### What Extensions Actually Need from EditorHost

For read-only rendering, extensions only need a tiny subset of the full `EditorHost` interface:

```typescript
// What a read-only extension actually calls:
host.loadContent()     // Get file content (string)
host.readonly          // true -- extension disables editing UI
host.theme             // Current theme name
host.fileName          // Display name
host.filePath          // File path (can be synthetic)
host.isActive          // Always true in viewer
host.onThemeChanged()  // React to theme toggle
host.storage           // Can be no-op for read-only

// Everything else is unused in read-only mode:
// saveContent, setDirty, onSaveRequested, onFileChanged,
// openHistory, toggleSourceMode, onDiffRequested, registerMenuItems
```

**Decision:** Add `readonly: boolean` to `EditorHost` (defaults to `false` in desktop). Extensions check this flag to hide edit buttons, disable keyboard shortcuts, and suppress editing UI. This is a small SDK addition -- the `ReadOnlyEditorHost` web shim sets it to `true`.

### Web Viewer Architecture

This builds entirely on the existing collabv3 share infrastructure. No new APIs, buckets, or endpoints. The only additions are static viewer assets deployed to R2 and a routing branch in the existing `GET /share/{id}` handler.

```
Existing collabv3 infrastructure (unchanged)
=============================================

POST /share              -- Upload encrypted content (existing, reused as-is)
GET /share/{id}          -- Serve viewer HTML page (existing, extended with new viewer_type branch)
GET /share/{id}/content  -- Serve encrypted content bytes (existing, reused as-is)

R2 Bucket (nimbalyst-session-shares)
  shares/{shareId}.bin   -- Encrypted content (existing, same format)

D1 Table (shared_sessions)
  viewer_type column     -- Already exists. New values: "mindmap", "excalidraw", "datamodellm", "csv"

New: static viewer assets deployed to R2
=========================================

  /viewer/shell.js           -- Decryption + viewer bootstrap (~15 KB)
  /viewer/shell.css          -- Viewer chrome styles
  /viewer/deps/react.js      -- React 18 production bundle
  /viewer/deps/react-dom.js  -- ReactDOM
  /viewer/ext/mindmap-viewer.js       -- Mindmap extension bundle (proof of concept)
  /viewer/ext/mindmap-viewer.css
  /viewer/ext/excalidraw-viewer.js    -- Excalidraw extension bundle
  /viewer/ext/excalidraw-viewer.css
  /viewer/ext/datamodellm-viewer.js   -- DataModelLM extension bundle
  /viewer/ext/csv-viewer.js           -- CSV spreadsheet bundle
  /viewer/ext/csv-viewer.css

Worker change: serve /viewer/* from R2 (static asset route)
```

### Viewer Shell Page

The Worker serves a viewer HTML page that:

1. Shows a branded loading state
2. Extracts the AES key from the URL fragment
3. Fetches and decrypts the content
4. Based on `viewer_type`, loads the appropriate extension viewer bundle
5. Creates a `ReadOnlyEditorHost` with the decrypted content
6. Mounts the extension component into the page

```html
<!-- Served by Worker for GET /share/{id} when viewer_type is an extension -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Nimbalyst</title>
  <link rel="stylesheet" href="/viewer/shell.css">
  <!-- Extension CSS loaded dynamically based on viewer_type -->
</head>
<body>
  <div id="viewer-chrome">
    <!-- Minimal header: Nimbalyst logo, theme toggle, "Open in Nimbalyst" link -->
  </div>
  <div id="viewer-root"></div>

  <!-- Import map for host dependencies -->
  <script type="importmap">
  {
    "imports": {
      "react": "/viewer/deps/react.js",
      "react-dom": "/viewer/deps/react-dom.js",
      "react-dom/client": "/viewer/deps/react-dom-client.js",
      "react/jsx-runtime": "/viewer/deps/react-jsx-runtime.js",
      "@nimbalyst/extension-sdk": "/viewer/deps/extension-sdk-shim.js"
    }
  }
  </script>

  <script type="module">
    import { decryptContent, createReadOnlyHost, mountViewer } from '/viewer/shell.js';

    const shareId = window.location.pathname.split('/').pop();
    const key = window.location.hash.slice(5); // #key=...

    const content = await decryptContent(shareId, key);
    const host = createReadOnlyHost(content, { theme: 'dark', fileName: 'shared.excalidraw' });

    // viewer_type is embedded in the HTML by the Worker
    const viewerType = '{{VIEWER_TYPE}}';
    await mountViewer(viewerType, host, document.getElementById('viewer-root'));
  </script>
</body>
</html>
```

### ReadOnlyEditorHost

A minimal implementation of `EditorHost` for web viewing:

```typescript
function createReadOnlyHost(content: string, opts: {
  theme: string;
  fileName: string;
}): EditorHost {
  let themeCallbacks: ((theme: string) => void)[] = [];
  let currentTheme = opts.theme;

  return {
    // File info
    filePath: `/shared/${opts.fileName}`,
    fileName: opts.fileName,
    readonly: true,
    theme: currentTheme,
    isActive: true,

    // Content loading -- returns the pre-decrypted content
    loadContent: async () => content,
    loadBinaryContent: async () => new TextEncoder().encode(content).buffer,

    // Theme
    onThemeChanged: (cb) => {
      themeCallbacks.push(cb);
      return () => { themeCallbacks = themeCallbacks.filter(c => c !== cb); };
    },

    // No-ops for read-only
    saveContent: async () => {},
    setDirty: () => {},
    onSaveRequested: () => () => {},
    onFileChanged: () => () => {},
    openHistory: () => {},
    registerMenuItems: () => {},

    // Storage (in-memory, non-persistent)
    storage: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      keys: async () => [],
    },

    // Public API for viewer chrome to toggle theme
    _setTheme(theme: string) {
      currentTheme = theme;
      themeCallbacks.forEach(cb => cb(theme));
    },
  };
}
```

### Viewer Mount Function

```typescript
async function mountViewer(
  viewerType: string,
  host: EditorHost,
  container: HTMLElement
) {
  // Dynamic import of the extension viewer bundle
  const viewerMap: Record<string, { js: string; css?: string; component: string }> = {
    'mindmap':     { js: '/viewer/ext/mindmap-viewer.js',     css: '/viewer/ext/mindmap-viewer.css',     component: 'MindmapEditor' },
    'excalidraw':  { js: '/viewer/ext/excalidraw-viewer.js',  css: '/viewer/ext/excalidraw-viewer.css', component: 'ExcalidrawEditor' },
    'datamodellm': { js: '/viewer/ext/datamodellm-viewer.js', css: '/viewer/ext/datamodellm-viewer.css', component: 'DataModelEditor' },
    'csv':         { js: '/viewer/ext/csv-viewer.js',         css: '/viewer/ext/csv-viewer.css',         component: 'SpreadsheetEditor' },
  };

  const viewer = viewerMap[viewerType];
  if (!viewer) {
    // Fall back to raw content display
    container.textContent = await host.loadContent();
    return;
  }

  // Load CSS
  if (viewer.css) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = viewer.css;
    document.head.appendChild(link);
  }

  // Load and mount the extension component
  const mod = await import(viewer.js);
  const Component = mod.components[viewer.component];

  const { createRoot } = await import('react-dom/client');
  const React = await import('react');
  const root = createRoot(container);
  root.render(React.createElement(Component, { host }));
}
```

## Blessed Extensions

Not all extensions make sense for web viewing. "Blessed" extensions are those that:

1. Have their viewer bundles deployed to Cloudflare R2
2. Are tested for read-only rendering (no crashes when save/dirty APIs are no-ops)
3. Have reasonable bundle sizes for web delivery

### Tier 1 -- Proof of concept candidates

| Extension | File type | Why it works | Approx bundle | Notes |
| --- | --- | --- | --- | --- |
| **Mindmap** | `.mindmap` | External marketplace extension using `useEditorLifecycle`, React Flow canvas, clean EditorHost usage. No IPC or Electron deps. | ~298 KB JS + 25 KB CSS | Best first candidate -- exercises the full web runtime path as an external extension |
| **Excalidraw** | `.excalidraw` | Library has native read-only mode. Well-tested built-in extension. | ~800 KB gzipped | Larger bundle but straightforward |

### Tier 2 -- Follow-on extensions

| Extension | File type | What's needed | Approx bundle |
| --- | --- | --- | --- |
| **DataModelLM** | `.datamodel` | Need to verify standalone rendering without Lexical nodes | ~200 KB |
| **CSV Spreadsheet** | `.csv` | RevoGrid in read-only mode. Need to verify no IPC deps. | ~400 KB |
| **PDF Viewer** | `.pdf` | Already read-only by nature. | ~300 KB (pdf.js) |

### Tier 3 -- More work

| Extension | File type | What's needed | Approx bundle |
| --- | --- | --- | --- |
| **Rexical** (markdown) | `.md` | Requires Lexical + all plugins. Large dependency surface. | ~500 KB+ |
| **Monaco** (code) | `.ts`, `.js`, etc. | Monaco is huge. Could use highlight.js instead for read-only. | ~2 MB or ~50 KB |

### Why Mindmap as Proof of Concept

The mindmap extension is the ideal first candidate because it exercises every part of the web runtime:

1. **External extension** -- lives in its own repo (`nimbalyst-mindmap`), distributed through the marketplace as a `.nimext` bundle. Proves the web runtime works for third-party extensions, not just built-ins.
2. **Uses ****`useEditorLifecycle`** -- calls `loadContent`, `parse`, `applyContent`, `markDirty`, theme tracking. The `ReadOnlyEditorHost` shim must satisfy the full lifecycle hook.
3. **React Flow canvas** -- renders an interactive spatial canvas (`@xyflow/react`). Read-only mode means pan/zoom still works but editing is disabled. Visually impressive.
4. **Markdown-based format** -- content is human-readable YAML frontmatter + indented markdown. Easy to inspect and debug during development.
5. **Moderate bundle size** (~298 KB JS) -- large enough to validate loading/caching strategy, small enough to load fast.
6. **No Lexical dependency** -- doesn't import Lexical or `@lexical/*`, so we don't need those in the web import map.
7. **No IPC dependency** -- doesn't call `electronAPI` or any Electron-specific APIs. Pure React + EditorHost.

### Bundle Strategy: Desktop Bundles First

**Decision:** Start by reusing the existing desktop extension bundles (`dist/index.js`) directly on the web. The viewer shell provides all the externals that the desktop build expects via import map:

- React, ReactDOM (ship production builds as static assets)
- `@nimbalyst/extension-sdk` (small, no platform deps -- ship as-is or provide a thin shim)
- `@nimbalyst/runtime` (web shim exporting only what extensions actually import)
- `@nimbalyst/editor-context` (web shim)
- Lexical + @lexical/* (only if the specific extension imports them)

This means no separate build step, bundles are always in sync with desktop, and the marketplace `.nimext` package is the single source of truth. If bundle sizes or shim complexity prove problematic for specific extensions, we can add optimized viewer builds later as a targeted optimization.

### Extension Allowlisting: Server-Side

**Decision:** The Worker maintains a hardcoded allowlist of extension IDs that have viewer bundles deployed. The desktop doesn't need to know which extensions support web viewing -- it sends the `viewer_type` with every share, and the server either serves the extension viewer or falls back to the static HTML/iframe viewer for unsupported types.

This keeps the logic centralized and avoids requiring a manifest flag that marketplace extensions would need to adopt.

## Deployment Pipeline

Since we're reusing desktop bundles, deployment is straightforward:

```
Developer runs: npm run deploy:viewer-bundles
  -> Copies dist/index.js from each blessed extension
  -> Uploads to R2 via wrangler: /viewer/ext/{extension}-viewer.js
  -> Updates allowlist in Worker config
```

### Versioning: Always Latest

**Decision:** All shared links use the current viewer bundle. No version pinning. This is the simplest approach and avoids storing bundle versions in D1 or keeping old bundles deployed. The risk of an extension update breaking old shares is low -- extensions are backwards-compatible with their own file format.

### Asset Caching Strategy

- Extension bundles: cache with reasonable TTL (~1 day), bust on deploy
- React/ReactDOM: versioned path (`/viewer/deps/react@18.2.0.js`), long cache
- Shell page HTML: short cache or no-cache (Worker can inline viewer_type)

## Encryption + Security

### Zero-Knowledge Preservation

The web viewer maintains the same zero-knowledge property as the existing share system:

- Content is encrypted at rest in R2
- Decryption key is in the URL fragment (never sent to server)
- Decryption happens client-side in the browser
- The `viewer_type` field in D1 reveals only the rendering method, not content

### Content Security Policy

The viewer page needs a carefully crafted CSP:

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self' blob:;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  font-src 'self' data:;
  connect-src 'self';
  frame-src blob:;
```

- `blob:` needed for es-module-shims (if used) or extension-internal blob URLs
- `'unsafe-inline'` for styles -- many extensions inject inline styles
- No external network access -- extensions can't phone home

## UX Flow

### Desktop (Sharing)

1. User right-clicks `.mindmap` file -> "Share link"
2. Desktop reads file content
3. Desktop encrypts with AES-256-GCM (reuses existing `encryptContent`)
4. Desktop uploads to R2 via `POST /share` with `viewer_type: "mindmap"` header
5. Desktop copies `https://share.nimbalyst.com/share/{id}````````#key````````={key}` to clipboard
6. Toast: "Link copied"

### Browser (Viewing)

1. Recipient opens share URL
2. Sees branded loading screen with Nimbalyst logo
3. Browser decrypts content (< 1 second)
4. Extension viewer bundle loads and renders
5. Recipient sees the mindmap / diagram / spreadsheet
6. Theme toggle available (dark/light)
7. "Open in Nimbalyst" link for desktop users

### Loading Performance

Bundle loading should feel fast:

1. **Shell HTML** served immediately by Worker (< 50ms)
2. **Decryption** happens while extension bundle loads (parallel)
3. **Extension bundle** loaded from R2 with edge caching
4. **Total time to interactive**: ~1-2 seconds for most extensions

Preloading: the shell HTML can include `<link rel="modulepreload">` for the extension bundle so it starts loading before the decryption script runs.

## What This Enables Beyond Sharing

The web viewer infrastructure has broader applications:

1. **Embeddable widgets** -- `<iframe src="share.nimbalyst.com/share/abc123#key=xyz">` lets users embed diagrams in Notion, blogs, docs
2. **Public portfolios** -- A collection of shared files as a simple website
3. **Documentation sites** -- Share data models, architecture diagrams, mockups as living docs
4. **Mobile web viewer** -- iOS/Android users can view shared content without installing the app
5. **SEO/social previews** -- Public (non-encrypted) shares enable OG tags, social card previews, and search indexing. Planned as a future option alongside the default encrypted mode.

## Decisions Made

1. **Bundle strategy: Desktop first, optimize later.** Reuse existing `dist/index.js` bundles with web shims for host dependencies. Only build separate viewer bundles if size or shim complexity proves problematic.

2. **Versioning: Always latest.** No version pinning. All shared links use the current viewer bundle. Keeps it simple.

3. **Allowlisting: Server-side.** Worker maintains a hardcoded allowlist of extension IDs with deployed viewer bundles. Desktop sends `viewer_type` with every share; server falls back to static viewer for unsupported types.

4. **Public sharing: Plan for it.** Design the viewer shell to support both encrypted and plaintext modes. A future "public share" option would skip encryption, enabling SEO, OG previews, and embeddable widgets. This doesn't change the default (encrypted), just opens the door.

## Remaining Open Questions

1. **What `@nimbalyst/runtime` exports do extensions actually use?** Need to audit the mindmap extension's imports to know what the web shim must provide. If it's only `useEditorLifecycle` (from extension-sdk, not runtime), the shim may be trivial.

2. **Bundle size budget?** Excalidraw is ~800KB gzipped. Is that acceptable for a share link? For reference, Google Docs viewer loads ~2MB+ of JS.

3. **How should public (non-encrypted) shares work?** Options: separate endpoint (`POST /share/public`), a flag on the existing endpoint, or a separate URL scheme (`share.nimbalyst.com/public/{id}` vs `/share/{id}#key=...`). Needs design when we get there.

4. **Read-only flag adoption in extensions.** `EditorHost.readonly` is a new field. Existing extensions need to check it and disable editing UI. For the proof of concept, we only need Mindmap to support it. Other extensions can adopt it as they're added to the blessed list.

## Implementation Phases

### Phase 1: Mindmap viewer (proof of concept)

The mindmap extension validates the full web runtime stack -- an external marketplace extension rendered on the web via the same EditorHost contract it uses on desktop.

1. Build `ReadOnlyEditorHost` shim (~50 LOC)
2. Build viewer shell page (decryption + import map + React mount)
3. Deploy React deps + extension-sdk shim to R2 (`/viewer/deps/`)
4. Build mindmap viewer bundle (test with existing `dist/index.js` first, fall back to separate viewer build if needed)
5. Deploy mindmap bundle to R2 (`/viewer/ext/mindmap-viewer.js`)
6. Desktop sends `viewer_type: "mindmap"` when sharing `.mindmap` files via existing `POST /share`
7. Worker routing: when `viewer_type` is an extension type, serve the viewer shell HTML instead of the current static HTML viewer
8. Test: share a `.mindmap` file, open the link in a browser, verify pan/zoom works, editing disabled

**Key validation questions this phase answers:**
- Can the desktop extension bundle (`dist/index.js`) run on the web with just an import map + ReadOnlyEditorHost shim?
- Does `useEditorLifecycle` work with the shim?
- What additional externals (if any) need web shims beyond React?
- Is the loading performance acceptable?

### Phase 2: Excalidraw + Generalize

Apply the same pattern to Excalidraw (built-in extension). Generalize the viewer shell to handle multiple extension types cleanly.

1. Deploy Excalidraw viewer bundle to R2
2. Verify Excalidraw's read-only mode works with ReadOnlyEditorHost
3. Refactor viewer shell to be fully data-driven (viewer registry in R2 or Worker config)
4. Add `viewer_type: "excalidraw"` support in desktop sharing

### Phase 3: DataModelLM + CSV + more

Add more extension viewers following the pattern established in Phases 1-2.

### Phase 4: Rexical (markdown)

Largest effort -- requires Lexical and all Rexical plugins. But gives pixel-perfect markdown rendering matching the desktop app.

## Relationship to Existing Plans

This design extends and deepens Phase 3c from [shared-file-viewer.md](./shared-file-viewer.md). That document outlines the phased approach (3a: static HTML, 3b: Rexical, 3c: extensions). This document focuses specifically on the extension viewer architecture -- the "web runtime" that makes Phase 3c possible.
