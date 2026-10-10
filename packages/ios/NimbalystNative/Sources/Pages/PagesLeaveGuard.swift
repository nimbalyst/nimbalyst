import Foundation

/// Anything that takes the reader off the page they are editing.
public enum PagesLeaveIntent: Equatable, Sendable {
    /// Native Back while the web view has history.
    case webBack
    /// Native Back at the root: leave the Pages screen.
    case leaveScreen
    /// Another sidebar row, link or push asked for a different page.
    case replaceRoute(ConsoleRoute)
    /// Any other document-replacing load: a `_blank` team link, a
    /// `nimbalyst://console/...` rewrite, a full navigation the page started, re-auth.
    case loadURL(URL)
}

/// The console side the guard talks to. `PagesWebController` implements it.
@MainActor
public protocol PagesUnsyncedEdits: ConsoleFlushing {
    /// `editState.unsynced`: counts every unacknowledged edit, including pages
    /// already navigated away from (contract r2), until acknowledged or discarded.
    var unsynced: Bool { get }
    @discardableResult func discardUnsynced() async -> Int?
}

/// One path for every way of leaving: flush first; if edits are still not on
/// the server, ask; discard only on the reader's "Leave".
@MainActor
public final class PagesLeaveGuard {
    /// The intent waiting on the reader's answer.
    public private(set) var pending: PagesLeaveIntent?
    private let flushTimeoutMs: Int

    public init(flushTimeoutMs: Int = PagesFlushCoordinator.flushTimeoutMs) {
        self.flushTimeoutMs = flushTimeoutMs
    }

    /// True when leaving is safe now: nothing unsynced, or a flush the server
    /// acknowledged. Touches no state, so a request that went stale during the
    /// flush cannot overwrite a newer one; the caller decides, then `hold`s.
    public func mayProceed(edits: PagesUnsyncedEdits) async -> Bool {
        guard edits.unsynced else { return true }
        let result = await edits.flushPending(timeoutMs: flushTimeoutMs)
        // `flushPending` covers every unacknowledged edit, so either answer means none is left.
        return result?.status == .acknowledged || result?.status == .notRequired
    }

    /// Wait for the reader's answer on `intent`.
    public func hold(_ intent: PagesLeaveIntent) {
        pending = intent
    }

    /// "Leave": hand back the intent to perform. Synchronous, so the dialog's
    /// dismissal that follows the button cannot cancel it first. The caller
    /// discards the console's unsynced edits before performing it.
    public func take() -> PagesLeaveIntent? {
        defer { pending = nil }
        return pending
    }

    /// "Keep Editing": drop the intent and hand it back so the caller can undo
    /// what started it (for example, re-select the page still on screen).
    public func cancel() -> PagesLeaveIntent? {
        defer { pending = nil }
        return pending
    }
}
