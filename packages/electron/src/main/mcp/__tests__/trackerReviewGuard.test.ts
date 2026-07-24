/**
 * An agent may move work into review; only a person promotes it past. This is
 * enforced at the tool boundary, not in a prompt, so the guard is pinned here:
 * `tracker_create` and `tracker_update` must refuse `approved` before touching
 * the database.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  globalRegistry,
  type TrackerDataModel,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

vi.mock('../../database/initialize', () => ({ getDatabase: vi.fn(() => null) }));

const { getDatabase } = await import('../../database/initialize');
const getDatabaseMock = vi.mocked(getDatabase);

import { handleTrackerCreate, handleTrackerUpdate } from '../tools/trackerToolHandlers';

const customType = 'review-guard-custom';
const customModel: TrackerDataModel = {
  type: customType,
  displayName: 'Review item',
  displayNamePlural: 'Review items',
  icon: 'fact_check',
  color: '#000000',
  modes: { inline: true, fullDocument: false },
  idPrefix: 'RGC',
  idFormat: 'ulid',
  fields: [
    { name: 'title', type: 'string', required: true },
    {
      name: 'phase',
      type: 'select',
      options: [
        { value: 'in-review', label: 'In review' },
        { value: 'approved', label: 'Approved' },
      ],
    },
  ],
  roles: { title: 'title', workflowStatus: 'phase' },
};

describe('review-lane guard on the agent tools', () => {
  afterEach(() => {
    globalRegistry.unregister(customType);
  });

  it('refuses a create that starts an item already approved', async () => {
    const result = await handleTrackerCreate(
      { type: 'bug', title: 'Self-approved', status: 'approved' },
      '/ws',
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('in-review');
    expect(getDatabaseMock).not.toHaveBeenCalled();
  });

  it('refuses an update that promotes an item to approved', async () => {
    const result = await handleTrackerUpdate({ id: 'NIM-1', status: 'approved' }, '/ws');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('only be set by a person');
    expect(getDatabaseMock).not.toHaveBeenCalled();
  });

  it('refuses approval smuggled through the generic fields bag', async () => {
    const result = await handleTrackerUpdate(
      { id: 'NIM-1', fields: { status: 'Approved' } },
      '/ws',
    );

    expect(result.isError).toBe(true);
    expect(getDatabaseMock).not.toHaveBeenCalled();
  });

  it('refuses approval through a custom workflow-status role', async () => {
    globalRegistry.register(customModel);

    const create = await handleTrackerCreate(
      { type: customType, title: 'Self-approved', fields: { phase: 'approved' } },
      '/ws',
    );
    const update = await handleTrackerUpdate(
      { id: 'RGC-1', fields: { phase: 'approved' } },
      '/ws',
    );

    expect(create.isError).toBe(true);
    expect(update.isError).toBe(true);
    expect(getDatabaseMock).not.toHaveBeenCalled();
  });

  it('lets an agent move work into review', async () => {
    // No guard hit, so the handler proceeds far enough to touch the database
    // (which the mock refuses) rather than short-circuiting with the message.
    const result = await handleTrackerUpdate({ id: 'NIM-1', status: 'in-review' }, '/ws');

    expect(result.content[0].text).not.toContain('only be set by a person');
    expect(getDatabaseMock).toHaveBeenCalled();
  });
});
