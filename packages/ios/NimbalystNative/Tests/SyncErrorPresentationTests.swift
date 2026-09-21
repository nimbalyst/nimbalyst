import XCTest
@testable import NimbalystNative

/// The banner's pure half. The view itself is not tested — a human looks at it,
/// and the exact strings and symbols are presentation, not behavior.
final class SyncErrorPresentationTests: XCTestCase {

    // MARK: - Copy rule

    /// A transport or timeout failure may still have landed. No headline may
    /// tell the user the operation failed outright; the detail sentence says
    /// what is uncertain instead.
    func testNoHeadlineClaimsTheOperationFailed() {
        let kinds: [SyncError.Kind] = [.transport, .decrypt, .storage, .requestTimeout]
        let claimsFailure = ["failed", "failure", "lost", "was not sent", "didn't send"]

        for kind in kinds {
            let title = SyncErrorPresentation.title(for: kind).lowercased()
            for phrase in claimsFailure {
                XCTAssertFalse(title.contains(phrase), "\(kind.rawValue) headline claims failure: \(title)")
            }
        }
    }

    // MARK: - Retry vs dismiss

    func testRetryIsOfferedOnlyWhenTheErrorCarriesAClosure() {
        XCTAssertTrue(SyncErrorPresentation.showsRetry(for: SyncError(kind: .transport, message: "m", retry: {})))
        XCTAssertFalse(SyncErrorPresentation.showsRetry(for: SyncError(kind: .decrypt, message: "m")))
    }

    // MARK: - Coalescing

    /// Two transport failures in a row are one banner. `SyncError.id` is a fresh
    /// UUID every time, so keying the view on it would re-animate the banner on
    /// each retry of the same reconnect.
    func testRepeatedIdenticalFailuresShareACoalesceKey() {
        let first = SyncError(kind: .transport, message: "Could not reach the sync server.")
        let second = SyncError(kind: .transport, message: "Could not reach the sync server.", retry: {})

        XCTAssertNotEqual(first.id, second.id)
        XCTAssertEqual(
            SyncErrorPresentation.coalesceKey(for: first),
            SyncErrorPresentation.coalesceKey(for: second)
        )
    }

    func testDifferentKindOrMessageIsADifferentBanner() {
        let transport = SyncError(kind: .transport, message: "same text")
        let storage = SyncError(kind: .storage, message: "same text")
        let otherMessage = SyncError(kind: .transport, message: "other text")

        XCTAssertNotEqual(
            SyncErrorPresentation.coalesceKey(for: transport),
            SyncErrorPresentation.coalesceKey(for: storage)
        )
        XCTAssertNotEqual(
            SyncErrorPresentation.coalesceKey(for: transport),
            SyncErrorPresentation.coalesceKey(for: otherMessage)
        )
    }

    func testClearedErrorHasNoCoalesceKey() {
        XCTAssertNil(SyncErrorPresentation.coalesceKey(for: nil as SyncError?))
    }
}
