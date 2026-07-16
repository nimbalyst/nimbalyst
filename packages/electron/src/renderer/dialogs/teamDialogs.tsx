/**
 * Team Dialogs Registration
 *
 * Dialogs for team management (create team, etc.).
 */

import React, { useState } from 'react';
import { registerDialog } from '../contexts/DialogContext';
import type { DialogConfig } from '../contexts/DialogContext.types';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { DIALOG_IDS } from './registry';
import { ShareToTeamDialog } from '../components/ShareToTeamDialog';
import type { CollaborativeDocumentTypeDescriptor } from '../services/CollaborativeDocumentTypeCatalog';

// ============================================================================
// Types
// ============================================================================

export interface AccountInfo {
  personalOrgId: string;
  email: string | null;
  isPrimary: boolean;
}

export interface CreateTeamData {
  gitRemote: string;
  suggestedName: string;
  accounts: AccountInfo[];
  onCreateTeam: (name: string, accountOrgId?: string) => void;
}

export interface ShareToTeamData {
  fileName: string;
  sourceRelPath: string;
  descriptor: CollaborativeDocumentTypeDescriptor;
  onConfirm: (params: { folderId: string | null; folderPath: string; sharedName: string }) => void;
}

// ============================================================================
// Create Team Dialog
// ============================================================================

function CreateTeamDialogWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: CreateTeamData;
}) {
  const [teamName, setTeamName] = useState(data.suggestedName);
  const primaryAccount = data.accounts.find((a) => a.isPrimary);
  const [selectedAccountOrgId, setSelectedAccountOrgId] = useState(
    primaryAccount?.personalOrgId ?? data.accounts[0]?.personalOrgId ?? ''
  );

  if (!isOpen) return null;

  const handleCreate = () => {
    if (teamName.trim()) {
      data.onCreateTeam(teamName.trim(), selectedAccountOrgId || undefined);
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCreate();
    }
    if (e.key === 'Escape') {
      onClose();
    }
  };

  const showAccountPicker = data.accounts.length > 1;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[400px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-0">
          <h3 className="text-lg font-semibold text-[var(--nim-text)] mb-1">Create Team</h3>
          <p className="text-[13px] text-[var(--nim-text-faint)] mb-5">
            Team members can collaborate on shared tracker items and documents.
          </p>
        </div>

        {/* Body */}
        <div className="px-6">
          {/* Account Picker (only shown with multiple accounts) */}
          {showAccountPicker && (
            <div className="mb-4">
              <label className="block text-[12px] font-medium text-[var(--nim-text-muted)] mb-1.5">
                Account
              </label>
              <select
                value={selectedAccountOrgId}
                onChange={(e) => setSelectedAccountOrgId(e.target.value)}
                className="w-full px-3 py-2 border border-[var(--nim-border)] rounded-md bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] text-[13px] outline-none focus:border-[var(--nim-primary)] cursor-pointer"
              >
                {data.accounts.map((account) => (
                  <option key={account.personalOrgId} value={account.personalOrgId}>
                    {account.email || account.personalOrgId}
                  </option>
                ))}
              </select>
              <div className="text-[11px] text-[var(--nim-text-disabled)] mt-1">
                The team will be created under this account.
              </div>
            </div>
          )}

          {/* Team Name */}
          <div className="mb-4">
            <label className="block text-[12px] font-medium text-[var(--nim-text-muted)] mb-1.5">
              Team Name
            </label>
            <input
              type="text"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full px-3 py-2 border border-[var(--nim-border)] rounded-md bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] text-[13px] outline-none focus:border-[var(--nim-primary)]"
              autoFocus
            />
            <div className="text-[11px] text-[var(--nim-text-disabled)] mt-1">
              Visible to all team members.
            </div>
          </div>

          {/* Git Remote */}
          <div className="mb-4">
            <label className="block text-[12px] font-medium text-[var(--nim-text-muted)] mb-1.5">
              Git Remote
            </label>
            <div className="w-full px-3 py-2 border border-[var(--nim-bg-tertiary)] rounded-md bg-[var(--nim-bg-secondary)] text-[var(--nim-text-faint)] text-[12px] font-mono">
              {data.gitRemote}
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <div className="w-1.5 h-1.5 rounded-full bg-[var(--nim-success)]" />
              <span className="text-[11px] text-[var(--nim-success)]">
                Detected from git remote origin
              </span>
            </div>
            <div className="text-[11px] text-[var(--nim-text-disabled)] mt-1.5">
              Any team member who opens a clone of this repo will be automatically connected.
            </div>
          </div>

          {/* Encryption Info */}
          <div className="mb-0">
            <label className="block text-[12px] font-medium text-[var(--nim-text-muted)] mb-1.5">
              Encryption
            </label>
            <div className="flex items-start gap-2 p-3 bg-[var(--nim-bg-secondary)] rounded-md border border-[var(--nim-bg-tertiary)]">
              <MaterialSymbol icon="lock" size={16} className="text-[var(--nim-success)] shrink-0 mt-0.5" />
              <div>
                <div className="text-[12px] font-medium text-[var(--nim-text)] mb-0.5">E2E Encrypted</div>
                <div className="text-[11px] text-[var(--nim-text-faint)] leading-snug">
                  A unique encryption key will be generated for this team. Keys are shared securely via ECDH exchange when members join.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-5 border-t border-[var(--nim-border)] mt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-transparent border border-[var(--nim-border)] rounded-md text-[var(--nim-text-muted)] text-[13px] cursor-pointer hover:bg-[var(--nim-bg-hover)]"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!teamName.trim()}
            className={`px-5 py-2 bg-[var(--nim-primary)] border-none rounded-md text-white text-[13px] font-medium ${
              teamName.trim()
                ? 'cursor-pointer opacity-100'
                : 'cursor-not-allowed opacity-50'
            }`}
          >
            Create Team
          </button>
        </div>
      </div>
    </div>
  );
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
      onConfirm={data.onConfirm}
    />
  );
}

export function registerTeamDialogs() {
  registerDialog<CreateTeamData>({
    id: DIALOG_IDS.CREATE_TEAM,
    group: 'system',
    component: CreateTeamDialogWrapper as DialogConfig<CreateTeamData>['component'],
    priority: 100,
  });

  registerDialog<ShareToTeamData>({
    id: DIALOG_IDS.SHARE_TO_TEAM,
    group: 'system',
    component: ShareToTeamDialogWrapper as DialogConfig<ShareToTeamData>['component'],
    priority: 200,
  });
}
