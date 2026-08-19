// @vitest-environment node
/**
 * MainBodyDocService: where an agent's body write actually lands.
 *
 * The service prefers the renderer that already has the body open -- that write
 * goes through the exact DocumentSyncProvider the Lexical editor is bound to.
 * The pooled headless room peer is the fallback for a body nobody has open.
 *
 * What these tests pin is the DISTINCTION between the renderer outcomes.
 * Collapsing them back to a boolean (the shape this slice corrected) is silent:
 * a renderer that is merely busy looks identical to one with no open editor, so
 * agent writes quietly demote to the headless peer -- the path whose own header
 * comment says a warm editor peer's next autosave can overwrite it.
 *
 * They also pin what `true` MEANS. Callers delete the plan's markdown file on
 * the strength of this return value, so it has to be the server's word, not the
 * local Y.Doc's: a mutated replica whose `docUpdateAck` never arrived is exactly
 * the state where the body exists nowhere but the file about to be overwritten.
 */
import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const WORKSPACE = '/ws/A';
const ITEM_ID = 'bug_main_body_write';
const MARKDOWN = '# Body written by an agent';

// --- Narrow module stubs ------------------------------------------------------
// `@nimbalyst/runtime/sync` is stubbed rather than partially mocked: importing it
// for real drags in the monaco editor tree, which this node-environment test can
// neither load nor needs.

const ipcMain = new EventEmitter() as EventEmitter & {
  removeListener: EventEmitter['removeListener'];
};

/** Whether the stub provider ever reports 'connected' / synced. */
let providerConnects = true;
/** Whether the stub provider's flush is answered by a server `docUpdateAck`. */
let providerAcks = true;
/** Whether the fake renderer's provider gets its own write acknowledged. */
let rendererAcks = true;
/** Payloads main sent to the fake renderer, newest last. */
let sentToRenderer: Array<Record<string, unknown>>;
/** How the fake renderer answers: apply it, refuse it, or never answer. */
let rendererBehavior: 'applied' | 'refused' | 'silent';
/** Markdown handed to the headless codec round trip, if it ran. */
let headlessWrites: string[];
let loggedErrors: string[];

vi.mock('ws', () => ({ default: class {} }));

vi.mock('electron', () => ({ ipcMain }));

vi.mock('@nimbalyst/runtime/sync', () => ({
  DocumentSyncProvider: class {
    private readonly config: Record<string, any>;
    constructor(config: Record<string, any>) {
      this.config = config;
    }
    async connect(): Promise<void> {
      if (providerConnects) this.config.onStatusChange?.('connected');
    }
    isSynced(): boolean { return providerConnects; }
    async flushWithAck(): Promise<boolean> { return providerAcks; }
    hasUndecodedContent(): boolean { return false; }
    getYDoc(): unknown { return {}; }
    destroy(): void { /* no-op */ }
  },
}));

vi.mock('../CollabConversionClient', () => ({
  convertFromFileIntoDoc: vi.fn(async (_op: string, _type: string, _doc: unknown, source: string) => {
    headlessWrites.push(source);
  }),
  convertExportToFile: vi.fn(async () => ''),
  convertRecoveryPlaintext: vi.fn(async () => ''),
}));

vi.mock('../TeamService', () => ({
  findTeamForWorkspace: vi.fn(async () => ({ orgId: 'org-1', teamProjectId: 'proj-1' })),
  getOrgScopedIdentity: vi.fn(async () => ({ jwt: 'jwt', teamMemberId: 'member-1' })),
  getOrgScopedJwt: vi.fn(async () => 'jwt'),
}));

vi.mock('../CollabBackupService', () => ({
  getCollabBackupService: () => ({ onContentChanged: vi.fn() }),
}));

vi.mock('../../utils/collabSyncUrl', () => ({ getCollabSyncWsUrl: () => 'wss://sync.test' }));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      error: (message: string) => { loggedErrors.push(message); },
      warn: () => {},
      info: () => {},
    },
  },
}));

const windows = new Map<number, any>();
const windowStates = new Map<number, any>();
vi.mock('../../window/windowState', () => ({ windows, windowStates }));

/**
 * A window whose webContents answers the per-request response channel the way
 * `rendererBehavior` dictates. `send` is synchronous, as Electron's is; the
 * reply is dispatched on a macrotask so main's promise is genuinely pending in
 * between, the way it is in the app.
 */
function registerFakeWindow(state: Record<string, unknown>): void {
  const webContents = {
    id: 7,
    isDestroyed: () => false,
    send: (_channel: string, payload: Record<string, unknown>) => {
      sentToRenderer.push(payload);
      if (rendererBehavior === 'silent') return;
      setTimeout(() => {
        const applied = rendererBehavior === 'applied';
        ipcMain.emit(
          payload.responseChannel as string,
          { sender: webContents },
          { applied, acknowledged: applied && rendererAcks },
        );
      }, 0);
    },
  };
  windows.set(1, { isDestroyed: () => false, webContents });
  windowStates.set(1, state);
}

async function loadService() {
  return import('../MainBodyDocService');
}

/**
 * Drive one write to completion. Timers are faked so the 5s renderer budget and
 * the peer's readiness poll can be advanced instead of waited out; advancing
 * well past both settles every branch.
 */
async function runWrite(itemId = ITEM_ID): Promise<boolean> {
  const { applyHeadlessBodyMarkdown } = await loadService();
  const pending = applyHeadlessBodyMarkdown(WORKSPACE, itemId, MARKDOWN);
  await vi.advanceTimersByTimeAsync(12_000);
  return pending;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  ipcMain.removeAllListeners();
  windows.clear();
  windowStates.clear();
  sentToRenderer = [];
  headlessWrites = [];
  loggedErrors = [];
  rendererBehavior = 'applied';
  rendererAcks = true;
  providerConnects = true;
  providerAcks = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MainBodyDocService renderer-first body writes', () => {
  const cases = [
    {
      name: 'a renderer applied it through the open editor provider',
      behavior: 'applied' as const,
      window: true,
      usesHeadlessPeer: false,
      logsDemotion: false,
    },
    {
      name: 'the renderer has no warm entry for the item',
      behavior: 'refused' as const,
      window: true,
      usesHeadlessPeer: true,
      logsDemotion: false,
    },
    {
      name: 'no window has the workspace open',
      behavior: 'applied' as const,
      window: false,
      usesHeadlessPeer: true,
      logsDemotion: false,
    },
    {
      name: 'the renderer never answered',
      behavior: 'silent' as const,
      window: true,
      usesHeadlessPeer: true,
      logsDemotion: true,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.usesHeadlessPeer ? 'falls back to the headless peer' : 'stops at the renderer'} when ${testCase.name}`, async () => {
      rendererBehavior = testCase.behavior;
      if (testCase.window) registerFakeWindow({ workspacePath: WORKSPACE });

      const applied = await runWrite();

      expect(applied).toBe(true);
      expect(headlessWrites).toEqual(testCase.usesHeadlessPeer ? [MARKDOWN] : []);
      // Only an unanswered request is worth an error: it is the one case where
      // an editor may well be open and the write demoted anyway. A renderer
      // with no warm entry is ordinary operation and must stay quiet.
      expect(
        loggedErrors.some((message) => message.includes('did not answer')),
      ).toBe(testCase.logsDemotion);
    });
  }

  it('gives the renderer a deadline it can refuse a late apply against', async () => {
    registerFakeWindow({ workspacePath: WORKSPACE });
    const before = Date.now();

    await runWrite();

    expect(sentToRenderer).toHaveLength(1);
    const { expiresAt } = sentToRenderer[0] as { expiresAt: number };
    // The renderer stops applying past this instant, which is what makes main's
    // fallback safe: without it a late apply and the headless write both run
    // `clear + insert` against different views of the room and merge into two
    // copies of the body. The renderer half of the contract is covered in
    // trackerSyncListeners.projectSwitch.test.ts.
    expect(expiresAt).toBeGreaterThan(before);
    expect(expiresAt).toBeLessThanOrEqual(before + 5_000);
  });

  /**
   * The fallback's own data-corruption path. `applyFromFile` replaces a body by
   * clearing what the doc holds and inserting the new content -- against a peer
   * that never synced there is nothing to clear, so the delta is pure insertion
   * and merges into the room as a SECOND copy of the body alongside the old one.
   */
  it('refuses the headless write when the peer never synced', async () => {
    providerConnects = false;

    const applied = await runWrite('bug_unsynced_peer');

    expect(applied).toBe(false);
    expect(headlessWrites).toEqual([]);
    expect(loggedErrors.some((message) => message.includes('never synced'))).toBe(true);
  });
});

/**
 * The publication path deletes the plan's markdown body from disk when this
 * service returns true. So `true` may only mean the SERVER has the body.
 *
 * A local Y.Doc mutation is not that. Drop the socket (or crash) between the
 * mutation and the `docUpdateAck` and the body is in no durable place at all --
 * the room is still empty for a cold teammate and the file has been overwritten
 * with a provenance pointer. Both write paths therefore have to wait for the
 * acknowledgment, and failing to get one has to read as failure.
 */
describe('MainBodyDocService server acknowledgment', () => {
  it('refuses the headless write when the room never acknowledges it', async () => {
    providerAcks = false;

    const applied = await runWrite('bug_headless_never_acked');

    expect(applied).toBe(false);
    // The write was attempted -- this is the drop-after-mutation case, not a
    // refusal to try, and the distinction is what makes retry the right advice.
    expect(headlessWrites).toEqual([MARKDOWN]);
    expect(loggedErrors.some((message) => message.includes('acknowledge'))).toBe(true);
  });

  it('reports failure without a headless retry when the renderer applied a write the room never acknowledged', async () => {
    registerFakeWindow({ workspacePath: WORKSPACE });
    rendererAcks = false;

    const applied = await runWrite('bug_renderer_never_acked');

    expect(applied).toBe(false);
    // Re-running `clear + insert` from the headless peer against a replica the
    // renderer has ALREADY mutated merges into two copies of the body. The
    // renderer's own pending write is still queued; the caller retries.
    expect(headlessWrites).toEqual([]);
    expect(loggedErrors.some((message) => message.includes('acknowledge'))).toBe(true);
  });

  it('treats a renderer answer with no acknowledgment field as unacknowledged', async () => {
    const webContents = {
      id: 7,
      isDestroyed: () => false,
      send: (_channel: string, payload: Record<string, unknown>) => {
        sentToRenderer.push(payload);
        setTimeout(() => {
          ipcMain.emit(payload.responseChannel as string, { sender: webContents }, { applied: true });
        }, 0);
      },
    };
    windows.set(1, { isDestroyed: () => false, webContents });
    windowStates.set(1, { workspacePath: WORKSPACE });

    expect(await runWrite('bug_renderer_legacy_shape')).toBe(false);
  });
});
