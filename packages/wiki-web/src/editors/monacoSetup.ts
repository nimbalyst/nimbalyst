/**
 * Self-hosted Monaco for the calc sheet editor, as in the web console's
 * `webMonacoBundle.tsx`: `@monaco-editor/react` would otherwise fetch Monaco
 * from a CDN, which a local wiki must not need, and Monaco throws without a
 * worker. Only the base editor worker is wired, and `monaco-editor` resolves to
 * `monacoCore.ts`, which leaves out the language services and their workers.
 * Imported lazily, so a wiki that never opens a calc sheet never downloads Monaco.
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';

self.MonacoEnvironment = { getWorker: () => new editorWorker() };
loader.config({ monaco });
