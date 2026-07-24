import type { UploadedEditorAsset } from '../../EditorConfig';

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to read file as data URL'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file as data URL'));
    reader.readAsDataURL(file);
  });
}

export async function uploadEditorImageAsset(
  file: File,
  uploadAsset?: (file: File) => Promise<UploadedEditorAsset>,
  options: { allowDataUrlFallback?: boolean } = {},
): Promise<string> {
  if (uploadAsset) {
    const uploaded = await uploadAsset(file);
    if (uploaded.kind !== 'image') {
      throw new Error('Expected image upload result');
    }
    return uploaded.src;
  }

  if (typeof window !== 'undefined' && (window as any).electronAPI) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Array.from(new Uint8Array(arrayBuffer));
      const documentPath = (window as any).__currentDocumentPath || undefined;
      const { relativePath } = await (window as any).electronAPI.invoke(
        'document-service:store-asset',
        { buffer, mimeType: file.type, documentPath },
      );
      return relativePath;
    } catch (error) {
      if (options.allowDataUrlFallback === false) {
        throw error;
      }
    }
  }

  if (options.allowDataUrlFallback === false) {
    throw new Error('No image upload path available for HTML clipboard image');
  }

  return readFileAsDataUrl(file);
}

export async function dataUrlToImageFile(
  dataUrl: string,
  fileName: string,
): Promise<File> {
  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error(`Failed to decode data URL: ${response.status}`);
  }
  const blob = await response.blob();
  return new File([blob], fileName, { type: blob.type || 'image/png' });
}
