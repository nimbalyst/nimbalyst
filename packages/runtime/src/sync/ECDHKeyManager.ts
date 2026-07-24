/**
 * ECDHKeyManager
 *
 * Manages ECDH P-256 identity key pairs for document key exchange.
 * Handles:
 * - Key pair generation
 * - Public key export (JWK format)
 * - Document key wrapping (for sharing with another user)
 * - Document key unwrapping (for receiving a shared document key)
 *
 * The identity key pair is generated once per user and stored securely
 * (Electron safeStorage / iOS Keychain). The public key is uploaded to
 * the server so other users can wrap document keys for this user.
 *
 * Key exchange flow:
 * 1. Each user generates an ECDH P-256 key pair
 * 2. Public keys are uploaded to the server (safe -- they're public)
 * 3. To share a document key with user B:
 *    a. Fetch B's public key from server
 *    b. Derive shared secret: ECDH(A.privateKey, B.publicKey)
 *    c. Use shared secret to wrap (encrypt) the document key
 *    d. Upload wrapped key envelope to DocumentRoom
 * 4. User B retrieves their envelope:
 *    a. Derive same shared secret: ECDH(B.privateKey, A.publicKey)
 *    b. Unwrap (decrypt) the document key
 */

// ============================================================================
// Base64 Utilities
// ============================================================================

const CHUNK_SIZE = 8192;

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (bytes.length < 1024) {
    return btoa(String.fromCharCode(...bytes));
  }
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    result += String.fromCharCode(...chunk);
  }
  return btoa(result);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ============================================================================
// Types
// ============================================================================

export interface ECDHKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export interface SerializedECDHKeyPair {
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

export interface KeyEnvelope {
  wrappedKey: string;       // base64 AES-GCM wrapped document key
  iv: string;               // base64 IV used for wrapping
  senderPublicKey: string;  // JSON-stringified JWK of sender's public key
}

// ============================================================================
// ECDHKeyManager
// ============================================================================

export class ECDHKeyManager {
  private keyPair: ECDHKeyPair | null = null;

  /**
   * Generate a new ECDH P-256 key pair.
   * The private key is extractable so it can be serialized for secure storage.
   */
  async generateKeyPair(): Promise<ECDHKeyPair> {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true, // extractable for serialization to secure storage
      ['deriveKey', 'deriveBits']
    );
    this.keyPair = keyPair;
    return keyPair;
  }

  /**
   * Set an existing key pair (loaded from secure storage).
   */
  setKeyPair(keyPair: ECDHKeyPair): void {
    this.keyPair = keyPair;
  }

  /**
   * Get the current key pair.
   */
  getKeyPair(): ECDHKeyPair | null {
    return this.keyPair;
  }

  /**
   * Export the public key as a JWK string (for uploading to server).
   */
  async exportPublicKeyJwk(): Promise<string> {
    if (!this.keyPair) throw new Error('No key pair loaded');
    const jwk = await crypto.subtle.exportKey('jwk', this.keyPair.publicKey);
    return JSON.stringify(jwk);
  }

  /**
   * Serialize the key pair for secure storage.
   * Both keys are exported as JWK.
   */
  async serializeKeyPair(): Promise<SerializedECDHKeyPair> {
    if (!this.keyPair) throw new Error('No key pair loaded');
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', this.keyPair.publicKey);
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', this.keyPair.privateKey);
    return { publicKeyJwk, privateKeyJwk };
  }

  /**
   * Deserialize a key pair from secure storage.
   */
  async deserializeKeyPair(serialized: SerializedECDHKeyPair): Promise<ECDHKeyPair> {
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      serialized.publicKeyJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      serialized.privateKeyJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );
    this.keyPair = { publicKey, privateKey };
    return this.keyPair;
  }

  /**
   * Wrap a document key for a target user using ECDH key agreement.
   *
   * @param documentKey - The AES-256-GCM document key to share
   * @param recipientPublicKeyJwk - The recipient's public key (JWK string from server)
   * @returns A KeyEnvelope containing the wrapped key, IV, and sender's public key
   */
  async wrapDocumentKey(
    documentKey: CryptoKey,
    recipientPublicKeyJwk: string
  ): Promise<KeyEnvelope> {
    if (!this.keyPair) throw new Error('No key pair loaded');

    // Import recipient's public key
    const recipientPubKey = await crypto.subtle.importKey(
      'jwk',
      JSON.parse(recipientPublicKeyJwk),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    // Derive shared wrapping key via ECDH
    const wrappingKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: recipientPubKey },
      this.keyPair.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['wrapKey']
    );

    // Wrap the document key
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrappedKeyBuffer = await crypto.subtle.wrapKey(
      'raw',
      documentKey,
      wrappingKey,
      { name: 'AES-GCM', iv }
    );

    // Export sender's public key for the envelope
    const senderPublicKeyJwk = await this.exportPublicKeyJwk();

    return {
      wrappedKey: uint8ArrayToBase64(new Uint8Array(wrappedKeyBuffer)),
      iv: uint8ArrayToBase64(iv),
      senderPublicKey: senderPublicKeyJwk,
    };
  }

  /**
   * Unwrap a document key from a key envelope using ECDH key agreement.
   *
   * @param envelope - The KeyEnvelope received from the DocumentRoom
   * @returns The unwrapped AES-256-GCM document key
   */
  async unwrapDocumentKey(envelope: KeyEnvelope): Promise<CryptoKey> {
    if (!this.keyPair) throw new Error('No key pair loaded');

    // Import sender's public key from the envelope
    const senderPubKey = await crypto.subtle.importKey(
      'jwk',
      JSON.parse(envelope.senderPublicKey),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    // Derive the same shared wrapping key via ECDH
    const wrappingKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: senderPubKey },
      this.keyPair.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['unwrapKey']
    );

    // Unwrap the document key
    const documentKey = await crypto.subtle.unwrapKey(
      'raw',
      base64ToUint8Array(envelope.wrappedKey) as BufferSource,
      wrappingKey,
      { name: 'AES-GCM', iv: base64ToUint8Array(envelope.iv) as BufferSource },
      { name: 'AES-GCM', length: 256 },
      true, // extractable so it can be re-wrapped for other users
      ['encrypt', 'decrypt']
    );

    return documentKey;
  }

  /**
   * Unwrap a document key, verifying the sender's public key matches an expected key.
   *
   * This cross-checks the senderPublicKey in the envelope against the sender's
   * registered identity key fetched from the server. If they don't match, the
   * envelope may have been tampered with (Finding 2 in security review).
   *
   * @param envelope - The KeyEnvelope received from the server
   * @param expectedSenderPublicKeyJwk - The sender's registered public key (from GET /api/identity-key)
   * @returns The unwrapped AES-256-GCM document key
   * @throws If the sender key in the envelope doesn't match the expected sender key
   */
  async unwrapDocumentKeyVerified(
    envelope: KeyEnvelope,
    expectedSenderPublicKeyJwk: string
  ): Promise<CryptoKey> {
    if (envelope.senderPublicKey !== expectedSenderPublicKeyJwk) {
      throw new Error(
        'Sender public key mismatch: envelope sender key does not match registered identity key'
      );
    }
    return this.unwrapDocumentKey(envelope);
  }

  /**
   * Generate a new random AES-256-GCM document key.
   */
  static async generateDocumentKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true, // extractable for wrapping/sharing
      ['encrypt', 'decrypt']
    );
  }
}

/**
 * Create an ECDHKeyManager instance.
 */
export function createECDHKeyManager(): ECDHKeyManager {
  return new ECDHKeyManager();
}
