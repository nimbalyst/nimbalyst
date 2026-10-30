import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Every key maps to the same text node; the DOM element for a key is a real <span> we control.
vi.mock('lexical', () => ({
  $getNodeByKey: () => ({ getTextContent: () => 'e'.repeat(10) }),
  $isTextNode: () => true,
}));

import { HighlightManager, MAX_RENDERED_HIGHLIGHTS, matchIndexAfterSearch, type SearchMatch } from '../HighlightManager';

function setup(matchCount: number) {
  const parent = document.createElement('div');
  const root = document.createElement('div');
  parent.appendChild(root);
  document.body.appendChild(parent);

  const spans = new Map<string, HTMLElement>();
  const matches: SearchMatch[] = [];
  for (let i = 0; i < matchCount; i++) {
    const key = `k${i}`;
    const span = document.createElement('span');
    span.textContent = 'e'.repeat(10);
    root.appendChild(span);
    spans.set(key, span);
    matches.push({ key, offset: 0, length: 1, text: 'e' });
  }

  const editor = {
    getRootElement: () => root,
    getEditorState: () => ({ read: (fn: () => void) => fn() }),
    getElementByKey: (key: string) => spans.get(key) ?? null,
  } as any;

  return { parent, root, matches, manager: new HighlightManager(editor) };
}

describe('HighlightManager.updateHighlights', () => {
  let wrapperChildCountAtRead: number[];
  let wrapper: () => Element | null;

  beforeEach(() => {
    wrapperChildCountAtRead = [];
    wrapper = () => document.querySelector('.search-highlights-wrapper');
    // jsdom has no layout; report one rect per range and record how many highlights are
    // already in the DOM each time layout would be read.
    (Range.prototype as any).getClientRects = function () {
      wrapperChildCountAtRead.push(wrapper()?.childElementCount ?? 0);
      return [{ left: 10, top: 20, width: 5, height: 12 }];
    };
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete (Range.prototype as any).getClientRects;
  });

  it('reads every match rect before adding any highlight element', () => {
    const { manager, matches } = setup(40);

    manager.updateHighlights(matches, 0);

    expect(wrapperChildCountAtRead).toHaveLength(40);
    // A read that follows a write forces a synchronous layout per match.
    expect(new Set(wrapperChildCountAtRead)).toEqual(new Set([0]));
    expect(wrapper()?.childElementCount).toBe(40);
  });

  it('renders a bounded window of highlights around the current match', () => {
    const total = MAX_RENDERED_HIGHLIGHTS * 3;
    const current = total / 2;
    const { manager, matches } = setup(total);

    manager.updateHighlights(matches, current);

    expect(wrapper()?.childElementCount).toBe(MAX_RENDERED_HIGHLIGHTS);
    expect(wrapper()?.querySelectorAll('.search-highlight-current')).toHaveLength(1);
  });

  it('keeps the window inside the match list at both ends', () => {
    const total = MAX_RENDERED_HIGHLIGHTS * 2;
    const { manager, matches } = setup(total);

    manager.updateHighlights(matches, 0);
    expect(wrapper()?.childElementCount).toBe(MAX_RENDERED_HIGHLIGHTS);
    expect(wrapper()?.querySelectorAll('.search-highlight-current')).toHaveLength(1);

    manager.updateHighlights(matches, total - 1);
    expect(wrapper()?.childElementCount).toBe(MAX_RENDERED_HIGHLIGHTS);
    expect(wrapper()?.querySelectorAll('.search-highlight-current')).toHaveLength(1);
  });
});

// GitHub #1889: highlights are absolutely positioned from rects measured when they were
// drawn, so a width change that reflows the text left them over the wrong characters.
describe('HighlightManager on resize', () => {
  type Entry = { target: Element; contentRect: { width: number; height: number } };
  let observers: Array<{ callback: (entries: Entry[]) => void; targets: Set<Element> }>;
  let matchLeft: number;

  const resize = (target: Element, width: number, height = 100) => {
    for (const observer of observers) {
      if (observer.targets.has(target)) observer.callback([{ target, contentRect: { width, height } }]);
    }
  };
  const highlightLeft = () => (document.querySelector('.search-highlight-current') as HTMLElement | null)?.style.left;

  beforeEach(() => {
    observers = [];
    matchLeft = 10;
    vi.stubGlobal('ResizeObserver', class {
      private record: { callback: (entries: Entry[]) => void; targets: Set<Element> };
      constructor(callback: (entries: Entry[]) => void) {
        this.record = { callback, targets: new Set() };
        observers.push(this.record);
      }
      observe(target: Element) { this.record.targets.add(target); }
      unobserve(target: Element) { this.record.targets.delete(target); }
      disconnect() { this.record.targets.clear(); }
    });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    (Range.prototype as any).getClientRects = () => [{ left: matchLeft, top: 20, width: 5, height: 12 }];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    delete (Range.prototype as any).getClientRects;
  });

  it('redraws at the new positions when the editor width changes', () => {
    const { manager, root, matches } = setup(3);
    manager.updateHighlights(matches, 1);
    resize(root, 500);
    expect(highlightLeft()).toBe('10px');

    matchLeft = 46;
    resize(root, 400);
    expect(highlightLeft()).toBe('46px');
  });

  it('redraws when only the container width changes', () => {
    const { manager, parent, matches } = setup(1);
    manager.updateHighlights(matches, 0);
    resize(parent, 800);

    matchLeft = 30;
    resize(parent, 900);
    expect(highlightLeft()).toBe('30px');
  });

  it('does not redraw when only the height changes, as it does on every added line', () => {
    const { manager, root, matches } = setup(1);
    manager.updateHighlights(matches, 0);
    resize(root, 500, 100);

    matchLeft = 46;
    resize(root, 500, 140);
    expect(highlightLeft()).toBe('10px');
  });

  it('draws nothing on resize after the search is cleared or the manager destroyed', () => {
    const { manager, root, matches } = setup(1);
    manager.updateHighlights(matches, 0);
    resize(root, 500);

    manager.clearHighlights();
    resize(root, 400);
    expect(document.querySelectorAll('.search-highlight, .search-highlight-current')).toHaveLength(0);

    manager.updateHighlights(matches, 0);
    manager.destroy();
    resize(root, 300);
    expect(document.querySelectorAll('.search-highlight, .search-highlight-current')).toHaveLength(0);
  });
});

// The re-search after an edit used to compute this inside a React state updater and read
// the result from a timer; React defers the updater, so the timer drew with `undefined`.
describe('matchIndexAfterSearch', () => {
  it('keeps the current match when re-searching, clamped to the new count', () => {
    expect(matchIndexAfterSearch(3, 10, true)).toBe(3);
    expect(matchIndexAfterSearch(7, 4, true)).toBe(3);
    expect(matchIndexAfterSearch(-1, 4, true)).toBe(0);
  });

  it('starts at the first match on a new search, and at -1 with no matches', () => {
    expect(matchIndexAfterSearch(5, 10, false)).toBe(0);
    expect(matchIndexAfterSearch(5, 0, true)).toBe(-1);
    expect(matchIndexAfterSearch(5, 0, false)).toBe(-1);
  });
});
