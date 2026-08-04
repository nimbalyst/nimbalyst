import { describe, expect, it } from 'vitest';
import {
  describeScreenshotCaptureError,
  sanitizeScreenshotCloneForXml,
} from '../screenshotUtils';

function commentData(document: Document): string[] {
  const comments: string[] = [];
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
  let node = walker.nextNode();

  while (node) {
    comments.push((node as Comment).data);
    node = walker.nextNode();
  }

  return comments;
}

describe('sanitizeScreenshotCloneForXml', () => {
  it('makes HTML comments safe for foreignObject SVG serialization', () => {
    const clone = document.implementation.createHTMLDocument();
    clone.body.innerHTML = [
      '<!-- Light --nim-* values -->',
      '<div><!-- three---hyphens --></div>',
      '<!-- trailing- -->',
      '<!-- safe comment -->',
    ].join('');
    clone.body.appendChild(clone.createComment('trailing-'));

    sanitizeScreenshotCloneForXml(clone);

    const comments = commentData(clone);
    expect(comments[0]).toBe(' Light - -nim-* values ');
    expect(comments[1]).toBe(' three- - -hyphens ');
    expect(comments[2]).toBe(' trailing- ');
    expect(comments[3]).toBe(' safe comment ');
    expect(comments[4]).toBe('trailing- ');
    expect(comments.every((comment) => !comment.includes('--'))).toBe(true);
    expect(comments.every((comment) => !comment.endsWith('-'))).toBe(true);
  });
});

describe('describeScreenshotCaptureError', () => {
  it('turns a raw image error event into an actionable message', () => {
    const image = document.createElement('img');
    let imageError: Event | undefined;
    image.addEventListener('error', (event) => {
      imageError = event;
    });
    image.dispatchEvent(new Event('error'));

    expect(describeScreenshotCaptureError(imageError)).toBe(
      'Mockup image serialization failed (error event)'
    );
  });
});
