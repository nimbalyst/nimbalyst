package com.nimbalyst.app.ui.sessiondetail

/** A slash command synced from the desktop project, as shown in the typeahead. */
data class SlashCommand(
    val name: String,
    val description: String? = null,
    /** "project", "builtin", "user", or "plugin". */
    val source: String,
)

data class SlashCommandGroup(val source: String, val commands: List<SlashCommand>)

/**
 * Mirrors iOS `CommandSuggestionView`: group order and prefix-before-substring
 * ranking. Unlike iOS, commands from an unrecognized source are listed after
 * the known groups instead of being dropped.
 */
object SlashCommandFilter {
    private val GROUP_ORDER = listOf("project", "builtin", "user", "plugin")

    /** The text after '/' while the user is typing a command name, or null outside slash mode. */
    fun slashQuery(text: String): String? {
        val trimmed = text.trim(' ', '\t')
        if (!trimmed.startsWith("/")) return null
        val afterSlash = trimmed.substring(1)
        if (afterSlash.any { it.isWhitespace() }) return null
        return afterSlash
    }

    fun filter(commands: List<SlashCommand>, query: String): List<SlashCommandGroup> {
        val needle = query.lowercase()
        val ranked = if (needle.isEmpty()) {
            commands
        } else {
            commands.mapNotNull { command ->
                val name = command.name.lowercase()
                when {
                    name.startsWith(needle) -> command to 2
                    name.contains(needle) -> command to 1
                    else -> null
                }
            }.sortedByDescending { it.second }.map { it.first }
        }
        val grouped = ranked.groupBy { it.source }
        val order = GROUP_ORDER + (grouped.keys - GROUP_ORDER.toSet())
        return order.mapNotNull { source ->
            grouped[source]?.takeIf { it.isNotEmpty() }?.let { SlashCommandGroup(source, it) }
        }
    }

    /** The composer text after picking [command]. */
    fun completion(command: SlashCommand): String = "/${command.name} "
}
