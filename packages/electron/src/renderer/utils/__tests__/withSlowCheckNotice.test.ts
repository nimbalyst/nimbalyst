// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { withSlowCheckNotice } from '../withSlowCheckNotice';

vi.mock('../../services/ErrorNotificationService', () => ({
  errorNotificationService: { showInfo: vi.fn(() => 'notice-1'), dismiss: vi.fn() },
}));

describe('withSlowCheckNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(errorNotificationService.showInfo).mockClear();
    vi.mocked(errorNotificationService.dismiss).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the notice once the work runs past the delay, then removes it when the work ends', async () => {
    let finish!: (value: string) => void;
    const work = new Promise<string>((resolve) => { finish = resolve; });
    const result = withSlowCheckNotice(work, 'Checking', 'Checking "wt"...', 1000);

    await vi.advanceTimersByTimeAsync(999);
    expect(errorNotificationService.showInfo).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(errorNotificationService.showInfo).toHaveBeenCalledTimes(1);
    expect(errorNotificationService.showInfo).toHaveBeenCalledWith(
      'Checking',
      'Checking "wt"...',
      expect.objectContaining({ duration: expect.any(Number) }),
    );
    expect(errorNotificationService.dismiss).not.toHaveBeenCalled();

    finish('done');
    expect(await result).toBe('done');
    expect(errorNotificationService.dismiss).toHaveBeenCalledWith('notice-1');
  });

  it('shows nothing when the work finishes before the delay', async () => {
    const result = withSlowCheckNotice(Promise.resolve(42), 'Checking', 'msg', 1000);
    expect(await result).toBe(42);

    await vi.advanceTimersByTimeAsync(5000);
    expect(errorNotificationService.showInfo).not.toHaveBeenCalled();
    expect(errorNotificationService.dismiss).not.toHaveBeenCalled();
  });

  it('removes the notice and passes the error on when the work fails', async () => {
    let fail!: (error: Error) => void;
    const work = new Promise<string>((_resolve, reject) => { fail = reject; });
    const result = withSlowCheckNotice(work, 'Checking', 'msg', 1000);
    const caught = result.then(() => { throw new Error('expected the work to fail'); }, (error: Error) => error);

    await vi.advanceTimersByTimeAsync(1000);
    expect(errorNotificationService.showInfo).toHaveBeenCalledTimes(1);

    fail(new Error('fetch failed'));
    expect((await caught).message).toBe('fetch failed');
    expect(errorNotificationService.dismiss).toHaveBeenCalledWith('notice-1');
  });
});
