/**
 * Mode selection: attempt live-mode discovery first; fall back to direct.
 * `--live` / `--offline` / `--db` force the choice.
 */
import { DirectGateway } from './DirectGateway.js';
import { LiveGateway } from './LiveGateway.js';
import { discoverEndpoint } from './endpoint.js';
import type { TrackerGateway } from './types.js';
import { connectionError, usageError } from '../cli/exitCodes.js';

export interface ModeOptions {
  live?: boolean;
  offline?: boolean;
  db?: string;
}

export function selectGateway(opts: ModeOptions): TrackerGateway {
  if (opts.live && opts.offline) {
    throw usageError('Cannot combine --live and --offline');
  }

  // Explicit direct: --offline or --db pin direct mode.
  if (opts.offline || opts.db) {
    return new DirectGateway(opts.db);
  }

  const descriptor = discoverEndpoint();

  if (opts.live) {
    if (!descriptor) {
      throw connectionError(
        '--live requested but no running Nimbalyst found (no valid endpoint descriptor). Start the app or drop --live.',
      );
    }
    return new LiveGateway(descriptor);
  }

  // Auto: prefer live when an app is reachable, else direct.
  if (descriptor) {
    return new LiveGateway(descriptor);
  }
  return new DirectGateway();
}
