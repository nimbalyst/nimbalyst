import { CalcSheetEditor } from './CalcSheetEditor';
import { CalcSheetShareViewer } from './CalcSheetShareViewer';
import './styles.css';

export async function activate(): Promise<void> {
  console.log('[Calc Sheets] Extension activated');
}

export async function deactivate(): Promise<void> {
  console.log('[Calc Sheets] Extension deactivated');
}

export const components = {
  CalcSheetEditor,
  CalcSheetShareViewer,
};
