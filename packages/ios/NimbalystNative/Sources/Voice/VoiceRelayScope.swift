import Foundation

/// Inside the encrypted tool arguments/result. The existing server only relays ciphertext.
struct VoiceRelayScope: Codable, Equatable, Sendable {
    let version: Int
    let hostDeviceId: String
    let projectId: String
    let sessionId: String?
    let voiceGeneration: String
    let actionId: String
    let announcingDeviceId: String
}

struct VoiceRelayRequest: Codable {
    let scope: VoiceRelayScope
    let tool: String
    let arguments: String
}

struct VoiceRelayResponse: Codable {
    let scope: VoiceRelayScope
    let success: Bool
    let result: String?
    let error: String?
}

enum VoiceFileTarget {
    static func resolve(_ reference: String, documents: [SyncedDocument], projectId: String) -> SyncedDocument? {
        let path = reference.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"),
              !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == ".." || $0 == "." || $0.isEmpty }) else { return nil }
        let candidates = documents.filter { $0.projectId == projectId && ($0.relativePath == path || (!$0.relativePath.isEmpty && $0.displayName == path)) }
        guard candidates.count == 1 else { return nil }
        return candidates[0]
    }
}
