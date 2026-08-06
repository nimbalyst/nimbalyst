import { dialogRef } from '../../contexts/DialogContext';
import { DIALOG_IDS } from '../../dialogs/registry';

/**
 * Route the profile popover's organization row to the right surface.
 *
 * An existing organization is administered in whichever window you are already
 * in (NIM-2322, superseding the 2026-07-17 "administration is its own OS
 * window" correction) — the organization window is now messaging only. Creating
 * one goes through the wizard dialog (NIM-2311); there is no organization to
 * administer until it exists (NIM-2320).
 */
export function openOrganizationSurface(orgId: string | undefined, workspacePath: string | null | undefined): void {
  if (!orgId) {
    dialogRef.current?.open(DIALOG_IDS.ORG_CREATION_WIZARD, {
      workspacePath: workspacePath ?? undefined,
    });
    return;
  }
  dialogRef.current?.open(DIALOG_IDS.ORG_MANAGEMENT, { orgId });
}
