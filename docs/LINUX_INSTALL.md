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

To stay on the AppImage, grant it the one permission it needs. Create `/etc/apparmor.d/nimbalyst`, replacing the path with wherever you keep the AppImage:

```
abi <abi/4.0>,
include <tunables/global>

profile nimbalyst /home/YOUR_USER/Applications/Nimbalyst-Linux.AppImage flags=(unconfined) {
  userns,

  include if exists <local/nimbalyst>
}
```

Load it:

```bash
sudo apparmor_parser -r /etc/apparmor.d/nimbalyst
```

The AppImage now starts, with the Chromium sandbox still on. The profile is scoped to that one path, so the rest of the system hardening is untouched. If you move or rename the AppImage, update the path in the profile and reload it.

Do not use `--no-sandbox` to work around this. It starts the app by turning off the renderer sandbox, which is the protection the error is about.

Reported in [#1430](https://github.com/nimbalyst/nimbalyst/issues/1430).
