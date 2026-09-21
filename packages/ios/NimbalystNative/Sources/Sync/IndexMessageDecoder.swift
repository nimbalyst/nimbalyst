import Foundation

/// An index-room message after JSON decoding, ready to route.
///
/// Decoding a cold index envelope means building thousands of entry structs, so
/// it does not belong on the main actor. Routing does: it is a pointer move plus
/// a state change.
enum DecodedIndexMessage: @unchecked Sendable {
    case syncResponse(IndexSyncResponse)
    case session(ServerSessionEntry)
    case project(ServerProjectEntry)
    case delete(sessionId: String)
    /// Versioned replication page.
    case page(IndexPageResponse)
    /// The server's "there is newer data" hint. Not a cursor.
    case changesAvailable(revision: Int)
    /// Small control traffic (devices, settings, command responses, errors),
    /// decoded by its existing handler on the main actor.
    case control(type: String, data: Data)
    case undecodable(type: String?, detail: String)

    var isIndexData: Bool {
        switch self {
        case .syncResponse, .session, .project, .delete, .page: return true
        case .changesAvailable, .control, .undecodable: return false
        }
    }
}

/// The decoded message plus what it cost, so the pipeline can be measured end to
/// end rather than from the first step we happen to own.
struct DecodedIndexMessageResult: @unchecked Sendable {
    let message: DecodedIndexMessage
    let byteCount: Int
    let decodeMs: Double
    /// False when the decode ran on the main actor. Only the synchronous
    /// compatibility entry point does that; the production path must not.
    let decodedOffMainActor: Bool
}

/// Decodes index-room messages away from the main actor.
///
/// An actor rather than a detached task per message: the socket handler awaits
/// each decode before reading the next message, so messages stay in arrival
/// order and no two decodes overlap. Independent tasks would give neither.
actor IndexMessageDecoder {
    private let decoder = JSONDecoder()

    func decode(_ data: Data) -> DecodedIndexMessageResult {
        Self.decode(data, using: decoder)
    }

    /// Same decode, on whatever thread the caller is already on. Used by the
    /// synchronous compatibility entry point so both paths share one
    /// implementation and cannot drift.
    nonisolated static func decode(_ data: Data, using decoder: JSONDecoder = JSONDecoder()) -> DecodedIndexMessageResult {
        let start = DispatchTime.now()
        let offMain = !Thread.isMainThread
        let message = classify(data, decoder: decoder)
        let decodeMs = Double(DispatchTime.now().uptimeNanoseconds &- start.uptimeNanoseconds) / 1_000_000
        return DecodedIndexMessageResult(
            message: message,
            byteCount: data.count,
            decodeMs: decodeMs,
            decodedOffMainActor: offMain
        )
    }

    private nonisolated static func classify(_ data: Data, decoder: JSONDecoder) -> DecodedIndexMessage {
        var type: String?
        do {
            let envelope = try decoder.decode(ServerMessage.self, from: data)
            type = envelope.type
            switch envelope.type {
            case "indexSyncResponse":
                return .syncResponse(try decoder.decode(IndexSyncResponse.self, from: data))
            case "indexBroadcast":
                return .session(try decoder.decode(IndexBroadcast.self, from: data).session)
            case "indexDeleteBroadcast":
                return .delete(sessionId: try decoder.decode(IndexDeleteBroadcast.self, from: data).sessionId)
            case "projectBroadcast":
                return .project(try decoder.decode(ProjectBroadcast.self, from: data).project)
            case "indexPageResponse":
                return .page(try decoder.decode(IndexPageResponse.self, from: data))
            case "indexChangesAvailable":
                return .changesAvailable(revision: try decoder.decode(IndexChangesAvailable.self, from: data).revision)
            default:
                return .control(type: envelope.type, data: data)
            }
        } catch {
            return .undecodable(type: type, detail: decodingFailure(error))
        }
    }

    /// Field locations explain contract failures without logging ciphertext,
    /// identifiers, or decoder descriptions that can contain the rejected value.
    private nonisolated static func decodingFailure(_ error: Error) -> String {
        let path: [any CodingKey]
        let reason: String
        switch error {
        case DecodingError.keyNotFound(let key, let context):
            path = context.codingPath + [key]
            reason = "missing field"
        case DecodingError.valueNotFound(_, let context):
            path = context.codingPath
            reason = "null value"
        case DecodingError.typeMismatch(_, let context):
            path = context.codingPath
            reason = "wrong type"
        case DecodingError.dataCorrupted(let context):
            path = context.codingPath
            reason = "invalid data"
        default:
            return "decoding failed"
        }
        let location = path.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
        return "\(reason) at \(location.isEmpty ? "root" : location)"
    }
}
