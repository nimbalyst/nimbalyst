import { useStore } from 'zustand';
import { MaterialSymbol } from '@nimbalyst/extension-sdk';
import type { DataModelStoreApi } from '../store';
import { layoutController } from './controller';
import type { Direction } from './geometry';
export function LayoutControls({ store }: { store: DataModelStoreApi }) {
  const controller = layoutController(store);
  const { busy, direction, setDirection, run } = useStore(controller.state);
  return (
    <div className="datamodel-layout-controls">
      <button
        className="datamodel-toolbar-button datamodel-toolbar-icon-button"
        onClick={() => void run()}
        title={busy ? 'Arranging entities…' : 'Auto-layout entities'}
        aria-label="Auto-layout entities"
        aria-busy={busy}
        disabled={busy || store.getState().entities.length === 0}
      >
        <MaterialSymbol
          icon={busy ? 'hourglass_empty' : 'grid_view'}
          size={18}
        />
      </button>
      <select
        className="datamodel-layout-direction datamodel-toolbar-button"
        aria-label="Layout direction"
        value={direction}
        disabled={busy}
        onChange={(event) => setDirection(event.target.value as Direction)}
      >
        <option value="automatic">Automatic</option>
        <option value="horizontal">Horizontal</option>
        <option value="vertical">Vertical</option>
      </select>
    </div>
  );
}
