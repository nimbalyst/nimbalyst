// @vitest-environment node

/**
 * `tracker_define_type({ predicates })` merges by id. It used to
 * replace the whole predicate registry, so two agents extending the vocabulary
 * at once erased each other's verbs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

vi.mock('../../../services/TrackerSchemaService', () => ({
  applyWorkspacePredicateRegistryInProcess: vi.fn(),
}));

import type { PredicateDefinition } from '@nimbalyst/tracker-schema';
import { applyPredicateRegistryArgs } from '../trackerVocabularyArgs';
import { readWorkspacePredicateRegistry } from '../../../services/tracker/trackerPredicateRegistryFile';
import {
  readWorkspaceLabelRegistry,
  workspaceLabelRegistryPath,
  writeWorkspaceLabelRegistry,
} from '../../../services/tracker/trackerLabelRegistryFile';

const verb = (id: string): PredicateDefinition => ({
  id, label: id, subjectKinds: ['*'], valueShape: 'entity', direction: 'directed',
});

describe('tracker_define_type vocabulary arguments', () => {
  let workspacePath: string;
  beforeEach(() => { workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-vocab-')); });
  afterEach(() => { fs.rmSync(workspacePath, { recursive: true, force: true }); });

  it('merges predicates by id and only removes one when asked and confirmed', async () => {
    await applyPredicateRegistryArgs(workspacePath, { predicates: [verb('made-by')] });
    await applyPredicateRegistryArgs(workspacePath, { predicates: [verb('in-market')] });
    expect(readWorkspacePredicateRegistry(workspacePath)?.map(p => p.id)).toEqual(['made-by', 'in-market']);

    const refused = await applyPredicateRegistryArgs(workspacePath, { removePredicates: ['made-by'] });
    expect('error' in refused).toBe(true);
    await applyPredicateRegistryArgs(workspacePath, { removePredicates: ['made-by'], confirmDestructive: true });
    expect(readWorkspacePredicateRegistry(workspacePath)?.map(p => p.id)).toEqual(['in-market']);
  });

  it('persists presentation-only edits without asking for confirmation', async () => {
    await applyPredicateRegistryArgs(workspacePath, { predicates: [verb('made-by')] });
    await applyPredicateRegistryArgs(workspacePath, { predicates: [{ ...verb('made-by'), label: 'is made by' }] });
    expect(readWorkspacePredicateRegistry(workspacePath)?.[0].label).toBe('is made by');
  });

  it('keeps an earlier label registry with qualifiers and claim properties readable and unchanged on save', async () => {
    const yaml = [
      'labels:',
      '  - id: feature',
      '    label: Feature',
      '    properties: [flag, implemented-in]',
      'properties:',
      '  - id: flag',
      '    label: Feature flag',
      '    type: string',
      '    qualifiers:',
      '      rollout: { type: number, label: Rollout % }',
      'claimProperties:',
      '  implemented-in: { range: [feature] }',
      '',
    ].join('\n');
    fs.mkdirSync(path.join(workspacePath, '.nimbalyst'), { recursive: true });
    fs.writeFileSync(workspaceLabelRegistryPath(workspacePath), yaml);

    const loaded = readWorkspaceLabelRegistry(workspacePath);
    expect(loaded?.properties[0].qualifiers).toEqual({ rollout: { type: 'number', label: 'Rollout %' } });
    expect(loaded?.claimProperties).toEqual({ 'implemented-in': { range: ['feature'] } });

    await writeWorkspaceLabelRegistry(workspacePath, loaded!);
    expect(readWorkspaceLabelRegistry(workspacePath)).toEqual(loaded);
  });
});
