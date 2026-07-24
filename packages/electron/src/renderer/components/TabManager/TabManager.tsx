import React from 'react';
import { TabBar } from './TabBar';
import { useTabs } from '../../contexts/TabsContext';

export interface Tab {
  id: string;
  filePath: string;
  fileName: string;
  content: string;
  isDirty: boolean;
  isPinned: boolean;
  lastSaved?: Date;
  isVirtual?: boolean;
  isProcessing?: boolean; // Session is actively processing AI response
  hasUnread?: boolean; // Session has unread AI response
  kind?: 'file' | 'tracker'; // Resource kind; 'tracker' tabs render a tracker item
  trackerItemId?: string; // For tracker tabs: the tracker item id
  // NOTE: hasUnacceptedChanges removed - now subscribed via Jotai atom in TabDirtyIndicator
}

interface TabManagerProps {
  // NOTE: tabs, activeTabId, onTabSelect, onTogglePin, onTabReorder removed - now comes from useTabs() context
  onTabClose: (tabId: string) => void;
  onNewTab: () => void;
  hideTabBar?: boolean;
  isActive?: boolean; // Whether this TabManager's keyboard shortcuts should be active
  onToggleAIChat?: () => void; // Toggle AI Chat panel
  isAIChatCollapsed?: boolean; // Whether AI Chat is collapsed
  onTabDoubleClick?: (tabId: string) => void; // Double-click a tab (e.g. maximize editor)
  children: React.ReactNode;
}

export const TabManager: React.FC<TabManagerProps> = ({
  onTabClose,
  onNewTab,
  hideTabBar = false,
  isActive = true,
  onToggleAIChat,
  isAIChatCollapsed,
  onTabDoubleClick,
  children
}) => {
  // if (import.meta.env.DEV) console.log('[TabManager] render');
  // Get tabs from context - this component subscribes to tab changes
  // NOTE: hasPendingDiffs polling removed - dirty/pending state now via Jotai atoms per-tab
  const { tabs, activeTabId, switchTab, togglePin, reorderTabs } = useTabs();

  return (
    <div className="tab-manager flex flex-col h-full w-full">
      {!hideTabBar && tabs.length > 0 && (
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onTabSelect={switchTab}
          onTabClose={onTabClose}
          onNewTab={onNewTab}
          onTogglePin={togglePin}
          onTabReorder={reorderTabs}
          isActive={isActive}
          onToggleAIChat={onToggleAIChat}
          isAIChatCollapsed={isAIChatCollapsed}
          onTabDoubleClick={onTabDoubleClick}
        />
      )}
      <div className="tab-content flex-1 overflow-hidden relative">
        {children}
      </div>
    </div>
  );
};
