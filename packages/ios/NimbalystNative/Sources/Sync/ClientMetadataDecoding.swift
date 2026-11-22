import Foundation
import os

/// Reads the decrypted client metadata blob one field at a time.
///
/// Every field in the blob is display-only (context meter, phase, tags, draft,
/// naming marker), so one malformed field must not hide the whole session. The
/// synthesized decoder failed the entire blob when a desktop on SQLite sent
/// `hasBeenNamed` as 0/1, and the strict index policy then skipped every session
/// created from the phone. Booleans accept 0/1; any other unreadable field
/// degrades to nil (which `apply` and `mergeDraft` treat as "said nothing") and
/// is reported by name so the failure is visible instead of silent.
struct ClientMetadataDecoding {
    let metadata: ClientMetadata
    /// Keys present in the blob that could not be read, in a stable order.
    let unreadableFields: [String]

    /// A field whose loss changes behavior rather than display. Losing it keeps
    /// the strict policy: the row is skipped rather than guessed.
    static let fieldsThatMustBeRead: Set<String> = ["transcriptSyncDisabled"]

    /// Throws only when the blob is not a JSON object at all.
    static func decode(_ data: Data) throws -> ClientMetadataDecoding {
        try JSONDecoder().decode(Box.self, from: data).result
    }

    private struct Box: Decodable {
        let result: ClientMetadataDecoding

        private enum Key: String, CodingKey {
            case currentContext, hasPendingPrompt, phase, tags, draftInput, draftUpdatedAt, hasBeenNamed, transcriptSyncDisabled
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: Key.self)
            var unreadable: [String] = []

            func value<T: Decodable>(_ key: Key, as type: T.Type = T.self) -> T? {
                guard container.contains(key), (try? container.decodeNil(forKey: key)) != true else { return nil }
                if let decoded = try? container.decode(T.self, forKey: key) { return decoded }
                unreadable.append(key.stringValue)
                return nil
            }

            func flag(_ key: Key) -> Bool? {
                guard container.contains(key), (try? container.decodeNil(forKey: key)) != true else { return nil }
                if let decoded = try? container.decode(Bool.self, forKey: key) { return decoded }
                if let number = try? container.decode(Int.self, forKey: key), number == 0 || number == 1 { return number == 1 }
                unreadable.append(key.stringValue)
                return nil
            }

            let metadata = ClientMetadata(
                currentContext: value(.currentContext, as: ContextInfo.self),
                hasPendingPrompt: flag(.hasPendingPrompt),
                phase: value(.phase, as: String.self),
                tags: value(.tags, as: [String].self),
                draftInput: value(.draftInput, as: String.self),
                draftUpdatedAt: value(.draftUpdatedAt, as: Int.self),
                hasBeenNamed: flag(.hasBeenNamed),
                transcriptSyncDisabled: flag(.transcriptSyncDisabled)
            )
            result = ClientMetadataDecoding(metadata: metadata, unreadableFields: unreadable)
        }
    }
}

/// Makes index rows the phone could not fully read visible: a log line, a
/// "Copy diagnostics" entry and a throttled `mobile_sync_error` event. Field
/// names only, never values. Before this, a skipped row was a bare count.
enum IndexRowDiagnostics {
    private static let logger = Logger(subsystem: "com.nimbalyst.app", category: "IndexDecrypt")

    /// The whole row was skipped and the session is missing from this device.
    static func skipped(field: String) {
        logger.warning("Index row skipped: unreadable \(field, privacy: .public)")
        report(code: "indexRowSkipped.\(field)")
    }

    /// The row was kept but one display field was dropped.
    static func degraded(field: String) {
        logger.warning("Index row kept without unreadable field \(field, privacy: .public)")
        report(code: "clientMetadataField.\(field)")
    }

    private static func report(code: String) {
        Task { @MainActor in
            throttle.observe(SyncError(kind: .decrypt, message: "A synced session field could not be read.", code: code))
        }
    }

    @MainActor private static var throttle = SyncErrorAnalyticsThrottle()
}
