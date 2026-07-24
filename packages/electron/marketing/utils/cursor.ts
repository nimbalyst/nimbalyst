/**
 * Marketing Cursor - DOM-injected fake macOS cursor for video capture.
 *
 * Injects a cursor element into the page that moves smoothly between
 * click targets with easing animations. Works with Playwright's built-in
 * video recording since the cursor is part of the DOM.
 */

import type { Page } from 'playwright';

// macOS arrow cursor as inline SVG
const CURSOR_ARROW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <g filter="url(#shadow)">
    <path d="M5 3l14 8.5-6 1.5-3.5 5.5z" fill="white" stroke="black" stroke-width="1.2" stroke-linejoin="round"/>
  </g>
  <defs>
    <filter id="shadow" x="-2" y="-2" width="28" height="28">
      <feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity="0.3"/>
    </filter>
  </defs>
</svg>`;

// macOS pointer (hand) cursor as inline SVG
const CURSOR_POINTER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <g filter="url(#shadow)">
    <path d="M9 3.5v9l-2.5-2.5c-.7-.7-1.8-.7-2.5 0s-.7 1.8 0 2.5L9.5 18c1 1 2.4 1.5 3.8 1.5H15c2.8 0 5-2.2 5-5v-3.5c0-1.1-.9-2-2-2h-.1c-.1-.9-.8-1.6-1.7-1.8-.2-.9-1-1.7-2-1.7h-.2c-.2-1-1.1-1.8-2.2-1.8-.5 0-.9.2-1.3.4V3.5C10.5 2.7 9.8 2 9 2s-1 .7-1 1.5z" fill="white" stroke="black" stroke-width="1" stroke-linejoin="round"/>
  </g>
  <defs>
    <filter id="shadow" x="-2" y="-2" width="28" height="28">
      <feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity="0.3"/>
    </filter>
  </defs>
</svg>`;

export interface CursorOptions {
  /** Duration of movement animation in ms. Default: 400 */
  moveDuration?: number;
  /** Show click ripple effect. Default: true */
  showClickEffect?: boolean;
  /** Offset from element center. Default: { x: 0, y: 0 } */
  offset?: { x: number; y: number };
}

/**
 * Inject the fake cursor element into the page.
 * Call this once after page load, before any cursor movements.
 */
export async function injectCursor(page: Page): Promise<void> {
  await page.evaluate(({ arrowSvg, pointerSvg }) => {
    // Remove existing cursor if re-injecting
    document.getElementById('marketing-cursor')?.remove();
    document.getElementById('marketing-cursor-styles')?.remove();

    // Add styles
    const style = document.createElement('style');
    style.id = 'marketing-cursor-styles';
    style.textContent = `
      #marketing-cursor {
        position: fixed;
        top: 0;
        left: 0;
        z-index: 999999;
        pointer-events: none;
        will-change: transform;
        transition: transform cubic-bezier(0.25, 0.1, 0.25, 1.0);
        transform: translate(-100px, -100px);
      }
      #marketing-cursor img,
      #marketing-cursor svg {
        width: 24px;
        height: 24px;
      }
      #marketing-cursor-click {
        position: fixed;
        z-index: 999998;
        pointer-events: none;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.15);
        transform: translate(-50%, -50%) scale(0);
        opacity: 0;
      }
      #marketing-cursor-click.active {
        animation: marketing-cursor-click-anim 0.4s ease-out forwards;
      }
      @keyframes marketing-cursor-click-anim {
        0% { transform: translate(-50%, -50%) scale(0.3); opacity: 0.6; }
        100% { transform: translate(-50%, -50%) scale(1.5); opacity: 0; }
      }
    `;
    document.head.appendChild(style);

    // Create cursor element
    const cursor = document.createElement('div');
    cursor.id = 'marketing-cursor';
    cursor.innerHTML = arrowSvg;
    document.body.appendChild(cursor);

    // Create click effect element
    const click = document.createElement('div');
    click.id = 'marketing-cursor-click';
    document.body.appendChild(click);

    // Store SVGs for cursor type switching
    (window as any).__marketingCursor = {
      arrowSvg,
      pointerSvg,
      currentType: 'arrow',
    };
  }, { arrowSvg: CURSOR_ARROW_SVG, pointerSvg: CURSOR_POINTER_SVG });
}

/**
 * Smoothly move the cursor to a target element's center.
 * Uses Playwright locator to find the element (supports :has-text and other Playwright selectors),
 * then passes coordinates to the DOM for animation.
 */
export async function moveTo(
  page: Page,
  selector: string,
  options?: Pick<CursorOptions, 'moveDuration' | 'offset'>
): Promise<void> {
  const duration = options?.moveDuration ?? 400;
  const offset = options?.offset ?? { x: 0, y: 0 };

  // Use Playwright locator to get bounding box (supports :has-text etc.)
  const element = page.locator(selector).first();
  const box = await element.boundingBox();
  if (!box) {
    console.warn(`[MarketingCursor] Target not found or not visible: ${selector}`);
    return;
  }

  const x = box.x + box.width / 2 + offset.x;
  const y = box.y + box.height / 2 + offset.y;

  // Check if element is clickable to determine cursor type
  const isClickable = await element.evaluate(el =>
    el.matches('a, button, [role="button"], input, select, textarea, [onclick], .tab, .file-tree-name, .session-list-item, .settings-category-item, [data-mode]')
  );

  await page.evaluate(({ targetX, targetY, dur, clickable }) => {
    const cursor = document.getElementById('marketing-cursor');
    if (!cursor) return;

    cursor.style.transitionDuration = `${dur}ms`;

    const cursorState = (window as any).__marketingCursor;
    if (cursorState) {
      const newType = clickable ? 'pointer' : 'arrow';
      if (newType !== cursorState.currentType) {
        cursor.innerHTML = newType === 'pointer' ? cursorState.pointerSvg : cursorState.arrowSvg;
        cursorState.currentType = newType;
      }
    }

    cursor.style.transform = `translate(${targetX}px, ${targetY}px)`;
  }, { targetX: x, targetY: y, dur: duration, clickable: isClickable });

  // Wait for animation to complete
  await page.waitForTimeout(duration + 50);
}

/**
 * Move to an element and click it, with a visual click effect.
 */
export async function moveAndClick(
  page: Page,
  selector: string,
  options?: CursorOptions
): Promise<void> {
  const duration = options?.moveDuration ?? 400;
  const showClick = options?.showClickEffect ?? true;

  // Move cursor to target
  await moveTo(page, selector, { moveDuration: duration, offset: options?.offset });

  // Brief hover pause before clicking
  await page.waitForTimeout(100);

  // Show click effect
  if (showClick) {
    const element = page.locator(selector).first();
    const box = await element.boundingBox();
    if (box) {
      const clickX = box.x + box.width / 2;
      const clickY = box.y + box.height / 2;
      await page.evaluate(({ x, y }) => {
        const clickEl = document.getElementById('marketing-cursor-click');
        if (!clickEl) return;
        clickEl.style.left = `${x}px`;
        clickEl.style.top = `${y}px`;
        clickEl.classList.remove('active');
        void clickEl.offsetWidth;
        clickEl.classList.add('active');
      }, { x: clickX, y: clickY });
    }
  }

  // Actually click the element via Playwright
  await page.locator(selector).first().click();

  // Wait for click animation
  await page.waitForTimeout(showClick ? 300 : 100);
}

/**
 * Hide the cursor (e.g., during typing sequences).
 */
export async function hideCursor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const cursor = document.getElementById('marketing-cursor');
    if (cursor) cursor.style.opacity = '0';
  });
}

/**
 * Show the cursor after hiding.
 */
export async function showCursor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const cursor = document.getElementById('marketing-cursor');
    if (cursor) cursor.style.opacity = '1';
  });
}

/**
 * Move the cursor off-screen (initial position or between scenes).
 */
export async function resetCursor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const cursor = document.getElementById('marketing-cursor');
    if (cursor) {
      cursor.style.transitionDuration = '0ms';
      cursor.style.transform = 'translate(-100px, -100px)';
    }
  });
}
