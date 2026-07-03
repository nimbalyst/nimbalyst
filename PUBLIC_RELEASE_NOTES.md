# July 2 Release

This release fixes a packaging regression that dropped built-in extensions (including the new project memory system) from released builds, and delivers a round of voice mode and agent-session fixes.

**About project memory:** the Nimbalyst Memory extension is opt-in — enable it from the Extensions page. It requires an OpenAI API key (configured in Settings) for generating embeddings.

### Improvements

- The iOS voice agent now runs the same realtime model and session configuration as desktop, with automatic fallback when the model is unavailable.
- Built-in extensions no longer show the native-code consent prompt; it now only appears for third-party extensions.

### Fixed

- Built-in extensions are once again included in packaged builds; a dependency regression had silently dropped them from released apps.
- The memory extension now starts in packaged builds instead of failing to load its bundled dependencies.
- Agent sessions that launch background tasks now wake and continue when those tasks finish, instead of the task being cancelled at the end of the turn.
- Voice mode no longer interrupts itself from echo of its own speech on open speakers (desktop and iOS).
- The voice selected in iOS Settings (or synced from desktop) is now actually used by the voice agent.
- Agent calls to deferred background tools no longer fail with schema validation errors.
