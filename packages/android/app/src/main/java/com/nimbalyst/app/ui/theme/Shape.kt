package com.nimbalyst.app.ui.theme

import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/** Corner radii matching the iOS app. */
object NimbalystShapes {
    /** Prompt composer field (iOS ComposeBar). */
    val composer = RoundedCornerShape(20.dp)
    /** Primary and secondary buttons (iOS LoginView). */
    val button = RoundedCornerShape(12.dp)
    /** List cards and grouped rows (iOS insetGrouped). */
    val card = RoundedCornerShape(10.dp)
    /** Inline banners such as the auth error row. */
    val banner = RoundedCornerShape(8.dp)
    /** Phase / provider badges and tag pills. */
    val capsule = CircleShape
}

val NimbalystMaterialShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(10.dp),
    large = RoundedCornerShape(12.dp),
    extraLarge = RoundedCornerShape(20.dp)
)
