import XCTest
import CryptoKit
import Foundation
import CommonCrypto

/// Tests that Swift CryptoKit can correctly derive keys and decrypt data
/// produced by the JavaScript Web Crypto API / node-forge implementations
/// used in the Nimbalyst desktop and mobile apps.
///
/// Wire format:
///   - Key derivation: PBKDF2-SHA256, 100k iterations, 256-bit output
///   - Encryption: AES-256-GCM
///   - IV: 12 bytes, base64-encoded
///   - Ciphertext: base64-encoded (ciphertext || 16-byte auth tag)
///
/// Run: swift test (from CryptoCompatibility package directory)
///       or via Xcode test target
final class CryptoCompatibilityTests: XCTestCase {

    // MARK: - Test Vector Data (from generate-test-vectors.mjs)

    // Key derivation inputs
    static let passphrase = "dGVzdC1lbmNyeXB0aW9uLWtleS1zZWVkLWZvci10ZXN0cw=="
    static let salt = "nimbalyst:user-test-12345"
    static let expectedKeyBase64 = "cVkuSqOYHOm1+QB5kTWOvRCHFzqKzjtsU+7XVBvX8fg="

    // MARK: - PBKDF2 Key Derivation

    /// Derive a 256-bit AES key using PBKDF2-SHA256, matching the JS implementation.
    static func deriveKey(passphrase: String, salt: String) -> SymmetricKey {
        let passphraseData = Data(passphrase.utf8)
        let saltData = Data(salt.utf8)

        // CryptoKit doesn't expose PBKDF2 directly, use CommonCrypto
        var derivedKeyBytes = [UInt8](repeating: 0, count: 32) // 256 bits
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

    /// Decrypt an AES-GCM ciphertext produced by the JS implementation.
    ///
    /// The JS side returns `base64(ciphertext || tag)` where tag is 16 bytes.
    /// CryptoKit's `AES.GCM.SealedBox` expects (nonce, ciphertext, tag) separately,
    /// so we split the last 16 bytes off as the tag.
    static func decrypt(encryptedBase64: String, ivBase64: String, key: SymmetricKey) throws -> String {
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

    /// Encrypt a plaintext string using AES-GCM, producing output in the same
    /// wire format as the JS implementation: base64(ciphertext || tag).
    static func encrypt(plaintext: String, ivBase64: String, key: SymmetricKey) throws -> String {
        guard let ivData = Data(base64Encoded: ivBase64) else {
            throw CryptoError.invalidBase64
        }

        let nonce = try AES.GCM.Nonce(data: ivData)
        let plaintextData = Data(plaintext.utf8)
        let sealedBox = try AES.GCM.seal(plaintextData, using: key, nonce: nonce)

        // Combine ciphertext + tag (same format as JS Web Crypto)
        var combined = Data(sealedBox.ciphertext)
        combined.append(contentsOf: sealedBox.tag)

        return combined.base64EncodedString()
    }

    enum CryptoError: Error {
        case invalidBase64
        case ciphertextTooShort
        case invalidUTF8
    }

    // MARK: - Derived key (shared across tests)

    static var derivedKey: SymmetricKey!

    override class func setUp() {
        super.setUp()
        derivedKey = deriveKey(passphrase: passphrase, salt: salt)
    }

    // =========================================================================
    // Tests
    // =========================================================================

    /// Verify PBKDF2 key derivation produces the same 256-bit key as Web Crypto API.
    func testKeyDerivationMatchesJS() throws {
        let key = Self.derivedKey!
        // Export raw key bytes
        let keyData = key.withUnsafeBytes { Data($0) }
        let keyBase64 = keyData.base64EncodedString()
        XCTAssertEqual(keyBase64, Self.expectedKeyBase64,
                       "PBKDF2 derived key does not match JS Web Crypto output")
    }

    /// Test case 1: Simple short text
    func testDecryptSimpleShortText() throws {
        let plaintext = try Self.decrypt(
            encryptedBase64: "07DfjrYjG0f1/3swnwWVpq6LsGZnw02+Kx4vzmu78YPm",
            ivBase64: "AQIDBAUGBwgJCgsM",
            key: Self.derivedKey
        )
        XCTAssertEqual(plaintext, "Hello, Nimbalyst!")
    }

    /// Test case 2: Unicode text with em-dash
    func testDecryptUnicodeText() throws {
        let plaintext = try Self.decrypt(
            encryptedBase64: "p7FcYa3KkKtIwUjEMQg5g6rjfd02RAyJo1z3joLvbl/Zi+lZ8CfCLJTHkS/aCK2KaSsrPH4fv7jnuTZE9ZfBR1MdZF4SpvYCdXXKhBb8",
            ivBase64: "FBUWFxgZGhscHR4f",
            key: Self.derivedKey
        )
        XCTAssertEqual(plaintext, "Session: Debug login flow \u{2014} fixed null check in handleAuth()")
    }

    /// Test case 3: JSON message content (realistic agent message)
    func testDecryptJSONMessage() throws {
        let plaintext = try Self.decrypt(
            encryptedBase64: "T6DMLttdGBVKtagXpQDopEcg4SXI94PGQaYOnCqFqnb52DGkNUuziPnWxc98mLWzlxfCSnJSdpRWGk1oNj66muBha4aegwZN+Riok5kKvxiIKMc3trMudMZvfFUb3DI/cwKIdGYM4Wu6wjkG6ZMJQgu9I/tQojmpeA92GCdrHOZmTigOr6wC8GWhBmTxAU04WnAiznQmdw1DxBGNMCqpkDekEDoXaKGjd0gAYIoCkmE=",
            ivBase64: "ZGVmZ2hpamtsbW5v",
            key: Self.derivedKey
        )

        let expectedJSON = """
        {"role":"assistant","content":"I'll help you fix that bug. Let me read the file first.","tool_calls":[{"name":"Read","arguments":{"file_path":"/src/auth.ts"}}]}
        """
        XCTAssertEqual(plaintext, expectedJSON)

        // Also verify it parses as valid JSON
        let data = plaintext.data(using: .utf8)!
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["role"] as? String, "assistant")
    }

    /// Test case 4: Empty string
    func testDecryptEmptyString() throws {
        let plaintext = try Self.decrypt(
            encryptedBase64: "f1NWNoC52uksPpTiUS+JsQ==",
            ivBase64: "yMnKy8zNzs/Q0dLT",
            key: Self.derivedKey
        )
        XCTAssertEqual(plaintext, "")
    }

    /// Test case 5: Project ID with fixed IV (deterministic encryption)
    func testDecryptProjectIdFixedIV() throws {
        let plaintext = try Self.decrypt(
            encryptedBase64: "H1T7Lpn6jiQaYXIFnwfeUGC5RmzhJP2NN1XvmexO3MDcJqIRur7fEhX0gu/nFZclT4WlhA==",
            ivBase64: "cHJvamVjdF9pZF9p",
            key: Self.derivedKey
        )
        XCTAssertEqual(plaintext, "/Users/ghinkle/sources/stravu-editor")
    }

    /// Test case 6: Large content (4KB)
    func testDecryptLargeContent() throws {
        let plaintext = try Self.decrypt(
            encryptedBase64: "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",
            ivBase64: "MjM0NTY3ODk6Ozw9",
            key: Self.derivedKey
        )
        XCTAssertEqual(plaintext.count, 4096)
        XCTAssertEqual(plaintext, String(repeating: "A", count: 4096))
    }

    // MARK: - Roundtrip Tests (Swift encrypt -> Swift decrypt)

    /// Encrypt in Swift, decrypt in Swift - basic sanity check.
    func testSwiftRoundtrip() throws {
        let key = Self.derivedKey!
        let plaintext = "Swift CryptoKit roundtrip test"
        let ivBase64 = Data([41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52]).base64EncodedString()

        let encrypted = try Self.encrypt(plaintext: plaintext, ivBase64: ivBase64, key: key)
        let decrypted = try Self.decrypt(encryptedBase64: encrypted, ivBase64: ivBase64, key: key)
        XCTAssertEqual(decrypted, plaintext)
    }

    // MARK: - Encrypt in Swift, verify JS can decrypt (deterministic with fixed IV)

    /// Encrypt the project ID with the fixed IV in Swift and verify the ciphertext
    /// matches the JS output byte-for-byte (deterministic encryption).
    func testDeterministicEncryptionMatchesJS() throws {
        let key = Self.derivedKey!
        let projectId = "/Users/ghinkle/sources/stravu-editor"
        let fixedIvBase64 = "cHJvamVjdF9pZF9p" // base64("project_id_i")

        let encrypted = try Self.encrypt(plaintext: projectId, ivBase64: fixedIvBase64, key: key)
        XCTAssertEqual(encrypted, "H1T7Lpn6jiQaYXIFnwfeUGC5RmzhJP2NN1XvmexO3MDcJqIRur7fEhX0gu/nFZclT4WlhA==",
                       "Deterministic encryption output should match JS exactly")
    }

    // MARK: - Error Cases

    /// Verify that a wrong key fails to decrypt (auth tag mismatch).
    func testWrongKeyFailsDecryption() throws {
        let wrongKey = SymmetricKey(size: .bits256)
        XCTAssertThrowsError(try Self.decrypt(
            encryptedBase64: "07DfjrYjG0f1/3swnwWVpq6LsGZnw02+Kx4vzmu78YPm",
            ivBase64: "AQIDBAUGBwgJCgsM",
            key: wrongKey
        ))
    }

    /// Verify that a tampered ciphertext fails to decrypt.
    func testTamperedCiphertextFailsDecryption() throws {
        // Flip a bit in the ciphertext
        var tamperedData = Data(base64Encoded: "07DfjrYjG0f1/3swnwWVpq6LsGZnw02+Kx4vzmu78YPm")!
        tamperedData[0] ^= 0xFF
        let tampered = tamperedData.base64EncodedString()

        XCTAssertThrowsError(try Self.decrypt(
            encryptedBase64: tampered,
            ivBase64: "AQIDBAUGBwgJCgsM",
            key: Self.derivedKey
        ))
    }
}
