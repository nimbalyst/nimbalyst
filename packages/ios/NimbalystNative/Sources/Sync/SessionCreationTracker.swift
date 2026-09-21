import Foundation
import Combine
import GRDB

/// Completes only this device's requests, after the returned session is readable
/// locally. An acknowledgement can precede index ingestion (or arrive twice).
@MainActor
final class SessionCreationTracker: ObservableObject {
    struct Completion {
        let requestId: String
        let sessionId: String?
        let error: String?
    }

    @Published private(set) var completion: Completion?
    private struct Pending {
        var sessionId: String?
        let timeout: Task<Void, Never>
        var observation: AnyDatabaseCancellable?
    }
    private var pending: [String: Pending] = [:]
    private let database: DatabaseManager
    private let lookup: (String) -> Void
    private let onReady: (String, String) -> Void
    private let timeout: Duration

    init(database: DatabaseManager, timeout: Duration = .seconds(30), lookup: @escaping (String) -> Void, onReady: @escaping (String, String) -> Void) {
        self.database = database
        self.timeout = timeout
        self.lookup = lookup
        self.onReady = onReady
    }

    func register(_ requestId: String) {
        let timeout = self.timeout
        let task = Task { [weak self] in
            do { try await Task.sleep(for: timeout) } catch { return }
            self?.finish(requestId, error: "The new session did not become available. It may still have been created; refresh the list before trying again.")
        }
        pending[requestId] = Pending(timeout: task)
    }

    func receive(_ response: CreateSessionResponse) {
        guard var request = pending[response.requestId], request.sessionId == nil else { return }
        guard response.success, let sessionId = response.sessionId, !sessionId.isEmpty else {
            finish(response.requestId, error: response.error ?? "The desktop did not return a created session.")
            return
        }
        request.sessionId = sessionId
        pending[response.requestId] = request
        resolveAvailable()
        guard pending[response.requestId] != nil else { return }
        // Observe the committed row rather than an ingestion callback: lookup
        // pages, legacy broadcasts and a reconnect all write through this DB.
        let observation = ValueObservation.tracking { db in
            try Session.fetchOne(db, key: sessionId) != nil
        }.start(in: database.writer, onError: { [weak self] error in
            self?.finish(response.requestId, error: "Could not load the created session: \(error.localizedDescription)")
        }, onChange: { [weak self] exists in
            guard exists else { return }
            self?.finish(response.requestId, sessionId: sessionId)
        })
        pending[response.requestId]?.observation = observation
        lookup(sessionId)
    }

    func resolveAvailable() {
        for (requestId, request) in pending {
            guard let sessionId = request.sessionId else { continue }
            do {
                guard try database.session(byId: sessionId) != nil else { continue }
                finish(requestId, sessionId: sessionId)
            } catch {
                finish(requestId, error: "Could not load the created session: \(error.localizedDescription)")
            }
        }
    }

    func cancel() {
        for request in pending.values {
            request.timeout.cancel()
            request.observation?.cancel()
        }
        pending.removeAll()
        completion = nil
    }

    private func finish(_ requestId: String, sessionId: String? = nil, error: String? = nil) {
        guard let request = pending.removeValue(forKey: requestId) else { return }
        request.timeout.cancel()
        request.observation?.cancel()
        completion = Completion(requestId: requestId, sessionId: sessionId, error: error)
        if let sessionId { onReady(requestId, sessionId) }
    }
}
