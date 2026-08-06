export interface WorkspaceManagerWindowOptions {
  showOnboarding?: boolean;
}

export type WorkspaceManagerRendererQuery = Record<string, string>;

export function createWorkspaceManagerRendererQuery(
  theme: string,
  options: WorkspaceManagerWindowOptions = {},
): WorkspaceManagerRendererQuery {
  return {
    mode: 'workspace-manager',
    theme,
    ...(options.showOnboarding ? { onboarding: '1' } : {}),
  };
}

export function createWorkspaceManagerDevUrl(
  port: string,
  query: WorkspaceManagerRendererQuery,
): string {
  return `http://localhost:${port}/?${new URLSearchParams(query).toString()}`;
}
