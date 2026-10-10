package com.nimbalyst.app.sync

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Desktop settings the phone keeps: the model list, the default model, and
 * feature gates. All three are persisted, like iOS `ModelPreferences`, so the
 * model picker and Meta Agent UI are populated on launch before the desktop
 * re-sends its settings.
 */
internal class SettingsSyncApplier(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val gson = Gson()
    private val _availableModels = MutableStateFlow(loadModels())
    private val _defaultModel = MutableStateFlow(prefs.getString(KEY_DEFAULT_MODEL, null))
    private val _metaAgentEnabled = MutableStateFlow(prefs.getBoolean(KEY_META_AGENT_ENABLED, false))

    val availableModels: StateFlow<List<SyncedAvailableModel>> = _availableModels.asStateFlow()
    val defaultModel: StateFlow<String?> = _defaultModel.asStateFlow()
    val metaAgentEnabled: StateFlow<Boolean> = _metaAgentEnabled.asStateFlow()

    /**
     * Whether a publish from [deviceId] is newer than the last one applied.
     * Older desktops reset `version` on launch, so order by timestamp first:
     * their new launch is accepted, but a higher counter replayed from an old
     * launch cannot rewind settings. The counter breaks same-millisecond ties.
     * Port of iOS `SettingsSyncApplier.isFresh`; the watermark is persisted
     * per desktop so a replay after restart is still rejected.
     */
    fun isFresh(deviceId: String, timestamp: Long, version: Long): Boolean {
        val last = prefs.getString(watermarkKey(deviceId), null)?.split(':') ?: return true
        val lastTimestamp = last.getOrNull(0)?.toLongOrNull() ?: return true
        val lastVersion = last.getOrNull(1)?.toLongOrNull() ?: return true
        if (timestamp != lastTimestamp) return timestamp > lastTimestamp
        return version > lastVersion
    }

    /** Applies [settings] only when [payload] is fresh. Returns whether it applied. */
    fun accept(payload: EncryptedSettingsPayload, settings: SyncedSettings): Boolean {
        synchronized(this) {
            if (!isFresh(payload.deviceId, payload.timestamp, payload.version)) return false
            prefs.edit().putString(watermarkKey(payload.deviceId), "${payload.timestamp}:${payload.version}").apply()
        }
        apply(settings)
        return true
    }

    private fun watermarkKey(deviceId: String) = "$KEY_WATERMARK_PREFIX$deviceId"

    /** A field the desktop omitted keeps its stored value (iOS `AppState` parity). */
    private fun apply(settings: SyncedSettings) {
        val edit = prefs.edit()
        settings.availableModels?.let { models ->
            _availableModels.value = models
            edit.putString(KEY_AVAILABLE_MODELS, gson.toJson(models))
        }
        settings.defaultModel?.let { model ->
            _defaultModel.value = model
            edit.putString(KEY_DEFAULT_MODEL, model)
        }
        val metaAgentEnabled = settings.metaAgentEnabled ?: false
        _metaAgentEnabled.value = metaAgentEnabled
        edit.putBoolean(KEY_META_AGENT_ENABLED, metaAgentEnabled).apply()
    }

    private fun loadModels(): List<SyncedAvailableModel> {
        val json = prefs.getString(KEY_AVAILABLE_MODELS, null) ?: return emptyList()
        return runCatching {
            gson.fromJson<List<SyncedAvailableModel>>(json, object : TypeToken<List<SyncedAvailableModel>>() {}.type)
        }.getOrNull().orEmpty()
    }

    private companion object {
        const val PREFS_NAME = "nimbalyst_sync_settings"
        const val KEY_META_AGENT_ENABLED = "metaAgentEnabled"
        const val KEY_AVAILABLE_MODELS = "availableModels"
        const val KEY_DEFAULT_MODEL = "defaultModel"
        const val KEY_WATERMARK_PREFIX = "appliedSettings:"
    }
}
