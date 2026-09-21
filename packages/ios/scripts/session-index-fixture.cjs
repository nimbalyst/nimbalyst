/**
 * Session index round-trip fixture (local-only, no Wrangler/Electron app required).
 *
 * Build: npm run build:node --workspace=@nimbalyst/runtime
 * Run:   node packages/ios/scripts/session-index-fixture.cjs [--self-test]
 * Swift: cd packages/ios/NimbalystNative && swift test --filter SessionIndexRoundTripTests
 * The first stdout line is the ephemeral loopback port; provider logs use stderr.
 * The fixture imports dist-node/CollabV3Sync.js directly because the current
 * runtime package's /sync export points at its browser build. It derives the
 * same AES-GCM key as CryptoManager(seed: "test-seed", userId: "test-user"):
 * PBKDF2-SHA256, salt "nimbalyst:test-user", 100000 iterations, 32 bytes.
 *
 * Server model, derived from nimbalyst-collab's IndexRoom.ts / IndexReplication.ts
 * and collab-protocol/fixtures (wire envelope templates are loaded below):
 * - Only desktop indexUpdate/indexBatchUpdate/indexClientMetadataPatch packets
 *   create normal rows. Full writes replace identity/title/provider/timestamps;
 *   only SQL CASE/COALESCE columns are sticky. lastReadAt never falls.
 *   Project through session_index columns: omit pendingExecution/hasPendingPrompt
 *   and always emit isExecuting/isArchived/isPinned as booleans.
 * - Each CHANGED session row appends immutable ciphertext to the journal and
 *   receives the next account revision, including individual batch rows. An
 *   identical effective write does not consume a revision. Patch-only fields do
 *   not alter updatedAt. HTTP responses expose the effective rows and journal.
 * - V2 peers get indexChangesAvailable hints; legacy peers get indexBroadcast.
 * - Delta replays EVERY journal entry in (sinceRevision, captured head], ordered
 *   by revision. Partial delta cursors prove only that page's contiguous prefix.
 * - Bootstrap enumerates bounded session IDs in ascending order, then captures
 *   the replay end and drains mutations since enumeration began. Only its final
 *   page supplies a cursor. Recent/lookup pages never establish cursor coverage.
 * - Recent excludes archived rows, sorting executing, pinned, updatedAt, ID
 *   descending; lookup follows requested IDs. Both optionally scope by project.
 * - Pages honor limits up to 100 and a 1 MiB target. Opaque in-memory tokens hold
 *   continuation state. Production token signing, automatic pruning, auth, project/file
 *   indexing, and byte-exact envelope budgets are deliberately outside this stub.
 *
 * HTTP controls (GET; use /state after any scenario to inspect both directions):
 * /seed: publish two queued prompts and capture the old encrypted row.
 * /clear: hold an old bulk snapshot inside WebCrypto, clear one prompt while an
 *         isExecuting patch overlaps, then release the bulk publication.
 * /revision-seed, /revision-newer: publish two titles at the same sort timestamp.
 * /replay: deliver the captured older row on the phone's next recent page;
 *          leaves authoritative server rows, journal and head unchanged.
 * /hold, /release: delay phone page delivery while desktop writes and acks run.
 * /duplicate-ack: re-deliver the last provider response to the phone.
 * /retention-floor: advance the journal floor to head; stale cursors must reset.
 * /state: revision, cursorFloor, rows, history, wire traffic, provider logs, held pages.
 * Phone sockets use ?token=phone. Creation requests are relayed to the real
 * provider listener; its permitted headless fallback publishes before responding.
 * This round trip covers the iOS half of create-session ordering: the tracker
 * completes only when the GRDB row is committed, never on the acknowledgement
 * alone. The fixture's publish-then-ack callback is an intentional stand-in.
 * The production desktop half is pinned separately by
 * packages/electron/src/main/services/ai/__tests__/mobileCreateRequestHandlers.test.ts:
 * "sends no response until the index publish for the new session resolves"
 * holds publication pending, asserts no response, then resolves it and checks
 * the successful response. The fixture does not claim to test that handler.
 * A headless dependency seam for the real handler is a separate follow-up.
 *
 * Mutation evidence, no Swift source changes required:
 * --mutation=late-bulk delivers the captured desktop bulk snapshot AFTER the
 *   newer clear, reproducing an ungated publisher's ordering without changing
 *   the clear payload. Default mode asserts the provider logged its gate drop.
 * --mutation=stale-revision falsely labels old ciphertext as head+1 (row failure).
 * Pass the same choices to Swift via NIMBALYST_INDEX_FIXTURE_MUTATION=<choice>.
 * Unset that variable for the restored green run. The revision mutation proves
 * the row assertion detects stale ingestion; it does NOT remove Swift's guard
 * or claim execution of a historical pre-fix binary. Normal /replay carries the
 * actual older revision, which the unmodified Swift consumer must reject.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocket, WebSocketServer } = require('ws');
const assert = require('node:assert/strict');
const mutation = process.argv.find(arg => arg.startsWith('--mutation='))?.split('=')[1];
assert(!mutation || ['late-bulk', 'stale-revision'].includes(mutation), 'unknown fixture mutation');
const fixtures = require('node:path').resolve(__dirname, '../../collab-protocol/fixtures');
const pageShape = require(`${fixtures}/indexPageResponse.runtime.json`);
const devicesShape = require(`${fixtures}/devicesList.json`);
const providerLogs = [];
const stderrLog = console.error.bind(console);
for (const level of ['log', 'warn', 'error']) console[level] = (...args) => { providerLogs.push(args.join(' ')); stderrLog(...args); };
function fatal(error) { fs.writeSync(2, `${error.stack ?? error}\n`); process.exit(1); }
global.WebSocket = WebSocket;
// Do not keep swift-test's output pipe alive if XCTest aborts before tearDown.
const parentPid = process.ppid;
setInterval(() => {
  try { process.kill(parentPid, 0); } catch { process.exit(1); }
}, 500).unref();
const rows = new Map(), history = [], traffic = [], heldPages = [];
let revision = 0, cursorFloor = 0, desktop, provider, oldRow, replay = false, holdPhone = false, silentNextPhone = false, lastAck;
const send = (ws, message) => {
  if (ws.readyState !== WebSocket.OPEN || ws.dormant || ws.silent) return;
  traffic.push({ direction: 'out', role: ws.role, message });
  ws.send(JSON.stringify(message));
};
function notify(ws, row) {
  if (ws.role === 'desktop' || holdPhone) return;
  send(ws, ws.v2 ? { type: 'indexChangesAvailable', revision } :
    { type: 'indexBroadcast', session: row.session, fromConnectionId: 'desktop' });
}
// Wire-name column projection of IndexRoom's upsert and indexRowProjection.
const replaced = ['encryptedProjectId', 'projectIdIv', 'encryptedTitle', 'titleIv', 'provider', 'model', 'mode', 'lastMessageAt', 'createdAt', 'updatedAt'];
const sticky = ['messageCount', 'isExecuting', 'encryptedClientMetadata', 'clientMetadataIv', 'parentSessionId', 'sessionType', 'worktreeId', 'hostDeviceId', 'isArchived', 'isPinned', 'branchedFromSessionId', 'branchPointMessageId', 'branchedAt', 'agentRole', 'createdBySessionId', 'queuedPromptCount', 'encryptedQueuedPrompts'];
const patchColumns = ['isExecuting', 'encryptedClientMetadata', 'clientMetadataIv'];
function projectSession(previous, incoming, patch) {
  const row = { ...previous, sessionId: incoming.sessionId };
  if (!patch) for (const field of replaced) {
    delete row[field];
    if (incoming[field] != null) row[field] = incoming[field];
  }
  for (const field of patch ? patchColumns : sticky) if (incoming[field] != null) row[field] = incoming[field];
  if (incoming.lastReadAt != null) row.lastReadAt = Math.max(previous.lastReadAt ?? 0, incoming.lastReadAt);
  row.projectIdIv ??= '';
  row.provider ??= 'unknown';
  row.lastMessageAt ??= 0;
  for (const field of ['isExecuting', 'isArchived', 'isPinned']) row[field] = row[field] === true;
  return row;
}
function persist(session, patch = false) {
  const previous = rows.get(session.sessionId)?.session ?? {};
  const merged = projectSession(previous, session, patch);
  if (require('node:util').isDeepStrictEqual(previous, merged)) return;
  const row = { entity: 'session', id: session.sessionId, revision: ++revision, deleted: false, session: merged };
  rows.set(row.id, row); history.push(structuredClone(row));
  for (const ws of wss.clients) notify(ws, row);
}
// Tokens are opaque, process-local state; production authenticates/encodes these.
const pageTokens = new Map();
const priority = row => row.session.isExecuting ? 2 : row.session.isPinned ? 1 : 0;
const recentOrder = (a, b) => priority(b) - priority(a) || b.session.updatedAt - a.session.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
function buildPage(request, replayEntry) {
  assert.equal(request.protocolVersion, 2);
  assert(['recent', 'lookup', 'bootstrap', 'delta'].includes(request.mode));
  const limit = Math.min(request.limit ?? 100, 100);
  assert(Number.isInteger(limit) && limit > 0);
  let token;
  if (request.pageToken) {
    token = structuredClone(pageTokens.get(request.pageToken));
    assert(token && token.mode === request.mode, 'invalid page token or mode');
  } else {
    if (request.mode === 'delta') assert(Number.isInteger(request.sinceRevision) && request.sinceRevision >= 0);
    if (request.mode === 'lookup') assert(Array.isArray(request.sessionIds));
    token = { mode: request.mode, start: request.mode === 'delta' ? request.sinceRevision : revision, end: request.mode === 'bootstrap' ? null : revision,
      after: request.mode === 'delta' ? request.sinceRevision : revision,
      upperId: [...rows.keys()].sort().at(-1) ?? '', lastId: '', enumerating: request.mode === 'bootstrap',
      ids: request.sessionIds, offset: 0, projectId: request.projectId, recentLast: null };
  }
  const response = { type: pageShape.type, protocolVersion: pageShape.protocolVersion,
    requestId: request.requestId, mode: request.mode, entries: [], complete: false };
  if (['bootstrap', 'delta'].includes(request.mode) && (token.start < cursorFloor || token.start > revision)) return { ...response, resetRequired: true };
  let bytes = 1024;
  const append = row => {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    assert(size < 15 * 1024 * 1024, 'index entry exceeds hard transport limit');
    if (response.entries.length && (response.entries.length >= limit || bytes + size > 1024 * 1024)) return false;
    response.entries.push(structuredClone(row)); bytes += size; return true;
  };
  const partial = () => {
    const id = crypto.randomUUID(); pageTokens.set(id, structuredClone(token));
    return { ...response, nextPageToken: id, ...(request.mode === 'delta' ? { cursor: token.after } : {}) };
  };
  if (request.mode === 'recent') {
    const candidates = replayEntry ? [replayEntry] : [...rows.values()].filter(row =>
      !row.session.isArchived && (!token.projectId || row.session.encryptedProjectId === token.projectId) &&
      (!token.recentLast || recentOrder(row, token.recentLast) > 0)).sort(recentOrder);
    for (const row of candidates) {
      if (!append(row)) return partial();
      token.recentLast = row;
    }
  } else if (request.mode === 'lookup') {
    while (token.offset < token.ids.length) {
      const row = rows.get(token.ids[token.offset]);
      if (row && (!token.projectId || row.session.encryptedProjectId === token.projectId) && !append(row)) return partial();
      token.offset++;
    }
  } else {
    if (token.enumerating) {
      for (const id of [...rows.keys()].sort().filter(id => id > token.lastId && id <= token.upperId)) {
        if (!append(rows.get(id))) return partial();
        token.lastId = id;
      }
      token.enumerating = false;
      token.end = revision; // Freeze replay end only AFTER bootstrap enumeration.
    }
    for (const row of history.filter(row => row.revision > token.after && row.revision <= token.end)) {
      if (!append(row)) return partial();
      token.after = row.revision;
    }
    response.cursor = token.end;
  }
  return { ...response, complete: true };
}
function page(ws, request) {
  if (holdPhone && ws.role === 'phone') { heldPages.push([ws, request]); return; }
  let replayEntry;
  if (replay && ws.role === 'phone' && request.mode === 'recent' && !request.pageToken) {
    replayEntry = structuredClone(oldRow); replay = false;
    // Counterfactual: stale ciphertext incorrectly advertised as a NEW revision.
    // Swift's row assertions must fail, proving the replay is actually consumed.
    if (mutation === 'stale-revision') replayEntry.revision = revision + 1;
  }
  send(ws, buildPage(request, replayEntry));
}
const session = (id, queuedPrompts = []) => ({ id, title: id, provider: 'claude-code', mode: 'agent',
  workspaceId: '/roundtrip', createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0, queuedPrompts });
const prompts = [{ id: 'first', prompt: 'Consume me', timestamp: Date.now() }, { id: 'second', prompt: 'Keep me', timestamp: Date.now() + 1 }];
async function published(outcome) { assert.equal((await outcome)?.published, true, 'real provider must publish'); }
async function waitFor(condition) {
  const deadline = Date.now() + 4000;
  while (!condition()) { if (Date.now() > deadline) throw Error('fixture timed out'); await new Promise(r => setTimeout(r, 10)); }
}
async function control(path) {
  if (path === '/seed') {
    await published(provider.syncSessionsToIndex([session('queue-session', prompts)]));
    await waitFor(() => rows.has('queue-session'));
    // Bulk session summaries do not accept queue payloads. The production
    // pending-prompt publisher sends them through metadata_updated.
    await published(provider.pushChange('queue-session', { type: 'metadata_updated', metadata: { queuedPrompts: prompts } }));
    await waitFor(() => rows.get('queue-session').session.queuedPromptCount === 2);
    oldRow = structuredClone(rows.get('queue-session'));
  } else if (path === '/clear') {
    // Freeze a stale bulk snapshot inside real encryption while two newer
    // per-session patches run. This pins the batch publication ordering fix.
    const subtle = crypto.webcrypto.subtle;
    const encrypt = subtle.encrypt;
    let release, entered;
    const blocked = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let first = true;
    subtle.encrypt = async function (...args) {
      if (first) { first = false; entered(); await blocked; }
      return encrypt.apply(this, args);
    };
    const bulkSession = session('queue-session', prompts);
    const heldBulk = { type: 'indexBatchUpdate', sessions: [{ ...structuredClone(oldRow.session), createdAt: bulkSession.createdAt, updatedAt: bulkSession.updatedAt, lastMessageAt: bulkSession.updatedAt }] };
    const logStart = providerLogs.length;
    const bulk = provider.syncSessionsToIndex([bulkSession]);
    try {
      await started;
      await Promise.all([
        published(provider.pushChange('queue-session', { type: 'metadata_updated', metadata: { queuedPrompts: prompts.slice(1) } })),
        published(provider.pushChange('queue-session', { type: 'metadata_updated', metadata: { isExecuting: true } })),
      ]);
    } finally { release(); subtle.encrypt = encrypt; }
    const bulkOutcome = await bulk;
    assert(bulkOutcome, 'bulk publication must report its outcome');
    await waitFor(() => rows.get('queue-session').session.isExecuting === true);
    assert(providerLogs.slice(logStart).some(line => line.includes('Dropping bulk index entry for queue-session: a newer publication landed first')), 'bulk publication gate was not exercised');
    if (mutation === 'late-bulk') {
      // Counterfactual wire delivery, not a changed newer patch or source edit.
      receive(desktop, heldBulk, 'late-bulk');
    }
  } else if (path === '/revision-seed') {
    await published(provider.syncSessionsToIndex([{ ...session('revision-session'), title: 'Older title' }]));
    await waitFor(() => rows.has('revision-session')); oldRow = structuredClone(rows.get('revision-session'));
  } else if (path === '/revision-newer') {
    await published(provider.pushChange('revision-session', { type: 'metadata_updated', metadata: { title: 'Newer title', updatedAt: oldRow.session.updatedAt } }));
    await waitFor(() => rows.get('revision-session').revision > oldRow.revision);
  } else if (path === '/replay') { replay = true;
  } else if (path === '/silent-next') { silentNextPhone = true;
  } else if (path === '/dormant') {
    // Keep TCP/WebSocket open while dropping application frames in both directions.
    for (const ws of wss.clients) if (ws.role === 'phone') ws.dormant = true;
    await published(provider.syncSessionsToIndex([{ ...session('dormant-session'), title: 'Created while asleep' }]));
    await waitFor(() => rows.has('dormant-session'));
  } else if (path === '/hold') { holdPhone = true;
  } else if (path === '/release') {
    holdPhone = false;
    for (const [ws, request] of heldPages.splice(0)) page(ws, request);
    for (const ws of wss.clients) notify(ws, rows.get('created-session'));
  } else if (path === '/duplicate-ack') {
    for (const ws of wss.clients) if (ws.role === 'phone') send(ws, lastAck);
  } else if (path === '/retention-floor') { cursorFloor = revision;
  } else if (path !== '/state') { throw Error(`Unknown control ${path}`); }
  return { revision, cursorFloor, providerLogs, rows: [...rows.values()], history, traffic, heldPages: heldPages.length };
}
const claims = new Map();
const failure = (requestId, error) => ({ type: 'createSessionResponseBroadcast', response: { requestId, success: false, error }, fromConnectionId: 'server' });
function relayCreation(requester, message) {
  const id = message.request.requestId;
  const existing = claims.get(id);
  if (existing) {
    if (existing.response) send(requester, existing.response);
    else if (existing.host.readyState !== WebSocket.OPEN) {
      existing.response = failure(id, 'The selected host device disconnected before execution');
      send(requester, existing.response);
    }
    return; // A live in-flight claim is not executed twice.
  }
  const hosts = [...wss.clients].filter(ws => ws !== requester && ws.role === 'desktop' && ws.v2 && ws.readyState === WebSocket.OPEN &&
    (message.targetDeviceId ? ws.device.deviceId === message.targetDeviceId && ['desktop', 'headless'].includes(ws.device.type) : ws.device.type === 'desktop'));
  hosts.sort((a, b) => Number(b.device.isFocused === true) - Number(a.device.isFocused === true) ||
    (b.device.lastActiveAt ?? 0) - (a.device.lastActiveAt ?? 0) || a.device.deviceId.localeCompare(b.device.deviceId));
  const host = hosts[0];
  if (!host) {
    const response = failure(id, message.targetDeviceId ? 'The requested host device is not connected' : 'No eligible desktop host is connected');
    claims.set(id, { response }); send(requester, response); return;
  }
  claims.set(id, { host });
  send(host, { type: 'createSessionRequestBroadcast', request: message.request, targetDeviceId: host.device.deviceId, fromConnectionId: 'phone' });
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try { res.end(JSON.stringify(await control(req.url))); }
  catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); fatal(error); }
});
const wss = new WebSocketServer({ server, autoPong: false });
wss.on('connection', (ws, req) => {
  ws.role = new URL(req.url, 'http://localhost').searchParams.get('token') === 'phone' ? 'phone' : 'desktop';
  if (ws.role === 'desktop' && !desktop) desktop = ws;
  if (ws.role === 'phone' && silentNextPhone) { ws.silent = true; silentNextPhone = false; }
  ws.on('ping', data => {
    traffic.push({ direction: 'ping', role: ws.role });
    if (!ws.silent && !ws.dormant) ws.pong(data);
  });
  ws.device = { deviceId: 'desktop', type: 'desktop', isFocused: true, lastActiveAt: 0 };
  send(ws, { type: devicesShape.type, devices: [{ ...devicesShape.devices[0], deviceId: 'desktop', name: 'Fixture desktop', type: 'desktop', platform: 'macos' }] });
  ws.on('message', raw => { try { receive(ws, JSON.parse(raw)); } catch (error) { fatal(error); } });
});
function receive(ws, message, mutationDelivery) {
    if (ws.dormant || ws.silent) return;
    try {
      traffic.push({ direction: 'in', role: ws.role, message, ...(mutationDelivery ? { mutationDelivery } : {}) });
      switch (message.type) {
        case 'deviceAnnounce': ws.device = message.device; break;
        case 'personalStatePageRequest': send(ws, { type: 'personalStatePageResponse', requestId: message.requestId, entries: [], complete: true }); break;
        case 'indexPageRequest': ws.v2 = true; page(ws, message); break;
        case 'indexUpdate': persist(message.session); break;
        case 'indexBatchUpdate': for (const entry of message.sessions) persist(entry); break;
        case 'indexClientMetadataPatch': assert(rows.has(message.patch.sessionId)); persist(message.patch, true); break;
        case 'createSessionRequest': relayCreation(ws, message); break;
        case 'createSessionResponse': {
          const claim = claims.get(message.response.requestId);
          if (claim && (claim.host !== ws || claim.response)) break;
          lastAck = { ...message, type: 'createSessionResponseBroadcast', fromConnectionId: 'desktop' };
          if (claim) claim.response = lastAck;
          for (const phone of wss.clients) if (phone.role === 'phone') send(phone, lastAck);
          break;
        }
      }
    } catch (error) { fatal(error); }
}
async function main() {
  const startupTimeout = setTimeout(() => { console.error('fixture startup timed out'); process.exit(1); }, 6000);
  const runtimePath = path.resolve(__dirname, '../../runtime/dist-node/sync/CollabV3Sync.js');
  assert(fs.existsSync(runtimePath), `Missing runtime Node build: ${runtimePath}. Run npm run build:node --workspace=@nimbalyst/runtime from the repository root.`);
  const { createCollabV3Sync } = await import(require('node:url').pathToFileURL(runtimePath).href);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const encryptionKey = await crypto.webcrypto.subtle.importKey('raw', crypto.pbkdf2Sync('test-seed', 'nimbalyst:test-user', 100000, 32, 'sha256'), 'AES-GCM', false, ['encrypt', 'decrypt']);
  provider = createCollabV3Sync({ serverUrl: `ws://127.0.0.1:${port}`, orgId: 'test-org', personalMemberId: 'test-user',
    getJwt: async () => `header.${Buffer.from(JSON.stringify({ sub: 'test-user' })).toString('base64url')}.signature`,
    encryptionKey, deviceInfo: { deviceId: 'desktop', name: 'Fixture desktop', type: 'desktop', platform: 'macos' } });
  await waitFor(() => desktop?.readyState === WebSocket.OPEN);
  await provider.fetchIndex();
  // The Electron handler imports window/store services, so use the permitted headless provider fallback.
  provider.onCreateSessionRequest(async request => {
    try {
      assert.equal(request.projectId, '/roundtrip');
      const acknowledge = () => provider.sendCreateSessionResponse({ requestId: request.requestId, success: true, sessionId: 'created-session' });
      await published(provider.syncSessionsToIndex([session('created-session')]));
      await acknowledge();
    } catch (error) { console.error(error); process.exit(1); }
  });
  clearTimeout(startupTimeout);
  if (process.argv.includes('--self-test')) {
    setTimeout(() => { console.error('fixture self-test timed out'); process.exit(1); }, 8000).unref();
    const drive = async path => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200); return response.json();
    };
    await drive('/seed');
    assert.equal(rows.get('queue-session').session.queuedPromptCount, 2);
    await drive('/clear');
    const row = rows.get('queue-session');
    assert.equal(row.session.queuedPromptCount, 1);
    assert.deepEqual(row.session.encryptedQueuedPrompts.map(p => p.id), ['second']);
    assert(row.revision > oldRow.revision);
    const phone = new WebSocket(`ws://127.0.0.1:${port}/?token=phone`);
    await new Promise(resolve => phone.once('open', resolve));
    await control('/hold');
    phone.send(JSON.stringify({ type: 'indexPageRequest', protocolVersion: 2, requestId: 'held-page', mode: 'recent' }));
    const start = traffic.length;
    const creationRequest = { type: 'createSessionRequest', targetDeviceId: 'desktop', request: {
      requestId: 'self-test-create', encryptedProjectId: row.session.encryptedProjectId,
      projectIdIv: row.session.projectIdIv, timestamp: Date.now(),
    } };
    phone.send(JSON.stringify(creationRequest));
    phone.send(JSON.stringify(creationRequest)); // in-flight deduplication
    await waitFor(() => lastAck !== undefined);
    assert.equal(heldPages.length, 1);
    assert.equal(traffic.filter(event => event.direction === 'out' && event.message.type === 'createSessionRequestBroadcast').length, 1, 'one host dispatch per in-flight request');
    const received = traffic.slice(start).filter(event => event.direction === 'in' && event.role === 'desktop');
    const publishIndex = received.findIndex(event => ['indexBatchUpdate', 'indexUpdate'].includes(event.message.type));
    const ackIndex = received.findIndex(event => event.message.type === 'createSessionResponse');
    assert(publishIndex >= 0 && publishIndex < ackIndex, 'fixture publish barrier must precede its ack (shipped handler is not covered)');
    assert(rows.has('created-session'));
    await control('/release');
    assert.equal(heldPages.length, 0);
    const requestPage = async options => {
      const requestId = crypto.randomUUID();
      phone.send(JSON.stringify({ type: 'indexPageRequest', protocolVersion: 2, requestId, ...options }));
      await waitFor(() => traffic.some(event => event.direction === 'out' && event.message.requestId === requestId));
      return traffic.find(event => event.direction === 'out' && event.message.requestId === requestId).message;
    };
    // Pagination must replay intermediate revisions, not merely current rows.
    let response = await requestPage({ mode: 'delta', sinceRevision: 0, limit: 1 });
    const seen = [];
    while (true) {
      seen.push(...response.entries.map(entry => entry.revision));
      if (response.complete) break;
      assert.equal(response.cursor, seen.at(-1));
      response = await requestPage({ mode: 'delta', pageToken: response.nextPageToken, limit: 1 });
    }
    assert.deepEqual(seen, history.map(entry => entry.revision));
    assert.equal(response.cursor, revision);
    const beforeNoop = revision;
    persist(structuredClone(rows.get('queue-session').session));
    assert.equal(revision, beforeNoop, 'identical effective row must not consume a revision');

    response = await requestPage({ mode: 'bootstrap', limit: 1 });
    assert.equal(response.complete, false);
    assert.equal(response.cursor, undefined);
    const bootstrapIds = response.entries.map(entry => entry.id);
    await published(provider.syncSessionsToIndex([session('zz-after-bootstrap-start')]));
    await waitFor(() => rows.has('zz-after-bootstrap-start'));
    while (!response.complete) {
      response = await requestPage({ mode: 'bootstrap', pageToken: response.nextPageToken, limit: 1 });
      bootstrapIds.push(...response.entries.map(entry => entry.id));
    }
    assert(bootstrapIds.includes('zz-after-bootstrap-start'), 'bootstrap replay must include a row beyond the enumeration bound');
    assert.equal(response.cursor, revision);
    response = await requestPage({ mode: 'lookup', sessionIds: ['missing', 'created-session', 'queue-session'], limit: 1 });
    assert.deepEqual(response.entries.map(entry => entry.id), ['created-session']);
    assert.equal(response.cursor, undefined);
    response = await requestPage({ mode: 'lookup', pageToken: response.nextPageToken, limit: 1 });
    assert.deepEqual(response.entries.map(entry => entry.id), ['queue-session']);
    assert.equal(response.complete, true);
    response = await requestPage({ mode: 'recent', limit: 1 });
    assert.equal(response.entries[0].id, 'queue-session', 'executing sessions lead the recent feed');
    assert.equal(response.cursor, undefined);

    await drive('/revision-seed'); await drive('/revision-newer');
    assert.equal(rows.get('revision-session').session.updatedAt, oldRow.session.updatedAt);
    const headBeforeReplay = revision;
    await drive('/replay');
    response = await requestPage({ mode: 'recent' });
    assert.equal(response.entries[0].revision, oldRow.revision, 'replay must retain its older revision');
    assert(response.entries[0].revision < rows.get('revision-session').revision);
    assert.equal(revision, headBeforeReplay, 'replay must not mutate authoritative state');
    // Projection and sticky/unconditional updates mirror the server column set.
    const projected = projectSession({}, { ...oldRow.session, pendingExecution: {}, hasPendingPrompt: true, model: 'old-model', lastReadAt: 50, parentSessionId: 'parent', isPinned: true }, false);
    assert.equal('pendingExecution' in projected, false);
    assert.equal('hasPendingPrompt' in projected, false);
    assert.equal(typeof projected.isExecuting, 'boolean');
    assert.equal(typeof projected.isArchived, 'boolean');
    assert.equal(typeof projected.isPinned, 'boolean');
    const replacedRow = projectSession(projected, { sessionId: projected.sessionId, encryptedProjectId: 'new-project', createdAt: 10, updatedAt: 11, lastReadAt: 5 }, false);
    assert.equal(replacedRow.model, undefined);
    assert.equal(replacedRow.encryptedTitle, undefined);
    assert.equal(replacedRow.provider, 'unknown');
    assert.equal(replacedRow.updatedAt, 11);
    assert.equal(replacedRow.parentSessionId, 'parent');
    assert.equal(replacedRow.isPinned, true);
    assert.equal(replacedRow.lastReadAt, 50);
    const patched = projectSession(projected, { sessionId: projected.sessionId, updatedAt: 999, model: 'ignored', isExecuting: true }, true);
    assert.equal(patched.updatedAt, projected.updatedAt);
    assert.equal(patched.model, 'old-model');

    const staleBootstrap = await requestPage({ mode: 'bootstrap', limit: 1 });
    await published(provider.pushChange('revision-session', { type: 'metadata_updated', metadata: { isExecuting: true } }));
    await waitFor(() => revision > headBeforeReplay);
    await drive('/retention-floor');
    response = await requestPage({ mode: 'delta', sinceRevision: 0 });
    assert.equal(response.resetRequired, true);
    assert.equal(response.complete, false);
    assert.deepEqual(response.entries, []);
    response = await requestPage({ mode: 'bootstrap', pageToken: staleBootstrap.nextPageToken, limit: 1 });
    assert.equal(response.resetRequired, true, 'an expired bootstrap cursor must reset too');
    response = await requestPage({ mode: 'recent' });
    assert.equal(response.resetRequired, undefined, 'retention cannot invalidate a feed');

    const legacy = new WebSocket(`ws://127.0.0.1:${port}/?token=phone`);
    const legacyMessages = [];
    legacy.on('message', raw => legacyMessages.push(JSON.parse(raw)));
    await new Promise(resolve => legacy.once('open', resolve));
    await published(provider.pushChange('revision-session', { type: 'metadata_updated', metadata: { isExecuting: false } }));
    await waitFor(() => legacyMessages.some(message => message.type === 'indexBroadcast'));
    assert.equal(legacyMessages.find(message => message.type === 'indexBroadcast').session.sessionId, 'revision-session');
    legacy.terminate();

    phone.send(JSON.stringify({ ...creationRequest, targetDeviceId: 'missing-host', request: { ...creationRequest.request, requestId: 'missing-target' } }));
    await waitFor(() => claims.has('missing-target'));
    assert.deepEqual(claims.get('missing-target').response, failure('missing-target', 'The requested host device is not connected'));
    provider.disconnectAll(); desktop.terminate();
    phone.send(JSON.stringify({ ...creationRequest, targetDeviceId: undefined, request: { ...creationRequest.request, requestId: 'no-host' } }));
    await waitFor(() => claims.has('no-host'));
    assert.deepEqual(claims.get('no-host').response, failure('no-host', 'No eligible desktop host is connected'));
    phone.terminate();
    // Protocol assertion failures must terminate, not be hidden by self-test exit(0).
    const child = require('node:child_process').spawn(process.execPath, [__filename], { stdio: ['ignore', 'pipe', 'pipe'] });
    let childStderr = '';
    child.stderr.on('data', bytes => { childStderr += bytes; });
    const childExit = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    const childTimeout = setTimeout(() => { child.kill(); }, 4000);
    try {
      const ready = await new Promise((resolve, reject) => { child.stdout.once('data', bytes => resolve(Number(String(bytes).trim()))); child.once('error', reject); child.once('exit', () => reject(Error('protocol child exited before ready: ' + childStderr))); });
      assert(Number.isInteger(ready) && ready > 0);
      const invalid = new WebSocket(`ws://127.0.0.1:${ready}/?token=phone`);
      invalid.on('error', () => {});
      await new Promise(resolve => invalid.once('open', resolve));
      invalid.send(JSON.stringify({ type: 'indexClientMetadataPatch', patch: { sessionId: 'absent' } }));
      assert.equal(await childExit, 1, 'invalid protocol input must exit non-zero');
      assert(childStderr.includes('AssertionError'), 'fatal protocol failure must reach stderr');
      invalid.terminate();
    } finally { clearTimeout(childTimeout); if (child.exitCode === null) child.kill(); }
    console.error('session-index self-test passed (including fatal child exit=1)');
    provider.disconnectAll(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); process.exit(process.exitCode ?? 0);
  } else process.stdout.write(`${port}\n`);
}
main().catch(error => { console.error(error); process.exit(1); });
