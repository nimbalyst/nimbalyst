import SwiftUI
import GRDB

/// Displays synced documents for a project as a collapsible file tree
/// with path flattening (single-child directory chains collapsed into one row).
struct DocumentListView: View {
    @EnvironmentObject var appState: AppState
    let project: Project

    /// When non-nil, the List uses selection binding for NavigationSplitView sidebar mode.
    /// When nil, NavigationLink push navigation is used (iPhone NavigationStack mode).
    private var selectedDocument: Binding<SyncedDocument?>?

    private var isIPadSidebar: Bool { selectedDocument != nil }

    @State private var documents: [SyncedDocument] = []
    @State private var cancellable: AnyDatabaseCancellable?
    @State private var searchText = ""
    @State private var isLoading = true
    @State private var expandedPaths: Set<String> = []

    /// iPhone init: push navigation via NavigationLink.
    init(project: Project) {
        self.project = project
        self.selectedDocument = nil
    }

    /// iPad init: selection binding drives NavigationSplitView detail column.
    init(project: Project, selectedDocument: Binding<SyncedDocument?>) {
        self.project = project
        self.selectedDocument = selectedDocument
    }

    private var filteredDocuments: [SyncedDocument] {
        if searchText.isEmpty { return documents }
        return documents.filter { doc in
            doc.title.localizedCaseInsensitiveContains(searchText)
            || doc.relativePath.localizedCaseInsensitiveContains(searchText)
        }
    }

    private var treeNodes: [FileTreeNode] {
        buildFlattenedTree(from: filteredDocuments, expandedPaths: expandedPaths)
    }

    var body: some View {
        Group {
            if isLoading {
                ProgressView()
            } else if documents.isEmpty {
                emptyState
            } else {
                documentTree
            }
        }
        .searchable(text: $searchText, prompt: "Search files")
        .onAppear {
            loadExpandedPaths()
            startObserving()
            connectDocSync()
        }
        .onDisappear {
            cancellable?.cancel()
        }
        .onChange(of: expandedPaths) {
            saveExpandedPaths()
        }
    }

    private var documentTree: some View {
        Group {
            if let binding = selectedDocument {
                List(selection: binding) {
                    documentTreeRows
                }
                .listStyle(.sidebar)
            } else {
                List {
                    documentTreeRows
                }
                .listStyle(.plain)
                #if canImport(UIKit)
                .navigationDestination(for: SyncedDocument.self) { doc in
                    DocumentEditorView(document: doc)
                        .environmentObject(appState)
                }
                #endif
            }
        }
    }

    @ViewBuilder
    private var documentTreeRows: some View {
        ForEach(treeNodes) { node in
            FileTreeRow(
                node: node,
                isExpanded: expandedPaths.contains(node.path),
                useSelectionTag: isIPadSidebar,
                onToggle: { toggleExpansion(node.path) }
            )
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 16))
            .listRowSeparator(.hidden)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "doc.text")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("No Documents")
                .font(.title3)
            Text("Markdown files will appear here once synced from your Mac.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }

    private func toggleExpansion(_ path: String) {
        withAnimation(.easeInOut(duration: 0.15)) {
            if expandedPaths.contains(path) {
                expandedPaths.remove(path)
            } else {
                expandedPaths.insert(path)
            }
        }
    }

    private func startObserving() {
        guard let db = appState.databaseManager else { return }

        let projectId = project.id
        let observation = ValueObservation.tracking { db in
            try SyncedDocument
                .filter(SyncedDocument.Columns.projectId == projectId)
                .order(SyncedDocument.Columns.relativePath)
                .fetchAll(db)
        }

        cancellable = observation.start(
            in: db.writer,
            onError: { _ in },
            onChange: { newDocs in
                withAnimation {
                    documents = newDocs
                    isLoading = false
                }
            }
        )
    }

    private func connectDocSync() {
        appState.documentSyncManager?.connectProject(project.id)
    }

    private var expandedPathsKey: String {
        "fileTree.expandedPaths.\(project.id)"
    }

    private func loadExpandedPaths() {
        if let array = UserDefaults.standard.stringArray(forKey: expandedPathsKey) {
            expandedPaths = Set(array)
        }
    }

    private func saveExpandedPaths() {
        UserDefaults.standard.set(Array(expandedPaths), forKey: expandedPathsKey)
    }
}

// MARK: - File Tree Node

/// A single visible row in the flattened tree -- either a directory or a file.
struct FileTreeNode: Identifiable {
    let id: String
    /// Full path for this node (used as expansion key for directories)
    let path: String
    /// Display label (may contain "/" for flattened ancestor chains)
    let displayLabel: String
    /// Depth in the visual tree (for indentation)
    let depth: Int
    /// Whether this is a directory (expandable) or a file (leaf)
    let isDirectory: Bool
    /// For file nodes, the associated document
    let document: SyncedDocument?
    /// For directory nodes, total file count in subtree
    let fileCount: Int
    /// For file nodes, last modified timestamp
    let lastModifiedAt: Int?

    /// The segments of the display label, split for styling (ancestor vs leaf)
    var labelSegments: [(text: String, isLeaf: Bool)] {
        let parts = displayLabel.components(separatedBy: "/")
        return parts.enumerated().map { (i, part) in
            (text: part, isLeaf: i == parts.count - 1)
        }
    }
}

// MARK: - Tree Building

/// Intermediate tree structure used during construction.
private class TreeDir {
    let name: String
    var children: [String: TreeDir] = [:]
    var files: [SyncedDocument] = []
    /// Sorted child directory names
    var sortedDirNames: [String] { children.keys.sorted() }

    init(name: String) {
        self.name = name
    }

    /// Total file count in this directory and all descendants.
    var totalFileCount: Int {
        files.count + children.values.reduce(0) { $0 + $1.totalFileCount }
    }
}

/// Build a flat array of visible tree nodes from documents, applying path flattening.
///
/// Path flattening: when a directory has exactly one child and that child is
/// also a directory (no files at this level), the two are merged into a single
/// display row, e.g. "src/components/ui".
func buildFlattenedTree(
    from documents: [SyncedDocument],
    expandedPaths: Set<String>
) -> [FileTreeNode] {
    // 1. Build an intermediate tree from relativePaths
    let root = TreeDir(name: "")
    for doc in documents {
        let components = doc.relativePath.components(separatedBy: "/")
        var current = root
        // Walk all path components except the last (filename)
        for dirName in components.dropLast() {
            if let existing = current.children[dirName] {
                current = existing
            } else {
                let child = TreeDir(name: dirName)
                current.children[dirName] = child
                current = child
            }
        }
        current.files.append(doc)
    }

    // 2. Flatten into visible nodes
    var result: [FileTreeNode] = []
    emitNodes(dir: root, depth: 0, pathPrefix: "", expandedPaths: expandedPaths, into: &result)
    return result
}

/// Recursively emit visible nodes from a TreeDir.
///
/// - Parameters:
///   - dir: The current directory to process
///   - depth: Visual indentation depth
///   - pathPrefix: Full path prefix for expansion tracking (e.g. "src/components")
///   - expandedPaths: Set of paths the user has expanded
///   - result: Output array
private func emitNodes(
    dir: TreeDir,
    depth: Int,
    pathPrefix: String,
    expandedPaths: Set<String>,
    into result: inout [FileTreeNode]
) {
    // Sort: directories first, then files
    let sortedDirs = dir.sortedDirNames
    let sortedFiles = dir.files.sorted { $0.relativePath < $1.relativePath }

    // Emit directory children
    for dirName in sortedDirs {
        guard let child = dir.children[dirName] else { continue }

        // Path flattening: if this child has exactly one child dir and no files,
        // merge it with its child into a single display label.
        var flattenedLabel = dirName
        var current = child
        var fullPath = pathPrefix.isEmpty ? dirName : "\(pathPrefix)/\(dirName)"

        while current.children.count == 1 && current.files.isEmpty {
            let onlyChildName = current.sortedDirNames[0]
            let onlyChild = current.children[onlyChildName]!
            flattenedLabel += "/\(onlyChildName)"
            fullPath += "/\(onlyChildName)"
            current = onlyChild
        }

        let isExpanded = expandedPaths.contains(fullPath)

        result.append(FileTreeNode(
            id: "dir:\(fullPath)",
            path: fullPath,
            displayLabel: flattenedLabel,
            depth: depth,
            isDirectory: true,
            document: nil,
            fileCount: current.totalFileCount,
            lastModifiedAt: nil
        ))

        if isExpanded {
            emitNodes(
                dir: current,
                depth: depth + 1,
                pathPrefix: fullPath,
                expandedPaths: expandedPaths,
                into: &result
            )
        }
    }

    // Emit file children
    for doc in sortedFiles {
        result.append(FileTreeNode(
            id: "file:\(doc.id)",
            path: doc.relativePath,
            displayLabel: doc.displayName,
            depth: depth,
            isDirectory: false,
            document: doc,
            fileCount: 0,
            lastModifiedAt: doc.lastModifiedAt
        ))
    }
}

// MARK: - File Tree Row View

struct FileTreeRow: View {
    let node: FileTreeNode
    let isExpanded: Bool
    var useSelectionTag: Bool = false
    let onToggle: () -> Void

    var body: some View {
        if let doc = node.document {
            if useSelectionTag {
                rowContent.tag(doc)
            } else {
                NavigationLink(value: doc) {
                    rowContent
                }
            }
        } else {
            Button(action: onToggle) {
                rowContent
            }
            .buttonStyle(.plain)
        }
    }

    private var rowContent: some View {
        HStack(spacing: 0) {
            // Indentation
            ForEach(0..<node.depth, id: \.self) { _ in
                Spacer().frame(width: 14)
            }

            // Disclosure chevron (or spacer for files)
            if node.isDirectory {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(NimbalystColors.textFaint)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    .frame(width: 22, height: 22)
            } else {
                Spacer().frame(width: 22)
            }

            // Icon
            if node.isDirectory {
                Image(systemName: isExpanded ? "folder.fill" : "folder")
                    .font(.system(size: 13))
                    .foregroundStyle(NimbalystColors.primary)
                    .frame(width: 18, height: 18)
                    .padding(.trailing, 6)
            } else {
                Image(systemName: fileIcon(for: node.displayLabel))
                    .font(.system(size: 13))
                    .foregroundStyle(fileColor(for: node.displayLabel))
                    .frame(width: 18, height: 18)
                    .padding(.trailing, 6)
            }

            // Label
            if node.isDirectory {
                flattenedDirectoryLabel
            } else {
                Text(node.displayLabel)
                    .font(.system(size: 14))
                    .foregroundStyle(NimbalystColors.text)
                    .lineLimit(1)
            }

            Spacer()

            // Badge (file count) or timestamp
            if node.isDirectory && node.fileCount > 0 {
                Text("\(node.fileCount)")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(NimbalystColors.textFaint)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(NimbalystColors.background)
                    .clipShape(Capsule())
            } else if let lastMod = node.lastModifiedAt {
                Text(RelativeTimestamp.format(epochMs: lastMod))
                    .font(.system(size: 11))
                    .foregroundStyle(NimbalystColors.textDisabled)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var flattenedDirectoryLabel: some View {
        let segments = node.labelSegments
        HStack(spacing: 0) {
            ForEach(Array(segments.enumerated()), id: \.offset) { index, segment in
                if index > 0 {
                    Text("/")
                        .font(.system(size: 11))
                        .foregroundStyle(NimbalystColors.textDisabled)
                        .padding(.horizontal, 1)
                }
                Text(segment.text)
                    .font(.system(size: 14))
                    .foregroundStyle(segment.isLeaf ? NimbalystColors.text : NimbalystColors.textFaint)
            }
        }
        .lineLimit(1)
    }

    private func fileIcon(for filename: String) -> String {
        let ext = (filename as NSString).pathExtension.lowercased()
        switch ext {
        case "md", "markdown": return "doc.text"
        case "swift": return "swift"
        case "ts", "tsx", "js", "jsx": return "chevron.left.forwardslash.chevron.right"
        case "json": return "curlybraces"
        case "css", "scss": return "paintbrush"
        case "yaml", "yml": return "list.bullet"
        case "html": return "globe"
        default: return "doc"
        }
    }

    private func fileColor(for filename: String) -> Color {
        let ext = (filename as NSString).pathExtension.lowercased()
        switch ext {
        case "md", "markdown": return NimbalystColors.textMuted
        case "swift": return NimbalystColors.error
        case "ts", "tsx": return Color(hex: 0x3178C6)
        case "js", "jsx": return NimbalystColors.warning
        case "json": return NimbalystColors.warning
        case "css", "scss": return NimbalystColors.purple
        case "yaml", "yml": return NimbalystColors.success
        case "html": return NimbalystColors.primary
        default: return NimbalystColors.textFaint
        }
    }
}
