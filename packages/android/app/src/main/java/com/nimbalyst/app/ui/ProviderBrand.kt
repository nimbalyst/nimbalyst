package com.nimbalyst.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.R
import java.util.Locale

private val openAiModelPattern = Regex("""\bo[134]\b""")

internal enum class ProviderFamily {
    OpenAI,
    Anthropic,
    Other
}

internal fun resolveProviderFamily(provider: String?, model: String?): ProviderFamily {
    val value = "${provider.orEmpty()} ${model.orEmpty()}".lowercase(Locale.US)
    return when {
        value.contains("openai") ||
            value.contains("codex") ||
            value.contains("gpt") ||
            openAiModelPattern.containsMatchIn(value) -> ProviderFamily.OpenAI
        value.contains("anthropic") ||
            value.contains("claude") -> ProviderFamily.Anthropic
        else -> ProviderFamily.Other
    }
}

internal fun providerFamilyLabel(provider: String?, model: String?): String {
    return when (resolveProviderFamily(provider, model)) {
        ProviderFamily.OpenAI -> "OpenAI"
        ProviderFamily.Anthropic -> "Anthropic"
        ProviderFamily.Other -> provider?.takeIf { it.isNotBlank() }?.toReadableProviderName() ?: "AI"
    }
}

internal fun modelLabel(model: String?): String? =
    model?.takeIf { it.isNotBlank() }?.replace('_', '-')

internal fun providerModelLabel(provider: String?, model: String?): String {
    val providerLabel = providerFamilyLabel(provider, model)
    val modelName = modelLabel(model)
    return if (modelName.isNullOrBlank()) providerLabel else "$providerLabel - $modelName"
}

private fun String.toReadableProviderName(): String =
    split('-', '_', ' ')
        .filter { it.isNotBlank() }
        .joinToString(" ") { word ->
            word.replaceFirstChar {
                if (it.isLowerCase()) it.titlecase(Locale.US) else it.toString()
            }
        }

@Composable
internal fun providerAccentColor(provider: String?, model: String?): Color {
    return when (resolveProviderFamily(provider, model)) {
        ProviderFamily.OpenAI -> Color(0xFF35D399)
        ProviderFamily.Anthropic -> Color(0xFFD8A46A)
        ProviderFamily.Other -> MaterialTheme.colorScheme.primary
    }
}

@Composable
internal fun ProviderLogo(
    provider: String?,
    model: String?,
    modifier: Modifier = Modifier,
    size: Dp = 42.dp
) {
    val family = resolveProviderFamily(provider, model)
    val accent = providerAccentColor(provider, model)
    val shape = RoundedCornerShape(size / 3)

    Surface(
        modifier = modifier.size(size),
        shape = shape,
        color = accent.copy(alpha = 0.16f),
        contentColor = accent
    ) {
        Box(contentAlignment = Alignment.Center) {
            when (family) {
                ProviderFamily.OpenAI -> Icon(
                    painter = painterResource(R.drawable.ic_provider_openai),
                    contentDescription = "OpenAI",
                    modifier = Modifier.size(size * 0.58f),
                    tint = accent
                )
                ProviderFamily.Anthropic -> Icon(
                    painter = painterResource(R.drawable.ic_provider_anthropic),
                    contentDescription = "Anthropic",
                    modifier = Modifier.size(size * 0.58f),
                    tint = accent
                )
                ProviderFamily.Other -> Icon(
                    imageVector = Icons.Default.SmartToy,
                    contentDescription = providerFamilyLabel(provider, model),
                    modifier = Modifier.size(size * 0.54f),
                    tint = accent
                )
            }
        }
    }
}
