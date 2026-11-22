import { useState, useEffect } from 'react';
import { localAssetUrl } from '../../../../utils/localAssetUrl';
import type { DisplayImageContent } from '../../utils/transcriptImages';

type ReadFile = (path: string) => Promise<{ success: boolean; content?: string; error?: string }>;

/** Inline bytes win; otherwise a URL for the local file at `path`. */
export function imageSrc(image: DisplayImageContent): string {
  if (image.data) return `data:${image.mimeType || 'image/png'};base64,${image.data}`;
  return localAssetUrl(image.path);
}

const MIME_TYPES: Record<string, string> = {
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'svg': 'image/svg+xml',
  'bmp': 'image/bmp'
};

function inlineSrc(image: DisplayImageContent): string | null {
  return image.data ? imageSrc(image) : null;
}

/**
 * Resolve an image to a loadable src. The thumbnail and the lightbox must share
 * this: `nim-asset://` only serves workspace roots, so a path elsewhere (e.g.
 * /tmp) only renders through the bytes `readFile` returns.
 */
export function useImageSource(image: DisplayImageContent, readFile?: ReadFile) {
  const [imageData, setImageData] = useState<string | null>(() => inlineSrc(image));
  const [loading, setLoading] = useState(() => !image.data);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadImage = async () => {
      try {
        if (image.data) {
          setImageData(imageSrc(image));
          setLoading(false);
          return;
        }

        // First try using readFile if available (for base64 loading)
        if (readFile) {
          const result = await readFile(image.path);
          if (result.success && result.content) {
            // Check if content is already base64 or needs conversion
            let src = result.content;
            if (!src.startsWith('data:')) {
              const ext = image.path.split('.').pop()?.toLowerCase();
              const mimeType = MIME_TYPES[ext || ''] || 'image/png';
              src = `data:${mimeType};base64,${result.content}`;
            }
            setImageData(src);
            setLoading(false);
            return;
          } else if (result.error) {
            console.error('[VisualDisplayWidget] Failed to read image file:', {
              path: image.path,
              error: result.error
            });
            setError(`Failed to load image: ${result.error}`);
            setLoading(false);
            return;
          }
        }

        // Fall back to a renderer-loadable URL for local Electron images.
        // `localAssetUrl` returns `nim-asset://` in Electron (the main window
        // runs with `webSecurity: true` and cannot load `file://`) and
        // `file://` for non-Electron consumers.
        setImageData(imageSrc(image));
        setLoading(false);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        console.error('[VisualDisplayWidget] Image load exception:', {
          path: image.path,
          error: errorMessage
        });
        setError(`Failed to load image: ${errorMessage}`);
        setLoading(false);
      }
    };

    loadImage();
  }, [image.path, image.data, image.mimeType, readFile]);

  return { imageData, loading, error, setError };
}
