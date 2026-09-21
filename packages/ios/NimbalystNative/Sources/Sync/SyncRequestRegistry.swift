import Foundation
import os

/// A sync failure worth telling the user about.
///
/// Produced by `SyncRequestRegistry` for sends that never landed and for
/// requests the desktop never answered, and by the decrypt/storage paths that
/// used to log and return. `retry` is present only where retrying is actually
/// meaningful; the banner that renders this lives outside the sync layer.
public struct SyncError: Identifiable {
    public enum Kind: String, Sendable {
        /// The frame never reached the socket, or the socket went away first.
        case transport
        /// A payload arrived but could not be read with this device's key.
        case decrypt
        /// The local database refused the write.
        case storage
        /// We sent a request and the desktop never answered.
        case requestTimeout
    }

    public let id: UUID
    public let kind: Kind
    public let message: String
    public let retry: (@MainActor () -> Void)?

    /// `id` is carried explicitly so `SyncErrorCoalescer` can update a banner in
    /// place. A fresh id means a new interruption and a new animation.
    public init(id: UUID = UUID(), kind: Kind, message: String, retry: (@MainActor () -> Void)? = nil) {
        self.id = id
        self.kind = kind
        self.message = message
        self.retry = retry
    }
}

extension SyncError.Kind {
    /// What the banner says once more than one operation has failed the same
    /// way. Naming one of them would be arbitrary, and restating each in turn is
    /// what made the banner flap between a draft and a read receipt.
    var coalescedMessage: String {
        switch self {
        case .transport:
            return "Some changes are saved on this device and may not have reached your desktop. They will be sent again when the connection returns."
        case .decrypt:
            return "Some messages could not be read with this device's key."
        case .storage:
            return "Some changes could not be saved on this device."
        case .requestTimeout:
            return "Your desktop has not answered. The requests may still have been applied."
        }
    }
}

/// What an outbound sync message is for.
///
/// The copy lives here rather than at each call site so a new send has to say
/// what the user loses when it fails, and so two sends of the same kind cannot
/// describe the same failure two different ways.
enum SyncRequestKind: String {
    case indexRequest
    case sessionSyncPage
    case draftPush
    case readReceipt
    case sessionControl
    case toolResult
    case pushToken
    case liveActivityToken
    case createWorktree
    case voiceTool
    case reparent

    /// Says what is uncertain. Never claims the operation failed outright: the
    /// frame can be delivered and then the socket error arrive, so "has not
    /// reached your desktop" is a claim this device cannot make. The kinds that
    /// re-publish on reconnect say so, because that is what makes the
    /// uncertainty survivable.
    var failureDescription: String {
        switch self {
        case .indexRequest, .sessionSyncPage:
            return "Could not reach the sync server. Pull to refresh once the connection returns."
        case .draftPush:
            return "Your draft is saved on this device and may not have reached your desktop. It will be sent again when the connection returns."
        case .readReceipt:
            return "Read state is saved on this device and may not have reached your desktop. It will be sent again when the connection returns."
        case .sessionControl:
            return "The desktop may not have received your response. Check the session before answering again."
        case .toolResult:
            return "Your response is saved on this device but may be missing from the transcript elsewhere."
        case .pushToken, .liveActivityToken:
            return "Notifications may not reach this device until it reconnects."
        case .createWorktree:
            return "The desktop did not confirm the new worktree. It may still appear; check the session list before trying again."
        case .voiceTool:
            return "Project memory is unavailable because your desktop isn't connected."
        case .reparent:
            return "The move is saved on this device and may not have reached your desktop. It will be sent again when the connection returns."
        }
    }

    /// Whether a failure here belongs in front of the user. Token registration
    /// and index paging are re-driven on the next connect by their owners, so
    /// they record the outcome and stay quiet.
    var isUserVisible: Bool {
        switch self {
        case .pushToken, .liveActivityToken, .indexRequest:
            return false
        default:
            return true
        }
    }
}

/// The single owner of outbound sync messages that are not fire-and-forget.
///
/// Generalized from `SessionCreationRequests`, which proved the shape: a send
/// completion, a timeout, a disconnect failure, and a typed outcome. Every send
/// routed through here produces exactly one terminal outcome, so a caller can
/// no longer decide by omission that the phone does not need to know.
///
/// Two shapes:
///   - `send`: the desktop never answers. Terminal when the socket accepts the
///     frame, or when it refuses it.
///   - `request`: the desktop answers by `requestId`. Terminal on `resolve`, on
///     a send error, on disconnect, or on timeout.
///
/// An optimistic local write keeps its `rebuild` closure. On a transport
/// failure the entry is parked and replayed after reconnect *from local state*,
/// not from the bytes that failed, so a draft edited three times offline
/// publishes once with what the row actually says.
@MainActor
final class SyncRequestRegistry {
    enum Channel {
        case index
        case session
    }

    struct Outcome {
        let requestId: String
        let kind: SyncRequestKind
        /// nil means the send landed, and for a request that it was answered.
        let error: SyncError?
    }

    typealias Sender = (Channel, String, @escaping @MainActor @Sendable (Error?) -> Void) -> Void

    private struct Pending {
        let kind: SyncRequestKind
        let channel: Channel
        /// Collapses a burst of the same logical write into one replay.
        let coalesceKey: String?
        /// Rebuilds the message from current local state. Non-nil marks this as
        /// an optimistic local write that must be re-published after reconnect.
        let rebuild: (@MainActor () -> String?)?
        var timeout: Task<Void, Never>?
    }

    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "SyncRequests")
    private let timeout: Duration
    private let sender: Sender

    private var pending: [String: Pending] = [:]
    /// Writes that failed while the socket was down, keyed by coalesce key.
    private var replay: [String: Pending] = [:]

    /// Fires once per terminal outcome, success or failure.
    var onOutcome: ((Outcome) -> Void)?

    var pendingCount: Int { pending.count }
    var replayCount: Int { replay.count }

    init(timeout: Duration = .seconds(30), sender: @escaping Sender) {
        self.timeout = timeout
        self.sender = sender
    }

    // MARK: - Sending

    /// Send a message the desktop never answers back on. The outcome reports
    /// whether the socket accepted the frame.
    @discardableResult
    func send(
        kind: SyncRequestKind,
        channel: Channel = .index,
        json: String,
        coalesceKey: String? = nil,
        rebuild: (@MainActor () -> String?)? = nil
    ) -> String {
        let id = UUID().uuidString
        pending[id] = Pending(kind: kind, channel: channel, coalesceKey: coalesceKey, rebuild: rebuild, timeout: nil)
        dispatch(id, json: json, expectsResponse: false)
        return id
    }

    /// Send a message the desktop answers by `requestId`. Fails on send error,
    /// disconnect, or timeout, whichever comes first.
    @discardableResult
    func request(
        kind: SyncRequestKind,
        requestId: String,
        channel: Channel = .index,
        json: String
    ) -> String {
        let task = Task { [weak self, timeout] in
            do { try await Task.sleep(for: timeout) } catch { return }
            self?.fail(requestId, errorKind: .requestTimeout, detail: "no response within \(timeout)")
        }
        pending[requestId] = Pending(kind: kind, channel: channel, coalesceKey: nil, rebuild: nil, timeout: task)
        dispatch(requestId, json: json, expectsResponse: true)
        return requestId
    }

    /// Record the desktop's answer to a `request`. A `detail` marks it failed,
    /// and is shown to the user as-is: the desktop knows why better than we do.
    /// Unknown ids are another device's request, or one we already timed out.
    func resolve(requestId: String, detail: String? = nil) {
        if let detail {
            fail(requestId, errorKind: .transport, detail: detail, userMessage: detail)
        } else {
            succeed(requestId)
        }
    }

    private func dispatch(_ id: String, json: String, expectsResponse: Bool) {
        guard let entry = pending[id] else { return }
        sender(entry.channel, json) { [weak self] error in
            guard let self else { return }
            if let error {
                self.fail(id, errorKind: .transport, detail: error.localizedDescription)
            } else if !expectsResponse {
                self.succeed(id)
            }
        }
    }

    // MARK: - Connection lifecycle

    /// Fail everything still in flight. Optimistic writes are parked for replay;
    /// requests are reported, because the desktop may have acted on them already.
    func disconnect() {
        for id in Array(pending.keys) {
            fail(id, errorKind: .transport, detail: "disconnected before the send was confirmed")
        }
    }

    /// Re-publish parked writes from current local state.
    func reconnect() {
        let parked = replay
        replay.removeAll()
        for entry in parked.values {
            guard let rebuild = entry.rebuild, let json = rebuild() else {
                // The local row is gone; there is nothing left to publish.
                continue
            }
            let id = UUID().uuidString
            pending[id] = entry
            dispatch(id, json: json, expectsResponse: false)
        }
    }

    /// Drop everything without reporting. Used when the account changes and the
    /// parked writes belong to an identity we are no longer writing for.
    func cancel() {
        for entry in pending.values { entry.timeout?.cancel() }
        pending.removeAll()
        replay.removeAll()
    }

    // MARK: - Terminal outcomes

    private func succeed(_ id: String) {
        guard let entry = finish(id) else { return }
        onOutcome?(Outcome(requestId: id, kind: entry.kind, error: nil))
    }

    private func fail(_ id: String, errorKind: SyncError.Kind, detail: String, userMessage: String? = nil) {
        guard let entry = finish(id) else { return }
        logger.error("\(entry.kind.rawValue) failed (\(errorKind.rawValue)): \(detail)")

        var retry: (@MainActor () -> Void)?
        if entry.rebuild != nil {
            park(entry)
            retry = { [weak self] in self?.reconnect() }
        }
        onOutcome?(Outcome(
            requestId: id,
            kind: entry.kind,
            error: SyncError(kind: errorKind, message: userMessage ?? entry.kind.failureDescription, retry: retry)
        ))
    }

    private func park(_ entry: Pending) {
        // Without a key every offline edit would replay separately, in an order
        // the local row has already settled; keyed, the last one wins.
        replay[entry.coalesceKey ?? UUID().uuidString] = entry
    }

    private func finish(_ id: String) -> Pending? {
        guard let entry = pending.removeValue(forKey: id) else { return nil }
        entry.timeout?.cancel()
        return entry
    }
}

/// The session id the session socket is joined to, readable off the main actor.
///
/// Session-room frames carry no session id of their own, and they arrive on a
/// URLSession queue. Reading the room here, at arrival, is what keeps a frame
/// from room A out of room B's rows when the user navigates in between.
final class SessionRoomBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?

    var sessionId: String? {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
}

/// Decides whether an incoming failure is a new banner or the current one,
/// updated.
///
/// `SyncManager` has a single `syncError` slot, and before this every failure
/// replaced it outright. Coalescing existed only as the banner's animation key,
/// which cannot help when the *message* differs: a draft push and a read receipt
/// failing alternately against one dead socket produced two messages, two
/// identities, and a banner that flapped. That is one interruption, so it is one
/// banner.
///
/// The window is measured from the first failure and is deliberately not
/// refreshed by later ones, so a steady stream of errors cannot pin a single
/// stale banner open forever -- after the window a genuinely new banner appears.
@MainActor
struct SyncErrorCoalescer {
    private var current: SyncError?
    private var openedAt: Date?
    private let window: TimeInterval

    init(window: TimeInterval = 2) {
        self.window = window
    }

    /// Returns what the banner should show, or nil to leave it exactly as it is.
    mutating func accept(_ incoming: SyncError, now: Date = Date()) -> SyncError? {
        guard let current, let openedAt,
              current.kind == incoming.kind,
              now.timeIntervalSince(openedAt) <= window else {
            // A different kind, an expired window, or the first failure. A
            // different kind replaces immediately: "could not decrypt" and
            // "could not send" are not the same thing to a reader.
            self.current = incoming
            self.openedAt = now
            return incoming
        }

        // Same kind inside the window: keep the identity so the view does not
        // re-animate, and stop naming one operation when several have failed.
        let message = current.message == incoming.message ? current.message : incoming.kind.coalescedMessage
        let retry = incoming.retry ?? current.retry
        if message == current.message, (retry == nil) == (current.retry == nil) {
            return nil
        }
        let merged = SyncError(id: current.id, kind: current.kind, message: message, retry: retry)
        self.current = merged
        return merged
    }

    /// Forget the open banner, so the next failure starts a new one.
    mutating func clear() {
        current = nil
        openedAt = nil
    }
}
