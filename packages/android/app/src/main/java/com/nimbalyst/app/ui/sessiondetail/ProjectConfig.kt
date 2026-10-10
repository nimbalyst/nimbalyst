package com.nimbalyst.app.ui.sessiondetail

import com.google.gson.Gson
import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.sync.SessionCreationOptions
import com.nimbalyst.app.sync.SyncedActionPrompt
import com.nimbalyst.app.sync.SyncedSlashCommand

/** Decodes the project config the sync layer stores on `ProjectEntity`. */
object ProjectConfig {
    private val gson = Gson()

    fun commands(commandsJson: String?): List<SlashCommand> =
        decode(commandsJson, Array<SyncedSlashCommand>::class.java)
            // Gson ignores Kotlin nullability; drop malformed entries.
            .filter { (it.name as String?)?.isNotBlank() == true }
            .map { SlashCommand(name = it.name, description = it.description, source = it.source.orEmpty()) }

    /** Only actions the phone can carry out; worktree launchers need a worktree the phone cannot create. */
    fun mobileActions(actionsJson: String?): List<SyncedActionPrompt> =
        decode(actionsJson, Array<SyncedActionPrompt>::class.java).filter {
            (it.label as String?) != null && (it.body as String?) != null && it.isSupportedOnMobile
        }

    /**
     * A launcher action as a new-session request, mirroring iOS
     * `launchActionInNewSession`: a sibling in this session's workstream on the
     * same host. `autoSubmit: false` seeds the body as a draft instead of sending it.
     */
    fun launchOptions(action: SyncedActionPrompt, session: SessionEntity): SessionCreationOptions {
        val holdAsDraft = action.autoSubmit == false
        return SessionCreationOptions(
            projectId = session.projectId,
            initialPrompt = if (holdAsDraft) null else action.body,
            parentSessionId = session.parentSessionId,
            provider = action.model?.substringBefore(':'),
            model = action.model,
            targetDeviceId = session.hostDeviceId,
            initialDraft = if (holdAsDraft) action.body else null
        )
    }

    private fun <T> decode(json: String?, type: Class<Array<T>>): List<T> {
        if (json.isNullOrBlank()) return emptyList()
        return runCatching { gson.fromJson(json, type)?.toList() }.getOrNull().orEmpty()
    }
}
