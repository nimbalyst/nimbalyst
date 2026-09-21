import Foundation
import Combine

/// App-scoped push-to-start tokens and per-activity update tokens must never be
/// interchanged; they have distinct registration and invalidation lifetimes.
public enum LiveActivityTokenKind: String, Sendable {
    case pushToStart
    case update
}

/// Observes server-started activities. Only the server calls APNs to start a card.
@MainActor
public final class FleetActivityController: ObservableObject {
    public static let shared = FleetActivityController(observer: FleetActivityObserver())
    private static let enabledKey = "liveActivityEnabled"
    private static let hasStoredEnabledKey = "liveActivityEnabledStored"
    private let observer: any FleetActivityObserving
    private let defaults: UserDefaults
    private var isObserving = false
    private var updateActivityId: String?

    @Published public private(set) var isEnabled: Bool
    @Published public private(set) var pushToStartToken: String?
    @Published public private(set) var updateToken: String?
    public var onTokenReceived: ((String, LiveActivityTokenKind) -> Void)?
    /// nil kind means all registrations; a token identifies the activity being retired.
    public var onTokenInvalidated: ((LiveActivityTokenKind?, String?) -> Void)?

    init(observer: any FleetActivityObserving, defaults: UserDefaults = .standard) {
        self.observer = observer
        self.defaults = defaults
        isEnabled = defaults.bool(forKey: Self.hasStoredEnabledKey) ? defaults.bool(forKey: Self.enabledKey) : true
    }

    public var areActivitiesEnabled: Bool { observer.areActivitiesEnabled }
    public var shouldRegister: Bool { isEnabled && areActivitiesEnabled }

    /// Reconcile even when already observing: callbacks may have been suspended
    /// while an activity ended, or permission may have changed in iOS Settings.
    public func start() {
        guard shouldRegister else {
            stop(invalidateTokens: true)
            return
        }
        if !isObserving {
            isObserving = true
            observer.start(
                pushToken: { [weak self] token in self?.receivePushToken(token) },
                updateToken: { [weak self] id, token in self?.receiveUpdateToken(token, activityId: id) },
                ended: { [weak self] id in self?.activityEnded(id) }
            )
        }
        observer.reconcile()
    }

    public func stop(invalidateTokens: Bool) {
        observer.stop()
        isObserving = false
        if invalidateTokens {
            pushToStartToken = nil
            updateToken = nil
            updateActivityId = nil
            onTokenInvalidated?(nil, nil)
        }
    }

    public func setEnabled(_ enabled: Bool) {
        isEnabled = enabled
        defaults.set(enabled, forKey: Self.enabledKey)
        defaults.set(true, forKey: Self.hasStoredEnabledKey)
        if enabled {
            start()
        } else {
            stop(invalidateTokens: true)
            Task { @MainActor [observer] in await observer.endAll() }
        }
    }

    /// Called on foreground and index reconnect. Restart before resending so an
    /// earlier denial does not strand us with empty cached tokens indefinitely.
    public func resendTokens() {
        start()
        guard shouldRegister else { return }
        if let token = pushToStartToken { onTokenReceived?(token, .pushToStart) }
        if let token = updateToken { onTokenReceived?(token, .update) }
    }

    private func receivePushToken(_ token: String) {
        guard isObserving, shouldRegister, token != pushToStartToken else { return }
        pushToStartToken = token
        onTokenReceived?(token, .pushToStart)
    }

    private func receiveUpdateToken(_ token: String, activityId: String) {
        guard isObserving, shouldRegister else { return }
        guard token != updateToken || activityId != updateActivityId else { return }
        updateActivityId = activityId
        updateToken = token
        onTokenReceived?(token, .update)
    }

    private func activityEnded(_ id: String) {
        guard id == updateActivityId else { return }
        let retiredToken = updateToken
        updateActivityId = nil
        updateToken = nil
        if let retiredToken { onTokenInvalidated?(.update, retiredToken) }
    }
}
