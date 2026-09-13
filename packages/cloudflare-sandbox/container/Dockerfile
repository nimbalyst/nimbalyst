# syntax=docker/dockerfile:1.7
#
# Nimbalyst headless runner on the Cloudflare Sandbox base image.
#
# Build context is NOT the checkout. Produce it first:
#
#   node packages/cloudflare-sandbox/container/stage-build-context.mjs
#   docker buildx build --platform linux/amd64 \
#     -f packages/cloudflare-sandbox/container/Dockerfile \
#     -t nimbalyst/sandbox-node:<sandbox-version> \
#     packages/cloudflare-sandbox/container/.build-context
#
# Three things this file is careful about:
#
#  1. The base image's ENTRYPOINT (`/container-server/sandbox`) is the contract
#     the @cloudflare/sandbox SDK talks to. It is never overridden here, and no
#     CMD is set either. The control server and runner both run without root.
#  2. The base image ships its own `node` at /usr/local/bin, used by the sandbox
#     server's JS executors. Ours is installed under /opt/nimbalyst/node and
#     stays off the default PATH, so upgrading the runner's Node cannot change
#     what the control plane runs.
#  3. Nothing here bakes in a credential. The runner reads a config file passed
#     at run time (see packages/node/README.md); it reads nothing from the
#     environment by design.
#
# Every version below is pinned in image.config.json; the two must agree, which
# __tests__/imageContract.test.ts checks.

ARG SANDBOX_VERSION=0.13.0-next.751.1
# Pinned by digest, not by tag. A tag is mutable: `cloudflare/sandbox:next`
# can be repushed, and the image under a deployed Worker would then change with
# nothing in this repository changing. The digest is recorded in
# image.config.json and was read from the registry API, not from a local pull.
ARG SANDBOX_BASE_IMAGE=docker.io/cloudflare/sandbox:0.13.0-next.751.1@sha256:712d12b2bd6f91ae66d83cebd9f7a0bfa684ae3e3100299c315d20d2ce38b8b1
ARG BUILD_BASE=ubuntu:22.04
ARG NODE_VERSION=24.21.0
ARG NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
ARG APP_UID=10001
ARG PRUNE_DEV=1


# --- Node 24, verified by checksum -------------------------------------------
# The sandbox base is Ubuntu 22.04 (glibc 2.35) and the official linux-x64 build
# needs only glibc >= 2.28, so the same tarball serves the builder and the final
# image. Building against a different libc than we run on is the classic way to
# get a native module that loads on the build host and nowhere else.
FROM ${BUILD_BASE} AS node-dist
ARG NODE_VERSION
ARG NODE_SHA256
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/nimbalyst/node; \
    tar -xJf /tmp/node.tar.xz -C /opt/nimbalyst/node --strip-components=1; \
    rm -f /tmp/node.tar.xz; \
    /opt/nimbalyst/node/bin/node --version


# --- Build the workspace subset ----------------------------------------------
FROM ${BUILD_BASE} AS builder
ARG PRUNE_DEV
ENV DEBIAN_FRONTEND=noninteractive
# better-sqlite3 ships Node-API prebuilds; these are the fallback toolchain for
# the case where no prebuild matches, so a miss is a slow build and not a
# failed one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 g++ make \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node-dist /opt/nimbalyst/node /opt/nimbalyst/node
ENV PATH=/opt/nimbalyst/node/bin:${PATH}
# Root devDependencies include Playwright and electron-builder, neither of which
# this image installs -- but the belt-and-braces guard costs nothing.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false

WORKDIR /build
# The context is the staged tree, whose contents are the allowlist in
# buildContextAllowlist.mjs and nothing else.
COPY . /build

# This install reproduces the root install packages/node/README.md documents,
# narrowed to the four workspaces the runner needs. Two flags carry the history:
#
# --include-workspace-root, because the workspace builds genuinely need root
# devDependencies. Excluding it looks like the tidier choice and fails twice:
# npm still runs the root `postinstall` (`patch-package`, a root devDependency
# -- `sh: 1: patch-package: not found`), and `extension-sdk/src/testing.ts`
# imports `@playwright/test` and `playwright`, so `tsc` fails on 7 errors. The
# dev-prune step below is what keeps those out of the shipped layer, rather than
# an install narrow enough to break the build.
#
# --ignore-scripts, because none of this dependency set needs an install script
# and skipping them keeps the install deterministic. Each reason was checked,
# not assumed:
#   - better-sqlite3 13 has no install script at all; its Node-API binding ships
#     inside the package tarball (prebuilds/linux-x64.node).
#   - the Claude Code binary is a plain optionalDependency package, no scripts.
#   - the two @lexical/* patches patch-package would apply are editor-tree
#     packages the headless closure never imports.
#   - the workspace `prepare` builds run explicitly in the next step.
# The smoke check at the end of this build is what proves the result works.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --include-workspace-root \
      --workspace=@nimbalyst/node \
      --workspace=@nimbalyst/runtime \
      --workspace=@nimbalyst/extension-sdk \
      --workspace=@nimbalyst/tracker-core

# Same order as packages/node/README.md: workspace deps, then the runtime's
# `node` export condition (dist-node/), then the runner itself.
RUN npm run build:workspace-deps \
 && npm run build:node --workspace=@nimbalyst/runtime \
 && npm run build --workspace=@nimbalyst/node

# Drop build-only dependencies. If this ever removes something the runner needs,
# the smoke check in the final stage fails the build; set PRUNE_DEV=0 to bisect.
#
# --ignore-scripts here for a specific reason: `npm prune` re-runs workspace
# `prepare` scripts, and @nimbalyst/tracker-core's prepare is `tsc -p
# tsconfig.json`. Pruning removes typescript first, so the rebuild it triggers
# dies on `sh: 1: tsc: not found` -- pruning a dev dependency and then demanding
# it back. The dist/ output built in the previous step is what ships; nothing
# needs rebuilding here.
RUN set -eux; \
    if [ "${PRUNE_DEV}" = "1" ]; then \
      npm prune --omit=dev --ignore-scripts --include-workspace-root \
        --workspace=@nimbalyst/node \
        --workspace=@nimbalyst/runtime \
        --workspace=@nimbalyst/extension-sdk \
        --workspace=@nimbalyst/tracker-core; \
    fi

# The build leaves TypeScript sources next to the emitted JS. They are dead
# weight in a shipped layer and make it ambiguous which copy is running.
#
# Named explicitly rather than swept with `find -name src`: two of the staged
# packages (collab-protocol, collab-adapters) publish `src/index.ts` as their
# entry point, and packages/electron/src holds the SQL migrations the runner
# reads at startup. A sweep would delete all three.
#
# The last two entries are the staging scaffolding, not build output. `bin/` is
# where the Dockerfile reads the launcher from, and the marker file is how the
# stager recognises a directory as one it may delete, so both have to be in the
# context -- but `COPY --from=builder /build` ships the whole tree, and neither
# belongs in /opt/nimbalyst/app. A second copy of the launcher there makes it
# ambiguous which one runs. buildContextAllowlist.mjs names them as
# CONTEXT_ONLY_PATHS and checks/image-pins.test.mjs keeps this list in step.
RUN rm -rf \
      /build/packages/node/src \
      /build/packages/runtime/src \
      /build/packages/runtime/scripts \
      /build/packages/extension-sdk/src \
      /build/packages/tracker-core/src \
      /build/bin \
      /build/.nimbalyst-build-context


# --- The image ----------------------------------------------------------------
FROM ${SANDBOX_BASE_IMAGE} AS runtime-image
ARG SANDBOX_VERSION
ARG NODE_VERSION
ARG APP_UID

LABEL org.opencontainers.image.title="nimbalyst-sandbox-node" \
      org.opencontainers.image.description="Nimbalyst headless agent runner on the Cloudflare Sandbox base image" \
      org.opencontainers.image.source="https://github.com/nimbalyst/nimbalyst" \
      com.nimbalyst.sandbox.version="${SANDBOX_VERSION}" \
      com.nimbalyst.node.version="${NODE_VERSION}"

COPY --from=node-dist /opt/nimbalyst/node /opt/nimbalyst/node
# One COPY from the builder stage, not from the host: this preserves the npm
# workspace layout -- hoisted /opt/nimbalyst/app/node_modules plus the relative
# @nimbalyst/* symlinks into packages/ -- which is what makes the runner
# resolvable at all. It also puts the SQL migrations exactly where
# packages/node's resolveSchemaDir() looks by default.
COPY --from=builder /build /opt/nimbalyst/app
COPY bin/nimbalyst-node /opt/nimbalyst/bin/nimbalyst-node
# The smoke check goes inside the app directory on purpose: that is where the
# hoisted node_modules lives, so its bare specifiers resolve through exactly the
# module graph the runner uses.
COPY bin/nimbalyst-smoke.mjs /opt/nimbalyst/app/nimbalyst-smoke.mjs

# The control API and runner share a container. Run both without root so local
# access to the control API cannot recover privileges the runner dropped.
RUN set -eux; \
    groupadd --gid "${APP_UID}" nimbalyst; \
    useradd --uid "${APP_UID}" --gid "${APP_UID}" --create-home --shell /bin/bash nimbalyst; \
    mkdir -p /var/lib/nimbalyst /workspace; \
    chown nimbalyst:nimbalyst /var/lib/nimbalyst /workspace; \
    chgrp nimbalyst /etc/ssl/certs/ca-certificates.crt; \
    chmod 0664 /etc/ssl/certs/ca-certificates.crt; \
    chmod 1777 /tmp; \
    chmod 0755 /opt/nimbalyst/bin/nimbalyst-node; \
    ln -sf /opt/nimbalyst/bin/nimbalyst-node /usr/local/bin/nimbalyst-node; \
    /opt/nimbalyst/node/bin/node --version

# Remove every setuid/setgid binary. The base image inherits 13 from Ubuntu --
# su, mount, umount, passwd, chsh, newgrp, fusermount3 among them -- and they
# are the whole reason the capability bounding set matters: without a setuid
# binary to execute, an unprivileged process has nothing to escalate through.
# None of them has a caller in this image; the agent runner is a Node process
# and the control server does not change user.
#
# This is done as root, before USER, because only root can clear the bits, and
# it is verified in the same layer rather than trusted -- `chmod a-s` on a file
# the build cannot write would otherwise fail quietly and leave the target in
# place. The runner additionally sets no_new_privs for itself (see
# bin/nimbalyst-node), so the two defences are independent.
RUN set -eux; \
    find / -xdev -perm /6000 -type f -exec chmod a-s {} +; \
    remaining="$(find / -xdev -perm /6000 -type f)"; \
    if [ -n "${remaining}" ]; then \
      echo "setuid/setgid files survived: ${remaining}" >&2; \
      exit 1; \
    fi

ENV HOME=/home/nimbalyst
USER 10001:10001

# Fails the build rather than shipping an image that only looks right: asserts
# the Node major, the deep `node`-condition runtime exports, the native SQLite
# binding, the platform-specific Claude Code binary, and that the real migration
# files apply to a real database -- as the unprivileged user.
RUN nimbalyst-node --smoke

# Keep the base tini + /container-server/sandbox entrypoint, running as uid 10001.
# The SDK appends the injected HTTPS CA during startup. Only the certificate
# bundle grants the runtime group write access; its directory and owner remain
# root. Root-only mounts are unsupported.
