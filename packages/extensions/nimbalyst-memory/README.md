# Nimbalyst Memory

A local **project brain** for your AI agents: it indexes your project's markdown (design docs, plans, `CLAUDE.md`, trackers, voice-memory) into a rebuildable shadow index and serves fast hybrid retrieval + durable facts over MCP — so an agent can be *grounded* in how your project actually works in well under a second.

This extension is the flagship consumer of the voice-agent grounding work. See the design of record: `nimbalyst-local/plans/voice-agent-grounding-system.md`.

## Structure

```
nimbalyst-memory/
  manifest.json     extension manifest, including the first-class Project settings route
  src/index.tsx     voice grounding bridge, AI tools, and Project settings route export
  engine/           the host-agnostic MCP engine (see engine/README.md) — ZERO app imports
```

The **engine** is intentionally decoupled: it has no knowledge of voice, trackers, or Nimbalyst settings. That boundary is the extraction seam — the engine can later be published as a standalone, MCP-first "project brain" for any coding repo. The Nimbalyst-facing shell runs the engine as a backend module, registers its tools with coding and voice agents, injects grounding at voice-session start, and exposes the live Memory surface under Project settings.

## Phase status

- **Phase 1 — Engine MCP server** ✅ — indexer, hybrid retrieval, pluggable embedders, markdown facts, MCP tools, `serve` launcher. Usable today by Nimbalyst's coding agent and any MCP agent. See [`engine/README.md`](./engine/README.md).
- **Phase 2 — Core voice-agent tool hooks** ✅ — general capability for extensions to expose voice-agent tools and session context.
- **Phase 3 — Voice bridge + settings** ✅ — engine tools are registered with coding and voice agents, live facts are injected at session start, and the Memory UI is a first-class Project settings route.
- **Phases 4–5** — brainstorm-loop helpers; optional auto-distillation / ANN. *Not started.*

The next scoped-memory, review-queue, nightly-distillation, and team-sync work is tracked in `nimbalyst-local/plans/memory-v2-personal-team-and-nightly-distillation.md`.

## Development

```sh
cd engine
npm run build       # tsc → dist/ (produces dist/serve.js)
npm run typecheck
```

Engine tests run under the repo's root vitest (`packages/extensions/nimbalyst-memory/engine/src/__tests__`).
