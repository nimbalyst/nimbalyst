/**
 * Runtime Settings Context for Nimbalyst
 * 
 * This context manages settings that can be changed at runtime without
 * requiring a full component re-render. These are typically UI toggles
 * that don't affect the core editor configuration.
 */

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export interface RuntimeSettings {
  showTreeView: boolean;
  isMarkdownMode: boolean;
}

interface RuntimeSettingsContextType {
  settings: RuntimeSettings;
  setSetting: <K extends keyof RuntimeSettings>(key: K, value: RuntimeSettings[K]) => void;
  toggleSetting: (key: keyof RuntimeSettings) => void;
}

const defaultSettings: RuntimeSettings = {
  showTreeView: false,
  isMarkdownMode: false,
};

const RuntimeSettingsContext = createContext<RuntimeSettingsContextType | undefined>(undefined);

export function RuntimeSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<RuntimeSettings>(defaultSettings);

  const setSetting = useCallback(<K extends keyof RuntimeSettings>(
    key: K,
    value: RuntimeSettings[K]
  ) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  const toggleSetting = useCallback((key: keyof RuntimeSettings) => {
    setSettings(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  return (
    <RuntimeSettingsContext.Provider value={{ settings, setSetting, toggleSetting }}>
      {children}
    </RuntimeSettingsContext.Provider>
  );
}

export function useRuntimeSettings() {
  const context = useContext(RuntimeSettingsContext);
  if (!context) {
    throw new Error('useRuntimeSettings must be used within RuntimeSettingsProvider');
  }
  return context;
}