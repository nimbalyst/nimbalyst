import Foundation
import Combine

struct SessionCreationOptions {
    let projectId: String
    var initialPrompt: String? = nil
    var sessionType: String? = nil
    var parentSessionId: String? = nil
    var provider: String? = nil
    var model: String? = nil
    var agentRole: String? = nil
    var targetDeviceId: String? = nil
}

/// Owns only this phone's requests; broadcasts for other devices cannot finish
/// its spinner or navigate its UI. A timeout reports uncertainty, never retries.
@MainActor
public final class SessionCreationRequests: ObservableObject {
    @Published public private(set) var pendingCount = 0
    @Published public var errorMessage: String? {
        didSet { errorRevision &+= 1 }
    }
    var onFailure: ((String, String) -> Void)?
    private var errorRevision: UInt64 = 0
    private var pending: [String: Task<Void, Never>] = [:]
    private let timeoutNanoseconds: UInt64

    init(timeoutNanoseconds: UInt64 = 30_000_000_000) {
        self.timeoutNanoseconds = timeoutNanoseconds
    }

    /// SwiftUI may dismiss the alert during a view update. Publish afterward,
    /// and preserve any error that arrived since the dismissal was requested.
    func dismissError() {
        guard errorMessage != nil else { return }
        let revision = errorRevision
        DispatchQueue.main.async { [weak self] in
            guard let self, self.errorRevision == revision, self.errorMessage != nil else { return }
            self.errorMessage = nil
        }
    }

    func create(
        _ options: SessionCreationOptions,
        crypto: CryptoManager,
        devices: [DeviceInfo],
        isConnected: Bool,
        onRegistered: (String) -> Void = { _ in },
        send: (String, @escaping @MainActor @Sendable (Error?) -> Void) -> Void
    ) throws -> String {
        do {
            guard isConnected else { throw CreationError("Connect to sync before creating a session.") }
            let target: DeviceInfo?
            if let selectedId = options.targetDeviceId {
                target = devices.first { $0.deviceId == selectedId && ($0.type == "desktop" || $0.type == "headless") }
            } else {
                // An unattended sandbox always reports active. It must never
                // outrank the user's desktop merely because the Mac is away.
                target = devices.filter { $0.type == "desktop" }.sorted {
                    if ($0.isFocused == true) != ($1.isFocused == true) { return $0.isFocused == true }
                    if $0.lastActiveAt != $1.lastActiveAt { return $0.lastActiveAt > $1.lastActiveAt }
                    return $0.deviceId < $1.deviceId
                }.first
            }
            guard let target else {
                throw CreationError(options.targetDeviceId == nil
                    ? "No desktop is connected. Open Nimbalyst on your computer and try again."
                    : "The selected machine is not connected.")
            }
            let prompt = try options.initialPrompt.map { try crypto.encrypt(plaintext: $0) }
            let requestId = UUID().uuidString
            let message = CreateSessionRequestMessage(
                request: EncryptedCreateSessionRequest(
                    requestId: requestId,
                    encryptedProjectId: try crypto.encryptProjectId(options.projectId),
                    projectIdIv: CryptoManager.projectIdIvBase64,
                    encryptedInitialPrompt: prompt?.encrypted,
                    initialPromptIv: prompt?.iv,
                    sessionType: options.sessionType,
                    parentSessionId: options.parentSessionId,
                    provider: options.provider,
                    model: options.model,
                    agentRole: options.agentRole,
                    timestamp: Int(Date().timeIntervalSince1970 * 1000)
                ),
                targetDeviceId: target.deviceId
            )
            let json = String(decoding: try JSONEncoder().encode(message), as: UTF8.self)
            errorMessage = nil
            pending[requestId] = Task { [weak self, timeoutNanoseconds] in
                do { try await Task.sleep(nanoseconds: timeoutNanoseconds) } catch { return }
                self?.fail(requestId, message: "The desktop did not confirm session creation. It may still appear; check the session list before trying again.")
            }
            pendingCount = pending.count
            onRegistered(requestId)
            send(json) { [weak self] error in
                if let error { self?.fail(requestId, message: error.localizedDescription) }
            }
            return requestId
        } catch {
            errorMessage = error.localizedDescription
            throw error
        }
    }

    /// Returns true only for a successful response to one of our pending requests.
    func receive(_ response: CreateSessionResponse) -> Bool {
        guard finish(response.requestId) else { return false }
        guard response.success, let sessionId = response.sessionId, !sessionId.isEmpty else {
            errorMessage = response.error ?? "The desktop did not return a session."
            return false
        }
        return true
    }

    func disconnect() {
        guard !pending.isEmpty else { return }
        for requestId in Array(pending.keys) {
            fail(requestId, message: "Disconnected before session creation was confirmed. Check the session list after reconnecting before trying again.")
        }
    }

    private func fail(_ requestId: String, message: String) {
        guard finish(requestId) else { return }
        errorMessage = message
        onFailure?(requestId, message)
    }

    private func finish(_ requestId: String) -> Bool {
        guard let task = pending.removeValue(forKey: requestId) else { return false }
        task.cancel()
        pendingCount = pending.count
        return true
    }
}

private struct CreationError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}
