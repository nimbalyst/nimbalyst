/**
 * Static singleton repository for TranscriptMigrationService access.
 * Follows the same pattern as TranscriptEventRepository: the Electron main
 * process calls setService() at startup, and SessionManager accesses
 * the service via the static methods.
 */

import type { TranscriptMigrationService } from '../../ai/server/transcript/TranscriptMigrationService';

let serviceInstance: TranscriptMigrationService | null = null;

export const TranscriptMigrationRepository = {
  setService(service: TranscriptMigrationService): void {
    serviceInstance = service;
  },

  clearService(): void {
    serviceInstance = null;
  },

  getService(): TranscriptMigrationService {
    if (!serviceInstance) {
      throw new Error('Transcript migration service has not been provided to the runtime');
    }
    return serviceInstance;
  },

  hasService(): boolean {
    return serviceInstance != null;
  },
};
