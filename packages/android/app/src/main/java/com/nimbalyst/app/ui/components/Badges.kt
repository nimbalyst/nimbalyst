package com.nimbalyst.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.R
import com.nimbalyst.app.ui.theme.NimbalystColors
import com.nimbalyst.app.ui.theme.NimbalystShapes

/** Capsule label tinted with [color] at 15% fill, the shared iOS badge look. */
@Composable
private fun CapsuleBadge(
    text: String,
    color: Color,
    modifier: Modifier = Modifier,
    horizontalPadding: Int = 6,
    verticalPadding: Int = 2
) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = color,
        maxLines = 1,
        modifier = modifier
            .clip(NimbalystShapes.capsule)
            .background(color.copy(alpha = 0.15f))
            .padding(horizontal = horizontalPadding.dp, vertical = verticalPadding.dp)
    )
}

/** Session kanban phase ("backlog", "planning", ...). Unknown phases render capitalized in gray. */
@Composable
fun PhaseBadge(phase: String, modifier: Modifier = Modifier) {
    val label = when (phase) {
        "backlog" -> stringResource(R.string.phase_backlog)
        "planning" -> stringResource(R.string.phase_planning)
        "implementing" -> stringResource(R.string.phase_implementing)
        "validating" -> stringResource(R.string.phase_validating)
        "complete" -> stringResource(R.string.phase_complete)
        else -> phase.replaceFirstChar { it.uppercase() }
    }
    CapsuleBadge(label, phaseColor(phase), modifier, horizontalPadding = 5, verticalPadding = 1)
}

/** Provider + short model label ("Opus 4.7"). Renders nothing for an unknown provider. */
@Composable
fun ProviderBadge(provider: String?, model: String?, modifier: Modifier = Modifier) {
    val label = ModelLabel.shortLabel(provider, model) ?: return
    CapsuleBadge(label, providerColor(provider), modifier)
}

/** Tabular figures, the Compose equivalent of SwiftUI's .monospacedDigit(). */
private const val TabularNumbers = "tnum"

private fun contextUsageColor(percent: Int, normal: Color): Color =
    when (ContextUsageLevel.forPercent(percent)) {
        ContextUsageLevel.CRITICAL -> NimbalystColors.error
        ContextUsageLevel.WARNING -> NimbalystColors.warning
        ContextUsageLevel.NORMAL -> normal
    }

/** Compact "42%" indicator for list rows. */
@Composable
fun ContextUsageBadge(percent: Int, modifier: Modifier = Modifier) {
    Text(
        text = stringResource(R.string.context_usage_percent, percent),
        style = MaterialTheme.typography.labelSmall.copy(fontFeatureSettings = TabularNumbers),
        color = contextUsageColor(percent, NimbalystColors.textFaint),
        modifier = modifier
    )
}

/** 48dp bar plus "Context 42%" label, for the session detail status bar. */
@Composable
fun ContextUsageBar(percent: Int, modifier: Modifier = Modifier) {
    val color = contextUsageColor(percent, NimbalystColors.textMuted)
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Box(
            modifier = Modifier
                .size(width = 48.dp, height = 4.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(NimbalystColors.backgroundTertiary)
        ) {
            Box(
                modifier = Modifier
                    .fillMaxHeight()
                    .fillMaxWidth(contextUsageFraction(percent))
                    .background(color)
            )
        }
        Text(
            text = stringResource(R.string.context_usage_label, percent),
            style = MaterialTheme.typography.labelSmall.copy(fontFeatureSettings = TabularNumbers),
            color = color
        )
    }
}
