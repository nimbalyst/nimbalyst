/**
 * The REST surface of `nim wiki serve`. Each route is one library call, so the
 * browser sees exactly the model `nim`, `nim mcp` and the desktop app see:
 *
 *   GET  /api/info                        server and wiki facts, API version
 *   GET  /api/snapshot                    wiki.snapshot()
 *   POST /api/command                     wiki.command(LocalWikiCommand)
 *   GET  /api/pages/:id/body              wiki.readBody(id)
 *   PUT  /api/pages/:id/body              wiki.writeBody(id, markdown, expectedVersion); 409 on conflict
 *   GET  /api/types                       type definitions (the library's slice plus the raw YAML)
 *   GET  /api/trackers/:type              wiki.trackerSnapshot(type)
 *   POST /api/trackers/:type/command      wiki.trackerCommand(type, LocalTrackerCommand)
 *   GET  /api/items/:id/activity          wiki.readActivity(id)
 *   GET  /api/search?q=&limit=            wiki.search(q)
 *   GET  /api/events                      change stream (see events.ts)
 */
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import yaml from 'js-yaml';
import type { LocalTrackerCommand, LocalWiki, LocalWikiCommand } from '@nimbalyst/local-wiki';
import { HttpError, readJson, sendJson } from './http.js';
import type { ChangeStream } from './events.js';

/** Bumped when a route or payload changes incompatibly; `@nimbalyst/wiki-web` checks it. */
export const WIKI_API_VERSION = 1;

export interface ApiContext {
  wiki: LocalWiki;
  events: ChangeStream;
  version: string;
  projectRoot: string | null;
}

interface WriteBodyRequest {
  markdown?: unknown;
  expectedVersion?: unknown;
}

function segment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'bad-path', 'Malformed path segment');
  }
}

async function typeDefinitions(wiki: LocalWiki) {
  return Promise.all(
    wiki.typeDefs().map(async (def) => {
      let definition: unknown = null;
      try {
        definition = yaml.load(await readFile(def.sourcePath, 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? null;
      } catch {
        // The library already reported a malformed type file in the snapshot's issues.
      }
      const { sourcePath: _sourcePath, ...rest } = def;
      return { ...rest, definition };
    }),
  );
}

/** Handles `/api/*`. Returns false when no route matched. */
export async function handleApi(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const { wiki } = ctx;

  if (method === 'GET' && parts.length === 1) {
    switch (parts[0]) {
      case 'info':
        sendJson(res, 200, { apiVersion: WIKI_API_VERSION, version: ctx.version, root: wiki.root, projectRoot: ctx.projectRoot });
        return true;
      case 'snapshot':
        sendJson(res, 200, await wiki.snapshot());
        return true;
      case 'types':
        sendJson(res, 200, { types: await typeDefinitions(wiki) });
        return true;
      case 'search': {
        const q = url.searchParams.get('q') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? '') || undefined;
        sendJson(res, 200, { hits: await wiki.search(q, { limit }) });
        return true;
      }
      case 'events':
        ctx.events.attach(req, res);
        return true;
    }
  }

  if (method === 'POST' && parts.length === 1 && parts[0] === 'command') {
    const cmd = await readJson<LocalWikiCommand>(req);
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') throw new HttpError(400, 'bad-command', 'Expected a command with a type');
    sendJson(res, 200, await wiki.command(cmd));
    return true;
  }

  if (parts.length === 3 && parts[0] === 'pages' && parts[2] === 'body') {
    const id = segment(parts[1]);
    if (method === 'GET') {
      sendJson(res, 200, await wiki.readBody(id));
      return true;
    }
    if (method === 'PUT') {
      const body = await readJson<WriteBodyRequest>(req);
      if (typeof body?.markdown !== 'string') throw new HttpError(400, 'bad-body', 'Expected { markdown, expectedVersion }');
      const expected = body.expectedVersion;
      if (expected !== null && typeof expected !== 'string') {
        throw new HttpError(400, 'bad-body', 'expectedVersion must be the version string read with the body, or null to overwrite');
      }
      const result = await wiki.writeBody(id, body.markdown, expected);
      sendJson(res, result.ok ? 200 : 409, result);
      return true;
    }
  }

  if (parts.length >= 2 && parts[0] === 'trackers') {
    const typeId = segment(parts[1]);
    if (method === 'GET' && parts.length === 2) {
      sendJson(res, 200, await wiki.trackerSnapshot(typeId));
      return true;
    }
    if (method === 'POST' && parts.length === 3 && parts[2] === 'command') {
      const cmd = await readJson<LocalTrackerCommand>(req);
      if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') throw new HttpError(400, 'bad-command', 'Expected a command with a type');
      sendJson(res, 200, await wiki.trackerCommand(typeId, cmd));
      return true;
    }
  }

  if (method === 'GET' && parts.length === 3 && parts[0] === 'items' && parts[2] === 'activity') {
    sendJson(res, 200, { entries: await wiki.readActivity(segment(parts[1])) });
    return true;
  }

  return false;
}
