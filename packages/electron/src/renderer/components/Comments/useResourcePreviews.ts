/**
 * Batched preview resolution for a set of resource references.
 *
 * Previews are re-resolved when the set of URNs changes, and the resolver is
 * expected to apply the reader's CURRENT access every time -- an access change
 * has to be able to turn an available pill into an unavailable one, which it
 * cannot do if a stale entry is kept forever.
 *
 * A resolver that rejects degrades every outstanding ref to `unavailable`
 * rather than leaving pills spinning, because a permanent spinner reads as
 * "still loading" when the truthful answer is "cannot say".
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { ResourcePreviewResolver, ResourcePreviewState, ResourceRef } from './commentTypes';
import { resourceRefToUrn } from './resourceUrn';

export function useResourcePreviews(
  refs: readonly ResourceRef[],
  resolver: ResourcePreviewResolver | null,
): Record<string, ResourcePreviewState> {
  const [previews, setPreviews] = useState<Record<string, ResourcePreviewState>>({});
  const generation = useRef(0);

  const key = useMemo(
    () => refs.map((ref) => resourceRefToUrn(ref)).sort().join('\u0000'),
    [refs],
  );

  // `refs` identity churns every render in most callers; the URN key is what
  // actually determines the work, so it is the only dependency.
  const refsRef = useRef(refs);
  refsRef.current = refs;

  useEffect(() => {
    if (!resolver || key.length === 0) {
      setPreviews({});
      return;
    }
    const current = ++generation.current;
    const pending = refsRef.current;
    let cancelled = false;

    void resolver
      .resolve(pending)
      .then((resolved) => {
        if (cancelled || current !== generation.current) return;
        setPreviews(resolved);
      })
      .catch(() => {
        if (cancelled || current !== generation.current) return;
        const degraded: Record<string, ResourcePreviewState> = {};
        for (const ref of pending) degraded[resourceRefToUrn(ref)] = { availability: 'unavailable' };
        setPreviews(degraded);
      });

    return () => {
      cancelled = true;
    };
  }, [key, resolver]);

  return previews;
}
