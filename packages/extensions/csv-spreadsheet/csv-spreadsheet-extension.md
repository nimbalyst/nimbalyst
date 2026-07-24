# CSV Spreadsheet Extension

A Nimbalyst extension that provides a Google Sheets-like editing experience for CSV files, with formula support and AI integration.

## Current Status

**Phase 1 (Core Editor)**: Complete
**Phase 2 (Formula Support)**: Complete
**Phase 3+**: In Progress

### What Works Now

- Open and edit CSV/TSV files in a spreadsheet interface
- Inline cell editing with RevoGrid
- Add/delete rows and columns
- Sort columns ascending/descending
- Formula bar showing raw formula for selected cell
- Formula evaluation with 25+ Excel-compatible functions
- Cell references (A1, B2) and ranges (A1:B10)
- Error display (#REF!, #VALUE!, #DIV/0!, etc.)
- Theme integration (light/dark/crystal-dark)
- Dirty state tracking and save integration
- External file change detection and reload

## Tech Stack

| Component | Library | License |
| --- | --- | --- |
| Grid UI | [RevoGrid](https://github.com/revolist/revogrid) | MIT |
| Formula Engine | [formula.js](https://github.com/formulajs/formulajs) | MIT |
| CSV Parsing | [Papa Parse](https://github.com/mholt/PapaParse) | MIT |
| State Management | [Zustand](https://github.com/pmndrs/zustand) | MIT |

## Supported Formulas

**Math**: SUM, AVERAGE, MIN, MAX, COUNT, ROUND, ABS, SQRT, POWER
**Logic**: IF, AND, OR, NOT
**Text**: CONCAT, CONCATENATE, LEFT, RIGHT, MID, LEN, UPPER, LOWER, TRIM
**Statistical**: COUNTA, COUNTBLANK, MEDIAN, STDEV, VAR

---

## Todo List

### Core Editing Features

- [ ] **Undo/Redo stack** - Track edit history for Cmd+Z/Cmd+Shift+Z support
- [ ] **Copy/paste** - Clipboard support for cells and ranges (Cmd+C/V/X)
- [ ] **Multi-cell selection** - Click and drag to select cell ranges
- [ ] **Keyboard navigation** - Arrow keys, Tab, Enter to move between cells
- [ ] **Context menus** - Right-click menu for cut/copy/paste, insert/delete row/col

### Selection & Navigation

- [ ] **Drag selection** - Click and drag to select rectangular cell ranges
- [ ] **Shift+click selection** - Extend selection from current cell to clicked cell
- [ ] **Select all** - Cmd+A to select entire spreadsheet
- [ ] **Select row/column** - Click row/column header to select entire row/column

### Row & Column Management

- [ ] **Header row designation** - Mark first row as headers (freeze + style differently)
- [ ] **Header column designation** - Mark first column as headers
- [ ] **Drag reorder rows** - Drag row headers to reorder
- [ ] **Drag reorder columns** - Drag column headers to reorder
- [ ] **Resize columns** - Drag column borders to resize (partially working via RevoGrid)
- [ ] **Resize rows** - Drag row borders to resize row height
- [ ] **Auto-fit column width** - Double-click column border to fit content
- [ ] **Hide/show columns** - Temporarily hide columns from view

### Formula Improvements

- [ ] **Formula result styling** - Visually distinguish computed values from raw text (italic, color)
- [ ] **Formula autocomplete** - Suggest functions as user types
- [ ] **Cell reference highlighting** - Highlight referenced cells when editing formula
- [ ] **Circular reference detection** - Detect and display #CIRC! error for circular refs
- [ ] **Relative/absolute references** - Support $A$1 style absolute references
- [ ] **Named ranges** - Define names for cell ranges (e.g., "Sales" = A1:A100)

### Data Types & Formatting

- [ ] **Column types** - Define column as text/number/date/currency
- [ ] **Number formatting** - Decimal places, thousands separator
- [ ] **Currency formatting** - $, EUR, etc. with proper display
- [ ] **Date formatting** - Parse and display dates in various formats
- [ ] **Percentage formatting** - Display 0.5 as 50%
- [ ] **Cell alignment** - Left/center/right alignment per cell or column
- [ ] **Text wrapping** - Wrap long text within cells
- [ ] **Find** - Cmd+F to search for text in cells
- [ ] **Find and replace** - Cmd+Shift+F to find/replace across spreadsheet
- [ ] **Column filters** - Dropdown filters on column headers
- [ ] **Filter by value** - Show only rows with specific values
- [ ] **Filter by condition** - Show rows matching numeric/text conditions

### Metadata & Persistence


### AI Integration

- [ ] **Metadata storage** - Store column types, header designation, formatting
- [ ] **File comment storage** - Store metadata as a comment at top of CSV
- [ ] **Parallel metadata file** - Option to store as .csv.meta JSON file
- [ ] **Configurable storage** - Let user choose comment vs. parallel file
- [ ] **Preserve formula text** - Store =SUM(A1:A10) in CSV, not computed value
- [ ] **Cell update visibility** - Flash/highlight cells as AI edits them
- [ ] **AI tool: analyze\_data** - Describe data patterns, statistics, anomalies
- [ ] **AI tool: add\_column** - Add calculated column with formula
- [ ] **AI tool: filter\_rows** - Filter to rows matching criteria
- [ ] **AI tool: sort\_data** - Sort by one or more columns
- [ ] **AI tool: apply\_formula** - Apply formula to column or range
- [ ] **AI tool: transform\_data** - Clean, normalize, or reshape data

### Search & Filter


### Data Validation

- [ ] **Required cells** - Mark cells that cannot be empty
- [ ] **Dropdown lists** - Restrict cell to predefined options
- [ ] **Numeric ranges** - Restrict to min/max values
- [ ] **Text patterns** - Validate against regex pattern
- [ ] **Validation errors** - Visual indicator for invalid cells

### Visual Features

- [ ] **Conditional formatting** - Highlight cells based on value (color scales, data bars)
- [ ] **Alternating row colors** - Zebra striping for readability
- [ ] **Cell borders** - Custom borders on cells
- [ ] **Freeze panes** - Freeze header row/column while scrolling
- [ ] **Cell comments/notes** - Add hover notes to cells

### Import/Export

- [ ] **Export to TSV** - Save with tab delimiter
- [ ] **Export to Excel** - Export as .xlsx (requires additional library)
- [ ] **Import from clipboard** - Paste tabular data from other apps
- [ ] **Delimiter detection** - Auto-detect comma vs. tab vs. semicolon

### Performance

- [ ] **Lazy formula evaluation** - Only recalculate visible cells for large files
- [ ] **Debounced recalculation** - Batch formula updates during rapid editing
- [ ] **Virtual scrolling optimization** - Tune RevoGrid for 100k+ row files

### Accessibility

- [ ] **Screen reader support** - ARIA labels for grid navigation
- [ ] **High contrast mode** - Support system high contrast settings
- [ ] **Keyboard-only operation** - Full functionality without mouse

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
    components/
      SpreadsheetEditor.tsx      # Main editor component
      SpreadsheetToolbar.tsx     # Toolbar buttons
      FormulaBar.tsx             # Formula input display
    hooks/
      useSpreadsheetStore.ts     # Zustand store for state
    utils/
      csvParser.ts               # CSV parsing/serialization
      formulaEngine.ts           # Formula evaluation
    aiTools.ts                   # AI tool registration
    styles.css                   # Themed styles
```

## Development

```bash
# Build the extension
cd packages/extensions/csv-spreadsheet
npm run build

# Install into Nimbalyst (via Extension Dev Kit MCP)
# Or copy dist/ to extensions folder
```

## References

- [RevoGrid Documentation](https://rv-grid.com/)
- [Formula.js Functions](https://formulajs.info/functions/)
- [Papa Parse Documentation](https://www.papaparse.com/docs)
- [nimbalyst-extension-system.md](./../design/Extensions/nimbalyst-extension-system.md)
