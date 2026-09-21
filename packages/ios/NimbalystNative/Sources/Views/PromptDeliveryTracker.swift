import Foundation
import Combine

/// Tracks evidence of desktop activity, not a durable per-prompt receipt.
/// A timeout therefore reports uncertainty and never invites an automatic resend.
@MainActor
final class PromptDeliveryTracker: ObservableObject {
    @Published var warning: String?
    private struct Pending {
        let id: UUID
        let sessionId: String
        let startedAt: Int
        let existingMessageIds: Set<String>
        var confirmed: Bool
    }
    private var pending: Pending?
    private var timer: Task<Void, Never>?
    private let timeout: Duration

    init(timeout: Duration = .seconds(10)) { self.timeout = timeout }

    func begin(sessionId: String, isExecuting: Bool, messages: [Message], now: Int) -> UUID {
        cancel()
        let id = UUID()
        // A prompt queued behind an active turn should not demand a new
        // idle -> running transition within ten seconds.
        pending = Pending(id: id, sessionId: sessionId, startedAt: now,
                          existingMessageIds: Set(messages.map(\.id)), confirmed: isExecuting)
        return id
    }

    func sent(_ id: UUID) {
        guard let pending, pending.id == id, !pending.confirmed else { return }
        timer?.cancel()
        timer = Task { [weak self, timeout] in
            do { try await Task.sleep(for: timeout) } catch { return }
            self?.expire(id)
        }
    }

    func observeExecution(sessionId: String, isExecuting: Bool) {
        guard pending?.sessionId == sessionId, isExecuting else { return }
        confirmActivity()
    }

    func observeMessages(_ messages: [Message]) {
        guard let pending, !pending.confirmed else { return }
        // Local optimistic user messages and old history loaded after sending
        // are not evidence the desktop processed this submission.
        if messages.contains(where: {
            $0.sessionId == pending.sessionId && $0.direction == "output" && $0.source != "system"
                && $0.createdAt >= pending.startedAt && !pending.existingMessageIds.contains($0.id)
        }) { confirmActivity() }
    }

    func expire(_ id: UUID) {
        guard let pending, pending.id == id, !pending.confirmed else { return }
        warning = "Your prompt was sent, but this device hasn't confirmed desktop activity yet. Check the session before sending again."
    }

    @discardableResult
    func failed(_ id: UUID) -> Bool {
        guard pending?.id == id else { return false }
        cancel()
        return true
    }

    func cancel() {
        timer?.cancel()
        timer = nil
        pending = nil
        warning = nil
    }

    private func confirmActivity() {
        pending?.confirmed = true
        timer?.cancel()
        timer = nil
        warning = nil
    }
}
