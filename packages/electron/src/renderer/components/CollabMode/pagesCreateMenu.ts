/**
 * The title bar's "+" menu for Pages mode, composed from the Team and Personal
 * sidebar sections. The title bar holds one menu per mode, so the Personal
 * section's entries join the team menu rather than publishing their own.
 */

import type { CollabSidebarCreateMenu } from '@nimbalyst/collab-client/docs-ui';
import type { TitleBarCreateMenu } from '../../store/atoms/titleBarCreate';

export function composePagesCreateMenu(
  team: CollabSidebarCreateMenu | null,
  personal: CollabSidebarCreateMenu | null,
  /** Copy a file from disk in; the dialog it opens offers both sections. */
  onAddFromFiles?: (section: 'team' | 'personal') => void,
): TitleBarCreateMenu | null {
  const primary = team ?? personal;
  if (!primary) return null;
  const addFromFiles = onAddFromFiles
    ? [{ id: 'add-from-files', label: 'Add from Files...', icon: 'upload_file', separatorBefore: true, onSelect: () => onAddFromFiles(team ? 'team' : 'personal') }]
    : [];
  const folderItem = (menu: CollabSidebarCreateMenu, id: string, label: string) => ({
    id,
    label,
    icon: 'create_new_folder',
    separatorBefore: true,
    onSelect: menu.onNewFolder,
  });

  // A page tree has no folders: a folder is a page with an empty body.
  const folderItems = (menu: CollabSidebarCreateMenu, id: string, label: string) =>
    (menu.pageTree ? [] : [folderItem(menu, id, label)]);

  if (!team) {
    return {
      mode: 'collab',
      destination: primary.destination,
      heading: { label: 'Personal', icon: 'person' },
      onPrimary: primary.onPrimary,
      primaryTrailing: primary.primaryTrailing,
      items: [...primary.items, ...folderItems(primary, 'folder', 'New folder'), ...addFromFiles],
    };
  }

  return {
    mode: 'collab',
    destination: team.destination,
    heading: { label: 'Shared with team', icon: 'groups' },
    onPrimary: team.onPrimary,
    primaryTrailing: team.primaryTrailing,
    items: [
      ...team.items,
      ...folderItems(team, 'folder', 'New folder'),
      ...(personal
        ? [
          {
            id: 'personal-page',
            label: 'New personal page',
            icon: 'person',
            separatorBefore: true,
            trailing: personal.primaryTrailing,
            onSelect: personal.onPrimary,
          },
          ...folderItems(personal, 'personal-folder', 'New personal folder')
            .map((item) => ({ ...item, separatorBefore: false })),
        ]
        : []),
      ...addFromFiles,
    ],
  };
}
