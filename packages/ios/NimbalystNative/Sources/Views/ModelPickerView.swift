import SwiftUI

/// Model picker sheet that displays available AI models grouped by provider type,
/// matching the Electron ModelSelector.tsx visual structure.
struct ModelPickerView: View {
    let models: [SyncedAvailableModel]
    @Binding var selectedModelId: String?
    let onDismiss: () -> Void

    /// Models grouped into "Agents" (claude-code, openai-codex) vs "Chat" (claude, openai, lmstudio).
    private var agentModelsByProvider: [(provider: String, models: [SyncedAvailableModel])] {
        let agents = models.filter { $0.provider == "claude-code" || $0.provider == "openai-codex" }
        let grouped = Dictionary(grouping: agents, by: \.provider)
        return grouped.sorted { $0.key < $1.key }.map { (provider: $0.key, models: $0.value) }
    }

    private var chatModelsByProvider: [(provider: String, models: [SyncedAvailableModel])] {
        let chat = models.filter { $0.provider != "claude-code" && $0.provider != "openai-codex" }
        let grouped = Dictionary(grouping: chat, by: \.provider)
        return grouped.sorted { $0.key < $1.key }.map { (provider: $0.key, models: $0.value) }
    }

    var body: some View {
        NavigationStack {
            List {
                if !agentModelsByProvider.isEmpty {
                    Section {
                        ForEach(agentModelsByProvider, id: \.provider) { group in
                            providerSection(provider: group.provider, models: group.models)
                        }
                    } header: {
                        Text("Agents")
                    }
                }

                if !chatModelsByProvider.isEmpty {
                    Section {
                        ForEach(chatModelsByProvider, id: \.provider) { group in
                            providerSection(provider: group.provider, models: group.models)
                        }
                    } header: {
                        Text("Chat")
                    }
                }
            }
            #if os(iOS)
            .listStyle(.insetGrouped)
            #endif
            .navigationTitle("Select Model")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onDismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private func providerSection(provider: String, models: [SyncedAvailableModel]) -> some View {
        ForEach(models) { model in
            Button {
                selectedModelId = model.id
                ModelPreferences.saveLastUsedModel(model.id)
                onDismiss()
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.name)
                            .font(.body)
                            .foregroundStyle(.primary)
                        Text(providerLabel(provider))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if selectedModelId == model.id {
                        Image(systemName: "checkmark")
                            .font(.body)
                            .fontWeight(.semibold)
                            .foregroundStyle(NimbalystColors.primary)
                    }
                }
            }
        }
    }

    private func providerLabel(_ provider: String) -> String {
        switch provider {
        case "claude-code": return "Claude Agent (Claude Code)"
        case "openai-codex": return "OpenAI Codex"
        case "claude": return "Claude Chat"
        case "openai": return "OpenAI"
        case "lmstudio": return "LM Studio"
        default: return provider
        }
    }
}
