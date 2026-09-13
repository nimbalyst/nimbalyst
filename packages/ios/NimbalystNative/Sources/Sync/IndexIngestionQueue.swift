import Foundation

/// A generation's cancellation flag.
///
/// `Task.isCancelled` is useless inside a GRDB write closure: that block runs on
/// the database queue, not in the task, so the check silently reads false and
/// the transaction runs to completion for an account that is gone. This flag is
/// thread-independent, so the same check works in the task loop and inside the
/// transaction.
final class IndexIngestionCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }
}

/// A first-in-first-out handoff between the socket's message handler and the
/// single background consumer that applies index work.
///
/// Submission is synchronous so the order items were received in is the order
/// they are applied in. Spawning a task per message instead would hand ordering
/// to the cooperative pool, which is how an older bulk row ends up overwriting
/// a newer live update.
///
/// The queue also bounds how many undelivered wire bytes it will hold. The
/// producer awaits `capacity()` before reading the next socket message, so a
/// history burst applies backpressure to the transport instead of growing an
/// unbounded in-memory backlog.
///
/// State lives behind a lock rather than in an actor because every mutation is
/// short and non-suspending, and because actor reentrancy gives no ordering
/// guarantee between separate submitting tasks -- the one property this type
/// exists to provide.
final class IndexIngestionQueue: @unchecked Sendable {
    struct Item {
        let work: IndexIngestionWork
        let byteCount: Int
        let submittedAt: DispatchTime
    }

    /// Retained wire bytes before the producer is asked to wait. Decoded entries
    /// cost a multiple of this, so keep the budget well under the transport's
    /// 16 MiB per-message ceiling.
    static let maxPendingBytes = 4 * 1024 * 1024

    private let lock = NSLock()
    private var items: [Item] = []
    private var pendingBytes = 0
    private var isFinished = false
    private var itemWaiter: CheckedContinuation<Void, Never>?
    private var capacityWaiters: [CheckedContinuation<Void, Never>] = []

    /// Enqueue work. Never blocks: ordering must not depend on the caller's
    /// willingness to await.
    func submit(_ work: IndexIngestionWork, byteCount: Int) {
        lock.lock()
        guard !isFinished else {
            lock.unlock()
            return
        }
        items.append(Item(work: work, byteCount: byteCount, submittedAt: .now()))
        pendingBytes += byteCount
        let waiter = itemWaiter
        itemWaiter = nil
        lock.unlock()
        waiter?.resume()
    }

    /// Returns the next contiguous run of work, up to `maxEntries` entries, or
    /// `nil` once the queue is finished and drained. A single item carrying more
    /// than the budget is returned alone; the writer bounds its own transactions.
    func nextBatch(maxEntries: Int) async -> [Item]? {
        while true {
            switch takeBatch(maxEntries: maxEntries) {
            case .items(let batch):
                return batch
            case .finished:
                return nil
            case .empty:
                await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                    if !installItemWaiter(continuation) {
                        // An item or finish() landed between the two calls.
                        continuation.resume()
                    }
                }
            }
        }
    }

    /// Suspends only while the backlog is over its byte budget.
    func capacity() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            if !installCapacityWaiter(continuation) {
                continuation.resume()
            }
        }
    }

    /// Drop everything still queued and wake every waiter. Used when the account
    /// or connection generation changes: that work belongs to an identity the
    /// consumer may no longer write for.
    func finish() {
        lock.lock()
        isFinished = true
        items.removeAll()
        pendingBytes = 0
        let waiter = itemWaiter
        let capacity = capacityWaiters
        itemWaiter = nil
        capacityWaiters = []
        lock.unlock()
        waiter?.resume()
        capacity.forEach { $0.resume() }
    }

    var pendingCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return items.count
    }

    // MARK: - Locked steps
    //
    // Each of these takes the lock, mutates, and releases it before any
    // continuation is resumed. They are synchronous so the lock is never held
    // across a suspension point.

    private enum Take {
        case items([Item])
        case empty
        case finished
    }

    private func takeBatch(maxEntries: Int) -> Take {
        lock.lock()
        if items.isEmpty {
            let finished = isFinished
            lock.unlock()
            return finished ? .finished : .empty
        }
        var batch: [Item] = []
        var entries = 0
        while let next = items.first, entries == 0 || entries + next.work.entryCount <= maxEntries {
            entries += next.work.entryCount
            pendingBytes -= next.byteCount
            batch.append(items.removeFirst())
            if entries >= maxEntries { break }
        }
        let released = pendingBytes <= Self.maxPendingBytes ? capacityWaiters : []
        if !released.isEmpty { capacityWaiters = [] }
        lock.unlock()
        released.forEach { $0.resume() }
        return .items(batch)
    }

    /// Returns false when the caller should not suspend after all.
    private func installItemWaiter(_ continuation: CheckedContinuation<Void, Never>) -> Bool {
        lock.lock()
        if !items.isEmpty || isFinished {
            lock.unlock()
            return false
        }
        let previous = itemWaiter
        itemWaiter = continuation
        lock.unlock()
        previous?.resume()
        return true
    }

    private func installCapacityWaiter(_ continuation: CheckedContinuation<Void, Never>) -> Bool {
        lock.lock()
        if isFinished || pendingBytes <= Self.maxPendingBytes {
            lock.unlock()
            return false
        }
        capacityWaiters.append(continuation)
        lock.unlock()
        return true
    }
}
