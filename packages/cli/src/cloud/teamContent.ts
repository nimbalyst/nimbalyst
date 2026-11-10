/**
 * Writes what `pages_import` cannot carry into the team documents it
 * registered: each editor page's content, through its document room with the
 * editor's own codec, and the files markdown pages link to, through the
 * document asset route.
 *
 * Both authenticate with a `pages_import_token` credential (15 minutes, this
 * project's documents only), asked for again shortly before it lapses. The
 * room client and codecs come from the editors' document code
 * (`editor-models.mjs`), the same bundle the editor tools load.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { PagesImportTokenResult } from '@nimbalyst/collab-protocol';
import type { EditorModels } from '../mcp/editorTools.js';
import type { ToolCaller } from './teamImport.js';

export type ContentFailure = { ok: false; code: string; message: string };

export interface TeamContentWriter {
  writeEditorPage(page: { localId: string; documentId: string; documentType: string; text: string }): Promise<
    { ok: true; outcome: 'seeded' | 'applied' | 'unchanged' } | ContentFailure
  >;
  uploadFile(file: { documentId: string; abs: string }): Promise<{ ok: true; uri: string } | ContentFailure>;
  /** Opens a team document's room, hands its Y.Doc to `read`, and closes it; nothing is written. */
  readRoom?<T>(documentId: string, read: (doc: unknown) => T): Promise<{ ok: true; value: T } | ContentFailure>;
}

/** The server's per-asset limit (`documentAssetFormat.ts` in the collab server). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const FLUSH_TIMEOUT_MS = 15_000;
/** Ask for a new credential when the current one has less than this left. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

// Wire names from `packages/runtime/src/sync/collabAssetFormat.ts`, which nim does not bundle.
const ASSET_HEADER_WIRE_FORMAT = 'X-Collab-Asset-Format';
const ASSET_WIRE_FORMAT_PLAINTEXT = 'plaintext.v1';
const ASSET_HEADER_FILE_NAME = 'X-Collab-Asset-File-Name';
const ASSET_HEADER_MIME = 'X-Collab-Asset-Mime-Type';
const ASSET_HEADER_PLAINTEXT_SIZE = 'X-Collab-Asset-Plaintext-Size';

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.json': 'application/json',
};

/** An asset id from the file's bytes, so uploading the same file again replaces it rather than adding a copy. */
export function assetIdFor(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

/** The uri an upload of `bytes` into a team document gets, as `buildCollabAssetUri` (runtime `editor/utils/collabAssetUri.ts`) writes it. */
export function assetUriFor(documentId: string, bytes: Uint8Array): string {
  // A typed page's `tracker-content/<id>` is one segment.
  return `collab-asset://doc/${encodeURIComponent(documentId)}/asset/${encodeURIComponent(assetIdFor(bytes))}`;
}

export function syncUrlFor(server: string): string {
  return server.replace(/^http(s?):\/\//, (_match, secure: string) => `ws${secure}://`);
}

export interface TeamContentOptions {
  server: string;
  call: ToolCaller;
  /** The routing arguments every tool call takes (`repo`, `project`). */
  base: Record<string, unknown>;
  /** Null when the editors' document code is not available; editor pages are then skipped before the import. */
  models: EditorModels | null;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long to wait for a room's first sync. */
  connectTimeoutMs?: number;
}

export function createTeamContentWriter(options: TeamContentOptions): TeamContentWriter {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let credential: PagesImportTokenResult | null = null;

  const currentCredential = async (forceRefresh = false): Promise<PagesImportTokenResult> => {
    if (!forceRefresh && credential && credential.expiresAt - now() > TOKEN_REFRESH_MARGIN_MS) return credential;
    const issued = (await options.call('pages_import_token', options.base)) as Partial<PagesImportTokenResult> | undefined;
    if (!issued?.token || !issued.memberId || !issued.orgId || typeof issued.expiresAt !== 'number') {
      throw new Error('pages_import_token returned no credential');
    }
    credential = issued as PagesImportTokenResult;
    return credential;
  };

  type RoomProvider = InstanceType<EditorModels['DocumentSyncProvider']>;
  /** Opens the room, waits for its first sync, runs `use`, and always closes it. */
  const withRoom = async <R>(documentId: string, use: (provider: RoomProvider, serverEmpty: boolean) => Promise<R | ContentFailure>): Promise<R | ContentFailure> => {
    const models = options.models;
    if (!models) return { ok: false, code: 'editor_code_unavailable', message: "The editors' document code is not installed." };
    const issued = await currentCredential();
    /** The server's answer, at first sync, to whether the room held anything. */
    let resolveFirstSync!: (serverEmpty: boolean) => void;
    const firstSync = new Promise<boolean>((resolve) => {
      resolveFirstSync = resolve;
    });
    const provider = new models.DocumentSyncProvider({
      serverUrl: syncUrlFor(options.server),
      getJwt: async (opts?: { forceRefresh?: boolean }) => (await currentCredential(opts?.forceRefresh === true)).token,
      orgId: issued.orgId,
      teamMemberId: issued.memberId,
      documentId,
      onFirstSyncComplete: (isEmpty) => resolveFirstSync(isEmpty),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await provider.connect();
      // Only the room's first sync says what it holds; a timeout is never read as an empty room.
      const serverEmpty = await Promise.race([
        firstSync,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
        }),
      ]);
      if (serverEmpty === null) {
        const status = provider.getLastAuthRejectionStatus();
        return {
          ok: false,
          code: status === null ? 'room_unavailable' : 'room_refused',
          message: status === null ? 'Timed out opening the team document.' : `The server refused the team document (status ${status}).`,
        };
      }
      // A snapshot or update the client could not read leaves the doc short of what the room holds; acting on it is blind.
      if (provider.hasUndecodedContent()) {
        return { ok: false, code: 'room_unreadable', message: 'Part of the team document could not be read, so nim did not act on it.' };
      }
      return await use(provider, serverEmpty);
    } catch (err) {
      return { ok: false, code: 'write_failed', message: err instanceof Error ? err.message : String(err) };
    } finally {
      if (timer) clearTimeout(timer);
      try {
        provider.destroy();
      } catch {
        // Teardown of a socket that already closed; nothing left to release.
      }
    }
  };

  return {
    async writeEditorPage(page) {
      return withRoom(page.documentId, async (provider, serverEmpty) => {
        const outcome = options.models!.editorCodecs.writeDoc(page.documentType, provider.getYDoc(), page.text, { roomHadState: !serverEmpty });
        if (outcome === 'edited') {
          return { ok: false, code: 'body_edited', message: 'Someone has changed this page in the team since the move wrote it (or it already had other content), so it was not overwritten.' };
        }
        if (outcome !== 'unchanged' && !(await provider.flushWithAck(FLUSH_TIMEOUT_MS))) {
          return { ok: false, code: 'write_unconfirmed', message: 'The server did not confirm the page content was saved; run the move again.' };
        }
        return { ok: true, outcome };
      });
    },

    async readRoom(documentId, read) {
      return withRoom(documentId, async (provider) => ({ ok: true as const, value: read(provider.getYDoc()) }));
    },

    async uploadFile(file) {
      const size = (await stat(file.abs)).size;
      if (size > MAX_UPLOAD_BYTES) {
        return { ok: false, code: 'file_too_large', message: `${Math.round(size / (1024 * 1024))} MB, over the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB a team page attachment can be; the link is left as written.` };
      }
      const bytes = await readFile(file.abs);
      const assetId = assetIdFor(bytes);
      const name = path.basename(file.abs);
      const url = `${options.server}/api/collab/docs/${encodeURIComponent(file.documentId)}/assets/${assetId}`;
      const put = async (token: string) =>
        fetchImpl(url, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            [ASSET_HEADER_WIRE_FORMAT]: ASSET_WIRE_FORMAT_PLAINTEXT,
            // Header values are latin-1 on the wire; percent-encoded so any file name survives.
            [ASSET_HEADER_FILE_NAME]: encodeURIComponent(name.slice(0, 200)),
            [ASSET_HEADER_MIME]: MIME_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
            [ASSET_HEADER_PLAINTEXT_SIZE]: String(bytes.byteLength),
          },
          body: bytes,
        });
      try {
        let res = await put((await currentCredential()).token);
        // A credential that lapsed between the check and the request: one fresh try.
        if (res.status === 401) res = await put((await currentCredential(true)).token);
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          return { ok: false, code: `upload_http_${res.status}`, message: `The upload was refused (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}.` };
        }
        return { ok: true, uri: assetUriFor(file.documentId, bytes) };
      } catch (err) {
        return { ok: false, code: 'upload_failed', message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
