// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const packageJson = require_("../../package.json");

// Electron sets the Wayland app_id (and WM_CLASS) from desktopName in this
// package.json, falling back to a slug of app.name when the key is absent.
// See lib/browser/desktop-name.ts and native_window_views.cc in electron.
// Our scoped name slugs to "nimbalyst-electron", which never matches the
// nimbalyst.desktop that electron-builder writes from linux.executableName,
// so GNOME could not link the running window to its entry and showed a
// generic icon (#697). Adding productName here would fix the slug too, but it
// would also move userData from ~/.config/@nimbalyst/electron and orphan every
// existing install, so the identity is pinned with desktopName instead.
const defaultDesktopSlug = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

describe("Linux desktop identity", () => {
  it("names the desktop entry Electron will report as the app_id", () => {
    expect(packageJson.desktopName).toBe(
      `${packageJson.build.linux.executableName}.desktop`
    );
  });

  it("does not rely on the slug Electron would derive from the package name", () => {
    expect(defaultDesktopSlug(packageJson.name)).not.toBe(
      packageJson.build.linux.executableName
    );
  });
});
