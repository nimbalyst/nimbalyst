/**
 * ExtensionHostComponents - Renders host components from loaded extensions.
 *
 * Extensions can contribute host components that need to be rendered at the app level
 * (e.g., picker menus, floating dialogs). This component renders all such components
 * from enabled extensions.
 */

import type { JSX } from 'react';
import { useState, useEffect } from 'react';
import { getExtensionLoader } from '@nimbalyst/runtime';
import type { ComponentType } from 'react';

interface HostComponentInfo {
  extensionId: string;
  componentName: string;
  component: ComponentType;
}

export function ExtensionHostComponents(): JSX.Element {
  const [hostComponents, setHostComponents] = useState<HostComponentInfo[]>([]);

  useEffect(() => {
    const loader = getExtensionLoader();

    // Function to sync host components from loaded extensions
    function syncHostComponents() {
      const components = loader.getHostComponents();
      setHostComponents(components);
    }

    // Initial sync
    syncHostComponents();

    // Subscribe to extension changes
    const unsubscribe = loader.subscribe(syncHostComponents);

    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <>
      {hostComponents.map((info) => {
        const Component = info.component;
        return (
          <Component key={`${info.extensionId}-${info.componentName}`} />
        );
      })}
    </>
  );
}

export default ExtensionHostComponents;
