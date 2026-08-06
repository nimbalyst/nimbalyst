## Token Discipline

This repo runs a very high volume of AI sessions (often 18+/day, much of it automated). Keep each
session's context lean so the harness stays cheap and fast. Token/context usage is an active product
concern here — practice it in the harness too.

Key points:

- **Fan out wide reads to a subagent.** When answering means grepping/reading many files, use the
  `Explore` (or `general-purpose`) agent and keep only its conclusion — don't pull 20+ files into the
  main context. A single targeted `Read` beats a wide grep when you already know the file.
- **Don't re-derive what a prior session already produced.** Use `get_session_summary` /
  `get_workstream_overview` instead of re-reading files a sibling session already covered.
- **Prefer deferred MCP tools.** Load tool schemas on demand via `ToolSearch`; don't force every MCP
  schema into context up front.
- **Reuse existing artifacts before spawning a new session.** Check `automations_list` for an existing
  automation, and the `github-pr` tracker for an existing review session, before creating a duplicate.
- **Keep the memory index lean.** Move shipped/complete project memories to `MEMORY-archive.md` (recall
  still finds them) rather than leaving them in the always-loaded `MEMORY.md`.
- **Match effort to the task.** Don't write a long `/design` plan for a one-line fix, and don't re-read
  or re-run the same command across turns when earlier output already answered it.
- **Tests are context every later session pays for.** The test corpus is ~2M tokens — 10x a context
  window — and a component's test file gets read alongside the component forever. You write it once and
  charge every future session. Extend an existing file rather than adding another one, and don't write a
  test for something a human would spot on screen in one second. See the testing rule in
  [CLAUDE.md](../../CLAUDE.md).
