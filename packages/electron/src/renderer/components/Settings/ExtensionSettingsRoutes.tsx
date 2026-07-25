import React, { useEffect, useMemo, useState } from 'react';
import {
  createExtensionStorage,
  getExtensionLoader,
  type LoadedExtensionSettingsRoute,
  type SettingsRouteProjectTarget,
} from '@nimbalyst/runtime';
import { useTheme } from '../../hooks/useTheme';
import type { ExtensionSettingsRoute } from './settingsRoutes';

/** Subscribe to install, enable, disable, unload, and hot-reload changes. */
export function useExtensionSettingsRoutes(): LoadedExtensionSettingsRoute[] {
  const loader = getExtensionLoader();
  const [routes, setRoutes] = useState<LoadedExtensionSettingsRoute[]>(() => loader.getSettingsRoutes());

  useEffect(() => {
    const refresh = () => setRoutes(loader.getSettingsRoutes());
    refresh();
    return loader.subscribe(refresh);
  }, [loader]);

  return routes;
}

/** Strip resolved components before merging routes into the pure registry. */
export function toSettingsRoute(route: LoadedExtensionSettingsRoute): ExtensionSettingsRoute {
  return {
    source: 'extension',
    id: route.id,
    extensionId: route.extensionId,
    scope: route.scope,
    group: route.group,
    label: route.label,
    icon: route.icon,
    componentName: route.componentName,
    order: route.order,
  };
}

interface ExtensionSettingsRoutePanelProps {
  route: LoadedExtensionSettingsRoute;
  workspacePath?: string;
  projectTarget?: SettingsRouteProjectTarget;
}

/** Render a resolved extension route with host-owned services and project context. */
export const ExtensionSettingsRoutePanel: React.FC<ExtensionSettingsRoutePanelProps> = ({
  route,
  workspacePath,
  projectTarget,
}) => {
  const { theme } = useTheme();
  const storage = useMemo(() => createExtensionStorage(route.extensionId), [route.extensionId]);
  const callBackendTool = useMemo(
    () => (toolName: string, args?: Record<string, unknown>) => {
      if (route.scope === 'project' && !workspacePath) {
        return Promise.reject(
          new Error('Backend tools require a local workspace for this project settings route'),
        );
      }
      return window.electronAPI.invoke('extensions:ai-call-backend-tool', {
        toolName,
        args: args ?? {},
        workspacePath,
        callerExtensionId: route.extensionId,
      });
    },
    [route.extensionId, route.scope, workspacePath],
  );
  const Component = route.component;
  const projectProps = route.scope === 'project' ? { workspacePath, projectTarget } : {};

  return (
    <div
      className="settings-extension-route-panel"
      data-testid={`extension-settings-route-${route.id}`}
      data-extension-id={route.extensionId}
    >
      <Component storage={storage} theme={theme} callBackendTool={callBackendTool} {...projectProps} />
    </div>
  );
};
