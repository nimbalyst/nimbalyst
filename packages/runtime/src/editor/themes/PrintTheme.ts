/**
 * Print stylesheet for PDF export.
 *
 * This stylesheet contains all necessary styles for rendering Lexical editor
 * content as a PDF, with CSS variables resolved to concrete light-theme values.
 * UI-only elements (cursors, selection, resize handles) are hidden.
 */

/**
 * Complete CSS for PDF export with all variables resolved to light theme values.
 */
export const PRINT_STYLESHEET = `
/* Base document styles */
* {
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
  font-size: 14px;
  line-height: 1.6;
  color: #111827;
  background: #ffffff;
  margin: 0;
  padding: 20px 40px;
}

/* Root container */
.pdf-export {
  max-width: 100%;
}

/* Text direction */
.nim-ltr {
  text-align: left;
}

.nim-rtl {
  text-align: right;
}

/* Paragraph */
.nim-paragraph {
  margin: 0 0 0.5em 0;
  position: relative;
}

/* Headings */
.nim-h1 {
  font-size: 28px;
  color: #050505;
  font-weight: 500;
  margin: 1em 0 0.5em 0;
}

.nim-h2 {
  font-size: 20px;
  color: #4d4c4c;
  font-weight: 600;
  margin: 1em 0 0.5em 0;
}

.nim-h3 {
  font-size: 16px;
  color: rgb(101, 103, 107);
  font-weight: 600;
  margin: 1em 0 0.5em 0;
}

.nim-h4 {
  font-size: 14px;
  color: rgb(101, 103, 107);
  font-weight: 600;
  margin: 1em 0 0.5em 0;
}

.nim-h5 {
  font-size: 12px;
  color: rgb(101, 103, 107);
  font-weight: 600;
  margin: 1em 0 0.5em 0;
}

.nim-h6 {
  font-size: 10px;
  color: rgb(101, 103, 107);
  font-weight: 600;
  margin: 1em 0 0.5em 0;
}

/* Text formatting */
.nim-text-bold {
  font-weight: bold;
}

.nim-text-italic {
  font-style: italic;
}

.nim-text-underline {
  text-decoration: underline;
}

.nim-text-strikethrough {
  text-decoration: line-through;
}

.nim-text-underline-strikethrough {
  text-decoration: underline line-through;
}

.nim-text-subscript {
  font-size: 0.8em;
  vertical-align: sub;
}

.nim-text-superscript {
  font-size: 0.8em;
  vertical-align: super;
}

.nim-text-highlight {
  background: rgba(255, 212, 0, 0.14);
  border-bottom: 2px solid rgba(255, 212, 0, 0.3);
}

/* Inline code */
.nim-text-code {
  background-color: rgb(240, 242, 245);
  padding: 1px 0.25rem;
  font-family: Menlo, Consolas, Monaco, monospace;
  font-size: 94%;
  border-radius: 2px;
}

/* Links */
.nim-link {
  color: rgb(33, 111, 219);
  text-decoration: none;
}

/* Quote */
.nim-quote {
  margin: 0 0 10px 20px;
  font-size: 15px;
  color: rgb(101, 103, 107);
  border-left: 4px solid rgb(206, 208, 212);
  padding-left: 16px;
}

/* Hashtag */
.nim-hashtag {
  background-color: rgba(88, 144, 255, 0.15);
  border-radius: 4px;
  padding-left: 3px;
  padding-right: 3px;
  display: inline-block;
}

/* Code blocks */
.nim-code {
  background-color: rgb(240, 242, 245);
  font-family: Menlo, Consolas, Monaco, monospace;
  display: block;
  padding: 8px 8px 8px 52px;
  line-height: 1.53;
  font-size: 13px;
  margin: 8px 0;
  overflow-x: auto;
  position: relative;
  tab-size: 2;
  border-radius: 4px;
  page-break-inside: avoid;
}

.nim-code:before {
  content: attr(data-gutter);
  position: absolute;
  background-color: #eee;
  left: 0;
  top: 0;
  border-right: 1px solid #ccc;
  padding: 8px;
  color: #777;
  white-space: pre-wrap;
  text-align: right;
  min-width: 25px;
}

/* Code syntax highlighting */
.nim-token-comment {
  color: slategray;
}

.nim-token-punctuation {
  color: #999;
}

.nim-token-property {
  color: #905;
}

.nim-token-selector {
  color: #690;
}

.nim-token-operator {
  color: #9a6e3a;
}

.nim-token-attr {
  color: #07a;
}

.nim-token-variable {
  color: #e90;
}

.nim-token-function {
  color: #dd4a68;
}

/* Lists */
.nim-ol1,
.nim-ol2,
.nim-ol3,
.nim-ol4,
.nim-ol5 {
  padding: 0;
  margin: 0;
  list-style-position: inside;
}

.nim-ol2 {
  list-style-type: upper-alpha;
}

.nim-ol3 {
  list-style-type: lower-alpha;
}

.nim-ol4 {
  list-style-type: upper-roman;
}

.nim-ol5 {
  list-style-type: lower-roman;
}

.nim-ul {
  padding: 0;
  margin: 0;
  list-style-position: inside;
}

.nim-list-item {
  margin: 0 24px;
}

.nim-nested-list-item {
  list-style-type: none;
}

/* Checkbox lists */
.nim-list-item-checked,
.nim-list-item-unchecked {
  position: relative;
  margin-left: 8px;
  margin-right: 8px;
  padding-left: 24px;
  padding-right: 24px;
  list-style-type: none;
}

.nim-list-item-checked {
  text-decoration: line-through;
}

.nim-list-item-unchecked:before,
.nim-list-item-checked:before {
  content: '';
  width: 16px;
  height: 16px;
  top: 2px;
  left: 0;
  display: block;
  position: absolute;
}

.nim-list-item-unchecked:before {
  border: 1px solid #999;
  border-radius: 2px;
}

.nim-list-item-checked:before {
  border: 1px solid rgb(61, 135, 245);
  border-radius: 2px;
  background-color: #3d87f5;
}

.nim-list-item-checked:after {
  content: '';
  border-color: #fff;
  border-style: solid;
  position: absolute;
  display: block;
  top: 6px;
  width: 3px;
  left: 7px;
  height: 6px;
  transform: rotate(45deg);
  border-width: 0 2px 2px 0;
}

/* Tables */
.nim-table-scrollable-wrapper {
  overflow-x: visible;
  margin: 0 0 16px 0;
}

.nim-table {
  border-collapse: collapse;
  border-spacing: 0;
  table-layout: fixed;
  margin: 16px 0;
  page-break-inside: avoid;
}

.nim-table-cell {
  border: 1px solid #bbb;
  vertical-align: top;
  text-align: start;
  padding: 6px 8px;
  min-width: 50px;
}

.nim-table-cell-header {
  background-color: #f2f3f5;
  text-align: start;
  font-weight: bold;
}

/* Hide table UI elements */
.nim-table-add-columns,
.nim-table-add-rows,
.nim-table-cell-resizer,
.nim-table-cell-action-button-container,
.nim-table-cell-action-button {
  display: none !important;
}

/* Horizontal rule */
.nim-hr {
  border: none;
  margin: 1em 0;
}

.nim-hr:after {
  content: '';
  display: block;
  height: 2px;
  background-color: #ccc;
}

/* Layout containers */
.nim-layout-container {
  display: grid;
  gap: 10px;
  margin: 10px 0;
}

.nim-layout-item {
  border: 1px dashed #ddd;
  padding: 8px 16px;
  min-width: 0;
  max-width: 100%;
}

/* Images */
.editor-image {
  display: block;
  max-width: 100%;
  margin: 8px 0;
}

.editor-image img {
  max-width: 100%;
  height: auto;
}

.ImageNode__contentEditable {
  font-size: 12px;
  padding: 10px;
  color: #666;
  font-style: italic;
}

/* Hide image placeholder */
.ImageNode__placeholder {
  display: none;
}

/* Collapsible sections - show expanded in print */
.Collapsible__container {
  background: #fcfcfc;
  border: 1px solid #eee;
  border-radius: 10px;
  margin-bottom: 8px;
  page-break-inside: avoid;
}

.Collapsible__title {
  padding: 5px 5px 5px 20px;
  position: relative;
  font-weight: bold;
  list-style: none;
}

.Collapsible__title::marker,
.Collapsible__title::-webkit-details-marker {
  display: none;
}

.Collapsible__title:before {
  border-style: solid;
  border-color: transparent;
  border-width: 6px 4px 0 4px;
  border-top-color: #000;
  display: block;
  content: '';
  position: absolute;
  left: 7px;
  top: 50%;
  transform: translateY(-50%);
}

.Collapsible__content {
  padding: 0 5px 5px 20px;
}

/* Force show collapsed content in print */
.Collapsible__collapsed .Collapsible__content {
  display: block !important;
}

/* Mermaid diagrams */
.mermaid-container {
  margin: 16px 0;
  page-break-inside: avoid;
}

.mermaid-header {
  display: none;
}

/* Diff styling - show diffs but simplified for print */
.nim-diff-add {
  background-color: #e6ffed;
  border-radius: 2px;
}

.nim-diff-remove {
  background-color: #ffebe9;
  text-decoration: line-through;
  border-radius: 2px;
}

/* Hide diff styling on empty paragraphs */
.nim-diff-add:has(br:only-child),
.nim-diff-remove:has(br:only-child) {
  background-color: transparent;
}

/* Marks/highlights */
.nim-mark {
  background: rgba(255, 212, 0, 0.14);
  border-bottom: 2px solid rgba(255, 212, 0, 0.3);
  padding-bottom: 2px;
}

/* Hide UI-only elements */
.nim-block-cursor,
.nim-autocomplete,
.nim-table-cell-selected::after,
.nim-hr-selected {
  display: none !important;
}

/* Print-specific rules */
@media print {
  body {
    padding: 0;
  }

  .nim-code,
  .nim-table,
  .Collapsible__container {
    page-break-inside: avoid;
  }

  h1, h2, h3, h4, h5, h6 {
    page-break-after: avoid;
  }

  img {
    page-break-inside: avoid;
  }
}
`;

/**
 * Wraps HTML content with a full document structure including the print stylesheet.
 * @param content - The HTML content from $generateHtmlFromNodes
 * @returns Complete HTML document ready for PDF generation
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function wrapWithPrintStyles(content: string, title: string = 'Document'): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${PRINT_STYLESHEET}</style>
</head>
<body class="pdf-export">
  <div class="nim-root">
    ${content}
  </div>
</body>
</html>`;
}
