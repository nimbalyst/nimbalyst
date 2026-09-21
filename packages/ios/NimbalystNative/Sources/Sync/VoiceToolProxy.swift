import Foundation
import os

/// Runs a desktop-hosted voice tool (project memory, for example) over the sync
/// channel and resumes the caller with the answer.
///
/// The timeout lives in `SyncRequestRegistry`, not here: a request that never
/// left the socket used to wait the full window for a send that had already
/// failed. This type owns only the continuations and the encryption.
@MainActor
public final class VoiceToolProxy {
    public struct Result {
        public let success: Bool
        public let result: String?
        public let error: String?
    }

    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "VoiceToolProxy")
    private let crypto: CryptoManager
    private let decoder = JSONDecoder()
    /// Continuations awaiting a desktop answer, keyed by requestId.
    private var pendingScopes: [String: VoiceRelayScope] = [:]
    private var pending: [String: CheckedContinuation<Result, Never>] = [:]

    /// Hands the encoded request to the registry, which owns send outcome and
    /// timeout and reports failures back through `fail(_:message:)`.
    private let send: (String, String) -> Void

    init(crypto: CryptoManager, send: @escaping (String, String) -> Void) {
        self.crypto = crypto
        self.send = send
    }

    func call(toolName: String, argsJson: String, projectId: String, scope: VoiceRelayScope? = nil) async -> Result {
        let encryptedProjectId: String
        let toolNameEnc: (encrypted: String, iv: String)
        let argsEnc: (encrypted: String, iv: String)
        do {
            encryptedProjectId = try crypto.encryptProjectId(projectId)
            toolNameEnc = try crypto.encrypt(plaintext: toolName)
            argsEnc = try crypto.encrypt(plaintext: argsJson)
        } catch {
            return Result(success: false, result: nil, error: "Failed to encrypt voice tool request")
        }

        let requestId = UUID().uuidString
        let message = VoiceToolRequestMessage(
            request: EncryptedVoiceToolRequest(
                requestId: requestId,
                encryptedProjectId: encryptedProjectId,
                projectIdIv: CryptoManager.projectIdIvBase64,
                encryptedToolName: toolNameEnc.encrypted,
                toolNameIv: toolNameEnc.iv,
                encryptedArgs: argsEnc.encrypted,
                argsIv: argsEnc.iv,
                timestamp: Int(Date().timeIntervalSince1970 * 1000)
            )
        )

        guard let data = try? JSONEncoder().encode(message),
              let json = String(data: data, encoding: .utf8) else {
            return Result(success: false, result: nil, error: "Failed to encode voice tool request")
        }

        return await withCheckedContinuation { continuation in
            pendingScopes[requestId] = scope
            pending[requestId] = continuation
            send(requestId, json)
        }
    }

    /// Apply the desktop's answer. Returns the requestId so the caller can
    /// close out the registry entry, whether or not we were still waiting.
    @discardableResult
    func receive(_ data: Data) -> String? {
        guard let broadcast = try? decoder.decode(VoiceToolResponseBroadcast.self, from: data) else {
            logger.error("Failed to decode voiceToolResponseBroadcast")
            return nil
        }
        let response = broadcast.response
        guard let continuation = pending[response.requestId] else {
            return response.requestId // already resolved by timeout, or not ours
        }
        var resultText: String?
        if let enc = response.encryptedResult, let iv = response.resultIv {
            resultText = crypto.decryptOrNil(encryptedBase64: enc, ivBase64: iv)
        }
        if let expected = pendingScopes[response.requestId] {
            guard let text = resultText, let data = text.data(using: .utf8),
                  let verified = try? decoder.decode(VoiceRelayResponse.self, from: data), verified.scope == expected else {
                // Old clients and unrelated hosts cannot settle this request, even with an error.
                return nil
            }
            pendingScopes.removeValue(forKey: response.requestId)
            pending.removeValue(forKey: response.requestId)
            continuation.resume(returning: Result(success: verified.success, result: verified.result, error: verified.error))
            return response.requestId
        }
        pending.removeValue(forKey: response.requestId)
        var errorText: String?
        if let enc = response.encryptedError, let iv = response.errorIv {
            errorText = crypto.decryptOrNil(encryptedBase64: enc, ivBase64: iv)
        }
        continuation.resume(returning: Result(success: response.success, result: resultText, error: errorText))
        return response.requestId
    }

    /// Resume a caller the registry gave up on.
    func fail(_ requestId: String, message: String) {
        pendingScopes.removeValue(forKey: requestId)
        guard let continuation = pending.removeValue(forKey: requestId) else { return }
        continuation.resume(returning: Result(success: false, result: nil, error: message))
    }
}
