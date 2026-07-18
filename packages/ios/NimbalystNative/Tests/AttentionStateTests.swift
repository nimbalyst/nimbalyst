import XCTest
import CryptoKit
@testable import NimbalystNative

final class AttentionStateTests: XCTestCase {
    private func encryptedDraftMetadataRoundTrip(
        session: Session,
        draftInput: String,
        draftUpdatedAt: Int
    ) throws -> ClientMetadata {
        let encoded = try JSONEncoder().encode(ClientMetadata.preservingOpaqueState(
            from: session,
            draftInput: draftInput,
            draftUpdatedAt: draftUpdatedAt
        ))
        let plaintext = try XCTUnwrap(String(data: encoded, encoding: .utf8))
        let crypto = CryptoManager(key: SymmetricKey(data: Data(repeating: 0x36, count: 32)))
        let encrypted = try crypto.encrypt(plaintext: plaintext)
        let decrypted = try crypto.decrypt(
            encryptedBase64: encrypted.encrypted,
            ivBase64: encrypted.iv
        )
        return try JSONDecoder().decode(
            ClientMetadata.self,
            from: try XCTUnwrap(decrypted.data(using: .utf8))
        )
    }

    func testExplicitFalseClearsInteractivePrompt() {
        XCTAssertFalse(SessionAttentionReconciler.pendingPrompt(
            existing: true,
            incoming: false,
            isExecuting: true
        ))
    }

    func testAuthoritativeIdleHealsOmittedInteractivePrompt() {
        XCTAssertFalse(SessionAttentionReconciler.pendingPrompt(
            existing: true,
            incoming: nil,
            isExecuting: false
        ))
    }

    func testGenuinelyPartialUpdatePreservesInteractivePrompt() {
        XCTAssertTrue(SessionAttentionReconciler.pendingPrompt(
            existing: true,
            incoming: nil,
            isExecuting: nil
        ))
    }

    func testLaterNewInteractivePromptRearmsState() {
        let healed = SessionAttentionReconciler.pendingPrompt(
            existing: true,
            incoming: nil,
            isExecuting: false
        )
        XCTAssertTrue(SessionAttentionReconciler.pendingPrompt(
            existing: healed,
            incoming: true,
            isExecuting: true
        ))
    }

    func testGenericAttentionArmAndCancelAreSeparateFromInteractivePrompt() {
        let armed = SessionAttentionReconciler.attention(
            existing: .none,
            incoming: AttentionSummary(
                pending: true,
                severity: "critical",
                eventId: "event-1",
                effectiveDeadline: "2026-07-18T12:00:00.000Z"
            )
        )
        XCTAssertTrue(armed.pending)
        XCTAssertEqual(armed.eventId, "event-1")

        let cancelled = SessionAttentionReconciler.attention(
            existing: armed,
            incoming: AttentionSummary(
                pending: false,
                severity: nil,
                eventId: nil,
                effectiveDeadline: nil
            )
        )
        XCTAssertEqual(cancelled, .none)
    }

    func testAttentionPresentationIsUnmistakable() {
        let presentation = SessionAttentionPresentation.make(from: SessionAttentionState(
            pending: true,
            severity: "critical",
            eventId: "event-1",
            effectiveDeadline: "2026-07-18T12:00:00.000Z"
        ))
        XCTAssertEqual(presentation?.systemImageName, "exclamationmark.octagon.fill")
        XCTAssertEqual(presentation?.label, "Critical attention required")
        XCTAssertTrue(presentation?.isCritical == true)
    }

    func testAttentionColumnsRoundTripThroughDatabase() throws {
        let database = try DatabaseManager()
        try database.upsertProject(Project(id: "/attention", name: "attention"))
        let session = Session(
            id: "session-attention",
            projectId: "/attention",
            hasPendingPrompt: true,
            attentionPending: true,
            attentionSeverity: "normal",
            attentionEventId: "event-2",
            attentionEffectiveDeadline: "2026-07-18T13:00:00.000Z"
        )
        try database.upsertSession(session)

        let stored = try XCTUnwrap(database.session(byId: session.id))
        XCTAssertTrue(stored.hasPendingPrompt)
        XCTAssertTrue(stored.attentionPending)
        XCTAssertEqual(stored.attentionSeverity, "normal")
        XCTAssertEqual(stored.attentionEventId, "event-2")
    }

    func testNamingMarkerTriStateRoundTripsThroughDatabase() throws {
        let database = try DatabaseManager()
        try database.upsertProject(Project(id: "/naming", name: "naming"))

        let markers: [Bool?] = [nil, false, true]
        for (index, marker) in markers.enumerated() {
            let session = Session(
                id: "session-naming-\(index)",
                projectId: "/naming",
                hasBeenNamed: marker
            )
            try database.upsertSession(session)

            let stored = try XCTUnwrap(database.session(byId: session.id))
            XCTAssertEqual(stored.hasBeenNamed, marker)
        }
    }

    func testNamingMarkerReconciliationPreservesOmissionAndAppliesExplicitValues() {
        XCTAssertNil(SessionOpaqueMetadataReconciler.namingMarker(existing: nil, incoming: nil))
        XCTAssertEqual(SessionOpaqueMetadataReconciler.namingMarker(existing: true, incoming: nil), true)
        XCTAssertEqual(SessionOpaqueMetadataReconciler.namingMarker(existing: false, incoming: nil), false)
        XCTAssertEqual(SessionOpaqueMetadataReconciler.namingMarker(existing: true, incoming: false), false)
        XCTAssertEqual(SessionOpaqueMetadataReconciler.namingMarker(existing: false, incoming: true), true)
    }

    func testDraftWireMetadataPreservesPendingPromptAndAttention() throws {
        let session = Session(
            id: "session-draft-pending",
            projectId: "/attention",
            phase: "validating",
            tagsJson: "[\"ios\",\"attention\"]",
            hasPendingPrompt: true,
            attentionPending: true,
            attentionSeverity: "critical",
            attentionEventId: "event-draft",
            attentionEffectiveDeadline: "2026-07-18T14:00:00.000Z",
            contextTokens: 1200,
            contextWindow: 200000,
            hasBeenNamed: true
        )

        let decoded = try encryptedDraftMetadataRoundTrip(
            session: session,
            draftInput: "new draft",
            draftUpdatedAt: 1234
        )

        XCTAssertEqual(decoded.hasPendingPrompt, true)
        XCTAssertEqual(decoded.attentionSummary, AttentionSummary(
            pending: true,
            severity: "critical",
            eventId: "event-draft",
            effectiveDeadline: "2026-07-18T14:00:00.000Z"
        ))
        XCTAssertEqual(decoded.currentContext?.tokens, 1200)
        XCTAssertEqual(decoded.currentContext?.contextWindow, 200000)
        XCTAssertEqual(decoded.phase, "validating")
        XCTAssertEqual(decoded.tags ?? [], ["ios", "attention"])
        XCTAssertEqual(decoded.draftInput, "new draft")
        XCTAssertEqual(decoded.draftUpdatedAt, 1234)
        XCTAssertEqual(decoded.hasBeenNamed, true)
    }

    func testDraftWireMetadataPreservesExplicitPromptAndAttentionCancellation() throws {
        let session = Session(
            id: "session-draft-cleared",
            projectId: "/attention",
            hasPendingPrompt: false,
            attentionPending: false,
            hasBeenNamed: false
        )

        let decoded = try encryptedDraftMetadataRoundTrip(
            session: session,
            draftInput: "",
            draftUpdatedAt: 5678
        )

        XCTAssertEqual(decoded.hasPendingPrompt, false)
        XCTAssertEqual(decoded.attentionSummary, AttentionSummary(
            pending: false,
            severity: nil,
            eventId: nil,
            effectiveDeadline: nil
        ))
        XCTAssertEqual(decoded.draftInput, "")
        XCTAssertEqual(decoded.draftUpdatedAt, 5678)
        XCTAssertEqual(decoded.hasBeenNamed, false)
    }

    func testDraftWireMetadataOmitsUnknownNamingMarker() throws {
        let session = Session(
            id: "session-draft-unknown-name",
            projectId: "/attention",
            hasPendingPrompt: false,
            attentionPending: false,
            hasBeenNamed: nil
        )
        let metadata = ClientMetadata.preservingOpaqueState(
            from: session,
            draftInput: "draft without naming knowledge",
            draftUpdatedAt: 9012
        )
        let encoded = try JSONEncoder().encode(metadata)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertFalse(object.keys.contains("hasBeenNamed"))

        let decoded = try encryptedDraftMetadataRoundTrip(
            session: session,
            draftInput: "draft without naming knowledge",
            draftUpdatedAt: 9012
        )
        XCTAssertNil(decoded.hasBeenNamed)
    }
}
