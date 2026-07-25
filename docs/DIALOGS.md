# Dialog System

Nimbalyst uses a centralized dialog management system via `DialogProvider`. All dialogs should be registered through this system rather than adding state directly to `App.tsx`.

## Architecture

The dialog system consists of:

- **DialogProvider** (`packages/electron/src/renderer/contexts/DialogContext.tsx`): React context that manages dialog state and rendering
- **Dialog Registry** (`packages/electron/src/renderer/dialogs/registry.ts`): Central registry of dialog IDs and types
- **Dialog Adapters** (`packages/electron/src/renderer/dialogs/*.tsx`): Wrapper components that adapt existing dialogs to the DialogProvider interface

## Adding a New Dialog

### 1. Add Dialog ID to Registry

In `packages/electron/src/renderer/dialogs/registry.ts`, add your dialog ID:

```typescript
export const DIALOG_IDS = {
  // ... existing IDs

  // Your new dialog
  MY_NEW_DIALOG: 'my-new-dialog',
} as const;
```

### 2. Create Dialog Data Interface and Wrapper

In the appropriate adapter file (usually `dataDialogs.tsx` for dialogs that need data):

```typescript
// Define the data your dialog needs
export interface MyNewDialogData {
  workspacePath: string;
  someOtherProp: string;
}

// Create a wrapper component
function MyNewDialogWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: MyNewDialogData;
}) {
  return (
    <MyActualDialog
      isOpen={isOpen}
      onClose={onClose}
      workspacePath={data.workspacePath}
      someOtherProp={data.someOtherProp}
    />
  );
}
```

### 3. Register the Dialog

In the same adapter file's registration function:

```typescript
export function registerDataDialogs() {
  // ... existing registrations

  registerDialog<MyNewDialogData>({
    id: DIALOG_IDS.MY_NEW_DIALOG,
    group: 'system',  // Choose appropriate group
    component: MyNewDialogWrapper as DialogConfig<MyNewDialogData>['component'],
    priority: 200,
  });
}
```

### 4. Export the Data Type

In `packages/electron/src/renderer/dialogs/index.ts`:

```typescript
export {
  registerDataDialogs,
  type ProjectSelectionData,
  type ErrorDialogData,
  type MyNewDialogData,  // Add your type
} from './dataDialogs';
```

### 5. Open the Dialog

Use `dialogRef` to open your dialog:

```typescript
import { dialogRef, DIALOG_IDS } from './dialogs';

// In a component or effect:
if (dialogRef.current) {
  dialogRef.current.open(DIALOG_IDS.MY_NEW_DIALOG, {
    workspacePath: '/path/to/workspace',
    someOtherProp: 'value',
  });
}
```

## Dialog Groups

Dialogs are organized into groups that control mutual exclusivity:

- **navigation**: Quick open, session quick open, command palette (mutually exclusive)
- **help**: Keyboard shortcuts
- **settings**: API key dialog
- **alert**: Confirm dialog, error dialog
- **system**: Project selection, session import
- **promotion**: Discord invitation
- **feedback**: PostHog survey
- **onboarding**: Onboarding flows, Windows warnings

Dialogs in the same group are mutually exclusive - opening one closes others in the group.

## Opening Dialogs from IPC (Menu Items)

For dialogs triggered by menu items:

### 1. Add Menu Item (Main Process)

In `packages/electron/src/main/menu/ApplicationMenu.ts`:

```typescript
{
  label: 'Show My Dialog',
  click: async () => {
    const focused = getFocusedWindow();
    if (focused) {
      focused.webContents.send('show-my-dialog');
    }
  }
}
```

### 2. Add IPC Listener (Renderer)

In `App.tsx`, add an effect to listen for the IPC event:

```typescript
useEffect(() => {
  if (!window.electronAPI?.on) return;

  const handleShowMyDialog = () => {
    if (dialogRef.current && workspacePath) {
      dialogRef.current.open(DIALOG_IDS.MY_NEW_DIALOG, {
        workspacePath,
        someOtherProp: 'value',
      });
    }
  };

  const unsubscribe = window.electronAPI.on('show-my-dialog', handleShowMyDialog);

  return () => {
    unsubscribe();
  };
}, [workspacePath]);
```

Unsubscribe with the closure `on()` returns. There is no `off(channel, callback)` — see [IPC_LISTENERS.md](./IPC_LISTENERS.md).

## Best Practices

1. **Never add dialog state to App.tsx** - Use the DialogProvider system
2. **Use appropriate groups** - This ensures proper mutual exclusivity behavior
3. **Set reasonable priorities** - Higher priority dialogs take precedence (errors = 400, system = 300, etc.)
4. **Export data types** - Make sure your dialog's data interface is exported from `index.ts`
5. **Keep wrappers simple** - The wrapper should just bridge props, not contain business logic
