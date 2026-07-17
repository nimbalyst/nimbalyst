/**
 * Settings navigation destination-leak guard (settings review finding).
 *
 * Only the `openSettingsCommand` deep-link path carries a `destination`. Every
 * other (in-place) navigation must clear a stale destination, or an old one
 * overrides a newer scope/category and lands the user on the wrong scope --
 * e.g. open Settings via the org switcher (sets an org destination), then use
 * "Personal Settings" and still land on Organization.
 */
import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';

import {
  settingsNavigationAtom,
  settingsDestinationAtom,
  settingsInitialScopeAtom,
  settingsInitialCategoryAtom,
  settingsKeyAtom,
  setSettingsDestinationAtom,
  navigateSettingsInPlaceAtom,
} from '../settingsNavigation';

describe('navigateSettingsInPlaceAtom', () => {
  it('clears a stale deep-link destination while switching scope', () => {
    const store = createStore();
    // A prior org-switcher deep link left an Organization destination.
    store.set(setSettingsDestinationAtom, {
      scope: 'organization',
      category: 'organization-security',
      orgId: 'org-1',
    } as any);
    expect(store.get(settingsDestinationAtom)).toBeDefined();

    const keyBefore = store.get(settingsKeyAtom);
    // Now the user asks for Account settings in-place.
    store.set(navigateSettingsInPlaceAtom, { scope: 'account', category: 'account' });

    expect(store.get(settingsDestinationAtom)).toBeUndefined();
    expect(store.get(settingsInitialScopeAtom)).toBe('account');
    expect(store.get(settingsInitialCategoryAtom)).toBe('account');
    expect(store.get(settingsKeyAtom)).toBe(keyBefore + 1);
  });

  it('only overwrites the fields it is given', () => {
    const store = createStore();
    store.set(settingsNavigationAtom, {
      initialScope: 'project',
      initialCategory: 'project-trackers',
      destination: { scope: 'project', category: 'project-sharing' } as any,
      key: 5,
    });

    // Update only the category; scope is preserved, destination still cleared.
    store.set(navigateSettingsInPlaceAtom, { category: 'project-github' });

    expect(store.get(settingsInitialScopeAtom)).toBe('project');
    expect(store.get(settingsInitialCategoryAtom)).toBe('project-github');
    expect(store.get(settingsDestinationAtom)).toBeUndefined();
  });

  it('leaves the command-path destination setter intact', () => {
    const store = createStore();
    // The deep-link/command path must still be able to set a destination.
    store.set(setSettingsDestinationAtom, {
      scope: 'organization',
      category: 'organization-members',
      orgId: 'org-2',
    } as any);
    expect(store.get(settingsDestinationAtom)).toMatchObject({ orgId: 'org-2' });
  });
});
