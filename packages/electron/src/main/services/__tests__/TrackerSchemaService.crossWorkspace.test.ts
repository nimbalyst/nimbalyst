/**
 * Cross-workspace tracker schema isolation (GitHub #1035 / NIM-2224).
 *
 * The tracker schema registry is process-global and keyed by TYPE NAME ONLY, so
 * two open projects that both define a `widget` type share one slot. A read-only
 * MCP call for project B used to `register()` B's models into the live view,
 * silently replacing project A's `widget` schema -- A then validated its items
 * against B's required fields and status options until restart.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same electron / ipc / chokidar mocks as the sibling TrackerSchemaService tests
// so the real service can run headless against temp workspace dirs.
const { mockSafeHandle, mockWatch, mockWindowSend } = vi.hoisted(() => ({
  mockSafeHandle: vi.fn(),
  mockWatch: vi.fn(() => ({
    on() {
      return this;
    },
    close: vi.fn().mockResolvedValue(undefined),
  })),
  mockWindowSend: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    isPackaged: false,
    getName: vi.fn(() => 'Nimbalyst'),
    getVersion: vi.fn(() => '0.0.0-test'),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    isReady: vi.fn(() => true),
    quit: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: mockWindowSend } }],
  },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: mockSafeHandle,
  safeOn: vi.fn(),
  safeOnce: vi.fn(),
}));

vi.mock('chokidar', () => ({
  default: { watch: mockWatch },
}));

// TrackerSchemaService transitively imports ../../database/initialize (via
// trackerTypeDefStore -> getDatabase), which drags in the sync/auth graph. Stub
// it so this file owns its state; DB writes are best-effort and tolerate null.
vi.mock('../../database/initialize', () => ({
  getDatabase: () => null,
}));

interface FieldLike {
  name: string;
  required?: boolean;
  options?: Array<{ value: string }>;
}

function widgetYaml(requiredOwner: boolean, statusOptions: string[]): string {
  return `packageVersion: 1.0.0
packageId: developer

type: widget
displayName: Widget
displayNamePlural: Widgets
icon: campaign
color: "#0f766e"

modes:
  inline: true
  fullDocument: false

sync:
  mode: local
  scope: project

idPrefix: wid
idFormat: ulid

fields:
  - name: title
    type: string
    required: true
  - name: owner
    type: string
    required: ${requiredOwner}
  - name: status
    type: select
    options:
${statusOptions.map((o) => `      - value: ${o}\n        label: ${o}`).join('\n')}

roles:
  title: title
`;
}

function gadgetYaml(): string {
  return `packageVersion: 1.0.0
packageId: developer

type: gadget
displayName: Gadget
displayNamePlural: Gadgets
icon: campaign
color: "#0f766e"

modes:
  inline: true
  fullDocument: false

sync:
  mode: local
  scope: project

idPrefix: gad
idFormat: ulid

fields:
  - name: title
    type: string
    required: true

roles:
  title: title
`;
}

async function writeSchema(workspacePath: string, fileName: string, content: string): Promise<void> {
  const dir = path.join(workspacePath, '.nimbalyst', 'trackers');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fileName), content, 'utf-8');
}

function ownerRequired(model: { fields: FieldLike[] } | undefined): boolean | undefined {
  return model?.fields.find((f) => f.name === 'owner')?.required;
}

describe('TrackerSchemaService cross-workspace isolation (#1035)', () => {
  let wsA: string;
  let wsB: string;
  let service: typeof import('../TrackerSchemaService');
  let scope: typeof import('../tracker/trackerSchemaScope');
  let globalRegistry: import('@nimbalyst/runtime/plugins/TrackerPlugin/models').TrackerDataModelRegistry;

  beforeEach(async () => {
    vi.resetModules();
    wsA = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-ws-a-'));
    wsB = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-ws-b-'));

    // A: owner optional, `in-review` is a valid status.
    await writeSchema(wsA, 'widget.yaml', widgetYaml(false, ['open', 'in-review']));
    // B: same type NAME, stricter -- owner required, no `in-review`. Plus a
    // custom type that exists only in B.
    await writeSchema(wsB, 'widget.yaml', widgetYaml(true, ['open']));
    await writeSchema(wsB, 'gadget.yaml', gadgetYaml());

    service = await import('../TrackerSchemaService');
    scope = await import('../tracker/trackerSchemaScope');
    ({ globalRegistry } = await import('@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel'));
  });

  it('keeps the active workspace schema intact after a call targeting another workspace', () => {
    service.initTrackerSchemaService(wsA);

    // Baseline: A's schema is active.
    expect(ownerRequired(service.getTrackerSchema('widget') as any)).toBe(false);
    expect(globalRegistry.validate('widget', { title: 't', status: 'in-review' }).valid).toBe(true);

    // A read-only MCP call for workspace B.
    service.ensureWorkspaceTrackerSchemasLoaded(wsB);

    // A's schema must be untouched: owner still optional, `in-review` still valid.
    expect(ownerRequired(service.getTrackerSchema('widget') as any)).toBe(false);
    const result = globalRegistry.validate('widget', { title: 't', status: 'in-review' });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('does not leak the other workspace custom types into the active view', () => {
    service.initTrackerSchemaService(wsA);
    service.ensureWorkspaceTrackerSchemasLoaded(wsB);

    // `gadget` exists only in B and must not appear in A's registry.
    expect(service.getTrackerSchema('gadget')).toBeUndefined();
    expect(globalRegistry.has('gadget')).toBe(false);
    expect(service.getAllTrackerSchemas().map((m) => m.type)).not.toContain('gadget');
  });

  it('resolves the other workspace schemas when reads are scoped to it (NIM-760)', () => {
    service.initTrackerSchemaService(wsA);
    service.ensureWorkspaceTrackerSchemasLoaded(wsB);

    scope.runWithTrackerSchemaWorkspace(wsB, () => {
      // B's custom type is visible on B's behalf...
      expect(service.getTrackerSchema('gadget')?.type).toBe('gadget');
      expect(globalRegistry.has('gadget')).toBe(true);
      // ...and B's stricter `widget` override applies, not A's.
      expect(ownerRequired(service.getTrackerSchema('widget') as any)).toBe(true);
      const result = globalRegistry.validate('widget', { title: 't', status: 'in-review' });
      expect(result.valid).toBe(false);
      expect(result.errors.map((e) => e.field)).toContain('owner');
    });

    // Leaving the scope restores A's view.
    expect(ownerRequired(service.getTrackerSchema('widget') as any)).toBe(false);
    expect(service.getTrackerSchema('gadget')).toBeUndefined();
  });

  it('scoped reads fall back to built-ins, never to the active workspace override', async () => {
    const wsC = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-ws-c-'));
    service.initTrackerSchemaService(wsA);

    // wsC has no schema dir at all, so nothing was ever cached for it.
    scope.runWithTrackerSchemaWorkspace(wsC, () => {
      // A's custom `widget` must not be visible to an unrelated workspace...
      expect(service.getTrackerSchema('widget')).toBeUndefined();
      // ...but built-in types still resolve.
      expect(service.getTrackerSchema('bug')?.type).toBe('bug');
    });
  });

  it('still registers into the live view for the active workspace', () => {
    service.initTrackerSchemaService(wsB);

    // Same workspace: additive registration into the live view, as before.
    service.ensureWorkspaceTrackerSchemasLoaded(wsB);
    expect(service.getTrackerSchema('gadget')?.type).toBe('gadget');
    expect(ownerRequired(service.getTrackerSchema('widget') as any)).toBe(true);
  });

  it('registers into the live view when no workspace has claimed it yet', () => {
    // MCP can serve a tracker call before any workspace window opens; the live
    // view is nobody's to corrupt, so registration stays global there.
    service.initTrackerSchemaService(null);
    service.ensureWorkspaceTrackerSchemasLoaded(wsB);

    expect(service.getTrackerSchema('gadget')?.type).toBe('gadget');
    expect(ownerRequired(service.getTrackerSchema('widget') as any)).toBe(true);
  });

  it('drops a cached layer type whose YAML was deleted', async () => {
    service.initTrackerSchemaService(wsA);
    service.ensureWorkspaceTrackerSchemasLoaded(wsB);

    scope.runWithTrackerSchemaWorkspace(wsB, () => {
      expect(service.getTrackerSchema('gadget')?.type).toBe('gadget');
    });

    await fs.unlink(path.join(wsB, '.nimbalyst', 'trackers', 'gadget.yaml'));
    service.ensureWorkspaceTrackerSchemasLoaded(wsB);

    // The layer is replaced from disk on each load, so the deleted type is gone.
    scope.runWithTrackerSchemaWorkspace(wsB, () => {
      expect(service.getTrackerSchema('gadget')).toBeUndefined();
    });
  });
});
