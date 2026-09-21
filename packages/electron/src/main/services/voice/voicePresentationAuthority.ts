import Store from '../../utils/privateSettingsStore';
import { createHash } from 'node:crypto';
import { VoicePresentationClaims, type PresentationClaim } from './events/voicePresentationClaims';

let store: Store<Record<string, PresentationClaim>> | undefined;
function storage(): Store<Record<string, PresentationClaim>> {
  return store ??= new Store<Record<string, PresentationClaim>>({ name: 'voice-presentation-claims' });
}
export const voicePresentationAuthority = new VoicePresentationClaims(
  key => storage().get(key),
  (key, value) => storage().set(key, value),
);
export function voicePresentationKey(host: string, workspace: string, eventId: string): string {
  return createHash('sha256').update(JSON.stringify([host, workspace, eventId])).digest('hex');
}

let realtimeDesktopActive: () => boolean = () => false;
export function registerDesktopVoicePresence(read: () => boolean): void { realtimeDesktopActive = read; }
export function desktopRealtimeOwnsVoice(): boolean { return realtimeDesktopActive(); }
