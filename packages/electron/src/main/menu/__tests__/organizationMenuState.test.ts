import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getHasOrganizationsForMenu,
  registerOrganizationMenuRebuild,
  setHasOrganizationsForMenu,
} from '../organizationMenuState';

describe('organizationMenuState', () => {
  beforeEach(() => {
    // Module state persists across tests; reset to the hidden default.
    registerOrganizationMenuRebuild(() => {});
    setHasOrganizationsForMenu(false);
  });

  it('defaults to hidden until an org membership is reported', () => {
    expect(getHasOrganizationsForMenu()).toBe(false);
  });

  it('rebuilds the menu when the membership state flips', () => {
    const rebuild = vi.fn();
    registerOrganizationMenuRebuild(rebuild);

    setHasOrganizationsForMenu(true);
    expect(getHasOrganizationsForMenu()).toBe(true);
    expect(rebuild).toHaveBeenCalledTimes(1);

    setHasOrganizationsForMenu(false);
    expect(getHasOrganizationsForMenu()).toBe(false);
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it('does not rebuild when the state is unchanged', () => {
    const rebuild = vi.fn();
    registerOrganizationMenuRebuild(rebuild);

    setHasOrganizationsForMenu(false);
    setHasOrganizationsForMenu(false);
    expect(rebuild).not.toHaveBeenCalled();
  });
});
