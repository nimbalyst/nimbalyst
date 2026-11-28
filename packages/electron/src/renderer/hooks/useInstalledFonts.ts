import { useCallback, useState } from 'react';
import { uniqueFontFamilies } from '../utils/fontSettings';

type LocalFontsWindow = Window & {
  queryLocalFonts?: () => Promise<Array<{ family: string }>>;
};

/**
 * Installed font families, loaded on the first call to `load`. `queryLocalFonts()` needs a user
 * gesture, so call `load` from a focus or click handler. If it is unavailable or refused, the
 * list stays empty and the fields remain free text.
 */
export function useInstalledFonts(): { families: string[]; load: () => void } {
  const [families, setFamilies] = useState<string[]>([]);
  const [requested, setRequested] = useState(false);

  const load = useCallback(() => {
    if (requested) return;
    setRequested(true);
    const query = (window as LocalFontsWindow).queryLocalFonts;
    if (!query) return;
    query
      .call(window)
      .then((faces) => setFamilies(uniqueFontFamilies(faces)))
      .catch((error) => console.warn('[FontsPanel] Listing installed fonts failed:', error));
  }, [requested]);

  return { families, load };
}
