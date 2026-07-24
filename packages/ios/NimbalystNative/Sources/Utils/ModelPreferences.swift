import Foundation

/// Manages the user's AI model selection preferences.
/// Persists the last-used model in UserDefaults and resolves which model to use
/// based on availability, falling back to the desktop default.
public enum ModelPreferences {
    private static let lastUsedModelKey = "lastUsedModelId"
    private static let availableModelsKey = "syncedAvailableModels"
    private static let defaultModelKey = "syncedDefaultModel"

    public static func saveLastUsedModel(_ modelId: String) {
        UserDefaults.standard.set(modelId, forKey: lastUsedModelKey)
    }

    public static func lastUsedModel() -> String? {
        UserDefaults.standard.string(forKey: lastUsedModelKey)
    }

    /// Persist the available models and default model from the desktop sync.
    public static func saveAvailableModels(_ models: [SyncedAvailableModel], defaultModel: String?) {
        if let data = try? JSONEncoder().encode(models) {
            UserDefaults.standard.set(data, forKey: availableModelsKey)
        }
        UserDefaults.standard.set(defaultModel, forKey: defaultModelKey)
    }

    /// Load persisted available models (from last desktop sync).
    public static func loadAvailableModels() -> [SyncedAvailableModel] {
        guard let data = UserDefaults.standard.data(forKey: availableModelsKey),
              let models = try? JSONDecoder().decode([SyncedAvailableModel].self, from: data) else {
            return []
        }
        return models
    }

    /// Load persisted desktop default model.
    public static func loadDefaultModel() -> String? {
        UserDefaults.standard.string(forKey: defaultModelKey)
    }

    /// Resolve which model to use for new sessions.
    /// Priority: last-used (if still available) > desktop default (if available) > first available.
    public static func resolveModel(
        available: [SyncedAvailableModel],
        desktopDefault: String?
    ) -> String? {
        // 1. Last used model, if it's still in the available list
        if let lastUsed = lastUsedModel(),
           available.contains(where: { $0.id == lastUsed }) {
            return lastUsed
        }
        // 2. Desktop default, if it's in the available list
        if let defaultModel = desktopDefault,
           available.contains(where: { $0.id == defaultModel }) {
            return defaultModel
        }
        // 3. First available model
        return available.first?.id
    }

    /// Extract the provider prefix from a model ID (e.g., "claude-code:opus" -> "claude-code").
    public static func providerFromModelId(_ modelId: String?) -> String? {
        guard let id = modelId else { return nil }
        let parts = id.split(separator: ":", maxSplits: 1)
        return parts.first.map(String.init)
    }
}
