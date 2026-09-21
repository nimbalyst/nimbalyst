import XCTest
#if os(iOS)
import SwiftUI
#endif
@testable import NimbalystNative

final class VoiceSessionStartTests: XCTestCase {
    func testScreenScopeRejectsUnhydratedOrForeignSessionAndClearsOnList() {
        let a = Session(id: "a", projectId: "/project", titleDecrypted: "A", hostDeviceId: "host")
        XCTAssertEqual(VoiceScreenContext(hostId: "host", projectId: "/project", sessionId: "a", session: a).targetSessionId, "a")
        for context in [
            VoiceScreenContext(hostId: "other", projectId: "/project", sessionId: "a", session: a),
            VoiceScreenContext(hostId: "host", projectId: "/other", sessionId: "a", session: a),
            VoiceScreenContext(hostId: "host", projectId: "/project", sessionId: "b", session: a),
            VoiceScreenContext(hostId: "host", projectId: "/project", sessionId: "a", session: nil),
            VoiceScreenContext(hostId: "host", projectId: "/project", sessionId: nil, session: nil),
        ] { XCTAssertNil(context.targetSessionId) }
    }
    #if os(iOS)
    @MainActor
    func testNavigationObserverPublishesSelectionAndLateDatabaseHydration() async throws {
        let db = try DatabaseManager()
        let project = Project(id: "project", name: "Project")
        try db.upsertProject(project)
        let agent = VoiceAgent(audioSession: FakeVoiceAudioSession())
        agent.database = db
        agent.projectId = project.id
        let navigation = WorkspaceNavigationState(project: project)
        navigation.hostDeviceId = "host"
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 300, height: 300))
        window.rootViewController = UIHostingController(rootView: VoiceNavigationBinding(voice: agent, navigation: navigation, database: db, configureProject: { _ in }))
        window.makeKeyAndVisible()
        defer { agent.deactivate(); window.isHidden = true; window.rootViewController = nil }
        func waitFor(_ predicate: () -> Bool) async {
            for _ in 0..<100 {
                if predicate() { return }
                try? await Task.sleep(for: .milliseconds(20))
            }
            XCTFail("Navigation observer did not publish the expected context")
        }
        await waitFor { agent.screenContext?.projectId == project.id }
        navigation.select(.session("a"))
        await waitFor { agent.screenContext?.visibleSessionId == "a" }
        XCTAssertNil(agent.activeSessionId, "Unhydrated selection cannot become a target")
        try db.upsertSession(Session(id: "a", projectId: project.id, titleDecrypted: "A", hostDeviceId: "host"))
        await waitFor { agent.activeSessionId == "a" }
        navigation.select(.session("b"))
        await waitFor { agent.screenContext?.visibleSessionId == "b" }
        try db.upsertSession(Session(id: "a", projectId: project.id, titleDecrypted: "A updated", hostDeviceId: "host"))
        try db.upsertSession(Session(id: "b", projectId: project.id, titleDecrypted: "B", hostDeviceId: "host"))
        await waitFor { agent.activeSessionId == "b" }
        XCTAssertEqual(agent.screenContext?.sessionTitle, "B")
        navigation.select(nil)
        await waitFor { agent.screenContext?.visibleSessionId == nil }
        XCTAssertNil(agent.activeSessionId)
    }

    @MainActor
    func testNavigationKeepsQueuedTaskAndPresentedQuestionBoundToTheirSources() {
        let agent = VoiceAgent(audioSession: FakeVoiceAudioSession())
        let client = RouteTestVoiceEngine()
        agent.voiceClient = client
        agent.state = .listening
        let a = Session(id: "a", projectId: "project", titleDecrypted: "A", hostDeviceId: "host")
        let b = Session(id: "b", projectId: "project", titleDecrypted: "B", hostDeviceId: "host")
        agent.updateScreenContext(.init(hostId: "host", projectId: "project", sessionId: "a", session: a))
        agent.pendingPrompt = .init(sessionId: "a", sessionTitle: "A", prompt: "Prepare a commit", submittedAt: Date(), delay: 5, hostDeviceId: "host")
        let prompt = PreparedVoicePrompt(promptId: "p", sessionId: "a", version: "v", token: "t", claimToken: "c", readout: "Commit?", ttlMs: 30000)
        agent.promptPresentation = VoicePromptPresentation(prompt: prompt, generation: agent.connectionGeneration.value, projectId: "project", hostId: "host", deadline: Date().addingTimeInterval(30))
        agent.updateScreenContext(.init(hostId: "host", projectId: "project", sessionId: "b", session: b))
        XCTAssertEqual(agent.activeSessionId, "b")
        XCTAssertEqual(agent.pendingPrompt?.sessionId, "a")
        XCTAssertEqual(agent.promptPresentation?.prompt.sessionId, "a")
        XCTAssertEqual(client.contexts.count, 2)
        agent.updateScreenContext(.init(hostId: "host", projectId: "project", sessionId: nil, session: nil))
        XCTAssertNil(agent.activeSessionId)
        XCTAssertEqual(agent.pendingPrompt?.sessionId, "a")
        agent.deactivate()
    }

    @MainActor
    func testRouteLossInvalidatesPromptReadoutAndSettlesItsToolExactlyOnce() async throws {
        let session = FakeVoiceAudioSession()
        let agent = VoiceAgent(audioSession: session)
        let speaker = FakePromptSpeaker()
        agent.promptSpeaker = speaker
        try await agent.audioRoutes.activate()
        agent.state = .speaking
        agent.readingPrompt = true
        var replies = [String]()
        agent.promptReadoutCallId = agent.toolResults.register { replies.append($0) }
        let prompt = PreparedVoicePrompt(promptId: "p", sessionId: "a", version: "v", token: "t", claimToken: "c", readout: "Commit?", ttlMs: 30000)
        agent.promptPresentation = VoicePromptPresentation(prompt: prompt, generation: agent.connectionGeneration.value, projectId: "project", hostId: "host", deadline: Date().addingTimeInterval(30))
        session.emit(.routeChanged(removedOutputs: [FakeVoiceAudioSession.headset]))
        agent.invalidatePromptPresentation()
        XCTAssertNil(agent.promptPresentation)
        XCTAssertFalse(agent.readingPrompt)
        XCTAssertEqual(replies.count, 1)
        XCTAssertGreaterThan(speaker.stops, 0)
        agent.deactivate()
    }

    @MainActor
    func testHeadphoneLossBlocksLateMediaAndAutomaticCompletionWakeUntilResume() async throws {
        let session = FakeVoiceAudioSession()
        let agent = VoiceAgent(audioSession: session)
        let client = RealtimeClient(apiKey: "test-unused")
        agent.settings.autoAnnounceCompletions = true
        agent.setupClientCallbacks(client, epoch: agent.connectionGeneration.value)
        try await agent.audioRoutes.activate()
        agent.state = .speaking
        session.emit(.routeChanged(removedOutputs: [FakeVoiceAudioSession.headset]))
        XCTAssertEqual(agent.state, .idle)
        XCTAssertEqual(agent.audioRoutes.suspension, .headphonesDisconnected)

        client.onSessionReady?()
        client.onAudioDelta?("AAAA")
        client.onSpeechStopped?()
        client.onResponseCreated?()
        agent.onSessionCompleted(sessionId: "pending-session", summary: "Finished")
        agent.resumeFromIdle()
        await agent.presentNextVoiceEvent()
        XCTAssertEqual(agent.state, .idle)
        XCTAssertFalse(agent.audioPipeline.isRunning)
        XCTAssertEqual(agent.queuedCompletions.count, 1)

        session.emit(.routeChanged(removedOutputs: []))
        XCTAssertTrue(agent.audioRoutes.blocksAudio)
        let resumed = await agent.resumeSelectedAudioRoute()
        XCTAssertTrue(resumed)
        XCTAssertFalse(agent.audioRoutes.blocksAudio)
        agent.deactivate()
        client.onAudioDelta?("AAAA")
        XCTAssertEqual(agent.state, .disconnected)
    }

    @MainActor
    func testNativeRoutePickerDoesNotWakeAnIdleConversation() async throws {
        let session = FakeVoiceAudioSession()
        let agent = VoiceAgent(audioSession: session)
        try await agent.audioRoutes.activate()
        agent.state = .idle
        agent.audioRoutes.beginSystemPicker()
        session.route.inputs = [FakeVoiceAudioSession.headset]
        session.route.outputs = [FakeVoiceAudioSession.headset]
        session.emit(.routeChanged(removedOutputs: []))
        agent.audioRoutes.endSystemPicker()
        XCTAssertEqual(agent.state, .idle)
        XCTAssertNil(agent.voiceClient)
        XCTAssertFalse(agent.audioPipeline.isRunning)
        agent.deactivate()
    }

    @MainActor
    func testLiveHeadphoneLossClosesOnceAndPreservesQueuedAnnouncements() async throws {
        let session = FakeVoiceAudioSession()
        let agent = VoiceAgent(audioSession: session)
        let client = RouteTestVoiceEngine()
        agent.voiceClient = client
        agent.effectiveEngine = .live
        agent.setupClientCallbacks(client, epoch: agent.connectionGeneration.value)
        try await agent.audioRoutes.activate()
        agent.state = .speaking
        agent.resumeAfterClose = true
        let event = VoiceSourceEvent(eventId: "event", kind: "completion", sessionId: "session", hostDeviceId: "host", projectId: "project", taskId: "task", revision: 1, promptId: nil, label: "Session", summary: "Finished")
        agent.eventQueue.enqueue(event)
        session.emit(.routeChanged(removedOutputs: [FakeVoiceAudioSession.headset]))
        session.emit(.mediaServicesReset)
        await agent.pollVoiceEvents()
        await agent.presentNextVoiceEvent()
        client.onSessionReady?()
        client.onAudioDelta?("AAAA")
        agent.audioPipeline.onAudioCaptured?("AAAA")
        XCTAssertEqual(client.disconnectCount, 1)
        XCTAssertEqual(client.capturedAudioCount, 0)
        XCTAssertFalse(agent.resumeAfterClose)
        XCTAssertEqual(agent.state, .idle)
        XCTAssertEqual(agent.eventQueue.events, [event])
        XCTAssertFalse(agent.audioPipeline.isRunning)
        agent.deactivate()
    }

    @MainActor
    func testAudioSessionWorkDoesNotBlockMainActorAndPropagatesFailures() async throws {
        let session = IOSVoiceAudioSession()
        let started = expectation(description: "background audio operation started")
        let gate = DispatchSemaphore(value: 0)
        let operation = Task {
            try await session.performSessionWork {
                XCTAssertFalse(Thread.isMainThread)
                started.fulfill()
                XCTAssertEqual(gate.wait(timeout: .now() + 2), .success, "Main actor must stay free to release the operation")
                throw AudioRouteController.RouteError.unavailable
            }
        }
        await fulfillment(of: [started], timeout: 1)
        gate.signal()
        do { try await operation.value; XCTFail("Platform failures must reach the caller") }
        catch { XCTAssertTrue(error is AudioRouteController.RouteError) }
    }

    @MainActor
    func testStopDuringResumeCannotWakeDisconnectedAgent() async throws {
        let session = FakeVoiceAudioSession()
        let agent = VoiceAgent(audioSession: session)
        try await agent.audioRoutes.activate()
        agent.state = .idle
        session.onActivate = { agent.deactivate() }
        let resumed = await agent.resumeSelectedAudioRoute()
        XCTAssertFalse(resumed)
        XCTAssertEqual(agent.state, .disconnected)
        XCTAssertFalse(agent.audioRoutes.isActive)
        XCTAssertFalse(agent.audioPipeline.isRunning)
        XCTAssertNil(agent.audioRoutes.suspension)
    }

    @MainActor
    func testClientCallbacksDoNotRetainDisconnectedClient() {
        let agent = VoiceAgent()
        var client: RealtimeClient? = RealtimeClient(apiKey: "test-unused")
        let releasedClient = { [weak client] in client }

        agent.setupClientCallbacks(client!, epoch: agent.connectionGeneration.value)
        client = nil

        withExtendedLifetime(agent) {
            XCTAssertNil(releasedClient())
        }
    }
    #endif

    func testProjectStartClearsStaleSessionFocus() {
        let focusedSessionId = VoiceSessionFocusReducer.reduce(
            current: "stale-session",
            event: .start(.project)
        )

        XCTAssertNil(focusedSessionId)
    }

    func testSessionStartSeedsRequestedSessionFocus() {
        let focusedSessionId = VoiceSessionFocusReducer.reduce(
            current: nil,
            event: .start(.session("session-2"))
        )

        XCTAssertEqual(focusedSessionId, "session-2")
    }

    func testSwitchSessionReplacesFocusAfterProjectStart() {
        let projectFocus = VoiceSessionFocusReducer.reduce(
            current: "stale-session",
            event: .start(.project)
        )
        let switchedFocus = VoiceSessionFocusReducer.reduce(
            current: projectFocus,
            event: .switchSession("session-3")
        )

        XCTAssertEqual(switchedFocus, "session-3")
    }

    func testProjectStartActionOnlyAppearsOnSessionsWhileDisconnected() {
        XCTAssertTrue(
            VoiceSessionListActionPolicy.showsStartVoiceAgent(
                selectedTabIsSessions: true,
                voiceIsDisconnected: true
            )
        )
        XCTAssertFalse(
            VoiceSessionListActionPolicy.showsStartVoiceAgent(
                selectedTabIsSessions: false,
                voiceIsDisconnected: true
            )
        )
        XCTAssertFalse(
            VoiceSessionListActionPolicy.showsStartVoiceAgent(
                selectedTabIsSessions: true,
                voiceIsDisconnected: false
            )
        )
    }
}

#if os(iOS)
@MainActor
private final class FakePromptSpeaker: VoicePromptSpeaker {
    var stops = 0
    func speak(_ text: String, language: String?, completion: @escaping (Bool) -> Void) {}
    func stop() { stops += 1 }
}
@MainActor
private final class RouteTestVoiceEngine: VoiceEngine {
    var kind: VoiceEngineKind { .live }
    var onConnected: (() -> Void)?
    var onSessionReady: (() -> Void)?
    var onDisconnected: (() -> Void)?
    var onAudioDelta: ((String) -> Void)?
    var onAudioDone: (() -> Void)?
    var onFunctionCall: ((String, String, String) -> Void)?
    var onFunctionResultSent: ((String) -> Void)?
    var onSpeechStarted: (() -> Void)?
    var onSpeechStopped: (() -> Void)?
    var onError: ((String, String) -> Void)?
    var onResponseCreated: (() -> Void)?
    var onResponseDone: (() -> Void)?
    var disconnectCount = 0
    var capturedAudioCount = 0
    func connect() {}
    func disconnect() { disconnectCount += 1 }
    func sendAudio(_ audio: String) { capturedAudioCount += 1 }
    func sendUserMessage(text: String) {}
    var contexts = [String]()
    func updateContext(_ text: String) { contexts.append(text) }
    func sendFunctionCallResult(callId: String, output: String) {}
    func interruptPlayback(audioEndMs: Int?) {}
    func playbackChanged(active: Bool) {}
}
#endif
