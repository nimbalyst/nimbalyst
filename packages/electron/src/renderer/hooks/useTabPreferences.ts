import { useState, useEffect, useCallback } from 'react';

export interface TabPreferences {
  enabled: boolean;
  maxTabs: number;
  showPinButton: boolean;
  warnOnClose: boolean;
  restoreTabs: boolean;
  tabPosition: 'top' | 'bottom';
}

const DEFAULT_PREFERENCES: TabPreferences = {
  enabled: true, // Feature flag - enabled for testing
  maxTabs: 100, // High default - EditorPool manages memory with sleep state (max 20 rendered)
  showPinButton: true,
  warnOnClose: true,
  restoreTabs: true,
  tabPosition: 'top'
};

const STORAGE_KEY = 'tabPreferences';

export function useTabPreferences() {
  const [preferences, setPreferences] = useState<TabPreferences>(DEFAULT_PREFERENCES);

  // Load preferences from localStorage on mount
  useEffect(() => {
    const loadPreferences = () => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          setPreferences({ ...DEFAULT_PREFERENCES, ...parsed });
        }
      } catch (error) {
        console.error('Failed to load tab preferences:', error);
      }
    };

    loadPreferences();

    // Also listen for storage events (changes from other windows)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          setPreferences({ ...DEFAULT_PREFERENCES, ...parsed });
        } catch (error) {
          console.error('Failed to parse tab preferences from storage event:', error);
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Save preferences to localStorage
  const savePreferences = useCallback((newPreferences: Partial<TabPreferences>) => {
    const updated = { ...preferences, ...newPreferences };
    setPreferences(updated);
    
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch (error) {
      console.error('Failed to save tab preferences:', error);
    }
  }, [preferences]);

  // Toggle tabs enabled/disabled
  const toggleTabs = useCallback(() => {
    savePreferences({ enabled: !preferences.enabled });
  }, [preferences.enabled, savePreferences]);

  // Update max tabs
  const setMaxTabs = useCallback((maxTabs: number) => {
    if (maxTabs >= 1 && maxTabs <= 1000) {
      savePreferences({ maxTabs });
    }
  }, [savePreferences]);

  // Reset to defaults
  const resetToDefaults = useCallback(() => {
    setPreferences(DEFAULT_PREFERENCES);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_PREFERENCES));
    } catch (error) {
      console.error('Failed to reset tab preferences:', error);
    }
  }, []);

  return {
    preferences,
    savePreferences,
    toggleTabs,
    setMaxTabs,
    resetToDefaults
  };
}