import { createStore } from 'jotai';
import { organizationDirectoryStateAtom, personalAccountsAtom } from '../../../store/atoms/settingsDomains';

/** Seed the central listener's state using each surface test's existing API fixtures. */
export async function createHydratedOrgStore() {
  const store = createStore();
  const directory = await window.electronAPI.organization.list();
  store.set(organizationDirectoryStateAtom, {
    entries: directory.teams, status: directory.success ? 'ready' : 'error', complete: directory.success,
    error: directory.success ? undefined : directory.error,
  });
  const accounts = await window.electronAPI.stytch?.getAccounts?.();
  store.set(personalAccountsAtom, accounts ?? []);
  return store;
}
