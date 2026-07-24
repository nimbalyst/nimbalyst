import XCTest
@testable import NimbalystNative
import CryptoKit

/// Tests for the production CryptoManager, using the same test vectors
/// as the CryptoCompatibility package to verify wire format compatibility
/// with the JavaScript Web Crypto API / node-forge implementations.
final class CryptoManagerTests: XCTestCase {

    // Test vector inputs (same as CryptoCompatibility)
    static let passphrase = "dGVzdC1lbmNyeXB0aW9uLWtleS1zZWVkLWZvci10ZXN0cw=="
    static let salt = "nimbalyst:user-test-12345"
    static let expectedKeyBase64 = "cVkuSqOYHOm1+QB5kTWOvRCHFzqKzjtsU+7XVBvX8fg="

    private var crypto: CryptoManager!

    override func setUp() {
        super.setUp()
        let key = CryptoManager.deriveKey(passphrase: Self.passphrase, salt: Self.salt)
        crypto = CryptoManager(key: key)
    }

    // MARK: - Key Derivation

    func testKeyDerivationMatchesJS() throws {
        let key = CryptoManager.deriveKey(passphrase: Self.passphrase, salt: Self.salt)
        let keyData = key.withUnsafeBytes { Data($0) }
        let keyBase64 = keyData.base64EncodedString()
        XCTAssertEqual(keyBase64, Self.expectedKeyBase64,
                       "PBKDF2 derived key does not match JS Web Crypto output")
    }

    func testConvenienceInitWithSeedAndUserId() throws {
        // The convenience init constructs salt as "nimbalyst:{userId}"
        let crypto = CryptoManager(seed: Self.passphrase, userId: "user-test-12345")
        // Verify it can decrypt the same test vectors
        let plaintext = try crypto.decrypt(
            encryptedBase64: "07DfjrYjG0f1/3swnwWVpq6LsGZnw02+Kx4vzmu78YPm",
            ivBase64: "AQIDBAUGBwgJCgsM"
        )
        XCTAssertEqual(plaintext, "Hello, Nimbalyst!")
    }

    // MARK: - Decryption (JS-produced ciphertexts)

    func testDecryptSimpleShortText() throws {
        let plaintext = try crypto.decrypt(
            encryptedBase64: "07DfjrYjG0f1/3swnwWVpq6LsGZnw02+Kx4vzmu78YPm",
            ivBase64: "AQIDBAUGBwgJCgsM"
        )
        XCTAssertEqual(plaintext, "Hello, Nimbalyst!")
    }

    func testDecryptUnicodeText() throws {
        let plaintext = try crypto.decrypt(
            encryptedBase64: "p7FcYa3KkKtIwUjEMQg5g6rjfd02RAyJo1z3joLvbl/Zi+lZ8CfCLJTHkS/aCK2KaSsrPH4fv7jnuTZE9ZfBR1MdZF4SpvYCdXXKhBb8",
            ivBase64: "FBUWFxgZGhscHR4f"
        )
        XCTAssertEqual(plaintext, "Session: Debug login flow \u{2014} fixed null check in handleAuth()")
    }

    func testDecryptJSONMessage() throws {
        let plaintext = try crypto.decrypt(
            encryptedBase64: "T6DMLttdGBVKtagXpQDopEcg4SXI94PGQaYOnCqFqnb52DGkNUuziPnWxc98mLWzlxfCSnJSdpRWGk1oNj66muBha4aegwZN+Riok5kKvxiIKMc3trMudMZvfFUb3DI/cwKIdGYM4Wu6wjkG6ZMJQgu9I/tQojmpeA92GCdrHOZmTigOr6wC8GWhBmTxAU04WnAiznQmdw1DxBGNMCqpkDekEDoXaKGjd0gAYIoCkmE=",
            ivBase64: "ZGVmZ2hpamtsbW5v"
        )

        let expectedJSON = """
        {"role":"assistant","content":"I'll help you fix that bug. Let me read the file first.","tool_calls":[{"name":"Read","arguments":{"file_path":"/src/auth.ts"}}]}
        """
        XCTAssertEqual(plaintext, expectedJSON)
    }

    func testDecryptEmptyString() throws {
        let plaintext = try crypto.decrypt(
            encryptedBase64: "f1NWNoC52uksPpTiUS+JsQ==",
            ivBase64: "yMnKy8zNzs/Q0dLT"
        )
        XCTAssertEqual(plaintext, "")
    }

    func testDecryptProjectIdFixedIV() throws {
        let plaintext = try crypto.decrypt(
            encryptedBase64: "H1T7Lpn6jiQaYXIFnwfeUGC5RmzhJP2NN1XvmexO3MDcJqIRur7fEhX0gu/nFZclT4WlhA==",
            ivBase64: "cHJvamVjdF9pZF9p"
        )
        XCTAssertEqual(plaintext, "/Users/ghinkle/sources/stravu-editor")
    }

    // MARK: - Encryption

    func testRoundtrip() throws {
        let original = "Swift CryptoManager roundtrip test"
        let (encrypted, iv) = try crypto.encrypt(plaintext: original)
        let decrypted = try crypto.decrypt(encryptedBase64: encrypted, ivBase64: iv)
        XCTAssertEqual(decrypted, original)
    }

    func testDeterministicEncryptionMatchesJS() throws {
        let projectId = "/Users/ghinkle/sources/stravu-editor"
        let encrypted = try crypto.encryptProjectId(projectId)
        XCTAssertEqual(encrypted, "H1T7Lpn6jiQaYXIFnwfeUGC5RmzhJP2NN1XvmexO3MDcJqIRur7fEhX0gu/nFZclT4WlhA==",
                       "Deterministic encryption output should match JS exactly")
    }

    // MARK: - Error Cases

    func testWrongKeyFailsDecryption() throws {
        let wrongKey = SymmetricKey(size: .bits256)
        let wrongCrypto = CryptoManager(key: wrongKey)
        XCTAssertThrowsError(try wrongCrypto.decrypt(
            encryptedBase64: "07DfjrYjG0f1/3swnwWVpq6LsGZnw02+Kx4vzmu78YPm",
            ivBase64: "AQIDBAUGBwgJCgsM"
        ))
    }

    func testTamperedCiphertextFailsDecryption() throws {
        var tamperedData = Data(base64Encoded: "07DfjrYjG0f1/3swnwWVpq6LsGZnw02+Kx4vzmu78YPm")!
        tamperedData[0] ^= 0xFF
        let tampered = tamperedData.base64EncodedString()

        XCTAssertThrowsError(try crypto.decrypt(
            encryptedBase64: tampered,
            ivBase64: "AQIDBAUGBwgJCgsM"
        ))
    }

    // MARK: - Convenience Methods

    func testDecryptOrNilReturnsNilOnFailure() {
        let result = crypto.decryptOrNil(encryptedBase64: "invalid", ivBase64: "also-invalid")
        XCTAssertNil(result)
    }

    func testDecryptOrNilReturnsNilForNilInputs() {
        let result = crypto.decryptOrNil(encryptedBase64: nil, ivBase64: nil)
        XCTAssertNil(result)
    }

    func testDecryptOrNilReturnsValueOnSuccess() {
        let result = crypto.decryptOrNil(
            encryptedBase64: "07DfjrYjG0f1/3swnwWVpq6LsGZnw02+Kx4vzmu78YPm",
            ivBase64: "AQIDBAUGBwgJCgsM"
        )
        XCTAssertEqual(result, "Hello, Nimbalyst!")
    }
}
