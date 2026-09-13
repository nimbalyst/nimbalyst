// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createEmbedFileHref, findExistingEmbedFilePath, getEmbedFilePathCandidates } from '../embedFilePaths';

describe('embed file links', () => {
  it.each([
    ['panel.mockup.html', ['/ws/docs/panel.mockup.html', '/ws/panel.mockup.html']],
    ['./panel.mockup.html', ['/ws/docs/panel.mockup.html']],
    ['../panel.mockup.html', ['/ws/panel.mockup.html']],
    ['/mockups/panel.mockup.html', ['/ws/mockups/panel.mockup.html', '/mockups/panel.mockup.html']],
    ['/ws/panel.mockup.html', ['/ws/ws/panel.mockup.html', '/ws/panel.mockup.html']],
    ['file:///tmp/My%20panel.mockup.html', ['/tmp/My panel.mockup.html']],
    ['./My%20panel.mockup.html?view=1#section', ['/ws/docs/My panel.mockup.html']],
    ['file:///C:/docs/panel.mockup.html', ['C:/docs/panel.mockup.html']],
    ['https://example.com/panel.mockup.html', []],
    ['collab://org:team:doc:panel', []],
    ['bad%ZZ.mockup.html', []],
  ])('resolves %s', (href, expected) => {
    expect(getEmbedFilePathCandidates(href, '/ws/docs', '/ws')).toEqual(expected);
  });

  it('uses the preferred existing file, preserves old links, and propagates lookup failures', async () => {
    const paths = getEmbedFilePathCandidates('panel.mockup.html', '/ws/docs', '/ws');
    const exists = vi.fn(async () => true);
    expect(await findExistingEmbedFilePath(paths, exists)).toBe(paths[0]);
    expect(exists).toHaveBeenCalledTimes(1);
    expect(await findExistingEmbedFilePath(paths, async path => path === paths[1])).toBe(paths[1]);
    expect(await findExistingEmbedFilePath(paths, async () => false)).toBeNull();
    await expect(findExistingEmbedFilePath(paths, async () => { throw new Error('lookup failed'); })).rejects.toThrow('lookup failed');
  });

  it('does not use a collaborative URI as a filesystem directory', () => {
    expect(getEmbedFilePathCandidates('./panel.mockup.html', 'collab://org:team:doc:host', '/ws')).toEqual([]);
    expect(getEmbedFilePathCandidates('panel.mockup.html', null, '/ws')).toEqual(['/ws/panel.mockup.html']);
    expect(getEmbedFilePathCandidates('panel.mockup.html', 'C:/ws/docs', 'C:/ws')).toEqual(['C:/ws/docs/panel.mockup.html', 'C:/ws/panel.mockup.html']);
  });

  it.each([
    ['docs/panel.mockup.html', '/ws/docs/host.md', './panel.mockup.html'],
    ['mockups/panel.mockup.html', '/ws/docs/host.md', '../mockups/panel.mockup.html'],
    ['docs/My #panel.mockup.html', '/ws/docs/host.md', './My%20%23panel.mockup.html'],
    ['docs/panel.mockup.html', null, '/docs/panel.mockup.html'],
  ])('picker emits a path that resolves back to %s', (filePath, host, expected) => {
    const href = createEmbedFileHref(filePath, host, '/ws');
    expect(href).toBe(expected);
    expect(getEmbedFilePathCandidates(href, host ? '/ws/docs' : null, '/ws')[0]).toBe(`/ws/${filePath}`);
  });
});
