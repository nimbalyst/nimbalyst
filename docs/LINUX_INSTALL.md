# Linux installation

Nimbalyst publishes two Linux builds on the [releases page](https://github.com/Nimbalyst/nimbalyst/releases/latest):

| Package | Use it when |
| --- | --- |
| `Nimbalyst-Linux.deb` | You are on Debian, Ubuntu, or a derivative. Recommended. |
| `Nimbalyst-Linux.AppImage` | You are on any other distribution. |

## Debian and Ubuntu (.deb)

```bash
sudo apt install ./Nimbalyst-Linux.deb
```

This installs to `/opt/Nimbalyst`, adds a `nimbalyst` command and a desktop entry, and configures the Chromium sandbox for you. Nothing else is required, including on Ubuntu 24.04 and later.

Auto-update works from the `.deb`: Nimbalyst downloads the new package and asks for the privileges needed to install it.

## Other distributions (AppImage)

```bash
chmod +x Nimbalyst-Linux.AppImage
./Nimbalyst-Linux.AppImage
```

### Ubuntu 24.04 and later: the AppImage needs an AppArmor profile

On Ubuntu 24.04 and later the AppImage exits immediately, with no window. Run from a terminal you will see:

```
FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc(166)] The SUID sandbox helper binary was
found, but is not configured correctly.
```

These releases set `kernel.apparmor_restrict_unprivileged_userns=1`, which stops unconfined programs from creating the user namespace Chromium's sandbox needs. Chromium's fallback is a setuid helper, and that cannot work either: an AppImage runs from a FUSE mount, which is mounted `nosuid`. With both options closed, Chromium stops rather than run without a sandbox.

**The simplest fix is to install the `.deb` instead** — it is unaffected.

To stay on the AppImage, grant it the one permission it needs. Create `/etc/apparmor.d/nimbalyst-appimage`, replacing the path with wherever you keep the AppImage:

```
abi <abi/4.0>,
include <tunables/global>

profile nimbalyst-appimage /home/YOUR_USER/Applications/Nimbalyst-Linux.AppImage flags=(unconfined) {
  userns,

  include if exists <local/nimbalyst-appimage>
}
```

Load it:

```bash
sudo apparmor_parser -r /etc/apparmor.d/nimbalyst-appimage
```

The AppImage now starts, with the Chromium sandbox still on. The profile is scoped to that one path, so the rest of the system hardening is untouched. If you move or rename the AppImage, update the path in the profile and reload it.

Keep the `nimbalyst-appimage` name. The `.deb` installs its own profile at `/etc/apparmor.d/nimbalyst`: installing the package overwrites that file, removing it deletes the file, and loading a profile replaces any loaded profile with the same name. With a name of its own, the AppImage profile survives the `.deb` on the same machine.

If you followed an earlier version of this page, check `/etc/apparmor.d/nimbalyst`. If it names your AppImage path, it is the old profile: unload and delete it. If it names `/opt/Nimbalyst/nimbalyst`, it belongs to the `.deb`, so leave it alone.

```bash
sudo apparmor_parser -R /etc/apparmor.d/nimbalyst
sudo rm /etc/apparmor.d/nimbalyst
```

Do not use `--no-sandbox` to work around this. It starts the app by turning off the renderer sandbox, which is the protection the error is about.

Reported in [#1430](https://github.com/nimbalyst/nimbalyst/issues/1430).
