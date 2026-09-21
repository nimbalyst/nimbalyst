import Foundation
import Network

/// Emits changes to an available route, including Wi-Fi/cellular transitions.
/// Availability never substitutes for a handshake with the sync server.
final class SyncNetworkObserver: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    // Accessed only by the monitor's serial callback queue.
    private var previous: String?
    init(onAvailable: @escaping @MainActor @Sendable () -> Void) {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let used = [NWInterface.InterfaceType.wifi, .cellular, .wiredEthernet, .loopback, .other]
                .filter { path.usesInterfaceType($0) }.map { String(describing: $0) }
            let signature = "\(path.status):\(used):\(path.availableInterfaces.map { $0.name }.sorted()):\(path.isExpensive)"
            defer { self.previous = signature }
            guard path.status == .satisfied, signature != self.previous else { return }
            // Initial availability is handled by startup, not a second reconnect.
            guard self.previous != nil else { return }
            Task { @MainActor in onAvailable() }
        }
        monitor.start(queue: DispatchQueue(label: "com.nimbalyst.sync-network"))
    }
    deinit { monitor.cancel() }
}
