// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  BUILTIN_TRACKER_YAML,
  parseBuiltinTrackers,
  loadBuiltinTrackers,
} from '../ModelLoader';
import { globalRegistry, type TrackerDataModel } from '@nimbalyst/tracker-schema';

/**
 * Guards the migration of the built-in tracker definitions from the old hardcoded
 * `builtinTrackers` array in ModelLoader.ts to bundled YAML under ./builtins.
 *
 * A malformed builtin YAML (or a dropped/renamed required role) must fail CI here
 * instead of silently dropping a type at runtime. The property table also pins the
 * behavior-preserving invariants so the YAML can't quietly diverge from what the
 * code array shipped.
 */

const EXPECTED = [
  'plan',
  'decision',
  'bug',
  'task',
  'idea',
  'milestone',
  'release',
  // Knowledge-scopes evidence kinds (master plan section 3, N7).
  'source',
  'capture',
  'citation',
  // GitHub panel overlays.
  'github-issue',
  'github-pr',
] as const;

// Behavior-preserving invariants carried over from the pre-migration code array.
const INVARIANTS: Record<string, {
  idPrefix: string;
  sharing: 'personal' | 'team';
  draftByDefault: boolean;
  creatable?: boolean;
}> = {
  plan: { idPrefix: 'pln', sharing: 'team', draftByDefault: true },
  decision: { idPrefix: 'dec', sharing: 'team', draftByDefault: false },
  bug: { idPrefix: 'bug', sharing: 'team', draftByDefault: false },
  task: { idPrefix: 'tsk', sharing: 'team', draftByDefault: false },
  idea: { idPrefix: 'id', sharing: 'personal', draftByDefault: false },
  // Collection types: both shared, since a sprint or release is a team artifact.
  milestone: { idPrefix: 'mst', sharing: 'team', draftByDefault: false },
  release: { idPrefix: 'rel', sharing: 'team', draftByDefault: false },
  // Evidence kinds start personal: the pilot's `me:` scope is where a citation
  // is written, and publishing it to the team is the existing per-item action.
  source: { idPrefix: 'src', sharing: 'personal', draftByDefault: false },
  capture: { idPrefix: 'cap', sharing: 'personal', draftByDefault: false },
  citation: { idPrefix: 'cit', sharing: 'personal', draftByDefault: false },
  // Overlays are personal by default: clicking Review or Investigate must not
  // publish to a team tracker unless the workspace's schema says so.
  'github-issue': { idPrefix: 'ghi', sharing: 'personal', draftByDefault: false },
  'github-pr': { idPrefix: 'ghp', sharing: 'personal', draftByDefault: false },
};

/** Section 3 pins `modes.fullDocument: false` on all three evidence kinds. */
const EVIDENCE_KINDS = ['source', 'capture', 'citation'] as const;

describe('bundled builtin tracker YAML', () => {
  it('bundles exactly the expected builtin types, in load order', () => {
    expect(BUILTIN_TRACKER_YAML.map((b) => b.type)).toEqual([...EXPECTED]);
  });

  it('parses every bundled builtin without throwing', () => {
    const models = parseBuiltinTrackers();
    expect(models).toHaveLength(EXPECTED.length);
  });

  it('every builtin declares a title role and a workflowStatus role backed by a select field', () => {
    const models = parseBuiltinTrackers();
    for (const model of models) {
      const titleField = model.roles?.title;
      const statusField = model.roles?.workflowStatus;
      expect(titleField, `${model.type} title role`).toBeTruthy();
      expect(statusField, `${model.type} workflowStatus role`).toBeTruthy();

      // The role must resolve to a real field on the model.
      const status = model.fields.find((f) => f.name === statusField);
      expect(status, `${model.type} status field '${statusField}'`).toBeDefined();
      expect(status!.type, `${model.type} status field type`).toBe('select');
      expect(status!.options?.length, `${model.type} status options`).toBeGreaterThan(0);

      // Required-field baseline: a title string field must exist.
      const title = model.fields.find((f) => f.name === titleField);
      expect(title, `${model.type} title field '${titleField}'`).toBeDefined();
      expect(title!.type).toBe('string');
    }
  });

  it('preserves the behavior-preserving invariants from the old code array', () => {
    const byType = new Map<string, TrackerDataModel>(
      parseBuiltinTrackers().map((m) => [m.type, m])
    );
    for (const type of EXPECTED) {
      const model = byType.get(type)!;
      const inv = INVARIANTS[type];
      expect(model.idPrefix, `${type} idPrefix`).toBe(inv.idPrefix);
      expect(model.sharing, `${type} sharing`).toBe(inv.sharing);
      expect(model.draftByDefault, `${type} draft default`).toBe(inv.draftByDefault);
      if (inv.creatable !== undefined) {
        expect(model.creatable, `${type} creatable`).toBe(inv.creatable);
      }
    }
  });

  it('keeps the evidence kinds out of type lists until the workspace defines claim', () => {
    // Every existing tracker user gets these builtins; they must not appear in
    // create menus, Tracker Mode, or tracker_list_types for a workspace that
    // has not defined claim. They stay registered so citations render.
    loadBuiltinTrackers();
    globalRegistry.clearWorkspaceSchema('claim');
    const listed = () => globalRegistry.getListed().map((m) => m.type);
    for (const type of EVIDENCE_KINDS) {
      expect(globalRegistry.has(type), `${type} registered`).toBe(true);
      expect(listed(), `${type} listed without claim`).not.toContain(type);
    }
    expect(listed()).toContain('bug');

    globalRegistry.register({ ...globalRegistry.get('bug')!, type: 'claim' });
    try {
      for (const type of EVIDENCE_KINDS) expect(listed(), `${type} listed with claim`).toContain(type);
    } finally {
      globalRegistry.clearWorkspaceSchema('claim');
    }
    for (const type of EVIDENCE_KINDS) {
      expect(listed(), `${type} listed after removing claim`).not.toContain(type);
      expect(globalRegistry.has(type), `${type} still resolvable`).toBe(true);
    }
  });

  it('keeps the GitHub overlays unlisted until a workspace schema replaces them', () => {
    loadBuiltinTrackers();
    const listed = () => globalRegistry.getListed().map((m) => m.type);
    for (const type of ['github-issue', 'github-pr']) {
      globalRegistry.clearWorkspaceSchema(type);
      expect(globalRegistry.get(type)?.listed, `${type} parsed listed flag`).toBe(false);
      expect(listed(), `${type} listed as builtin`).not.toContain(type);

      // A workspace's own full schema (this repo's triage types) lists it again.
      const { listed: _unlisted, ...workspaceModel } = globalRegistry.get(type)!;
      globalRegistry.register(workspaceModel);
      try {
        expect(listed(), `${type} listed with a workspace schema`).toContain(type);
      } finally {
        globalRegistry.clearWorkspaceSchema(type);
      }
      expect(listed(), `${type} unlisted after the workspace schema goes`).not.toContain(type);
    }
  });

  it('keeps the evidence kinds out of full-document mode', () => {
    // A source, a capture, and a citation are records about something else.
    // Giving them a document body would invite the argument to be written in
    // the wrong place, where no claim can cite it.
    const byType = new Map(parseBuiltinTrackers().map((m) => [m.type, m]));
    for (const type of EVIDENCE_KINDS) {
      expect(byType.get(type)!.modes?.fullDocument, `${type} fullDocument`).toBe(false);
    }
  });

  it('carries the citation locator field through the YAML parser as a declared shape', () => {
    // The parser copies field properties by an explicit allowlist, so a dropped
    // `objectShape` would leave `locator` validated as opaque JSON with nothing
    // at runtime saying the locator contract was never enforced.
    const citation = parseBuiltinTrackers().find((m) => m.type === 'citation')!;
    const locator = citation.fields.find((f) => f.name === 'locator')!;
    expect(locator.type).toBe('object');
    expect(locator.objectShape).toBe('citation-locator');
  });

  it('registers all builtins into the registry as builtin types', () => {
    loadBuiltinTrackers();
    for (const type of EXPECTED) {
      expect(globalRegistry.get(type), `${type} registered`).toBeDefined();
      expect(globalRegistry.isBuiltin(type), `${type} isBuiltin`).toBe(true);
    }
  });

  // The collab worker resolves a team's builtin overrides against this
  // generated copy (#1880). A YAML edit that did not regenerate it would leave
  // the server resolving deltas against different builtins than desktops do.
  it('matches the catalog the collab worker bundles (run `pnpm --filter @nimbalyst/tracker-builtins build`)', () => {
    const catalog = JSON.parse(readFileSync(
      new URL('../../../../../../tracker-builtins/src/builtinCatalog.json', import.meta.url), 'utf8',
    ));
    expect(catalog).toEqual(JSON.parse(JSON.stringify(parseBuiltinTrackers())));
  });
});
