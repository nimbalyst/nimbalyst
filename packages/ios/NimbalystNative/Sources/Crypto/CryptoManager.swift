import Foundation
import CryptoKit
import CommonCrypto

/// Handles all encryption/decryption operations using CryptoKit AES-256-GCM.
/// Compatible with the JavaScript Web Crypto API / node-forge implementations
/// used in the Nimbalyst desktop and mobile web apps.
///
/// Wire format:
///   - Key derivation: PBKDF2-SHA256, 100k iterations, 256-bit output
///   - Encryption: AES-256-GCM
///   - IV: 12 bytes, base64-encoded
///   - Ciphertext: base64-encoded (ciphertext || 16-byte auth tag)
public final class CryptoManager: @unchecked Sendable {
    private let key: SymmetricKey

    /// Fixed IV for deterministic project ID encryption (base64 of "project_id_i").
    public static let projectIdIvBase64 = "cHJvamVjdF9pZF9p"

    // MARK: - Initialization

    /// Initialize with a pre-derived symmetric key.
    public init(key: SymmetricKey) {
        self.key = key
    }

    /// Initialize by deriving a key from the pairing seed and user ID.
    /// The seed is the base64-encoded encryption key from QR pairing.
    /// The salt format is "nimbalyst:{userId}".
    public convenience init(seed: String, userId: String) {
        let salt = "nimbalyst:\(userId)"
        let key = Self.deriveKey(passphrase: seed, salt: salt)
        self.init(key: key)
    }

    // MARK: - Key Derivation

    /// Derive a 256-bit AES key using PBKDF2-SHA256, matching the JS implementation.
    public static func deriveKey(passphrase: String, salt: String) -> SymmetricKey {
        let passphraseData = Data(passphrase.utf8)
        let saltData = Data(salt.utf8)

        var derivedKeyBytes = [UInt8](repeating: 0, count: 32)
        let status = derivedKeyBytes.withUnsafeMutableBufferPointer { derivedKeyBuffer in
            passphraseData.withUnsafeBytes { passphraseBuffer in
                saltData.withUnsafeBytes { saltBuffer in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        passphraseBuffer.baseAddress!.assumingMemoryBound(to: Int8.self),
                        passphraseData.count,
                        saltBuffer.baseAddress!.assumingMemoryBound(to: UInt8.self),
                        saltData.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                        100_000,
                        derivedKeyBuffer.baseAddress!,
                        32
                    )
                }
            }
        }
        precondition(status == kCCSuccess, "PBKDF2 derivation failed with status: \(status)")
        return SymmetricKey(data: derivedKeyBytes)
    }

    // MARK: - Decryption

    /// Decrypt an AES-GCM ciphertext produced by the JS implementation.
    ///
    /// The JS side returns `base64(ciphertext || tag)` where tag is 16 bytes.
    /// CryptoKit's `AES.GCM.SealedBox` expects (nonce, ciphertext, tag) separately,
    /// so we split the last 16 bytes off as the tag.
    public func decrypt(encryptedBase64: String, ivBase64: String) throws -> String {
        guard let combinedData = Data(base64Encoded: encryptedBase64),
              let ivData = Data(base64Encoded: ivBase64) else {
            throw CryptoError.invalidBase64
        }

        let tagLength = 16
        guard combinedData.count >= tagLength else {
            throw CryptoError.ciphertextTooShort
        }

        let ciphertext = combinedData[..<(combinedData.count - tagLength)]
        let tag = combinedData[(combinedData.count - tagLength)...]

        let nonce = try AES.GCM.Nonce(data: ivData)
        let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
        let decryptedData = try AES.GCM.open(sealedBox, using: key)

        guard let plaintext = String(data: decryptedData, encoding: .utf8) else {
            throw CryptoError.invalidUTF8
        }
        return plaintext
    }

    /// Decrypt, returning nil on failure instead of throwing.
    public func decryptOrNil(encryptedBase64: String?, ivBase64: String?) -> String? {
        guard let encrypted = encryptedBase64, let iv = ivBase64 else { return nil }
        return try? decrypt(encryptedBase64: encrypted, ivBase64: iv)
    }

    // MARK: - Encryption

    /// Encrypt a plaintext string using AES-GCM with a random IV.
    /// Returns a tuple of (encryptedBase64, ivBase64).
    public func encrypt(plaintext: String) throws -> (encrypted: String, iv: String) {
        let plaintextData = Data(plaintext.utf8)
        let sealedBox = try AES.GCM.seal(plaintextData, using: key)

        var combined = Data(sealedBox.ciphertext)
        combined.append(contentsOf: sealedBox.tag)

        let ivBase64 = Data(sealedBox.nonce).base64EncodedString()
        return (combined.base64EncodedString(), ivBase64)
    }

    /// Encrypt raw data using AES-GCM with a random IV.
    /// Returns a tuple of (encryptedBase64, ivBase64).
    public func encryptData(_ data: Data) throws -> (encrypted: String, iv: String) {
        let sealedBox = try AES.GCM.seal(data, using: key)

        var combined = Data(sealedBox.ciphertext)
        combined.append(contentsOf: sealedBox.tag)

        let ivBase64 = Data(sealedBox.nonce).base64EncodedString()
        return (combined.base64EncodedString(), ivBase64)
    }

    /// Encrypt with a fixed IV for deterministic output (e.g., project IDs).
    public func encryptDeterministic(plaintext: String, ivBase64: String) throws -> String {
        guard let ivData = Data(base64Encoded: ivBase64) else {
            throw CryptoError.invalidBase64
        }

        let nonce = try AES.GCM.Nonce(data: ivData)
        let plaintextData = Data(plaintext.utf8)
        let sealedBox = try AES.GCM.seal(plaintextData, using: key, nonce: nonce)

        var combined = Data(sealedBox.ciphertext)
        combined.append(contentsOf: sealedBox.tag)
        return combined.base64EncodedString()
    }

    /// Encrypt a project/workspace path using the fixed project ID IV.
    /// This produces deterministic output that can be matched across devices.
    public func encryptProjectId(_ workspacePath: String) throws -> String {
        try encryptDeterministic(plaintext: workspacePath, ivBase64: Self.projectIdIvBase64)
    }

    // MARK: - Errors

    enum CryptoError: Error, LocalizedError {
        case invalidBase64
        case ciphertextTooShort
        case invalidUTF8

        var errorDescription: String? {
            switch self {
            case .invalidBase64: return "Invalid base64 encoding"
            case .ciphertextTooShort: return "Ciphertext too short (less than 16 bytes for auth tag)"
            case .invalidUTF8: return "Decrypted data is not valid UTF-8"
            }
        }
    }
}
