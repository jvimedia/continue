import SwiftUI

/// Color palette mirroring Continue's dark/blue VS Code theme
/// (see `gui/src/styles/theme.ts` in the main repo), adapted for iOS with a
/// light-mode fallback since VS Code themes can be light too.
enum ContinueTheme {
    // MARK: Background / foreground

    static func background(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0x1e1e1e) : Color(hex: 0xffffff)
    }

    static func foreground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0xe6e6e6) : Color(hex: 0x1e1e1e)
    }

    static func secondaryForeground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0xb3b3b3) : Color(hex: 0x5a5a5a)
    }

    // MARK: Surfaces

    static func border(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0x2a2a2a) : Color(hex: 0xd8d8d8)
    }

    static func inputBackground(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0x2d2d2d) : Color(hex: 0xf2f2f2)
    }

    static func inputPlaceholder(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0x9e9e9e) : Color(hex: 0x8a8a8a)
    }

    // MARK: Accent / primary

    static let primary = Color(hex: 0x2c5aa0)
    static let primaryHover = Color(hex: 0x3a6db3)
    static let primaryForeground = Color.white

    static let success = Color(hex: 0x4caf50)
    static let warning = Color(hex: 0xffb74d)
    static let error = Color(hex: 0xf44336)
    static let link = Color(hex: 0x5c9ce6)
}

extension Color {
    init(hex: UInt32, alpha: Double = 1.0) {
        let red = Double((hex & 0xFF0000) >> 16) / 255.0
        let green = Double((hex & 0x00FF00) >> 8) / 255.0
        let blue = Double(hex & 0x0000FF) / 255.0
        self.init(.sRGB, red: red, green: green, blue: blue, opacity: alpha)
    }
}
