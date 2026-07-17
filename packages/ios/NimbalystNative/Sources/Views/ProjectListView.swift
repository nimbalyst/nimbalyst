import SwiftUI
import Combine
import GRDB

/// Displays the list of projects (workspace paths) synced from the desktop app.
/// Uses GRDB ValueObservation for reactive updates when the database changes.
public struct ProjectListView: View {
    @EnvironmentObject var appState: AppState
    @State private var projects: [Project] = []
    @State private var cancellable: AnyDatabaseCancellable?
    @State private var accountSwitchError: String?

    public init() {}

    public var body: some View {
        List {
            Section {
                ForEach(projects) { project in
                    NavigationLink(value: project) {
                        ProjectRow(project: project)
                    }
                }
            } header: {
                brandingHeader
                    .textCase(nil)
                    .listRowInsets(EdgeInsets())
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        #endif
        .navigationTitle("Nimbalyst")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .refreshable {
            appState.requestSync()
            // Give a moment for the sync response to arrive and update SQLite
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        .navigationDestination(for: Project.self) { project in
            SessionListView(project: project)
                .onAppear {
                    AnalyticsManager.shared.capture("mobile_project_selected")
                }
        }
        .overlay {
            if projects.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "folder")
                        .font(.system(size: 48))
                        .foregroundStyle(.secondary)
                    Text("No Projects")
                        .font(.title3)
                    Text("Projects will appear here once synced from your Mac.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding()
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                connectionIndicator
            }
            ToolbarItem(placement: .primaryAction) {
                accountSwitcher
            }
            #if os(iOS)
            ToolbarItem(placement: .topBarLeading) {
                NavigationLink(value: "settings") {
                    Image(systemName: "gearshape")
                }
            }
            #else
            ToolbarItem {
                NavigationLink(value: "settings") {
                    Image(systemName: "gearshape")
                }
            }
            #endif
        }
        .navigationDestination(for: String.self) { value in
            if value == "settings" {
                SettingsView()
            }
        }
        .alert("Could Not Switch Accounts", isPresented: Binding(
            get: { accountSwitchError != nil },
            set: { if !$0 { accountSwitchError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(accountSwitchError ?? "")
        }
        .onAppear {
            startObserving()
        }
        .onReceive(appState.$databaseManager) { db in
            // Always restart observation when databaseManager changes (e.g. after re-pairing)
            cancellable?.cancel()
            cancellable = nil
            if db != nil {
                startObserving()
            }
        }
        .onDisappear {
            cancellable?.cancel()
        }
    }

    private var brandingHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                #if os(iOS)
                if let icon = appIcon {
                    Image(uiImage: icon)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 36, height: 36)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                #endif
                Text("Nimbalyst")
                    .font(.title.bold())
                    .foregroundStyle(.primary)
            }
            Text("Projects")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
                .tracking(0.5)
        }
        .padding(.top, 8)
        .padding(.bottom, 4)
    }

    #if os(iOS)
    private var appIcon: UIImage? {
        guard let iconName = Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any],
              let primaryIcon = iconName["CFBundlePrimaryIcon"] as? [String: Any],
              let iconFiles = primaryIcon["CFBundleIconFiles"] as? [String],
              let lastIcon = iconFiles.last else {
            return nil
        }
        return UIImage(named: lastIcon)
    }
    #endif

    private var isDesktopConnected: Bool {
        if appState.screenshotMode { return true }
        return appState.syncManager?.connectedDevices.contains(where: { $0.type == "desktop" }) ?? false
    }

    private var connectionIndicator: some View {
        HStack(spacing: 4) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 14))
                .foregroundStyle(appState.isConnected ? .primary : .secondary)
            Circle()
                .fill(isDesktopConnected ? Color.green : (appState.isConnected ? Color.orange : Color.gray))
                .frame(width: 8, height: 8)
        }
    }

    private var accountSwitcher: some View {
        Menu {
            ForEach(appState.accounts) { account in
                Button {
                    do {
                        try appState.switchAccount(to: account.id)
                    } catch {
                        accountSwitchError = error.localizedDescription
                    }
                } label: {
                    if account.id == appState.activeAccountId {
                        Label(account.email, systemImage: "checkmark")
                    } else {
                        Text(account.email)
                    }
                }
                .disabled(account.id == appState.activeAccountId)
            }
        } label: {
            Image(systemName: "person.crop.circle")
                .accessibilityLabel("Switch account")
        }
    }

    private func startObserving() {
        guard let db = appState.databaseManager else { return }

        let observation = ValueObservation.tracking { db in
            try Project
                .order(Project.Columns.lastUpdatedAt.desc, Project.Columns.name)
                .fetchAll(db)
        }

        cancellable = observation.start(
            in: db.writer,
            onError: { error in
                print("Project observation error: \(error)")
            },
            onChange: { newProjects in
                withAnimation {
                    projects = newProjects
                }
            }
        )
    }
}

struct ProjectRow: View {
    let project: Project

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(project.name)
                    .font(.body)
                    .foregroundStyle(.primary)
                if project.sessionCount > 0 {
                    Text("\(project.sessionCount) session\(project.sessionCount == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let lastUpdated = project.lastUpdatedAt {
                Text(RelativeTimestamp.format(epochMs: lastUpdated))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
    }
}
