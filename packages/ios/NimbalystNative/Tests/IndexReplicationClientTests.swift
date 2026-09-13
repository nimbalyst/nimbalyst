import XCTest
@testable import NimbalystNative

/// The replication driver: what it asks for next, and what it refuses to
/// conclude from silence or from the wrong answer.
///
/// The driver takes no database: every read, recovery and cursor reset goes to
/// the ingestion owner as maintenance work. That is why these tests can drive it
/// with plain values, and it is also the guarantee that crash recovery cannot
/// run on the main actor.
@MainActor
final class IndexReplicationClientTests: XCTestCase {
    private var sent: [IndexPageRequest] = []
    private var submitted: [IndexPageWork] = []
    private var maintenance: [(request: IndexReplicationMaintenance, id: Int)] = []
    private var coverages: [IndexCoverage] = []
    private var legacyFallbacks = 0

    private func makeClient(timeout: TimeInterval = 30) -> IndexReplicationClient {
        IndexReplicationClient(
            generation: 1,
            timeout: timeout,
            send: { [weak self] json in
                guard let data = json.data(using: .utf8),
                      let request = try? JSONDecoder().decode(SentPageRequest.self, from: data) else {
                    return XCTFail("Unparseable page request")
                }
                self?.sent.append(IndexPageRequest(
                    requestId: request.requestId, mode: request.mode,
                    pageToken: request.pageToken, sinceRevision: request.sinceRevision,
                    projectId: nil, sessionIds: request.sessionIds, limit: request.limit
                ))
            },
            submitPage: { [weak self] _, work in self?.submitted.append(work) },
            submitMaintenance: { [weak self] request, id in self?.maintenance.append((request, id)) },
            onCoverageChanged: { [weak self] coverage in self?.coverages.append(coverage) },
            onLegacyServer: { [weak self] in self?.legacyFallbacks += 1 }
        )
    }

    /// The request as it actually goes over the wire.
    private struct SentPageRequest: Decodable {
        let type: String
        let protocolVersion: Int
        let requestId: String
        let mode: String
        let pageToken: String?
        let sinceRevision: Int?
        let sessionIds: [String]?
        let limit: Int?
    }

    private func outcome(
        _ request: IndexPageRequest,
        _ result: IndexPageOutcome.Result
    ) -> IndexPageOutcome {
        IndexPageOutcome(
            generation: 1,
            requestId: request.requestId,
            mode: IndexReplicationMode(rawValue: request.mode) ?? .recent,
            result: result
        )
    }

    /// Answer the driver's outstanding maintenance request the way the ingestion
    /// owner would.
    private func completeMaintenance(
        _ client: IndexReplicationClient,
        cursor: Int = 0,
        historyComplete: Bool = false,
        pendingRunId: String? = nil,
        missingAncestors: [String] = [],
        failure: String? = nil
    ) {
        guard let pending = maintenance.last else { return XCTFail("No maintenance was requested") }
        client.handle(maintenance: IndexMaintenanceOutcome(
            generation: 1, id: pending.id, request: pending.request,
            cursorState: .init(cursor: cursor, historyComplete: historyComplete),
            pendingFinalizationRunId: pendingRunId, missingAncestorIds: missingAncestors,
            ranOffMainActor: true, failure: failure
        ))
    }

    /// The usual opening: coverage loads empty, the seed applies.
    private func startWithEmptyCoverage(_ client: IndexReplicationClient) {
        client.start()
        completeMaintenance(client)
        client.handle(outcome: outcome(sent[0], applied()))
    }

    private func applied(
        nextPageToken: String? = nil,
        complete: Bool = true,
        cursor: Int? = nil,
        historyComplete: Bool = false
    ) -> IndexPageOutcome.Result {
        .applied(
            nextPageToken: nextPageToken, complete: complete,
            committedCursor: cursor, historyComplete: historyComplete, entries: 1
        )
    }

    // MARK: - Negotiation

    /// The probe is the compatibility check. Only an explicit
    /// unknown_message_type means the server predates versioned replication.
    func testOnlyUnknownMessageTypeFallsBackToLegacySync() throws {
        let client = makeClient()
        client.start()

        XCTAssertEqual(sent.count, 1, "The seed goes out immediately, without waiting on the database")
        XCTAssertEqual(maintenance.map(\.request), [.loadCoverage])
        XCTAssertEqual(sent[0].mode, "recent")
        XCTAssertEqual(sent[0].limit, 100, "The seed is bounded")
        XCTAssertEqual(sent[0].sinceRevision, nil)

        client.handle(errorCode: "internal_error", requestId: sent[0].requestId)
        XCTAssertEqual(legacyFallbacks, 0, "An ordinary failure is not evidence of an old server")

        client.start()
        client.handle(errorCode: "unknown_message_type", requestId: nil)
        XCTAssertEqual(legacyFallbacks, 1)
        XCTAssertEqual(client.coverage.compatibility, .legacyServer)
    }

    /// Silence is a failure, never a diagnosis. A timed-out probe must not be
    /// mistaken for an old server, and must not empty the list.
    func testTimeoutIsAFailureRatherThanALegacyDiagnosis() async throws {
        let client = makeClient(timeout: 0.1)
        client.start()
        try await Task.sleep(nanoseconds: 400_000_000)

        XCTAssertEqual(legacyFallbacks, 0)
        XCTAssertEqual(client.coverage.compatibility, .unsupported)
        XCTAssertFalse(client.coverage.historyComplete)
    }

    // MARK: - Sequencing

    func testSeedIsFollowedByBootstrapAndThenDeltaOnTheNextConnection() throws {
        let client = makeClient()
        startWithEmptyCoverage(client)
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(sent[1].mode, "bootstrap", "Incomplete history bootstraps before anything else")
        XCTAssertTrue(client.coverage.isBackfilling)

        client.handle(outcome: outcome(sent[1], applied(nextPageToken: "p2", complete: false)))
        XCTAssertEqual(sent[2].mode, "bootstrap")
        XCTAssertEqual(sent[2].pageToken, "p2", "Paging continues with the server's opaque token")

        client.handle(outcome: outcome(sent[2], applied(cursor: 42, historyComplete: true)))
        XCTAssertFalse(client.coverage.isBackfilling)
        XCTAssertTrue(client.coverage.historyComplete)
        XCTAssertEqual(client.coverage.lastCommittedRevision, 42)
        XCTAssertEqual(sent.count, 3, "A finished bootstrap does not immediately ask for more")

        // A later connection reads the committed coverage back through the
        // pipeline and asks for a delta instead of bootstrapping again.
        let reconnect = makeClient()
        sent = []
        maintenance = []
        reconnect.start()
        completeMaintenance(reconnect, cursor: 42, historyComplete: true)
        reconnect.handle(outcome: outcome(sent[0], applied()))
        XCTAssertEqual(sent[1].mode, "delta")
        XCTAssertEqual(sent[1].sinceRevision, 42)
    }

    /// One request at a time: a hint that arrives mid-page is remembered, not
    /// dropped and not stacked.
    func testChangeHintsAreCoalescedBehindTheRequestInFlight() throws {
        let client = makeClient()
        client.start()
        completeMaintenance(client, cursor: 5, historyComplete: true)
        client.handle(outcome: outcome(sent[0], applied(cursor: 5, historyComplete: true)))
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(sent[1].mode, "delta")

        client.handle(changesAvailable: 9)
        client.handle(changesAvailable: 11)
        XCTAssertEqual(sent.count, 2, "Nothing is sent while a request is outstanding")

        client.handle(outcome: outcome(sent[1], applied(cursor: 7)))
        XCTAssertEqual(sent.count, 3)
        XCTAssertEqual(sent[2].mode, "delta")
        XCTAssertEqual(sent[2].sinceRevision, 7, "The catch-up resumes from what actually committed")

        client.handle(outcome: outcome(sent[2], applied(cursor: 11)))
        XCTAssertEqual(sent.count, 3, "The retained hint is covered, so nothing more is asked for")
        client.handle(changesAvailable: 11)
        XCTAssertEqual(sent.count, 3, "A hint at or below the committed cursor asks for nothing")
    }

    /// The quiet loss this guards: the server sends the terminal bootstrap page,
    /// a hint lands while we are still applying it, and the follow-up delta is
    /// never asked for -- leaving the account permanently one update behind
    /// until something else happens to wake it.
    func testHintDuringTerminalApplicationStillTriggersTheFollowUpDelta() throws {
        let client = makeClient()
        startWithEmptyCoverage(client)
        XCTAssertEqual(sent[1].mode, "bootstrap")

        // The terminal page arrives and goes to the pipeline; the outcome has
        // not come back yet.
        let terminal = try JSONDecoder().decode(IndexPageResponse.self, from: JSONSerialization.data(withJSONObject: [
            "type": "indexPageResponse", "protocolVersion": 2, "requestId": sent[1].requestId,
            "mode": "bootstrap", "entries": [], "complete": true, "cursor": 100,
        ]))
        XCTAssertTrue(client.handle(page: terminal))
        XCTAssertEqual(submitted.count, 1)

        // The hint lands in that gap.
        client.handle(changesAvailable: 105)
        XCTAssertEqual(sent.count, 2, "Nothing is sent while the terminal is still being applied")

        client.handle(outcome: outcome(sent[1], applied(cursor: 100, historyComplete: true)))
        XCTAssertEqual(sent.count, 3)
        XCTAssertEqual(sent[2].mode, "delta")
        XCTAssertEqual(sent[2].sinceRevision, 100, "The hint survived the phase change")

        // A delta that completes without reaching the announced revision -- a
        // capped page, say -- must not end the catch-up. A boolean "delta
        // pending" flag is consumed by the request that was sent, so it stops
        // here, permanently three revisions behind with nothing left to wake it.
        client.handle(outcome: outcome(sent[2], applied(cursor: 102)))
        XCTAssertEqual(sent.count, 4, "The announced revision is still ahead of what committed")
        XCTAssertEqual(sent[3].mode, "delta")
        XCTAssertEqual(sent[3].sinceRevision, 102)

        // And once it does cover the hint, the catch-up stops on its own.
        client.handle(outcome: outcome(sent[3], applied(cursor: 105)))
        XCTAssertEqual(sent.count, 4)
    }

    func testPageForAnUnexpectedRequestIsNeverApplied() throws {
        let client = makeClient()
        client.start()

        let foreign = try JSONDecoder().decode(IndexPageResponse.self, from: JSONSerialization.data(withJSONObject: [
            "type": "indexPageResponse", "protocolVersion": 2, "requestId": "someone-else",
            "mode": "recent", "entries": [], "complete": true,
        ]))
        XCTAssertFalse(client.handle(page: foreign))
        XCTAssertTrue(submitted.isEmpty, "A page we did not ask for cannot reach the cursor")
    }

    /// A reset clears the cursor on the ingestion owner, and the fresh bootstrap
    /// waits for that clear rather than racing it.
    func testResetClearsTheCursorOffMainAndThenBootstraps() throws {
        let client = makeClient()
        client.start()
        completeMaintenance(client, cursor: 99, historyComplete: true)
        XCTAssertTrue(client.coverage.historyComplete)

        client.handle(outcome: outcome(sent[0], .reset))
        XCTAssertFalse(client.coverage.historyComplete, "A reset withdraws the coverage claim")
        XCTAssertNil(client.coverage.lastCommittedRevision)
        XCTAssertEqual(maintenance.last?.request, .resetCursor)
        XCTAssertEqual(sent.count, 1, "No new request goes out until the cursor is actually cleared")

        completeMaintenance(client)
        XCTAssertEqual(sent.last?.mode, "bootstrap")
    }

    // MARK: - Crash recovery

    /// An interrupted bootstrap is finished on the ingestion owner before the
    /// client asks the server for anything, and a hint that arrives during that
    /// recovery is honoured as soon as it finishes -- not left until the next
    /// reconnect.
    func testInterruptedBootstrapIsResumedOffMainAndAHintDuringItIsHonoured() throws {
        let client = makeClient()
        client.start()

        // Coverage says a bootstrap owes reconciliation.
        completeMaintenance(client, cursor: 40, historyComplete: false, pendingRunId: "run-9")
        XCTAssertEqual(maintenance.last?.request, .resumeFinalization(runId: "run-9"))
        XCTAssertTrue(client.coverage.isBackfilling)

        // The seed lands, and a hint arrives, both while recovery is running.
        client.handle(outcome: outcome(sent[0], applied()))
        client.handle(changesAvailable: 77)
        XCTAssertEqual(sent.count, 1, "Nothing is asked for while an interrupted bootstrap is being finished")

        // Recovery completes: coverage is proven, and the hint is served now.
        completeMaintenance(client, cursor: 60, historyComplete: true)
        XCTAssertTrue(client.coverage.historyComplete)
        XCTAssertFalse(client.coverage.isBackfilling)
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(sent[1].mode, "delta")
        XCTAssertEqual(sent[1].sinceRevision, 60)
    }

    /// Without proven coverage a delta from revision 0 would look like a
    /// complete catch-up while the baseline was never enumerated. A hint in that
    /// state has to bootstrap instead.
    func testHintWithoutProvenCoverageBootstrapsRatherThanAskingForADelta() throws {
        let client = makeClient()
        startWithEmptyCoverage(client)
        XCTAssertEqual(sent[1].mode, "bootstrap")

        client.handle(outcome: outcome(sent[1], .failed("network")))
        XCTAssertFalse(client.coverage.historyComplete)
        XCTAssertFalse(client.coverage.isBackfilling)

        client.handle(changesAvailable: 500)
        XCTAssertEqual(sent.count, 3)
        XCTAssertEqual(sent[2].mode, "bootstrap", "An unfinished baseline is never skipped by a delta")
        XCTAssertNil(sent[2].sinceRevision)
    }

    // MARK: - Navigation priority

    /// A notification tap must not wait for history. The lookup takes the next
    /// page slot, the bootstrap resumes from its retained token afterwards, and
    /// ancestors are fetched by id so the session opens inside its workstream.
    func testLookupPreemptsHistoryFillAndResolvesAncestors() throws {
        let client = makeClient()
        startWithEmptyCoverage(client)
        XCTAssertEqual(sent[1].mode, "bootstrap")

        // A bootstrap page comes back mid-enumeration, and navigation is waiting.
        client.lookup(sessionIds: ["wanted"])
        client.handle(outcome: outcome(sent[1], applied(nextPageToken: "p2", complete: false)))

        XCTAssertEqual(sent[2].mode, "lookup", "Navigation goes before more history")
        XCTAssertEqual(sent[2].sessionIds, ["wanted"])
        XCTAssertNil(sent[2].sinceRevision)

        // The lookup asks which ancestors are missing, and fetches those next.
        client.handle(outcome: outcome(sent[2], applied()))
        XCTAssertEqual(maintenance.last?.request, .missingAncestors(of: ["wanted"]))
        completeMaintenance(client, missingAncestors: ["parent"])
        XCTAssertEqual(sent[3].mode, "lookup")
        XCTAssertEqual(sent[3].sessionIds, ["parent"])

        // With nothing missing, history resumes exactly where it paused.
        client.handle(outcome: outcome(sent[3], applied()))
        completeMaintenance(client)
        XCTAssertEqual(sent[4].mode, "bootstrap")
        XCTAssertEqual(sent[4].pageToken, "p2")
    }

    /// A navigation poller and a retry button both call this. Neither may put a
    /// second identical request on the wire while the first is outstanding.
    func testRepeatedLookupsForTheSameSessionAreCoalesced() throws {
        let client = makeClient()
        startWithEmptyCoverage(client)
        XCTAssertEqual(sent[1].mode, "bootstrap")

        client.lookup(sessionIds: ["wanted"])
        client.lookup(sessionIds: ["wanted"])
        client.handle(outcome: outcome(sent[1], applied(nextPageToken: "p2", complete: false)))
        XCTAssertEqual(sent[2].mode, "lookup")
        XCTAssertEqual(sent[2].sessionIds, ["wanted"])

        // Still in flight: the poller's next tick adds nothing.
        client.lookup(sessionIds: ["wanted"])
        XCTAssertEqual(sent.count, 3)

        client.handle(outcome: outcome(sent[2], applied()))
        completeMaintenance(client)
        XCTAssertEqual(sent[3].mode, "bootstrap", "History resumed rather than looking up again")

        // After it came back, asking again is a deliberate retry and does go out.
        client.lookup(sessionIds: ["wanted"])
        client.handle(outcome: outcome(sent[3], applied(nextPageToken: "p3", complete: false)))
        XCTAssertEqual(sent[4].mode, "lookup")
        XCTAssertEqual(sent[4].sessionIds, ["wanted"])
    }

    /// Backgrounding pauses history fill and nothing else, and it resumes from
    /// the page it paused on.
    func testBackgroundingPausesHistoryFillButNotNavigation() throws {
        let client = makeClient()
        startWithEmptyCoverage(client)
        client.handle(outcome: outcome(sent[1], applied(nextPageToken: "p2", complete: false)))
        XCTAssertEqual(sent.count, 3, "History continued while in the foreground")

        client.setForeground(false)
        client.handle(outcome: outcome(sent[2], applied(nextPageToken: "p3", complete: false)))
        XCTAssertEqual(sent.count, 3, "Backgrounded: history fill stops at the page boundary")

        // Navigation still works while backgrounded.
        client.lookup(sessionIds: ["urgent"])
        XCTAssertEqual(sent.count, 4)
        XCTAssertEqual(sent[3].mode, "lookup")
        client.handle(outcome: outcome(sent[3], applied()))
        completeMaintenance(client)
        XCTAssertEqual(sent.count, 4, "and still does not resume history")

        client.setForeground(true)
        XCTAssertEqual(sent.count, 5)
        XCTAssertEqual(sent[4].mode, "bootstrap")
        XCTAssertEqual(sent[4].pageToken, "p3", "resuming exactly where it paused")
    }

    /// The server paginates a lookup by bytes as well as by count, so a 50-id
    /// request can come back split. Starting ancestor resolution after the first
    /// page would silently drop every id the later pages carried.
    func testPaginatedLookupDrainsBeforeAncestorsAndHistory() throws {
        let client = makeClient()
        startWithEmptyCoverage(client)
        client.handle(outcome: outcome(sent[1], applied(nextPageToken: "history-2", complete: false)))
        XCTAssertEqual(sent[2].mode, "bootstrap", "History was mid-enumeration")

        client.lookup(sessionIds: ["a", "b"])
        client.handle(outcome: outcome(sent[2], applied(nextPageToken: "history-3", complete: false)))
        XCTAssertEqual(sent[3].mode, "lookup")
        XCTAssertEqual(sent[3].sessionIds, ["a", "b"])

        // First lookup page is byte-limited: the rest must still be fetched, and
        // no ancestor work starts yet.
        client.handle(outcome: outcome(sent[3], applied(nextPageToken: "lookup-2", complete: false)))
        XCTAssertEqual(sent[4].mode, "lookup")
        XCTAssertEqual(sent[4].pageToken, "lookup-2")
        XCTAssertEqual(sent[4].sessionIds, ["a", "b"], "The original id set carries across pages")
        XCTAssertTrue(maintenance.allSatisfy { $0.request != .missingAncestors(of: ["a", "b"]) })

        // Terminal lookup page: now ancestors resolve, from the original set.
        client.handle(outcome: outcome(sent[4], applied()))
        XCTAssertEqual(maintenance.last?.request, .missingAncestors(of: ["a", "b"]))
        completeMaintenance(client)

        // And history resumes from the page it was actually paused on.
        XCTAssertEqual(sent[5].mode, "bootstrap")
        XCTAssertEqual(sent[5].pageToken, "history-3")
    }

    /// A hint arriving while history is paused must not restart the enumeration
    /// from the beginning and throw away the saved page.
    func testHintDuringPausedHistoryDoesNotDiscardTheSavedPage() throws {
        let client = makeClient()
        startWithEmptyCoverage(client)
        client.handle(outcome: outcome(sent[1], applied(nextPageToken: "history-2", complete: false)))
        XCTAssertEqual(sent[2].pageToken, "history-2")

        client.setForeground(false)
        client.handle(outcome: outcome(sent[2], applied(nextPageToken: "history-3", complete: false)))
        XCTAssertEqual(sent.count, 3, "Paused at the page boundary")

        // Without proven coverage a hint restarts the bootstrap -- but from where
        // it paused, not from scratch.
        client.handle(changesAvailable: 400)
        XCTAssertEqual(sent.count, 3, "Still paused")
        client.setForeground(true)
        XCTAssertEqual(sent.count, 4)
        XCTAssertEqual(sent[3].mode, "bootstrap")
        XCTAssertEqual(sent[3].pageToken, "history-3", "The saved page survived the hint")
    }

    /// Navigation targets are bounded: a poller that never resolves cannot grow
    /// the queue without limit, and the newest tap is the one that matters.
    func testPendingLookupsAreCappedKeepingTheNewestTargets() throws {
        let client = makeClient()
        startWithEmptyCoverage(client)
        // Occupy the wire so everything queues behind it.
        client.handle(outcome: outcome(sent[1], applied(nextPageToken: "p2", complete: false)))

        let ids = (0..<(IndexReplicationClient.maxPendingLookupIds + 10)).map { "s\($0)" }
        client.lookup(sessionIds: ids)
        client.handle(outcome: outcome(sent[2], applied(nextPageToken: "p3", complete: false)))

        let requested = try XCTUnwrap(sent[3].sessionIds)
        XCTAssertEqual(requested.count, IndexReplicationClient.lookupBatchLimit)
        XCTAssertFalse(requested.contains("s0"), "The oldest targets were dropped when the cap was hit")
        XCTAssertTrue(requested.contains("s10"), "and the newest ones survived")
    }

    // MARK: - Failure surfacing

    /// A failure after negotiation must be visible. Leaving coverage looking
    /// healthy left the sidebar saying "still checking older history" forever.
    func testFailuresSurfaceAsCoverageErrorAndClearOnRetry() throws {
        let client = makeClient()
        startWithEmptyCoverage(client)
        XCTAssertFalse(client.coverage.hasError)

        client.handle(outcome: outcome(sent[1], .failed("decrypt")))
        XCTAssertTrue(client.coverage.hasError)
        XCTAssertFalse(client.coverage.isBackfilling)

        client.start()
        XCTAssertFalse(client.coverage.hasError, "A retry clears the previous failure")
        completeMaintenance(client)
        client.handle(outcome: outcome(sent.last!, applied()))
        XCTAssertFalse(client.coverage.hasError)
    }

    func testCancelledClientStopsRequestingAndIgnoresLateOutcomes() throws {
        let client = makeClient()
        client.start()
        completeMaintenance(client)
        let probe = sent[0]
        client.cancel()

        client.handle(outcome: outcome(probe, applied(cursor: 5)))
        client.handle(changesAvailable: 99)
        XCTAssertEqual(sent.count, 1, "A retired generation asks for nothing more")
        XCTAssertNil(client.coverage.lastCommittedRevision)
    }
}
