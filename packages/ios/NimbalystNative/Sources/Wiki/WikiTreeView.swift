import SwiftUI
import GRDB
import Combine

/// The project's Local wiki as a page tree: titles and `order` from the files,
/// Home first, child pages under their parent, table types among their
/// siblings, sync conflict copies under the page they diverged from. Trash and
/// the marker never show. Rows select documents, as the Files tab does.
struct WikiTreeView: View {
    @EnvironmentObject var appState: AppState
    let project: Project
    let folder: String
    @Binding private var selection: WorkspaceSelection?
    @Binding private var searchText: String

    @State private var documents: [SyncedDocument] = []
    @State private var snapshot: WikiSnapshot?
    @State private var cancellable: AnyDatabaseCancellable?
    @State private var expanded: Set<String> = []
    @State private var observationError: String?
    @State private var syncState: DocumentSyncState = .connecting

    init(project: Project, folder: String, selection: Binding<WorkspaceSelection?>, searchText: Binding<String>) {
        self.project = project
        self.folder = folder
        _selection = selection
        _searchText = searchText
    }

    private var documentIds: [String: String] {
        Dictionary(documents.map { ($0.relativePath, $0.id) }, uniquingKeysWith: { first, _ in first })
    }

    var body: some View {
        Group {
            if let observationError {
                message(observationError, retry: true)
            } else if let snapshot, snapshot.isUnsupportedVersion {
                message("This wiki was written by a newer version of Nimbalyst. Update the app to read it.", retry: false)
            } else if let snapshot, !snapshot.tree.isEmpty {
                List(selection: $selection) {
                    ForEach(rows(snapshot)) { row in
                        WikiTreeRow(row: row, isExpanded: expanded.contains(row.id)) { toggle(row.id) }
                            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 16))
                            .listRowSeparator(.hidden)
                    }
                }
                .listStyle(.plain)
            } else if snapshot == nil {
                ProgressView("Loading wiki…")
            } else {
                switch syncState {
                case .failed(let text): message(text, retry: true)
                case .connecting, .syncing: ProgressView("Syncing wiki…")
                case .ready: message("Wiki pages will appear here once synced from the desktop app.", retry: false)
                }
            }
        }
        .onAppear {
            loadExpanded()
            startObserving()
            appState.documentSyncManager?.connectProject(project.id)
        }
        .onDisappear { cancellable?.cancel() }
        // The observation captured the folder and types it started with.
        .onChange(of: "\(folder)\u{1f}\(project.localWikiTypesJSON ?? "")") { startObserving() }
        .onReceive(appState.documentSyncManager?.$loadStates.eraseToAnyPublisher() ?? Just([:]).eraseToAnyPublisher()) { states in
            syncState = states[project.id] ?? .connecting
        }
        .onChange(of: expanded) { saveExpanded() }
    }

    // MARK: Rows

    private func rows(_ snapshot: WikiSnapshot) -> [WikiTreeRowModel] {
        var out: [WikiTreeRowModel] = []
        let ids = documentIds
        let query = searchText.trimmingCharacters(in: .whitespaces)
        if !query.isEmpty {
            func search(_ nodes: [WikiNode]) {
                for node in nodes {
                    if node.title.localizedCaseInsensitiveContains(query) {
                        out.append(model(node, depth: 0, ids: ids, snapshot: snapshot, conflict: false))
                    }
                    if case .page(_, let children) = node { search(children) }
                }
            }
            search(snapshot.tree)
            return out
        }
        func emit(_ nodes: [WikiNode], depth: Int) {
            let copies = Dictionary(grouping: nodes.compactMap { node -> (String, WikiNode)? in
                guard case .page(let page, _) = node, let original = page.conflictOf else { return nil }
                return (original, node)
            }, by: \.0)
            for node in nodes {
                if case .page(let page, _) = node, page.conflictOf != nil { continue }
                var row = model(node, depth: depth, ids: ids, snapshot: snapshot, conflict: false)
                let conflicts = copies[node.id]?.map(\.1) ?? []
                row.hasChildren = row.hasChildren || !conflicts.isEmpty
                out.append(row)
                guard expanded.contains(node.id) else { continue }
                for copy in conflicts { out.append(model(copy, depth: depth + 1, ids: ids, snapshot: snapshot, conflict: true)) }
                if case .page(_, let children) = node { emit(children, depth: depth + 1) }
            }
        }
        emit(snapshot.tree, depth: 0)
        return out
    }

    private func model(_ node: WikiNode, depth: Int, ids: [String: String], snapshot: WikiSnapshot, conflict: Bool) -> WikiTreeRowModel {
        switch node {
        case .page(let page, let children):
            return WikiTreeRowModel(
                id: page.id,
                title: page.title,
                depth: depth,
                documentId: page.path.flatMap { ids[WikiDocuments.projectPath(of: $0, folder: folder)] },
                icon: conflict ? "exclamationmark.triangle" : page.type != nil ? "tag" : page.documentType == "markdown" ? "doc.text" : "doc",
                badge: conflict ? "Conflict" : page.type.map(snapshot.typeName),
                isConflict: conflict,
                hasChildren: !children.isEmpty
            )
        case .table(let table):
            return WikiTreeRowModel(
                id: node.id,
                title: table.title,
                depth: depth,
                documentId: ids[WikiDocuments.projectPath(of: table.path, folder: folder)],
                icon: "tablecells",
                badge: "\(table.rows.count)",
                isConflict: false,
                hasChildren: false
            )
        }
    }

    private func toggle(_ id: String) {
        withAnimation(.easeInOut(duration: 0.15)) {
            if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
        }
    }

    // MARK: Data

    private func startObserving() {
        cancellable?.cancel()
        guard let db = appState.databaseManager else {
            observationError = "The wiki is unavailable until this account connects."
            return
        }
        let projectId = project.id
        let prefix = folder.isEmpty ? "" : folder + "/"
        let observation = ValueObservation.tracking { db in
            try SyncedDocument
                .filter(SyncedDocument.Columns.projectId == projectId)
                .filter(SyncedDocument.Columns.relativePath.like("\(prefix)%"))
                .fetchAll(db)
        }
        cancellable = observation.start(
            in: db.writer,
            onError: { _ in observationError = "Could not load the wiki. Please retry." },
            onChange: { docs in
                documents = docs
                snapshot = WikiStore.shared.snapshot(
                    projectId: projectId, folder: folder, documents: docs, types: project.localWikiTypes
                ) { appState.documentSyncManager?.decryptContentOnDemand($0) }
            }
        )
    }

    private func message(_ text: String, retry: Bool) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "books.vertical")
                .font(.system(size: 36))
                .foregroundStyle(.secondary)
            Text(text).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if retry {
                Button("Retry") {
                    observationError = nil
                    startObserving()
                    appState.documentSyncManager?.retryProject(project.id)
                }
            }
        }
        .padding()
    }

    private var expandedKey: String { "wikiTree.expanded.\(project.id)" }

    private func loadExpanded() {
        if let array = UserDefaults.standard.stringArray(forKey: expandedKey) { expanded = Set(array) }
    }

    private func saveExpanded() {
        UserDefaults.standard.set(Array(expanded), forKey: expandedKey)
    }
}

struct WikiTreeRowModel: Identifiable {
    let id: String
    let title: String
    let depth: Int
    /// The synced file to open; nil for a bare folder or a file that has not synced.
    let documentId: String?
    let icon: String
    let badge: String?
    let isConflict: Bool
    var hasChildren: Bool
}

private struct WikiTreeRow: View {
    let row: WikiTreeRowModel
    let isExpanded: Bool
    let onToggle: () -> Void

    var body: some View {
        if let documentId = row.documentId {
            content.tag(WorkspaceSelection.document(documentId))
        } else {
            Button(action: onToggle) { content }.buttonStyle(.plain)
        }
    }

    private var content: some View {
        HStack(spacing: 0) {
            Spacer().frame(width: CGFloat(row.depth) * 14)
            if row.hasChildren {
                Button(action: onToggle) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(NimbalystColors.textFaint)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(isExpanded ? "Collapse \(row.title)" : "Expand \(row.title)")
            } else {
                Spacer().frame(width: 22)
            }
            Image(systemName: row.icon)
                .font(.system(size: 13))
                .foregroundStyle(row.isConflict ? NimbalystColors.warning : NimbalystColors.primary)
                .frame(width: 18, height: 18)
                .padding(.trailing, 6)
            Text(row.title)
                .font(.system(size: 14))
                .foregroundStyle(row.documentId == nil && !row.hasChildren ? NimbalystColors.textFaint : NimbalystColors.text)
                .lineLimit(1)
            Spacer()
            if let badge = row.badge {
                Text(badge)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(row.isConflict ? NimbalystColors.warning : NimbalystColors.textFaint)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(NimbalystColors.background)
                    .clipShape(Capsule())
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityIdentifier("wiki-row-\(row.title)")
    }
}
