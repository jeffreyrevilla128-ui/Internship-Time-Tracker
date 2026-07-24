import React from 'react';

// Tabs that require Required Hours + Start Date to already be configured —
// everything except the overview itself, since that's where the setup
// banner (in MetricHeader) lives and gives the person a way in.
const LOCKED_TABS = ['punch', 'diary', 'history'];

export default function Sidebar({ activeTab, setActiveTab, isConfigComplete }) {
  const handleNavClick = (tab) => {
    if (LOCKED_TABS.includes(tab) && !isConfigComplete) return;
    setActiveTab(tab);
  };

  const lockedTitle = 'Complete your Required Hours and Start Date setup first';

  return (
    <aside className="dashboard-sidebar">
      <div className="sidebar-menu-wrapper">
        {/* Navigation Layer Container */}
        <nav className="sidebar-nav-container">
          <button 
            onClick={() => handleNavClick('dashboard')}
            className={`nav-link ${activeTab === 'dashboard' ? 'nav-link-active' : 'nav-link-inactive'}`}
            title="Main Overview"
          >
            <span className="nav-icon">📊</span>
            <span className="link-text">Main Overview</span>
          </button>
          <button 
            onClick={() => handleNavClick('punch')}
            className={`nav-link ${activeTab === 'punch' ? 'nav-link-active' : 'nav-link-inactive'}${!isConfigComplete ? ' nav-link-disabled' : ''}`}
            title={isConfigComplete ? 'Time In / Out' : lockedTitle}
            aria-disabled={!isConfigComplete}
          >
            <span className="nav-icon">{isConfigComplete ? '🕒' : '🔒'}</span>
            <span className="link-text">Time In / Out</span>
          </button>
          <button 
            onClick={() => handleNavClick('diary')}
            className={`nav-link ${activeTab === 'diary' ? 'nav-link-active' : 'nav-link-inactive'}${!isConfigComplete ? ' nav-link-disabled' : ''}`}
            title={isConfigComplete ? 'Narrative Diary' : lockedTitle}
            aria-disabled={!isConfigComplete}
          >
            <span className="nav-icon">{isConfigComplete ? '📝' : '🔒'}</span>
            <span className="link-text">Narrative Diary</span>
          </button>
          <button 
            onClick={() => handleNavClick('history')}
            className={`nav-link ${activeTab === 'history' ? 'nav-link-active' : 'nav-link-inactive'}${!isConfigComplete ? ' nav-link-disabled' : ''}`}
            title={isConfigComplete ? 'Attendance History' : lockedTitle}
            aria-disabled={!isConfigComplete}
          >
            <span className="nav-icon">{isConfigComplete ? '📋' : '🔒'}</span>
            <span className="link-text">Attendance History</span>
          </button>
        </nav>
      </div>
    </aside>
  );
}