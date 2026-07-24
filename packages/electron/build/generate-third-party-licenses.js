const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const electronRoot = path.resolve(__dirname, '..');
const outputDir = path.join(electronRoot, 'resources', 'generated');
const noticesPath = path.join(outputDir, 'THIRD_PARTY_NOTICES.txt');
const inventoryPath = path.join(outputDir, 'THIRD_PARTY_LICENSES.json');
const auditPath = path.join(outputDir, 'THIRD_PARTY_LICENSE_AUDIT.md');
const lockfilePath = path.join(repoRoot, 'package-lock.json');
const approvalsPath = path.join(electronRoot, 'build', 'license-approvals.json');

const reviewMode = process.argv.includes('--check');

const PERMISSIVE_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'Python-2.0',
  'Unlicense',
  'Zlib',
]);

const REVIEW_LICENSE_PATTERNS = [
  /\bAGPL\b/i,
  /\bEPL\b/i,
  /\bGPL\b/i,
  /\bLGPL\b/i,
  /\bMPL\b/i,
];

function main() {
  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  const approvals = loadApprovals();
  const workspaceRoots = getWorkspaceRoots();
  const packages = lockfile.packages || {};
  const visited = new Set();
  const collected = new Map();

  for (const rootKey of workspaceRoots) {
    walkDependencyTree(rootKey, packages, visited, collected);
  }

  const records = [...collected.values()].sort((a, b) =>
    a.name.localeCompare(b.name) ||
    a.version.localeCompare(b.version)
  );

  applyApprovals(records, approvals);

  const summary = buildSummary(records);
  const inventory = {
    generatedAt: new Date().toISOString(),
    scope: {
      workspaceRoots,
      description: 'Production dependencies reachable from Electron, runtime, and built-in extension workspaces.',
    },
    summary,
    packages: records,
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(noticesPath, renderNotices(records, summary));
  fs.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  fs.writeFileSync(auditPath, renderAudit(records, summary));

  console.log(`[licenses] Wrote ${path.relative(repoRoot, noticesPath)}`);
  console.log(`[licenses] Wrote ${path.relative(repoRoot, inventoryPath)}`);
  console.log(`[licenses] Wrote ${path.relative(repoRoot, auditPath)}`);
  console.log(`[licenses] ${summary.packageCount} packages, ${summary.reviewRequiredCount} require review`);

  if (reviewMode && summary.reviewRequiredCount > 0) {
    console.error('[licenses] Review-required packages detected:');
    for (const pkg of records.filter((record) => record.reviewRequired)) {
      console.error(`- ${pkg.name}@${pkg.version}: ${pkg.reviewReasons.join('; ')}`);
    }
    process.exitCode = 1;
  }
}

function loadApprovals() {
  if (!fs.existsSync(approvalsPath)) return new Map();
  const raw = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));
  const entries = Array.isArray(raw.approvals) ? raw.approvals : [];
  const map = new Map();
  for (const entry of entries) {
    if (entry && typeof entry.name === 'string' && typeof entry.reason === 'string') {
      map.set(entry.name, { license: entry.license || null, reason: entry.reason });
    }
  }
  return map;
}

function applyApprovals(records, approvals) {
  for (const record of records) {
    const approval = approvals.get(record.name);
    if (!approval) continue;
    record.approved = true;
    record.approvalReason = approval.reason;
    record.approvalLicense = approval.license;
    record.reviewRequired = false;
    record.reviewReasons = [];
  }
}

function getWorkspaceRoots() {
  const roots = [
    'packages/electron',
    'packages/runtime',
  ];

  const extensionsDir = path.join(repoRoot, 'packages', 'extensions');
  if (fs.existsSync(extensionsDir)) {
    const extensionRoots = fs.readdirSync(extensionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/extensions/${entry.name}`)
      .sort();
    roots.push(...extensionRoots);
  }

  return roots;
}

function walkDependencyTree(key, packages, visited, collected) {
  if (!key || visited.has(key)) return;

  const info = packages[key];
  if (!info) return;

  visited.add(key);

  if (key.includes('node_modules/')) {
    const record = buildPackageRecord(key, info);
    if (!record.name.startsWith('@nimbalyst/')) {
      const existing = collected.get(record.id);
      if (existing) {
        existing.installPaths = dedupeStrings([...existing.installPaths, ...record.installPaths]);
        existing.licenseFiles = dedupeArtifacts([...existing.licenseFiles, ...record.licenseFiles]);
        existing.noticeFiles = dedupeArtifacts([...existing.noticeFiles, ...record.noticeFiles]);
        existing.reviewReasons = dedupeStrings([...existing.reviewReasons, ...record.reviewReasons]);
        existing.issues = dedupeStrings([...existing.issues, ...record.issues]);
        existing.reviewRequired = existing.reviewReasons.length > 0;
      } else {
        collected.set(record.id, record);
      }
    }
  }

  for (const dependencyName of Object.keys(info.dependencies || {}).sort()) {
    const dependencyKey = resolveDependencyKey(key, dependencyName, packages);
    if (dependencyKey) {
      walkDependencyTree(dependencyKey, packages, visited, collected);
    }
  }
}

function resolveDependencyKey(fromKey, dependencyName, packages) {
  let current = fromKey;
  while (true) {
    const candidate = `${current ? `${current}/` : ''}node_modules/${dependencyName}`;
    if (packages[candidate]) return candidate;
    if (!current) break;
    current = parentKey(current);
  }

  const hoistedCandidate = `node_modules/${dependencyName}`;
  return packages[hoistedCandidate] ? hoistedCandidate : null;
}

function parentKey(key) {
  const index = key.lastIndexOf('/');
  return index === -1 ? '' : key.slice(0, index);
}

function buildPackageRecord(key, info) {
  const packageDir = path.join(repoRoot, key);
  const packageName = getPackageNameFromKey(key);
  const rawLicense = normalizeLicenseString(info.license) || readLegacyLicense(packageDir);
  const licenseArtifacts = findLegalArtifacts(packageDir, ['license', 'licence', 'copying']);
  const noticeArtifacts = findLegalArtifacts(packageDir, ['notice']);
  const inferredFromText = detectLicenseFromArtifacts(licenseArtifacts);
  const selectedLicense = selectLicense(rawLicense, inferredFromText);
  const issues = [];
  const reviewReasons = [];

  if (!rawLicense) {
    issues.push('Missing license field in package metadata');
  }

  if (rawLicense && /^SEE LICENSE IN /i.test(rawLicense) && !selectedLicense) {
    reviewReasons.push(`License references an external file but could not be inferred: ${rawLicense}`);
  }

  if (!licenseArtifacts.length) {
    issues.push('No license file found in package directory');
  }

  if (!selectedLicense) {
    reviewReasons.push('Unable to determine a concrete license from package metadata or legal files');
  } else if (requiresReview(selectedLicense, rawLicense)) {
    reviewReasons.push(`Manual review required for license ${selectedLicense}`);
  }

  return {
    id: `${packageName}@${info.version}`,
    name: packageName,
    version: info.version,
    rawLicense,
    selectedLicense,
    reviewRequired: reviewReasons.length > 0,
    reviewReasons,
    approved: false,
    approvalReason: null,
    approvalLicense: null,
    issues,
    installPaths: [key],
    resolved: info.resolved || null,
    licenseFiles: licenseArtifacts,
    noticeFiles: noticeArtifacts,
  };
}

function getPackageNameFromKey(key) {
  const segments = key.split('node_modules/').filter(Boolean);
  return segments[segments.length - 1];
}

function normalizeLicenseString(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function readLegacyLicense(packageDir) {
  const manifestPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  const legacy = manifest.licenses;
  if (Array.isArray(legacy) && legacy.length > 0) {
    const types = legacy
      .map((entry) => (entry && typeof entry === 'object' ? entry.type : entry))
      .filter((value) => typeof value === 'string' && value.trim().length);
    if (types.length === 1) return types[0].trim();
    if (types.length > 1) return `(${types.map((t) => t.trim()).join(' OR ')})`;
  }
  if (legacy && typeof legacy === 'object' && typeof legacy.type === 'string') {
    return legacy.type.trim() || null;
  }
  return null;
}

function findLegalArtifacts(packageDir, prefixes) {
  if (!fs.existsSync(packageDir)) return [];

  const matches = fs.readdirSync(packageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((fileName) => prefixes.some((prefix) => fileName.toLowerCase().startsWith(prefix)))
    .sort((a, b) => a.localeCompare(b));

  return matches.map((fileName) => {
    const absolutePath = path.join(packageDir, fileName);
    return {
      fileName,
      relativePath: path.relative(repoRoot, absolutePath),
      text: readTextFile(absolutePath),
    };
  });
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

function detectLicenseFromArtifacts(artifacts) {
  for (const artifact of artifacts) {
    const detected = detectLicenseFromText(artifact.text);
    if (detected) return detected;
  }
  return null;
}

function detectLicenseFromText(text) {
  if (!text) return null;

  const normalized = text.toLowerCase();
  if (normalized.includes('gnu lesser general public license')) return 'LGPL-3.0';
  if (normalized.includes('gnu general public license')) return 'GPL-3.0';
  if (normalized.includes('apache license')) return 'Apache-2.0';
  if (normalized.includes('mozilla public license')) return 'MPL-2.0';
  if (normalized.includes('bsd 3-clause') || normalized.includes('redistribution and use in source and binary forms, with or without modification, are permitted')) {
    return 'BSD-3-Clause';
  }
  if (normalized.includes('isc license')) return 'ISC';
  if (normalized.includes('permission is hereby granted') || normalized.includes('the mit license')) return 'MIT';
  if (normalized.includes('blue oak model license')) return 'BlueOak-1.0.0';
  if (normalized.includes('unlicense')) return 'Unlicense';
  if (normalized.includes('creative commons zero')) return 'CC0-1.0';
  if (normalized.includes('python software foundation license')) return 'Python-2.0';
  return null;
}

function selectLicense(rawLicense, inferredFromText) {
  const candidates = [];
  if (rawLicense && /^SEE LICENSE IN /i.test(rawLicense)) {
    if (inferredFromText) {
      candidates.push(inferredFromText);
    }
    candidates.push(...extractSpdxTokens(rawLicense));
  } else {
    if (rawLicense) {
      candidates.push(...extractSpdxTokens(rawLicense));
    }
    if (inferredFromText) {
      candidates.push(inferredFromText);
    }
  }

  const permissiveCandidate = candidates.find((candidate) => PERMISSIVE_LICENSES.has(candidate));
  if (permissiveCandidate) return permissiveCandidate;
  if (candidates.length > 0) return candidates[0];
  return null;
}

function extractSpdxTokens(expression) {
  if (!expression) return [];
  return dedupeStrings((expression.match(/[A-Za-z0-9.+-]+/g) || [])
    .filter((token) => !token.includes('/'))
    .filter((token) => !token.startsWith('.'))
    .filter((token) => !token.toLowerCase().endsWith('.md'))
    .filter((token) => !token.toLowerCase().endsWith('.txt'))
    .filter((token) => !['AND', 'OR', 'WITH', 'IN', 'SEE', 'LICENSE', 'README', 'CUSTOM'].includes(token.toUpperCase())));
}

function requiresReview(selectedLicense, rawLicense) {
  if (!selectedLicense) return true;

  const normalizedSelected = selectedLicense.toUpperCase();
  if (normalizedSelected.includes('SEE LICENSE')) return true;

  if (REVIEW_LICENSE_PATTERNS.some((pattern) => pattern.test(selectedLicense))) {
    const rawTokens = extractSpdxTokens(rawLicense || '');
    const hasPermissiveOption = rawTokens.some((token) => PERMISSIVE_LICENSES.has(token));
    return !hasPermissiveOption;
  }

  return false;
}

function buildSummary(records) {
  const licenseCounts = {};
  for (const record of records) {
    const bucket = record.selectedLicense || record.rawLicense || 'Unknown';
    licenseCounts[bucket] = (licenseCounts[bucket] || 0) + 1;
  }

  return {
    packageCount: records.length,
    reviewRequiredCount: records.filter((record) => record.reviewRequired).length,
    approvedExceptionCount: records.filter((record) => record.approved).length,
    licenseCounts: Object.fromEntries(Object.entries(licenseCounts).sort(([a], [b]) => a.localeCompare(b))),
    reviewRequiredPackages: records
      .filter((record) => record.reviewRequired)
      .map((record) => ({
        name: record.name,
        version: record.version,
        reasons: record.reviewReasons,
      })),
    approvedExceptions: records
      .filter((record) => record.approved)
      .map((record) => ({
        name: record.name,
        version: record.version,
        license: record.approvalLicense || record.selectedLicense || record.rawLicense || 'Unknown',
        reason: record.approvalReason,
      })),
  };
}

function renderNotices(records, summary) {
  const sections = [
    'Nimbalyst Third-Party Notices',
    '',
    'This file aggregates license and notice texts for third-party packages reachable',
    'from the Electron app, runtime package, and built-in extensions.',
    '',
    `Package count: ${summary.packageCount}`,
    `Packages requiring manual review: ${summary.reviewRequiredCount}`,
    `Approved exceptions (non-permissive licenses, manually reviewed): ${summary.approvedExceptionCount}`,
    '',
  ];

  if (summary.reviewRequiredPackages.length > 0) {
    sections.push('Review-required packages:');
    for (const pkg of summary.reviewRequiredPackages) {
      sections.push(`- ${pkg.name}@${pkg.version}: ${pkg.reasons.join('; ')}`);
    }
    sections.push('');
  }

  if (summary.approvedExceptions.length > 0) {
    sections.push('Approved exceptions:');
    for (const pkg of summary.approvedExceptions) {
      sections.push(`- ${pkg.name}@${pkg.version} (${pkg.license}): ${pkg.reason}`);
    }
    sections.push('');
  }

  for (const record of records) {
    sections.push('='.repeat(80));
    sections.push(`${record.name}@${record.version}`);
    sections.push(`Selected license: ${record.selectedLicense || 'Unknown'}`);
    sections.push(`Declared license: ${record.rawLicense || 'Not declared'}`);
    sections.push(`Install paths: ${record.installPaths.join(', ')}`);
    if (record.approved) {
      sections.push(`Approved exception: ${record.approvalReason}`);
    }
    if (record.reviewRequired) {
      sections.push(`Review required: ${record.reviewReasons.join('; ')}`);
    }
    if (record.issues.length > 0) {
      sections.push(`Issues: ${record.issues.join('; ')}`);
    }
    sections.push('');

    if (record.licenseFiles.length === 0) {
      sections.push('No license file found.');
      sections.push('');
    } else {
      for (const artifact of record.licenseFiles) {
        sections.push(`--- ${artifact.fileName} (${artifact.relativePath}) ---`);
        sections.push(artifact.text || '[Unreadable license file]');
        sections.push('');
      }
    }

    if (record.noticeFiles.length > 0) {
      for (const artifact of record.noticeFiles) {
        sections.push(`--- ${artifact.fileName} (${artifact.relativePath}) ---`);
        sections.push(artifact.text || '[Unreadable notice file]');
        sections.push('');
      }
    }
  }

  return `${sections.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function renderAudit(records, summary) {
  const lines = [
    '# Third-Party License Audit',
    '',
    `Generated from \`package-lock.json\` and installed package legal files.`,
    '',
    `- Packages scanned: ${summary.packageCount}`,
    `- Review required: ${summary.reviewRequiredCount}`,
    `- Approved exceptions: ${summary.approvedExceptionCount}`,
    '',
    '## License Counts',
    '',
  ];

  for (const [license, count] of Object.entries(summary.licenseCounts)) {
    lines.push(`- ${license}: ${count}`);
  }

  lines.push('');
  lines.push('## Review Required');
  lines.push('');

  if (summary.reviewRequiredPackages.length === 0) {
    lines.push('- None');
  } else {
    for (const pkg of summary.reviewRequiredPackages) {
      lines.push(`- ${pkg.name}@${pkg.version}: ${pkg.reasons.join('; ')}`);
    }
  }

  lines.push('');
  lines.push('## Approved Exceptions');
  lines.push('');
  lines.push('Packages with non-permissive licenses that have been manually reviewed and approved. See `packages/electron/build/license-approvals.json` for the source of truth.');
  lines.push('');

  if (summary.approvedExceptions.length === 0) {
    lines.push('- None');
  } else {
    for (const pkg of summary.approvedExceptions) {
      lines.push(`- **${pkg.name}@${pkg.version}** (${pkg.license}): ${pkg.reason}`);
    }
  }

  lines.push('');
  lines.push('## Output Files');
  lines.push('');
  lines.push('- `THIRD_PARTY_NOTICES.txt`: bundled attribution and notice text');
  lines.push('- `THIRD_PARTY_LICENSES.json`: machine-readable package inventory');
  lines.push('- `THIRD_PARTY_LICENSE_AUDIT.md`: summary for manual review');

  return `${lines.join('\n')}\n`;
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function dedupeArtifacts(values) {
  const seen = new Set();
  const deduped = [];
  for (const value of values) {
    const key = `${value.fileName}:${value.relativePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(value);
  }
  return deduped;
}

main();
