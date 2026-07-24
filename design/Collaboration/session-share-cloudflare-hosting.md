---
planStatus:
  planId: plan-session-share-cloudflare-hosting
  title: "Phase 2: Shareable Session Links via Cloudflare"
  status: in-review
  startDate: "2026-02-06"
  planType: feature
  priority: medium
  owner: ghinkle
  stakeholders: []
  tags:
    - ai-sessions
    - sharing
    - cloudflare
    - stytch
  created: "2026-02-06"
  updated: "2026-02-06T12:00:00.000Z"
  progress: 100
---
# Phase 2: Shareable Session Links via Cloudflare

## Implementation Progress

- [x] Step 1: Cloudflare infrastructure (R2 bucket binding, D1 migration, Env type)
- [x] Step 2: Server-side share endpoints (upload, view, list, delete)
- [x] Step 3: Desktop client - share IPC handler and preload API
- [x] Step 4: Desktop client - UI (share button, context menu, toast)
- [x] Step 5: Desktop client - unshare and share state management
- [x] Step 6: Shared Links settings panel

## Goal

One-click sharing of AI session exports. User clicks "Share" on a session, gets a link they can paste into Slack, email, or anywhere. The recipient opens the link in their browser and sees the rendered session transcript - no login required to view.

Builds on Phase 1 (HTML export) by uploading the same self-contained HTML file to Cloudflare and returning a shareable URL.

## Prerequisites

- Phase 1 complete: `SessionHtmlExporter` generates self-contained HTML files
- Stytch authentication already in place (same accounts used for sync)
- CollabV3 Cloudflare Worker already deployed at `sync.nimbalyst.com`

## Architecture

### High-level flow

```
User clicks "Share Session"
  -> Desktop generates HTML (existing SessionHtmlExporter)
  -> Desktop uploads HTML to Cloudflare R2 via Worker endpoint
     (authenticated with Stytch JWT, same as sync)
  -> Worker stores file in R2 bucket with unique key
  -> Worker stores metadata in D1 (owner, created, expiry, session title)
  -> Worker returns shareable URL
  -> Desktop copies URL to clipboard + shows toast notification
  -> Anyone with the URL can view the rendered HTML (no auth required to read)
```

### Why extend collabv3 vs. a new Worker

The collabv3 Worker already has:
- Stytch JWT validation
- CORS configuration
- Environment setup (dev/staging/production)
- Domain at `sync.nimbalyst.com`

Adding a few HTTP routes for upload/serve is simpler than deploying a separate Worker. The share functionality is a natural extension of the sync infrastructure.

### Cloudflare resources needed

1. **R2 Bucket** (`nimbalyst-session-shares`)
  - Stores the HTML files
  - Key format: `shares/{shareId}.html`
  - No public access - served through Worker (allows access control later)

2. **D1 Table** (`shared_sessions`)
  - Tracks share metadata for management (list, delete, expire)

3. **Worker routes** (added to existing collabv3)
  - `POST /share` - upload HTML, return share URL (authenticated)
  - `GET /share/{shareId}` - serve the HTML file (public, no auth)
  - `GET /shares` - list user's shared sessions (authenticated)
  - `DELETE /share/{shareId}` - delete a shared session (authenticated)

### URL format

```
https://sync.nimbalyst.com/share/{shareId}
```

Where `shareId` is a 22-character base62 random ID (a-z, A-Z, 0-9), providing ~131 bits of entropy. Example: `aB3kM9xPqR7nWz2vLc4jYh`. Compact enough for URLs, cryptographically unguessable.

Alternatively, could use a dedicated subdomain like `share.nimbalyst.com` pointing to the same Worker, which reads cleaner. Decision: start with `sync.nimbalyst.com/share/` and add a subdomain later if desired.

## Data Model

### D1 Table: `shared_sessions`

```sql
CREATE TABLE shared_sessions (
  id TEXT PRIMARY KEY,            -- shareId (22-char base62, ~131 bits entropy)
  user_id TEXT NOT NULL,          -- Stytch user ID (owner)
  session_id TEXT NOT NULL,       -- original AI session ID
  title TEXT,                     -- session title for listing
  r2_key TEXT NOT NULL,           -- R2 object key
  size_bytes INTEGER NOT NULL,    -- file size
  created_at TEXT NOT NULL,       -- ISO timestamp
  expires_at TEXT,                -- optional expiry (NULL = never)
  view_count INTEGER DEFAULT 0,  -- how many times viewed
  is_deleted INTEGER DEFAULT 0   -- soft delete
);

CREATE INDEX idx_shared_sessions_user ON shared_sessions(user_id, is_deleted);
```

### R2 object structure

```
shares/{shareId}.html   -- the self-contained HTML file
```

No subdirectories per user - the shareId is globally unique and the D1 table tracks ownership.

## Server-side implementation

### New routes in collabv3 Worker

Add to the existing `fetch` handler in `/packages/collabv3/src/index.ts`:

```typescript
// Share endpoints
if (url.pathname === '/share' && request.method === 'POST') {
  // Authenticated: validate JWT, upload HTML to R2, record in D1
  return handleShareUpload(request, env);
}

if (url.pathname.startsWith('/share/') && request.method === 'GET') {
  // Public: serve HTML from R2
  const shareId = url.pathname.split('/share/')[1];
  return handleShareView(shareId, env);
}

if (url.pathname === '/shares' && request.method === 'GET') {
  // Authenticated: list user's shares
  return handleShareList(request, env);
}

if (url.pathname.startsWith('/share/') && request.method === 'DELETE') {
  // Authenticated: delete a share
  const shareId = url.pathname.split('/share/')[1];
  return handleShareDelete(shareId, request, env);
}
```

### Upload handler

```typescript
async function handleShareUpload(request: Request, env: Env) {
  // 1. Validate JWT (reuse existing parseAuth)
  const userId = await authenticateRequest(request, env);
  if (!userId) return new Response('Unauthorized', { status: 401 });

  // 2. Read HTML body
  const html = await request.text();
  const title = request.headers.get('X-Session-Title') || 'Untitled';
  const sessionId = request.headers.get('X-Session-Id') || '';

  // 3. Validate size (max 5 MB)
  if (html.length > 5 * 1024 * 1024) {
    return new Response('File too large', { status: 413 });
  }

  // 4. Generate share ID
  const shareId = generateShareId(); // 22-char base62 (~131 bits entropy)

  // 5. Upload to R2
  const r2Key = `shares/${shareId}.html`;
  await env.SESSION_SHARES.put(r2Key, html, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });

  // 6. Record in D1
  await env.DB.prepare(
    `INSERT INTO shared_sessions (id, user_id, session_id, title, r2_key, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(shareId, userId, sessionId, title, r2Key, html.length, new Date().toISOString()).run();

  // 7. Return URL
  const shareUrl = `https://sync.nimbalyst.com/share/${shareId}`;
  return Response.json({ shareId, url: shareUrl });
}
```

### View handler

```typescript
async function handleShareView(shareId: string, env: Env) {
  // 1. Look up in D1 (check not deleted/expired)
  const record = await env.DB.prepare(
    `SELECT r2_key, expires_at, is_deleted FROM shared_sessions WHERE id = ?`
  ).bind(shareId).first();

  if (!record || record.is_deleted) {
    return new Response('Share not found', { status: 404 });
  }

  if (record.expires_at && new Date(record.expires_at) < new Date()) {
    return new Response('Share has expired', { status: 410 });
  }

  // 2. Increment view count (fire-and-forget)
  env.DB.prepare(
    `UPDATE shared_sessions SET view_count = view_count + 1 WHERE id = ?`
  ).bind(shareId).run();

  // 3. Serve from R2
  const object = await env.SESSION_SHARES.get(record.r2_key);
  if (!object) {
    return new Response('File not found', { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
```

## Client-side implementation

### Desktop: Share action

Add to the existing `ExportHandlers.ts` or a new `ShareHandlers.ts`:

```typescript
safeHandle('share:sessionAsLink', async (event, options: { sessionId: string }) => {
  // 1. Check auth
  const jwt = await getStytchJwt();
  if (!jwt) return { success: false, error: 'Not signed in. Sign in via Settings > Sync.' };

  // 2. Generate HTML (reuse existing exporter)
  const session = await loadSessionForExport(sessionId);
  const html = exportSessionToHtml(session);

  // 3. Upload to server
  const serverUrl = getSyncServerUrl(); // https://sync.nimbalyst.com
  const response = await fetch(`${serverUrl}/share`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'text/html',
      'X-Session-Title': session.title || 'Untitled',
      'X-Session-Id': session.id,
    },
    body: html,
  });

  if (!response.ok) {
    return { success: false, error: `Upload failed: ${response.statusText}` };
  }

  const { url } = await response.json();

  // 4. Copy to clipboard
  clipboard.writeText(url);

  return { success: true, url };
});
```

### UI: Share and Unshare

**Authentication**: Uploading (sharing) requires a Stytch account - same account used for sync. Viewing shared links is public, no auth needed.

**Share button** - add to:
- Session context menu (SessionListItem.tsx) - "Share link"
- Session header (AgentSessionHeader.tsx) - share icon button

The share button should:
1. Show a brief loading state while uploading
2. Copy URL to clipboard on success
3. Show a toast: "Link copied to clipboard" with the URL
4. If not authenticated, show a toast directing them to Settings > Sync to sign in

**Unshare / manage** - the app needs to track which sessions have been shared:

1. **Local tracking**: Store share metadata locally (shareId, URL, sessionId) so we know which sessions have active shares without hitting the server.
  - Store in D1 on the server and cache locally via `GET /shares`
  - On app launch (if authenticated), fetch the user's shares list and cache it

2. **Context menu state**: If a session is already shared, the context menu shows:
  - "Copy share link" (copies the existing URL)
  - "Unshare" (deletes the share, removes the link)
   Instead of just "Share link"

3. **Shared indicator**: Small link icon or badge on shared sessions in the sidebar, so the user can see at a glance which sessions are shared.

4. **Unshare flow**:
  - User clicks "Unshare" in context menu
  - Confirmation: "Remove shared link? Anyone with this link will no longer be able to view this session."
  - Calls `DELETE /share/{shareId}` (authenticated)
  - Removes local cache entry
  - Toast: "Share link removed"

5. **Manage all shares** (Settings > Shared Links panel):
  - Dedicated settings panel for viewing and managing all shared links
  - See details below in "Shared Links settings panel" section

## Shared Links settings panel

A new panel in Settings (alongside Account & Sync) where users can see and manage all their shared links.

**Location**: `packages/electron/src/renderer/components/GlobalSettings/panels/SharedLinksPanel.tsx`

**Registration**:
- Add `'shared-links'` to `SettingsCategory` type in `SettingsSidebar.tsx`
- Add to the "Application" sidebar group with `MaterialSymbol icon="link"`
- Add render case in `SettingsView.tsx`
- User scope (account-level, not per-project)

**Panel layout** (follows SyncPanel pattern - no props, uses Jotai atoms + IPC directly):

```
Shared Links
  "Manage links you've shared. Anyone with a link can view the content."

  [list of shared links]
  ┌─────────────────────────────────────────────────────────┐
  │  Fix token validation bug                    12 views   │
  │  sync.nimbalyst.com/share/aB3kM...   Feb 5, 2026       │
  │                              [Copy link]  [Delete]      │
  ├─────────────────────────────────────────────────────────┤
  │  Database migration plan                      3 views   │
  │  sync.nimbalyst.com/share/xR7pQ...   Feb 3, 2026       │
  │                              [Copy link]  [Delete]      │
  └─────────────────────────────────────────────────────────┘

  [empty state: "No shared links yet. Right-click a session
   and select 'Share link' to create one."]

  [not authenticated state: "Sign in to share sessions.
   Go to Account & Sync to set up your account."
   with link to sync settings]
```

**Features**:
- Fetches shares list via `GET /shares` on panel mount
- Each row shows: session title, truncated URL, created date, view count
- "Copy link" copies the URL to clipboard
- "Delete" shows confirmation, calls `DELETE /share/{shareId}`, removes from list
- Loading state while fetching
- Empty state when no shares exist
- Unauthenticated state when not signed in (with link to Account & Sync panel)
- Refreshes automatically when panel is opened

**State management**:
- Shares list is fetched via IPC (not persisted in settings atoms)
- The main process handles the HTTP calls to the server
- Panel is stateless - just displays what the server returns

## Security considerations

1. **Upload requires auth**: Only authenticated Nimbalyst users can upload. Prevents abuse.
2. **Viewing is public**: Anyone with the link can view. This is intentional - the point is easy sharing. The share ID (22 chars, base62) provides ~131 bits of entropy - on par with cryptographic tokens and infeasible to brute-force.
3. **Content is NOT encrypted**: Unlike sync messages, shared sessions are stored in plaintext HTML on R2. This is by design - recipients need to view them without any key.
4. **Owner can delete**: Users can remove their shares at any time.
5. **Rate limiting**: Consider rate-limiting uploads per user (e.g., 50 shares/day) to prevent abuse.
6. **Size limit**: 5 MB per share. A typical session export is ~30-100 KB, so this is generous.

## Implementation steps

### Step 1: Cloudflare infrastructure

- Add R2 bucket binding (`SESSION_SHARES`) to `wrangler.toml`
- Add D1 migration for `shared_sessions` table
- Create R2 bucket via Wrangler CLI

### Step 2: Server-side share endpoints

- Add share route handling to collabv3 Worker `fetch` handler
- Implement `handleShareUpload` (with JWT auth)
- Implement `handleShareView` (public, serve from R2)
- Implement `handleShareList` (authenticated)
- Implement `handleShareDelete` (authenticated)
- Add share ID generation utility
- Deploy to staging, test manually

### Step 3: Desktop client - sharing

- Add `share:sessionAsLink` IPC handler
- Wire up JWT retrieval from StytchAuthService
- Add preload API methods for share/unshare/list
- Add "Share link" to session context menu
- Add share button to session header
- Add toast notification for success/failure
- Handle unauthenticated state gracefully (prompt to sign in)

### Step 4: Desktop client - unshare and share state

- Fetch user's shares list on app launch (if authenticated) via `GET /shares`
- Cache share state locally (map of sessionId -> shareId/URL)
- Context menu shows "Copy share link" / "Unshare" for already-shared sessions
- Add `unshare:session` IPC handler that calls `DELETE /share/{shareId}`
- Confirmation dialog before unsharing
- Small shared indicator on session list items
- Toast for unshare success

### Step 5: Shared Links settings panel

- Create `SharedLinksPanel.tsx` following SyncPanel pattern (no props, IPC-driven)
- Add `'shared-links'` to `SettingsCategory` type
- Add to "Application" sidebar group in `SettingsSidebar.tsx`
- Add render case in `SettingsView.tsx`
- Add IPC handler `shares:list` that calls `GET /shares` with JWT
- Add IPC handler `shares:delete` that calls `DELETE /share/{shareId}` with JWT
- List view with copy/delete actions per share
- Empty state, loading state, unauthenticated state
- Confirmation dialog on delete

### Step 6: Testing and polish

- Test share/unshare cycle end-to-end
- Test with large sessions
- Test expired/deleted shares return proper 404/410 errors
- Test unauthenticated upload is rejected
- Verify shared HTML renders correctly in Chrome/Safari/Firefox
- Test unshare removes access for existing link holders
- Add PostHog events for share/unshare actions

## Future enhancements (out of scope)

- **Expiring links**: Option to set TTL when sharing (1 day, 1 week, 30 days)
- **Custom slugs**: Let users choose a readable URL slug
- **Share subdomain**: `share.nimbalyst.com/{shareId}` for cleaner URLs
- **Password-protected shares**: Optional password for sensitive sessions
- **OG meta tags**: Add OpenGraph tags to the HTML so Slack/Discord show rich previews
- **Share analytics**: View count trends, geographic breakdown
