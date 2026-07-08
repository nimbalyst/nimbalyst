# Nimbalyst Memory

A local **project brain** for your AI agents: it indexes your project's markdown (design docs, plans, `CLAUDE.md`, trackers, voice-memory) into a rebuildable shadow index and serves fast hybrid retrieval + durable facts over MCP — so an agent can be *grounded* in how your project actually works in well under a second.

This extension is the flagship consumer of the voice-agent grounding work. See the design of record: `nimbalyst-local/plans/voice-agent-grounding-system.md`.

## Structure

```
nimbalyst-memory/
  manifest.json     extension manifest (disabled until the Nimbalyst-facing half lands)
  src/index.ts      inert in Phase 1 — voice bridge + settings panel land in Phases 2–3
  engine/           the host-agnostic MCP engine (see engine/README.md) — ZERO app imports
```

The **engine** is the heart of Phase 1 and is intentionally decoupled: it has no knowledge of voice, trackers, or Nimbalyst settings. That boundary is the extraction seam — the engine can later be published as a standalone, MCP-first "project brain" for any coding repo. The Nimbalyst-facing half of this extension (spawn/connect the engine over MCP, register its tools to the voice agent, inject top-N facts at session start, feed the tracker source class, settings UI) is added in later phases.

## Phase status

- **Phase 1 — Engine MCP server** ✅ — indexer, hybrid retrieval, pluggable embedders, markdown facts, MCP tools, `serve` launcher. Usable today by Nimbalyst's coding agent and any MCP agent. See [`engine/README.md`](./engine/README.md).
- **Phase 2 — Core voice-agent tool hooks** — general capability for any extension to expose voice-agent tools + session context. *Not started.*
- **Phase 3 — Voice bridge + settings** — register engine tools to the voice agent, inject facts at session start, settings panel. *Not started.*
- **Phases 4–5** — brainstorm-loop helpers; optional auto-distillation / ANN. *Not started.*

## Development

```sh
cd engine
npm run build       # tsc → dist/ (produces dist/serve.js)
npm run typecheck
```

Engine tests run under the repo's root vitest (`packages/extensions/nimbalyst-memory/engine/src/__tests__`).
