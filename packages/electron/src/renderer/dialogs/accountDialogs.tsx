import React from 'react';

import { AccountLoginForm, type AccountLoginMode } from '../components/Accounts/AccountLoginForm';
import type { PersonalAccountSummary } from '../store/atoms/settingsDomains';
import { registerDialog } from '../contexts/DialogContext';
import type { DialogConfig } from '../contexts/DialogContext.types';
import { DIALOG_IDS } from './registry';

export interface AccountLoginData {
  mode: AccountLoginMode;
  account?: PersonalAccountSummary;
}

function AccountLoginDialog({ isOpen, onClose, data }: { isOpen: boolean; onClose: () => void; data: AccountLoginData }) {
  if (!isOpen) return null;
  return (
    <div className="account-login-dialog fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4" data-component="AccountLoginDialog" data-testid="account-login-dialog" onClick={onClose}>
      <div className="relative w-[390px] max-w-[90vw]" onClick={(event) => event.stopPropagation()}>
        <button type="button" aria-label="Close sign-in" className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)]" onClick={onClose}>×</button>
        <AccountLoginForm mode={data.mode} account={data.account} />
      </div>
    </div>
  );
}

export function registerAccountDialogs() {
  registerDialog<AccountLoginData>({
    id: DIALOG_IDS.ACCOUNT_LOGIN,
    group: 'system',
    component: AccountLoginDialog as DialogConfig<AccountLoginData>['component'],
    priority: 275,
  });
}
