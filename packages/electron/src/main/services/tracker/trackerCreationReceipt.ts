import { createHash } from 'crypto';
import { database } from '../../database/PGLiteDatabaseWorker';

export type CreationPublicationStatus = 'local' | 'pending' | 'published';
export interface CreationReceipt {
  item_id: string;
  workspace: string;
  request_hash: string;
  publication_status: CreationPublicationStatus;
  error: string | null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonical(v)]),
    );
  }
  return value;
}

export function creationRequestHash(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(payload)))
    .digest('hex');
}

const active = new Map<string, Promise<unknown>>();
/** Serialize retries of the same item; unrelated creations remain independent. */
export function withCreationLock<T>(
  workspace: string,
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([workspace, id]);
  const prior = active.get(key) ?? Promise.resolve();
  const result = prior.catch(() => undefined).then(operation);
  active.set(key, result);
  return result.finally(() => {
    if (active.get(key) === result) active.delete(key);
  });
}

export async function getCreationReceipt(
  workspace: string,
  itemId: string,
): Promise<CreationReceipt | undefined> {
  const result = await database.query<CreationReceipt>(
    'SELECT * FROM tracker_creation_receipts WHERE item_id = $1 AND workspace = $2',
    [itemId, workspace],
  );
  return result.rows[0];
}

export async function setCreationPublication(
  workspace: string,
  itemId: string,
  status: CreationPublicationStatus,
  error: string | null = null,
): Promise<void> {
  await database.query(
    'UPDATE tracker_creation_receipts SET publication_status = $1, error = $2, updated = NOW() WHERE item_id = $3 AND workspace = $4',
    [status, error, itemId, workspace],
  );
}
