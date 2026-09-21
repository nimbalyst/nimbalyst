import Foundation
import os

/// Serializes lifecycle, auth and transport recovery. A network path is only a
/// retry signal; the operation must prove that the server connection is ready.
@MainActor
final class SyncRecoveryCoordinator {
    typealias Sleep = @Sendable (Duration) async throws -> Void
    private let recover: @MainActor () async -> Bool
    private let sleep: Sleep
    private let retryDelay: (Int) -> Duration
    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "SyncRecovery")
    private var attempt: Task<Void, Never>?
    private var retry: Task<Void, Never>?
    private var generation = 0
    private var failures = 0
    private var identity: String?
    private var needsRecovery = false
    private var attemptFailed = false
    private(set) var isForeground = true

    init(
        sleep: @escaping Sleep = { try await Task.sleep(for: $0) },
        retryDelay: @escaping (Int) -> Duration = { failures in
            .seconds(min(30, pow(2, Double(min(failures, 5)))) * Double.random(in: 0.8...1))
        },
        recover: @escaping @MainActor () async -> Bool
    ) {
        self.sleep = sleep
        self.retryDelay = retryDelay
        self.recover = recover
    }

    func configure(identity: String?) {
        guard self.identity != identity else { return }
        cancel()
        self.identity = identity
    }

    func cancel() {
        generation &+= 1
        attempt?.cancel()
        retry?.cancel()
        attempt = nil
        retry = nil
        identity = nil
        failures = 0
        needsRecovery = false
    }

    func setForeground(_ foreground: Bool) {
        let returning = !isForeground && foreground
        isForeground = foreground
        if !foreground {
            // An attempt suspended across dormancy cannot satisfy the next
            // wake-up. Retire its completion while retaining account identity.
            generation &+= 1
            attempt?.cancel()
            attempt = nil
            retry?.cancel()
            retry = nil
            needsRecovery = true
        } else if returning || needsRecovery {
            request(reason: "foreground")
        }
    }

    func connectionFailed() {
        // A disconnect can arrive between the operation's successful return
        // and our continuation. Do not let that stale success swallow it.
        attemptFailed = true
        request(reason: "transport")
    }

    func request(reason: String) {
        guard identity != nil else { return }
        needsRecovery = true
        guard isForeground, attempt == nil else { return }
        retry?.cancel()
        retry = nil
        let generation = self.generation
        attemptFailed = false
        logger.info("Recovery requested: \(reason, privacy: .public)")
        attempt = Task { [weak self, recover] in
            let succeeded = await recover()
            guard let self, !Task.isCancelled, self.generation == generation else { return }
            self.attempt = nil
            let recovered = succeeded && !self.attemptFailed
            self.needsRecovery = !recovered
            if recovered {
                self.failures = 0
                self.logger.info("Recovery connected")
            } else {
                self.failures += 1
                self.scheduleRetry(generation: generation)
            }
        }
    }

    private func scheduleRetry(generation: Int) {
        guard isForeground else { return }
        let delay = retryDelay(failures)
        retry = Task { [weak self, sleep] in
            do { try await sleep(delay) } catch { return }
            guard let self, !Task.isCancelled, self.generation == generation else { return }
            self.retry = nil
            self.request(reason: "retry")
        }
    }
}
