import JSZip from 'jszip';
import type { TraceData, TraceAction, TraceScreenshot, TraceSnapshot } from './types';

/**
 * Playwright trace events (subset of what appears in the trace file).
 * The trace format uses JSON Lines (one JSON object per line).
 */
interface TraceEvent {
  type: string;
  callId?: string;
  title?: string;
  apiName?: string;
  startTime?: number;
  endTime?: number;
  wallTime?: number;
  duration?: number;
  error?: { message: string };
  stack?: Array<{ file: string; line: number; column: number }>;
  params?: Record<string, unknown>;
  snapshots?: Array<{ title: string; snapshotName: string }>;
  afterSnapshot?: string;
  beforeSnapshot?: string;
  // context-options event
  contextOptions?: Record<string, unknown>;
  // resource events
  resourceId?: number;
  sha1?: string;
  // screenshot event
  pageId?: string;
}

/**
 * Parse a Playwright trace ZIP file into structured trace data.
 */
export async function parseTrace(zipData: ArrayBuffer): Promise<TraceData> {
  const zip = await JSZip.loadAsync(zipData);

  // Find the trace events file (could be named differently across versions)
  const traceFile =
    zip.file('trace.trace') ??
    zip.file('trace.tracing') ??
    zip.file(/\.trace$/i)?.[0] ??
    zip.file(/\.tracing$/i)?.[0];

  if (!traceFile) {
    throw new Error('No trace events file found in ZIP');
  }

  const traceText = await traceFile.async('text');
  const events = parseJsonLines(traceText);

  // Detect if this is an Electron trace
  const isElectron = events.some(
    (e) =>
      e.type === 'context-options' &&
      (e.title?.includes('electron') ||
        JSON.stringify(e.contextOptions ?? {}).includes('electron'))
  ) || events.some(
    (e) => e.title?.toLowerCase().includes('electron') || e.apiName?.includes('electron')
  );

  // Extract actions from before/after event pairs
  const actions = extractActions(events);

  // Extract screenshots from the ZIP
  const screenshots = await extractScreenshots(zip, events, actions);

  // Extract DOM snapshots
  const snapshots = await extractSnapshots(zip, events, actions);

  // Link screenshots and snapshots to actions
  linkResources(actions, screenshots, snapshots);

  // Find any error
  const errorEvent = events.find((e) => e.error);
  const totalDuration =
    actions.length > 0
      ? Math.max(...actions.map((a) => a.endTime)) - Math.min(...actions.map((a) => a.startTime))
      : 0;

  // Try to extract test name from events
  const testNameEvent = events.find(
    (e) => e.type === 'before' && e.title?.includes('.spec')
  );
  const testName = testNameEvent?.title ?? 'Unknown Test';

  return {
    testName,
    actions,
    screenshots,
    snapshots,
    totalDuration,
    error: errorEvent?.error?.message,
    isElectron,
  };
}

function parseJsonLines(text: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as TraceEvent);
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}

function extractActions(events: TraceEvent[]): TraceAction[] {
  const actions: TraceAction[] = [];
  const beforeEvents = new Map<string, TraceEvent>();

  for (const event of events) {
    if (!event.callId) continue;

    if (event.type === 'before') {
      beforeEvents.set(event.callId, event);
    } else if (event.type === 'after') {
      const before = beforeEvents.get(event.callId);
      if (!before) continue;

      const startTime = before.wallTime ?? before.startTime ?? 0;
      const endTime = event.wallTime ?? event.endTime ?? startTime;
      const title = before.title ?? before.apiName ?? event.callId;

      // Skip internal/hook events
      if (event.callId.startsWith('hook@') || title === 'Before Hooks' || title === 'After Hooks') {
        continue;
      }

      const location = before.stack?.[0];

      actions.push({
        actionId: event.callId,
        type: before.apiName ?? 'action',
        title,
        startTime,
        endTime,
        duration: endTime - startTime,
        error: event.error?.message,
        location: location
          ? { file: location.file, line: location.line, column: location.column }
          : undefined,
      });
    }
  }

  return actions.sort((a, b) => a.startTime - b.startTime);
}

async function extractScreenshots(
  zip: JSZip,
  events: TraceEvent[],
  actions: TraceAction[]
): Promise<TraceScreenshot[]> {
  const screenshots: TraceScreenshot[] = [];

  // Find screenshot resources referenced in events
  for (const event of events) {
    if (event.type === 'resource' && event.sha1) {
      // Map resource sha1 to the nearest action
    }
    if (event.type === 'after' && event.callId) {
      // Check for screenshot attachments in params
    }
  }

  // Also scan ZIP for screenshot files directly
  const screenshotFiles = Object.keys(zip.files).filter(
    (name) =>
      (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg')) &&
      !name.startsWith('__MACOSX')
  );

  for (const fileName of screenshotFiles) {
    const file = zip.file(fileName);
    if (!file) continue;

    const blob = await file.async('blob');
    const blobUrl = URL.createObjectURL(blob);

    // Try to associate with an action by timestamp or index
    const index = screenshots.length;
    const associatedAction = actions[Math.min(index, actions.length - 1)];

    screenshots.push({
      actionId: associatedAction?.actionId ?? `screenshot-${index}`,
      blobUrl,
      timestamp: associatedAction?.startTime ?? 0,
    });
  }

  return screenshots;
}

async function extractSnapshots(
  zip: JSZip,
  _events: TraceEvent[],
  actions: TraceAction[]
): Promise<TraceSnapshot[]> {
  const snapshots: TraceSnapshot[] = [];

  // Look for snapshot HTML files in the ZIP
  const snapshotFiles = Object.keys(zip.files).filter(
    (name) => name.endsWith('.html') && !name.startsWith('__MACOSX')
  );

  for (const fileName of snapshotFiles) {
    const file = zip.file(fileName);
    if (!file) continue;

    const html = await file.async('text');
    if (!html.trim()) continue;

    // Try to associate snapshot with an action
    const index = snapshots.length;
    const associatedAction = actions[Math.min(index, actions.length - 1)];

    snapshots.push({
      actionId: associatedAction?.actionId ?? `snapshot-${index}`,
      html,
    });
  }

  return snapshots;
}

function linkResources(
  actions: TraceAction[],
  screenshots: TraceScreenshot[],
  snapshots: TraceSnapshot[]
) {
  // Build lookup maps
  const screenshotByAction = new Map<string, number>();
  screenshots.forEach((s, i) => {
    if (!screenshotByAction.has(s.actionId)) {
      screenshotByAction.set(s.actionId, i);
    }
  });

  const snapshotByAction = new Map<string, number>();
  snapshots.forEach((s, i) => {
    if (!snapshotByAction.has(s.actionId)) {
      snapshotByAction.set(s.actionId, i);
    }
  });

  for (const action of actions) {
    const screenshotIdx = screenshotByAction.get(action.actionId);
    if (screenshotIdx !== undefined) {
      action.screenshotIndex = screenshotIdx;
    }
    const snapshotIdx = snapshotByAction.get(action.actionId);
    if (snapshotIdx !== undefined) {
      action.snapshotIndex = snapshotIdx;
    }
  }
}

/** Clean up blob URLs when trace data is no longer needed */
export function revokeTraceUrls(data: TraceData) {
  for (const screenshot of data.screenshots) {
    URL.revokeObjectURL(screenshot.blobUrl);
  }
}
