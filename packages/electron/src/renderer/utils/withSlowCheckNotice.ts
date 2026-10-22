import { errorNotificationService } from '../services/ErrorNotificationService';

// Backstop only: the notice normally goes away the moment the check ends.
// It is longer than the 15 s the status check can take, so it never vanishes early.
const NOTICE_BACKSTOP_MS = 30_000;

/**
 * Wait for a slow check and tell the user about it.
 * If `work` is still running after `delayMs`, show an info notice; remove the
 * notice when `work` ends, whether it worked or failed. Quick checks show
 * nothing. The result, or the error, passes through unchanged. See #282.
 */
export async function withSlowCheckNotice<T>(
  work: Promise<T>,
  title: string,
  message: string,
  delayMs = 1000,
): Promise<T> {
  let noticeId: string | undefined;
  const timer = setTimeout(() => {
    noticeId = errorNotificationService.showInfo(title, message, { duration: NOTICE_BACKSTOP_MS });
  }, delayMs);

  try {
    return await work;
  } finally {
    clearTimeout(timer);
    if (noticeId) errorNotificationService.dismiss(noticeId);
  }
}
