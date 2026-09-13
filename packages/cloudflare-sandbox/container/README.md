# Nimbalyst sandbox container image

A `linux/amd64` image that adds the headless Nimbalyst runner (`@nimbalyst/node`) to the official Cloudflare Sandbox base image, with the control service and agent runner both running as uid 10001.

## What is in it

| Path | Contents |
| --- | --- |
| `/opt/nimbalyst/node` | Node 24, installed from a checksum-verified official tarball. Deliberately off the default `PATH`. |
| `/opt/nimbalyst/app` | The built workspace subset: `@nimbalyst/node` (`dist/`), `@nimbalyst/runtime` (`dist-node/`, the `node` export condition only), `@nimbalyst/extension-sdk`, `@nimbalyst/tracker-core`, and the hoisted `node_modules` including the native `better-sqlite3` binding and the linux-x64 Claude Code binary. |
| `/opt/nimbalyst/app/packages/electron/src/main/database/sqlite/schemas` | The SQL migrations, unmodified. This is exactly where `packages/node`'s `resolveSchemaDir()` looks by default, so no `schemaDir` is needed in the config. |
| `/usr/local/bin/nimbalyst-node` | Launcher. Uses our Node with a clean environment; also drops privileges if an administrator invokes it as root — uid, gid, `no_new_privs`, and the capability bounding set, so nothing reached later can hand root back. |
| `/var/lib/nimbalyst`, `/workspace` | Writable, owned by `nimbalyst`. |

The preview base image's `ENTRYPOINT` (`/usr/bin/tini -- /container-server/sandbox`) and its own `node` remain in place. `USER 10001:10001` applies to tini, the control service and all of its children. The control API is reachable inside the container, so dropping privileges only in the runner would leave a root execution path. The application code stays root-owned; `/home/nimbalyst`, `/workspace`, `/var/lib/nimbalyst`, and temporary storage are writable.

The whole container is one execution trust domain. Keep privileged credentials and unrelated tenants outside it. The current Worker has no public control route and disables general internet access, with an explicit host allowlist. Its private RPCs provision files and manage the headless node process. Root-only mounts are unsupported. HTTPS interception is explicitly enabled for the preview SDK. The system CA bundle remains root-owned but grants the runtime group write access so Cloudflare can append its injected certificate during startup; the surrounding directory stays root-owned and unwritable. The launcher adds Cloudflare's fixed runtime CA to Node's trust and creates a temporary combined CA bundle for Git, curl, and Claude's child process. It does not inherit caller-supplied certificate paths or TLS verification overrides.

**No credentials are baked in.** The launcher clears inherited environment variables. API keys and MCP connections must be provisioned explicitly in the runner config; implicit repository/user MCP configuration and executable settings are disabled. CLI OAuth login can use the container user's credential store if one is explicitly provisioned.

## Build

The build context is a staged directory, never the checkout — this working tree holds private notes, `.env` files and host-platform `node_modules`, and an image layer cannot be un-shipped.

```sh
node packages/cloudflare-sandbox/container/stage-build-context.mjs

docker buildx build --platform linux/amd64 \
  -f packages/cloudflare-sandbox/container/Dockerfile \
  -t nimbalyst/sandbox-node:0.13.0-next.751.1 \
  packages/cloudflare-sandbox/container/.build-context
```

`stage-build-context.mjs` copies only the paths in `buildContextAllowlist.mjs` (currently ~1,150 files / ~10 MB) and refuses to stage anything credential-shaped, anything reached through a symlink, or anything git does not track. **Tracked means present in git's index**, not merely "not ignored": the file that ships a pasted key is usually an ordinary scratch file nobody has added yet, and it is not gitignored either. A tracked file is one that has appeared in a diff. Working-tree bytes are what get staged — tracking is the admission check, not the source of the content.

Because the gate reads the index, a build run before the files are committed needs them added. To do that without touching the shared index, point git at a throwaway one:

```sh
export GIT_INDEX_FILE=/tmp/sandbox-build.index
git read-tree HEAD && git add packages/cloudflare-sandbox
node packages/cloudflare-sandbox/container/stage-build-context.mjs
```

It writes `.build-context-manifest.json` **beside** the staged directory, listing every file with its hash plus a content digest for the tree. Beside, not inside: `COPY . /build` takes the whole context, so anything left in there ships, and the manifest is a record for a reviewer rather than an input to the build. For the same reason the builder stage deletes `bin/` and the staging marker before the image is assembled.

The build ends with `RUN nimbalyst-node --smoke`, which fails the build unless the Node major, the runtime's deep `node`-condition exports, the native SQLite binding, the linux-x64 Claude Code binary and the real migrations all work — as the unprivileged user. An image that builds has been checked, not just assembled.

## Versions

All pins live in `image.config.json`; `checks/image-pins.test.mjs` fails if the Dockerfile or Worker SDK version drifts from it.

`sandbox.sdkVersion` **must equal the `@cloudflare/sandbox` version the Worker package depends on.** The SDK and the container server inside the base image speak a versioned protocol. Current pin: **0.13.0-next.751.1**, with the linux/amd64 base manifest digest recorded in `image.config.json`. Stable and preview control protocols are incompatible; deployment uses immediate container rollout.

To move the pin: change `image.config.json` and the matching `ARG` defaults in the `Dockerfile`, bump the Worker's `@cloudflare/sandbox` dependency in the same change, and re-run the build.

## Distributing without a local build

End users should not need Docker. A Worker can reference an already-published image, so the build here is a maintainer step and not a setup dependency.

Reference it **by immutable digest**, not by tag. The installed Wrangler parses `NAME:TAG@DIGEST` and `NAME@DIGEST`, builds `repository@digest` references, and passes a non-Cloudflare hostname through unchanged — so a `registry/repo@sha256:…` reference is expressible. A tag is mutable and would let the image under a deployed Worker change without the config changing.

Wrangler 4.125.0 accepts the preview digest configuration with `--containers-rollout immediate` in a local dry run. Remote image acceptance and live operation still require a Cloudflare deployment.

## Running the runner

```sh
nimbalyst-node --config /var/lib/nimbalyst/nimbalyst-node.config.json \
               --workspace /workspace/repo \
               --prompt "list the files in this directory"
```

Write the config into the sandbox at run time, e.g.:

```json
{
  "databasePath": "/var/lib/nimbalyst/nimbalyst.sqlite",
  "trust": { "mode": "bypass-all" }
}
```

`databasePath` and `--workspace` must both point somewhere the `nimbalyst` user can write; `/var/lib/nimbalyst` and `/workspace` already are.

## Security validation

The preview runtime smoke uses WebSocket RPC at `/rpc`, activates a control session, starts the runner with an argv command and waits for its exit. It checks both tini and the control server run as uid 10001, then checks launcher hardening and the absence of setuid/setgid files. The probe bundles successfully in local tests; the preview Docker build and runtime smoke must still be run. The measurements below describe the earlier stable image and do not validate the preview image.

Built locally on 2026-09-09, most recently as `nimbalyst/sandbox-node:0.12.9-hardened2`, image `sha256:239f084128c57f9349ebd2d61d13ffa85afd02aa167713198d213cd44e8b5b24` (`linux/amd64`, emulated on an arm64 daemon, Docker 29.4.1). No image was published or deployed to Cloudflare.

`checks/runtime-smoke.mjs` failed against the root-control-service image because its control service ran as uid 0. It passes against this one: the inherited entrypoint starts as uid 10001 with network disabled. All nine runner smoke checks pass, including a synthetic environment marker being cleared by the launcher. The fixed readiness command also succeeds through the Sandbox API after creating a shell session, covering the server-to-runner path. The fixture container is removed unconditionally.

The harness deliberately does **not** pass `--cap-drop=ALL` or `--security-opt=no-new-privileges`. Cloudflare does not apply those to our container, so setting them measures the harness rather than the image — and they did hide a real defect: the launcher applied `setpriv` only on its root branch, which `USER 10001` means the image never takes, so the runner ran with `NoNewPrivs: 0` and 13 setuid binaries available. `--network=none` stays, because the image genuinely relies on it.

```sh
node packages/cloudflare-sandbox/container/checks/runtime-smoke.mjs nimbalyst/sandbox-node:0.12.9-hardened2
```

Two further properties were checked by reading the built filesystem, because both are things a passing smoke check would not notice:

- **Nothing identifies the machine that built it.** `grep -rIl` across the whole image for the maintainer's username and for the checkout path returns nothing. On the preceding image it returned one file — the staged build-context manifest, which recorded an absolute home directory and travelled into `/opt/nimbalyst/app` via `COPY . /build`. The manifest, the staging marker and the duplicate `bin/` are all absent now.
- **The runner cannot gain privilege.** Its own process reports `NoNewPrivs: 1` (measured from `/proc/self/status` by the runner itself, not by the shell that started it); the same `node` invoked directly, bypassing the launcher, reports `0`, which is the control showing the launcher is what sets it. Invoked as root the launcher additionally empties the bounding set, `CapBnd: 00000000a80425fb` to `0`. At uid 10001 the bounding set cannot be emptied — that needs CAP_SETPCAP — so the image instead removes what it would protect against: **zero setuid/setgid files**, down from the 13 Ubuntu ships (`su`, `mount`, `umount`, `passwd`, `chsh`, `newgrp`, `fusermount3`, …). Stripped as root at build time and re-verified in the same layer.

Not covered: PID 1, the base image's own entrypoint, runs with `NoNewPrivs: 0`. Setting it would mean overriding the inherited `ENTRYPOINT`, which is the SDK's contract and deliberately left alone. With no setuid binary on the filesystem there is nothing for it to escalate through.

This validates local Linux startup and the packaged runtime, not a Cloudflare deployment or authenticated agent turn. The runtime smoke check uses Docker only for the Linux image; it does not run desktop E2E tests.

## Previous image verification

The following measurements describe the earlier root-control-service image, before the security changes. They do not validate the current rootless image.

Built and exercised on 2026-09-09 (`linux/amd64`, emulated on an arm64 daemon, Docker 29.4.1):

- Image `sha256:6c6df879da4fae651d131d6c428f6fdff91ca9cc8a4fbe4594820e999c7fbc62`, 2.21 GB, `linux/amd64`.
- All seven smoke checks pass against the **final image** with `--network none`, exit 0: Node v24.21.0, uid 10001, the runtime's deep `node`-condition exports, better-sqlite3 on SQLite 3.53.3, the linux-x64 Claude Code binary, 42 migrations applied to a real database, and `nimbalyst-node --help`.
- The base entrypoint still works: the container starts as root, `/container-server/sandbox` comes up on port 3000, and `docker exec … nimbalyst-node --smoke` passes inside the running container.
- `Entrypoint: ["/container-server/sandbox"]`, no `Cmd`, no `User` — the base image's contract is intact.
- The base image's own Node (v22.23.2) is untouched on `PATH`; ours is v24.21.0 under `/opt/nimbalyst/node`. This is why the runner does not use the image's node: it is a major version below what this repository requires.

## Known gaps

- **Image size is untuned: 2.21 GB.** The install is lockfile-faithful rather than hand-trimmed, so the runtime's full production dependency set (Monaco, Mermaid, Lexical, …) ships even though the headless closure imports none of it. Trimming belongs behind the smoke check, not a guess about what is unused.
- **Only the amd64 build has been exercised**, under emulation. A native amd64 builder will be faster but has not been tried.
- `PRUNE_DEV=0` disables the dev-dependency prune if it ever removes something the runner needs; the smoke check is what catches that.

### Why the build needs the root devDependencies

`npm ci` here uses `--include-workspace-root` even though the image ships none of that toolchain. Narrowing the _install_ to the four workspaces fails twice, and both failures were found by real builds rather than reasoning:

- npm still runs the root `postinstall` (`patch-package`), a root devDependency the narrow selection never installs — `sh: 1: patch-package: not found`.
- `extension-sdk/src/testing.ts` imports `@playwright/test` and `playwright`, so `tsc` fails with seven errors.

`npm prune --omit=dev` is what keeps them out of the shipped layer. Both `npm ci` and `npm prune` pass `--ignore-scripts`: prune re-runs workspace `prepare` scripts, and `@nimbalyst/tracker-core`'s prepare is `tsc -p tsconfig.json`, which dies on `tsc: not found` immediately after the prune removes typescript.
