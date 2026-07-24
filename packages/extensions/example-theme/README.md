# Example Theme Extension

A manifest-only example theme extension. This package exists as a fixture / smoke test for the `contributions.themes` wiring.

It contributes a single dark theme called **Midnight Orchid** and ships **no JavaScript** -- the entire extension is a single `manifest.json`. There is no `package.json`, no build step, no `dist/` directory.

When this extension is enabled (via Settings > Extensions, or by setting `defaultEnabled: true` in the manifest), the theme appears in **Settings > Themes** under **Extension Themes** as `com.nimbalyst.example-theme:midnight-orchid` and can be applied like any other theme.

When the extension is disabled or uninstalled while its theme is active, the runtime falls back to the built-in `dark` theme and surfaces an inline banner in the Themes panel.

See [docs/EXTENSION_THEMING.md](../../../docs/EXTENSION_THEMING.md) for the full theming contract.
