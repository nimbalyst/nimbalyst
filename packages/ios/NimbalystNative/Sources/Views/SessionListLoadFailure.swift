import Foundation
import GRDB

/// Why the local session list could not be read. "Couldn't load sessions" used to
/// be the whole report, which could not tell a local database failure from a
/// failed server sync.
struct SessionListLoadFailure: Equatable {
    enum Stage: String {
        /// The live list query threw.
        case query
        /// Rebuilding the persisted grouping projection threw.
        case projection
    }

    let stage: Stage
    /// Shown on screen. For SQLite errors this is the engine message, never the
    /// statement or its arguments.
    let detail: String
    /// SQLite primary result code, or nil for a non-database error.
    let resultCode: Int?

    init(stage: Stage, error: Error) {
        self.stage = stage
        if let dbError = error as? DatabaseError {
            resultCode = Int(dbError.resultCode.rawValue)
            detail = "SQLite \(dbError.resultCode.rawValue): \(dbError.message ?? "no message")"
        } else {
            resultCode = nil
            detail = "\(type(of: error)): \(error.localizedDescription)"
        }
    }

    var analyticsProperties: [String: Any] {
        var props: [String: Any] = ["errorType": "sessionList", "stage": stage.rawValue]
        if let resultCode {
            props["sqliteResultCode"] = resultCode
            props["detail"] = detail
        }
        return props
    }
}
