#!/usr/bin/env python3
"""Drops platform packages that are not linux x86_64 or aarch64 (glibc) from generated-sources.json."""
import json
import re
import sys

OS = r"(?:darwin|win32|windows|android|freebsd|openbsd|netbsd|sunos|aix|openharmony)"
CPU = r"(?:x64|arm64|arm|ia32|ppc64|riscv64|s390x|loong64|mips64el|x86_64|aarch64|universal|64)"
FOREIGN = re.compile(
    rf"[-_/.]{OS}-{CPU}(?![a-z0-9])"
    r"|[-_/.]wasm32-wasi"
    r"|[-_/.]linux-(?:arm|ia32|ppc64|riscv64|s390x|loong64|mips64el|x86|armv7l)(?![a-z0-9])"
    r"|(?:arm|powerpc64le|riscv64gc|s390x|i686)-unknown-linux"
    r"|linuxmusl|musl",
    re.IGNORECASE,
)

# @vscode/ripgrep downloads the static musl build on every Linux libc.
RIPGREP = re.compile(r"(?:x86_64|aarch64)-unknown-linux-musl")


def foreign(entry: dict) -> bool:
    name = entry.get("url") or entry.get("dest-filename") or entry.get("dest") or ""
    return not RIPGREP.search(name) and bool(FOREIGN.search(name))


def prune_manifest(sources: list) -> None:
    """Drops pnpm-manifest.json entries whose tarball was pruned; populate_pnpm_store.py needs every listed tarball."""
    tarballs = {
        e["dest-filename"]
        for e in sources
        if e.get("dest") == "flatpak-node/pnpm-tarballs" and "dest-filename" in e
    }
    for e in sources:
        if e.get("dest-filename") == "pnpm-manifest.json":
            manifest = json.loads(e["contents"])
            manifest["packages"] = {k: v for k, v in manifest["packages"].items() if k in tarballs}
            e["contents"] = json.dumps(manifest)


def main(path: str) -> None:
    with open(path) as f:
        sources = json.load(f)
    kept = [e for e in sources if not foreign(e)]
    prune_manifest(kept)
    with open(path, "w") as f:
        json.dump(kept, f, indent=4)
        f.write("\n")
    print(f"{path}: kept {len(kept)} of {len(sources)} sources")


if __name__ == "__main__":
    main(sys.argv[1])
