# Codex app-server protocol schemas (v2)

These JSON schemas describe the JSON-RPC v2 protocol spoken by `codex app-server --listen stdio://` for the codex version we currently bundle (`0.130.0`).

Generated with:

```
codex app-server generate-json-schema --out design/agents/codex-app-server-schemas
```

Re-generate whenever we upgrade the codex SDK / binary. Compare the diff to spot protocol changes that may break our `CodexAppServerProtocol` implementation.

The aggregate schema is `codex_app_server_protocol.v2.schemas.json`. Individual per-message schemas are in `v2/`.

## Why this lives in the repo

The exec-mode SDK we have used historically does not exercise this protocol surface, so it is easy to miss breaking changes during version bumps. Having a frozen reference in the repo gives us a stable baseline for code review and migration verification.
