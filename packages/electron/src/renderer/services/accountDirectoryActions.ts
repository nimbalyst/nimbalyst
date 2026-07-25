import { refreshPersonalAccountsDirectory } from '../store/listeners/stytchAuthListeners';

export async function setSyncAccountAndRefresh(personalOrgId: string) {
  const result = await window.electronAPI.stytch.setSyncAccount(personalOrgId);
  if (result.success) await refreshPersonalAccountsDirectory();
  return result;
}

export async function removeAccountAndRefresh(personalOrgId: string, purgeOfflineWork = false) {
  const result = await window.electronAPI.stytch.removeAccount(personalOrgId, purgeOfflineWork);
  if (result.success) await refreshPersonalAccountsDirectory();
  return result;
}
