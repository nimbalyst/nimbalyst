# Nimbalyst screen inventory

Initial inventory organized by application navigation. Existing implementation entry points and historical staged captures provide a starting point; this is not a verified complete catalog.

## Application navigation

- [Files](files.md)
- [Agent](agent.md)
- [Tracker](tracker.md)
- [GitHub](github.md)
- [Shared Docs](shared-docs.md)
- [Organization](organization.md)
- [Settings](settings.md)
- [iOS](ios.md) — separate platform branch

## Record conventions

Stable `key` identifies a screen; `parent` describes navigation containment. A focused view may show its surrounding app context. States and journey transitions are separate from this hierarchy. Records deliberately omit trackerStatus until the separate screens tracker is configured.

The local pilot board embeds historical marketing images for easy previewing. Canonical captures will use Git LFS under this directory after capture ingestion is configured. No original capture timestamp or commit is inferred from filesystem dates. Fresh captures must include sanitized fixtures, viewport, theme, timestamp, and source revision.

Coverage gaps are explicit. Next priorities are current Tracker, GitHub, Shared Docs, Organization, Project Canvas, and one iOS screen, followed by empty/error/loading and permission-dependent states.
