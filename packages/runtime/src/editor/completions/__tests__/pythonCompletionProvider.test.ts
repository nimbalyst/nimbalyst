import { describe, it, expect } from 'vitest';
import { providePythonCompletionsFromText } from '../pythonCompletionProvider';

function getLabels(items: { label: string | { label: string } }[]): string[] {
  return items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
}

describe('providePythonCompletionsFromText', () => {
  it('returns Python keywords for a fresh prefix', () => {
    const items = providePythonCompletionsFromText('', 0);
    const labels = getLabels(items);
    expect(labels).toContain('def');
    expect(labels).toContain('class');
    expect(labels).toContain('return');
    expect(labels).toContain('import');
    expect(labels).toContain('from');
    expect(labels).toContain('yield');
    expect(labels).toContain('async');
    expect(labels).toContain('await');
  });

  it('filters keywords by prefix', () => {
    const items = providePythonCompletionsFromText('de', 2);
    const labels = getLabels(items);
    expect(labels).toContain('def');
    expect(labels).not.toContain('class');
  });

  it('surfaces stdlib identifiers with matching prefix', () => {
    const items = providePythonCompletionsFromText('json', 4);
    const labels = getLabels(items);
    expect(labels).toContain('json.dumps');
    expect(labels).toContain('json.loads');
    // Non-matching stdlib entries dropped
    expect(labels).not.toContain('os.path.join');
  });

  it('collects in-file def/class/import identifiers', () => {
    const text = [
      'import os',
      'import json as j',
      'from typing import List, Optional as Opt',
      'class User:',
      '    def __init__(self, name, age):',
      '        self.name = name',
      '        self.age = age',
      'def helper(x, y=3, **kwargs):',
      '    target = x + y',
      '',
    ].join('\n');
    const offset = text.length;
    const items = providePythonCompletionsFromText(text, offset);
    const labels = getLabels(items);
    expect(labels).toContain('User');
    expect(labels).toContain('helper');
    expect(labels).toContain('__init__');
    expect(labels).toContain('os');
    expect(labels).toContain('j'); // aliased import
    expect(labels).toContain('List');
    expect(labels).toContain('Opt');
    expect(labels).toContain('x');
    expect(labels).toContain('y');
    expect(labels).toContain('kwargs');
    expect(labels).toContain('target');
    expect(labels).toContain('name');
    expect(labels).toContain('age');
  });

  it('collects identifiers from async defs', () => {
    const text = ['async def fetch(url):', '    body = None', ''].join('\n');
    const items = providePythonCompletionsFromText(text, text.length);
    const labels = getLabels(items);
    expect(labels).toContain('fetch');
    expect(labels).toContain('url');
    expect(labels).toContain('body');
  });

  it('returns no keyword completions when prefix matches nothing', () => {
    const text = 'qqqqq';
    const items = providePythonCompletionsFromText(text, text.length);
    // No keywords, stdlib, or in-file identifiers match `qqqqq`.
    expect(items).toEqual([]);
  });

  it('treats `self` and `cls` as positional only and excludes them', () => {
    const text = ['def m(self, cls, value):', ''].join('\n');
    const items = providePythonCompletionsFromText(text, text.length);
    const labels = getLabels(items);
    expect(labels).toContain('value');
    expect(labels).not.toContain('self');
    expect(labels).not.toContain('cls');
  });
});
