#if canImport(UIKit)
import SwiftUI
import UIKit
import GRDB

/// A selected synced file, opened with what the Local wiki knows about it:
/// pages open in the document editor (typed pages with their type and fields
/// above the body, links between pages followed in the app), table types and
/// other CSV files as a read-only grid. Files outside a wiki open as before.
struct WikiAwareDocumentView: View {
    @EnvironmentObject var appState: AppState
    let document: SyncedDocument
    let onOpenDocument: (String) -> Void

    @State private var resolved: Resolved?
    @State private var observation: AnyDatabaseCancellable?

    /// The file's wiki role, with the snapshot links resolve against.
    private struct Resolved {
        var role: WikiDocuments.Role
        var folder: String?
        var snapshot: WikiSnapshot?

        /// Every editor case shares one view, so a change of permission updates
        /// the open editor instead of replacing it.
        var editor: (readOnly: Bool, page: WikiPage?)? {
            switch role {
            case .outside, .otherFile: return (false, nil)
            case .unsupportedFormat: return (true, nil)
            case .page(let page): return (page.malformed || page.documentType != "markdown", page)
            case .table, .csv: return nil
            }
        }
    }

    var body: some View {
        Group {
            if let resolved {
                if let editor = resolved.editor {
                    DocumentEditorView(
                        document: document,
                        readOnly: editor.readOnly,
                        header: editor.page.flatMap { page in
                            guard page.type != nil, let snapshot = resolved.snapshot else { return nil }
                            return AnyView(WikiPageHeader(page: page, snapshot: snapshot))
                        },
                        onLink: { follow($0, $1, in: resolved) }
                    )
                } else if case .table(let table) = resolved.role {
                    WikiTableView(title: table.title, header: table.header, rows: table.rows.map { row in
                        table.header.map { column in column == "id" ? row.id : row.fields.first { $0.name == column }?.value.displayText ?? "" }
                    }, malformed: table.malformed)
                } else {
                    let rows = (try? WikiFormat.parseCSV(content ?? "")) ?? []
                    WikiTableView(title: document.displayName, header: rows.first ?? [], rows: Array(rows.dropFirst()), malformed: false)
                }
            } else {
                ProgressView()
            }
        }
        .onAppear(perform: observe)
        .onDisappear { observation?.cancel() }
    }

    private var content: String? {
        document.contentDecrypted ?? appState.documentSyncManager?.decryptContentOnDemand(document)
    }

    /// Re-resolves whenever the project row (wiki folder, types) or any of its
    /// files change: a marker that turns the wiki unsupported, a page that turns
    /// malformed, or a rename that moves a link target.
    private func observe() {
        observation?.cancel()
        guard let database = appState.databaseManager else {
            resolved = Resolved(role: WikiDocuments.role(of: document.relativePath, folder: nil, snapshot: nil))
            return
        }
        let projectId = document.projectId
        observation = ValueObservation
            .tracking { db in
                (try Project.fetchOne(db, key: projectId),
                 try SyncedDocument.filter(SyncedDocument.Columns.projectId == projectId).fetchAll(db))
            }
            .start(in: database.writer, scheduling: .immediate, onError: { _ in }) { project, documents in
                resolved = resolve(project: project, documents: documents)
            }
    }

    private func resolve(project: Project?, documents: [SyncedDocument]) -> Resolved {
        guard let folder = project?.localWikiFolder,
              WikiDocuments.wikiPath(of: document.relativePath, folder: folder) != nil else {
            return Resolved(role: WikiDocuments.role(of: document.relativePath, folder: nil, snapshot: nil))
        }
        let snapshot = WikiStore.shared.snapshot(
            projectId: document.projectId, folder: folder, documents: documents, types: project?.localWikiTypes ?? []
        ) { appState.documentSyncManager?.decryptContentOnDemand($0) }
        return Resolved(role: WikiDocuments.role(of: document.relativePath, folder: folder, snapshot: snapshot), folder: folder, snapshot: snapshot)
    }

    /// True when the link was handled here; web links fall through to the editor.
    private func follow(_ href: String, _ title: String?, in resolved: Resolved) -> Bool {
        switch WikiDocuments.linkTarget(href: href, title: title, fromRelativePath: document.relativePath, folder: resolved.folder, snapshot: resolved.snapshot) {
        case .external: return false
        case .none: return true
        case .document(let path):
            if let target = try? appState.databaseManager?.document(forProject: document.projectId, relativePath: path) {
                onOpenDocument(target.id)
            }
            return true
        }
    }
}

/// A typed page's type and fields, read-only, above its body.
struct WikiPageHeader: View {
    let page: WikiPage
    let snapshot: WikiSnapshot
    @State private var expanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "tag")
                    Text(page.type.map(snapshot.typeName) ?? "")
                        .font(.system(size: 12, weight: .semibold))
                    Spacer()
                    if !page.fields.isEmpty {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 10, weight: .semibold))
                            .rotationEffect(.degrees(expanded ? 0 : -90))
                    }
                }
                .foregroundStyle(NimbalystColors.primary)
            }
            .buttonStyle(.plain)
            if expanded {
                ForEach(page.fields, id: \.name) { field in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(field.name)
                            .font(.system(size: 12))
                            .foregroundStyle(NimbalystColors.textFaint)
                            .frame(width: 96, alignment: .leading)
                        Text(field.value.displayText)
                            .font(.system(size: 13))
                            .foregroundStyle(NimbalystColors.text)
                            .textSelection(.enabled)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(hex: 0x222222))
        .accessibilityIdentifier("wiki-page-header")
    }
}

/// Rows of a table type or a CSV file, read-only.
struct WikiTableView: View {
    let title: String
    let header: [String]
    let rows: [[String]]
    let malformed: Bool

    var body: some View {
        Group {
            if malformed {
                ContentUnavailableView("This table could not be read", systemImage: "tablecells", description: Text("Fix the file on the desktop."))
            } else if header.isEmpty {
                ContentUnavailableView("Empty table", systemImage: "tablecells")
            } else {
                ScrollView([.horizontal, .vertical]) {
                    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                        GridRow {
                            ForEach(Array(header.enumerated()), id: \.offset) { _, column in
                                Text(column).font(.system(size: 12, weight: .semibold)).foregroundStyle(NimbalystColors.textFaint)
                            }
                        }
                        Divider()
                        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                            GridRow {
                                ForEach(Array(header.indices), id: \.self) { column in
                                    Text(column < row.count ? row[column] : "")
                                        .font(.system(size: 13))
                                        .foregroundStyle(NimbalystColors.text)
                                        .lineLimit(3)
                                        .frame(maxWidth: 240, alignment: .leading)
                                        .textSelection(.enabled)
                                }
                            }
                        }
                    }
                    .padding(16)
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("wiki-table")
    }
}
#endif
