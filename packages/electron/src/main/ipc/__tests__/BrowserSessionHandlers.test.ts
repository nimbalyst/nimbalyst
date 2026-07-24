import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  BROWSER_TRANSCRIPT_IMAGE_DIRNAME,
  getBrowserTranscriptImageDir,
} from '../BrowserSessionHandlers';

describe('getBrowserTranscriptImageDir', () => {
  it('stores transcript screenshots under a durable .nimbalyst subdirectory', () => {
    const workspacePath = path.join('/tmp', 'workspace');

    expect(getBrowserTranscriptImageDir(workspacePath)).toBe(
      path.join(workspacePath, '.nimbalyst', BROWSER_TRANSCRIPT_IMAGE_DIRNAME),
    );
  });

  it('normalizes the workspace path before joining the transcript image directory', () => {
    const workspacePath = path.join('/tmp', 'workspace', '..', 'workspace', '.');

    expect(getBrowserTranscriptImageDir(workspacePath)).toBe(
      path.join('/tmp', 'workspace', '.nimbalyst', BROWSER_TRANSCRIPT_IMAGE_DIRNAME),
    );
  });
});
