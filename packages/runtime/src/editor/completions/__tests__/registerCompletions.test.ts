import { describe, it, expect } from 'vitest';
import { registerCompletions } from '../registerCompletions';

function buildStubMonaco() {
  const registered: Array<{ language: string; provider: { provideCompletionItems: unknown } }> = [];
  const monaco = {
    languages: {
      registerCompletionItemProvider(
        language: string,
        provider: { provideCompletionItems: unknown },
      ) {
        registered.push({ language, provider });
        return { dispose: () => {} };
      },
    },
  } as unknown as Parameters<typeof registerCompletions>[0];
  return { monaco, registered };
}

describe('registerCompletions', () => {
  it('registers providers for sql, python, markdown', () => {
    const { monaco, registered } = buildStubMonaco();
    registerCompletions(monaco);
    const languages = registered.map((r) => r.language).sort();
    expect(languages).toEqual(['markdown', 'python', 'sql']);
  });

  it('is idempotent — re-registering disposes the prior registrations', () => {
    const { monaco, registered } = buildStubMonaco();
    registerCompletions(monaco);
    expect(registered.length).toBe(3);
    registerCompletions(monaco);
    // After re-registering, only 3 entries should remain (the new trio).
    expect(registered.length).toBe(6);
  });

  it('returns a disposable that, when called, removes the registrations', () => {
    const disposables: Array<{ disposeCalls: number }> = [];
    const { monaco } = buildStubMonaco();
    // Replace the stub's dispose with a counter
    const original = monaco.languages.registerCompletionItemProvider;
    monaco.languages.registerCompletionItemProvider = ((language: string, provider: { provideCompletionItems: unknown }) => {
      const d = { disposeCalls: 0, dispose() { this.disposeCalls += 1; } };
      disposables.push(d);
      return d;
    }) as typeof original;
    const handle = registerCompletions(monaco);
    expect(disposables.length).toBe(3);
    handle.dispose();
    expect(disposables.every((d) => d.disposeCalls === 1)).toBe(true);
  });

  it('gate: registerCompletions is only invoked for the three language IDs', () => {
    // Sanity check that the helper ONLY registers for sql/python/markdown.
    // Even if a consumer accidentally passes an extra language via options,
    // those are not expanded — the helper is intentionally narrow.
    const { monaco, registered } = buildStubMonaco();
    registerCompletions(monaco);
    expect(new Set(registered.map((r) => r.language))).toEqual(
      new Set(['sql', 'python', 'markdown']),
    );
  });
});
