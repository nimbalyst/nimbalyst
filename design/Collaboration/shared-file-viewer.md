---
planStatus:
  planId: plan-shared-file-viewer
  title: "Phase 3: Shareable Nimbalyst File Viewer"
  status: draft
  planType: feature
  priority: low
  owner: ghinkle
  stakeholders: []
  tags:
    - sharing
    - cloudflare
    - editors
    - read-only
    - encryption
  created: "2026-02-06"
  updated: "2026-02-16T00:00:00.000Z"
  progress: 0
---
# Phase 3: Shareable Nimbalyst File Viewer

## Goal

Share Nimbalyst workspace files via the same Cloudflare link infrastructure from Phase 2. A user shares a file, gets a link, and anyone can view it in the browser in a read-only viewer. Start with markdown (rendered rich text), then progressively add support for other editor types so files like `.datamodel`, `.excalidraw`, and `.mockup.html` can be viewed natively.

## Prerequisites

- Phase 2 complete: Cloudflare R2/D1 share infrastructure, `POST /share` and `GET /share/{shareId}` endpoints
- Stytch auth for upload
- Client-side encryption infrastructure from session sharing (AES-256-GCM, URL fragment keys, decryption viewer)

## Client-side encryption

File sharing reuses the same encryption model already implemented for session sharing. All content is encrypted before upload so the server only stores ciphertext and cannot read user content.

**How it works (already implemented in ShareHandlers.ts):**
1. Desktop generates a random 256-bit AES key per shared item (or reuses if re-sharing)
2. Content is encrypted with AES-256-GCM: `IV (12 bytes) || ciphertext || auth tag (16 bytes)`
3. Encrypted bytes are uploaded to R2 via `POST /share` as `application/octet-stream`
4. The decryption key is appended to the URL as a fragment: `https://share.nimbalyst.com/share/{id}#key={urlSafeBase64Key}`
5. The URL fragment is never sent to the server (per HTTP spec)

**Viewer decryption flow (already implemented in collabv3/src/share.ts):**
1. `GET /share/{id}` serves a self-contained decryption viewer HTML page
2. Viewer extracts key from `window.location.hash` (`#key=...`)
3. Fetches encrypted bytes from `GET /share/{id}/content`
4. Decrypts via Web Crypto API (`crypto.subtle.decrypt` with AES-GCM)
5. Renders decrypted HTML in a sandboxed iframe

**Key management:**
- Keys are stored locally in electron-store (`shareKeys` map: identifier -> base64 key)
- `share:getKeys` IPC lets the renderer reconstruct full URLs with fragments
- Keys are cleaned up on share deletion via `removeShareKey()`
- URL-safe base64 encoding: `+` -> `-`, `/` -> `_`, no padding

**Zero-knowledge server:** The server never receives any plaintext user content or content-derived metadata. Specifically:
- No filenames, file extensions, or titles are sent as headers or stored in D1
- The `X-Session-Title` header is hardcoded to `"Encrypted session"` (not the actual title)
- Only opaque identifiers (share ID, user ID, session/file ID for upsert) and structural metadata (size, viewer type, timestamps) are stored server-side
- OG/preview tags can only show generic branding, not content-derived text

## Phased approach

This is a progressive feature - each sub-phase adds richer viewing capability.

### Phase 3a: Markdown files (static HTML rendering)

Same approach as session export - render markdown to a self-contained HTML file at share time, upload to R2, serve via Worker. No runtime dependencies needed.

**How it works:**
1. User right-clicks a `.md` file in file tree -> "Share link"
2. Desktop reads the file, converts markdown to HTML using `marked` + `highlight.js` (same pipeline as session export)
3. Wraps in a styled HTML shell (similar to session export template but with document-focused layout)
4. Encrypts the HTML with AES-256-GCM using a per-file key (same as session encryption)
5. Uploads encrypted bytes to R2 via `POST /share` as `application/octet-stream`
6. Appends decryption key to URL fragment: `https://share.nimbalyst.com/share/{id}#key={key}`
7. Copies full URL (with fragment) to clipboard

**Rendering details:**
- Use `$convertToEnhancedMarkdownString` from Rexical if the file was saved via Lexical (preserves Nimbalyst-specific extensions like tables, frontmatter)
- Fall back to raw file content + `marked` for plain markdown
- Include YAML frontmatter rendering as a metadata header
- Dark/light theme toggle (reuse session export CSS variables)

**What this gives us:**
- Shareable rich-text documents with code highlighting, tables, images
- End-to-end encryption: server never sees plaintext content
- Minimal JS in the viewer (just the decryption + iframe render, same as session viewer)
- Works for 90% of the sharing use case

### Phase 3b: Read-only Rexical viewer (client-side rendering)

Instead of pre-rendering to static HTML, serve the actual Rexical editor in read-only mode. This gives pixel-perfect rendering that matches what the user sees in Nimbalyst.

**Architecture:**
- Build a standalone Rexical viewer bundle (React + Lexical + Rexical CSS)
- Host the bundle on Cloudflare (static assets via R2 or Pages)
- Upload raw markdown content encrypted with AES-256-GCM (same encryption as Phase 3a)
- Viewer decrypts content client-side, then initializes Rexical in read-only mode

**Viewer page structure:**

The decryption viewer (already implemented for sessions) serves as the outer shell. After decrypting the content, it needs to hand off to the Rexical viewer instead of rendering raw HTML in an iframe:

```html
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="/viewer/rexical.css">
  <script type="module" src="/viewer/rexical-viewer.js"></script>
</head>
<body>
  <div id="viewer-root"></div>
  <script>
    // Decryption viewer extracts key from URL fragment, fetches + decrypts content,
    // then passes decrypted markdown to the Rexical viewer
    window.__NIMBALYST_SHARE__ = {
      // populated after client-side decryption
      content: null,
      filename: "design-doc.md",
      theme: "dark"
    };
  </script>
</body>
</html>
```

**What this gives us:**
- Identical rendering to Nimbalyst (tables, callouts, code blocks, embeds)
- Foundation for serving other editors in read-only mode
- Still lightweight - Rexical + Lexical bundle is manageable

**Build/deploy:**
- Add a `viewer` build target to Rexical that produces a standalone bundle
- Deploy bundle to R2 as static assets (`/viewer/rexical-viewer.js`, `/viewer/rexical.css`)
- Worker serves a viewer shell page that handles decryption (reuses the session decryption pattern) then initializes the Rexical viewer with decrypted content

### Phase 3c: Extension editors in read-only mode

The long game: serve any Nimbalyst editor type in the browser viewer.

**Editors in priority order:**
1. **DataModelLM** (`.datamodel`) - visual ER diagrams are highly shareable
2. **Excalidraw** (`.excalidraw`) - diagrams and sketches
3. **MockupLM** (`.mockup.html`) - UI mockups (these are already HTML, so almost free)
4. **RevoGrid** (`.csv`) - spreadsheet view
5. **Monaco** (code files) - syntax-highlighted code

**Architecture for extension viewer:**

Each extension that supports read-only sharing needs:

1. **A read-only build** - a standalone JS bundle that can render the file content without the full Nimbalyst host. The extension SDK would provide a `buildReadOnlyViewer()` helper.

2. **A minimal EditorHost shim** - provides just enough of the EditorHost interface for rendering:
```typescript
   interface ReadOnlyEditorHost {
     loadContent(): Promise<string>;  // returns the file content
     readonly: true;
     theme: 'dark' | 'light';
   }
```
   No save, no file watching, no IPC - just content and theme.

3. **Registration in the share viewer** - the Worker knows which viewer bundle to serve based on file extension:
```
   .md           -> rexical-viewer.js
   .datamodel    -> datamodellm-viewer.js
   .excalidraw   -> excalidraw-viewer.js
   .mockup.html  -> (serve raw HTML in sandboxed iframe)
   .csv          -> revogrid-viewer.js
   .ts/.js/etc   -> monaco-viewer.js (or just highlight.js pre-render)
```

**MockupLM is the easiest win** - `.mockup.html` files are already self-contained HTML. The viewer just serves them in a sandboxed iframe with some chrome around it (header showing filename, theme toggle). Nearly zero work.

**Excalidraw is also straightforward** - the Excalidraw library supports read-only mode natively. Bundle `@excalidraw/excalidraw` with the viewer, load the JSON content, render.

**DataModelLM** - needs a standalone build of the visual schema renderer. More work but high value since ER diagrams are commonly shared.

## Sharing flow (all phases)

```
Upload (desktop):
  User right-clicks file in file tree
    -> "Share link" (requires Stytch auth)
    -> Desktop reads file content
    -> For Phase 3a: render to static HTML
    -> For Phase 3b+: prepare raw file content
    -> Get or create AES-256-GCM key for this file (stored in electron-store)
    -> Encrypt content: IV (12B) || ciphertext || auth tag (16B)
    -> Upload encrypted bytes to POST /share as application/octet-stream
    -> Server stores ciphertext in R2, returns { shareId, url }
    -> Desktop appends key to URL fragment: url#key={urlSafeBase64Key}
    -> Full URL (with fragment) copied to clipboard

View (browser):
  Recipient opens URL (e.g., https://share.nimbalyst.com/share/abc123#key=xyz...)
    -> GET /share/{id} returns decryption viewer HTML page
    -> Viewer extracts AES key from URL fragment (#key=...)
    -> Viewer fetches encrypted bytes from GET /share/{id}/content
    -> Viewer decrypts via Web Crypto API (AES-256-GCM)
    -> Phase 3a: render decrypted HTML in sandboxed iframe
    -> Phase 3b+: pass decrypted content to viewer bundle (Rexical, Excalidraw, etc.)

Security: the URL fragment is never sent to the server per HTTP spec,
so the decryption key remains client-side only. The server stores and
serves only ciphertext.
```

## Data model additions

Extend the Phase 2 `shared_sessions` D1 table (or create a sibling `shared_files` table):

```sql
CREATE TABLE shared_files (
  id TEXT PRIMARY KEY,              -- shareId (22-char base62)
  user_id TEXT NOT NULL,            -- Stytch user ID
  r2_key TEXT NOT NULL,             -- R2 object key
  size_bytes INTEGER NOT NULL,
  viewer_type TEXT NOT NULL,        -- "static-html" | "rexical" | "excalidraw" | etc.
  created_at TEXT NOT NULL,
  expires_at TEXT,
  view_count INTEGER DEFAULT 0,
  is_deleted INTEGER DEFAULT 0
);
```

**Zero-knowledge principle:** The server stores no plaintext metadata about the shared content. No filename, no file extension, no title. The `viewer_type` is the only semantic field -- it tells the Worker which decryption viewer page to serve, but reveals nothing about the content itself (only the rendering method). For Phase 3a all shares use `"static-html"` regardless of source file type.

## R2 storage

All shared content is stored as encrypted binary blobs (AES-256-GCM ciphertext). The server cannot distinguish file types from the stored content.

```
shares/{shareId}.bin            -- Encrypted content (all phases, all file types)
                                   Format: IV (12B) || ciphertext || auth tag (16B)
viewer/rexical-viewer.js        -- Phase 3b: Rexical bundle (deployed once, shared by all)
viewer/rexical.css
viewer/excalidraw-viewer.js     -- Phase 3c: per-editor bundles
viewer/datamodellm-viewer.js
```

Note: Unlike the original plan which had separate storage paths per file type, encryption means everything is stored as opaque `.bin` files. The `viewer_type` field in D1 metadata tells the Worker which decryption viewer page to serve.

## Desktop UI

### File tree context menu

Add "Share link" to the file context menu (right-click on a file in the sidebar):
- Only shown for supported file types
- Grayed out with tooltip "Sign in to share" if not authenticated
- Shows brief loading spinner while uploading
- Toast on success: "Link copied to clipboard"

### Session sharing extension

Phase 3a can also improve the session share UX:
- Instead of just context menu, add a share icon to the file tree item on hover (like the existing delete icon pattern)

## Implementation steps

### Phase 3a (markdown static HTML)

1. Create a markdown-to-HTML renderer (extend SessionHtmlExporter or create FileHtmlExporter)
2. Add `share:file` IPC handler that reads file, renders HTML, encrypts with AES-256-GCM (reuse `encryptContent` and `getOrCreateShareKey` from ShareHandlers.ts), uploads ciphertext to R2
3. Add preload API method
4. Add "Share link" to file tree context menu for `.md` files
5. Reuse `POST /share` endpoint -- server already handles encrypted binary uploads. Do NOT send filename or file extension as headers (zero-knowledge: no plaintext metadata on the server)
6. Reuse the decryption viewer page from session sharing (already renders decrypted HTML in a sandboxed iframe)
7. Extend D1 schema if using separate `shared_files` table, or add `share_type` column to `shared_sessions`
8. Key management: use filepath-based keys in electron-store (parallel to session-based keys), so re-sharing the same file produces the same URL

### Phase 3b (Rexical viewer)

1. Add a standalone viewer build target to the Rexical package
2. Create a minimal React app that initializes Rexical in read-only mode
3. Build and deploy viewer bundle to R2
4. Modify the decryption viewer page to support a two-stage flow: decrypt first, then hand off to the Rexical viewer bundle (instead of rendering raw HTML in an iframe)
5. Upload encrypted raw markdown content to R2 (encrypt before upload, same pattern)
6. Worker serves a decryption+viewer shell that loads the Rexical bundle after decryption

### Phase 3c (extension editors)

1. Define `ReadOnlyEditorHost` interface in extension SDK
2. Add `buildReadOnlyViewer` script/config to extension SDK
3. For each extension: create a read-only viewer entry point
4. Start with MockupLM (decrypt, then iframe the HTML in a sandboxed iframe)
5. Then Excalidraw (decrypt, then pass JSON to @excalidraw/excalidraw read-only mode)
6. Then DataModelLM (decrypt, then render with standalone schema renderer)
7. Deploy viewer bundles to R2
8. Extend Worker routing to serve correct decryption+viewer shell per file type (based on `viewer_type` in D1)

## Open questions

- Should shared files be versioned? If a user re-shares the same file, does it create a new link or update the existing one? (Session sharing uses upsert: same session ID reuses the same share ID and encryption key)
- Should we support sharing entire folders/workspaces? (Probably a much later phase)
- For Phase 3c, should we build viewer bundles as part of the extension build pipeline, or as a separate CI step?
- Do we want OpenGraph meta tags so shared links show rich previews in Slack/Discord? (With E2E encryption and zero-knowledge server, the only option is a generic "Nimbalyst Shared File" OG tag -- no content-derived previews since the server has no plaintext)
- Key identifier for files: session sharing uses `sessionId` as the key map identifier. File sharing could use the file path (relative to workspace) or a hash. File paths are stable for re-sharing the same file but leak the path if the electron-store is examined
