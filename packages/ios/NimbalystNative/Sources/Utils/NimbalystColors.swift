import SwiftUI

/// Color constants matching the Nimbalyst dark theme.
/// Source: packages/runtime/src/editor/themes/registry.ts -> darkThemeColors
public enum NimbalystColors {
    // MARK: - Backgrounds
    public static let background = Color(hex: 0x2D2D2D)
    public static let backgroundSecondary = Color(hex: 0x1A1A1A)
    public static let backgroundTertiary = Color(hex: 0x3A3A3A)
    public static let backgroundActive = Color(hex: 0x4A4A4A)

    // MARK: - Text
    public static let text = Color.white
    public static let textMuted = Color(hex: 0xB3B3B3)
    public static let textFaint = Color(hex: 0x808080)
    public static let textDisabled = Color(hex: 0x666666)

    // MARK: - Borders
    public static let border = Color(hex: 0x4A4A4A)

    // MARK: - Accent colors
    public static let primary = Color(hex: 0x60A5FA)     // Blue
    public static let success = Color(hex: 0x4ADE80)     // Green
    public static let warning = Color(hex: 0xFBBF24)     // Yellow
    public static let error = Color(hex: 0xEF4444)       // Red
    public static let purple = Color(hex: 0xA78BFA)      // Purple

    // MARK: - Code
    public static let codeBackground = Color(hex: 0x1E1E1E)
    public static let codeText = Color(hex: 0xD4D4D4)
}

public extension Color {
    init(hex: UInt, opacity: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: opacity
        )
    }
}
