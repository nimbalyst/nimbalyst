import { describe, expect, it } from 'vitest';
import { resolveScreenshotEditor } from '../resolveScreenshotEditor';

describe('screenshot editor selection', () => {
  it('prefers compound extension editors over built-ins', () => {
    const custom = {};
    expect(
      resolveScreenshotEditor('/talk.slides.md', (suffix) =>
        suffix === '.slides.md' ? custom : undefined
      )
    ).toEqual({ type: 'custom', component: custom });
    expect(
      resolveScreenshotEditor('/schema.backup.prisma', (suffix) =>
        suffix === '.prisma' ? custom : undefined
      )
    ).toEqual({ type: 'custom', component: custom });
  });
  it.each([
    ['/notes.md', 'markdown'],
    ['/notes.markdown', 'markdown'],
    ['/source.test.ts', 'code'],
    ['/Dockerfile', 'code'],
    ['/picture.png', 'image'],
  ])('mounts the built-in editor for %s', (file, type) => {
    expect(resolveScreenshotEditor(file, () => undefined)).toEqual({ type });
  });
});
