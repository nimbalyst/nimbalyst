import Foundation
import Combine

struct VoiceAudioPort: Equatable, Identifiable, Sendable {
    enum Kind: Sendable { case microphone, speaker, receiver, headphones, bluetooth, other }
    let id: String
    let name: String
    let kind: Kind
    var isPrivateOutput: Bool { kind == .headphones || kind == .bluetooth }
}

struct VoiceAudioRoute: Equatable, Sendable {
    var inputs: [VoiceAudioPort] = []
    var outputs: [VoiceAudioPort] = []
    var availableInputs: [VoiceAudioPort] = []
    var preferredInputID: String?
    var sampleRate: Double = 0
    var bufferDuration: Double = 0
    var inputChannels: Int = 0
    var outputChannels: Int = 0
    var inputName: String { inputs.map(\.name).joined(separator: ", ") }
    var outputName: String { outputs.map(\.name).joined(separator: ", ") }
    var isUsable: Bool { !inputs.isEmpty && !outputs.isEmpty && sampleRate > 0 }
    var usesBluetoothPair: Bool {
        inputs.contains { $0.kind == .bluetooth } && outputs.contains { $0.kind == .bluetooth }
    }
    func hasSameIO(as other: Self) -> Bool {
        inputs == other.inputs && outputs == other.outputs && sampleRate == other.sampleRate
            && bufferDuration == other.bufferDuration && inputChannels == other.inputChannels
            && outputChannels == other.outputChannels
    }
}

enum VoiceAudioSessionEvent: Sendable {
    case routeChanged(removedOutputs: [VoiceAudioPort])
    case interruptionBegan
    case interruptionEnded
    case mediaServicesReset
    case mediaServicesLost
}

@MainActor
protocol VoiceAudioSession: AnyObject {
    var route: VoiceAudioRoute { get }
    func activate() async throws
    func deactivate() async throws
    func preferInput(id: String?) throws
    func overrideSpeaker(_ enabled: Bool) throws
    func observe(_ handler: @escaping @MainActor (VoiceAudioSessionEvent) -> Void)
    func stopObserving()
}

/// Owns user routing intent separately from the effective route reported by iOS.
/// No device IDs escape this audio session or enter synced voice preferences.
@MainActor
final class AudioRouteController: ObservableObject {
    enum Suspension: Equatable {
        case headphonesDisconnected, interrupted, recoveryFailed
        var message: String {
            switch self {
            case .headphonesDisconnected: return "Headphones disconnected. Tap Resume to continue."
            case .interrupted: return "Audio interrupted. Tap Resume to continue."
            case .recoveryFailed: return "Audio stopped. Tap Resume to retry."
            }
        }
    }
    private enum Selection {
        case input(String?), speaker
        func matches(_ route: VoiceAudioRoute) -> Bool {
            guard route.isUsable else { return false }
            switch self {
            case .input(let id):
                return id.map { uid in route.inputs.contains { $0.id == uid } } ?? (route.preferredInputID == nil)
            case .speaker:
                return route.outputs.contains { $0.kind == .speaker } && route.inputs.contains { $0.kind == .microphone }
            }
        }
    }

    @Published private(set) var route = VoiceAudioRoute()
    @Published private(set) var isSwitching = false
    @Published private(set) var isActivating = false
    @Published private(set) var suspension: Suspension?
    @Published private(set) var error: String?
    private(set) var isActive = false
    private var pickerOpen = false
    private var selection: Selection?
    private var timeout: Task<Void, Never>?
    private var generation = UUID()
    private var suspensionGeneration = UUID()
    private var sessionOperation: Task<Void, Error>?
    private let session: any VoiceAudioSession
    private let selectionTimeout: Duration

    var onWillChange: (() -> Void)?
    var onDidChange: (() -> Void)?
    var onSuspended: (() -> Void)?
    var blocksAudio: Bool { suspension != nil || isSwitching || isActivating }

    init(session: any VoiceAudioSession, selectionTimeout: Duration = .seconds(3)) {
        self.session = session
        self.selectionTimeout = selectionTimeout
    }

    func activate() async throws {
        guard !isActivating else { throw CancellationError() }
        if !isActive { generation = UUID() }
        let epoch = generation
        isActivating = true
        if !isActive {
            isActive = true
            error = nil
            session.observe { [weak self] event in
                guard let self, self.isActive, self.generation == epoch else { return }
                self.receive(event)
            }
        }
        defer { if generation == epoch { isActivating = false } }
        do {
            try await enqueueSessionOperation { [session] in try await session.activate() }.value
            guard generation == epoch else { throw CancellationError() }
            try Task.checkCancellation()
            refresh()
        } catch {
            if generation == epoch { stop() }
            throw error
        }
    }

    /// Teardown is nonblocking, but the next activation must wait for it. Queue
    /// operations synchronously before yielding so Stop/Start cannot reorder them.
    private func enqueueSessionOperation(_ operation: @escaping @MainActor () async throws -> Void) -> Task<Void, Error> {
        let previous = sessionOperation
        let next = Task {
            _ = await previous?.result
            try await operation()
        }
        sessionOperation = next
        return next
    }

    func refresh() { route = session.route }

    func stop() {
        let wasActive = isActive
        isActive = false
        isActivating = false
        generation = UUID()
        timeout?.cancel()
        timeout = nil
        session.stopObserving()
        selection = nil
        pickerOpen = false
        isSwitching = false
        suspension = nil
        error = nil
        if wasActive {
            let epoch = generation
            let cleanup = enqueueSessionOperation { [session] in try await session.deactivate() }
            Task { [weak self] in
                let result = await cleanup.result
                guard let self, self.generation == epoch else { return }
                if case .failure(let failure) = result { self.error = failure.localizedDescription }
                self.refresh()
            }
        }
        refresh()
    }

    /// Only the explicit Resume action can remove a route-loss/interruption hold.
    func resume() async throws {
        guard !isSwitching, !isActivating else { throw CancellationError() }
        let suspensionEpoch = suspensionGeneration
        try await activate()
        guard suspensionGeneration == suspensionEpoch else { throw CancellationError() }
        guard route.isUsable else { throw RouteError.unavailable }
        suspension = nil
        error = nil
    }

    func failRecovery(_ failure: Error) {
        error = failure.localizedDescription
        suspend(.recoveryFailed)
    }

    func selectInput(_ id: String?) {
        refresh()
        guard id == nil || route.availableInputs.contains(where: { $0.id == id }) else {
            error = "That microphone is no longer available."
            return
        }
        select(.input(id)) {
            try session.overrideSpeaker(false)
            try session.preferInput(id: id)
        }
    }

    func useSpeaker() {
        select(.speaker) {
            try session.preferInput(id: nil)
            try session.overrideSpeaker(true)
        }
    }

    /// Native pickers own their choices. Hold audio until dismissal, even if the
    /// user visits several routes while the picker is open.
    func beginSystemPicker() {
        guard isActive, !pickerOpen, !isSwitching, !isActivating else { return }
        pickerOpen = true
        beginChange()
        do { try session.overrideSpeaker(false) }
        catch { self.error = error.localizedDescription }
    }

    func endSystemPicker() {
        guard pickerOpen else { return }
        pickerOpen = false
        refresh()
        finishChange()
    }

    private func select(_ requested: Selection, apply: () throws -> Void) {
        guard isActive, !pickerOpen, !isActivating else { return }
        timeout?.cancel()
        selection = requested
        beginChange()
        do {
            try apply()
            refresh()
            if requested.matches(route) { finishChange(); return }
            timeout = Task { [weak self, selectionTimeout] in
                try? await Task.sleep(for: selectionTimeout)
                guard !Task.isCancelled, let self, self.isActive, self.selection != nil else { return }
                self.refresh()
                if self.selection?.matches(self.route) != true {
                    self.error = "The audio route did not change. Choose a device and try again."
                }
                self.finishChange()
            }
        } catch {
            self.error = error.localizedDescription
            refresh()
            finishChange()
        }
    }

    private func beginChange() {
        error = nil
        guard !isSwitching else { return }
        isSwitching = true
        onWillChange?()
    }

    private func finishChange() {
        timeout?.cancel()
        timeout = nil
        selection = nil
        guard isSwitching else { return }
        isSwitching = false
        if !route.isUsable { suspend(.recoveryFailed) }
        onDidChange?()
    }

    private func suspend(_ reason: Suspension) {
        suspensionGeneration = UUID()
        // A subsequent system interruption must not erase the headphone-loss reason.
        if suspension == nil { suspension = reason }
        onSuspended?()
    }

    private func receive(_ event: VoiceAudioSessionEvent) {
        let previous = route
        refresh()
        switch event {
        case .routeChanged(let removed):
            if removed.contains(where: \.isPrivateOutput) {
                suspend(.headphonesDisconnected)
                if !pickerOpen { finishChange() }
                return
            }
            if let selection {
                if selection.matches(route) { finishChange() }
            } else if !pickerOpen, !previous.hasSameIO(as: route) {
                beginChange()
                finishChange()
            }
        case .interruptionBegan, .mediaServicesLost:
            suspend(.interrupted)
            if !pickerOpen { finishChange() }
        case .interruptionEnded:
            // The person, not an OS recovery callback, decides when to resume.
            break
        case .mediaServicesReset:
            suspend(.interrupted)
            if !pickerOpen { finishChange() }
        }
    }

    enum RouteError: LocalizedError {
        case unavailable
        var errorDescription: String? { "No usable microphone and speaker are available." }
    }
}
