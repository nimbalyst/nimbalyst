/**
 * Generate encryption test vectors for Swift CryptoKit compatibility testing.
 *
 * This script uses the Web Crypto API (the same implementation as the desktop app)
 * to produce deterministic test vectors. The Swift XCTest suite decrypts these
 * vectors using CryptoKit and verifies roundtrip compatibility.
 *
 * Usage: node generate-test-vectors.mjs > test-vectors.json
 */

import { webcrypto } from 'node:crypto';

const crypto = webcrypto;

// ---------------------------------------------------------------------------
// Helpers (same as CollabV3Sync.ts)
// ---------------------------------------------------------------------------

function uint8ArrayToBase64(bytes) {
  if (bytes.length < 1024) {
    return btoa(String.fromCharCode(...bytes));
  }
  const CHUNK_SIZE = 8192;
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    result += String.fromCharCode(...chunk);
  }
  return btoa(result);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Key derivation (same as SyncManager.ts)
// ---------------------------------------------------------------------------

async function deriveEncryptionKey(passphrase, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true, // extractable so we can export for test vectors
    ['encrypt', 'decrypt']
  );
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt (same as CollabV3Sync.ts)
// ---------------------------------------------------------------------------

async function encrypt(content, key, ivOverride) {
  const iv = ivOverride || crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const data = encoder.encode(content);

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

async function decrypt(encryptedB64, ivB64, key) {
  const encryptedBytes = base64ToUint8Array(encryptedB64);
  const ivBytes = base64ToUint8Array(ivB64);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes },
    key,
    encryptedBytes
  );

  return new TextDecoder().decode(decrypted);
}

// ---------------------------------------------------------------------------
// Fixed IV for project_id encryption
// ---------------------------------------------------------------------------

const PROJECT_ID_FIXED_IV = new Uint8Array([
  0x70, 0x72, 0x6f, 0x6a, 0x65, 0x63, 0x74, 0x5f, 0x69, 0x64, 0x5f, 0x69 // "project_id_i"
]);

// ---------------------------------------------------------------------------
// Generate test vectors
// ---------------------------------------------------------------------------

async function main() {
  // Use a fixed passphrase and salt for reproducible test vectors
  const passphrase = 'dGVzdC1lbmNyeXB0aW9uLWtleS1zZWVkLWZvci10ZXN0cw=='; // base64-encoded seed
  const salt = 'nimbalyst:user-test-12345';

  const key = await deriveEncryptionKey(passphrase, salt);

  // Export raw key bytes so Swift can verify PBKDF2 derivation
  const rawKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  const rawKeyBase64 = uint8ArrayToBase64(rawKeyBytes);

  const vectors = {
    _comment: 'Test vectors for Swift CryptoKit AES-GCM compatibility with JS Web Crypto API',
    keyDerivation: {
      passphrase,
      salt,
      iterations: 100000,
      hash: 'SHA-256',
      keyLengthBits: 256,
      derivedKeyBase64: rawKeyBase64,
    },
    testCases: [],
  };

  // --- Test case 1: Simple short text ---
  {
    const plaintext = 'Hello, Nimbalyst!';
    const fixedIv = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const { encrypted, iv } = await encrypt(plaintext, key, fixedIv);
    // Verify roundtrip
    const decrypted = await decrypt(encrypted, iv, key);
    if (decrypted !== plaintext) throw new Error('Roundtrip failed for case 1');

    vectors.testCases.push({
      name: 'simple_short_text',
      plaintext,
      iv,
      encrypted,
    });
  }

  // --- Test case 2: Unicode / emoji content ---
  {
    const plaintext = 'Session: Debug login flow \u2014 fixed null check in handleAuth()';
    const fixedIv = new Uint8Array([20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
    const { encrypted, iv } = await encrypt(plaintext, key, fixedIv);
    const decrypted = await decrypt(encrypted, iv, key);
    if (decrypted !== plaintext) throw new Error('Roundtrip failed for case 2');

    vectors.testCases.push({
      name: 'unicode_text',
      plaintext,
      iv,
      encrypted,
    });
  }

  // --- Test case 3: JSON message content (realistic agent message) ---
  {
    const plaintext = JSON.stringify({
      role: 'assistant',
      content: 'I\'ll help you fix that bug. Let me read the file first.',
      tool_calls: [{ name: 'Read', arguments: { file_path: '/src/auth.ts' } }],
    });
    const fixedIv = new Uint8Array([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111]);
    const { encrypted, iv } = await encrypt(plaintext, key, fixedIv);
    const decrypted = await decrypt(encrypted, iv, key);
    if (decrypted !== plaintext) throw new Error('Roundtrip failed for case 3');

    vectors.testCases.push({
      name: 'json_message',
      plaintext,
      iv,
      encrypted,
    });
  }

  // --- Test case 4: Empty string ---
  {
    const plaintext = '';
    const fixedIv = new Uint8Array([200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211]);
    const { encrypted, iv } = await encrypt(plaintext, key, fixedIv);
    const decrypted = await decrypt(encrypted, iv, key);
    if (decrypted !== plaintext) throw new Error('Roundtrip failed for case 4');

    vectors.testCases.push({
      name: 'empty_string',
      plaintext,
      iv,
      encrypted,
    });
  }

  // --- Test case 5: Project ID with fixed IV (deterministic) ---
  {
    const projectId = '/Users/ghinkle/sources/stravu-editor';
    const { encrypted, iv } = await encrypt(projectId, key, PROJECT_ID_FIXED_IV);
    const decrypted = await decrypt(encrypted, iv, key);
    if (decrypted !== projectId) throw new Error('Roundtrip failed for case 5');

    vectors.testCases.push({
      name: 'project_id_fixed_iv',
      plaintext: projectId,
      iv,
      encrypted,
      note: 'Uses fixed IV for deterministic encryption (PROJECT_ID_FIXED_IV = "project_id_i")',
    });
  }

  // --- Test case 6: Large content (multi-KB) ---
  {
    const plaintext = 'A'.repeat(4096);
    const fixedIv = new Uint8Array([50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61]);
    const { encrypted, iv } = await encrypt(plaintext, key, fixedIv);
    const decrypted = await decrypt(encrypted, iv, key);
    if (decrypted !== plaintext) throw new Error('Roundtrip failed for case 6');

    vectors.testCases.push({
      name: 'large_content_4kb',
      plaintext,
      iv,
      encrypted,
    });
  }

  console.log(JSON.stringify(vectors, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
