import { FeatureUsageService } from '../services/FeatureUsageService';
import type { FeatureUsageRecord } from '../../shared/featureUsage';
import { safeHandle } from '../utils/ipcRegistry';

export function registerFeatureUsageHandlers() {
  const service = FeatureUsageService.getInstance();

  safeHandle('feature-usage:record', (_event, feature: string): FeatureUsageRecord => {
    return service.recordUsage(feature);
  });

  safeHandle('feature-usage:get', (_event, feature: string): FeatureUsageRecord | undefined => {
    return service.getUsage(feature);
  });

  safeHandle('feature-usage:get-count', (_event, feature: string): number => {
    return service.getCount(feature);
  });

  safeHandle('feature-usage:get-all', (): Record<string, FeatureUsageRecord> => {
    return service.getAllUsage();
  });
}
