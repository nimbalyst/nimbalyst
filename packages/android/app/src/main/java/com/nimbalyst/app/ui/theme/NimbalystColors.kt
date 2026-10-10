package com.nimbalyst.app.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Color constants matching the Nimbalyst dark theme. Mirrors the iOS
 * `NimbalystColors` (packages/ios/NimbalystNative/Sources/Utils/NimbalystColors.swift),
 * which in turn mirrors `darkThemeColors` in packages/runtime/src/editor/themes/registry.ts.
 * Keep all three in sync so the native chrome matches the transcript's `--nim-*` palette.
 */
object NimbalystColors {
    // Backgrounds
    val background = Color(0xFF2D2D2D)
    val backgroundSecondary = Color(0xFF1A1A1A)
    val backgroundTertiary = Color(0xFF3A3A3A)
    val backgroundActive = Color(0xFF4A4A4A)

    // Text
    val text = Color(0xFFFFFFFF)
    val textMuted = Color(0xFFB3B3B3)
    val textFaint = Color(0xFF808080)
    val textDisabled = Color(0xFF666666)

    // Borders
    val border = Color(0xFF4A4A4A)

    // Accents
    val primary = Color(0xFF60A5FA)
    val success = Color(0xFF4ADE80)
    val warning = Color(0xFFFBBF24)
    val error = Color(0xFFEF4444)
    val purple = Color(0xFFA78BFA)

    // Code
    val codeBackground = Color(0xFF1E1E1E)
    val codeText = Color(0xFFD4D4D4)
}
