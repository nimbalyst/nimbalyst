# Mobile Sync Local Testing Guide

This guide explains how to set up and test the Nimbalyst mobile sync system locally. The sync system consists of three main components:

1. **CollabV3 Server** - Cloudflare Workers-based sync server with Durable Objects
2. **Desktop App** - Electron app that syncs AI sessions
3. **Mobile App** - Capacitor iOS/iPadOS app that receives synced sessions

## Prerequisites

- Node.js 18+
- npm (workspaces-enabled)
- Xcode 15+ (for iOS development)
- CocoaPods (`sudo gem install cocoapods`)
- Wrangler CLI (installed as dev dependency)

## Quick Start

```bash
# 1. Install all dependencies from monorepo root
cd /path/to/nimbalyst
npm install

# 2. Build the runtime package (shared dependency)
npm run build --workspace @nimbalyst/runtime

# 3. Start the CollabV3 sync server locally
cd packages/collabv3
npm run dev

# 4. In a new terminal, start the Capacitor dev server
cd packages/capacitor
npm run dev

# 5. In another terminal, start the Electron app
cd packages/electron
npm run dev
```

---

## CollabV3 Sync Server

The sync server is a Cloudflare Workers application using Durable Objects for real-time WebSocket synchronization.

### Package Location

```
packages/collabv3/
```

### Available Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start local server with Wrangler (port 8790) |
| `npm run deploy` | Deploy to Cloudflare production |
| `npm run deploy:staging` | Deploy to staging environment |
| `npm test` | Run unit tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | TypeScript type checking |

### Local Development

Start the local server:

```bash
cd packages/collabv3
npm run dev
```

This runs `wrangler dev --local --ip 0.0.0.0` which:
- Starts the server on `http://localhost:8790`
- Enables WebSocket connections at `ws://localhost:8790/sync/{roomId}`
- Uses local SQLite-backed Durable Objects (no Cloudflare account needed)
- Exposes to local network IPs (192.168.x.x) for mobile testing

### Environment Configuration

The server uses environment variables defined in `wrangler.toml`:

```toml
[vars]
ENVIRONMENT = "development"

# Stytch auth (set via wrangler secret or .dev.vars)
# STYTCH_PROJECT_ID = "project-test-xxx"
# STYTCH_SECRET_KEY = "secret-test-xxx"
# STYTCH_PUBLIC_TOKEN = "public-token-test-xxx"
```

For local development with Stytch, create a `.dev.vars` file:

```bash
# packages/collabv3/.dev.vars
STYTCH_PROJECT_ID=project-test-xxx
STYTCH_SECRET_KEY=secret-test-xxx
STYTCH_PUBLIC_TOKEN=public-token-test-xxx
```

### Testing WebSocket Connections

You can test WebSocket connections using wscat or similar tools:

```bash
# Install wscat
npm install -g wscat

# Connect to a session room (requires auth header)
wscat -c "ws://localhost:8790/sync/user:test-user:session:test-session" \
  -H "Authorization: Bearer <jwt-token>"
```

### Inspecting Local Database

Local Durable Object state is stored in `.wrangler/state/`:

```bash
# View SQLite data
sqlite3 .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite "SELECT * FROM sessions"
```

### Resetting Local State

```bash
# Delete all local state and start fresh
rm -rf .wrangler/state
npm run dev
```

---

## Capacitor Mobile App

The iOS/iPadOS companion app for viewing synced AI sessions.

### Package Location

```
packages/capacitor/
```

### Available Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start Vite dev server (port 4102) |
| `npm run build` | Build web assets |
| `npm run cap:sync` | Build and sync to native projects |
| `npm run cap:open:ios` | Open iOS project in Xcode |
| `npm run ios:dev` | Build, sync, and open Xcode |
| `npm run ios:build` | Build and sync for iOS |

### Browser-Based Development

The fastest way to iterate on mobile UI is using the browser dev server:

```bash
cd packages/capacitor
npm run dev
```

This starts a Vite dev server at `http://localhost:4102` with hot module replacement.

**Browser Limitations:**
- Capacitor native plugins (camera, secure storage) won't work
- Deep links (`nimbalyst://`) won't work
- Use this for UI development only

### iOS Simulator Testing

For full native functionality:

```bash
cd packages/capacitor

# Build web assets and open in Xcode
npm run ios:dev
```

In Xcode:
1. Select a simulator (iPhone or iPad)
2. Click Run (Cmd+R)

### Live Reload with iOS Simulator

For faster development with live reload on the simulator:

1. Edit `capacitor.config.ts` to point to your dev server:

```typescript
const config: CapacitorConfig = {
  appId: 'com.nimbalyst.app',
  appName: 'Nimbalyst',
  webDir: 'dist',
  server: {
    url: 'http://localhost:4102',  // Your dev server
    cleartext: true
  }
};
```

2. Start the dev server:
```bash
npm run dev
```

3. Build and run in Xcode:
```bash
npm run ios:dev
# Then click Run in Xcode
```

Changes to the web code will hot reload in the simulator.

### Physical Device Testing

For testing on a physical iOS device:

1. Find your Mac's local IP:
```bash
ipconfig getifaddr en0  # Wi-Fi
# or
ipconfig getifaddr en1  # Ethernet
```

2. Update `capacitor.config.ts`:
```typescript
server: {
  url: 'http://192.168.1.XXX:4102',  // Your Mac's IP
  cleartext: true
}
```

3. Ensure your phone is on the same network
4. Build and deploy to device via Xcode

### Stytch Authentication in Browser Dev Mode

When developing in the browser, Stytch OAuth won't work because deep links (`nimbalyst://`) can't redirect back to the browser. Instead, use the **dev session workflow**:

1. Open the sync server's login page in a browser:
```
http://localhost:8790/auth/login/google
```

2. Complete Google OAuth authentication

3. On the success page, you'll see a "Dev Mode: Copy Session Tokens" section

4. Copy the JSON containing:
```json
{
  "sessionToken": "stytch-session-token-xxx",
  "sessionJwt": "eyJ...",
  "userId": "user-xxx",
  "email": "you@example.com",
  "expiresAt": "2025-01-01T00:00:00Z"
}
```

5. In your browser dev console (http://localhost:4102), manually set the session:
```javascript
// Import or access the StytchAuthService
import { saveSession } from './src/services/StytchAuthService';

await saveSession({
  sessionToken: 'stytch-session-token-xxx',
  sessionJwt: 'eyJ...',
  userId: 'user-xxx',
  email: 'you@example.com',
  expiresAt: '2025-01-01T00:00:00Z',
  refreshedAt: Date.now()
});

// Refresh the page to pick up the session
location.reload();
```

This allows testing sync functionality in the browser without native deep link support.

---

## Desktop App (Electron)

The main Nimbalyst editor with AI session sync capabilities.

### Starting the Desktop App

```bash
cd packages/electron
npm run dev
```

### Configuring Sync

1. Open Settings > Session Sync
2. Enable sync and set the server URL to: `ws://localhost:8790`
3. Sign in with your Stytch account (Google or email)

### Mobile Pairing

1. On the desktop app, go to Settings > Session Sync
2. Click "Pair Mobile Device" to show QR code
3. On the mobile app, tap Settings > Scan QR Code
4. Scan the QR code to pair

The QR code contains:
- Server URL
- User credentials (device token)
- E2E encryption key (never sent to server)

---

## Testing Scenarios

### Scenario 1: Basic Session Sync

1. Start all three components (collabv3, capacitor, electron)
2. Create an AI session in the desktop app
3. Send a few messages
4. Verify session appears on mobile app
5. Verify messages are readable (decryption working)

### Scenario 2: Real-time Updates

1. Have both desktop and mobile connected
2. Send a message in desktop AI chat
3. Verify it appears on mobile within 1-2 seconds
4. Check WebSocket connection status on both

### Scenario 3: Offline/Reconnection

1. Start a session on desktop
2. Disconnect mobile (airplane mode or kill app)
3. Send more messages on desktop
4. Reconnect mobile
5. Verify missed messages sync

### Scenario 4: Authentication Flow

1. Sign out on mobile
2. Re-authenticate via QR code pairing
3. Verify sessions restore correctly
4. Check JWT refresh works (wait 5+ minutes, then sync)

---

## Troubleshooting

### CollabV3 Server Issues

**Port already in use:**
```bash
# Find and kill process on port 8790
lsof -i :8790
kill -9 <PID>
```

**WebSocket connection refused:**
- Verify server is running: `curl http://localhost:8790/health`
- Check CORS origins include your client origin
- Verify auth token is valid

**"Stytch not configured" error:**
- Create `.dev.vars` file with Stytch credentials
- Restart the server after adding secrets

### Capacitor Issues

**"Module not found" errors:**
```bash
# Rebuild from monorepo root
cd /path/to/nimbalyst
npm install
npm run build --workspace @nimbalyst/runtime
npm run cap:sync --workspace @nimbalyst/capacitor
```

**Pod install issues:**
```bash
cd packages/capacitor/ios/App
pod install --repo-update
```

**iOS build fails in Xcode:**
- Clean build folder: Product > Clean Build Folder
- Delete derived data: `rm -rf ~/Library/Developer/Xcode/DerivedData`
- Re-sync: `npm run cap:sync`

### Sync Issues

**Sessions not appearing on mobile:**
1. Check WebSocket connection status (should show "Connected")
2. Verify both devices are using the same user ID
3. Check server logs: `wrangler tail --local`
4. Verify encryption keys match (re-pair via QR if needed)

**Decryption failures:**
- QR code contains encryption key - re-pair to get fresh key
- Verify `encryptionKeySeed` matches between desktop and mobile

---

## Architecture Reference

### Server Endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/health` | GET | Health check |
| `/sync/{roomId}` | WebSocket | Real-time sync connection |
| `/api/sessions` | GET | List user's sessions |
| `/api/bulk-index` | POST | Bulk update session index |
| `/auth/login/google` | GET | Initiate Google OAuth |
| `/auth/callback` | GET | OAuth/Magic link callback |
| `/auth/refresh` | POST | Refresh session JWT |
| `/api/auth/magic-link` | POST | Send magic link email |

### Room ID Formats

- Session room: `user:{userId}:session:{sessionId}`
- Index room: `user:{userId}:index`
- Projects room: `user:{userId}:projects`

### WebSocket Message Protocol

The sync uses encrypted Y.js documents. All message content is end-to-end encrypted - the server only sees encrypted blobs.

---

## Related Documentation

- [Stytch Authentication System](./stytch-consumer-auth-system.md)
- [Local Development Plan](./local-development.md)
- [Sync Architecture](./SYNC_ARCHITECTURE.md)
- [Security Review](./SECURITY_REVIEW.md)
- [Capacitor README](../../packages/capacitor/README.md)


