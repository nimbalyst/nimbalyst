import SwiftUI

/// Floating overlay that shows slash command suggestions above the ComposeBar.
/// Filters commands by prefix match as the user types after '/'.
public struct CommandSuggestionView: View {
    let commands: [SyncedSlashCommand]
    let filter: String
    let onSelect: (SyncedSlashCommand) -> Void

    private var filteredCommands: [ScoredCommand] {
        let query = filter.lowercased()
        if query.isEmpty {
            // Show all commands grouped by source
            return commands.map { ScoredCommand(command: $0, score: 0) }
        }
        return commands.compactMap { cmd in
            let name = cmd.name.lowercased()
            if name.hasPrefix(query) {
                return ScoredCommand(command: cmd, score: 2)
            } else if name.contains(query) {
                return ScoredCommand(command: cmd, score: 1)
            }
            return nil
        }
        .sorted { $0.score > $1.score }
    }

    private var groupedCommands: [(String, [ScoredCommand])] {
        let grouped = Dictionary(grouping: filteredCommands) { sourceLabel($0.command.source) }
        // Sort groups: Project first, then Built-in, then User, then Plugin
        let order = ["Project", "Built-in", "User", "Plugin"]
        return order.compactMap { label in
            guard let items = grouped[label], !items.isEmpty else { return nil }
            return (label, items)
        }
    }

    public var body: some View {
        if !filteredCommands.isEmpty {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(groupedCommands, id: \.0) { label, items in
                        Text(label)
                            .font(.caption2)
                            .fontWeight(.semibold)
                            .foregroundStyle(NimbalystColors.textFaint)
                            .textCase(.uppercase)
                            .padding(.horizontal, 12)
                            .padding(.top, 8)
                            .padding(.bottom, 4)

                        ForEach(items) { item in
                            Button {
                                onSelect(item.command)
                            } label: {
                                HStack(spacing: 8) {
                                    Text("/\(item.command.name)")
                                        .font(.system(.body, design: .monospaced))
                                        .foregroundStyle(NimbalystColors.primary)

                                    if let desc = item.command.description, !desc.isEmpty {
                                        Text(desc)
                                            .font(.subheadline)
                                            .foregroundStyle(NimbalystColors.textMuted)
                                            .lineLimit(1)
                                    }

                                    Spacer()
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .frame(maxHeight: 200)
            .background(NimbalystColors.backgroundSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(NimbalystColors.border, lineWidth: 0.5)
            )
            .shadow(color: .black.opacity(0.3), radius: 8, y: -2)
            .padding(.horizontal, 12)
        }
    }

    private func sourceLabel(_ source: String) -> String {
        switch source {
        case "project": return "Project"
        case "builtin": return "Built-in"
        case "user": return "User"
        case "plugin": return "Plugin"
        default: return source.capitalized
        }
    }
}

// MARK: - Scored Command

private struct ScoredCommand: Identifiable {
    let command: SyncedSlashCommand
    let score: Int

    var id: String { command.id }
}
