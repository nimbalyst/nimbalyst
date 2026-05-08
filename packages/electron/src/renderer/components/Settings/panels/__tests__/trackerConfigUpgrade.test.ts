import { describe, expect, it } from 'vitest';
import {
  buildTrackerUpgradeConfirmOptions,
  canUpgradeTrackerMode,
  getTrackerStorageCopy,
  requiresTrackerUpgradeConfirmation,
} from '../trackerConfigUpgrade';

describe('trackerConfigUpgrade', () => {
  it('requires confirmation when upgrading a local tracker into a synced mode', () => {
    expect(requiresTrackerUpgradeConfirmation('local', 'shared')).toBe(true);
    expect(requiresTrackerUpgradeConfirmation('local', 'hybrid')).toBe(true);
  });

  it('does not require confirmation for unchanged or non-upgrade mode changes', () => {
    expect(requiresTrackerUpgradeConfirmation('local', 'local')).toBe(false);
    expect(requiresTrackerUpgradeConfirmation('shared', 'hybrid')).toBe(false);
    expect(requiresTrackerUpgradeConfirmation('hybrid', 'shared')).toBe(false);
    expect(requiresTrackerUpgradeConfirmation('shared', 'local')).toBe(false);
  });

  it('allows local-to-shared upgrades only for admins', () => {
    expect(canUpgradeTrackerMode('local', 'shared', true)).toBe(true);
    expect(canUpgradeTrackerMode('local', 'hybrid', true)).toBe(true);
    expect(canUpgradeTrackerMode('local', 'shared', false)).toBe(false);
    expect(canUpgradeTrackerMode('local', 'hybrid', false)).toBe(false);
    expect(canUpgradeTrackerMode('shared', 'local', false)).toBe(true);
  });

  it('describes where local and shared tracker config are stored', () => {
    expect(getTrackerStorageCopy()).toContain('.nimbalyst/trackers/*.yaml');
    expect(getTrackerStorageCopy()).toContain('shared Cloudflare-hosted tracker database');
  });

  it('builds the required local-to-shared confirmation copy', () => {
    const options = buildTrackerUpgradeConfirmOptions('Bugs', 'shared');

    expect(options.title).toContain('Upgrade Bugs to shared?');
    expect(options.confirmLabel).toBe('Proceed');
    expect(options.cancelLabel).toBe('Cancel');
    expect(options.message).toContain('local YAML config');
    expect(options.message).toContain('.nimbalyst/trackers/*.yaml');
    expect(options.message).toContain('shared Cloudflare-hosted tracker database');
    expect(options.message).toContain('union of every column already in use');
    expect(options.message).toContain('all tracker items will be preserved');
    expect(options.message).toContain('use your agent to move items, consolidate columns, and delete any extra columns');
  });
});
