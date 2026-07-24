/**
 * Agentic Streaming Simulator - Test utility for simulating AI streaming in Agentic Coding Window
 *
 * This utility allows tests to simulate real-time AI streaming responses
 * in the agentic coding transcript without requiring actual AI API calls.
 */

import type { Page } from '@playwright/test';

export interface StreamChunk {
  text: string;
  delayMs?: number;
}

export interface StreamOptions {
  sessionId?: string;
  delayBetweenChunks?: number;
  includeToolCalls?: boolean;
  includeCompletion?: boolean;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, any>;
    result?: any;
  }>;
}

/**
 * Simulate AI streaming by directly setting React state
 * This bypasses IPC and directly manipulates the component's streaming state
 *
 * @example
 * ```typescript
 * await simulateAgenticStreaming(page, [
 *   'First chunk ',
 *   'second chunk ',
 *   'final chunk'
 * ], {
 *   delayBetweenChunks: 100,
 *   includeCompletion: true
 * });
 * ```
 */
export async function simulateAgenticStreaming(
  page: Page,
  chunks: string[] | StreamChunk[],
  options: StreamOptions = {}
): Promise<{ success: boolean; totalEvents: number }> {
  const {
    delayBetweenChunks = 50,
    includeCompletion = true
  } = options;

  // Normalize chunks to objects
  const normalizedChunks: StreamChunk[] = chunks.map(chunk =>
    typeof chunk === 'string' ? { text: chunk, delayMs: delayBetweenChunks } : chunk
  );

  let accumulated = '';

  // Stream text chunks by directly updating the DOM/React state
  for (const chunk of normalizedChunks) {
    accumulated += chunk.text;

    // Inject streaming content directly into the component
    await page.evaluate((content) => {
      // Trigger a custom event that we'll use to update the UI
      window.dispatchEvent(new CustomEvent('test-set-streaming', {
        detail: { content }
      }));
    }, accumulated);

    if (chunk.delayMs) {
      await page.waitForTimeout(chunk.delayMs);
    }
  }

  // Clear streaming on completion
  if (includeCompletion) {
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('test-clear-streaming'));
    });
  }

  return { success: true, totalEvents: normalizedChunks.length };
}

/**
 * Set up the agentic window with test utilities for streaming simulation
 * Call this AFTER finding the window but BEFORE running tests
 */
export async function setupStreamHandlerCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Store streaming content and active session ID for test mode
    (window as any).__testStreamingContent = null;
    (window as any).__testActiveSessionId = null;

    // Expose test API for setting streaming content
    (window as any).__testSetStreaming = (content: string) => {
      (window as any).__testStreamingContent = content;
      // Trigger re-render by dispatching event
      window.dispatchEvent(new Event('test-streaming-updated'));
    };

    (window as any).__testClearStreaming = () => {
      (window as any).__testStreamingContent = null;
      window.dispatchEvent(new Event('test-streaming-updated'));
    };

    // Listen for test events
    window.addEventListener('test-set-streaming', ((event: CustomEvent) => {
      (window as any).__testSetStreaming(event.detail.content);
    }) as EventListener);

    window.addEventListener('test-clear-streaming', () => {
      (window as any).__testClearStreaming();
    });
  });
}

/**
 * Check if streaming indicator is visible
 */
export async function hasStreamingIndicator(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const text = document.body.textContent || '';
    return text.includes('streaming...');
  });
}

/**
 * Check if transcript contains specific text
 */
export async function transcriptContains(page: Page, searchText: string): Promise<boolean> {
  return await page.evaluate((text) => {
    const transcript = document.querySelector('[class*="transcript"]') ||
                      document.querySelector('.rich-transcript-view') ||
                      document.body;
    const content = transcript?.textContent || '';
    return content.includes(text);
  }, searchText);
}

/**
 * Get the current input value in the active tab
 */
export async function getAgenticInput(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const input = document.querySelector('textarea[placeholder*="Type your message"]') as HTMLTextAreaElement;
    return input?.value || '';
  });
}

/**
 * Set the input value in the active tab
 */
export async function setAgenticInput(page: Page, value: string): Promise<void> {
  await page.evaluate((val) => {
    const input = document.querySelector('textarea[placeholder*="Type your message"]') as HTMLTextAreaElement;
    if (input) {
      input.value = val;
      // Trigger change events
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, value);
}

/**
 * Wait for streaming to complete (no streaming indicator)
 */
export async function waitForStreamingComplete(
  page: Page,
  timeoutMs = 5000
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const isStreaming = await hasStreamingIndicator(page);
    if (!isStreaming) {
      return true;
    }
    await page.waitForTimeout(100);
  }

  return false;
}

/**
 * Simulate a complete message exchange (user message + AI streaming response)
 */
export async function simulateMessageExchange(
  page: Page,
  userMessage: string,
  aiResponseChunks: string[],
  options: StreamOptions = {}
): Promise<void> {
  // Set user message
  await setAgenticInput(page, userMessage);
  await page.waitForTimeout(100);

  // Simulate AI streaming response
  await simulateAgenticStreaming(page, aiResponseChunks, {
    ...options,
    includeCompletion: true
  });

  // Wait for streaming to complete
  await waitForStreamingComplete(page);
}
