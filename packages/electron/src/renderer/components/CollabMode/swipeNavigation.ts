/**
 * Two-finger swipe to go Back and Forward in Pages, recognized from trackpad
 * wheel events. Electron reports no gesture phases for a two-finger swipe
 * (its `swipe` event is the legacy three-finger one), so a gesture here is a
 * run of wheel events with no gap longer than `gestureGapMs`. Fingers moving
 * right (negative deltaX) go Back, as in a browser.
 *
 * A gesture is decided once, from its first few events: mostly horizontal,
 * nothing under the pointer that could scroll that way, and somewhere to go.
 * Anything else ignores the whole gesture, so a horizontal scroll that reaches
 * the edge of a wide table never turns into navigation midway.
 */

export type SwipeDirection = -1 | 1;

export interface SwipeSample {
  deltaX: number;
  deltaY: number;
  /** Event time in ms (`event.timeStamp`). */
  time: number;
  /**
   * Whether something under the pointer can still scroll horizontally the way
   * this event moves. Called only while a gesture is being decided: it reads layout.
   */
  contentScrolls: () => boolean;
}

export type SwipeUpdate =
  | { kind: 'none' }
  | { kind: 'progress'; direction: SwipeDirection; progress: number }
  | { kind: 'navigate'; direction: SwipeDirection };

export interface SwipeNavigationOptions {
  /** Whether Back (-1) or Forward (1) has anywhere to go. */
  canNavigate: (direction: SwipeDirection) => boolean;
  /** Horizontal travel, in CSS px, that commits the navigation. */
  threshold?: number;
  /** A pause longer than this ends the gesture. */
  gestureGapMs?: number;
}

export const SWIPE_THRESHOLD_PX = 160;
export const SWIPE_GESTURE_GAP_MS = 200;
// Travel before the axis is judged; a few px of either axis is noise.
const DECISION_DISTANCE_PX = 12;
// Horizontal must clearly dominate, or a diagonal scroll would navigate.
const HORIZONTAL_DOMINANCE = 2;

type Phase = 'idle' | 'deciding' | 'tracking' | 'finished';

export class SwipeNavigationRecognizer {
  private phase: Phase = 'idle';
  private lastTime = Number.NEGATIVE_INFINITY;
  private sumX = 0;
  private sumY = 0;
  private direction: SwipeDirection = -1;
  private travel = 0;
  private readonly threshold: number;
  private readonly gestureGapMs: number;

  constructor(private readonly options: SwipeNavigationOptions) {
    this.threshold = options.threshold ?? SWIPE_THRESHOLD_PX;
    this.gestureGapMs = options.gestureGapMs ?? SWIPE_GESTURE_GAP_MS;
  }

  feed(sample: SwipeSample): SwipeUpdate {
    if (sample.time - this.lastTime > this.gestureGapMs) this.reset();
    this.lastTime = sample.time;

    if (this.phase === 'finished') return { kind: 'none' };
    if (this.phase === 'idle') {
      this.phase = 'deciding';
      this.sumX = 0;
      this.sumY = 0;
    }

    if (this.phase === 'deciding') {
      this.sumX += sample.deltaX;
      this.sumY += sample.deltaY;
      if (Math.abs(this.sumX) + Math.abs(this.sumY) < DECISION_DISTANCE_PX) return { kind: 'none' };
      const direction: SwipeDirection = this.sumX < 0 ? -1 : 1;
      const horizontal = Math.abs(this.sumX) > HORIZONTAL_DOMINANCE * Math.abs(this.sumY);
      if (!horizontal || sample.contentScrolls() || !this.options.canNavigate(direction)) {
        this.phase = 'finished';
        return { kind: 'none' };
      }
      this.phase = 'tracking';
      this.direction = direction;
      this.travel = 0;
      return this.advance(this.sumX);
    }

    return this.advance(sample.deltaX);
  }

  /** Ends the gesture; the next event starts a new one. */
  reset(): void {
    this.phase = 'idle';
    this.travel = 0;
  }

  private advance(deltaX: number): SwipeUpdate {
    // Swiping back the other way undoes travel, which is how a swipe is cancelled.
    this.travel = Math.max(0, this.travel + deltaX * this.direction);
    const progress = this.travel / this.threshold;
    if (progress < 1) return { kind: 'progress', direction: this.direction, progress };
    this.phase = 'finished';
    return { kind: 'navigate', direction: this.direction };
  }
}

/**
 * Whether an element between `target` and `boundary` (inclusive) can still
 * scroll horizontally the way a wheel event moves: -1 for a negative deltaX
 * (toward the left edge), 1 toward the right edge.
 */
export function canScrollHorizontally(target: Element | null, boundary: Element, direction: SwipeDirection): boolean {
  for (let element = target; element; element = element.parentElement) {
    if (element.scrollWidth > element.clientWidth + 1) {
      const style = getComputedStyle(element);
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') {
        const maxScroll = element.scrollWidth - element.clientWidth;
        // RTL containers report scrollLeft from 0 at the right edge down to -maxScroll.
        const fromLeft = style.direction === 'rtl' ? maxScroll + element.scrollLeft : element.scrollLeft;
        const room = direction === -1 ? fromLeft : maxScroll - fromLeft;
        if (room > 0.5) return true;
      }
    }
    if (element === boundary) break;
  }
  return false;
}
