# CSV Spreadsheet Extension

A Nimbalyst extension that provides a Google Sheets-like editing experience for CSV files, with formula support and AI integration.

## Current Status

Shipped as marketplace extension v1.0.2. The todo list below was re-audited against the source on 2026-08-04; items that had shipped since it was first written have been moved into "What Works Now."

### What Works Now

**Editing**

- Open and edit CSV/TSV files in a spreadsheet interface (RevoGrid)
- Inline cell editing; add/delete rows and columns
- Sort columns ascending/descending
- Undo/redo with a dedicated history stack (`plugins/UndoRedoPlugin.ts`, Cmd+Z / Cmd+Shift+Z)
- Copy/cut/paste and clear across cell ranges (Cmd+C/X/V, Delete)
- Rectangular range selection, Cmd+A select-all, row/column header selection; drag-selection crosses the frozen-column and pinned-row boundaries as one unbroken rectangle, and autoscrolls when dragged past the viewport edge (`selection/`)
- Right-click context menu (cut/copy/paste/clear, insert/delete row/column)
- Source mode toggle for editing raw CSV text

**Formatting and layout**

- Column types with formatting: text, number, currency (USD/EUR/GBP/JPY/CNY), percentage, date (4 formats), with decimal places and thousands separator (`ColumnFormatDialog.tsx`)
- Header row designation, frozen columns, persisted column widths
- Metadata persisted either inline as a CSV comment or in a sidecar `.csvmeta` file (workspace setting `metadataStorage`)
- Theme integration (light/dark/crystal-dark)

**Formulas**

- Formula bar showing the raw formula for the selected cell
- Formula evaluation via formula.js for 27 mapped functions
- Cell references (A1, B2) and ranges (A1:B10), case-insensitive
- Error display (#VALUE!, #NAME?, #REF!, #ERROR!)

**Integration**

- Collaborative editing with presence/awareness (selected cell, editing cell)
- Diff mode for reviewing AI edits, with revert
- Selection published to AI chat as a "+ context" range chip
- Transcript embed support
- Dirty state tracking, save integration, external file change detection and reload

## Tech Stack

| Component | Library | License |
| --- | --- | --- |
| Grid UI | [RevoGrid](https://github.com/revolist/revogrid) | MIT |
| Formula Engine | [formula.js](https://github.com/formulajs/formulajs) | MIT |
| CSV Parsing | [Papa Parse](https://github.com/mholt/PapaParse) | MIT |
| Undo History | [use-undoable](https://github.com/black7375/use-undoable) | MIT |
| Diff | [diff](https://github.com/kpdecker/jsdiff) | BSD-3-Clause |

## Supported Formulas

**Math**: SUM, AVERAGE, MIN, MAX, COUNT, ROUND, ABS, SQRT, POWER
**Logic**: IF, AND, OR, NOT
**Text**: CONCAT, CONCATENATE, LEFT, RIGHT, MID, LEN, UPPER, LOWER, TRIM
**Statistical**: COUNTA, COUNTBLANK, MEDIAN, STDEV, VAR

---

## Missing Features

Re-audited 2026-08-04 against the extension source. Formula-engine findings are from a live probe of `evaluateFormula` / `recalculateFormulas`, not code reading.

### Formula engine — correctness gaps

These are the highest-value items: several produce a **silently wrong answer** rather than an error, which is worse than an unsupported feature.

- [ ] **Composed expressions** — `=SUM(A1:A3)*2` returns `#VALUE!`. The evaluator matches one top-level `FUNC(...)` covering the entire expression, or falls back to a digits-only arithmetic path; a function result cannot participate in arithmetic.
- [ ] **Nested functions** — `=IF(A1>0,SUM(B1:B3),0)` returns the literal string `"SUM([10,20,30])"` with no error. Arguments are never recursively evaluated.
- [ ] **Comparison operators** — `A1>0`, `A1=1`, `<>` are not evaluated; they reach formula.js as strings and are truthy, so conditionals silently take the wrong branch.
- [ ] **Absolute references** — `=SUM($A$1:$A$3)` returns `0`, no error. The reference regex does not accept `$`.
- [ ] **Text literals are uppercased** — the whole expression is `.toUpperCase()`'d before evaluation, so `=IF(A1=1,"yes","no")` yields `"YES"` and `=CONCAT("Hello ","World")` yields `"HELLO WORLD"`. Any text-producing formula corrupts its output.
- [ ] **Dependency ordering** — `recalculateFormulas` is a single row-order pass reading `cell.computed`, so a formula referencing another formula's result is one pass stale (a fresh `=C1` where `C1` is itself a formula computes `0` until the next recalculation). Needs a dependency graph with topological evaluation.
- [ ] **Indirect circular references** — only direct self-reference is caught. `C1 = C2` with `C2 = C1` silently evaluates to `0` instead of `#CIRC!`.
- [ ] **Function coverage** — only 27 of formula.js's 400+ functions are mapped, so VLOOKUP, SUMIF/COUNTIF, date functions, etc. return `#NAME?`. Consider exposing the library surface directly instead of a hand-maintained map.
- [ ] **Percent and currency literals** — `=50%` returns `#VALUE!`.

### Formula authoring UX

- [ ] **Formula result styling** — visually distinguish computed values from typed values
- [ ] **Formula autocomplete** — suggest function names and signatures while typing
- [ ] **Cell reference highlighting** — highlight referenced cells/ranges while editing a formula
- [ ] **Click-to-insert references** — click a cell while editing to insert its reference
- [ ] **Named ranges** — define names for ranges (e.g. `Sales` = A1:A100)
- [ ] **Fill handle / formula fill-down** — drag to copy a formula down a column with relative reference adjustment

### Formatting and visuals

- [ ] **Cell alignment** — left/center/right per cell or column (no alignment support exists today)
- [ ] **Text wrapping** — wrap long text within a cell
- [ ] **Row height / resize rows** — no row-height control exists
- [ ] **Conditional formatting** — color scales, data bars, value-based highlighting
- [ ] **Cell-level formatting** — bold/color/background on individual cells (formatting is column-scoped today)
- [ ] **Cell borders**
- [ ] **Alternating row colors** — zebra striping
- [ ] **Cell comments/notes** — hover notes on cells
- [ ] **Freeze rows** — frozen columns work; frozen header rows do not
- [ ] **Auto-fit column width** — double-click a column border to fit content
- [ ] **Hide/show columns**
- [ ] **Drag reorder rows/columns**

### Search and filter

The find/replace, filter-predicate, and row-mapping engines live under `src/filter/`. The find bar (Cmd+F, including replace-all scoped to a selection) and the column-header filter dropdown are both connected and shipped.

#### Row-index contract

Selections stay in logical sheet coordinates, while RevoGrid filtering hides physical `rgRow` indexes without removing source rows. Every range consumer must therefore map each visible row through the shared visible↔logical mapping and operate on the returned ordered logical-row list; it must never rebuild a contiguous logical range from the first and last row.

Copy and AI selection context collapse that ordered logical-row list into adjacent output rows. For example, visible rows backed by logical rows 2, 7, and 19 serialize as a three-row block with no blank padding, while clear and paste address those same visible rows and never the hidden rows between them.

A column header's rendered text is decorative — the column template appends a filter funnel glyph — so a header's column index always comes from `data-rgcol` through `resolveHeaderColumnIndex`, never from `textContent`.

Both derivations are snapshots: the hidden rows a filter derived, and the mapping built from them. Any mutation invalidates them, so every mutating grid operation and every whole-source load funnels through the editor's single invalidation path rather than refreshing at individual call sites.

Filter predicates are session-only view state. Reopening the file clears filters; filter state is not CSV metadata, `.csvmeta` content, collaboration state, or migration data.

- [ ] **Filter persistence** — decide whether an active filter is view-only or persisted in metadata

### AI integration

The entire Phase 3 of the original plan was never built. There is no `aiTools.ts` and no `aiTools` contribution in `manifest.json`; the AI can only see the spreadsheet through file reads and the selection context chip.

- [ ] **AI tool: analyze_data** — summary statistics, type detection, data quality issues
- [ ] **AI tool: add_column** — add a calculated column, optionally formula-backed
- [ ] **AI tool: filter_rows** — filter to rows matching natural-language criteria
- [ ] **AI tool: sort_data** — single and multi-column sort
- [ ] **AI tool: apply_formula** — apply a formula across a column or range
- [ ] **AI tool: transform_data** — clean, normalize, or reshape data
- [ ] **Cell update visibility** — flash/highlight cells as the AI edits them (diff mode covers review, not live edits)
- [ ] **Range-scoped tool calls** — let tools target the user's current selection

### Data validation

- [ ] **Dropdown lists** — restrict a cell or column to predefined options
- [ ] **Numeric ranges** — min/max constraints
- [ ] **Text patterns** — regex validation
- [ ] **Required cells** — mark cells that cannot be empty
- [ ] **Validation errors** — visual indicator for invalid cells

### Import/export

- [ ] **Export to Excel** — `.xlsx` output (needs an additional library)
- [ ] **Delimiter detection** — auto-detect comma vs. tab vs. semicolon on open (delimiter is currently derived from the file extension)
- [ ] **Semicolon and pipe delimiters** — the `getDelimiter` contract is `',' | '\t'` only
- [ ] **Import from clipboard** — paste tabular data from other apps into a new sheet

### Performance

- [ ] **Lazy formula evaluation** — recalculate only what changed rather than every formula cell on every edit
- [ ] **Debounced recalculation** — batch formula updates during rapid editing
- [ ] **Virtual scrolling tuning** — validate behavior on 100k+ row files

### Accessibility

- [ ] **Screen reader support** — ARIA labels for grid navigation
- [ ] **High contrast mode** — respect system high contrast settings
- [ ] **Keyboard-only operation** — audit full functionality without a mouse

---

## Architecture

```
packages/extensions/csv-spreadsheet/
  manifest.json
  package.json
  vite.config.ts
  src/
    index.tsx                    # Extension entry point
    types.ts                     # TypeScript type definitions
    selectionContext.ts          # Publishes the selected range to AI chat
    components/
      SpreadsheetEditor.tsx      # Main editor component
      SpreadsheetToolbar.tsx     # Toolbar buttons
      FormulaBar.tsx             # Formula input display
      ColumnFormatDialog.tsx     # Column type and format editor
      ContextMenu.tsx            # Right-click menu
      CollabPresenceOverlay.tsx  # Remote cursor/selection overlay
    hooks/
      useSpreadsheetMetadata.ts  # Headers, frozen columns, formats, widths
      useColumnFilters.ts        # Session-only column filter state
      useSpreadsheetFind.ts      # Find bar state and replace
    plugins/
      UndoRedoPlugin.ts          # Undo/redo history stack
    editors/
      SheetsTextEditor.ts        # Source mode (raw CSV) editor
    collab/
      csvBinding.ts              # Y.Doc binding
      presence.ts                # Awareness fields
      seed.ts                    # Initial doc seeding
      CsvCollabContentAdapter.ts # Shared-doc content adapter
    utils/
      csvParser.ts               # CSV parsing/serialization
      formulaEngine.ts           # Formula evaluation
      formatters.ts              # Column type formatting
      gridOperations.ts          # Clipboard, insert/delete, range ops
      diffCompute.ts             # Diff mode computation
```

## Development

```bash
# Build the extension
cd packages/extensions/csv-spreadsheet
npm run build

# Install into Nimbalyst (via Extension Dev Kit MCP)
# Or copy dist/ to extensions folder
```

### Probing the live grid from `renderer_eval`

Three things make a hand-written probe report "nothing is there" when the feature works. All three cost a session an hour on 2026-08-04.

- **Several `.spreadsheet-editor` nodes are mounted at once.** AI-tool file mounts leave zero-size editors behind holding unrelated CSVs, so `document.querySelector('.spreadsheet-editor')` usually returns the wrong one. Always pick with `getBoundingClientRect().width > 0`.
- **A hidden grid virtualizes to nothing.** A zero-size editor reports zero cells and zero selection overlays, so any measurement taken while the tab's mode is hidden is meaningless rather than negative. Check the width before believing a count of `0`.
- **Synthetic drags must match what the drag hook expects.** `handlePointerDown` is `async` (it awaits `getProviders()`), so the moves need a tick after `pointerdown`; and `handlePointerMove` returns early on `event.buttons === 0`, so every `pointermove` needs `buttons: 1`. Without both, the hook never arms and no `.selection-border-range` is ever painted.

Selection is also painted asynchronously, so allow a frame after `pointerup` before reading `data-csv-open-*` attributes or computed styles.

## References

- [RevoGrid Documentation](https://rv-grid.com/)
- [Formula.js Functions](https://formulajs.info/functions/)
- [Papa Parse Documentation](https://www.papaparse.com/docs)
- [nimbalyst-extension-system.md](./../design/Extensions/nimbalyst-extension-system.md)
