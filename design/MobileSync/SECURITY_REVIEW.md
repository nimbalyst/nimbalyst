# Security Review: Sync & Authentication Systems

This document provides a comprehensive security review of Nimbalyst's sync and authentication infrastructure in preparation for a formal security audit.

**Last Updated:** 2025-12-08
**Review Status:** Comprehensive audit completed

## Executive Summary

Nimbalyst uses a multi-layered security architecture:
1. **User Authentication**: Stytch Consumer (B2C) platform for identity management
2. **Sync Authentication**: JWT-based authentication for WebSocket connections
3. **Data Protection**: End-to-end AES-256-GCM encryption for synced message content

The desktop app (Electron) and mobile app (Capacitor) share the same security model with platform-specific credential storage.

### Critical Findings Summary

| Severity | Count | Key Issues |
| --- | --- | --- |
| CRITICAL | 0 | ~~HTTP fallback in magic links~~ **FIXED** |
| HIGH | 4 | No rate limiting, JWT expiry not checked client-side, JWKS cache too long |
| MEDIUM | 6 | No forward secrecy, debug logging, weak input validation |
| LOW | 4 | Missing security headers, no certificate pinning |

**Resolved CRITICAL issues:**
- ~~ENC-1: Unencrypted queued prompts~~ - **FIXED** (AES-256-GCM encryption)
- ~~ENC-2: Unencrypted session titles~~ - **FIXED** (AES-256-GCM encryption)

---

## System Architecture Overview

```
+-----------------------------------------------------------------------------+
|                              CLIENT APPS                                     |
+--------------------------------+--------------------------------------------+
|         Electron (Desktop)     |           Capacitor (Mobile)               |
|  +---------------------------+ |  +-------------------------------------+    |
|  | StytchAuthService         | |  | StytchAuthService                   |    |
|  | - OAuth/Magic Link        | |  | - OAuth/Magic Link                  |    |
|  | - Session token storage   | |  | - Secure storage (Keychain/Keystore)|    |
|  +---------------------------+ |  +-------------------------------------+    |
|  +---------------------------+ |  +-------------------------------------+    |
|  | CredentialService         | |  | CredentialService                   |    |
|  | - Sync credentials        | |  | - Sync credentials (from QR)        |    |
|  | - Encryption key seed     | |  | - Secure storage (Keychain/Keystore)|    |
|  +---------------------------+ |  +-------------------------------------+    |
|  +---------------------------+ |  +-------------------------------------+    |
|  | SyncManager               | |  | CollabV3Sync                        |    |
|  | - Key derivation          | |  | - Key derivation                    |    |
|  | - E2E encryption          | |  | - E2E encryption                    |    |
|  +---------------------------+ |  +-------------------------------------+    |
+--------------------------------+--------------------------------------------+
                                   |
                                   | HTTPS / WSS
                                   v
+-----------------------------------------------------------------------------+
|                         CollabV3 (Cloudflare Worker)                         |
+-----------------------------------------------------------------------------+
|  +---------------------------+  +---------------------------------------+   |
|  | Auth Routes (/auth/*)     |  | Sync Routes (/sync/*)                 |   |
|  | - OAuth initiation        |  | - WebSocket upgrade                   |   |
|  | - JWT validation (JWKS)   |  | - JWT auth (query params or header)   |   |
|  | - Deep link redirect      |  | - Room routing                        |   |
|  +---------------------------+  +---------------------------------------+   |
|  +---------------------------+  +---------------------------------------+   |
|  | Stytch Integration        |  | Durable Objects                       |   |
|  | - Secret key (server-only)|  | - SessionRoom (per-session)           |   |
|  | - Token authentication    |  | - IndexRoom (per-user)                |   |
|  +---------------------------+  +---------------------------------------+   |
+-----------------------------------------------------------------------------+
                                   |
                                   | HTTPS (server-to-server)
                                   v
+-----------------------------------------------------------------------------+
|                              Stytch API                                      |
|  - User management                                                           |
|  - OAuth providers (Google)                                                  |
|  - Magic link email delivery                                                 |
|  - Session JWT issuance with JWKS                                            |
+-----------------------------------------------------------------------------+
```

---

## 1. User Authentication (Stytch)

### 1.1 Architecture

| Component | Location | Responsibility |
| --- | --- | --- |
| Public tokens | `packages/runtime/src/config/stytch.ts` | Committed to git, used for OAuth URL construction |
| Secret key | Cloudflare secrets | Server-only, never in client code |
| Auth service (Desktop) | `packages/electron/src/main/services/StytchAuthService.ts` | Deep link handling, encrypted session storage |
| Auth service (Mobile) | `packages/capacitor/src/services/StytchAuthService.ts` | Deep link handling, secure session storage (Keychain/Keystore) |
| Server routes | `packages/collabv3/src/index.ts` | Token validation, OAuth flow |
| JWT validation | `packages/collabv3/src/auth.ts` | JWKS-based signature verification |

### 1.2 Authentication Flows

#### Google OAuth Flow
```
1. User clicks "Sign in with Google"
2. App opens: https://collabv3.../auth/login/google
3. Server redirects to Stytch OAuth URL with public_token
4. User authenticates with Google
5. Stytch redirects to: https://collabv3.../auth/callback?token=...
6. Server validates token using SECRET KEY
7. Server issues session JWT signed by Stytch
8. Server redirects to: nimbalyst://auth/callback?session_token=...&session_jwt=...
9. App receives deep link, stores session credentials
```

#### Magic Link Flow
```
1. User enters email, clicks "Send Magic Link"
2. App calls: POST https://collabv3.../api/auth/magic-link
3. Server calls Stytch API with SECRET KEY to send email
4. User clicks link in email
5. Browser opens: https://collabv3.../auth/callback?token=...
6. Server validates token using SECRET KEY
7. Server redirects to: nimbalyst://auth/callback?session_token=...&session_jwt=...
8. App receives deep link, stores session credentials
```

### 1.3 Security Assessment - Desktop (Electron)

#### Strengths
- [x] Secret key never leaves server
- [x] Session tokens stored with OS keychain encryption (safeStorage)
- [x] Deep links prevent token interception in browser
- [x] JWT validated for 3-part structure before use
- [x] Session expiration tracked (7 days default)
- [x] Clear state management with event listeners

#### Vulnerabilities Found

| ID | Severity | Issue | Details |
| --- | --- | --- | --- |
| ELEC-1 | HIGH | JWT expiry not validated before use | Only structure checked (3 parts), not `exp` claim. Expired JWT used until server rejects. |
| ELEC-2 | MEDIUM | Plaintext fallback | If safeStorage unavailable, credentials stored as plaintext JSON with warning log only. |
| ELEC-3 | MEDIUM | No audit logging | Auth events logged to electron-log but no centralized security audit. |
| ELEC-4 | LOW | Missing CSRF on deep links | No nonce/state parameter to prevent token substitution attacks. |

### 1.4 Security Assessment - Mobile (Capacitor)

#### Secure Storage Implementation (FIXED)

Mobile credentials are now stored securely using `capacitor-secure-storage-plugin`, which provides:
- **iOS**: Keychain storage with hardware-backed encryption
- **Android**: Keystore with hardware-backed encryption (where available)

```typescript
// packages/capacitor/src/services/StytchAuthService.ts
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

await SecureStoragePlugin.set({
  key: 'nimbalyst_stytch_session',
  value: JSON.stringify(session),  // Encrypted in Keychain/Keystore
});
```

| ID | Severity | Issue | Status |
| --- | --- | --- | --- |
| MOB-1 | ~~CRITICAL~~ | ~~Session stored in plaintext~~ | **FIXED** - Now uses SecureStoragePlugin |
| MOB-2 | ~~CRITICAL~~ | ~~Encryption key in plaintext~~ | **FIXED** - Now uses SecureStoragePlugin |
| MOB-3 | HIGH | No JWT signature validation | Open - Mobile extracts `sub` claim without verifying signature |
| MOB-4 | ~~MEDIUM~~ | ~~Refresh token unprotected~~ | **FIXED** - Now stored in SecureStoragePlugin |

### 1.5 Credential Storage

| Platform | Storage Mechanism | Encryption | Status |
| --- | --- | --- | --- |
| macOS | Electron safeStorage (Keychain) | AES-256 via Keychain | OK |
| Windows | Electron safeStorage (DPAPI) | DPAPI encryption | OK |
| Linux | Electron safeStorage (libsecret) | Keyring encryption | OK (with fallback risk) |
| iOS | SecureStoragePlugin (Keychain) | Hardware-backed encryption | OK |
| Android | SecureStoragePlugin (Keystore) | Hardware-backed encryption | OK |

**File locations (Desktop):**
- Encrypted credentials: `~/Library/Application Support/@nimbalyst/electron/stytch-credentials`
- Device tokens: `~/Library/Application Support/@nimbalyst/electron/stytch-device-tokens`

---

## 2. CollabV3 Server Authentication

### 2.1 JWT Validation Flow

```typescript
// packages/collabv3/src/auth.ts
export async function parseAuth(request: Request, config: AuthConfig): Promise<AuthResult | null> {
  // 1. Extract token from Authorization header or query param
  let token = request.headers.get('Authorization')?.slice(7);  // "Bearer {jwt}"
  if (!token) {
    token = new URL(request.url).searchParams.get('token');  // ?token={jwt}
  }

  // 2. Validate JWT structure (3 parts)
  // 3. Decode header and payload
  // 4. Check exp, nbf, iss claims
  // 5. Validate audience (project ID)
  // 6. Verify signature using Stytch JWKS
  // 7. Return { user_id: payload.sub }
}
```

### 2.2 Server Security Assessment

#### Strengths
- [x] JWKS-based signature verification (cryptographically sound)
- [x] Issuer validation (`stytch.com`)
- [x] Expiry and not-before validation
- [x] Audience validation when configured
- [x] Supports both header and query param auth (needed for WebSocket)

#### Vulnerabilities Found

| ID | Severity | Issue | Details | Location |
| --- | --- | --- | --- | --- |
| SRV-1 | ~~CRITICAL~~ | ~~CORS wildcard~~ | **FIXED** - Now validates origin against allowlist. Production: `app.nimbalyst.com`, `capacitor://localhost`. Dev: localhost + local IPs | index.ts |
| SRV-2 | ~~CRITICAL~~ | ~~HTTP fallback~~ | **FIXED** - Production now requires `redirect_url` and validates HTTPS. Dev mode allows localhost HTTP fallback. | index.ts:332-354 |
| SRV-3 | HIGH | No rate limiting | `/api/auth/magic-link` and `/auth/refresh` have no rate limits | index.ts:149,208 |
| SRV-4 | HIGH | JWKS cache 1 hour | Revoked keys continue working for up to 1 hour | auth.ts:13 |
| SRV-5 | HIGH | Weak DO auth | Durable Objects use simple string parsing, not JWT validation | SessionRoom.ts:154-172 |
| SRV-6 | MEDIUM | Audience optional | If `STYTCH_PROJECT_ID` unset, ANY Stytch JWT accepted | auth.ts:155-163 |
| SRV-7 | MEDIUM | Debug logging | JWT payloads and user IDs logged to console | auth.ts:130-131 |
| SRV-8 | LOW | Missing security headers | No X-Content-Type-Options, X-Frame-Options, HSTS | All responses |

### 2.3 JWT in Query Parameters

**Context:** WebSocket API doesn't support custom headers during handshake.

**Current Implementation:**
```
wss://collabv3.../sync/user:{userId}:session:{sessionId}?token={jwt}
```

**Security Considerations:**
1. **Server logs** - URLs often logged; could expose JWT
2. **Browser history** - URL stored in history
3. **Referrer headers** - Could leak via Referer header

**Mitigations in place:**
- JWT has short expiration (5 minutes)
- JWKS signature verification
- Cloudflare Workers don't log query params by default

**Recommendations:**
1. Use very short-lived tokens (30-60 seconds) for WebSocket connection
2. Implement token exchange pattern (REST call first, then use ticket)
3. Ensure infrastructure doesn't log query parameters

---

## 3. End-to-End Encryption

### 3.1 Key Derivation

```typescript
// packages/electron/src/main/services/SyncManager.ts
async function deriveEncryptionKey(passphrase: string, salt: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),  // encryptionKeySeed (32 bytes base64)
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),    // `nimbalyst:${stytchUserId}`
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,                            // not extractable
    ['encrypt', 'decrypt']
  );
}
```

### 3.2 Message Encryption

```typescript
// packages/runtime/src/sync/CollabV3Sync.ts
async function encrypt(content: string, key: CryptoKey): Promise<{ encrypted: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));  // 96-bit nonce
  const data = new TextEncoder().encode(content);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  return {
    encrypted: uint8ArrayToBase64(new Uint8Array(encrypted)),
    iv: uint8ArrayToBase64(iv),
  };
}
```

### 3.3 What IS Encrypted

| Data | Encrypted | Notes |
| --- | --- | --- |
| Message content | YES | Full text encrypted |
| Message metadata | YES | Tool names, attachments info encrypted in content blob |
| Hidden flag | YES | Part of encrypted content |
| Session title | YES | Encrypted before sync transmission |
| Queued prompts | YES | Each prompt encrypted individually before sync |

### 3.4 What is NOT Encrypted (Operational Metadata)

| Field | Location | Privacy Impact |
| --- | --- | --- |
| ~~Session title~~ | ~~Session metadata~~ | **NOW ENCRYPTED** |
| AI provider/model | Session metadata | Reveals which AI used |
| Timestamps | Message envelope | Timing analysis possible |
| Message direction | Message envelope | User vs assistant |
| Message sequence | Message envelope | Conversation length |
| ~~Queued prompts~~ | ~~Session metadata~~ | **NOW ENCRYPTED** |
| Execution state | Session metadata | When user is working |
| Project ID | Session metadata | Which workspace |

**Note:** Session titles and queued prompts were previously unencrypted but are now E2E encrypted as of 2025-12-08.

### 3.5 Encryption Security Assessment

#### Strengths
- [x] AES-256-GCM: Authenticated encryption (confidentiality + integrity)
- [x] PBKDF2 with 100k iterations: Resistant to brute-force
- [x] User-specific salt: Prevents rainbow table attacks
- [x] Random 96-bit IV per message: Prevents pattern analysis
- [x] CryptoKey non-extractable: Cannot be exported from WebCrypto

#### Vulnerabilities Found

| ID | Severity | Issue | Details |
| --- | --- | --- | --- |
| ENC-1 | ~~CRITICAL~~ | ~~Queued prompts unencrypted~~ | **FIXED** - Now encrypted with AES-256-GCM before transmission |
| ENC-2 | ~~CRITICAL~~ | ~~Session title unencrypted~~ | **FIXED** - Now encrypted with AES-256-GCM before transmission |
| ENC-3 | MEDIUM | No forward secrecy | Compromise of seed decrypts all messages |
| ENC-4 | MEDIUM | Predictable salt | Uses `nimbalyst:${userId}` - low risk but suboptimal |
| ENC-5 | LOW | Content length inference | Message size reveals content characteristics |

---

## 4. Mobile Device Pairing

### 4.1 QR Code Contents (v2 format)

```json
{
  "version": 2,
  "serverUrl": "wss://sync.example.com",
  "encryptionKeySeed": "base64-32-byte-key",
  "expiresAt": 1702857600000
}
```

### 4.2 Security Assessment

#### Strengths
- [x] QR code is local-only (camera scan, not network)
- [x] Contains encryption key seed for true E2E
- [x] 15-minute expiration on QR code
- [x] Version field allows future format changes

#### Vulnerabilities Found

| ID | Severity | Issue | Details |
| --- | --- | --- | --- |
| QR-1 | MEDIUM | Client-side expiry only | No server validation of QR expiration |
| QR-2 | MEDIUM | No per-scan limit | Same QR can pair multiple devices |
| QR-3 | MEDIUM | Screenshot attack | QR visible on screen contains raw encryption key |
| QR-4 | LOW | No pairing notification | Desktop doesn't confirm when mobile connects |

---

## 5. Data at Rest

### 5.1 Desktop (Electron)

| Data | Location | Encryption |
| --- | --- | --- |
| Stytch credentials | `stytch-credentials` | safeStorage (OS keychain) |
| Sync credentials | `sync-credentials` | safeStorage (OS keychain) |
| Device tokens | `stytch-device-tokens` | safeStorage (OS keychain) |
| AI sessions (local) | PGLite database | Unencrypted (local-only) |
| App settings | electron-store | Unencrypted |

### 5.2 Mobile (Capacitor)

| Data | Location | Encryption |
| --- | --- | --- |
| Stytch session | SecureStoragePlugin (Keychain/Keystore) | Hardware-backed |
| Sync credentials | SecureStoragePlugin (Keychain/Keystore) | Hardware-backed |
| Encryption key seed | SecureStoragePlugin (Keychain/Keystore) | Hardware-backed |

### 5.3 Server (Cloudflare)

| Data | Location | Encryption |
| --- | --- | --- |
| Message content | Durable Object SQLite | E2E encrypted (AES-256-GCM) |
| Session metadata | Durable Object SQLite | Unencrypted |
| Stytch secret | Cloudflare secrets | Cloudflare encryption |

---

## 6. Network Security

### 6.1 Transport Security

| Connection | Protocol | Certificate |
| --- | --- | --- |
| Desktop -> CollabV3 | HTTPS/WSS | Cloudflare managed |
| Mobile -> CollabV3 | HTTPS/WSS | Cloudflare managed |
| CollabV3 -> Stytch | HTTPS | Stytch managed |

### 6.2 Security Assessment

#### Strengths
- [x] All production connections use TLS 1.2+
- [x] Cloudflare edge provides DDoS protection
- [x] No direct database exposure

#### Concerns
- [ ] **Certificate pinning**: Not implemented
- [ ] **Local development**: Uses HTTP (acceptable for dev only)

---

## 7. Attack Vectors

### 7.1 Client-Side Attacks

| Attack | Risk | Mitigation | Status |
| --- | --- | --- | --- |
| Malicious Electron update | High | Code signing, notarization | Implemented |
| Deep link hijacking | Medium | Platform-specific protections | Partial |
| Mobile device theft | Medium | Secure storage (Keychain/Keystore) | Implemented |
| QR code screenshot | Medium | User awareness, 15-min expiry | Partial |
| Memory dump | Low | Desktop/Mobile use secure storage | Implemented |

### 7.2 Server-Side Attacks

| Attack | Risk | Mitigation | Status |
| --- | --- | --- | --- |
| Stytch secret leak | Critical | Cloudflare secrets | Implemented |
| Database compromise | Medium | E2E encryption (but metadata exposed) | Partial |
| DDoS | Medium | Cloudflare protection | Implemented |
| Cross-tenant JWT | Medium | Audience validation | Partial (optional) |
| Magic link spam | High | No rate limiting | **VULNERABLE** |

### 7.3 Network Attacks

| Attack | Risk | Mitigation | Status |
| --- | --- | --- | --- |
| MITM | Low | TLS 1.2+ | Implemented |
| JWT interception via query param | Medium | Short expiry, signature validation | Acceptable |
| Replay attack | Low | Unique message IDs | Implemented |

---

## 8. Recommendations

### 8.1 CRITICAL (Fix Before Production)

1. **~~[MOB-1, MOB-2] Implement secure storage on mobile~~** **FIXED**
-   - Now uses `capacitor-secure-storage-plugin` for iOS Keychain and Android Keystore
  - All credentials and encryption keys are encrypted at rest

2. **~~[SRV-1] Restrict CORS origins~~** **FIXED**
  - Now validates origin against allowlist using `getCorsHeaders()`
  - Production: `https://app.nimbalyst.com`, `https://nimbalyst.com`, `capacitor://localhost`
  - Development: localhost ports + local network IPs (192.168.x.x, 10.x.x.x)
  - Configurable via `ALLOWED_ORIGINS` environment variable

3. **~~[SRV-2] Remove HTTP fallback~~** **FIXED**
  - Production now requires `redirect_url` parameter
  - Production validates `redirect_url` starts with `https://`
  - Development mode (`ENVIRONMENT=development|local`) allows HTTP localhost fallback

4. **~~[ENC-1] Encrypt queued prompts~~** **DONE**
  - Queued prompts now encrypted with AES-256-GCM before transmission
  - Both desktop and mobile encrypt on send, decrypt on receive

5. **~~[ENC-2] Encrypt session titles~~** **DONE**
  - Session titles now encrypted with AES-256-GCM before transmission
  - Backwards-compatible: accepts both encrypted and plaintext during transition

### 8.2 HIGH Priority (Next Sprint)

5. **[SRV-3] Implement rate limiting**
-   - Add per-IP rate limiting on `/api/auth/magic-link` (5 req/min)
-   - Add per-session rate limiting on `/auth/refresh`
-   - Use Cloudflare KV or native rate limiting

6. **[ELEC-1] Validate JWT expiry client-side**
-   - Check `exp` claim before using JWT
-   - Trigger refresh before expiry, not after server rejection

7. **[SRV-4] Reduce JWKS cache TTL**
  - Reduce from 1 hour to 5 minutes
  - Allow force refresh on signature validation failure

8. **[MOB-3] Validate JWT signature on mobile**
  - Use `jose` library to verify signature
  - Don't trust JWT payload without signature verification

### 8.3 MEDIUM Priority (Backlog)

10. **[SRV-6] Make audience validation mandatory**
  -     - Require `STYTCH_PROJECT_ID` env var
  -     - Fail startup if not configured

11. **[SRV-7] Reduce debug logging**
  -     - Remove JWT payload logging in production
  -     - Log only errors and security-relevant events

12. **[QR-1] Server-side QR expiration**
  -     - Track QR generation time on server
  -     - Reject pairing attempts after expiration

### 8.4 LOW Priority (Future)

1. **Certificate pinning** for high-security mode
2. **Forward secrecy** via message-level key rotation
3. **Device attestation** for mobile apps
4. **Audit logging** with centralized security event tracking
5. **Security headers** on all responses (X-Content-Type-Options, etc.)

---

## 9. Testing Checklist

### 9.1 Authentication Tests

- [ ] OAuth flow completes successfully (desktop and mobile)
- [ ] Magic link flow completes successfully
- [ ] Session persists across app restart
- [ ] Session expires after 7 days
- [ ] Sign out clears all credentials
- [ ] Invalid/expired JWT is rejected
- [ ] Expired JWT triggers refresh
- [ ] Rate limiting prevents magic link spam

### 9.2 Sync Tests

- [ ] WebSocket connects with valid JWT
- [ ] WebSocket rejects invalid JWT
- [ ] WebSocket rejects expired JWT
- [ ] Messages encrypt/decrypt correctly
- [ ] Cross-device sync works
- [ ] Offline changes sync on reconnect

### 9.3 Security Tests

- [ ] Desktop credentials encrypted at rest (safeStorage)
- [ ] Mobile credentials encrypted at rest (after fix)
- [ ] Deep link is handled securely
- [ ] QR code contains correct data and expires
- [ ] Server rejects cross-user room access
- [ ] CORS rejects unauthorized origins (after fix)
- [ ] JWT query param not logged

### 9.4 Mobile-Specific Tests

- [ ] Credentials stored in secure storage (after fix)
- [ ] JWT signature validated before use (after fix)
- [ ] Session refresh works correctly
- [ ] Biometric unlock (future)

---

## 10. Appendix

### A. Key Files

| File | Purpose |
| --- | --- |
| `packages/runtime/src/config/stytch.ts` | Stytch public tokens |
| `packages/runtime/src/sync/CollabV3Sync.ts` | E2E encryption implementation |
| `packages/electron/src/main/services/StytchAuthService.ts` | Desktop user authentication |
| `packages/electron/src/main/services/CredentialService.ts` | Desktop sync credential management |
| `packages/electron/src/main/services/SyncManager.ts` | Key derivation, sync setup |
| `packages/capacitor/src/services/StytchAuthService.ts` | Mobile user authentication |
| `packages/capacitor/src/services/CredentialService.ts` | Mobile sync credential management |
| `packages/collabv3/src/index.ts` | Server auth routes |
| `packages/collabv3/src/auth.ts` | JWT/JWKS validation |
| `packages/collabv3/src/SessionRoom.ts` | Session Durable Object |
| `packages/collabv3/src/IndexRoom.ts` | Index Durable Object |

### B. Environment Variables

### Client (Electron)

None required - uses committed public tokens.

#### Client (Mobile)

None required - uses committed public tokens.

### Server (Cloudflare Worker)

| Variable | Purpose | Source |
| --- | --- | --- |
| `STYTCH_PROJECT_ID` | Stytch project identifier, audience validation | Cloudflare secrets |
| `STYTCH_PUBLIC_TOKEN` | OAuth URL construction | Cloudflare secrets |
| `STYTCH_SECRET_KEY` | Token validation, magic link sending | Cloudflare secrets |

### C. Revision History

| Date | Author | Changes |
| --- | --- | --- |
| 2025-12-05 | Claude | Initial security review document |
| 2025-12-08 | Claude | Comprehensive security audit: Electron, Capacitor, CollabV3, E2E encryption. Added critical findings for mobile plaintext storage, CORS, metadata leakage. |
| 2025-12-08 | Claude | **FIXED MOB-1, MOB-2**: Implemented secure storage on Capacitor using `capacitor-secure-storage-plugin`. Mobile credentials now encrypted via iOS Keychain / Android Keystore. |
| 2025-12-08 | Claude | **FIXED SRV-1**: Replaced CORS wildcard with origin allowlist. Production restricts to nimbalyst.com domains. Development allows localhost and local network IPs. |
| 2025-12-08 | Claude | **Elevated ENC-1, ENC-2 to CRITICAL**: Unencrypted queued prompts and session titles expose user-generated content in plaintext. Both must be fixed before production. |
| 2025-12-08 | Claude | **FIXED ENC-1, ENC-2**: Implemented E2E encryption for queued prompts and session titles. Both are now encrypted using AES-256-GCM before transmission. Desktop (CollabV3Sync.ts) and mobile (CollabV3SyncContext.tsx) both encrypt on send and decrypt on receive. Plaintext fallback maintained for backwards compatibility during transition. |
| 2025-12-08 | Claude | **FIXED SRV-2**: Removed HTTP fallback in magic links for production. Production now requires `redirect_url` parameter and validates HTTPS. Dev mode (`ENVIRONMENT=development\ | local`) retains localhost HTTP fallback for local testing. |
