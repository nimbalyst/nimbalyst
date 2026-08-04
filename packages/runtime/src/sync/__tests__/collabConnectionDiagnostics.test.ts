// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emitCollabConnectionEvent,
  emitCollabLexicalConnectionEvent,
  setCollabConnectionDiagnosticContext,
} from '../collabConnectionDiagnostics';

const diagnosticGlobal = globalThis as typeof globalThis & {
  __NIMBALYST_COLLAB_CONNECTION_DIAGNOSTICS__?: boolean;
};

afterEach(() => {
  delete diagnosticGlobal.__NIMBALYST_COLLAB_CONNECTION_DIAGNOSTICS__;
  vi.restoreAllMocks();
});

describe('collab connection diagnostics', () => {
  it('stays silent until enabled and correlates simultaneous bindings on one shared provider', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const syncProvider = {};
    const firstAdapter = {};
    const secondAdapter = {};

    setCollabConnectionDiagnosticContext(syncProvider, {
      cache: 'body-doc',
      cacheKey: 'bug_2431',
      documentId: 'tracker-content/bug_2431',
      itemId: 'bug_2431',
      shared: true,
    });
    emitCollabConnectionEvent(syncProvider, 'DocumentSyncProvider', 'construct');
    expect(debug).not.toHaveBeenCalled();

    diagnosticGlobal.__NIMBALYST_COLLAB_CONNECTION_DIAGNOSTICS__ = true;
    emitCollabLexicalConnectionEvent(firstAdapter, syncProvider, 'construct');
    emitCollabLexicalConnectionEvent(firstAdapter, syncProvider, 'connect');
    emitCollabLexicalConnectionEvent(firstAdapter, syncProvider, 'bridge-attach');
    emitCollabLexicalConnectionEvent(secondAdapter, syncProvider, 'construct');
    emitCollabLexicalConnectionEvent(secondAdapter, syncProvider, 'connect');
    emitCollabLexicalConnectionEvent(secondAdapter, syncProvider, 'bridge-attach');

    const events = debug.mock.calls.map(([, json]) => JSON.parse(String(json)));
    const overlap = events.at(-1);
    expect(overlap).toMatchObject({
      layer: 'CollabLexicalProvider',
      event: 'bridge-attach',
      cache: 'body-doc',
      cacheKey: 'bug_2431',
      documentId: 'tracker-content/bug_2431',
      itemId: 'bug_2431',
      shared: true,
      adapterCount: 2,
      liveBindings: 2,
      activeBridges: 2,
    });
    expect(events[0].syncProviderId).toBe(overlap.syncProviderId);
    expect(events[0].instanceId).not.toBe(overlap.instanceId);

    emitCollabLexicalConnectionEvent(firstAdapter, syncProvider, 'disconnect');
    const disconnected = JSON.parse(String(debug.mock.calls.at(-1)?.[1]));
    expect(disconnected).toMatchObject({ liveBindings: 1, activeBridges: 2 });
  });
});
