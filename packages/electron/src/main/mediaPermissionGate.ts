import { systemPreferences, type Session } from 'electron';
import { logger } from './utils/logger';

/**
 * macOS microphone gate (GitHub #22 / NIM-1535).
 *
 * Nimbalyst ships the `com.apple.security.device.audio-input` entitlement so
 * Voice Mode can prompt for the microphone. With that entitlement present, ANY
 * Electron session that opens an audio input device triggers the OS microphone
 * prompt — and Chromium touches the mic from ungated contexts during normal,
 * non-voice usage. The leading suspect is the Browser extension's
 * `session.fromPartition(...)` preview sessions, which had no permission
 * handler and therefore default-allowed audio, but the specific toucher has not
 * been positively confirmed.
 *
 * Voice Mode activation explicitly calls
 * `systemPreferences.askForMediaAccess('microphone')`. The default renderer
 * session can allow audio after that OS grant, while sessions used for browsed
 * third-party content remain deny-always. Non-audio permissions keep Electron's
 * default-allow behavior.
 *
 * Install this on EVERY session (see the early `app.on('session-created')` hook
 * in index.ts) so a new extension that spins up its own `fromPartition` session
 * cannot silently reintroduce the ungated path.
 */

interface MediaPermissionDetails {
  mediaType?: string;
  mediaTypes?: string[];
  requestingUrl?: string;
}

export interface MicrophoneGateOptions {
  allowWhenGranted: boolean;
  label?: string;
}

function isAudioRequest(permission: string, details?: MediaPermissionDetails): boolean {
  if (permission === 'audioCapture') return true;
  if (permission === 'media') {
    const types = details?.mediaTypes ?? (details?.mediaType ? [details.mediaType] : []);
    return types.includes('audio');
  }
  return false;
}

function audioAllowed(allowWhenGranted: boolean): boolean {
  // The gate is macOS-specific; other platforms don't have this entitlement
  // model, so don't restrict them.
  if (process.platform !== 'darwin') return true;
  if (!allowWhenGranted) return false;
  try {
    return systemPreferences.getMediaAccessStatus('microphone') === 'granted';
  } catch (err) {
    // Never harden ourselves out of audio on an unexpected error.
    logger.main.warn('[mediaPermissionGate] getMediaAccessStatus failed:', err);
    return true;
  }
}

function logDenial(
  source: 'request' | 'check',
  partition: string,
  origin: string | undefined,
  permission: string,
): void {
  logger.main.warn(
    `[mediaPermissionGate] denied audio ${source} partition=${JSON.stringify(partition)} origin=${JSON.stringify(origin ?? 'unknown')} permission=${JSON.stringify(permission)}`,
  );
}

/**
 * Attach audio permission handlers to a session. Idempotent: calling it again
 * simply replaces the handlers with equivalent ones.
 */
export function installMicrophoneGate(session: Session, opts: MicrophoneGateOptions): void {
  const partition = opts.label ?? session.storagePath ?? 'unknown';

  session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const mediaDetails = details as MediaPermissionDetails;
    if (isAudioRequest(permission, mediaDetails)) {
      const allowed = audioAllowed(opts.allowWhenGranted);
      if (!allowed) {
        logDenial('request', partition, mediaDetails.requestingUrl, permission);
      }
      callback(allowed);
      return;
    }
    callback(true);
  });

  // Chromium also consults the (synchronous) check handler for some media
  // paths; a permissive default here can let a context open the device even
  // when the request handler would deny it.
  session.setPermissionCheckHandler((_wc, permission, origin, details) => {
    if (isAudioRequest(permission, details as MediaPermissionDetails)) {
      const allowed = audioAllowed(opts.allowWhenGranted);
      if (!allowed) {
        logDenial('check', partition, origin, permission);
      }
      return allowed;
    }
    return true;
  });
}
