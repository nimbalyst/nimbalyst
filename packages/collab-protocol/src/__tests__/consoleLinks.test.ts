// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildConsoleLink,
  consoleLinkDeepLink,
  consoleLinkFromDeepLink,
  isConsoleLink,
  parseConsoleLink,
  type ConsoleLinkTarget,
} from '../consoleLinks.js';

const team = { orgId: 'org-1', projectId: 'tp-1' };

describe('console links', () => {
  const cases: Array<[ConsoleLinkTarget, string]> = [
    [{ kind: 'page', scope: team, pageId: 'doc-1' }, 'https://console.nimbalyst.com/org/org-1/project/tp-1/document/doc-1'],
    [{ kind: 'item', scope: team, itemRef: 'NIM-12' }, 'https://console.nimbalyst.com/org/org-1/project/tp-1/page/item/NIM-12'],
    [{ kind: 'type', scope: team, typeId: 'competitor' }, 'https://console.nimbalyst.com/org/org-1/project/tp-1/page/type/competitor'],
    [{ kind: 'view', scope: team, view: { kind: 'type', typeId: 'competitor' } }, 'https://console.nimbalyst.com/org/org-1/project/tp-1/view/type/competitor'],
    [{ kind: 'view', scope: team, view: { kind: 'marks', marks: 'decided' } }, 'https://console.nimbalyst.com/org/org-1/project/tp-1/view/marks?kind=decided'],
    [{ kind: 'view', scope: team, view: { kind: 'marks', marks: 'all' } }, 'https://console.nimbalyst.com/org/org-1/project/tp-1/view/marks'],
    [{ kind: 'page', scope: 'local', pageId: 'p-9' }, 'https://console.nimbalyst.com/app/page/p-9'],
    [{ kind: 'item', scope: 'local', itemRef: 'abc' }, 'https://console.nimbalyst.com/app/item/abc'],
    [{ kind: 'type', scope: 'local', typeId: 'idea' }, 'https://console.nimbalyst.com/app/type/idea'],
    [{ kind: 'view', scope: 'local', view: { kind: 'type', typeId: 'idea' } }, 'https://console.nimbalyst.com/app/view/type/idea'],
    [{ kind: 'citation', sessionId: 's-1', inputKind: 'answer', key: 'toolu_01' }, 'https://console.nimbalyst.com/app/cite/s-1/answer/toolu_01'],
    [{ kind: 'commentCitation', scope: team, pageId: 'doc-1', commentId: 'c 1' }, 'https://console.nimbalyst.com/org/org-1/project/tp-1/document/doc-1?comment=c%201'],
  ];

  it.each(cases)('builds and parses %j', (target, url) => {
    expect(buildConsoleLink(target)).toBe(url);
    expect(parseConsoleLink(url)).toEqual(target);
  });

  it('escapes ids so a segment cannot add path, query or markdown syntax', () => {
    const url = buildConsoleLink({ kind: 'citation', sessionId: 'a/b', inputKind: 'prompt', key: 'k (1)?x' });
    expect(url).toBe('https://console.nimbalyst.com/app/cite/a%2Fb/prompt/k%20%281%29%3Fx');
    expect(url).not.toMatch(/[\s()]/);
    expect(parseConsoleLink(url)).toEqual({ kind: 'citation', sessionId: 'a/b', inputKind: 'prompt', key: 'k (1)?x' });
  });

  it('builds and parses a citation of a Claude Code session, and an older parser reads it as nothing', () => {
    const target: ConsoleLinkTarget = { kind: 'citation', agent: 'claude-code', sessionId: 'cc-1', inputKind: 'answer', key: 'toolu_01~1' };
    const url = buildConsoleLink(target);
    expect(url).toBe('https://console.nimbalyst.com/app/cite/claude-code/cc-1/answer/toolu_01~1'.replace('~', '%7E'));
    expect(parseConsoleLink(url)).toEqual(target);
    expect(consoleLinkFromDeepLink(consoleLinkDeepLink(url)!)).toBe(url);
    // Five segments after `app/cite` only for a known agent; comments are never cited from a terminal session.
    expect(parseConsoleLink('https://console.nimbalyst.com/app/cite/other-agent/cc-1/answer/k')).toBeNull();
    expect(parseConsoleLink('https://console.nimbalyst.com/app/cite/claude-code/cc-1/comment/k')).toBeNull();
  });

  it('ignores a hash and the list-context query the console adds to item links', () => {
    expect(parseConsoleLink('https://console.nimbalyst.com/org/o/project/p/page/item/NIM-1?type=bug#x'))
      .toEqual({ kind: 'item', scope: { orgId: 'o', projectId: 'p' }, itemRef: 'NIM-1' });
  });

  it('still reads typed-page and type links written in the older trackers shape', () => {
    const scope = { orgId: 'o', projectId: 'p' };
    expect(parseConsoleLink('https://console.nimbalyst.com/org/o/project/p/trackers/item/NIM-1'))
      .toEqual({ kind: 'item', scope, itemRef: 'NIM-1' });
    expect(parseConsoleLink('https://console.nimbalyst.com/org/o/project/p/trackers/type/bug'))
      .toEqual({ kind: 'type', scope, typeId: 'bug' });
    expect(consoleLinkFromDeepLink('nimbalyst://console/org/o/project/p/trackers/item/NIM-1'))
      .toBe('https://console.nimbalyst.com/org/o/project/p/trackers/item/NIM-1');
    expect(parseConsoleLink('https://console.nimbalyst.com/org/o/project/p/page/view/x')).toBeNull();
  });

  it('rejects other origins, other console routes and malformed links', () => {
    for (const url of [
      'https://evil.example.com/org/o/project/p/document/d',
      'http://console.nimbalyst.com/org/o/project/p/document/d',
      'https://console.nimbalyst.com/org/o/project/p/docs',
      'https://console.nimbalyst.com/app/cite/s/shout/k',
      'https://console.nimbalyst.com/app/cite/s/prompt',
      'https://console.nimbalyst.com/org/o/project/p/view/marks?kind=nope',
      'https://console.nimbalyst.com/org/o/project/p/document/d?comment=',
      'nimbalyst://NIM-1',
      'not a url',
    ]) {
      expect(parseConsoleLink(url)).toBeNull();
    }
    expect(isConsoleLink('https://console.nimbalyst.com/org/o/project/p/document/d')).toBe(true);
    expect(isConsoleLink('https://console.nimbalyst.com/org/o/admin')).toBe(false);
  });

  it('reads links minted against an extra origin the host allows', () => {
    expect(parseConsoleLink('http://localhost:5173/app/page/p', { origins: ['http://localhost:5173'] }))
      .toEqual({ kind: 'page', scope: 'local', pageId: 'p' });
  });

  it('carries a console link to the app as a deep link and back', () => {
    const url = 'https://console.nimbalyst.com/org/o/project/p/view/marks?kind=open';
    const deep = consoleLinkDeepLink(url);
    expect(deep).toBe('nimbalyst://console/org/o/project/p/view/marks?kind=open');
    expect(consoleLinkFromDeepLink(deep!)).toBe(url);
    expect(consoleLinkFromDeepLink('nimbalyst://tracker/abc')).toBeNull();
    expect(consoleLinkFromDeepLink('nimbalyst://console/org/o/admin')).toBeNull();
  });
});
