import { describe, expect, it, vi } from 'vitest';
import { ScreenshotServiceImpl } from '../ScreenshotService';

describe('host-owned screenshots', () => {
  it('routes any file through the host instead of legacy private renderers', async () => {
    const service = new ScreenshotServiceImpl();
    const legacy = vi.fn();
    service.register({
      id: 'legacy',
      fileExtensions: ['.prisma'],
      capture: legacy,
    });
    const captureFile = vi.fn().mockResolvedValue('png');
    service.setCaptureProvider({ captureFile, captureElement: vi.fn() });
    expect(await service.capture('/schema.prisma')).toBe('png');
    expect(await service.capture('/notes.md')).toBe('png');
    expect(captureFile.mock.calls).toEqual([['/schema.prisma'], ['/notes.md']]);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('coalesces concurrent captures and releases the guard after failure', async () => {
    const service = new ScreenshotServiceImpl();
    let reject!: (error: Error) => void;
    const captureElement = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, no) => {
            reject = no;
          })
      )
      .mockResolvedValue('retry');
    service.setCaptureProvider({
      captureElement,
      captureFile: vi.fn().mockResolvedValue('file'),
    });
    const element = document.createElement('div');
    const first = service.captureElement(element);
    const repeated = service.captureElement(element);
    expect(repeated).toBe(first);
    await Promise.resolve();
    reject(new Error('capture failed'));
    await expect(first).rejects.toThrow('capture failed');
    expect(await service.captureElement(element)).toBe('retry');
    expect(captureElement).toHaveBeenCalledTimes(2);
    const file = service.capture('/schema.prisma');
    expect(service.capture('/schema.prisma')).toBe(file);
    await file;
  });

  it('rejects unsupported hosts without cloning the DOM', async () => {
    const service = new ScreenshotServiceImpl();
    const clone = vi.spyOn(document.documentElement, 'cloneNode');
    await expect(service.captureElement(document.body)).rejects.toThrow(
      'not supported'
    );
    expect(clone).not.toHaveBeenCalled();
    clone.mockRestore();
  });
});
