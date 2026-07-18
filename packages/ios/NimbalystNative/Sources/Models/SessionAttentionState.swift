import Foundation

/// Pure reconciliation shared by full index merges and partial metadata
/// broadcasts. Explicit prompt state wins. A definitive idle execution state
/// heals an omitted stale prompt bit; genuinely partial updates preserve it.
enum SessionAttentionReconciler {
    static func pendingPrompt(
        existing: Bool,
        incoming: Bool?,
        isExecuting: Bool?
    ) -> Bool {
        if let incoming { return incoming }
        if isExecuting == false { return false }
        return existing
    }

    static func attention(
        existing: SessionAttentionState,
        incoming: AttentionSummary?
    ) -> SessionAttentionState {
        guard let incoming else { return existing }
        guard incoming.pending else { return .none }
        guard let severity = incoming.severity,
              let eventId = incoming.eventId,
              let deadline = incoming.effectiveDeadline else {
            return existing
        }
        return SessionAttentionState(
            pending: true,
            severity: severity,
            eventId: eventId,
            effectiveDeadline: deadline
        )
    }
}

struct SessionAttentionState: Equatable, Sendable {
    var pending: Bool
    var severity: String?
    var eventId: String?
    var effectiveDeadline: String?

    static let none = SessionAttentionState(
        pending: false,
        severity: nil,
        eventId: nil,
        effectiveDeadline: nil
    )
}

struct SessionAttentionPresentation: Equatable, Sendable {
    let systemImageName: String
    let label: String
    let isCritical: Bool

    static func make(from state: SessionAttentionState) -> SessionAttentionPresentation? {
        guard state.pending else { return nil }
        return SessionAttentionPresentation(
            systemImageName: state.severity == "critical"
                ? "exclamationmark.octagon.fill"
                : "exclamationmark.triangle.fill",
            label: state.severity == "critical" ? "Critical attention required" : "Attention required",
            isCritical: state.severity == "critical"
        )
    }
}
