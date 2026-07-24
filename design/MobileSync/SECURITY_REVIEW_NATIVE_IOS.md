# Security Review: Native iOS Encryption Implementation

**Date**: 2026-02-15
**Scope**: Native iOS (Swift/CryptoKit) vs. Capacitor/Web (node-forge / Web Crypto API)
**Reviewer**: Automated analysis (Claude)
**Status**: Initial review

## Executive Summary

The native iOS implementation is a well-executed port of the existing web-based encryption system. It uses Apple CryptoKit (AES-256-GCM) and CommonCrypto (PBKDF2) with parameters that match the JavaScript implementations byte-for-byte, confirmed by 14 cross-platform compatibility test vectors. Key storage moves from Capacitor's secure storage plugin to direct iOS Keychain access, which is a security improvement. The use of platform-native crypto (hardware-accelerated) is superior to the pure-JS node-forge library used in the Capacitor version.

However, there are findings related to data-at-rest exposure in SQLite, deterministic encryption risks (pre-existing across all implementations), and opportunities for transport-layer hardening unique to the native app.

**Overall assessment**: The native iOS implementation is at least as secure as the Capacitor/web version in all areas except data-at-rest (where the SQLite plaintext cache is a regression). Several medium-priority improvements are available because the native app is not constrained by browser API limitations.

---

## Findings Summary

| Severity | Count | Description |
| --- | --- | --- |
| CRITICAL | 0 | None |
| HIGH | 2 | Data-at-rest plaintext in SQLite, deterministic encryption IV reuse |
| MEDIUM | 5 | Memory key zeroing, JWT transport, cert pinning, token expiry, PBKDF2 key cleanup |
| LOW | 4 | OAuth cookies, email validation, device ID storage, log leakage |
| INFO | 6 | Positive findings: Keychain improvement, PBKDF2 parity, wire format, test coverage, error handling, native crypto |

---

## HIGH

### H1: Decrypted Content Stored in Plaintext in SQLite Database

**Files**:
- `packages/ios/NimbalystNative/Sources/Database/DatabaseManager.swift` (schema columns)
- `packages/ios/NimbalystNative/Sources/Sync/SyncManager.swift` (processServerSession, decryptServerMessage)

**Description**: The SQLite database stores `titleDecrypted` and `contentDecrypted` columns in plaintext alongside their encrypted counterparts. If an attacker gains access to the database file (device backup extraction, jailbreak, forensic imaging), all session content is available in plaintext.

**Comparison**: The Capacitor/web implementation does NOT persistently store decrypted content. It decrypts on-the-fly for display. The native iOS implementation introduces a new data-at-rest exposure.

**Mitigation**: iOS Data Protection API (`NSFileProtectionComplete`) protects files when locked, but only on devices with a passcode and the protection class must be explicitly set.

**Remediation** (pick one):
1. Remove `contentDecrypted` and `titleDecrypted` columns. Decrypt on-the-fly with an in-memory LRU cache.
2. Set `NSFileProtectionComplete` on the database file path so it is encrypted at rest when the device is locked.
3. Use GRDB's SQLCipher integration to encrypt the entire database at rest.

---

### H2: Deterministic Encryption with Fixed IV Creates Linkability

**Files**:
- `packages/ios/NimbalystNative/Sources/Crypto/CryptoManager.swift` (`projectIdIvBase64`, `encryptDeterministic`)
- `packages/runtime/src/sync/CollabV3Sync.ts` (deterministic encrypt)
- `packages/capacitor/src/contexts/CollabV3SyncContext.tsx` (deterministic encrypt)

**Description**: Project IDs are encrypted with a fixed IV (`"project_id_i"` = base64 `"cHJvamVjdF9pZF9p"`), producing deterministic ciphertext. AES-GCM with a fixed nonce reused across different plaintexts with the same key breaks GCM security: an attacker can XOR two ciphertexts to recover the XOR of the two plaintexts.

**Important**: This is a **pre-existing design** present in all three implementations, not introduced by the iOS port. The server uses the deterministic ciphertext for project deduplication.

**Remediation**: Replace deterministic encryption with `HMAC-SHA256(key, projectId)` for dedup. Or use a separate derived key (via HKDF) for deterministic operations.

---

## MEDIUM

### M1: Encryption Key Not Cleared from Memory

**Files**: `CryptoManager.swift` (SymmetricKey stored property), `AppState.swift` (cryptoManager lifecycle)

The `CryptoManager` holds a `SymmetricKey` for the app's lifetime. When `unpair()` sets `cryptoManager = nil`, Swift/ARC does not guarantee memory zeroing on deallocation. Key material could remain in process memory.

**Comparison**: The Capacitor/web version has the same issue with JS garbage collection. No regression.

**Remediation**: Use `SymmetricKey.withUnsafeBytes` to zero the buffer before release.

### M2: PBKDF2 Derived Key Bytes Not Zeroed

**File**: `CryptoManager.swift` (`deriveKey` function)

The `derivedKeyBytes` array is not zeroed after constructing the `SymmetricKey`. The array's backing storage remains in memory.

**Remediation**: Add `defer { for i in derivedKeyBytes.indices { derivedKeyBytes[i] = 0 } }` before the return. Use `memset_s` to prevent dead-store elimination by the optimizer.

### M3: JWT Passed in WebSocket URL Query Parameter

**Files**: `WebSocketClient.swift` (line 94), `CollabV3SyncContext.tsx`

The JWT is passed as `?token=<jwt>` in the WebSocket URL. URL query parameters may be logged by proxies, CDNs, and server access logs. The native iOS app uses `URLSession` (not a browser), so it CAN set custom headers.

**Remediation**: Use `URLRequest` with an `Authorization: Bearer <jwt>` header instead:
```swift
var request = URLRequest(url: url)
request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
let wsTask = session.webSocketTask(with: request)
```

### M4: Auth Token Cached Without Expiry Tracking

**File**: `SyncManager.swift` (`authToken` property)

`SyncManager` caches the auth token as a plain string without tracking expiry. If JWT refresh fails, the stale token is used for reconnection.

**Remediation**: Store token expiry alongside it, or accept a token-provider closure instead of a static value.

### M5: No Certificate Pinning

**Files**: `WebSocketClient.swift`, `AuthManager.swift`

No custom `URLSessionDelegate` is provided for certificate validation. The native app has the capability to implement certificate pinning (unlike browser-constrained implementations).

**Comparison**: The Capacitor/web version also lacks pinning. Not a regression.

**Remediation**: Implement certificate pinning using `URLSessionDelegate.urlSession(_:didReceive:completionHandler:)` with SPKI hash pinning.

---

## LOW

### L1: Non-Ephemeral OAuth Browser Session
`prefersEphemeralWebBrowserSession = false` shares cookies with Safari. Low impact since auth sessions expire in 5 minutes.

### L2: Email Validation Bypass
Email validation is skipped when QR userId is not an email format. Self-correcting: mismatched Stytch user ID produces wrong derived key, failing decryption. No action needed.

### L3: Device ID in UserDefaults
Device ID stored in `UserDefaults` (not Keychain), but it is not sensitive data (presence tracking only). No action needed.

### L4: Debug Logging
User IDs and connection details appear in some log messages. The logging cleanup (already completed) removed raw data dumps and converted verbose NSLog to os.Logger with appropriate levels. Remaining `logger.info("Connecting to sync server")` is safe.

---

## INFO (Positive Findings)

### I1: Keychain Storage Is a Security Improvement
iOS Keychain with `kSecAttrAccessibleAfterFirstUnlock` provides better protection than the Capacitor secure storage plugin. Direct Keychain access gives more granular control over protection classes.

### I2: PBKDF2 Parameters Match Exactly
All three implementations use identical parameters:
- Algorithm: PBKDF2-HMAC-SHA256
- Iterations: 100,000
- Output: 256 bits
- Salt: `"nimbalyst:{stytchUserId}"`
- Test vector: `expectedKeyBase64 = "cVkuSqOYHOm1+QB5kTWOvRCHFzqKzjtsU+7XVBvX8fg="`

Note: 100K iterations is acceptable given the seed is 256 bits of random entropy (not a user-chosen password).

### I3: AES-GCM Wire Format Is Compatible
Wire format is identical across all platforms:
- IV: 12 bytes random, base64-encoded
- Ciphertext: `base64(ciphertext || 16-byte-auth-tag)`
- Algorithm: AES-256-GCM

### I4: Crypto Test Coverage Is Comprehensive
14 cross-platform test vectors covering: key derivation parity, cross-platform decryption (5 ciphertexts from JS), large content, roundtrip, deterministic parity, error cases.

Gap: No test for encrypting in Swift and decrypting in JS (only the reverse direction is tested).

### I5: Error Messages Do Not Leak Crypto Details
`CryptoError` enum provides generic messages. `decryptOrNil()` swallows errors silently.

### I6: Platform-Native Crypto Is Superior
Using CryptoKit/CommonCrypto (hardware-accelerated, Apple-reviewed) is superior to node-forge (pure JavaScript, susceptible to timing side-channels).

---

## Comparison Matrix: Native iOS vs. Capacitor/Web

| Aspect | Native iOS (Swift) | Capacitor/Web (node-forge) | Delta |
| --- | --- | --- | --- |
| **Key Derivation** | CommonCrypto PBKDF2 (HW accelerated) | node-forge PBKDF2 (pure JS) | Improvement |
| **Encryption** | CryptoKit AES-GCM (HW accelerated) | node-forge AES-GCM (pure JS) | Improvement |
| **Key Storage** | iOS Keychain (direct) | Keychain wrapper (plugin) | Slight improvement |
| **Data at Rest** | SQLite with plaintext columns | No persistent plaintext | **Regression** |
| **Transport** | URLSessionWebSocketTask (TLS 1.2+) | Browser WebSocket API (TLS 1.2+) | Equivalent |
| **JWT Transport** | URL query param (could use headers) | URL query param (constrained) | Equivalent |
| **Cert Pinning** | None (could add) | None (constrained) | Equivalent |
| **IV Generation** | CryptoKit random nonce | crypto.getRandomValues | Equivalent |
| **Fixed IV Risk** | Same (project ID dedup) | Same (project ID dedup) | Equivalent |
| **Memory Safety** | ARC, no explicit zeroing | JS GC, no explicit zeroing | Equivalent |
| **Test Coverage** | 14 cross-platform vectors | N/A | Good |
| **Auth Flow** | ASWebAuthenticationSession | Capacitor browser plugin | Equivalent |

---

## Prioritized Remediation

| Priority | Finding | Effort | Impact |
| --- | --- | --- | --- |
| HIGH | H1: Remove plaintext SQLite columns or set NSFileProtectionComplete | Medium | Eliminates data-at-rest exposure |
| HIGH | H2: Replace deterministic encryption with HMAC for project ID dedup | Medium | Eliminates IV reuse vulnerability |
| MEDIUM | M3: Use Authorization header for JWT (native-only improvement) | Low | Prevents JWT in server logs |
| MEDIUM | M5: Add certificate pinning for sync server | Medium | Prevents MITM with rogue CA |
| MEDIUM | M2: Zero PBKDF2 derived key bytes after SymmetricKey construction | Low | Reduces key exposure window |
| MEDIUM | M1: Consider zeroing SymmetricKey on unpair | Low | Reduces memory exposure window |
| MEDIUM | M4: Track token expiry in SyncManager | Low | Prevents stale token usage |
| LOW | L1: Consider ephemeral browser session for OAuth | Low | Reduces cookie exposure |
| LOW | L4: Hash user IDs in production log messages | Low | Reduces correlation risk |
