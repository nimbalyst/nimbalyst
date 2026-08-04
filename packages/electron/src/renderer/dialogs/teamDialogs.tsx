/**
 * Team Dialogs Registration
 *
 * Dialogs for team management. Organization creation has exactly one surface —
 * `OrgCreationWizard` — since the one-field `CreateTeamDialog` was folded into
 * it; every entry point opens `DIALOG_IDS.ORG_CREATION_WIZARD`.
 */

import React from 'react';
import { registerDialog } from '../contexts/DialogContext';
import type { DialogConfig } from '../contexts/DialogContext.types';
import { DIALOG_IDS } from './registry';
import { ShareToTeamDialog } from '../components/ShareToTeamDialog';
import { OrgCreationWizard } from '../components/TeamMode/onboarding/OrgCreationWizard';
import { OrgManagementDialog } from '../components/OrgManagement/OrgManagementDialog';
import type { AdminTab } from '../components/TeamMode/orgWindowState';
import type { CollaborativeDocumentTypeDescriptor } from '../services/CollaborativeDocumentTypeCatalog';
import type { EmbeddedDocumentCandidate } from '../services/embeddedDocumentShare';

// ============================================================================
// Types
// ============================================================================

export interface ShareToTeamData {
  fileName: string;
  sourceRelPath: string;
  descriptor: CollaborativeDocumentTypeDescriptor;
  embeddedDocuments?: EmbeddedDocumentCandidate[];
  onConfirm: (params: {
    folderId: string | null;
    folderPath: string;
    sharedName: string;
    selectedEmbeddedDocumentPaths: string[];
  }) => void;
}

// ============================================================================
// Registration
// ============================================================================

function ShareToTeamDialogWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: ShareToTeamData;
}) {
  return (
    <ShareToTeamDialog
      isOpen={isOpen}
      onClose={onClose}
      fileName={data.fileName}
      sourceRelPath={data.sourceRelPath}
      descriptor={data.descriptor}
      embeddedDocuments={data.embeddedDocuments}
      onConfirm={data.onConfirm}
    />
  );
}

/**
 * The organization creation wizard. Registered here so every window sharing
 * this registry — the project window, Account settings, the org window — opens
 * the same one.
 */
export interface OrgCreationWizardData {
  onOrganizationCreated?: (orgId: string) => void;
  /** Set by the Sharing entry point: the new org adopts this project. */
  workspacePath?: string;
  /** Pre-fills the name field, e.g. with the project's folder name. */
  suggestedName?: string;
  /** Which surface opened it; reported on the wizard's analytics events. */
  entryPoint?: 'organization_manager' | 'project_sharing';
}

function OrgCreationWizardWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data?: OrgCreationWizardData;
}) {
  return (
    <OrgCreationWizard
      isOpen={isOpen}
      onClose={onClose}
      workspacePath={data?.workspacePath}
      suggestedName={data?.suggestedName}
      entryPoint={data?.entryPoint}
      onOrganizationCreated={data?.onOrganizationCreated}
    />
  );
}

/**
 * Organization administration. Registered here for the same reason the wizard
 * is: both windows share this registry, so the project window and the
 * organization window open the same dialog rather than one of them starting a
 * new OS window to administer an org (NIM-2322).
 */
export interface OrgManagementDialogData {
  orgId: string;
  /** Which administration panel to land on; defaults to Members. */
  initialTab?: AdminTab;
}

function OrgManagementDialogWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: OrgManagementDialogData;
}) {
  return (
    <OrgManagementDialog
      isOpen={isOpen}
      onClose={onClose}
      orgId={data.orgId}
      initialTab={data.initialTab}
    />
  );
}

export function registerTeamDialogs() {
  registerDialog<OrgManagementDialogData>({
    id: DIALOG_IDS.ORG_MANAGEMENT,
    group: 'system',
    component: OrgManagementDialogWrapper as DialogConfig<OrgManagementDialogData>['component'],
    priority: 150,
  });

  registerDialog<OrgCreationWizardData>({
    id: DIALOG_IDS.ORG_CREATION_WIZARD,
    group: 'system',
    component: OrgCreationWizardWrapper as DialogConfig<OrgCreationWizardData>['component'],
    priority: 150,
  });

  registerDialog<ShareToTeamData>({
    id: DIALOG_IDS.SHARE_TO_TEAM,
    group: 'system',
    component: ShareToTeamDialogWrapper as DialogConfig<ShareToTeamData>['component'],
    priority: 200,
  });
}
