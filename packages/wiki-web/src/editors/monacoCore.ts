/**
 * What `monaco-editor` resolves to in this build (see the alias in
 * `vite.config.ts`): the package's main entry without its CSS, HTML, JSON and
 * TypeScript language services or the bundled syntax grammars. Each language
 * service carries a worker, and Vite emits a worker it can see even when
 * `getWorker` never starts it; the TypeScript one alone is 7 MB, over the
 * plugin directory's 5 MiB per-file limit for the staged nimbalyst-wiki repo.
 * Only the calc sheet editor uses Monaco here, and it registers its own
 * tokenizer, so neither the services nor the grammars are needed.
 */
import 'monaco-editor/esm/vs/editor/editor.all.js';
import 'monaco-editor/esm/vs/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard.js';
import 'monaco-editor/esm/vs/editor/standalone/browser/inspectTokens/inspectTokens.js';
import 'monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js';
import 'monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js';
import 'monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js';
import 'monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js';
import 'monaco-editor/esm/vs/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js';
import 'monaco-editor/esm/vs/editor/standalone/browser/toggleHighContrast/toggleHighContrast.js';

export * from 'monaco-editor/esm/vs/editor/editor.api.js';
