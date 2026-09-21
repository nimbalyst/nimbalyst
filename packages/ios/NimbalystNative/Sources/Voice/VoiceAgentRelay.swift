#if os(iOS)
import Foundation

@MainActor
extension VoiceAgent {
    func callDesktopTool(callId: String, toolName: String, argsJson: String, projectId: String) async -> SyncManager.VoiceToolCallResult {
        guard let syncManager else { return .init(success: false, result: nil, error: "Desktop sync is unavailable.") }
        guard effectiveEngine == .live else {
            return await syncManager.callVoiceTool(toolName: toolName, argsJson: argsJson, projectId: projectId)
        }
        guard toolResults.contains(callId), let scope = toolScopes[callId], scope.projectId == projectId,
              scope.voiceGeneration == connectionGeneration.value.uuidString else {
            return .init(success: false, result: nil, error: "This voice request no longer has a valid computer/session binding.")
        }
        return await syncManager.callLiveVoiceTool(toolName: toolName, argsJson: argsJson, scope: scope)
    }

    func handleOpenFile(args: [String: Any], callId: String) {
        guard let project = resolveProjectId(), let reference = args["path"] as? String,
              let docs = try? database?.documents(forProject: project),
              let file = VoiceFileTarget.resolve(reference, documents: docs, projectId: project), let onOpenDocument else {
            sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "error": "Use an exact relative path for one synced file in the current project."]))
            return
        }
        fileContext = file.relativePath
        onOpenDocument(project, file.id)
        sendToolResult(callId: callId, output: Self.encodeArgs(["success": true, "path": file.relativePath, "document_id": file.id]))
    }
}
#endif
