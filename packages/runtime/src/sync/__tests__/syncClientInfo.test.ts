import { afterEach, describe, expect, it } from 'vitest';
import {
  appendSyncClientParams,
  getSyncClientInfo,
  setSyncClientInfo,
} from '../syncClientInfo';

const DEFAULTS = { platform: 'desktop', version: 'unknown' };

afterEach(() => {
  // Reset the module-level singleton so tests don't leak state.
  setSyncClientInfo(DEFAULTS);
});

describe('appendSyncClientParams', () => {
  it('appends platform and version after an existing token query', () => {
    setSyncClientInfo({ platform: 'desktop', version: '1.4.2' });
    const url = appendSyncClientParams('wss://sync.nimbalyst.com/sync/room?token=jwt');
    expect(url).toBe(
      'wss://sync.nimbalyst.com/sync/room?token=jwt&platform=desktop&version=1.4.2'
    );
  });

  it('URL-encodes the label values', () => {
    setSyncClientInfo({ platform: 'web', version: '1.0.0 beta/2' });
    const url = appendSyncClientParams('wss://host/sync/r?token=t');
    expect(url).toBe('wss://host/sync/r?token=t&platform=web&version=1.0.0%20beta%2F2');
  });

  it('clamps each label to 32 chars before encoding', () => {
    const longVersion = 'v'.repeat(40);
    setSyncClientInfo({ platform: 'mobile', version: longVersion });
    const url = appendSyncClientParams('wss://host/sync/r?token=t');
    expect(url).toBe(`wss://host/sync/r?token=t&platform=mobile&version=${'v'.repeat(32)}`);
  });

  it('defaults to desktop/unknown when never set', () => {
    expect(getSyncClientInfo()).toEqual(DEFAULTS);
    const url = appendSyncClientParams('wss://host/sync/r?token=t');
    expect(url).toBe('wss://host/sync/r?token=t&platform=desktop&version=unknown');
  });
});
