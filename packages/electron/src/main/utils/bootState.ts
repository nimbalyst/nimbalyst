/**
 * Boot State Tracking
 *
 * Provides a way to track whether the main process has completed its
 * initialization sequence. This is useful for:
 *
 * 1. Extension system: Extensions can check if boot is complete before
 *    attempting to use main process services
 *
 * 2. Dynamic imports: Code that runs via dynamic imports can verify
 *    the module cache is populated before proceeding
 *
 * 3. Debugging: Helps identify timing-related issues during startup
 */

let bootComplete = false;
let bootTimestamp: number | null = null;

/**
 * Mark the boot sequence as complete.
 * Should be called after all critical initialization is done,
 * typically after createWindow() returns successfully.
 */
export function markBootComplete(): void {
  if (!bootComplete) {
    bootComplete = true;
    bootTimestamp = Date.now();
    console.log('[Boot] Main process initialization complete');
  }
}

/**
 * Check if the boot sequence has completed.
 * Returns true once markBootComplete() has been called.
 */
export function isBootComplete(): boolean {
  return bootComplete;
}

/**
 * Get the timestamp when boot completed.
 * Returns null if boot hasn't completed yet.
 */
export function getBootTimestamp(): number | null {
  return bootTimestamp;
}

/**
 * Wait for boot to complete.
 * Useful for code that needs to ensure initialization is done.
 *
 * @param timeoutMs Maximum time to wait (default: 30 seconds)
 * @returns Promise that resolves when boot is complete, or rejects on timeout
 */
export function waitForBoot(timeoutMs: number = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (bootComplete) {
      resolve();
      return;
    }

    const startTime = Date.now();
    const checkInterval = setInterval(() => {
      if (bootComplete) {
        clearInterval(checkInterval);
        resolve();
      } else if (Date.now() - startTime > timeoutMs) {
        clearInterval(checkInterval);
        reject(new Error(`Boot did not complete within ${timeoutMs}ms`));
      }
    }, 100);
  });
}
