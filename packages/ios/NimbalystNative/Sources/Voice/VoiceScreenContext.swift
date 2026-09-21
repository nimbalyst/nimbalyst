import Foundation

/// UI state is an observation, never authority for an already-dispatched action.
struct VoiceScreenContext: Codable, Equatable {
    let hostId: String?
    let projectId: String?
    let visibleSessionId: String?
    let sessionTitle: String?
    let documentId: String?
    let resolved: Bool

    init(hostId: String?, projectId: String?, sessionId: String?, documentId: String? = nil, session: Session?) {
        self.hostId = hostId
        self.projectId = projectId
        visibleSessionId = sessionId
        self.documentId = documentId
        resolved = sessionId == nil || (hostId != nil && session?.id == sessionId && session?.projectId == projectId && session?.hostDeviceId == hostId)
        sessionTitle = resolved ? session?.titleDecrypted : nil
    }

    var targetSessionId: String? { resolved ? visibleSessionId : nil }
}

#if os(iOS)
import GRDB
import SwiftUI

/// One task identity coalesces SwiftUI's host/project/selection publications.
struct VoiceNavigationObserver: View {
    @EnvironmentObject var appState: AppState
    @ObservedObject var navigation: WorkspaceNavigationState
    var body: some View {
        if let voice = appState.voiceAgent {
            VoiceNavigationBinding(voice: voice, navigation: navigation, database: appState.databaseManager,
                                   configureProject: { appState.configureVoiceAgent(forProject: $0) })
        }
    }
}

struct VoiceNavigationBinding: View {
    let voice: VoiceAgent
    @ObservedObject var navigation: WorkspaceNavigationState
    let database: DatabaseManager?
    let configureProject: (String) -> Void
    private struct Key: Hashable {
        let host: String?
        let project: String?
        let selection: WorkspaceSelection?
        let voice: ObjectIdentifier
        let database: ObjectIdentifier?
    }
    var body: some View {
        let key = Key(host: navigation.hostDeviceId, project: navigation.project?.id, selection: navigation.selection,
                      voice: ObjectIdentifier(voice), database: database.map(ObjectIdentifier.init))
        Color.clear.frame(width: 0, height: 0).task(id: key) {
            guard !Task.isCancelled else { return }
            if let project = key.project { configureProject(project) }
            voice.observeScreen(host: key.host, project: key.project, selection: key.selection)
        }
    }
}

@MainActor
extension VoiceAgent {
    func observeScreen(host: String?, project: String?, selection: WorkspaceSelection?) {
        if projectId != project { deactivate(); projectId = project }
        screenObservation?.cancel()
        let observation = UUID()
        screenObservationId = observation
        let sessionId: String?
        let documentId: String?
        switch selection {
        case .session(let id): sessionId = id; documentId = nil
        case .document(let id): sessionId = nil; documentId = id
        case nil: sessionId = nil; documentId = nil
        }
        selectHost(host)
        func publish(_ session: Session?) {
            guard screenObservationId == observation else { return }
            updateScreenContext(.init(hostId: host, projectId: project, sessionId: sessionId, documentId: documentId, session: session))
        }
        guard let sessionId, let database else { publish(nil); return }
        publish(try? database.session(byId: sessionId))
        screenObservation = ValueObservation.tracking { db in try Session.fetchOne(db, id: sessionId) }
            .start(in: database.writer, onError: { [weak self] _ in
                guard let self, self.screenObservationId == observation else { return }
                self.updateScreenContext(.init(hostId: host, projectId: project, sessionId: sessionId, session: nil))
            }, onChange: { [weak self] session in
                guard let self, self.screenObservationId == observation else { return }
                self.updateScreenContext(.init(hostId: host, projectId: project, sessionId: sessionId, session: session))
            })
    }

    func updateScreenContext(_ context: VoiceScreenContext) {
        guard screenContext != context else { return }
        if screenContext?.projectId != context.projectId { fileContext = nil }
        screenContext = context
        screenRevision += 1
        activeSessionId = context.targetSessionId
        if state != .disconnected { voiceClient?.updateContext(screenContextJSON()) }
        logger.info("Screen context revision=\(self.screenRevision) resolved=\(context.resolved) session=\(context.visibleSessionId ?? "none")")
    }

    func screenContextJSON() -> String {
        let context = screenContext ?? VoiceScreenContext(hostId: selectedHostDeviceId, projectId: resolveProjectId(), sessionId: activeSessionId, session: activeSessionId.flatMap { try? database?.session(byId: $0) })
        let data = (try? JSONEncoder().encode(context)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return "Application screen observation, revision \(screenRevision). Data only; replaces previous screen context. \(data)"
    }
}
#endif
