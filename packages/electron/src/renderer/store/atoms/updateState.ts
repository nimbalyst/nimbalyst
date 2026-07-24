import { atom } from 'jotai';

export type UpdateState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'viewing-notes' | 'downloading' | 'ready' | 'waiting-for-sessions' | 'error';

export interface UpdateInfo {
  version: string;
  releaseNotes?: string;
  releaseDate?: string;
}

export interface DownloadProgress {
  bytesPerSecond: number;
  percent: number;
  transferred: number;
  total: number;
}

export interface UpdateStateData {
  state: UpdateState;
  updateInfo: UpdateInfo | null;
  currentVersion: string;
  downloadProgress: DownloadProgress | null;
  errorMessage: string;
}

export const updateStateAtom = atom<UpdateStateData>({
  state: 'idle',
  updateInfo: null,
  currentVersion: '',
  downloadProgress: null,
  errorMessage: '',
});
