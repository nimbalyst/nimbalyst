import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { useTheme } from '../../../hooks/useTheme';
import { marketplaceInstallProgressAtom } from '../../../store/atoms/appCommands';

// Registry types (mirror main process types)
interface RegistryExtension {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  categories: string[];
  tags: string[];
  icon: string;
  screenshots: Array<{ src: string; srcLight?: string; alt: string }>;
  downloads: number;
  featured: boolean;
  permissions: string[];
  minimumAppVersion: string;
  downloadUrl: string;
  checksum: string;
  repositoryUrl: string;
  changelog: string;
  tagline?: string;
  longDescription?: string;
  highlights?: string[];
  fileTypes?: string[];
}

interface RegistryCategory {
  id: string;
  name: string;
  icon: string;
}

interface RegistryData {
  schemaVersion: number;
  generatedAt: string;
  extensions: RegistryExtension[];
  categories: RegistryCategory[];
}

interface MarketplaceInstallRecord {
  extensionId: string;
  version: string;
  installedAt: string;
  updatedAt: string;
  source: 'marketplace' | 'github-url';
  githubUrl?: string;
}

interface InstalledExtensionInfo {
  id: string;
  path: string;
  isBuiltin: boolean;
  manifest: {
    name?: string;
    version?: string;
    description?: string;
    author?: string;
    icon?: string;
  };
}

type InstallStatus = 'idle' | 'installing' | 'installed' | 'error';

interface ExtensionMarketplaceInstallRequest {
  extensionId: string;
  requestedAt: string;
  token: number;
}

interface ExtensionMarketplacePanelProps {
  installRequest?: ExtensionMarketplaceInstallRequest | null;
  onInstallRequestHandled?: (token: number) => void;
  onViewInstalled?: () => void;
}

// Category icon map (Material Symbols)
const CATEGORY_ICONS: Record<string, string> = {
  'developer-tools': 'code',
  'diagrams': 'brush',
  'data': 'table_chart',
  'ai-tools': 'auto_awesome',
  'themes': 'palette',
  'writing': 'edit_note',
  'knowledge': 'psychology',
  'integrations': 'link',
};

export function ExtensionMarketplacePanel({
  installRequest = null,
  onInstallRequestHandled,
  onViewInstalled,
}: ExtensionMarketplacePanelProps) {
  const posthog = usePostHog();
  const { theme } = useTheme();

  // All hooks must be declared before any early returns
  const [hasAcceptedRisk, setHasAcceptedRisk] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [registry, setRegistry] = useState<RegistryData | null>(null);
  const [installedExtensions, setInstalledExtensions] = useState<Record<string, MarketplaceInstallRecord>>({});
  const [allInstalledExtensions, setAllInstalledExtensions] = useState<InstalledExtensionInfo[]>([]);
  const allInstalledIds = useMemo(() => new Set(allInstalledExtensions.map(e => e.id)), [allInstalledExtensions]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedExtension, setSelectedExtension] = useState<RegistryExtension | null>(null);
  const [installStatus, setInstallStatus] = useState<Record<string, InstallStatus>>({});
  const [statusMessage, setStatusMessage] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [githubInstalling, setGithubInstalling] = useState(false);
  const [availableUpdates, setAvailableUpdates] = useState<Record<string, { currentVersion: string; availableVersion: string }>>({});

  // GitHub-install progress: the central listener bumps an atom on every
  // install-progress IPC event. We watch the atom only while an install is
  // active, and ignore versions that arrived before this install started.
  const installProgress = useAtomValue(marketplaceInstallProgressAtom);
  const installProgressBaselineRef = useRef<number>(0);
  useEffect(() => {
    if (!githubInstalling || !installProgress) return;
    if (installProgress.version <= installProgressBaselineRef.current) return;
    setStatusMessage(installProgress.message);
  }, [githubInstalling, installProgress]);

  // Check if user has previously accepted the marketplace risk warning
  useEffect(() => {
    window.electronAPI.invoke('app-settings:get', 'marketplaceRiskAccepted').then((accepted: boolean) => {
      setHasAcceptedRisk(!!accepted);
    }).catch(() => {
      setHasAcceptedRisk(false);
    });
  }, []);

  useEffect(() => {
    if (hasAcceptedRisk) {
      loadData();
      posthog?.capture('extension_marketplace_viewed');
    }
  }, [hasAcceptedRisk]);

  useEffect(() => {
    if (!installRequest || !hasAcceptedRisk || !registry) return;

    const requestedExtension = registry.extensions.find((extension) => extension.id === installRequest.extensionId);
    if (!requestedExtension) {
      setStatusMessage(`Extension ${installRequest.extensionId} was not found in the marketplace`);
      onInstallRequestHandled?.(installRequest.token);

      const timeoutId = window.setTimeout(() => setStatusMessage(''), 5000);
      return () => window.clearTimeout(timeoutId);
    }

    setSelectedCategory(null);
    setSearchQuery('');
    setSelectedExtension(requestedExtension);
    setStatusMessage(`Review ${requestedExtension.name} before installing it from the marketplace`);
    onInstallRequestHandled?.(installRequest.token);

    const timeoutId = window.setTimeout(() => setStatusMessage(''), 5000);
    return () => window.clearTimeout(timeoutId);
  }, [installRequest, hasAcceptedRisk, onInstallRequestHandled, registry]);

  const handleAcceptRisk = async () => {
    await window.electronAPI.invoke('app-settings:set', 'marketplaceRiskAccepted', true);
    setHasAcceptedRisk(true);
    posthog?.capture('extension_marketplace_risk_accepted');
  };

  const loadData = async () => {
    setLoading(true);
    setError(null);

    try {
      const [registryResult, installedResult, allExtensionsResult, updatesResult] = await Promise.all([
        window.electronAPI.invoke('extension-marketplace:fetch-registry'),
        window.electronAPI.invoke('extension-marketplace:get-installed'),
        window.electronAPI.invoke('extensions:list-installed'),
        window.electronAPI.invoke('extension-marketplace:check-updates'),
      ]);

      if (registryResult.success) {
        setRegistry(registryResult.data);
      } else {
        setError(registryResult.error || 'Failed to load marketplace');
      }

      if (installedResult.success) {
        setInstalledExtensions(installedResult.data || {});
      }

      // Track all installed extension IDs (built-in + user-installed)
      if (Array.isArray(allExtensionsResult)) {
        setAllInstalledExtensions(allExtensionsResult as InstalledExtensionInfo[]);
      }

      if (updatesResult.success && Array.isArray(updatesResult.data)) {
        const updateMap: Record<string, { currentVersion: string; availableVersion: string }> = {};
        for (const u of updatesResult.data) {
          updateMap[u.extensionId] = { currentVersion: u.currentVersion, availableVersion: u.availableVersion };
        }
        setAvailableUpdates(updateMap);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load marketplace data';
      console.error('Failed to load marketplace data:', err);
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleInstall = useCallback(async (extension: RegistryExtension) => {
    setInstallStatus(prev => ({ ...prev, [extension.id]: 'installing' }));
    setStatusMessage(`Installing ${extension.name}...`);

    try {
      const result = await window.electronAPI.invoke(
        'extension-marketplace:install',
        extension.id,
        extension.downloadUrl,
        extension.checksum,
        extension.version,
      );

      if (result.success) {
        setInstallStatus(prev => ({ ...prev, [extension.id]: 'installed' }));
        setStatusMessage(`${extension.name} installed successfully`);

        posthog?.capture('extension_marketplace_installed', {
          extensionId: extension.id,
          source: 'marketplace',
          category: extension.categories[0],
        });

        // Refresh installed list
        const [installedResult, allExtensionsResult] = await Promise.all([
          window.electronAPI.invoke('extension-marketplace:get-installed'),
          window.electronAPI.invoke('extensions:list-installed'),
        ]);
        if (installedResult.success) {
          setInstalledExtensions(installedResult.data || {});
        }
        if (Array.isArray(allExtensionsResult)) {
          setAllInstalledExtensions(allExtensionsResult as InstalledExtensionInfo[]);
        }
      } else {
        setInstallStatus(prev => ({ ...prev, [extension.id]: 'error' }));
        setStatusMessage(result.error || 'Installation failed');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Installation failed';
      setInstallStatus(prev => ({ ...prev, [extension.id]: 'error' }));
      setStatusMessage(errorMessage);
    }

    setTimeout(() => setStatusMessage(''), 5000);
  }, [posthog]);

  const handleUninstall = useCallback(async (extensionId: string) => {
    const ext = registry?.extensions.find(e => e.id === extensionId);
    const name = ext?.name || extensionId;

    setStatusMessage(`Uninstalling ${name}...`);

    try {
      const result = await window.electronAPI.invoke('extension-marketplace:uninstall', extensionId);

      if (result.success) {
        setInstallStatus(prev => ({ ...prev, [extensionId]: 'idle' }));
        setStatusMessage(`${name} uninstalled`);

        posthog?.capture('extension_marketplace_uninstalled', { extensionId });

        const [installedResult, allExtensionsResult] = await Promise.all([
          window.electronAPI.invoke('extension-marketplace:get-installed'),
          window.electronAPI.invoke('extensions:list-installed'),
        ]);
        if (installedResult.success) {
          setInstalledExtensions(installedResult.data || {});
        }
        if (Array.isArray(allExtensionsResult)) {
          setAllInstalledExtensions(allExtensionsResult as InstalledExtensionInfo[]);
        }
      } else {
        setStatusMessage(result.error || 'Uninstall failed');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Uninstall failed';
      setStatusMessage(errorMessage);
    }

    setTimeout(() => setStatusMessage(''), 5000);
  }, [registry, posthog]);

  const handleGithubInstall = useCallback(async () => {
    if (!githubUrl.trim()) return;

    // Baseline the progress atom version so we only react to events emitted
    // by this install, not stale ones from a previous run.
    installProgressBaselineRef.current = installProgress?.version ?? 0;
    setGithubInstalling(true);
    setStatusMessage(`Installing from GitHub...`);

    try {
      const result = await window.electronAPI.invoke('extension-marketplace:install-from-github', githubUrl.trim());

      if (result.success) {
        setStatusMessage(`Extension installed from GitHub`);
        setGithubUrl('');

        posthog?.capture('extension_marketplace_installed', {
          extensionId: result.extensionId,
          source: 'github-url',
        });

        const installedResult = await window.electronAPI.invoke('extension-marketplace:get-installed');
        if (installedResult.success) {
          setInstalledExtensions(installedResult.data || {});
        }
      } else {
        setStatusMessage(result.error || 'GitHub installation failed');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'GitHub installation failed';
      setStatusMessage(errorMessage);
    } finally {
      setGithubInstalling(false);
    }

    setTimeout(() => setStatusMessage(''), 5000);
  }, [githubUrl, posthog, installProgress?.version]);

  const isExtensionInstalled = useCallback((extensionId: string): boolean => {
    return !!installedExtensions[extensionId] || allInstalledIds.has(extensionId);
  }, [installedExtensions, allInstalledIds]);

  const isBuiltinExtension = useCallback((extensionId: string): boolean => {
    return allInstalledIds.has(extensionId) && !installedExtensions[extensionId];
  }, [installedExtensions, allInstalledIds]);

  const getAvailableUpdate = useCallback((extensionId: string) => {
    return availableUpdates[extensionId] || null;
  }, [availableUpdates]);

  const handleUpdate = useCallback(async (extension: RegistryExtension) => {
    setInstallStatus(prev => ({ ...prev, [extension.id]: 'installing' }));
    setStatusMessage(`Updating ${extension.name} to v${extension.version}...`);

    try {
      const result = await window.electronAPI.invoke(
        'extension-marketplace:install',
        extension.id,
        extension.downloadUrl,
        extension.checksum,
        extension.version,
      );

      if (result.success) {
        setInstallStatus(prev => ({ ...prev, [extension.id]: 'installed' }));
        setStatusMessage(`${extension.name} updated to v${extension.version}`);
        setAvailableUpdates(prev => {
          const next = { ...prev };
          delete next[extension.id];
          return next;
        });

        posthog?.capture('extension_marketplace_updated', {
          extensionId: extension.id,
          fromVersion: availableUpdates[extension.id]?.currentVersion,
          toVersion: extension.version,
        });

        const [installedResult, allExtensionsResult] = await Promise.all([
          window.electronAPI.invoke('extension-marketplace:get-installed'),
          window.electronAPI.invoke('extensions:list-installed'),
        ]);
        if (installedResult.success) {
          setInstalledExtensions(installedResult.data || {});
        }
        if (Array.isArray(allExtensionsResult)) {
          setAllInstalledExtensions(allExtensionsResult as InstalledExtensionInfo[]);
        }
      } else {
        setInstallStatus(prev => ({ ...prev, [extension.id]: 'error' }));
        setStatusMessage(result.error || 'Update failed');
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Update failed';
      setInstallStatus(prev => ({ ...prev, [extension.id]: 'error' }));
      setStatusMessage(errorMessage);
    }

    setTimeout(() => setStatusMessage(''), 5000);
  }, [posthog, availableUpdates]);

  const handleUpdateAll = useCallback(async () => {
    if (!registry) return;
    const updateIds = Object.keys(availableUpdates);
    if (updateIds.length === 0) return;

    setStatusMessage(`Updating ${updateIds.length} extension${updateIds.length > 1 ? 's' : ''}...`);

    for (const extId of updateIds) {
      const ext = registry.extensions.find(e => e.id === extId);
      if (ext) await handleUpdate(ext);
    }
  }, [registry, availableUpdates, handleUpdate]);

  // Filter extensions
  const filteredExtensions = useMemo(() => {
    if (!registry) return [];
    return registry.extensions.filter(ext => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matches = ext.name.toLowerCase().includes(query) ||
          ext.description.toLowerCase().includes(query) ||
          ext.author.toLowerCase().includes(query) ||
          ext.tags.some(t => t.toLowerCase().includes(query)) ||
          (ext.tagline && ext.tagline.toLowerCase().includes(query));
        if (!matches) return false;
      }
      // Category filter
      if (selectedCategory) {
        if (!ext.categories.includes(selectedCategory)) return false;
      }
      return true;
    });
  }, [registry, searchQuery, selectedCategory]);

  // Group by category
  const extensionsByCategory = useMemo(() => {
    const grouped: Record<string, RegistryExtension[]> = {};
    filteredExtensions.forEach(ext => {
      const cat = ext.categories[0] || 'other';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(ext);
    });
    return grouped;
  }, [filteredExtensions]);

  // Featured extensions
  const featuredExtensions = useMemo(() => {
    return filteredExtensions.filter(e => e.featured);
  }, [filteredExtensions]);

  // Show loading state while checking risk acceptance
  if (hasAcceptedRisk === null) {
    return (
      <div className="provider-panel flex flex-col">
        <div className="p-8 text-center text-[var(--nim-text-muted)]">Loading...</div>
      </div>
    );
  }

  // Show security warning if not yet accepted
  if (!hasAcceptedRisk) {
    return (
      <div className="provider-panel flex flex-col" data-testid="extension-marketplace-panel">
        <div className="mb-6 pb-4 border-b border-[var(--nim-border)]">
          <h3 className="text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">Extension Marketplace</h3>
          <p className="text-sm leading-relaxed text-[var(--nim-text-muted)]">
            Discover and install extensions to enhance your Nimbalyst workspace.
          </p>
        </div>

        <div className="flex flex-col gap-4 p-6 border border-[var(--nim-warning)] rounded-lg bg-[rgba(251,191,36,0.05)]">
          <div className="flex items-start gap-3">
            <MaterialSymbol icon="warning" size={24} className="text-[var(--nim-warning)] shrink-0 mt-0.5" />
            <div>
              <h4 className="m-0 mb-2 text-base font-semibold text-[var(--nim-text)]">Security Warning</h4>
              <div className="text-sm leading-relaxed text-[var(--nim-text-muted)] flex flex-col gap-3">
                <p className="m-0">
                  Extensions run with access to your local file system and can execute code on your machine.
                  Installing untrusted extensions may pose security risks including:
                </p>
                <ul className="m-0 pl-5 flex flex-col gap-1.5">
                  <li>Reading or modifying files on your computer</li>
                  <li>Executing arbitrary code in the application context</li>
                  <li>Accessing network resources</li>
                  <li>Interacting with other installed extensions</li>
                </ul>
                <p className="m-0">
                  Only install extensions from sources you trust. Nimbalyst does not review or verify
                  third-party extensions installed from GitHub URLs. Marketplace extensions published
                  by Nimbalyst are reviewed for safety.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2 border-t border-[var(--nim-border)]">
            <button
              className="py-2.5 px-5 border-none rounded-md bg-[var(--nim-primary)] text-white text-sm font-medium cursor-pointer transition-opacity duration-150 hover:opacity-90"
              onClick={handleAcceptRisk}
              data-testid="marketplace-accept-risk"
            >
              I understand the risks
            </button>
            <span className="text-xs text-[var(--nim-text-faint)]">
              You can reset this in Settings &gt; Advanced
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="provider-panel flex flex-col">
        <div className="p-8 text-center text-[var(--nim-text-muted)]">Loading marketplace...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="provider-panel flex flex-col">
        <div className="p-8 text-center text-[var(--nim-error)]">
          Error: {error}
          <button
            onClick={loadData}
            className="ml-4 px-4 py-2 bg-[var(--nim-primary)] text-white border-none rounded cursor-pointer"
            data-testid="marketplace-retry"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const renderExtensionCard = (ext: RegistryExtension) => {
    const installed = isExtensionInstalled(ext.id);
    const update = getAvailableUpdate(ext.id);
    const status = installStatus[ext.id] || 'idle';
    const categoryIcon = CATEGORY_ICONS[ext.categories[0]] || 'extension';

    return (
      <div
        key={ext.id}
        className={`flex flex-col p-4 border rounded-lg cursor-pointer transition-all duration-150 ${
          update
            ? 'border-[rgba(96,165,250,0.4)] bg-[rgba(96,165,250,0.05)]'
            : installed
              ? 'border-[rgba(39,174,96,0.3)] bg-[rgba(39,174,96,0.05)]'
              : 'border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]'
        } hover:border-[var(--nim-primary)] hover:bg-[var(--nim-bg-hover)]`}
        onClick={() => setSelectedExtension(ext)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setSelectedExtension(ext);
          }
        }}
        data-testid={`marketplace-card-${ext.id}`}
      >
        <div className="flex items-center gap-3 mb-2">
          <div className="w-8 h-8 rounded-md bg-[var(--nim-bg-tertiary)] flex items-center justify-center shrink-0">
            <MaterialSymbol icon={categoryIcon} size={18} />
          </div>
          <div className="font-semibold text-[0.9375rem] text-[var(--nim-text)] truncate">{ext.name}</div>
        </div>
        <div className="text-[0.8125rem] text-[var(--nim-text-muted)] leading-relaxed mb-3 flex-1 line-clamp-2">{ext.tagline || ext.description}</div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--nim-text-faint)]">by {ext.author}</span>
            {ext.downloads > 0 && (
              <span className="text-xs text-[var(--nim-text-faint)]">
                {ext.downloads.toLocaleString()} installs
              </span>
            )}
          </div>
          {update ? (
            <button
              className={`py-1.5 px-3 border-none rounded text-xs font-medium cursor-pointer transition-opacity duration-150 ${
                status === 'installing'
                  ? 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]'
                  : 'bg-[var(--nim-primary)] text-white hover:opacity-90'
              } disabled:opacity-60 disabled:cursor-not-allowed`}
              onClick={(e) => {
                e.stopPropagation();
                handleUpdate(ext);
              }}
              disabled={status === 'installing'}
              data-testid={`marketplace-update-${ext.id}`}
            >
              {status === 'installing' ? 'Updating...' : `Update to v${update.availableVersion}`}
            </button>
          ) : installed ? (
            <span className={`inline-flex items-center px-2 py-1 rounded text-[0.6875rem] font-semibold uppercase tracking-tight ${
              isBuiltinExtension(ext.id)
                ? 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]'
                : 'bg-[rgba(39,174,96,0.15)] text-[#27ae60]'
            }`}>
              {isBuiltinExtension(ext.id) ? 'Built-in' : 'Installed'}
            </span>
          ) : (
            <button
              className={`py-1.5 px-3 border-none rounded text-xs font-medium cursor-pointer transition-opacity duration-150 ${
                status === 'installing'
                  ? 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]'
                  : 'bg-[var(--nim-primary)] text-white hover:opacity-90'
              } disabled:opacity-60 disabled:cursor-not-allowed`}
              onClick={(e) => {
                e.stopPropagation();
                handleInstall(ext);
              }}
              disabled={status === 'installing'}
              data-testid={`marketplace-install-${ext.id}`}
            >
              {status === 'installing' ? 'Installing...' : 'Install'}
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderDiscover = () => (
    <div data-testid="marketplace-discover" role="main">
      {/* Search */}
      <div className="relative mb-4" role="search">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search extensions..."
          className="w-full py-3 pl-4 pr-10 border border-[var(--nim-border)] rounded-lg bg-[var(--nim-bg)] text-[var(--nim-text)] text-[0.9375rem] outline-none focus:border-[var(--nim-primary)] placeholder:text-[var(--nim-text-faint)]"
          data-testid="marketplace-search"
          autoFocus
        />
        {searchQuery && (
          <button
            className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 border-none rounded-full bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] text-xs cursor-pointer flex items-center justify-center hover:bg-[var(--nim-text-faint)] hover:text-[var(--nim-bg)]"
            onClick={() => setSearchQuery('')}
            data-testid="marketplace-search-clear"
          >
            x
          </button>
        )}
      </div>

      {/* Category Chips */}
      {registry && (
        <div className="flex flex-wrap gap-2 mb-6" data-testid="marketplace-categories">
          <button
            className={`py-1.5 px-3 border rounded-full text-xs font-medium cursor-pointer transition-all duration-150 ${
              !selectedCategory
                ? 'border-[var(--nim-primary)] bg-[var(--nim-primary)] text-white'
                : 'border-[var(--nim-border)] bg-transparent text-[var(--nim-text-muted)] hover:border-[var(--nim-primary)] hover:text-[var(--nim-text)]'
            }`}
            onClick={() => setSelectedCategory(null)}
          >
            All
          </button>
          {registry.categories.map(cat => {
            const count = registry.extensions.filter(e => e.categories.includes(cat.id)).length;
            if (count === 0) return null;
            return (
              <button
                key={cat.id}
                className={`py-1.5 px-3 border rounded-full text-xs font-medium cursor-pointer transition-all duration-150 ${
                  selectedCategory === cat.id
                    ? 'border-[var(--nim-primary)] bg-[var(--nim-primary)] text-white'
                    : 'border-[var(--nim-border)] bg-transparent text-[var(--nim-text-muted)] hover:border-[var(--nim-primary)] hover:text-[var(--nim-text)]'
                }`}
                onClick={() => setSelectedCategory(selectedCategory === cat.id ? null : cat.id)}
              >
                {cat.name} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* Featured (only when no search/category filter) */}
      {!searchQuery && !selectedCategory && featuredExtensions.length > 0 && (
        <div className="mb-6">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--nim-text-faint)] m-0 mb-3 pb-2 border-b border-[var(--nim-border)]">
            Featured
          </h4>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {featuredExtensions.map(renderExtensionCard)}
          </div>
        </div>
      )}

      {/* By Category */}
      {(searchQuery || selectedCategory) ? (
        // Flat list when searching/filtering
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {filteredExtensions.map(renderExtensionCard)}
        </div>
      ) : (
        // Grouped by category
        registry?.categories.map(cat => {
          const exts = extensionsByCategory[cat.id];
          if (!exts || exts.length === 0) return null;
          // Skip featured-only duplicates
          const nonFeatured = exts.filter(e => !e.featured);
          if (nonFeatured.length === 0) return null;

          return (
            <div key={cat.id} className="mb-6">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--nim-text-faint)] m-0 mb-3 pb-2 border-b border-[var(--nim-border)]">
                {cat.name}
              </h4>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                {nonFeatured.map(renderExtensionCard)}
              </div>
            </div>
          );
        })
      )}

      {/* No results */}
      {filteredExtensions.length === 0 && searchQuery && (
        <div className="p-8 text-center text-[var(--nim-text-faint)] text-[0.9375rem]">
          No extensions match "{searchQuery}"
        </div>
      )}

      {/* Install from GitHub URL */}
      <div className="mt-8 pt-6 border-t border-[var(--nim-border)]">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--nim-text-faint)] m-0 mb-3">
          Install from GitHub
        </h4>
        <div className="flex gap-2">
          <input
            type="text"
            value={githubUrl}
            onChange={(e) => setGithubUrl(e.target.value)}
            placeholder="https://github.com/user/nimbalyst-extension"
            className="flex-1 py-2.5 px-3 border border-[var(--nim-border)] rounded-lg bg-[var(--nim-bg)] text-[var(--nim-text)] text-sm outline-none focus:border-[var(--nim-primary)] placeholder:text-[var(--nim-text-faint)]"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleGithubInstall();
            }}
            data-testid="marketplace-github-url"
          />
          <button
            className="py-2.5 px-4 border-none rounded-lg bg-[var(--nim-primary)] text-white text-sm font-medium cursor-pointer transition-opacity duration-150 hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
            onClick={handleGithubInstall}
            disabled={githubInstalling || !githubUrl.trim()}
            data-testid="marketplace-github-install"
          >
            {githubInstalling ? 'Installing...' : 'Install'}
          </button>
        </div>
        <p className="text-xs text-[var(--nim-text-faint)] mt-2 m-0">
          Paste a GitHub repository URL containing a Nimbalyst extension (must have manifest.json).
        </p>
      </div>
    </div>
  );

  const renderExtensionDetails = () => {
    if (!selectedExtension) return null;

    const installed = isExtensionInstalled(selectedExtension.id);
    const update = getAvailableUpdate(selectedExtension.id);
    const status = installStatus[selectedExtension.id] || 'idle';

    return (
      <div
        className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000] p-4"
        onClick={() => setSelectedExtension(null)}
        data-testid="marketplace-details-overlay"
      >
        <div
          className="bg-[var(--nim-bg)] rounded-xl p-6 max-w-[500px] w-full max-h-[80vh] overflow-y-auto relative shadow-[0_20px_40px_rgba(0,0,0,0.3)]"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="absolute top-4 right-4 w-7 h-7 border-none rounded-full bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] text-base cursor-pointer flex items-center justify-center transition-all duration-150 hover:bg-[var(--nim-text-faint)] hover:text-[var(--nim-bg)]"
            onClick={() => setSelectedExtension(null)}
          >
            x
          </button>

          <div className="flex items-center gap-4 mb-4">
            <div className="w-12 h-12 rounded-[10px] bg-[var(--nim-bg-tertiary)] flex items-center justify-center shrink-0">
              <MaterialSymbol icon={CATEGORY_ICONS[selectedExtension.categories[0]] || 'extension'} size={24} />
            </div>
            <div>
              <h3 className="m-0 mb-1 text-lg font-semibold text-[var(--nim-text)]">{selectedExtension.name}</h3>
              <span className="text-[0.8125rem] text-[var(--nim-text-faint)]">by {selectedExtension.author}</span>
            </div>
          </div>

          {selectedExtension.tagline && (
            <p className="text-[0.9375rem] text-[var(--nim-text)] leading-relaxed m-0 mb-2 font-medium">
              {selectedExtension.tagline}
            </p>
          )}

          <p className="text-[0.875rem] text-[var(--nim-text-muted)] leading-relaxed m-0 mb-4">
            {selectedExtension.longDescription || selectedExtension.description}
          </p>

          {/* Highlights */}
          {selectedExtension.highlights && selectedExtension.highlights.length > 0 && (
            <ul className="m-0 mb-5 pl-5 flex flex-col gap-1.5">
              {selectedExtension.highlights.map((h, idx) => (
                <li key={idx} className="text-[0.8125rem] text-[var(--nim-text-muted)] leading-relaxed">{h}</li>
              ))}
            </ul>
          )}

          {/* Screenshots (theme-aware: use light variant when available) */}
          {selectedExtension.screenshots && selectedExtension.screenshots.length > 0 && (
            <div className="mb-5 flex flex-col gap-2">
              {selectedExtension.screenshots.map((ss, idx) => {
                const imgSrc = (theme === 'light' && ss.srcLight) ? ss.srcLight : ss.src;
                return (
                  <img
                    key={idx}
                    src={imgSrc}
                    alt={ss.alt}
                    className="w-full rounded-lg border border-[var(--nim-border)] object-cover max-h-[300px]"
                    loading="lazy"
                    data-testid={`marketplace-screenshot-${idx}`}
                  />
                );
              })}
            </div>
          )}

          {update && (
            <div className="flex items-center gap-2 mb-4 py-2 px-3 rounded-md bg-[rgba(96,165,250,0.1)] border border-[rgba(96,165,250,0.3)]">
              <MaterialSymbol icon="upgrade" size={18} className="text-[var(--nim-primary)]" />
              <span className="text-sm text-[var(--nim-text)]">
                Update available: v{update.currentVersion} &rarr; v{update.availableVersion}
              </span>
            </div>
          )}

          <div className="flex flex-col gap-2 mb-6 p-3 bg-[var(--nim-bg-secondary)] rounded-lg">
            <div className="flex items-center gap-2 text-[0.8125rem]">
              <span className="text-[var(--nim-text-faint)]">Version:</span>
              <span className="text-[var(--nim-text)] font-medium">
                {update ? `${update.currentVersion} (latest: ${update.availableVersion})` : selectedExtension.version}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[0.8125rem]">
              <span className="text-[var(--nim-text-faint)]">Category:</span>
              <span className="text-[var(--nim-text)] font-medium">
                {registry?.categories.find(c => c.id === selectedExtension.categories[0])?.name || selectedExtension.categories[0]}
              </span>
            </div>
            {selectedExtension.fileTypes && selectedExtension.fileTypes.length > 0 && (
              <div className="flex items-center gap-2 text-[0.8125rem]">
                <span className="text-[var(--nim-text-faint)]">File types:</span>
                <div className="flex gap-1">
                  {selectedExtension.fileTypes.map(ft => (
                    <span key={ft} className="inline-flex items-center px-2 py-0.5 rounded text-[0.6875rem] font-mono bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]">
                      {ft}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {selectedExtension.permissions.length > 0 && (
              <div className="flex items-center gap-2 text-[0.8125rem]">
                <span className="text-[var(--nim-text-faint)]">Permissions:</span>
                <div className="flex gap-1">
                  {selectedExtension.permissions.map(p => (
                    <span key={p} className="inline-flex items-center px-2 py-0.5 rounded text-[0.6875rem] bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]">
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {selectedExtension.downloads > 0 && (
              <div className="flex items-center gap-2 text-[0.8125rem]">
                <span className="text-[var(--nim-text-faint)]">Downloads:</span>
                <span className="text-[var(--nim-text)] font-medium">{selectedExtension.downloads.toLocaleString()}</span>
              </div>
            )}
            {selectedExtension.repositoryUrl && (
              <div className="flex items-center gap-2 text-[0.8125rem]">
                <span className="text-[var(--nim-text-faint)]">Repository:</span>
                <a
                  href="#"
                  className="text-[var(--nim-primary)] no-underline cursor-pointer hover:underline"
                  onClick={(e) => {
                    e.preventDefault();
                    window.electronAPI.openExternal(selectedExtension.repositoryUrl);
                  }}
                >
                  View on GitHub
                </a>
              </div>
            )}
          </div>

          {/* Changelog */}
          {selectedExtension.changelog && (
            <div className="mb-6">
              <h4 className="text-sm font-semibold text-[var(--nim-text)] mb-2">Changelog</h4>
              <pre className="text-xs text-[var(--nim-text-muted)] bg-[var(--nim-bg-secondary)] p-3 rounded-lg m-0 whitespace-pre-wrap font-[inherit]">
                {selectedExtension.changelog}
              </pre>
            </div>
          )}

          <div className="flex items-center gap-3">
            {update ? (
              <>
                <button
                  className={`flex-1 py-3 px-6 border-none rounded-md text-[0.9375rem] font-medium cursor-pointer transition-opacity duration-150 ${
                    status === 'installing'
                      ? 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]'
                      : 'bg-[var(--nim-primary)] text-white hover:opacity-90'
                  } disabled:opacity-60 disabled:cursor-not-allowed`}
                  onClick={() => handleUpdate(selectedExtension)}
                  disabled={status === 'installing'}
                >
                  {status === 'installing' ? 'Updating...' : `Update to v${update.availableVersion}`}
                </button>
                <button
                  className="py-1.5 px-3 border border-[var(--nim-error)] rounded bg-transparent text-[var(--nim-error)] text-xs font-medium cursor-pointer transition-all duration-150 hover:bg-[var(--nim-error)] hover:text-white"
                  onClick={() => {
                    handleUninstall(selectedExtension.id);
                    setSelectedExtension(null);
                  }}
                >
                  Uninstall
                </button>
              </>
            ) : installed ? (
              <>
                <span className={`inline-flex items-center py-1.5 px-3 rounded text-[0.8125rem] font-medium ${
                  isBuiltinExtension(selectedExtension.id)
                    ? 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]'
                    : 'bg-[rgba(39,174,96,0.15)] text-[#27ae60]'
                }`}>
                  {isBuiltinExtension(selectedExtension.id) ? 'Built-in' : 'Installed'}
                </span>
                {!isBuiltinExtension(selectedExtension.id) && (
                  <button
                    className="py-1.5 px-3 border border-[var(--nim-error)] rounded bg-transparent text-[var(--nim-error)] text-xs font-medium cursor-pointer transition-all duration-150 hover:bg-[var(--nim-error)] hover:text-white"
                    onClick={() => {
                      handleUninstall(selectedExtension.id);
                      setSelectedExtension(null);
                    }}
                  >
                    Uninstall
                  </button>
                )}
              </>
            ) : (
              <button
                className={`flex-1 py-3 px-6 border-none rounded-md text-[0.9375rem] font-medium cursor-pointer transition-opacity duration-150 ${
                  status === 'installing'
                    ? 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]'
                    : 'bg-[var(--nim-primary)] text-white hover:opacity-90'
                } disabled:opacity-60 disabled:cursor-not-allowed`}
                onClick={() => handleInstall(selectedExtension)}
                disabled={status === 'installing'}
              >
                {status === 'installing' ? 'Installing...' : 'Install Extension'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  const devExtensionCount = allInstalledExtensions.filter(
    e => !e.isBuiltin && !installedExtensions[e.id]
  ).length;
  const installedCount = Object.keys(installedExtensions).length + devExtensionCount;
  const updateCount = Object.keys(availableUpdates).length;

  return (
    <div className="provider-panel flex flex-col" data-testid="extension-marketplace-panel">
      <div className="mb-4 pb-4 border-b border-[var(--nim-border)] flex items-start justify-between gap-4">
        <div>
          <h3 className="text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">Extension Marketplace</h3>
          <p className="text-sm leading-relaxed text-[var(--nim-text-muted)]">
            Discover and install extensions to enhance your Nimbalyst workspace.
          </p>
        </div>
        {onViewInstalled && (
          <button
            className="shrink-0 inline-flex items-center gap-1.5 py-2 px-3 border border-[var(--nim-border)] rounded-md bg-transparent text-[var(--nim-text-muted)] text-xs font-medium cursor-pointer transition-all duration-150 hover:border-[var(--nim-text-muted)] hover:text-[var(--nim-text)]"
            onClick={onViewInstalled}
            data-testid="marketplace-view-installed"
          >
            <MaterialSymbol icon="extension" size={16} />
            Installed ({installedCount}){updateCount > 0 && ` • ${updateCount} update${updateCount > 1 ? 's' : ''}`}
          </button>
        )}
      </div>

      {/* Status Message */}
      {statusMessage && (
        <div className="mb-4 py-2 px-3 rounded-md bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] text-sm">
          {statusMessage}
        </div>
      )}

      {renderDiscover()}
      {renderExtensionDetails()}
    </div>
  );
}
