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
    case undecodable(type: String?)

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
        guard let envelope = try? decoder.decode(ServerMessage.self, from: data) else {
            return .undecodable(type: nil)
        }
        switch envelope.type {
        case "indexSyncResponse":
            guard let response = try? decoder.decode(IndexSyncResponse.self, from: data) else {
                return .undecodable(type: envelope.type)
            }
            return .syncResponse(response)
        case "indexBroadcast":
            guard let broadcast = try? decoder.decode(IndexBroadcast.self, from: data) else {
                return .undecodable(type: envelope.type)
            }
            return .session(broadcast.session)
        case "indexDeleteBroadcast":
            guard let broadcast = try? decoder.decode(IndexDeleteBroadcast.self, from: data) else {
                return .undecodable(type: envelope.type)
            }
            return .delete(sessionId: broadcast.sessionId)
        case "projectBroadcast":
            guard let broadcast = try? decoder.decode(ProjectBroadcast.self, from: data) else {
                return .undecodable(type: envelope.type)
            }
            return .project(broadcast.project)
        case "indexPageResponse":
            guard let response = try? decoder.decode(IndexPageResponse.self, from: data) else {
                return .undecodable(type: envelope.type)
            }
            return .page(response)
        case "indexChangesAvailable":
            guard let hint = try? decoder.decode(IndexChangesAvailable.self, from: data) else {
                return .undecodable(type: envelope.type)
            }
            return .changesAvailable(revision: hint.revision)
        default:
            return .control(type: envelope.type, data: data)
        }
    }
}
