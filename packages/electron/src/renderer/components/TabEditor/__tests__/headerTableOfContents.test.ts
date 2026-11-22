// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { tocDepths } from '../HeaderTableOfContents';

describe('tocDepths', () => {
  it('indents relative to the shallowest heading', () => {
    expect(tocDepths([2, 3, 3, 2, 4])).toEqual([0, 1, 1, 0, 1]);
  });

  it('never jumps more than one step deeper than the previous heading', () => {
    expect(tocDepths([1, 4, 4, 2, 3])).toEqual([0, 1, 1, 1, 2]);
  });

  it('treats a heading with nothing shallower above it as top level', () => {
    expect(tocDepths([3, 2, 3])).toEqual([0, 0, 1]);
  });

  it('handles an empty document', () => {
    expect(tocDepths([])).toEqual([]);
  });
});
