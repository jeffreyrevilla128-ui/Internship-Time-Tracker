import React, { useState, useEffect, useRef } from 'react';

import Sidebar from './Sidebar';
import MetricHeader from './MetricHeader';
import AttendanceCalendar from './AttendanceCalendar';
import PunchCard from './PunchCard';
import DiaryForm from './DiaryForm';
import HistoryLogs from './HistoryLogs';
import { fetchLogs, fetchDay } from '../services/attendanceapi';
import { fetchInternshipConfig, saveInternshipConfig } from '../services/internshipconfigapi';

// --- Shared time-math helper -------------------------------------------
function calculateHoursAndMinutes(amIn, amOut, pmIn, pmOut) {
  let totalMinutes = 0;
  const baseDate = "2026-01-01 ";

  if (amIn && amOut) {
    const diffMs = new Date(baseDate + amOut) - new Date(baseDate + amIn);
    if (diffMs > 0) totalMinutes += Math.floor(diffMs / (1000 * 60));
  }
  if (pmIn && pmOut) {
    const diffMs = new Date(baseDate + pmOut) - new Date(baseDate + pmIn);
    if (diffMs > 0) totalMinutes += Math.floor(diffMs / (1000 * 60));
  }

  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
    decimalHours: totalMinutes / 60,
  };
}

const EMPTY_SHIFT = {
  amIn: '',
  amOut: '',
  pmIn: '',
  pmOut: '',
  diaryEntries: [],
  isCompleted: false,
};

// Key used to persist the user's theme choice across sessions.
const THEME_STORAGE_KEY = 'ojt-dashboard-theme';

// Key used to persist which sidebar tab was active, so a page refresh
// restores the user's place instead of always bouncing back to the
// dashboard overview.
const TAB_STORAGE_KEY = 'ojt-dashboard-active-tab';
const VALID_TABS = ['dashboard', 'punch', 'diary', 'history'];

// Kept in sync with Sidebar.jsx's own LOCKED_TABS — everything except the
// overview requires Required Hours + Start Date to already be configured.
const LOCKED_TABS = ['punch', 'diary', 'history'];

// `onLogout` is optional so this component still renders standalone
// (e.g. in isolation or storybook-style previews) without a parent
// wiring up auth. When it's not provided, clicking "Log Out" simply
// closes the menu — see handleLogout below.
export default function OJTDashboard({ user, onLogout }) {
  // --- Layout & Config State ---------------------------------------------
  // Read any previously saved tab on first render, same pattern as theme
  // below. The whitelist guard means a stale/corrupted stored value (or a
  // tab name that no longer exists after a future refactor) safely falls
  // back to 'dashboard' instead of rendering a blank/broken panel.
  const [activeTab, setActiveTab] = useState(() => {
    try {
      const saved = localStorage.getItem(TAB_STORAGE_KEY);
      return VALID_TABS.includes(saved) ? saved : 'dashboard';
    } catch {
      return 'dashboard';
    }
  });
  const [estimatedHours, setEstimatedHours] = useState(0);
  const [startDate, setStartDate] = useState('');
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [configError, setConfigError] = useState(null);
  // Tracks whether fetchInternshipConfig() has resolved (success or failure)
  // at least once. Before it settles, estimatedHours/startDate are just
  // placeholder defaults (0 / ''), so isConfigComplete is necessarily false
  // for reasons that have nothing to do with the person's actual saved
  // config. The tab-guard effect below needs this to tell "still loading"
  // apart from "loaded and genuinely incomplete" — otherwise it fires on
  // every refresh, during the split second before the fetch resolves, and
  // bounces a restored locked tab back to 'dashboard' before the real
  // config value ever gets a chance to confirm it shouldn't.
  const [isConfigLoaded, setIsConfigLoaded] = useState(false);

  // Same validation MetricHeader uses to gate its own inline edit and Save
  // button — computed once here too, since Sidebar needs it to decide
  // which tabs are locked, and the tab guard below needs it to prevent
  // landing on a locked tab any other way (e.g. a stale saved tab from
  // before the person's config was ever reset).
  const isConfigComplete =
    Number.isInteger(estimatedHours) &&
    estimatedHours > 0 &&
    !!startDate &&
    !Number.isNaN(new Date(startDate).getTime());

  // If the current tab is one of the locked ones and config is genuinely
  // incomplete, fall back to the dashboard tab instead of rendering a tab
  // the sidebar itself disables. Gated on isConfigLoaded so this doesn't
  // fire during the initial fetch — before the config resolves,
  // isConfigComplete is false purely because the real values haven't
  // arrived yet, not because the person's config is actually incomplete.
  // Firing here would overwrite a validly-restored locked tab (from
  // TAB_STORAGE_KEY) before it ever gets a fair check.
  useEffect(() => {
    if (isConfigLoaded && !isConfigComplete && LOCKED_TABS.includes(activeTab)) {
      setActiveTab('dashboard');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfigLoaded, isConfigComplete]);

  // Fetches the saved required-hours/start-date on mount — without this,
  // MetricHeader's Update modal only ever wrote to local state, so every
  // refresh silently reset both values back to 0 / ''.
  useEffect(() => {
    let cancelled = false;

    fetchInternshipConfig()
      .then((config) => {
        if (cancelled) return;
        setEstimatedHours(config.estimatedHours);
        setStartDate(config.startDate);
      })
      .catch((err) => {
        if (!cancelled) setConfigError(err.message || 'Failed to load internship configuration.');
      })
      .finally(() => {
        // Runs on both success and failure — a failed fetch still means
        // "loading is done", and the guard effect above needs to know that
        // so it can correctly redirect away from a locked tab when the
        // config genuinely couldn't be loaded (rather than staying stuck
        // waiting forever, or worse, redirecting prematurely).
        if (!cancelled) setIsConfigLoaded(true);
      });

    return () => { cancelled = true; };
  }, []);

  // Passed to MetricHeader in place of the raw setters — persists to the
  // backend first, then updates local state only on success, so a failed
  // save doesn't leave the UI showing a value that was never actually
  // saved.
  const handleSaveConfig = async ({ estimatedHours: nextHours, startDate: nextStartDate }) => {
    setIsSavingConfig(true);
    setConfigError(null);
    try {
      const saved = await saveInternshipConfig({
        estimatedHours: nextHours,
        startDate: nextStartDate,
      });
      setEstimatedHours(saved.estimatedHours);
      setStartDate(saved.startDate);
    } catch (err) {
      setConfigError(err.message || 'Failed to save internship configuration.');
      throw err; // lets MetricHeader know the save failed, so it can keep its modal open
    } finally {
      setIsSavingConfig(false);
    }
  };

  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, activeTab);
    } catch {
      // Storage can fail (private browsing, quota, etc.) — the tab still
      // works for the current session even if it won't survive a reload.
    }
  }, [activeTab]);

  // Fallback covers the case where OJTDashboard is rendered without a user
  // prop (e.g. in isolation/storybook-style previews, same reasoning as
  // onLogout being optional below).
  const displayName = user?.username || 'Guest';
  const avatarInitial = displayName.charAt(0).toUpperCase();

  // --- Theme (Light/Dark) --------------------------------------------------
  // Read any previously saved preference on first render; default to light
  // if nothing's been saved yet (e.g. first-ever visit, or storage blocked).
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      return saved === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage can fail (private browsing, quota, etc.) — theme still
      // applies for the current session even if it can't be persisted.
    }
  }, [theme]);

  // Also mirror the theme onto <html>, not just .dashboard-shell below.
  // .dashboard-shell's own data-theme attribute (set in the JSX further
  // down) is what MetricHeader.css's dark overrides currently key off of,
  // so it stays. This one exists so anything living *outside* the shell —
  // index.css's html/body base reset, or any future UI portaled straight
  // into document.body (toasts, tooltips, etc.) — has something to read
  // too, since CSS custom properties can't cascade upward from a sibling.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  };

  // --- Profile settings dropdown -------------------------------------------
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef(null);

  useEffect(() => {
    if (!isProfileMenuOpen) return;

    const handleOutsideClick = (event) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target)) {
        setIsProfileMenuOpen(false);
      }
    };
    const handleEscape = (event) => {
      if (event.key === 'Escape') setIsProfileMenuOpen(false);
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isProfileMenuOpen]);

  // Closes the menu first, then hands off to whatever the parent wants to
  // do (clear session, redirect to /login, etc.) — kept decoupled from
  // any specific auth implementation.
  const handleLogout = () => {
    setIsProfileMenuOpen(false);
    try {
      localStorage.removeItem(TAB_STORAGE_KEY);
    } catch {
      // Nothing to do if storage isn't available.
    }
    if (typeof onLogout === 'function') {
      onLogout();
    }
  };

  // --- Header logo click "spin" animation -----------------------------
  // Mirrors the identical interaction on AuthPage's brand logo (see
  // AuthPage.jsx / AuthPage.css) so the mark behaves the same way
  // wherever it appears. Toggling via ref + classList (rather than React
  // state) means a click mid-animation restarts it immediately: remove
  // the class, force a reflow, then re-add it — no queued/overlapping
  // animations, no jitter.
  const logoIconRef = useRef(null);

  const spinLogo = (ref) => {
    const el = ref.current;
    if (!el) return;
    el.classList.remove('dashboard-logo-spin');
    // eslint-disable-next-line no-void
    void el.offsetWidth; // force reflow so the animation restarts from 0%
    el.classList.add('dashboard-logo-spin');
  };

  const handleLogoKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      spinLogo(logoIconRef);
    }
  };

  const clearLogoSpin = (e) => {
    e.currentTarget.classList.remove('dashboard-logo-spin');
  };

  // --- Today's shift, shared by PunchCard + DiaryForm ---------------------
  const [shiftState, setShiftState] = useState(EMPTY_SHIFT);

  // --- Attendance history, single source of truth for HistoryLogs AND the
  // dashboard's grand-total/calendar calculations. Starts empty and is
  // populated from the backend on mount below — no mock data, so a user
  // with zero completed days correctly sees 0 everywhere immediately,
  // instead of a stale placeholder until they happen to visit History.
  const [logs, setLogs] = useState([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState(true);
  const [logsError, setLogsError] = useState(null);

  // Fetches completed history + today's in-progress punches (if any) as
  // soon as the dashboard mounts — i.e. right after login — rather than
  // waiting for the person to happen to open the History tab first.
  useEffect(() => {
    let cancelled = false;
    const todayKey = new Date().toISOString().split('T')[0];

    setIsLoadingLogs(true);
    setLogsError(null);

    Promise.all([fetchLogs(), fetchDay(todayKey)])
      .then(([fetchedLogs, todayRow]) => {
        if (cancelled) return;
        setLogs(fetchedLogs);

        // DiaryForm renders a multi-date history from shiftState.diaryEntries,
        // but fetchDay only ever returns *today's* entry. Backfill every past
        // completed day that actually has diary text, so DiaryForm's list
        // reflects real daily_diaries rows, not just today.
        const historicalDiaryEntries = fetchedLogs
          .filter(log => log.diaryText && log.diaryText.trim())
          .map(log => ({
            id: log.id,
            date: log.date,
            text: log.diaryText,
            timestamp: log.submittedAt,
          }));

        // Only seed shiftState if today's row exists and isn't already
        // completed — a completed "today" belongs in `logs`, not as an
        // active in-progress shift.
        if (todayRow && !todayRow.isCompleted) {
          setShiftState(prev => ({
            ...prev,
            ...todayRow,
            diaryEntries: [...historicalDiaryEntries, ...(todayRow.diaryEntries || [])],
          }));
        } else {
          setShiftState(prev => ({ ...prev, diaryEntries: historicalDiaryEntries }));
        }
      })
      .catch((err) => {
        if (!cancelled) setLogsError(err.message || 'Failed to load attendance data.');
      })
      .finally(() => {
        if (!cancelled) setIsLoadingLogs(false);
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keeps DiaryForm's entry list in sync with `logs` — not just on initial
  // mount, but every time `logs` changes (e.g. after PunchCard's diary
  // save, or HistoryLogs' Add/Update/Delete Attendance History actions,
  // all of which share this same `logs` state). Without this, the mount
  // effect above only ever ran once, so any diary change made afterward
  // never reached shiftState.diaryEntries until a full page refresh.
  //
  // Today's own in-progress diary entry is preserved rather than
  // overwritten, since `logs` only contains COMPLETED days — an
  // unfinished today never appears there until it's marked complete.
  useEffect(() => {
    const historicalDiaryEntries = logs
      .filter(log => log.diaryText && log.diaryText.trim())
      .map(log => ({
        id: log.id,
        date: log.date,
        text: log.diaryText,
        timestamp: log.submittedAt,
      }));

    const historicalDates = new Set(historicalDiaryEntries.map(e => e.date));

    setShiftState(prev => {
      const preservedLocalEntries = (prev.diaryEntries || []).filter(
        e => !historicalDates.has(e.date)
      );
      const nextEntries = [...historicalDiaryEntries, ...preservedLocalEntries];

      // Avoid an unnecessary re-render when nothing actually changed —
      // shallow-compare by length + stringified content is cheap enough
      // for a list this size and prevents this effect from looping with
      // any other effect that also touches shiftState.
      const prevKey = JSON.stringify(prev.diaryEntries || []);
      const nextKey = JSON.stringify(nextEntries);
      if (prevKey === nextKey) return prev;

      return { ...prev, diaryEntries: nextEntries };
    });
  }, [logs]);

  // --- Today's worked hours (live, before submission) ----------------------
  const todayTotals = calculateHoursAndMinutes(
    shiftState.amIn, shiftState.amOut, shiftState.pmIn, shiftState.pmOut
  );
  const hoursWorkedToday = todayTotals.decimalHours.toFixed(1);

  // --- Grand total across all logged days, plus today's live progress -----
  const loggedHoursTotal = logs.reduce(
    (sum, log) => sum + log.hours + log.minutes / 60,
    0
  );
  const grandTotalHours = shiftState.isCompleted
    ? loggedHoursTotal
    : loggedHoursTotal + todayTotals.decimalHours;

  // --- When PunchCard marks the shift complete, turn it into a log row ----
  useEffect(() => {
    if (!shiftState.isCompleted) return;

    const currentLogDate = shiftState.date || new Date().toISOString().split('T')[0];
    const logDateObj = new Date(currentLogDate);
    const dayName = logDateObj.toLocaleDateString('en-US', { weekday: 'long' });
    const timestamp = `${currentLogDate} ${new Date().toTimeString().split(' ')[0].substring(0, 5)}`;
    
    const { hours, minutes } = calculateHoursAndMinutes(
      shiftState.amIn, shiftState.amOut, shiftState.pmIn, shiftState.pmOut
    );

    // shiftState carries diary content as `diaryEntries` (an array, since a
    // reopened past log can theoretically span a different date than
    // today) — never as a flat `diary` string. Pull out just today's text.
    const diaryText = (shiftState.diaryEntries || []).find(
      entry => entry.date === currentLogDate
    )?.text || '';

    setLogs(prevLogs => {
      const alreadyLogged = prevLogs.some(log => log.date === currentLogDate);
      if (alreadyLogged) return prevLogs;

      const newLog = {
        id: shiftState.id || Date.now(),
        date: currentLogDate,
        day: dayName,
        amIn: shiftState.amIn,
        amOut: shiftState.amOut,
        pmIn: shiftState.pmIn,
        pmOut: shiftState.pmOut,
        hours,
        minutes,
        diaryText,
        submittedAt: timestamp,
      };

      return [newLog, ...prevLogs].sort((a, b) => new Date(b.date) - new Date(a.date));
    });

    // Deliberately no shiftState reset and no tab switch here: the person
    // stays on Punch Card after a successful save, with the completed
    // day's Time In/Out still visible and the "✓ Day Logs Saved" state on
    // the button. PunchCard's own local toast (fired from saveDayLogs /
    // saveTimeOut once their save actually resolves) is what confirms the
    // save — it can be trusted to render now because PunchCard is no
    // longer unmounted out from under it.
  }, [shiftState.isCompleted]);

  // --- Handle editing existing log element structures ---------------------
  const handleEditLog = (logId) => {
    const targetLog = logs.find(log => log.id === logId);
    if (!targetLog) return;

    setShiftState({
      id: targetLog.id,
      date: targetLog.date,
      amIn: targetLog.amIn,
      amOut: targetLog.amOut,
      pmIn: targetLog.pmIn,
      pmOut: targetLog.pmOut,
      diaryEntries: targetLog.diaryText
        ? [{ id: targetLog.id, date: targetLog.date, text: targetLog.diaryText, timestamp: targetLog.submittedAt }]
        : [],
      isCompleted: false,
    });

    setLogs(prevLogs => prevLogs.filter(log => log.id !== logId));
    setActiveTab('punch');
  };

  const renderActiveTab = () => {
    switch (activeTab) {
      case 'punch':
        return (
          <PunchCard
            shiftState={shiftState}
            setShiftState={setShiftState}
            hoursWorkedToday={hoursWorkedToday}
          />
        );
      case 'diary':
        return (
          <DiaryForm
            shiftState={shiftState}
            setShiftState={setShiftState}
            logs={logs}
          />
        );
      case 'history':
        return (
          <HistoryLogs
            logs={logs}
            setLogs={setLogs}
            onEditLog={handleEditLog}
            startDate={startDate}
          />
        );
      case 'dashboard':
      default:
        return (
          <>
            <MetricHeader
              estimatedHours={estimatedHours}
              setEstimatedHours={setEstimatedHours}
              grandTotalHours={grandTotalHours}
              startDate={startDate}
              setStartDate={setStartDate}
              onSave={handleSaveConfig}
              isSaving={isSavingConfig}
            />
            <AttendanceCalendar shiftState={shiftState} logs={logs} isConfigComplete={isConfigComplete} startDate={startDate} />
          </>
        );
    }
  };

  return (
    // data-theme drives every dark-mode override in the stylesheet — see
    // the `[data-theme="dark"]` token block in OJTDashboard.css. Any
    // component whose CSS reads the --color-* custom properties defined on
    // .dashboard-shell picks up theme changes automatically; components
    // with their own hardcoded colors (like MetricHeader's badges) need an
    // explicit dark-mode override block of their own.
    <div className="dashboard-shell" data-theme={theme}>
      {/* Full-width top header bar with branding and responsive right-side profile */}
      <header className="app-topbar">
        <h1 className="dashboard-header-title">
          {/* Same clock-glyph mark + spin-on-click interaction as the
              brand panel on AuthPage (.auth-brand-logo-icon), so the
              logo is visually and behaviorally consistent across both
              screens. */}
          <span
            className="dashboard-header-logo-icon"
            ref={logoIconRef}
            role="button"
            tabIndex={0}
            aria-label="OJT Tracker logo"
            onClick={() => spinLogo(logoIconRef)}
            onKeyDown={handleLogoKeyDown}
            onAnimationEnd={clearLogoSpin}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
              <path d="M12 7v5.2l3.4 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span>OJT TRACKER</span>
        </h1>
        
        {/* Integrated User Profile Summary + Settings Dropdown */}
        <div className="header-profile-wrapper" ref={profileMenuRef}>
          <button
            type="button"
            className="profile-avatar"
            onClick={() => setIsProfileMenuOpen(open => !open)}
            aria-haspopup="menu"
            aria-expanded={isProfileMenuOpen}
            aria-label="Open profile settings menu"
          >
            {avatarInitial}
            {/* Small chevron badge in the corner signals the avatar itself
                is a dropdown trigger (theme + logout), not just a static
                profile picture. Flips to point up while the menu is open. */}
            <span
              className={`profile-avatar-caret${isProfileMenuOpen ? ' profile-avatar-caret-open' : ''}`}
              aria-hidden="true"
            >
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </button>

          {isProfileMenuOpen && (
            <div className="profile-menu" role="menu">
              <div className="profile-menu-header">
                <span className="profile-menu-name">{displayName}</span>
                <span className="profile-menu-role">{user?.role === 'admin' ? 'Admin' : 'Intern'}</span>
              </div>

              <div className="profile-menu-divider" role="separator" />

              <div className="profile-menu-item">
                <span id="dark-mode-label">Theme</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={theme === 'dark'}
                  aria-labelledby="dark-mode-label"
                  className={`theme-switch${theme === 'dark' ? ' theme-switch-on' : ''}`}
                  onClick={toggleTheme}
                >
                  <span className="theme-switch-knob">
                    <span className="theme-switch-icon theme-switch-icon-sun" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <circle cx="12" cy="12" r="4.5" fill="currentColor" />
                        <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="12" y1="1.5" x2="12" y2="3.5" />
                          <line x1="12" y1="20.5" x2="12" y2="22.5" />
                          <line x1="4.4" y1="4.4" x2="5.8" y2="5.8" />
                          <line x1="18.2" y1="18.2" x2="19.6" y2="19.6" />
                          <line x1="1.5" y1="12" x2="3.5" y2="12" />
                          <line x1="20.5" y1="12" x2="22.5" y2="12" />
                          <line x1="4.4" y1="19.6" x2="5.8" y2="18.2" />
                          <line x1="18.2" y1="5.8" x2="19.6" y2="4.4" />
                        </g>
                      </svg>
                    </span>
                    <span className="theme-switch-icon theme-switch-icon-moon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path
                          d="M20.5 13.4A8.5 8.5 0 1 1 10.6 3.5a7 7 0 0 0 9.9 9.9Z"
                          fill="currentColor"
                        />
                      </svg>
                    </span>
                  </span>
                </button>
              </div>

              <div className="profile-menu-divider" role="separator" />

              {/* Sits directly below the theme toggle so account-level
                  actions read as a distinct, final group in the menu. */}
              <button
                type="button"
                role="menuitem"
                className="profile-menu-logout-btn"
                onClick={handleLogout}
              >
                <span className="profile-menu-logout-icon" aria-hidden="true">🚪</span>
                <span>Log Out</span>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Navigational Component */}
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} isConfigComplete={isConfigComplete} />

      {/* Main Container Content */}
      <main className="dashboard-main-content">
        <div className="dashboard-tab-panel">
          {renderActiveTab()}
        </div>
      </main>
    </div>
  );
}