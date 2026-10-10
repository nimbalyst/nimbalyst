import XCTest
@testable import NimbalystNative

/// The teardown save (no revision) is skipped when native already wrote that text.
final class WikiEditorSaveLedgerTests: XCTestCase {
    func testTeardownSaveDoesNotOverwriteANewerRemoteWithPersistedText() {
        var ledger = EditorSaveLedger()
        ledger.loaded("A")
        XCTAssertTrue(ledger.shouldPersist("AB", revision: 1))
        ledger.persisted("AB")
        // A remote R persists after close stopped observing; the bundle never
        // heard the ack and hands back AB as its final body.
        XCTAssertFalse(ledger.shouldPersist("AB", revision: nil))
        // Text native never wrote still saves (last write wins).
        XCTAssertTrue(ledger.shouldPersist("ABC", revision: nil))
        // A remote seen while open becomes the reference.
        ledger.loaded("R")
        XCTAssertTrue(ledger.shouldPersist("AB", revision: nil))
        XCTAssertTrue(ledger.shouldPersist("R", revision: 2), "a revisioned save always runs so it can be acked")
    }
}
