export type TrackerDeepLinkView = 'document';

export interface TrackerDeepLinkTarget {
  trackerId: string;
  orgId: string;
  view?: TrackerDeepLinkView;
}

/**
 * Parse and validate a tracker deep link at the main-process routing boundary.
 */
export function parseTrackerDeepLink(rawUrl: string): TrackerDeepLinkTarget {
  const parsed = new URL(rawUrl);
  const isTrackerRoute = parsed.protocol === 'nimbalyst:'
    && (parsed.host === 'tracker' || parsed.pathname.startsWith('/tracker/'));
  if (!isTrackerRoute) {
    throw new Error('URL is not a Nimbalyst tracker deep link');
  }

  const encodedTrackerId = parsed.host === 'tracker'
    ? parsed.pathname.replace(/^\//, '')
    : parsed.pathname.replace('/tracker/', '');

  let trackerId: string;
  try {
    trackerId = decodeURIComponent(encodedTrackerId);
  } catch {
    throw new Error('Tracker deep link has a malformed trackerId');
  }

  const orgId = parsed.searchParams.get('orgId');
  if (!trackerId || !orgId) {
    throw new Error('Tracker deep link requires trackerId and orgId');
  }

  const rawView = parsed.searchParams.get('view');
  if (rawView !== null && rawView !== 'document') {
    throw new Error(`Tracker deep link has unsupported view: ${rawView}`);
  }

  return {
    trackerId,
    orgId,
    ...(rawView === 'document' ? { view: rawView } : {}),
  };
}
