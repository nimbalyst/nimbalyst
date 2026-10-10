import Foundation
import os

/// Calls the console's `flushPending`. The Pages web controller implements it.
@MainActor
public protocol ConsoleFlushing: AnyObject {
    /// Nil when the console bridge is not installed (nothing to flush).
    func flushPending(timeoutMs: Int) async -> ConsoleFlushResult?
}

/// `UIApplication.beginBackgroundTask` behind a seam so the coordinator is testable.
@MainActor
public protocol BackgroundTaskScheduling: AnyObject {
    /// Returns nil when the system refuses the task.
    func begin(name: String, expiration: @escaping @MainActor () -> Void) -> Int?
    func end(_ id: Int)
}

/// What one background flush came to. Recorded, never swallowed.
public enum PagesFlushOutcome: Equatable, Sendable {
    case acknowledged
    case notRequired
    /// The console's own timeout, or native gave up waiting.
    case timedOut
    case failed(String?)
    /// iOS ended the background time before the console answered.
    case expired
    case noBridge
}

/// Flush-on-background and the "your last edits may not have saved" notice.
///
/// The console keeps document Y.Docs in memory only, and iOS kills background
/// web content freely. When the scene leaves the foreground this starts a
/// background task, asks the console to flush, and ends the task on the first
/// of: the console's answer, native's own timeout, or iOS's expiration. If the
/// page had unsynced edits and its process (or the app) dies, the next load
/// shows a one-line notice instead of silently reloading over the gap.
@MainActor
public final class PagesFlushCoordinator {
    public static let flushTimeoutMs = 5_000
    static let unsyncedMarkerKey = "consolePages.unsyncedAtBackground"
    static let lastOutcomeKey = "consolePages.lastBackgroundFlush"

    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "ConsolePages")
    private let defaults: UserDefaults
    private let backgroundTasks: BackgroundTaskScheduling
    private let nativeTimeout: Duration
    public weak var bridge: ConsoleFlushing?

    public private(set) var editing = false
    public private(set) var unsynced = false
    public private(set) var lastOutcome: PagesFlushOutcome?
    public private(set) var recordedFailures = 0
    private var lostEditsPending: Bool
    private var flushInFlight = false

    public init(defaults: UserDefaults = .standard, backgroundTasks: BackgroundTaskScheduling, nativeTimeout: Duration = .milliseconds(PagesFlushCoordinator.flushTimeoutMs + 1_000)) {
        self.defaults = defaults
        self.backgroundTasks = backgroundTasks
        self.nativeTimeout = nativeTimeout
        // Set by the previous process while it held unsynced edits; still being
        // here means it never saw them reach the server.
        lostEditsPending = defaults.bool(forKey: Self.unsyncedMarkerKey)
        defaults.removeObject(forKey: Self.unsyncedMarkerKey)
    }

    /// `editState` from the console.
    public func editStateChanged(editing: Bool, unsynced: Bool) {
        self.editing = editing
        self.unsynced = unsynced
        if unsynced {
            defaults.set(true, forKey: Self.unsyncedMarkerKey)
        } else {
            defaults.removeObject(forKey: Self.unsyncedMarkerKey)
        }
    }

    /// The web content process died. Unsynced edits in it are gone.
    public func contentProcessTerminated() {
        if unsynced {
            logger.warning("Console web process terminated with unsynced edits")
            lostEditsPending = true
        }
        editStateChanged(editing: false, unsynced: false)
    }

    /// True once after a process kill that held unsynced edits; the caller shows the notice.
    public func consumeLostEditsNotice() -> Bool {
        defer { lostEditsPending = false }
        return lostEditsPending
    }

    /// The scene left the foreground. Returns the outcome once the background task ended.
    @discardableResult
    public func sceneDidEnterBackground() async -> PagesFlushOutcome {
        guard let bridge else { return record(.noBridge) }
        guard !flushInFlight else { return .notRequired }
        flushInFlight = true
        defer { flushInFlight = false }

        let race = FlushRace(backgroundTasks: backgroundTasks)
        let timeout = nativeTimeout
        let outcome: PagesFlushOutcome = await withCheckedContinuation { continuation in
            race.continuation = continuation
            race.taskId = backgroundTasks.begin(name: "Flush team page edits") { race.settle(.expired) }
            race.workers.append(Task { @MainActor in
                let result = await bridge.flushPending(timeoutMs: Self.flushTimeoutMs)
                guard !Task.isCancelled else { return }
                race.settle(Self.outcome(for: result))
            })
            race.workers.append(Task { @MainActor in
                try? await Task.sleep(for: timeout)
                guard !Task.isCancelled else { return }
                race.settle(.timedOut)
            })
        }
        return record(outcome)
    }

    /// First of answer, native timeout, or expiration wins; the background task ends exactly once.
    @MainActor
    private final class FlushRace {
        let backgroundTasks: BackgroundTaskScheduling
        var continuation: CheckedContinuation<PagesFlushOutcome, Never>?
        var taskId: Int?
        var workers: [Task<Void, Never>] = []

        init(backgroundTasks: BackgroundTaskScheduling) {
            self.backgroundTasks = backgroundTasks
        }

        func settle(_ outcome: PagesFlushOutcome) {
            guard let continuation else { return }
            self.continuation = nil
            workers.forEach { $0.cancel() }
            if let taskId { backgroundTasks.end(taskId) }
            continuation.resume(returning: outcome)
        }
    }

    static func outcome(for result: ConsoleFlushResult?) -> PagesFlushOutcome {
        guard let result else { return .noBridge }
        switch result.status {
        case .acknowledged: return .acknowledged
        case .notRequired: return .notRequired
        case .timedOut: return .timedOut
        case .failed: return .failed(result.detail)
        }
    }

    @discardableResult
    private func record(_ outcome: PagesFlushOutcome) -> PagesFlushOutcome {
        lastOutcome = outcome
        defaults.set(String(describing: outcome), forKey: Self.lastOutcomeKey)
        switch outcome {
        case .acknowledged, .notRequired, .noBridge:
            logger.info("Background flush: \(String(describing: outcome))")
        case .timedOut, .failed, .expired:
            recordedFailures += 1
            logger.error("Background flush did not reach the server: \(String(describing: outcome))")
        }
        return outcome
    }
}
