import type { FileSession } from '../components/TabEditor/DocumentSessionControl';

interface Request {
  revision: number;
  promise: Promise<FileSession[]>;
}
const inFlight = new Map<string, Request>();

/** Share a running read; edits arriving during it collapse into one trailing read. */
export function loadFileSessions(workspaceId: string, filePath: string, revision: number): Promise<FileSession[]> {
  const key = JSON.stringify([workspaceId, filePath]);
  const existing = inFlight.get(key);
  if (existing) {
    existing.revision = Math.max(existing.revision, revision);
    return existing.promise;
  }
  const request: Request = { revision, promise: Promise.resolve([]) };
  inFlight.set(key, request);
  request.promise = (async () => {
    try {
      let rows: FileSession[];
      let startedRevision: number;
      do {
        startedRevision = request.revision;
        rows = await window.electronAPI.invoke('sessions:get-by-file', workspaceId, filePath);
      } while (startedRevision !== request.revision);
      return Array.isArray(rows) ? rows : [];
    } finally {
      inFlight.delete(key);
    }
  })();
  return request.promise;
}
