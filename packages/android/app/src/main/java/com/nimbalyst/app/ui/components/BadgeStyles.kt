package com.nimbalyst.app.ui.components

import androidx.compose.ui.graphics.Color
import com.nimbalyst.app.ui.theme.NimbalystColors

/** Context-window pressure. Thresholds match iOS ContextUsageBadge/ContextUsageBar. */
enum class ContextUsageLevel {
    NORMAL, WARNING, CRITICAL;

    companion object {
        const val WARNING_PERCENT = 70
        const val CRITICAL_PERCENT = 90

        fun forPercent(percent: Int): ContextUsageLevel = when {
            percent >= CRITICAL_PERCENT -> CRITICAL
            percent >= WARNING_PERCENT -> WARNING
            else -> NORMAL
        }
    }
}

/** Fill fraction for the usage bar, clamped so bad data can't overdraw. */
fun contextUsageFraction(percent: Int): Float = percent.coerceIn(0, 100) / 100f

/** Kanban phase colors, identical to iOS PhaseBadge. */
internal fun phaseColor(phase: String): Color = when (phase) {
    "backlog" -> Color(0xFF6B7280)
    "planning" -> Color(0xFF60A5FA)
    "implementing" -> Color(0xFFEAB308)
    "validating" -> Color(0xFFA78BFA)
    "complete" -> Color(0xFF4ADE80)
    else -> NimbalystColors.textFaint
}

/** Provider accent, matching iOS ProviderBadge. */
internal fun providerColor(provider: String?): Color = when (provider?.lowercase()) {
    "claude-code", "claude" -> NimbalystColors.primary
    "openai" -> IosSystemColors.green
    "lm-studio" -> IosSystemColors.purple
    else -> IosSystemColors.gray
}

/** iOS dark-mode system colors that the iOS badges use directly (.green, .orange, .gray, .purple). */
internal object IosSystemColors {
    val green = Color(0xFF30D158)
    val orange = Color(0xFFFF9F0A)
    val gray = Color(0xFF8E8E93)
    val purple = Color(0xFFBF5AF2)
}
