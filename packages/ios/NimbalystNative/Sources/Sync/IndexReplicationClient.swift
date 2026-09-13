import Foundation
import os

/// What the account has proven about its local index, for the list to read.
public struct IndexCoverage: Equatable, Sendable {
    /// A bootstrap baseline and its replay have committed. Until this is true,
    /// a search that finds nothing has not proven the account has nothing.
    /// Coverage of the retained cloud cache, not lifetime desktop history.
    public var historyComplete: Bool = false
    /// A bootstrap is in flight. Cached rows stay usable throughout.
    public var isBackfilling: Bool = false
    public var compatibility: Compatibility = .unknown
    public var lastCommittedRevision: Int?
    /// The last replication attempt failed: a rejected page, a failed decrypt, a
    /// failed database operation, a server error, or a timeout.
    ///
    /// Cached rows stay on screen throughout. This exists so a failure after
    /// negotiation cannot leave the list showing a "still checking older
    /// history" spinner forever with nothing behind it -- the UI can say sync
    /// failed while continuing to show what it has.
    public var hasError: Bool = false

    public enum Compatibility: Sendable, Equatable {
        case unknown
        /// Versioned replication negotiated.
        case v2
        /// The server predates versioned replication; legacy sync is in use and
        /// bounded transport is not available.
        case legacyServer
        /// We could not establish either. Cached rows remain; this is never
        /// rendered as an empty index.
        case unsupported
    }
}

/// Drives versioned index replication: negotiation, the recent-first seed, the
/// bootstrap, and delta catch-up.
///
/// It owns no data. Every page is handed to the ordered ingestion pipeline, and
/// this type only decides what to ask for next based on what came back. One
/// request is in flight at a time, so history work cannot pile up ahead of
/// navigation.
@MainActor
final class IndexReplicationClient {
    /// How long a request may go unanswered before we call it a failure. A
    /// timeout is never read as "this is an old server": that inference belongs
    /// only to an explicit unknown_message_type error.
    static let requestTimeout: TimeInterval = 30
    static let recentPageLimit = 100
    /// Session ids per lookup request.
    static let lookupBatchLimit = 50
    /// Navigation targets we will hold. Past this the oldest are dropped: they
    /// are stale taps, and the newest is the screen the user is looking at.
    static let maxPendingLookupIds = 200
    /// How many ancestor hops one navigation may trigger. A cycle or a very deep
    /// chain must not turn a single tap into unbounded fetching.
    static let maxAncestorHops = 5

    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "IndexReplication")
    private let generation: Int
    private let timeout: TimeInterval
    private let send: @MainActor (String) -> Void
    private let onCoverageChanged: @MainActor (IndexCoverage) -> Void
    /// Called when the server turns out to predate versioned replication, so the
    /// caller can fall back to the legacy index request.
    private let onLegacyServer: @MainActor () -> Void
    private let submitPage: @MainActor (IndexPageResponse, IndexPageWork) -> Void
    /// Every database touch goes through the ingestion owner. This type holds no
    /// database reference at all, which is what makes "recovery never runs on the
    /// main actor" a property of the code rather than of a review.
    private let submitMaintenance: @MainActor (IndexReplicationMaintenance, Int) -> Void

    private(set) var coverage = IndexCoverage() {
        didSet {
            if coverage != oldValue { onCoverageChanged(coverage) }
        }
    }

    private struct InFlight {
        let requestId: String
        let mode: IndexReplicationMode
        let bootstrapRunId: String?
        let lookupSessionIds: [String]?
        /// True only for the first request of a connection, the one whose
        /// unknown_message_type answer proves the server is pre-v2.
        let isProbe: Bool
    }

    private var inFlight: InFlight?
    private var timeoutTask: Task<Void, Never>?
    private var bootstrapRunId: String?
    private var isCancelled = false
    /// The recent seed for this connection has been applied.
    private var seedApplied = false
    /// Committed coverage has been read back from the database.
    private var coverageLoaded = false
    /// An interrupted bootstrap is being finished on the ingestion owner.
    private var isResumingFinalization = false
    /// Guards against choosing bootstrap-or-delta twice for one connection.
    private var hasChosenCoverageWork = false
    private var maintenanceCounter = 0
    private var outstandingMaintenance: [Int: IndexReplicationMaintenance] = [:]
    /// Sessions the UI needs right now -- a notification tap, a voice command --
    /// regardless of what history has been paged in.
    private var pendingLookupIds: [String] = []
    /// Where the bootstrap resumes. Held rather than sent immediately so a
    /// lookup can take the next slot at a page boundary, and so backgrounding
    /// can pause history fill without losing its place.
    ///
    /// Modelled as a value rather than an optional token because "resume from
    /// this page" and "start from the beginning" are different things, and an
    /// empty-string token would be sent to the server as if it were real.
    private enum BootstrapContinuation: Equatable {
        case start
        case page(String)
    }
    private var bootstrapContinuation: BootstrapContinuation?
    /// A lookup the server paginated. It answers by bytes as well as by count,
    /// so a 50-id request can come back split; dropping the rest would silently
    /// lose the sessions the user navigated to.
    private var lookupContinuation: (token: String, requestedIds: [String])?
    private var ancestorHops = 0
    private var isBackgrounded = false
    /// The highest revision the server has ever told us about, retained across
    /// every phase.
    ///
    /// A boolean "delta pending" flag loses the quiet case: a hint that lands
    /// after the server sent a terminal bootstrap page but before we finish
    /// applying it. Keeping the revision means the follow-up is decided by
    /// comparing it against what actually committed, whenever a drain ends,
    /// rather than by whether a flag survived the phase change.
    private var highestHintedRevision = 0

    /// True when the server has announced a revision we have not committed.
    private var owesDelta: Bool {
        highestHintedRevision > (coverage.lastCommittedRevision ?? 0)
    }

    init(
        generation: Int,
        timeout: TimeInterval = IndexReplicationClient.requestTimeout,
        send: @escaping @MainActor (String) -> Void,
        submitPage: @escaping @MainActor (IndexPageResponse, IndexPageWork) -> Void,
        submitMaintenance: @escaping @MainActor (IndexReplicationMaintenance, Int) -> Void,
        onCoverageChanged: @escaping @MainActor (IndexCoverage) -> Void,
        onLegacyServer: @escaping @MainActor () -> Void
    ) {
        self.generation = generation
        self.timeout = timeout
        self.send = send
        self.submitPage = submitPage
        self.submitMaintenance = submitMaintenance
        self.onCoverageChanged = onCoverageChanged
        self.onLegacyServer = onLegacyServer
    }

    // MARK: - Lifecycle

    /// Begin replication for a fresh connection.
    ///
    /// The bounded recent seed goes out immediately -- it doubles as the
    /// compatibility probe -- while committed coverage is read on the ingestion
    /// owner. The queue is FIFO, so that read lands before any page applied
    /// afterwards, and the seed does not wait on the database.
    func start() {
        guard !isCancelled else { return }
        seedApplied = false
        hasChosenCoverageWork = false
        coverageLoaded = false
        coverage.hasError = false
        requestMaintenance(.loadCoverage)
        request(mode: .recent, isProbe: true)
    }

    /// Fetch these sessions and their ancestors, whatever the list has paged in.
    ///
    /// Navigation takes priority over history fill: the request goes out at the
    /// next page boundary, and the bootstrap resumes from its retained token
    /// afterwards. It never advances the cursor -- a lookup proves nothing about
    /// coverage.
    /// Repeat calls for the same session are coalesced: a navigation poller and
    /// a retry button both land here, and neither should put a second identical
    /// request on the wire while the first is still queued or in flight. Once
    /// that request has come back, asking again is a deliberate retry and does
    /// go out.
    func lookup(sessionIds: [String]) {
        guard !isCancelled, !sessionIds.isEmpty else { return }
        let alreadyRequested = Set(inFlight?.lookupSessionIds ?? [])
        var addedNewWork = false
        for id in sessionIds where !pendingLookupIds.contains(id) && !alreadyRequested.contains(id) {
            pendingLookupIds.append(id)
            addedNewWork = true
        }
        if pendingLookupIds.count > Self.maxPendingLookupIds {
            let dropped = pendingLookupIds.count - Self.maxPendingLookupIds
            pendingLookupIds.removeFirst(dropped)
            logger.info("Dropped \(dropped) stale navigation lookups; the newest targets win")
        }
        // A fresh navigation gets a fresh ancestor budget; a poller repeating
        // itself does not, or it could hop forever.
        if addedNewWork { ancestorHops = 0 }
        pumpNextRequest()
    }

    /// History fill pauses while the app is backgrounded. Navigation lookups and
    /// delta catch-up still run: they are small and user- or server-driven.
    func setForeground(_ inForeground: Bool) {
        guard !isCancelled else { return }
        isBackgrounded = !inForeground
        if inForeground { pumpNextRequest() }
    }

    func cancel() {
        isCancelled = true
        timeoutTask?.cancel()
        timeoutTask = nil
        inFlight = nil
        outstandingMaintenance.removeAll()
        isResumingFinalization = false
        pendingLookupIds.removeAll()
        bootstrapContinuation = nil
        lookupContinuation = nil
    }

    // MARK: - Server input

    func handle(page response: IndexPageResponse) -> Bool {
        guard let current = inFlight, current.requestId == response.requestId else {
            // A page for a request we are no longer waiting on -- a retired
            // generation's, or a duplicate. Applying it could move the cursor
            // for a range we never asked about.
            logger.info("Ignoring index page for unexpected request \(response.requestId)")
            return false
        }
        clearTimeout()
        submitPage(response, IndexPageWork(
            requestId: current.requestId,
            mode: current.mode,
            bootstrapRunId: current.bootstrapRunId
        ))
        return true
    }

    /// The applied result comes back from the ingestion pipeline.
    func handle(outcome: IndexPageOutcome) {
        guard !isCancelled, outcome.generation == generation else { return }
        guard let current = inFlight, current.requestId == outcome.requestId else { return }
        inFlight = nil

        switch outcome.result {
        case .reset:
            logger.info("Server rejected the index cursor; resetting and bootstrapping again")
            coverage.historyComplete = false
            coverage.lastCommittedRevision = nil
            bootstrapRunId = nil
            hasChosenCoverageWork = false
            // The cursor is cleared on the ingestion owner; the bootstrap starts
            // when that lands, so it cannot race the clear.
            requestMaintenance(.resetCursor)

        case .failed(let reason):
            logger.error("Index page failed (\(current.mode.rawValue)): \(reason)")
            coverage.isBackfilling = false
            coverage.hasError = true
            // Nothing advanced, so the next hint or reconnect retries the same
            // range. Cached rows stay exactly as they were.

        case .applied(let nextPageToken, let complete, let committedCursor, let historyComplete, _):
            if coverage.compatibility != .v2 { coverage.compatibility = .v2 }
            // A page that applied clears the previous failure.
            coverage.hasError = false
            if let committedCursor { coverage.lastCommittedRevision = committedCursor }
            if historyComplete { coverage.historyComplete = true }

            switch current.mode {
            case .recent:
                // The seed is on screen. What comes next depends on committed
                // coverage, which may still be loading, so the decision is made
                // in one place once both are known.
                seedApplied = true
                advanceCoverageIfReady()
            case .bootstrap:
                if complete {
                    coverage.isBackfilling = false
                    bootstrapRunId = nil
                    bootstrapContinuation = nil
                    requestDeltaIfNeeded()
                } else if let nextPageToken {
                    // Held, not sent: a pending lookup takes this slot, and
                    // backgrounding pauses here without losing our place.
                    bootstrapContinuation = .page(nextPageToken)
                    pumpNextRequest()
                } else {
                    coverage.isBackfilling = false
                }
            case .delta:
                if !complete, let nextPageToken {
                    request(mode: .delta, pageToken: nextPageToken)
                } else {
                    pumpNextRequest()
                }
            case .lookup:
                if !complete, let nextPageToken, let ids = current.lookupSessionIds {
                    // The server paginates a lookup by bytes as well as by
                    // count, so the ids we asked for can span pages. Carry the
                    // original set through: it is what ancestors resolve from
                    // once the whole lookup has drained.
                    lookupContinuation = (token: nextPageToken, requestedIds: ids)
                    pumpNextRequest()
                } else if ancestorHops < Self.maxAncestorHops, let ids = current.lookupSessionIds {
                    // Ancestors are resolved by id, so a session opened from a
                    // notification shows its workstream rather than a bare row.
                    ancestorHops += 1
                    requestMaintenance(.missingAncestors(of: ids))
                } else {
                    pumpNextRequest()
                }
            }
        }
    }

    /// The server's "there is newer data" hint. It is not a cursor: it only
    /// tells us a delta is worth asking for.
    func handle(changesAvailable revision: Int) {
        guard !isCancelled else { return }
        highestHintedRevision = max(highestHintedRevision, revision)
        requestDeltaIfNeeded()
    }

    /// A server error. Only an explicit unknown_message_type for our probe means
    /// the server predates versioned replication.
    func handle(errorCode: String, requestId: String?) {
        guard !isCancelled, let current = inFlight else { return }
        if let requestId, requestId != current.requestId { return }

        if errorCode == "unknown_message_type", requestId == nil, current.isProbe {
            logger.info("Server does not support versioned index replication; using legacy sync")
            inFlight = nil
            clearTimeout()
            coverage.compatibility = .legacyServer
            coverage.isBackfilling = false
            onLegacyServer()
            return
        }

        logger.error("Index page request failed with \(errorCode)")
        inFlight = nil
        clearTimeout()
        coverage.isBackfilling = false
        coverage.hasError = true
    }

    // MARK: - Requests

    /// Choose the next request, in priority order: navigation first, then
    /// history fill, then catch-up. A no-op while something is in flight.
    private func pumpNextRequest() {
        guard !isCancelled, inFlight == nil, !isResumingFinalization else { return }

        // Finish the lookup already in progress before anything else: its
        // remaining pages hold ids the user is waiting on.
        if let continuation = lookupContinuation {
            lookupContinuation = nil
            request(mode: .lookup, pageToken: continuation.token, sessionIds: continuation.requestedIds)
            return
        }
        if !pendingLookupIds.isEmpty {
            let ids = Array(pendingLookupIds.prefix(Self.lookupBatchLimit))
            pendingLookupIds.removeFirst(ids.count)
            request(mode: .lookup, sessionIds: ids)
            return
        }
        if let continuation = bootstrapContinuation, !isBackgrounded {
            bootstrapContinuation = nil
            coverage.isBackfilling = true
            switch continuation {
            case .start:
                request(mode: .bootstrap, runId: bootstrapRunId)
            case .page(let token):
                request(mode: .bootstrap, pageToken: token, runId: bootstrapRunId)
            }
            return
        }
        requestDeltaIfNeeded()
    }

    private func startBootstrap() {
        guard !isCancelled, !isResumingFinalization else { return }
        scheduleBootstrap()
        pumpNextRequest()
    }

    /// Mark that a bootstrap is owed, without deciding when it runs.
    ///
    /// Never discards a saved page: a hint arriving while history is paused must
    /// resume the enumeration, not restart it from the beginning.
    private func scheduleBootstrap() {
        hasChosenCoverageWork = true
        bootstrapRunId = bootstrapRunId ?? UUID().uuidString
        if bootstrapContinuation == nil { bootstrapContinuation = .start }
    }

    /// Decide what to do after the recent seed, once committed coverage is known
    /// and any interrupted bootstrap has been resumed.
    private func advanceCoverageIfReady() {
        guard !isCancelled, seedApplied, coverageLoaded, !isResumingFinalization,
              inFlight == nil, !hasChosenCoverageWork else { return }
        // Navigation still comes first.
        if !pendingLookupIds.isEmpty { return pumpNextRequest() }
        if coverage.historyComplete {
            hasChosenCoverageWork = true
            request(mode: .delta, sinceRevision: coverage.lastCommittedRevision ?? 0)
        } else {
            startBootstrap()
        }
    }

    /// Ask for a delta when the server has announced something we have not
    /// committed. Safe to call at the end of any drain: it is a no-op while a
    /// request is in flight, and a no-op when nothing is owed.
    ///
    /// A delta is only legitimate once a bootstrap has proven coverage. Without
    /// that gate, a hint arriving after a failed bootstrap would ask for changes
    /// since revision 0 and the client would treat the answer as if the baseline
    /// had been enumerated -- skipping the history it never fetched. In that
    /// state the right response to a hint is to bootstrap again.
    private func requestDeltaIfNeeded() {
        guard !isCancelled, inFlight == nil, owesDelta else { return }
        guard coverage.historyComplete else {
            // Schedule rather than start: the pump is usually what called us, so
            // calling back into it here is how this recursed forever while
            // history was paused. Whoever owns the pump will pick it up.
            if seedApplied, coverageLoaded, !isResumingFinalization, bootstrapContinuation == nil {
                logger.info("Hint arrived without proven coverage; bootstrapping instead of asking for a delta")
                scheduleBootstrap()
                if !isBackgrounded { pumpNextRequest() }
            }
            return
        }
        request(mode: .delta, sinceRevision: coverage.lastCommittedRevision ?? 0)
    }

    // MARK: - Maintenance

    private func requestMaintenance(_ request: IndexReplicationMaintenance) {
        maintenanceCounter += 1
        let id = maintenanceCounter
        outstandingMaintenance[id] = request
        if case .resumeFinalization = request { isResumingFinalization = true }
        submitMaintenance(request, id)
    }

    /// Results of database work run on the ingestion owner.
    func handle(maintenance outcome: IndexMaintenanceOutcome) {
        guard !isCancelled, outcome.generation == generation else { return }
        guard outstandingMaintenance.removeValue(forKey: outcome.id) != nil else { return }

        switch outcome.request {
        case .loadCoverage:
            coverageLoaded = true
            if outcome.failure != nil { coverage.hasError = true }
            coverage.historyComplete = outcome.cursorState.historyComplete
            coverage.lastCommittedRevision = outcome.cursorState.cursor > 0 ? outcome.cursorState.cursor : nil
            if let runId = outcome.pendingFinalizationRunId {
                // An interrupted bootstrap owes reconciliation. Finish it before
                // asking the server for anything new.
                coverage.isBackfilling = true
                bootstrapRunId = runId
                requestMaintenance(.resumeFinalization(runId: runId))
            } else {
                advanceCoverageIfReady()
            }

        case .resumeFinalization:
            isResumingFinalization = false
            coverage.isBackfilling = false
            if let failure = outcome.failure {
                logger.error("Bootstrap finalization failed: \(failure)")
                coverage.hasError = true
            }
            if outcome.failure == nil {
                coverage.historyComplete = outcome.cursorState.historyComplete
                coverage.lastCommittedRevision = outcome.cursorState.cursor > 0 ? outcome.cursorState.cursor : nil
                bootstrapRunId = nil
            }
            // A hint that arrived during recovery is still owed. Without this the
            // catch-up waited for the next reconnect.
            advanceCoverageIfReady()
            requestDeltaIfNeeded()

        case .missingAncestors:
            if !outcome.missingAncestorIds.isEmpty {
                for id in outcome.missingAncestorIds where !pendingLookupIds.contains(id) {
                    pendingLookupIds.append(id)
                }
            }
            pumpNextRequest()

        case .resetCursor:
            if outcome.failure != nil { coverage.hasError = true }
            coverage.historyComplete = false
            coverage.lastCommittedRevision = nil
            startBootstrap()
        }
    }

    private func request(
        mode: IndexReplicationMode,
        pageToken: String? = nil,
        sinceRevision: Int? = nil,
        sessionIds: [String]? = nil,
        runId: String? = nil,
        isProbe: Bool = false
    ) {
        guard !isCancelled, inFlight == nil else { return }
        let requestId = UUID().uuidString
        var request = IndexPageRequest(requestId: requestId, mode: mode.rawValue)
        request.pageToken = pageToken
        request.sinceRevision = sinceRevision
        request.sessionIds = sessionIds
        request.limit = mode == .recent ? Self.recentPageLimit : nil

        guard let data = try? JSONEncoder().encode(request),
              let json = String(data: data, encoding: .utf8) else {
            logger.error("Failed to encode index page request")
            return
        }
        inFlight = InFlight(
            requestId: requestId, mode: mode, bootstrapRunId: runId,
            lookupSessionIds: sessionIds, isProbe: isProbe
        )
        startTimeout(for: requestId)
        send(json)
    }

    private func startTimeout(for requestId: String) {
        timeoutTask?.cancel()
        let timeout = self.timeout
        timeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self, self.inFlight?.requestId == requestId else { return }
                // A silent server is a failure, never evidence of an old one.
                self.logger.error("Index page request timed out")
                self.inFlight = nil
                self.coverage.isBackfilling = false
                self.coverage.hasError = true
                if self.coverage.compatibility == .unknown {
                    self.coverage.compatibility = .unsupported
                }
            }
        }
    }

    private func clearTimeout() {
        timeoutTask?.cancel()
        timeoutTask = nil
    }
}
