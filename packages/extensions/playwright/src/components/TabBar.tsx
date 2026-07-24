export type TabId = 'tests' | 'traces' | 'history';

interface Tab {
  id: TabId;
  label: string;
  icon: string;
  badge?: number;
}

interface TabBarProps {
  tabs: Tab[];
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export function TabBar({ tabs, activeTab, onTabChange }: TabBarProps) {
  return (
    <div className="pw-tab-bar">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`pw-tab ${activeTab === tab.id ? 'pw-tab-active' : ''}`}
          onClick={() => onTabChange(tab.id)}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
            {tab.icon}
          </span>
          <span>{tab.label}</span>
          {tab.badge != null && tab.badge > 0 && (
            <span className="pw-tab-badge">{tab.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}
