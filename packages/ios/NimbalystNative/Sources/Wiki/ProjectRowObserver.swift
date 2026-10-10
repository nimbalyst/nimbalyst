import Foundation
import GRDB

/// The live `projects` row for a project the sidebar is showing. The sidebar
/// is handed a copy when the project is chosen; config sync (the Local wiki
/// folder and types) can update the row afterwards.
@MainActor
final class ProjectRowObserver: ObservableObject {
    @Published private(set) var project: Project?
    private var cancellable: AnyDatabaseCancellable?
    private var observedId: String?

    func observe(_ projectId: String, in database: DatabaseManager?) {
        guard observedId != projectId || cancellable == nil, let database else { return }
        observedId = projectId
        cancellable?.cancel()
        cancellable = ValueObservation
            .tracking { try Project.fetchOne($0, key: projectId) }
            .removeDuplicates()
            .start(in: database.writer, scheduling: .immediate, onError: { _ in }) { [weak self] row in
                self?.project = row
            }
    }
}
