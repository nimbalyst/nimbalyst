# Third-Party License Audit

Generated from `package-lock.json` and installed package legal files.

- Packages scanned: 874
- Review required: 0
- Approved exceptions: 3

## License Counts

- 0BSD: 1
- Apache-2.0: 41
- BlueOak-1.0.0: 9
- BSD-2-Clause: 7
- BSD-3-Clause: 28
- CC0-1.0: 2
- EPL-2.0: 1
- ISC: 59
- LGPL-3.0: 1
- MIT: 721
- Python-2.0: 1
- SEE LICENSE IN README.md: 1
- Unlicense: 2

## Review Required

- None

## Approved Exceptions

Packages with non-permissive licenses that have been manually reviewed and approved. See `packages/electron/build/license-approvals.json` for the source of truth.

- **@anthropic-ai/claude-agent-sdk@0.3.170** (Anthropic Commercial): Anthropic commercial license (https://code.claude.com/docs/en/legal-and-compliance). Permits use by developers writing code locally, which is exactly how Nimbalyst integrates the SDK. Used unmodified.
- **elkjs@0.11.1** (EPL-2.0): Eclipse Public License 2.0. Bundled unmodified as a JavaScript library. EPL-2.0 is a file-level weak copyleft that permits this without affecting Nimbalyst's licensing; only modifications to elkjs itself would need to be released under EPL-2.0.
- **libheif-js@1.19.8** (LGPL-3.0): GNU Lesser GPL 3.0. Bundled unmodified as a JavaScript module loaded at runtime from node_modules; users can substitute their own build. License text is included in THIRD_PARTY_NOTICES.txt. No copyleft contagion to Nimbalyst's source.

## Output Files

- `THIRD_PARTY_NOTICES.txt`: bundled attribution and notice text
- `THIRD_PARTY_LICENSES.json`: machine-readable package inventory
- `THIRD_PARTY_LICENSE_AUDIT.md`: summary for manual review
