import { PDFViewerEditor } from './PDFViewerEditor';
import './styles/textLayer.css';

// Export the component for the extension system
export const components = {
  PDFViewerEditor,
};

// Extension activation (optional)
export async function activate(context: any) {
  console.log('PDF Viewer extension activated');

  // Load the PDF.js worker and create a blob URL for it
  // This works reliably in both development and production
  try {
    // Worker is in the dist folder alongside the main module
    const workerPath = `${context.extensionPath}/dist/pdf.worker.min.mjs`;
    const workerContent = await context.services.filesystem.readFile(workerPath);
    const workerBlob = new Blob([workerContent], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(workerBlob);

    // Store the worker URL globally
    (window as any).__pdfViewerWorkerUrl = workerUrl;
    console.log('[PDF Viewer] Worker loaded and blob URL created');
  } catch (error) {
    console.error('[PDF Viewer] Failed to load worker:', error);
  }
}

// Extension deactivation (optional)
export async function deactivate() {
  console.log('PDF Viewer extension deactivated');
}
