/**
 * Calc Sheets CollabContentAdapter
 *
 * `.calc.md` is a text-first format, so collaboration uses the SDK's generic
 * single-`Y.Text` adapter. The WHOLE file (YAML frontmatter + body) lives in
 * the `content` field; the editor visually hides the frontmatter lines while
 * keeping them synced. The Monaco live binding
 * (`createMonacoCollabBinding`, wired via MonacoEditor's `collab` prop) MUST
 * use the same `content` field.
 *
 * documentType is `calc.md` to match the custom-editor suffix convention
 * (cf. `mockup.html`), so share-time documentType resolution and the runtime
 * adapter registry agree.
 */
import { createTextCollabContentAdapter } from '@nimbalyst/extension-sdk';

/** Shared Y.Text field carrying the full `.calc.md` document. */
export const CALC_SHEET_TEXT_FIELD = 'content';

export const CalcSheetCollabContentAdapter = createTextCollabContentAdapter({
  documentType: 'calc.md',
  fileExtensions: ['.calc.md'],
  mimeType: 'text/markdown',
  textField: CALC_SHEET_TEXT_FIELD,
});
