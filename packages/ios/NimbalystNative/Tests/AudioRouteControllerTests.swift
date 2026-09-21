import XCTest
@testable import NimbalystNative

@MainActor
final class AudioRouteControllerTests: XCTestCase {
    func testSelectionWaitsForActualRouteAndTimesOutWithoutInventingSuccess() async throws {
        let session = FakeVoiceAudioSession()
        let routes = AudioRouteController(session: session, selectionTimeout: .milliseconds(10))
        try await routes.activate()
        routes.selectInput(FakeVoiceAudioSession.headset.id)
        XCTAssertTrue(routes.isSwitching)
        XCTAssertEqual(routes.route.inputs, [FakeVoiceAudioSession.mic])
        session.route.inputs = [FakeVoiceAudioSession.headset]
        session.route.outputs = [FakeVoiceAudioSession.headset]
        session.emit(.routeChanged(removedOutputs: []))
        XCTAssertFalse(routes.isSwitching)
        XCTAssertTrue(routes.route.usesBluetoothPair)

        routes.useSpeaker()
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertFalse(routes.isSwitching)
        XCTAssertNotNil(routes.error)
        XCTAssertEqual(routes.route.outputs, [FakeVoiceAudioSession.headset])
        routes.stop()
    }

    func testRemovedDeviceSupersedesSelectionAndReconnectDoesNotResume() async throws {
        let session = FakeVoiceAudioSession()
        let routes = AudioRouteController(session: session)
        try await routes.activate()
        routes.selectInput(FakeVoiceAudioSession.headset.id)
        session.route.availableInputs = [FakeVoiceAudioSession.mic]
        session.emit(.routeChanged(removedOutputs: [FakeVoiceAudioSession.headset]))
        XCTAssertFalse(routes.isSwitching)
        XCTAssertEqual(routes.suspension, .headphonesDisconnected)
        session.route.availableInputs.append(FakeVoiceAudioSession.headset)
        session.emit(.routeChanged(removedOutputs: []))
        XCTAssertTrue(routes.blocksAudio)
        session.emit(.interruptionEnded)
        XCTAssertTrue(routes.blocksAudio)
        try await routes.resume()
        XCTAssertFalse(routes.blocksAudio)
        routes.stop()
    }

    func testStaleInputAndFailedSelectionPreserveActualRoute() async throws {
        let session = FakeVoiceAudioSession()
        let routes = AudioRouteController(session: session)
        try await routes.activate()
        routes.selectInput("gone")
        XCTAssertEqual(session.inputRequests.count, 0)
        XCTAssertNotNil(routes.error)
        session.failSelection = true
        routes.selectInput(FakeVoiceAudioSession.headset.id)
        XCTAssertFalse(routes.isSwitching)
        XCTAssertNotNil(routes.error)
        XCTAssertEqual(routes.route.inputs, [FakeVoiceAudioSession.mic])
        XCTAssertEqual(session.speakerRequests, [false])
        routes.stop()
    }

    func testNewerSelectionWinsAndHardwareOnlyChangesStillRecover() async throws {
        let session = FakeVoiceAudioSession()
        let routes = AudioRouteController(session: session)
        var recoveries = 0
        routes.onDidChange = { recoveries += 1 }
        try await routes.activate()
        session.route.inputs = [FakeVoiceAudioSession.headset]
        session.route.outputs = [FakeVoiceAudioSession.headset]
        session.emit(.routeChanged(removedOutputs: []))
        routes.useSpeaker()
        routes.selectInput(FakeVoiceAudioSession.headset.id)
        XCTAssertFalse(routes.isSwitching)
        XCTAssertEqual(routes.route.inputs, [FakeVoiceAudioSession.headset])
        let beforeFormatChange = recoveries
        session.route.sampleRate = 16000
        session.emit(.routeChanged(removedOutputs: []))
        XCTAssertEqual(recoveries, beforeFormatChange + 1)
        session.route.availableInputs = []
        session.emit(.routeChanged(removedOutputs: []))
        XCTAssertEqual(recoveries, beforeFormatChange + 1, "Discovery-only changes must not interrupt audio")
        routes.stop()
    }

    func testActivationOwnsOneObserverAndRejectsLateEventsAfterTeardown() async throws {
        let session = FakeVoiceAudioSession()
        let routes = AudioRouteController(session: session)
        try await routes.activate()
        let stale = session.handler
        try await routes.activate()
        XCTAssertEqual(session.observationCount, 1)
        routes.stop()
        try await routes.activate()
        stale?(.interruptionBegan)
        XCTAssertNil(routes.suspension)
        session.emit(.mediaServicesReset)
        XCTAssertEqual(routes.suspension, .interrupted)
        routes.stop()
        XCTAssertNil(session.handler)
    }

    func testNativePickerHoldsAudioAcrossChangesAndSpeakerRequiresBothPorts() async throws {
        let session = FakeVoiceAudioSession()
        let routes = AudioRouteController(session: session)
        var stops = 0
        var recoveries = 0
        routes.onWillChange = { stops += 1 }
        routes.onDidChange = { recoveries += 1 }
        try await routes.activate()
        routes.beginSystemPicker()
        session.route.inputs = [FakeVoiceAudioSession.headset]
        session.route.outputs = [FakeVoiceAudioSession.headset]
        session.emit(.routeChanged(removedOutputs: []))
        XCTAssertTrue(routes.blocksAudio)
        XCTAssertEqual(recoveries, 0)
        routes.endSystemPicker()
        XCTAssertEqual(stops, 1)
        XCTAssertEqual(recoveries, 1)
        routes.useSpeaker()
        session.route.outputs = [FakeVoiceAudioSession.speaker]
        session.emit(.routeChanged(removedOutputs: []))
        XCTAssertTrue(routes.isSwitching)
        session.route.inputs = [FakeVoiceAudioSession.mic]
        session.emit(.routeChanged(removedOutputs: []))
        XCTAssertFalse(routes.isSwitching)
        XCTAssertEqual(session.inputRequests, [nil])
        XCTAssertEqual(session.speakerRequests, [false, true])
        routes.stop()
    }
    func testStopDuringActivationCannotRestoreObserversOrAudio() async throws {
        let session = FakeVoiceAudioSession()
        let routes = AudioRouteController(session: session)
        let started = expectation(description: "activation started")
        let stopped = expectation(description: "deactivation finished")
        var completion: CheckedContinuation<Void, Never>?
        session.onActivate = {
            await withCheckedContinuation { completion = $0; started.fulfill() }
        }
        session.onDeactivate = { stopped.fulfill() }
        let activation = Task { try await routes.activate() }
        await fulfillment(of: [started], timeout: 1)
        XCTAssertTrue(routes.blocksAudio)
        routes.stop()
        XCTAssertFalse(routes.isActive)
        XCTAssertNil(session.handler)
        completion?.resume()
        do { try await activation.value; XCTFail("Stopped activation must be cancelled") }
        catch { XCTAssertTrue(error is CancellationError) }
        await fulfillment(of: [stopped], timeout: 1)
        XCTAssertFalse(routes.isActive)
        XCTAssertNil(session.handler)
        XCTAssertEqual(session.operations, ["activate", "deactivate"])
    }

    func testRestartWaitsForDeactivationAndIgnoresItsLateFailure() async throws {
        let session = FakeVoiceAudioSession()
        let routes = AudioRouteController(session: session)
        try await routes.activate()
        let stopping = expectation(description: "deactivation started")
        var completion: CheckedContinuation<Void, Never>?
        session.onDeactivate = {
            await withCheckedContinuation { completion = $0; stopping.fulfill() }
            throw AudioRouteController.RouteError.unavailable
        }
        routes.stop()
        await fulfillment(of: [stopping], timeout: 1)
        let restartScheduled = expectation(description: "restart scheduled")
        let restarted = Task { try await routes.activate() }
        Task { restartScheduled.fulfill() }
        await fulfillment(of: [restartScheduled], timeout: 1)
        XCTAssertEqual(session.operations, ["activate", "deactivate"])
        completion?.resume()
        try await restarted.value
        XCTAssertEqual(session.operations, ["activate", "deactivate", "activate"])
        XCTAssertTrue(routes.isActive)
        XCTAssertNil(routes.error)
        session.onDeactivate = nil
        routes.stop()
    }

    func testInterruptionDuringResumeStillRequiresAnotherExplicitResume() async throws {
        let session = FakeVoiceAudioSession()
        let routes = AudioRouteController(session: session)
        try await routes.activate()
        session.emit(.interruptionBegan)
        session.onActivate = { session.emit(.routeChanged(removedOutputs: [FakeVoiceAudioSession.headset])) }
        do { try await routes.resume(); XCTFail("A new interruption must cancel Resume") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertTrue(routes.blocksAudio)
        session.onActivate = nil
        try await routes.resume()
        XCTAssertFalse(routes.blocksAudio)
        routes.stop()
    }

}

@MainActor
final class FakeVoiceAudioSession: VoiceAudioSession {
    static let mic = VoiceAudioPort(id: "phone-mic", name: "iPhone Microphone", kind: .microphone)
    static let speaker = VoiceAudioPort(id: "speaker", name: "iPhone Speaker", kind: .speaker)
    static let headset = VoiceAudioPort(id: "airpods", name: "AirPods", kind: .bluetooth)
    var route = VoiceAudioRoute(inputs: [mic], outputs: [speaker], availableInputs: [mic, headset], sampleRate: 48000)
    var handler: (@MainActor (VoiceAudioSessionEvent) -> Void)?
    var observationCount = 0
    var inputRequests: [String?] = []
    var speakerRequests: [Bool] = []
    var failSelection = false
    var operations: [String] = []
    var onActivate: (@MainActor () async throws -> Void)?
    var onDeactivate: (@MainActor () async throws -> Void)?
    func activate() async throws { operations.append("activate"); try await onActivate?() }
    func deactivate() async throws { operations.append("deactivate"); try await onDeactivate?() }
    func preferInput(id: String?) throws {
        inputRequests.append(id)
        if failSelection { throw AudioRouteController.RouteError.unavailable }
    }
    func overrideSpeaker(_ enabled: Bool) throws { speakerRequests.append(enabled) }
    func observe(_ handler: @escaping @MainActor (VoiceAudioSessionEvent) -> Void) {
        observationCount += 1
        self.handler = handler
    }
    func stopObserving() { handler = nil }
    func emit(_ event: VoiceAudioSessionEvent) { handler?(event) }
}
