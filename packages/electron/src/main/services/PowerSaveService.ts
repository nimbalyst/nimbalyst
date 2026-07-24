/**
 * PowerSaveService - Prevents system sleep using Electron's powerSaveBlocker.
 *
 * Uses 'prevent-app-suspension' mode which prevents the system from sleeping
 * but allows the display to dim/sleep normally. Similar to `caffeinate -i` on macOS.
 *
 * Supports three modes:
 * - 'off': No sleep prevention
 * - 'always': Always prevent sleep while sync is connected
 * - 'pluggedIn': Only prevent sleep when on AC power
 */

import { powerSaveBlocker, powerMonitor } from 'electron';
import { logger } from '../utils/logger';

export type PreventSleepMode = 'off' | 'always' | 'pluggedIn';

let blockerId: number | null = null;
let currentMode: PreventSleepMode = 'off';
let syncConnected = false;
let batteryListenersRegistered = false;

/**
 * Set the sleep prevention mode and update blocker state accordingly.
 * Call this when the user changes the setting or when sync connects/disconnects.
 */
export function setSleepPreventionMode(mode: PreventSleepMode): void {
  currentMode = mode;
  registerBatteryListeners();
  reconcile();
}

/**
 * Notify PowerSaveService that sync connection state changed.
 */
export function setSyncConnected(connected: boolean): void {
  syncConnected = connected;
  reconcile();
}

/**
 * Returns whether sleep prevention is currently active.
 */
export function isPreventingSleep(): boolean {
  return blockerId !== null && powerSaveBlocker.isStarted(blockerId);
}

/**
 * Returns the current sleep prevention mode.
 */
export function getSleepPreventionMode(): PreventSleepMode {
  return currentMode;
}

/**
 * Shutdown: stop all blockers and remove listeners.
 */
export function shutdownSleepPrevention(): void {
  stopBlocker();
  currentMode = 'off';
  syncConnected = false;
}

// -- Legacy API for backward compat during migration --

/** @deprecated Use setSleepPreventionMode('always') / setSyncConnected() instead */
export function startPreventingSleep(): void {
  setSleepPreventionMode('always');
}

/** @deprecated Use setSleepPreventionMode('off') instead */
export function stopPreventingSleep(): void {
  setSleepPreventionMode('off');
}

// -- Internal --

function shouldBeBlocking(): boolean {
  if (!syncConnected) return false;
  if (currentMode === 'off') return false;
  if (currentMode === 'always') return true;
  if (currentMode === 'pluggedIn') {
    return !powerMonitor.isOnBatteryPower();
  }
  return false;
}

function reconcile(): void {
  const shouldBlock = shouldBeBlocking();
  const isBlocking = isPreventingSleep();

  if (shouldBlock && !isBlocking) {
    startBlocker();
  } else if (!shouldBlock && isBlocking) {
    stopBlocker();
  }
}

function startBlocker(): void {
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
    return;
  }
  blockerId = powerSaveBlocker.start('prevent-app-suspension');
  logger.main.info(`(POWER) Started sleep prevention (blocker id: ${blockerId}, mode: ${currentMode})`);
}

function stopBlocker(): void {
  if (blockerId === null) return;
  if (powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
    logger.main.info(`(POWER) Stopped sleep prevention (blocker id: ${blockerId})`);
  }
  blockerId = null;
}

function registerBatteryListeners(): void {
  if (batteryListenersRegistered) return;
  batteryListenersRegistered = true;

  powerMonitor.on('on-ac', () => {
    // logger.main.info('(POWER) Switched to AC power');
    reconcile();
  });
  powerMonitor.on('on-battery', () => {
    // logger.main.info('(POWER) Switched to battery power');
    reconcile();
  });
}
