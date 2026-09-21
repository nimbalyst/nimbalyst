import Foundation

/// The pure half of the sync error banner: what a `SyncError` reads as, whether
/// it offers a retry, and when two successive errors are the same banner.
///
/// Lives here rather than in the view so the copy and the coalescing rule can be
/// tested; `SyncErrorBanner` only arranges what this returns. Colours are not
/// decided here — `severity` names the meaning and the view maps it onto
/// `NimbalystColors`.
enum SyncErrorPresentation {

    /// How loud the banner should be. `caution` means the operation may still
    /// have landed; `failure` means this device is certain something did not.
    enum Severity: Equatable {
        case caution
        case failure
    }

    /// A short headline. Says what is uncertain and never claims an operation
    /// failed outright — the detail sentence in `SyncError.message` carries the
    /// specifics, and a send that errored may still have been delivered.
    static func title(for kind: SyncError.Kind) -> String {
        switch kind {
        case .transport:
            return "Sync interrupted"
        case .decrypt:
            return "A message could not be read"
        case .storage:
            return "Not saved on this device"
        case .requestTimeout:
            return "No answer from your desktop"
        }
    }

    static func symbolName(for kind: SyncError.Kind) -> String {
        switch kind {
        case .transport:
            return "wifi.exclamationmark"
        case .decrypt:
            return "lock.trianglebadge.exclamationmark"
        case .storage:
            return "externaldrive.badge.exclamationmark"
        case .requestTimeout:
            return "clock.badge.exclamationmark"
        }
    }

    static func severity(for kind: SyncError.Kind) -> Severity {
        switch kind {
        case .transport, .requestTimeout:
            // The frame may have landed before the socket died, and the owning
            // slice re-drives on reconnect. Uncertain, not lost.
            return .caution
        case .decrypt, .storage:
            // This device tried and could not. Nothing is pending.
            return .failure
        }
    }

    /// Retrying is only offered where the sync layer attached a closure that
    /// knows how to re-drive the work from current local state.
    static func showsRetry(for error: SyncError) -> Bool {
        error.retry != nil
    }

    /// The label on the trailing control: the retry when there is one, the
    /// dismiss otherwise. There is always exactly one.
    static func actionLabel(for error: SyncError) -> String {
        showsRetry(for: error) ? "Try again" : "Dismiss"
    }

    /// Identity for coalescing. `SyncManager` keeps a single error slot, so a
    /// burst of the same failure already replaces itself; this keeps the view
    /// from re-animating when it does. A new `UUID` per error is deliberately
    /// not part of the key — two transport failures with the same message are
    /// one banner, updated in place.
    static func coalesceKey(for error: SyncError) -> String {
        "\(error.kind.rawValue)|\(error.message)"
    }

    static func coalesceKey(for error: SyncError?) -> String? {
        error.map(coalesceKey(for:))
    }

    /// One sentence for VoiceOver, since the banner is read as a single element.
    static func accessibilityLabel(for error: SyncError) -> String {
        "\(title(for: error.kind)). \(error.message)"
    }
}
