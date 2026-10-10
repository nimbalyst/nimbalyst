package com.nimbalyst.app.pages

import android.content.SharedPreferences
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/** One org from `GET /api/teams` (collabv3 `teamDirectory.ts`), reduced to what the phone needs. */
data class ConsoleTeamSummary(
    val orgId: String,
    val name: String,
    val membershipType: String? = "active_member",
    /** Single-project teams created before the project registry. */
    val gitRemoteHash: String? = null,
    val teamProjectId: String? = null,
    val projects: List<TeamProject> = emptyList(),
) {
    data class TeamProject(
        val projectId: String,
        val teamProjectId: String,
        val gitRemoteHash: String?,
        val name: String? = null,
    )

    companion object {
        /** Parse a `{ teams: [...] }` body. Returns null when the shape is wrong. */
        fun parseResponse(body: String): List<ConsoleTeamSummary>? {
            val root = runCatching { JsonParser.parseString(body) }.getOrNull()?.takeIf { it.isJsonObject }?.asJsonObject ?: return null
            val teams = root.get("teams")?.takeIf { it.isJsonArray }?.asJsonArray ?: return null
            return teams.mapNotNull { element -> element.takeIf { it.isJsonObject }?.asJsonObject?.let(::parseTeam) }
        }

        private fun parseTeam(record: JsonObject): ConsoleTeamSummary? {
            val orgId = record.stringOrNull("orgId") ?: return null
            val projects = (record.get("projects")?.takeIf { it.isJsonArray }?.asJsonArray ?: JsonArray()).mapNotNull { element ->
                val project = element.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
                TeamProject(
                    projectId = project.stringOrNull("projectId") ?: return@mapNotNull null,
                    teamProjectId = project.stringOrNull("teamProjectId") ?: return@mapNotNull null,
                    gitRemoteHash = project.stringOrNull("gitRemoteHash"),
                    name = project.stringOrNull("name"),
                )
            }
            return ConsoleTeamSummary(
                orgId = orgId,
                name = record.stringOrNull("name") ?: "Team",
                membershipType = record.stringOrNull("membershipType"),
                gitRemoteHash = record.stringOrNull("gitRemoteHash"),
                teamProjectId = record.stringOrNull("teamProjectId"),
                projects = projects,
            )
        }
    }
}

/** A phone project's team project in one org. */
data class ConsoleTeamProjectMatch(val orgId: String, val orgName: String, val teamProjectId: String) {
    val id: String get() = "$orgId/$teamProjectId"
    val wikiRoute: ConsoleRoute? get() = ConsoleRoute.wiki(orgId, teamProjectId)
    val trackersRoute: ConsoleRoute? get() = ConsoleRoute.trackers(orgId, teamProjectId)
}

/** Whether a phone project has a team project, and which. */
sealed interface ConsoleProjectMapping {
    data object Unmapped : ConsoleProjectMapping
    data class Mapped(val match: ConsoleTeamProjectMatch) : ConsoleProjectMapping
    /** The same remote is shared in several orgs and the user has not picked one. */
    data class NeedsChoice(val matches: List<ConsoleTeamProjectMatch>) : ConsoleProjectMapping
}

/** Phone project -> (orgId, teamProjectId). Pure. */
object ConsoleTeamResolver {
    /**
     * Every team project with this remote, in orgs the user is an active member
     * of (the console-session mint refuses any other membership).
     */
    fun matches(gitRemoteHash: String?, teams: List<ConsoleTeamSummary>): List<ConsoleTeamProjectMatch> {
        val hash = gitRemoteHash?.trim()?.takeIf { it.isNotEmpty() } ?: return emptyList()
        val seen = mutableSetOf<String>()
        val result = mutableListOf<ConsoleTeamProjectMatch>()
        for (team in teams) {
            if ((team.membershipType ?: "active_member") != "active_member") continue
            val candidates = team.projects
                .filter { it.gitRemoteHash == hash && it.teamProjectId.isNotEmpty() }
                .map { it.teamProjectId }
                .toMutableList()
            if (team.gitRemoteHash == hash && !team.teamProjectId.isNullOrEmpty()) candidates += team.teamProjectId
            for (teamProjectId in candidates) {
                val match = ConsoleTeamProjectMatch(team.orgId, team.name, teamProjectId)
                if (match.wikiRoute == null || !seen.add(match.id)) continue
                result += match
            }
        }
        return result
    }

    fun mapping(gitRemoteHash: String?, teams: List<ConsoleTeamSummary>, rememberedOrgId: String?): ConsoleProjectMapping {
        val all = matches(gitRemoteHash, teams)
        return when (all.size) {
            0 -> ConsoleProjectMapping.Unmapped
            1 -> ConsoleProjectMapping.Mapped(all[0])
            else -> all.firstOrNull { rememberedOrgId != null && it.orgId == rememberedOrgId }
                ?.let { ConsoleProjectMapping.Mapped(it) }
                ?: ConsoleProjectMapping.NeedsChoice(all)
        }
    }
}

/**
 * Small persisted values the Pages shell keeps: org choices, the store-removal
 * journal, and the unsynced-edits marker. Writes are synchronous so a journal
 * entry survives a process death right after it is made.
 */
interface ConsoleKeyValueStore {
    fun getString(key: String): String?
    /** A null [value] removes the key. */
    fun putString(key: String, value: String?)
    fun keys(): Set<String>
}

class SharedPreferencesConsoleStore(private val preferences: SharedPreferences) : ConsoleKeyValueStore {
    override fun getString(key: String): String? = preferences.getString(key, null)

    override fun putString(key: String, value: String?) {
        val editor = preferences.edit()
        if (value == null) editor.remove(key) else editor.putString(key, value)
        // commit, not apply: the removal journal must be on disk before anything is deleted.
        editor.commit()
    }

    override fun keys(): Set<String> = preferences.all.keys
}

internal fun ConsoleKeyValueStore.getStringList(key: String): List<String> {
    val raw = getString(key) ?: return emptyList()
    val array = runCatching { JsonParser.parseString(raw) }.getOrNull()?.takeIf { it.isJsonArray }?.asJsonArray ?: return emptyList()
    return array.mapNotNull { element -> element.takeIf { it.isJsonPrimitive }?.asString }
}

internal fun ConsoleKeyValueStore.putStringList(key: String, values: List<String>) {
    if (values.isEmpty()) {
        putString(key, null)
    } else {
        putString(key, JsonArray().apply { values.forEach(::add) }.toString())
    }
}

/** The org a user picked for a project whose remote is shared in several orgs. */
class ConsoleOrgChoiceStore(private val store: ConsoleKeyValueStore) {
    private fun key(accountId: String, projectId: String) = "consolePages.orgChoice.$accountId.$projectId"

    fun orgId(accountId: String, projectId: String): String? = store.getString(key(accountId, projectId))

    fun remember(orgId: String, accountId: String, projectId: String) = store.putString(key(accountId, projectId), orgId)

    fun forgetAccount(accountId: String) {
        val prefix = "consolePages.orgChoice.$accountId."
        store.keys().filter { it.startsWith(prefix) }.forEach { store.putString(it, null) }
    }
}
