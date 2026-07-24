# Nimbalyst Sync Architecture

This document describes how the sync system enables real-time collaboration between the desktop (Electron) and mobile (Capacitor) apps.

## Overview

The sync system uses **CollabV3**, an append-only message protocol with WebSocket-based real-time sync. Data is end-to-end encrypted using AES-256-GCM, with the server never seeing plaintext content.

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Desktop App   │◄───────►│  Sync Server    │◄───────►│   Mobile App    │
│   (Electron)    │   WSS   │ (Durable Objects)│   WSS   │  (Capacitor)    │
└─────────────────┘         └─────────────────┘         └─────────────────┘
        │                                                        │
        ▼                                                        ▼
┌─────────────────┐                                    ┌─────────────────┐
│  Local SQLite   │                                    │  In-Memory      │
│  (PGLite)       │                                    │  Session Cache  │
└─────────────────┘                                    └─────────────────┘
```

## Key Components

### Shared Runtime (`packages/runtime/src/sync/`)

| File | Purpose |
| --- | --- |
| `CollabV3Sync.ts` | Core WebSocket protocol implementation |
| `SyncedSessionStore.ts` | Decorator that adds sync to any SessionStore |
| `types.ts` | Type definitions for sync messages |

### Desktop App (`packages/electron/src/main/services/`)

| File | Purpose |
| --- | --- |
| `SyncManager.ts` | Initialization, encryption key derivation |
| `ai/AIService.ts` | Mobile queue processing handler |
| `MessageSyncHandler.ts` | Pushes local messages to sync |

### Mobile App (`packages/capacitor/src/contexts/`)

| File | Purpose |
| --- | --- |
| `CollabV3SyncContext.tsx` | React context for sync state and operations |

## Protocol Messages

### Client → Server

| Message | Purpose |
| --- | --- |
| `sync_request` | Request messages for a session (paginated) |
| `append_message` | Send encrypted message to session |
| `update_metadata` | Update session title, provider, queuedPrompts, etc. |
| `delete_session` | Delete entire session |
| `index_sync_request` | Fetch all sessions across all projects |
| `index_update` | Update single session in index |
| `index_batch_update` | Update multiple sessions atomically |
| `device_announce` | Register device presence |

### Server → Client

| Message | Purpose |
| --- | --- |
| `sync_response` | Paginated message batch with cursor |
| `message_broadcast` | Real-time message from other device |
| `metadata_broadcast` | Real-time metadata update |
| `index_sync_response` | All sessions and projects |
| `index_broadcast` | Real-time session list update |
| `devices_list` | Connected devices |
| `device_joined` / `device_left` | Presence notifications |

## WebSocket Rooms

Two types of WebSocket connections:

1. **Session Room**: `ws://server/sync/user:{userId}:session:{sessionId}`
  - Per-session message sync
  - Connected on-demand when session accessed
  - Max 5 concurrent connections

2. **Index Room**: `ws://server/sync/user:{userId}:index`
  - Session list synchronization (SessionIndexEntry[])
  - Project list synchronization (which projects exist and are sync-enabled)
  - Cross-device coordination (queued prompts, pending execution)
  - Always connected when sync enabled

### Index Room Data

The index room syncs both sessions and projects in `index_sync_response`:

```typescript
{
  type: 'index_sync_response',
  sessions: SessionIndexEntry[],
  projects: Array<{
    project_id: string;
    name: string;
    session_count: number;
    last_activity_at: number;
    sync_enabled: boolean;
  }>
}
```

Projects are synced via `syncProjectsToIndex()` which sends project metadata to the index room. This tells the mobile app which projects exist and which are enabled for sync.

## Encryption

All message content is end-to-end encrypted. The server only sees encrypted blobs and cannot read any conversation content.

### Credential Generation

On first sync setup, credentials are generated locally and never leave the device (except authToken for server auth):

```typescript
// CredentialService.ts
{
  userId: crypto.randomUUID(),           // UUIDv4 - identifies user
  authToken: crypto.randomBytes(32),     // 256-bit - sent to server for auth
  encryptionKeySeed: crypto.randomBytes(32), // 256-bit - NEVER sent to server
  createdAt: Date.now()
}
```

**Storage**: Credentials are encrypted using the OS keychain via Electron's `safeStorage` API before writing to disk.

### Encryption Key Seed

The `encryptionKeySeed` is the root secret for all E2E encryption:

- **Generated**: 32 bytes (256 bits) of cryptographically random data
- **Format**: Base64 encoded string
- **Storage**: Encrypted on disk using OS keychain (macOS Keychain, Windows DPAPI, etc.)
- **Never transmitted**: Only the derived key is used; seed stays on device
- **Shared via QR**: When pairing mobile, the seed is transferred via QR code (never over network)

### Key Derivation (PBKDF2)

The encryption key seed is converted to an AES key using PBKDF2:

```typescript
// SyncManager.ts - deriveEncryptionKey()
const keyMaterial = await crypto.subtle.importKey(
  'raw',
  encoder.encode(encryptionKeySeed),  // The 32-byte seed
  'PBKDF2',
  false,
  ['deriveKey']
);

const aesKey = await crypto.subtle.deriveKey(
  {
    name: 'PBKDF2',
    salt: encoder.encode(`nimbalyst:${userId}`),  // User-specific salt
    iterations: 100000,                            // High iteration count
    hash: 'SHA-256'
  },
  keyMaterial,
  { name: 'AES-GCM', length: 256 },  // Output: 256-bit AES-GCM key
  false,                              // Not extractable
  ['encrypt', 'decrypt']
);
```

**Parameters**:
| Parameter | Value | Purpose |
| --- | --- | --- |
| Algorithm | PBKDF2 | Industry-standard key derivation |
| Salt | `nimbalyst:{userId}` | Prevents rainbow table attacks, unique per user |
| Iterations | 100,000 | Slows brute-force attacks |
| Hash | SHA-256 | Secure hash function |
| Output | 256-bit AES-GCM key | Used for all message encryption |

### Message Encryption (AES-256-GCM)

Each message is encrypted individually with a unique IV:

```typescript
// CollabV3Sync.ts - encryptMessage()
async function encryptMessage(message: AgentMessage, key: CryptoKey): Promise<EncryptedMessage> {
  // 1. Create JSON payload with all message data
  const content = JSON.stringify({
    content: message.content,    // The actual message text
    metadata: message.metadata,  // Tool calls, attachments, etc.
    hidden: message.hidden       // Whether message is hidden in UI
  });

  // 2. Generate random 12-byte IV (96 bits, recommended for GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // 3. Encrypt with AES-256-GCM
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(content)
  );

  // 4. Return base64-encoded ciphertext and IV
  return {
    id: syncId,                              // Stable hash for deduplication
    encrypted_content: base64Encode(encrypted),
    iv: base64Encode(iv),
    // ... unencrypted metadata for server indexing
  };
}
```

**Security Properties of AES-GCM**:
- **Confidentiality**: Content is encrypted
- **Integrity**: Built-in authentication tag detects tampering
- **Unique IV**: Fresh random IV per message prevents pattern analysis

### Encrypted Message Structure

What the server sees (cannot decrypt):

```typescript
interface EncryptedMessage {
  id: string;                    // Stable sync ID (hash)
  sequence: number;              // Server-assigned order
  created_at: number;            // Timestamp (unencrypted)
  source: 'user' | 'claude-code' | 'tool';  // Message source (unencrypted)
  direction: 'input' | 'output'; // Direction (unencrypted)
  encrypted_content: string;     // Base64 AES-GCM ciphertext
  iv: string;                    // Base64 initialization vector
  metadata: {};                  // Empty - all sensitive data in encrypted_content
}
```

**What's encrypted**: Message content, tool names, attachments, hidden flag - all message data
**What's NOT encrypted**: Timestamps, message source/direction (structural metadata only)

### Sync ID Generation

Stable IDs prevent duplicate messages when syncing:

```typescript
// Hash: sessionId + timestamp + direction + first 100 chars of content
const hashInput = `${sessionId}:${timestamp}:${direction}:${contentPreview}`;
const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(hashInput));
const syncId = hashArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
```

**Result**: 32-character hex string (128 bits of SHA-256)

### Mobile Device Pairing

When pairing a mobile device:

1. Desktop generates QR code containing credentials (including `encryptionKeySeed`)
2. Mobile scans QR code and stores credentials securely
3. Both devices now share the same encryption key seed
4. All messages encrypted/decrypted with same derived key

**QR Code Contents** (transferred locally, never over network):
```json
{
  "userId": "uuid",
  "authToken": "base64-token",
  "encryptionKeySeed": "base64-seed",
  "serverUrl": "wss://sync.example.com"
}
```

## Queued Prompts Flow

This is how messages typed on mobile get executed on desktop:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ MOBILE                                                                   │
│                                                                          │
│ 1. User types message                                                    │
│ 2. Added to queuedPrompts in session metadata                           │
│ 3. Send index_update with queuedPrompts to server                       │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼ index_broadcast
┌─────────────────────────────────────────────────────────────────────────┐
│ DESKTOP                                                                  │
│                                                                          │
│ 4. AIService.initializeMobileSyncHandler() receives index change        │
│ 5. Updates local session metadata with queuedPrompts                    │
│ 6. Sends IPC 'ai:queuedPromptsReceived' to renderer                     │
│ 7. AgenticPanel receives IPC, loads session if needed                   │
│ 8. Calls handleSendMessage() - same flow as typing locally              │
│ 9. AI processes message, response synced back                           │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Design Decision

Queue processing happens in the **renderer process only**, using the same code path as normal message sending. This avoids SDK instantiation issues in the main process.

```typescript
// AgenticPanel.tsx - Single place for queue processing
const handleQueuedPromptsReceived = async (data) => {
  // Open session tab if needed (loads session)
  // Process queue using handleSendMessage() - same as typing
};
```

## Session Index Structure

Lightweight metadata for session list display:

```typescript
interface SessionIndexEntry {
  session_id: string;
  project_id: string;
  title: string;
  provider: string;
  model?: string;
  mode?: 'agent' | 'planning';
  message_count: number;
  last_message_at: number;
  created_at: number;
  updated_at: number;

  // Cross-device coordination
  queuedPrompts?: Array<{
    id: string;
    prompt: string;
    timestamp: number;
  }>;
  pendingExecution?: {
    messageId: string;
    sentAt: number;
    sentBy: 'mobile' | 'desktop';
  };
  isExecuting?: boolean;
}
```

## Delta Sync (Startup)

On desktop startup, only sync what's missing:

1. Fetch server's session index (message counts)
2. Compare with local message counts
3. For each session with fewer local messages:
  - Connect to session room
  - Request messages starting from local count
  - Append to local database
4. Sync in batches of 3 sessions with 1-second delays

## Connection Management

### Limits

- `MAX_SESSION_CONNECTIONS = 10` - Prevents connection explosion
- `IDLE_EVICTION_TIMEOUT_MS = 5 minutes` - Sessions idle longer than this can be evicted
- When at max: evicts oldest idle session to make room for new connections
- If no idle sessions: new connections rejected

### Auto-Connect Strategy

| Operation | Connects? | Reason |
| --- | --- | --- |
| `create()` | Yes | Needs to push initial metadata |
| `updateMetadata()` | Only if connected | Avoids connection spam |
| `get()` / `list()` | No | Read-only operations |

### Retry Logic

- Mobile: 5-second reconnect delay
- Desktop: 5 retries with 1-second delay
- Connection timeout: 10 seconds
- Operation timeout: 30 seconds

## Device Presence

Devices announce themselves and receive presence updates:

```typescript
interface DeviceInfo {
  device_id: string;    // Stable: SHA-256(userId + hostname + platform)
  name: string;         // Friendly name (hostname)
  type: 'desktop' | 'mobile';
  platform: 'macos' | 'windows' | 'linux' | 'ios' | 'android';
  app_version: string;
}
```

Re-announcement every 30 seconds to handle server hibernation.

## Configuration

Stored in electron-store app settings:

```json
{
  "sessionSync": {
    "enabled": true,
    "backend": "collabv3",
    "serverUrl": "wss://sync.example.com",
    "enabledProjects": ["/path/to/project1", "/path/to/project2"]
  }
}
```

Credentials stored in system keychain via CredentialService.

## Graceful Degradation

Sync is completely optional:

- If not configured: app works normally without sync
- On sync failure: reverts to local-only mode
- On connection loss: queues operations, retries automatically
- No data loss: local database is always source of truth

## Event-Driven Architecture

Components subscribe to sync events:

```typescript
// Status changes
syncProvider.onStatusChange((status) => { ... });

// Remote messages
syncProvider.onRemoteChange((sessionId, entry) => { ... });

// Session list updates (including queuedPrompts)
syncProvider.onIndexChange((sessionId, entry) => { ... });
```

## Server Infrastructure

- **Backend**: Cloudflare Durable Objects + SQLite
- **WebSocket**: Automatic upgrade from HTTPS
- **Authentication**: Token in WebSocket URL query params
- **Encryption**: End-to-end, server sees only encrypted blobs

## File Structure

```
packages/
├── runtime/src/sync/
│   ├── CollabV3Sync.ts       # Core protocol
│   ├── SyncedSessionStore.ts # Store decorator
│   ├── types.ts              # Type definitions
│   └── index.ts              # Public exports
│
├── electron/src/main/services/
│   ├── SyncManager.ts        # Desktop sync initialization
│   ├── ai/AIService.ts       # Queue processing handler (lines 438-515)
│   └── MessageSyncHandler.ts # Message push to sync
│
└── capacitor/src/contexts/
    └── CollabV3SyncContext.tsx  # Mobile sync context
```

## User Authentication (Stytch)

User authentication is handled via [Stytch Consumer](https://stytch.com/docs/guides/dashboard/api-keys), a B2C authentication platform. This is separate from the sync credentials (which are device-specific).

### Architecture

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Desktop App   │────────►│  CollabV3       │────────►│  Stytch API     │
│   (Electron)    │  HTTPS  │  (Cloudflare)   │  HTTPS  │                 │
└─────────────────┘         └─────────────────┘         └─────────────────┘
        │                           │
        │                           │ Has secret key
        │                           ▼
        │                   ┌─────────────────┐
        │                   │  Token          │
        │                   │  Validation     │
        │                   └────────┬────────┘
        │                            │
        │◄───────────────────────────┘
        │     nimbalyst://auth/callback
        ▼
┌─────────────────┐
│  Session Token  │
│  (safeStorage)  │
└─────────────────┘
```

**Key principle**: The desktop app NEVER has access to the Stytch secret key. All secret key operations happen on the CollabV3 Cloudflare Worker.

### Authentication Methods

| Method | Flow |
| --- | --- |
| Google OAuth | Browser -> collabv3/auth/login/google -> Stytch -> collabv3/auth/callback -> nimbalyst:// deep link |
| Magic Link | collabv3/api/auth/magic-link (sends email) -> user clicks link -> collabv3/auth/callback -> nimbalyst:// deep link |

### Server Endpoints (CollabV3)

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/auth/login/google` | GET | Initiates Google OAuth flow, redirects to Stytch |
| `/auth/callback` | GET | Validates OAuth/magic link tokens, redirects to `nimbalyst://auth/callback` |
| `/api/auth/magic-link` | POST | Sends magic link email (requires secret key) |

### Deep Link Format

After successful authentication, the server redirects to:

```
nimbalyst://auth/callback?session_token=...&session_jwt=...&user_id=...&email=...&expires_at=...
```

The Electron app handles this via the `open-url` event and stores the session token securely.

### Configuration

Stytch public tokens are stored in `packages/runtime/src/config/stytch.ts`:

```typescript
// Public tokens - safe to commit (designed for client-side use)
export const STYTCH_CONFIG = {
  test: {
    projectId: 'project-test-...',
    publicToken: 'public-token-test-...',
    apiBase: 'https://test.stytch.com/v1',
  },
  live: {
    projectId: 'project-live-...',
    publicToken: 'public-token-live-...',
    apiBase: 'https://api.stytch.com/v1',
  },
};
```

The secret key is stored as a Cloudflare secret on the CollabV3 worker:
- `STYTCH_PROJECT_ID`
- `STYTCH_PUBLIC_TOKEN`
- `STYTCH_SECRET_KEY`

### Session Management

| Item | Storage | Purpose |
| --- | --- | --- |
| Session Token | Electron safeStorage | Authenticates API requests |
| Session JWT | Electron safeStorage | Contains user claims |
| User ID | Electron safeStorage | Identifies the user |
| Expiration | Electron safeStorage | Token validity check |

Sessions are validated and refreshed automatically. On sign-out, all credentials are cleared.

### Key Files

| File | Purpose |
| --- | --- |
| `packages/runtime/src/config/stytch.ts` | Public token configuration |
| `packages/electron/src/main/services/StytchAuthService.ts` | Desktop auth service (deep link handling, session storage) |
| `packages/collabv3/src/index.ts` | Server auth routes (`/auth/*`, `/api/auth/*`) |

## Local Development Setup

For testing auth and sync locally with wrangler:

### 1. Create `.dev.vars` for local secrets

```bash
# packages/collabv3/.dev.vars
STYTCH_PROJECT_ID=project-test-...
STYTCH_PUBLIC_TOKEN=public-token-test-...
STYTCH_SECRET_KEY=<from-stytch-dashboard>
```

### 2. Configure Stytch Redirect URLs

In [Stytch Dashboard > Redirect URLs](https://stytch.com/dashboard/redirect-urls), add:

| URL | Types |
| --- | --- |
| `http://localhost:8790/auth/callback` | Login, Signup |

### 3. Start local collabv3 server

```bash
cd packages/collabv3
npx wrangler dev
```

Runs on `http://localhost:8790`.

### 4. Configure desktop app

In Settings > Account & Sync, set server URL to `ws://localhost:8790`.

The auth handlers automatically convert `ws://` to `http://` for auth endpoints.

## Security Considerations

1. **End-to-end encryption**: Server never sees plaintext message content
2. **Key derivation**: Strong PBKDF2 with 100k iterations
3. **Unique IVs**: Fresh random IV per message
4. **Credential storage**: System keychain, not localStorage
5. **Token auth**: Short-lived tokens, refreshed periodically
6. **Secret key isolation**: Stytch secret key only exists on server (CollabV3), never in client apps
