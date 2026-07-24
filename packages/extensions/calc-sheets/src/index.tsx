import type { ExtensionContext } from '@nimbalyst/extension-sdk';
import { CalcSheetEditor } from './CalcSheetEditor';
import { CalcSheetShareViewer } from './CalcSheetShareViewer';
import { CalcSheetCollabContentAdapter } from './collab/CalcSheetCollabContentAdapter';
import './styles.css';

export { CalcSheetCollabContentAdapter };

export async function activate(context?: ExtensionContext): Promise<void> {
  // Register the collab adapter so `.calc.md` docs can be shared and the host
  // can project/re-upload their Y.Doc content. Guarded for older hosts whose
  // context predates the collab service.
  context?.services?.collab?.registerContentAdapter?.(CalcSheetCollabContentAdapter);
  console.log('[Calc Sheets] Extension activated');
}

export async function deactivate(): Promise<void> {
  console.log('[Calc Sheets] Extension deactivated');
}

export const components = {
  CalcSheetEditor,
  CalcSheetShareViewer,
};
