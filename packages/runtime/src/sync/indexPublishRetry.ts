import type { PushChangeOutcome } from './types';

/**
 * Bounded retry for an index publish that lost a race.
 *
 * A metadata publish that comes back with "index state changed during
 * publication" was built against a cache another writer replaced while this one
 * was encrypting. Re-merging against the newer state is right; doing it in an
 * unbounded `while` with no yield is not -- a session under a steady stream of
 * remote updates keeps losing the race, and the loop then holds the per-session
 * publish queue and the microtask queue for as long as the stream lasts.
 */

/** Reason a publish reports when it lost the race against a newer cache write. */
export const INDEX_STATE_CHANGED_REASON = 'index state changed during publication';

/** How many times a publish may re-merge against a newer cache before giving up. */
export const MAX_INDEX_PUBLISH_ATTEMPTS = 5;

/** Hand the event loop back between attempts so the winning writer can settle. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export interface BoundedIndexPublishOptions {
  /**
   * Whether another attempt is still worth making -- the caller checks that the
   * connection generation has not moved and the index is still connected.
   */
  shouldRetry: () => boolean;
  /** Attempt cap, including the first attempt. Defaults to `MAX_INDEX_PUBLISH_ATTEMPTS`. */
  maxAttempts?: number;
  /** Seam for tests; production yields a macrotask. */
  yieldBetweenAttempts?: () => Promise<void>;
}

/**
 * Run `attempt` until it stops reporting a lost race, `shouldRetry` goes false,
 * or the attempt cap is reached. Hitting the cap is reported as NON-retryable:
 * the caller has already tried repeatedly and a further immediate attempt would
 * lose to the same writer.
 */
export async function publishWithBoundedRetry(
  attempt: () => Promise<PushChangeOutcome>,
  options: BoundedIndexPublishOptions,
): Promise<PushChangeOutcome> {
  const maxAttempts = options.maxAttempts ?? MAX_INDEX_PUBLISH_ATTEMPTS;
  const pause = options.yieldBetweenAttempts ?? yieldToEventLoop;

  let outcome = await attempt();
  let attempts = 1;

  while (outcome.reason === INDEX_STATE_CHANGED_REASON && options.shouldRetry()) {
    if (attempts >= maxAttempts) {
      return {
        published: false,
        reason: `${INDEX_STATE_CHANGED_REASON} on ${attempts} consecutive attempts`,
        retryable: false,
      };
    }
    await pause();
    // Re-read the fence on the far side of the yield. A reconnect landing
    // during the backoff replaces the socket and moves the connection
    // generation; an attempt started after that publishes this obsolete intent
    // onto the replacement socket, over whatever the new connection has since
    // written. Not retryable here: the intent belongs to a connection that is
    // gone, and whoever owns the new one republishes from current state.
    if (!options.shouldRetry()) {
      return {
        published: false,
        reason: 'index connection changed during publish backoff',
        retryable: false,
      };
    }
    outcome = await attempt();
    attempts++;
  }

  return outcome;
}
