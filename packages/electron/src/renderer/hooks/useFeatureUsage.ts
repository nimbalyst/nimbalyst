import { useState, useEffect, useCallback } from 'react';
import type { FeatureUsageRecord } from '../../shared/featureUsage';

/**
 * Hook for querying and recording feature usage from renderer components.
 * Used for local UX decisions (tips, walkthroughs, onboarding nudges).
 */
export function useFeatureUsage(feature: string) {
  const [record, setRecord] = useState<FeatureUsageRecord | undefined>(undefined);

  useEffect(() => {
    window.electronAPI.featureUsage.get(feature).then(setRecord);
  }, [feature]);

  const recordUsage = useCallback(async () => {
    const updated = await window.electronAPI.featureUsage.record(feature);
    setRecord(updated);
    return updated;
  }, [feature]);

  return {
    count: record?.count ?? 0,
    firstUsed: record?.firstUsed,
    lastUsed: record?.lastUsed,
    record,
    recordUsage,
  };
}
