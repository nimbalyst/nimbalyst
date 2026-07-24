import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  isTrackerSchemaFile,
  shouldIgnoreTrackerWatchPath,
} from '../trackerSchemaWatchUtils';

describe('trackerSchemaWatchUtils', () => {
  const trackersDir = path.join('/tmp', 'workspace', '.nimbalyst', 'trackers');

  it('matches yaml tracker schema files', () => {
    expect(isTrackerSchemaFile(path.join(trackersDir, 'tracker.yaml'))).toBe(true);
    expect(isTrackerSchemaFile(path.join(trackersDir, 'tracker.yml'))).toBe(true);
    expect(isTrackerSchemaFile(path.join(trackersDir, 'tracker.json'))).toBe(false);
  });

  it('does not ignore normal files inside .nimbalyst/trackers', () => {
    expect(shouldIgnoreTrackerWatchPath(trackersDir, trackersDir)).toBe(false);
    expect(shouldIgnoreTrackerWatchPath(trackersDir, path.join(trackersDir, 'github-pr.yaml'))).toBe(false);
  });

  it('still ignores dotfiles within the watched directory', () => {
    expect(shouldIgnoreTrackerWatchPath(trackersDir, path.join(trackersDir, '.github-pr.yaml.swp'))).toBe(true);
  });
});
