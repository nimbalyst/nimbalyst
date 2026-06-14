import { BrowserWindow } from 'electron';
import { existsSync } from 'fs';
import { isCompletionSoundEnabled, getCompletionSoundType, getCompletionSoundCustomPath, CompletionSoundType } from '../utils/store';
import { findWindowByWorkspace } from '../window/WindowManager';

export class SoundNotificationService {
  private static instance: SoundNotificationService;

  private constructor() {}

  public static getInstance(): SoundNotificationService {
    if (!SoundNotificationService.instance) {
      SoundNotificationService.instance = new SoundNotificationService();
    }
    return SoundNotificationService.instance;
  }

  public playCompletionSound(workspacePath: string): void {
    if (!isCompletionSoundEnabled()) {
      // console.log('[SoundNotification] Completion sound disabled, skipping playback');
      return;
    }

    const soundType = getCompletionSoundType();
    if (soundType === 'none') {
      // console.log('[SoundNotification] Sound type is "none", skipping playback');
      return;
    }

    // 'custom' selected but no playable file configured: play nothing, matching
    // the disabled Test button. Avoids silently surprising the user with chime.
    if (soundType === 'custom') {
      const customPath = getCompletionSoundCustomPath();
      if (!customPath || !existsSync(customPath)) {
        return;
      }
    }

    // console.log(`[SoundNotification] Playing completion sound: ${soundType} for workspace:`, workspacePath);

    // REQUIRED: workspacePath must be provided - sessions are tied to workspaces
    if (!workspacePath) {
      throw new Error('workspacePath is required for sound notification routing');
    }

    // Find window by workspace path (the only stable identifier)
    const targetWindow = findWindowByWorkspace(workspacePath);

    if (!targetWindow || targetWindow.isDestroyed()) {
      console.warn('[SoundNotification] No window found for workspace:', workspacePath);
      return;
    }

    // Send sound playback request to renderer
    targetWindow.webContents.send('play-completion-sound', soundType);
  }

  /**
   * Play a permission request sound to alert the user that the agent needs approval.
   * Only plays when app is backgrounded.
   */
  public playPermissionSound(workspacePath: string): void {
    // Check if any window is visible and focused - skip if app is in foreground
    const allWindows = BrowserWindow.getAllWindows();
    const hasVisibleFocusedWindow = allWindows.some(win => win.isVisible() && win.isFocused());
    if (hasVisibleFocusedWindow) {
      // App is in foreground, skip the sound
      return;
    }

    // REQUIRED: workspacePath must be provided
    if (!workspacePath) {
      console.warn('[SoundNotification] workspacePath is required for permission sound');
      return;
    }

    // Find window by workspace path
    const targetWindow = findWindowByWorkspace(workspacePath);

    if (!targetWindow || targetWindow.isDestroyed()) {
      console.warn('[SoundNotification] No window found for workspace:', workspacePath);
      return;
    }

    // Send permission sound playback request to renderer
    targetWindow.webContents.send('play-permission-sound');
  }

  public testSound(soundType: CompletionSoundType, windowId?: number): void {
    console.log(`[SoundNotification] Testing sound: ${soundType}`);

    let targetWindow: BrowserWindow | null = null;
    if (windowId) {
      targetWindow = BrowserWindow.fromId(windowId);
    } else {
      targetWindow = BrowserWindow.getFocusedWindow();
    }

    if (!targetWindow) {
      const allWindows = BrowserWindow.getAllWindows();
      if (allWindows.length > 0) {
        targetWindow = allWindows[0];
      }
    }

    if (!targetWindow || targetWindow.isDestroyed()) {
      console.warn('[SoundNotification] No valid window found for sound test');
      return;
    }

    targetWindow.webContents.send('play-completion-sound', soundType);
  }
}
