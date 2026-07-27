# Pull Request: Inline code completion for SQL, Python, and Markdown files

> Full PR body for GitHub. Paste into the PR description field when opening.
> Associated GitHub issue: #535.

## Summary

Adds inline autocompletion that fires automatically while a user is typing in `.sql`, `.py`, and `.md` files in Nimbalyst. Completions are scoped per language, draw from in-file identifiers and project/schema context where available, and close the gap with modern IDE baselines (JetBrains, VS Code, Copilot inline suggestions) that Nimbalyst currently lacks.

This PR delivers the language-specific behavior described in issue #535:

- **SQL** — keywords (`SELECT`, `FROM`, `WHERE`, `JOIN`, `GROUP BY`, `ORDER BY`, etc.), table names from the project's SQL files, and column names informed by table context (`SELECT * FROM users` → `id`, `email`, `created_at`, …).
- **Python** — built-in keywords and standard-library identifiers (e.g. `os`, `json`, `pathlib`, `re`), plus in-file variable, function, and class names collected by a lightweight identifier scanner.
- **Markdown** — heading structures (`#`, `##`, `###`), link syntax (`[text](url)`), and code-fence blocks (```` ``` ```` / ```` ```python ````), exposed as snippets that expand with correct placeholder ordering.

## Related issue

Closes #535

## Problem

When writing SQL scripts, Python code, or Markdown files in Nimbalyst, users today must type every token manually with no autocompletion support. This:

- Slows down writing, especially for repetitive SQL queries and long Python imports.
- Increases typo risk for table and column names in SQL queries that may not fail until runtime or commit time.
- Forces Nimbalyst users to fall back on memory or copy/paste for boilerplate Markdown structures.

The feature request — opened by `@xushang0145-jpg` on Jun 2 — calls out that standard IDE-level autocomplete (as seen in JetBrains, VS Code, Copilot inline suggestions) is the expected baseline and is currently absent for all three languages.

## Proposed solution

Wire up language-aware completion providers in the Monaco-backed editor extension. Each language gets its own provider registered on file open; completions trigger on standard typing and on `Ctrl+Space`, matching Monaco's default inline UX.

### SQL completions (`.sql`)

- **Keywords**: built-in completion list for common SQL reserved words (`SELECT`, `FROM`, `WHERE`, `JOIN`, `LEFT JOIN`, `INNER JOIN`, `GROUP BY`, `ORDER BY`, `LIMIT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, `ALTER TABLE`, etc.), with optional `snippets` for multi-line forms.
- **Table names**: parsed from any `.sql` files in the workspace; refreshed incrementally as files change. Identifier rules follow the project's `NAMING_CONVENTIONS.md` conventions for SQL identifiers (`snake_case`).
- **Column names**: after the user types `SELECT * FROM <table>` (or begins a column list), surface that table's known columns from either the in-workspace table definitions or, when a project schema is configured, the schema metadata source.

### Python completions (`.py`)

- **Language + stdlib keywords**: built-in identifiers (`def`, `class`, `return`, `yield`, `if`, `else`, `try`, `except`, …) plus a curated stdlib module/`function` list for common usage (`os.path.join`, `json.dumps`, `Path(...).read_text()`, `re.match`, etc.).
- **In-file identifiers**: a lightweight tokenizer collects names from assignments, function parameters, `def` headers, `class` headers, and imports in the current document. Completions update as the file is edited. No project-wide AST index is required for this PR.

### Markdown completions (`.md`)

- **Headings**: snippet for `# `, `## `, `### ` with placeholder for the heading text.
- **Links**: snippet for `[text](url)` whose first placeholder is the link text and second is the URL.
- **Code fences**: snippet that opens a triple-backtick block, inserts a cursor position, and closes the fence. Backtick fences inside ```` ``` ```` are not auto-completed; the snippet is the only auto-fence expansion.

## Alternatives considered

- **Do nothing (current state)**: requires users to hand-type all tokens; no workaround exists today.
- **Bring in a full LSP backend (e.g. pylsp, sqls, marksman)**: rejected for this PR — heavier dependency surface, separate processes per language, and out of step with the current extension architecture that targets Monaco's native `registerCompletionItemProvider` API. Can be revisited later as a follow-up if completion quality from static providers proves insufficient.
- **AI-only inline suggestions (Copilot-style)**: rejected because the issue specifies deterministic language-aware completions for tables/columns/keywords, which deterministic providers solve more reliably and at lower latency. AI completion remains a separate, additive feature.

The chosen approach — Monaco-native provider registration per language — matches the existing extension architecture (see `docs/EXTENSION_ARCHITECTURE.md`) and minimizes new dependency surface area.

## User experience

- Autocomplete popup appears while typing, identical to Monaco's default behavior; no special keybind required.
- `Ctrl+Space` (the Monaco default) still triggers explicit completion on demand.
- Provider order: precise in-file identifiers first, then language keywords, then snippets — matching VS Code/JetBrains defaults.
- No visible change to other file types; completions are scoped to the three languages in scope.

## Testing

- New unit tests cover the SQL keyword provider, the SQL table/column scanner (using fixture `.sql` files), the Python identifier scanner (tokenizing sample `.py` files), and the Markdown snippet expansion (verifying placeholder ordering).
- New unit test confirms completion is gated on language — `.txt` and `.json` files must not surface completions from this provider.
- New E2E spec drives the Monaco editor in `.sql` / `.py` / `.md` files, types a partial token, asserts the popup appears and accepts a completion.
- Manual sanity: open the dev Electron app, open a `.sql` file with ≥1 `CREATE TABLE` statement, type `SELECT * FROM ` to verify column suggestions populate.
- Repo gates (per `CLAUDE.md`):
  - `npm run typecheck`
  - `npm run test:prepush` (the local pre-push hook runs this automatically)

## Implementation sketch

- New file: `packages/runtime/src/editor/completions/sqlCompletionProvider.ts` — keyword list + in-workspace scanner + snippet wiring.
- New file: `packages/runtime/src/editor/completions/pythonCompletionProvider.ts` — keyword/stdlib list + in-file identifier tokenizer.
- New file: `packages/runtime/src/editor/completions/markdownCompletionProvider.ts` — snippet-only provider for headings, links, and code fences.
- New file: `packages/runtime/src/editor/completions/registerCompletions.ts` — wire-up entry imported by the Monaco-backed editor extension; registers each provider under its language id (`sql`, `python`, `markdown`).
- Tests co-located under `packages/runtime/src/editor/completions/__tests__/`.

## Out of scope / follow-ups

- Project-wide AST indexing for Python (only in-file identifier scanning ships in this PR).
- LSP-based backends for any of the three languages (would replace or wrap the static providers).
- AI-powered inline suggestions (separate, additive feature track).
- Schema introspection for `.sql` against a live database connection — this PR is filesystem-scoped only.

## Notes for reviewers

- The completion surface is intentionally narrow and deterministic; please flag any place where a snippet would help users more than a plain token completion.
- SQL identifier scanning uses `snake_case` (per `NAMING_CONVENTIONS.md`); if the project adopts `camelCase` SQL elsewhere, the scanner needs the same update.
- For Markdown, snippets are used (not token completions) because the multi-line forms don't fit cleanly into `insertText`.
- The user-facing settings panel does not need changes — completions are on by default and consistent with how Monaco users expect the editor to behave.
- Per `CLAUDE.md`, this PR ships with a one-line `[Unreleased]` entry in `CHANGELOG.md` once the branch lands, not in this description.

## Additional context (from issue #535)

- **App version**: 0.63.9
- **OS**: macOS 26.3 (darwin arm64)
- **Filed by**: `@xushang0145-jpg`
- **Filed on**: Jun 2
