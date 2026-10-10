package com.nimbalyst.app.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Platform type scale (Roboto) with roles mapped onto the iOS text hierarchy:
 *
 * | Material role   | iOS equivalent | Typical use                      |
 * |-----------------|----------------|----------------------------------|
 * | headlineMedium  | .title bold    | Pairing / Sign In screen titles  |
 * | headlineSmall   | .title2        | Branding header                  |
 * | titleLarge      | .title3        | Top bar titles                   |
 * | titleMedium     | .headline      | Row titles, button labels        |
 * | titleSmall      | .subheadline   | Section headers                  |
 * | bodyLarge       | .body          | Primary copy                     |
 * | bodyMedium      | .callout       | Secondary copy, errors           |
 * | bodySmall       | .footnote      | Row subtitles                    |
 * | labelMedium     | .caption       | Metadata                         |
 * | labelSmall      | .caption2      | Badges, timestamps               |
 */
val NimbalystTypography = Typography(
    headlineMedium = TextStyle(fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.Bold),
    headlineSmall = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold),
    titleLarge = TextStyle(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.5.sp),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight.Medium)
)
