import { useCallback, useRef, useState, type CSSProperties } from 'react';

/**
 * The transcript's virtual list unmounts rows that leave its buffer. A
 * remounted image row renders a short loading state until its bytes come back,
 * the list sees the row shrink, and it moves the reader back to the image, so
 * they cannot scroll past it. Remembering each image's rendered height and
 * holding it until the image loads keeps the row the same size. Heights are a
 * number per image, so every image is kept.
 */
const heightByKey = new Map<string, number>();

export function useRememberedImageHeight(key: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [settled, setSettled] = useState(false);
  const remembered = key ? heightByKey.get(key) : undefined;

  const onImageLoad = useCallback(() => {
    setSettled(true);
    const height = ref.current?.getBoundingClientRect().height;
    if (key && height) heightByKey.set(key, height);
  }, [key]);
  const onImageError = useCallback(() => setSettled(true), []);

  const style: CSSProperties | undefined = !settled && remembered ? { minHeight: remembered } : undefined;
  return { ref, style, onImageLoad, onImageError };
}
