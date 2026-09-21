import Foundation
#if os(iOS)
import ActivityKit
#endif

/// ActivityKit is unavailable in host unit tests. This boundary lets those tests
/// exercise the controller's actual permission and ownership transitions.
@MainActor
protocol FleetActivityObserving: AnyObject {
    var areActivitiesEnabled: Bool { get }
    func start(pushToken: @escaping (String) -> Void,
               updateToken: @escaping (String, String) -> Void,
               ended: @escaping (String) -> Void)
    func reconcile()
    func stop()
    func endAll() async
}

@MainActor
final class FleetActivityObserver: FleetActivityObserving {
    #if os(iOS)
    private var tasks: [Task<Void, Never>] = []
    private var activityTasks: [String: [Task<Void, Never>]] = [:]
    private var pushToken: ((String) -> Void)?
    private var updateToken: ((String, String) -> Void)?
    private var ended: ((String) -> Void)?

    var areActivitiesEnabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    func start(pushToken: @escaping (String) -> Void,
               updateToken: @escaping (String, String) -> Void,
               ended: @escaping (String) -> Void) {
        guard tasks.isEmpty else { return }
        self.pushToken = pushToken
        self.updateToken = updateToken
        self.ended = ended
        tasks.append(Task { [weak self] in
            for await data in Activity<FleetActivityAttributes>.pushToStartTokenUpdates {
                guard !Task.isCancelled else { return }
                self?.pushToken?(Self.hex(data))
            }
        })
        tasks.append(Task { [weak self] in
            for await activity in Activity<FleetActivityAttributes>.activityUpdates {
                guard !Task.isCancelled else { return }
                self?.observe(activity)
            }
        })
    }

    func reconcile() {
        if let token = Activity<FleetActivityAttributes>.pushToStartToken {
            pushToken?(Self.hex(token))
        }
        let activities = Activity<FleetActivityAttributes>.activities
        let currentIds = Set(activities.map(\.id))
        for id in Array(activityTasks.keys) where !currentIds.contains(id) { retire(id) }
        for activity in activities {
            if activity.activityState == .ended || activity.activityState == .dismissed {
                retire(activity.id)
            } else {
                observe(activity)
                if let token = activity.pushToken { updateToken?(activity.id, Self.hex(token)) }
            }
        }
    }

    private func observe(_ activity: Activity<FleetActivityAttributes>) {
        guard activity.activityState != .ended, activity.activityState != .dismissed else {
            retire(activity.id)
            return
        }
        guard activityTasks[activity.id] == nil else { return }
        let tokenTask = Task { [weak self] in
            for await data in activity.pushTokenUpdates {
                guard !Task.isCancelled, let self, self.activityTasks[activity.id] != nil else { return }
                self.updateToken?(activity.id, Self.hex(data))
            }
        }
        let stateTask = Task { [weak self] in
            for await state in activity.activityStateUpdates {
                guard !Task.isCancelled else { return }
                if state == .ended || state == .dismissed { self?.retire(activity.id) }
            }
        }
        activityTasks[activity.id] = [tokenTask, stateTask]
    }

    private func retire(_ id: String) {
        for task in activityTasks.removeValue(forKey: id) ?? [] { task.cancel() }
        ended?(id)
    }

    func stop() {
        for task in tasks { task.cancel() }
        tasks.removeAll()
        for group in activityTasks.values { for task in group { task.cancel() } }
        activityTasks.removeAll()
        pushToken = nil
        updateToken = nil
        ended = nil
    }

    func endAll() async {
        for activity in Activity<FleetActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    private static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
    #else
    var areActivitiesEnabled: Bool { false }
    func start(pushToken: @escaping (String) -> Void, updateToken: @escaping (String, String) -> Void, ended: @escaping (String) -> Void) {}
    func reconcile() {}
    func stop() {}
    func endAll() async {}
    #endif
}
