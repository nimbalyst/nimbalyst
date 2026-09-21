import React, { useEffect, useMemo, useState } from 'react';
import { atom, useAtomValue } from 'jotai';
import { shellCoverageDetails, type ShellCoverageSummary } from '@nimbalyst/runtime/ai/shellTrackingCoverage';
import { shellTrackingRevisionAtom } from '../../store/atoms/shellTracking';

/** Requeries on persisted link/coverage updates; old requests cannot replace a new scope. */
export function ShellTrackingNotice({ sessionIds }: { sessionIds: string[] }) {
  const key = [...new Set(sessionIds)].sort().join(',');
  const revisionAtom = useMemo(() => atom(get =>
    (key ? key.split(',') : []).reduce((sum, id) => sum + get(shellTrackingRevisionAtom(id)), 0)
  ), [key]);
  const revision = useAtomValue(revisionAtom);
  const [coverage, setCoverage] = useState<ShellCoverageSummary[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setCoverage([]);
    setFailed(false);
  }, [key]);
  useEffect(() => {
    const ids = key ? key.split(',') : [];
    let disposed = false;
    const load = async () => {
      try {
        const result = await window.electronAPI.invoke('session-files:coverage', ids);
        if (!disposed) {
          setCoverage(result);
          setFailed(false);
        }
      } catch {
        if (!disposed) {
          setCoverage([]);
          setFailed(true);
        }
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [key, revision]);
  const details = shellCoverageDetails(coverage);
  const recovering = coverage.some(item => item.observation === 'recovering');
  const historical = coverage.length > 0 && coverage.every(item => item.observation === 'watching');
  if (!failed && !details.length) return null;
  return (
    <details
      className="px-3 py-2 text-xs border-b border-[var(--nim-border)] text-[var(--nim-text-secondary)]"
      data-testid="shell-tracking-notice"
    >
      <summary className="cursor-pointer">
        {failed ? 'File tracking status unavailable' : recovering ? 'File tracking interrupted' : historical ? 'Earlier file tracking gaps' : 'File tracking incomplete'}
      </summary>
      <p className="mt-2">{historical ? 'Tracking has resumed. Earlier edits may be missing from this list.' : 'Some edits may be missing from this list.'} Review your changes before committing.</p>
      {details.length > 0 && (
        <ul className="mt-1 list-disc pl-4">
          {details.map((detail) => (
            <li key={detail}>{detail}.</li>
          ))}
        </ul>
      )}
    </details>
  );
}
