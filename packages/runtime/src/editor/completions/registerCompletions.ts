/**
 * Register inline code completion providers for SQL, Python, and Markdown
 * on a Monaco instance. Called from `MonacoCodeEditor.handleEditorMount`
 * once Monaco is ready.
 *
 * Idempotent within a Monaco instance: registering the same provider
 * twice adds both to the provider chain but does not throw; we dispose
 * the previous registrations first so duplicate mounts do not stack up.
 */

import type { Monaco } from '@monaco-editor/react';
import {
  provideSqlCompletions,
  type SqlCompletionOptions,
} from './sqlCompletionProvider';
import { providePythonCompletions } from './pythonCompletionProvider';
import { provideMarkdownCompletions } from './markdownCompletionProvider';

const REGISTRATION_KEY = Symbol.for('nimbalyst.completions.registrations');

interface RegistrationRecord {
  sql?: { dispose: () => void };
  python?: { dispose: () => void };
  markdown?: { dispose: () => void };
}

/**
 * Side-effect: registers all three providers on the Monaco instance.
 * Returns a single disposable that unregisters every provider we added.
 */
export function registerCompletions(
  monaco: Monaco,
  options: { sql?: SqlCompletionOptions; python?: { extraInFileIdentifiers?: readonly string[] } } = {},
): { dispose: () => void } {
  const monacoAny = monaco as unknown as {
    languages: {
      registerCompletionItemProvider: (
        language: string,
        provider: { provideCompletionItems: unknown },
      ) => { dispose: () => void };
    };
  };

  // Idempotency: if a prior mount already registered providers on this
  // Monaco instance, dispose them before re-registering.
  const prior = (monaco as unknown as { [REGISTRATION_KEY]?: RegistrationRecord })[REGISTRATION_KEY];
  if (prior) {
    prior.sql?.dispose();
    prior.python?.dispose();
    prior.markdown?.dispose();
  }
  const record: RegistrationRecord = {};

  record.sql = monacoAny.languages.registerCompletionItemProvider('sql', {
    provideCompletionItems: (model: unknown, position: unknown) =>
      provideSqlCompletions(
        model as Parameters<typeof provideSqlCompletions>[0],
        position as Parameters<typeof provideSqlCompletions>[1],
        options.sql ?? {},
      ),
  });
  record.python = monacoAny.languages.registerCompletionItemProvider('python', {
    provideCompletionItems: (model: unknown, position: unknown) =>
      providePythonCompletions(
        model as Parameters<typeof providePythonCompletions>[0],
        position as Parameters<typeof providePythonCompletions>[1],
        options.python ?? {},
      ),
  });
  record.markdown = monacoAny.languages.registerCompletionItemProvider('markdown', {
    provideCompletionItems: (model: unknown, position: unknown) =>
      provideMarkdownCompletions(
        model as Parameters<typeof provideMarkdownCompletions>[0],
        position as Parameters<typeof provideMarkdownCompletions>[1],
      ),
  });

  (monaco as unknown as { [REGISTRATION_KEY]?: RegistrationRecord })[REGISTRATION_KEY] = record;

  return {
    dispose: () => {
      record.sql?.dispose();
      record.python?.dispose();
      record.markdown?.dispose();
      const cur = (monaco as unknown as { [REGISTRATION_KEY]?: RegistrationRecord })[REGISTRATION_KEY];
      if (cur === record) {
        delete (monaco as unknown as { [REGISTRATION_KEY]?: RegistrationRecord })[REGISTRATION_KEY];
      }
    },
  };
}
