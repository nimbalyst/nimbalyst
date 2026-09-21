import GRDB

extension DatabaseManager {
    /// Use GRDB's callback API so both the query and reader release run on the
    /// configured database queue. A synchronous read inherits a utility caller's
    /// QoS; the Swift async overload still releases its reader from the task.
    func readOnDatabaseQueue<T: Sendable>(
        _ value: @escaping @Sendable (Database) throws -> T
    ) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            writer.asyncRead { result in
                continuation.resume(with: Result { try value(result.get()) })
            }
        }
    }
}
