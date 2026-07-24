import React, { useState, useEffect, useRef } from 'react';
import { saveDay, saveDiaryOnly, fetchDay } from '../services/attendanceapi';

// Formats a raw Date object into a readable 12-hour string (e.g., "08:30 AM")
const formatTo12Hour = (date) => {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
};

// Parses a 12-hour string back into fractional hours for dynamic duration calculations
const calculateDuration12H = (inTime, outTime) => {
  if (!inTime || !outTime) return 0;

  const parseToMinutes = (timeStr) => {
    const match = timeStr.match(/^(\d+):(\d+)\s*(AM|PM)$/i);
    if (!match) return 0;

    let [_, hours, minutes, modifier] = match;
    hours = Number(hours);
    minutes = Number(minutes);

    if (modifier.toUpperCase() === 'PM' && hours !== 12) {
      hours += 12;
    }
    if (modifier.toUpperCase() === 'AM' && hours === 12) {
      hours = 0;
    }

    return hours * 60 + minutes;
  };

  const diffInMinutes = parseToMinutes(outTime) - parseToMinutes(inTime);
  return diffInMinutes > 0 ? diffInMinutes / 60 : 0;
};

// --- Conversions between stored "hh:mm AM/PM" strings and <input type="time"> "HH:MM" values ---

const to24HourInputValue = (time12h) => {
  if (!time12h) return '';
  const match = time12h.match(/^(\d+):(\d+)\s*(AM|PM)$/i);
  if (!match) return '';
  let [, hours, minutes, modifier] = match;
  hours = Number(hours);
  if (modifier.toUpperCase() === 'PM' && hours !== 12) hours += 12;
  if (modifier.toUpperCase() === 'AM' && hours === 12) hours = 0;
  return `${String(hours).padStart(2, '0')}:${minutes}`;
};

const from24HourInputValue = (value) => {
  if (!value) return '';
  const [hStr, mStr] = value.split(':');
  let hours = Number(hStr);
  const modifier = hours >= 12 ? 'PM' : 'AM';
  let hours12 = hours % 12;
  if (hours12 === 0) hours12 = 12;
  return `${hours12}:${mStr} ${modifier}`;
};

const currentTimeInputValue = () => {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
};

// --- Shared with the "Daily Diary" quick-entry modal ---
const DIARY_WORD_LIMIT = 1000;

const countWords = (text) => {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
};

// Local calendar-day key (not UTC) so "today" matches what the user sees on their clock.
const getDateKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// The diary "business date" for the currently active shiftState: its own .date if one was
// set (e.g. re-opened from History Logs for a past day), otherwise today.
const getShiftDateKey = (state) => state.date || getDateKey(new Date());

// Creates a blank diary entry for dateKey only if one doesn't already exist — safe to call
// repeatedly (e.g. on every Time In/Out save) without ever producing a duplicate.
const ensureDiaryEntryExists = (entries, dateKey) => {
  const list = entries || [];
  if (list.some(entry => entry.date === dateKey)) return list;
  return [...list, { id: Date.now(), date: dateKey, text: '', timestamp: new Date().toISOString() }];
};

// Formats a "YYYY-MM-DD" key as a local date, avoiding the UTC-midnight shift that
// `new Date("YYYY-MM-DD")` would introduce in negative-UTC-offset timezones.
const formatDateKeyLabel = (dateKey) => {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

// Small reusable chip so Time In / Time Out always read as two distinct facts, never one merged line
function TimeChip({ kind, label, value }) {
  const isLogged = !!value;
  return (
    <div className={`time-chip time-chip-${kind}`}>
      <span className="time-chip-label">{label}</span>
      <span className={`time-chip-value ${isLogged ? 'status-logged' : 'status-empty'}`}>
        {value || '--:-- --'}
      </span>
    </div>
  );
}

// One correction row inside the modal: shows the locked recorded value (with an Edit
// option), a note explaining why entry can't happen yet, or the auto-fill/manual entry
// controls for recording — or correcting — a punch.
function TimeEntrySection({
  label,
  storedValue,
  draft,
  onDraftChange,
  onAutoFill,
  onSave,
  blockedMessage,
  saveLabel,
  isEditing,
  onStartEdit,
  onCancelEdit,
  canEdit,
}) {
  const isLocked = !!storedValue;
  const showControls = isEditing || (!isLocked && !blockedMessage);

  return (
    <div className="time-entry-section">
      <div className="time-entry-header">
        <span className="time-entry-label">{label}</span>
        {isLocked && !isEditing && (
          <span className="time-entry-header-actions">
            <span className="time-entry-recorded-badge">✓ Recorded</span>
            {canEdit && (
              <button type="button" className="time-entry-edit-link" onClick={onStartEdit}>
                Edit
              </button>
            )}
          </span>
        )}
      </div>

      {showControls ? (
        <div className="time-entry-controls">
          <input
            type="time"
            value={draft}
            onChange={onDraftChange}
            className="time-entry-input"
          />
          <div className="time-entry-actions">
            <button type="button" className="btn-outline time-entry-autofill" onClick={onAutoFill}>
              ⏱ Use Current Time
            </button>
            <button
              type="button"
              className="punch-btn btn-blue time-entry-save"
              onClick={onSave}
              disabled={!draft}
            >
              {saveLabel || `Save ${label}`}
            </button>
          </div>
          {isEditing && (
            <button type="button" className="time-entry-cancel-link" onClick={onCancelEdit}>
              Cancel edit
            </button>
          )}
        </div>
      ) : isLocked ? (
        <div className="time-entry-value-display">{storedValue}</div>
      ) : (
        <p className="time-entry-blocked-note">{blockedMessage}</p>
      )}
    </div>
  );
}

export default function PunchCard({ shiftState, setShiftState }) {
  // --- Live Clock Display State ---
  const [timeString, setTimeString] = useState('');
  const [dateString, setDateString] = useState('');

  // --- Modal Workflow View Control: 'closed' | 'am' | 'pm' ---
  const [modalView, setModalView] = useState('closed');

  // --- Draft values for the time-correction inputs (24h "HH:MM" strings) ---
  const [draftIn, setDraftIn] = useState('');
  const [draftOut, setDraftOut] = useState('');

  // --- Draft text for the "Daily Diary" quick-entry modal ---
  const [diaryDraft, setDiaryDraft] = useState('');

  // --- Whether an already-recorded time is currently being edited ---
  const [editingIn, setEditingIn] = useState(false);
  const [editingOut, setEditingOut] = useState(false);

  // --- Empty-diary guard: inline red message + a 3s glow on the Daily
  // Diary button, replacing the old alert() popup. ---
  const [diaryGuardError, setDiaryGuardError] = useState(null);
  const [isDiaryButtonGlowing, setIsDiaryButtonGlowing] = useState(false);
  const diaryGlowTimeoutRef = useRef(null);

  // --- Success toast, matching the History Logs notification exactly:
  //     appears immediately, starts fading at 1.5s, fully removed at 2.2s ---
  const [toastMessage, setToastMessage] = useState(null);
  const [toastType, setToastType] = useState('success');
  const [isToastFading, setIsToastFading] = useState(false);

  const triggerToast = (text, type = 'success') => {
    setToastMessage(text);
    setToastType(type);
    setIsToastFading(false);
  };

  useEffect(() => {
    if (!toastMessage) return;

    const fadeStartTimeout = setTimeout(() => {
      setIsToastFading(true);
    }, 1500);

    const completeTimeout = setTimeout(() => {
      setToastMessage(null);
      setIsToastFading(false);
    }, 2200);

    return () => {
      clearTimeout(fadeStartTimeout);
      clearTimeout(completeTimeout);
    };
  }, [toastMessage]);

  // --- Real-time Ticker Effect ---
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTimeString(now.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      }));
      setDateString(now.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      }));
    };

    updateTime();
    const intervalId = setInterval(updateTime, 1000);
    return () => clearInterval(intervalId);
  }, []);

  // Lock background window scrolling while modal layer is toggled open
  useEffect(() => {
    if (modalView !== 'closed') {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [modalView]);

  // Seed the draft inputs whenever a shift modal opens, from whatever is already recorded,
  // and reset out of edit mode so a fresh open never starts mid-edit.
  useEffect(() => {
    if (modalView === 'am') {
      setDraftIn(to24HourInputValue(shiftState.amIn));
      setDraftOut(to24HourInputValue(shiftState.amOut));
    } else if (modalView === 'pm') {
      setDraftIn(to24HourInputValue(shiftState.pmIn));
      setDraftOut(to24HourInputValue(shiftState.pmOut));
    }
    setEditingIn(false);
    setEditingOut(false);
    if (modalView === 'diary') {
      const dateKey = getShiftDateKey(shiftState);
      const entry = (shiftState.diaryEntries || []).find(e => e.date === dateKey);
      setDiaryDraft(entry ? entry.text : '');
    }
  }, [modalView, shiftState.amIn, shiftState.amOut, shiftState.pmIn, shiftState.pmOut, shiftState.date, shiftState.diaryEntries]);

  const amHours = calculateDuration12H(shiftState.amIn, shiftState.amOut);
  const pmHours = calculateDuration12H(shiftState.pmIn, shiftState.pmOut);
  const totalHoursWorked = (amHours + pmHours).toFixed(2);

  const openShift = (shiftKey) => setModalView(shiftKey);
  const closeModal = () => setModalView('closed');

  const hasDiaryContent = (shiftState.diaryEntries || []).some(entry => entry.text && entry.text.trim())
    || (shiftState.diary && shiftState.diary.trim());

  // Shows the inline red guard message and makes the Daily Diary button
  // glow red for 3 seconds so it's obvious where to go to fix it. Closes
  // whatever shift-correction modal is open first (if any), since the
  // Daily Diary button lives on the main card underneath it and needs to
  // actually be visible for the glow to do its job.
  const triggerDiaryGuard = (message) => {
    setModalView('closed');
    setDiaryGuardError(message);

    if (diaryGlowTimeoutRef.current) clearTimeout(diaryGlowTimeoutRef.current);
    setIsDiaryButtonGlowing(true);
    diaryGlowTimeoutRef.current = setTimeout(() => {
      setIsDiaryButtonGlowing(false);
    }, 3000);
  };

  // Clear the guard message automatically once the diary actually has
  // content, so it doesn't linger after the person fixes it.
  useEffect(() => {
    if (hasDiaryContent && diaryGuardError) {
      setDiaryGuardError(null);
    }
  }, [hasDiaryContent, diaryGuardError]);

  useEffect(() => () => {
    if (diaryGlowTimeoutRef.current) clearTimeout(diaryGlowTimeoutRef.current);
  }, []);

  const saveTimeIn = async () => {
    if (!draftIn) return;
    const field = modalView === 'am' ? 'amIn' : 'pmIn';
    const otherField = modalView === 'am' ? 'amOut' : 'pmOut';
    const newValue = from24HourInputValue(draftIn);
    const bothPresent = !!newValue && !!shiftState[otherField];
    const dateKey = getShiftDateKey(shiftState);
    const previous = shiftState;

    // Guard against silently reopening/overwriting an already-completed
    // day. Only checked for a genuinely fresh session — nothing recorded
    // locally yet, and not an intentional reopen via History Logs' Edit
    // (which sets shiftState.id). A normal AM -> PM continuation within
    // the same session never re-triggers this, since by then amIn/amOut
    // etc. already have local values.
    const isFreshSession = !shiftState.id
      && !shiftState.amIn && !shiftState.amOut && !shiftState.pmIn && !shiftState.pmOut;

    if (isFreshSession) {
      try {
        const existing = await fetchDay(dateKey);
        if (existing && existing.isCompleted) {
          triggerToast(
            'This day has already been recorded. Open it from Attendance History to edit it instead.',
            'danger'
          );
          return;
        }
      } catch {
        // If the pre-check itself fails (e.g. a network hiccup), don't block
        // the person on that — fall through and let the real save attempt
        // below surface any actual error instead.
      }
    }

    const next = { ...shiftState, [field]: newValue };
    if (bothPresent) {
      next.diaryEntries = ensureDiaryEntryExists(shiftState.diaryEntries, dateKey);
    }

    setShiftState(next);
    setEditingIn(false);
    closeModal();

    try {
      await saveDay({
        date: dateKey,
        amIn: next.amIn,
        amOut: next.amOut,
        pmIn: next.pmIn,
        pmOut: next.pmOut,
        isCompleted: next.isCompleted,
      });
      triggerToast('Time In recorded successfully.');
    } catch (err) {
      setShiftState(previous);
      triggerToast(err.message || 'Failed to save Time In. Please try again.', 'danger');
    }
  };

  const saveTimeOut = async () => {
    if (!draftOut) return;
    const newValue = from24HourInputValue(draftOut);
    const dateKey = getShiftDateKey(shiftState);
    const previous = shiftState;

    if (modalView === 'pm') {
      if (!hasDiaryContent) {
        triggerDiaryGuard("Please provide your narrative daily progress notes before executing final out punches.");
        return;
      }
      const bothPresent = !!newValue && !!shiftState.pmIn;
      const next = { ...shiftState, pmOut: newValue, isCompleted: true };
      if (bothPresent) {
        next.diaryEntries = ensureDiaryEntryExists(shiftState.diaryEntries, dateKey);
      }

      setShiftState(next);
      setEditingOut(false);
      closeModal();

      try {
        await saveDay({
          date: dateKey,
          amIn: next.amIn,
          amOut: next.amOut,
          pmIn: next.pmIn,
          pmOut: next.pmOut,
          isCompleted: next.isCompleted,
        });
        triggerToast('Time Out recorded successfully.');
      } catch (err) {
        setShiftState(previous);
        triggerToast(err.message || 'Failed to save Time Out. Please try again.', 'danger');
      }
      return;
    }

    const bothPresent = !!newValue && !!shiftState.amIn;
    const next = { ...shiftState, amOut: newValue };
    if (bothPresent) {
      next.diaryEntries = ensureDiaryEntryExists(shiftState.diaryEntries, dateKey);
    }

    setShiftState(next);
    setEditingOut(false);
    closeModal();

    try {
      await saveDay({
        date: dateKey,
        amIn: next.amIn,
        amOut: next.amOut,
        pmIn: next.pmIn,
        pmOut: next.pmOut,
        isCompleted: next.isCompleted,
      });
      triggerToast('Time Out recorded successfully.');
    } catch (err) {
      setShiftState(previous);
      triggerToast(err.message || 'Failed to save Time Out. Please try again.', 'danger');
    }
  };

  const cancelEditIn = () => {
    const stored = modalView === 'am' ? shiftState.amIn : shiftState.pmIn;
    setDraftIn(to24HourInputValue(stored));
    setEditingIn(false);
  };

  const cancelEditOut = () => {
    const stored = modalView === 'am' ? shiftState.amOut : shiftState.pmOut;
    setDraftOut(to24HourInputValue(stored));
    setEditingOut(false);
  };

  const handleDiaryDraftChange = (e) => {
    const text = e.target.value;
    const words = text.trim() === '' ? [] : text.trim().split(/\s+/);
    if (words.length <= DIARY_WORD_LIMIT) {
      setDiaryDraft(text);
    } else {
      // Prevent typing past the limit rather than silently truncating mid-word
      setDiaryDraft(words.slice(0, DIARY_WORD_LIMIT).join(' '));
    }
  };

  const saveDiaryEntry = async () => {
    const trimmedText = diaryDraft.trim();
    if (!trimmedText) return;

    const dateKey = getShiftDateKey(shiftState);
    const previous = shiftState;
    const wasExisting = !!activeDiaryEntry;

    setShiftState(prev => {
      const existingEntries = prev.diaryEntries || [];
      const idx = existingEntries.findIndex(entry => entry.date === dateKey);

      const updatedEntries = idx !== -1
        ? existingEntries.map((entry, i) =>
            i === idx ? { ...entry, text: trimmedText, timestamp: new Date().toISOString() } : entry
          )
        : [...existingEntries, { id: Date.now(), date: dateKey, text: trimmedText, timestamp: new Date().toISOString() }];

      return { ...prev, diaryEntries: updatedEntries };
    });

    setDiaryDraft('');
    closeModal();

    try {
      await saveDiaryOnly(dateKey, trimmedText);
      triggerToast(wasExisting ? 'Diary entry updated successfully.' : 'Diary entry saved successfully.');
    } catch (err) {
      setShiftState(previous);
      triggerToast(err.message || 'Failed to save diary entry. Please try again.', 'danger');
    }
  };

  const diaryWordCount = countWords(diaryDraft);
  const activeDateKey = getShiftDateKey(shiftState);
  const activeDiaryEntry = (shiftState.diaryEntries || []).find(entry => entry.date === activeDateKey);
  const activeDateLabel = activeDateKey === getDateKey(new Date()) ? 'Today' : formatDateKeyLabel(activeDateKey);

  // --- "Save Day Logs" — finalizes whichever shifts are recorded for the day. ---
  // A shift only counts as recorded once it has BOTH a Time In and Time Out;
  // a lone Time In with no matching Time Out isn't enough to log that shift.
  const [isSavingDayLogs, setIsSavingDayLogs] = useState(false);
  const isAmShiftComplete = !!(shiftState.amIn && shiftState.amOut);
  const isPmShiftComplete = !!(shiftState.pmIn && shiftState.pmOut);
  const dayType = isAmShiftComplete && isPmShiftComplete
    ? 'Full Day'
    : (isAmShiftComplete || isPmShiftComplete)
      ? 'Half Day'
      : null;

  const saveDayLogs = async () => {
    if (!dayType || isSavingDayLogs || shiftState.isCompleted) return;

    // Same "no blank diary" rule already enforced when the PM Out punch closes
    // out the day — applied here too, since this button can also finalize
    // the day (e.g. a Half Day with no PM shift at all).
    if (!hasDiaryContent) {
      triggerDiaryGuard("Please provide your narrative daily progress notes before saving your day logs.");
      return;
    }

    const dateKey = getShiftDateKey(shiftState);
    const previous = shiftState;
    const next = { ...shiftState, isCompleted: true };

    setShiftState(next);
    setIsSavingDayLogs(true);

    try {
      await saveDay({
        date: dateKey,
        amIn: next.amIn,
        amOut: next.amOut,
        pmIn: next.pmIn,
        pmOut: next.pmOut,
        isCompleted: next.isCompleted,
      });
      triggerToast(`Day logs saved successfully as a ${dayType}.`);
    } catch (err) {
      setShiftState(previous);
      triggerToast(err.message || 'Failed to save day logs. Please try again.', 'danger');
    } finally {
      setIsSavingDayLogs(false);
    }
  };

  const isAm = modalView === 'am';
  const shiftLabel = isAm ? 'Morning Shift (AM)' : 'Afternoon Shift (PM)';
  const timeInValue = isAm ? shiftState.amIn : shiftState.pmIn;
  const timeOutValue = isAm ? shiftState.amOut : shiftState.pmOut;
  // Time In is never blocked for either shift — Morning and Afternoon are
  // independent of each other, so a user who only works one shift (or
  // forgets to punch the other) can still record either one on its own.
  const timeInBlockedMessage = null;
  const timeOutBlockedMessage = !timeInValue
    ? `Record ${isAm ? 'Morning' : 'Afternoon'} Time In first.`
    : null;

  // Daily Diary only unlocks once at least one punch has been recorded for the day
  const hasAnyPunchRecorded = !!(shiftState.amIn || shiftState.amOut || shiftState.pmIn || shiftState.pmOut);

  return (
    <div className="punch-card-wrapper">

      {/* Standalone Live Clock Card — separated from the punch card so the ticking clock
          reads as ambient context, not as part of the shift-tracking surface below */}
      <div className="live-clock-card">
        <div className="clock-time">{timeString || '00:00:00 AM'}</div>
        <div className="clock-date">{dateString}</div>
      </div>

      {/* Main Base Card Container */}
      <div className="punch-card">
        {/* SUCCESS TOAST NOTIFICATION — same design/behavior as HistoryLogs' toast */}
        {toastMessage && (
          <div className={`toast-notification-banner toast-${toastType} ${isToastFading ? 'fade-out-active' : ''}`}>
            <span>{toastType === 'success' ? '✅' : '⚠️'} {toastMessage}</span>
          </div>
        )}

        <div className="punch-content-inner">
          <div className="punch-header">
            <div>
              <h3 className="punch-title">📅 OJT Time Management</h3>
              <p className="punch-subtitle">Select a shift to record or correct your Time In / Time Out.</p>
            </div>
            <div className="punch-hours-badge">
              Today: <span className="punch-hours-count">{totalHoursWorked}</span> hrs
            </div>
          </div>

          {/* Two distinct, color-coded cards — each shift's Time In/Out
              chips live directly above its own action button, instead of
              both previews sitting together with the buttons separated
              below them. */}
          <div className="shift-cards-grid">
            <div className="shift-card shift-card-morning">
              <span className="shift-card-label">🌅 Morning (AM)</span>
              <div className="time-pair">
                <TimeChip kind="in" label="Time In" value={shiftState.amIn} />
                <TimeChip kind="out" label="Time Out" value={shiftState.amOut} />
              </div>
              <button
                onClick={() => openShift('am')}
                className="punch-btn btn-blue shift-select-btn"
              >
                🌅 Morning Shift
              </button>
            </div>

            <div className="shift-card shift-card-afternoon">
              <span className="shift-card-label">🌇 Afternoon (PM)</span>
              <div className="time-pair">
                <TimeChip kind="in" label="Time In" value={shiftState.pmIn} />
                <TimeChip kind="out" label="Time Out" value={shiftState.pmOut} />
              </div>
              <button
                onClick={() => openShift('pm')}
                className="punch-btn btn-amber shift-select-btn"
              >
                🌇 Afternoon Shift
              </button>
            </div>
          </div>

          <div className="view-center-action save-day-logs-wrap">
            <button
              onClick={saveDayLogs}
              className="punch-btn btn-emerald save-day-logs-btn"
              disabled={!dayType || isSavingDayLogs || shiftState.isCompleted}
            >
              {shiftState.isCompleted
                ? `✓ Day Logs Saved (${dayType || 'Recorded'})`
                : isSavingDayLogs
                  ? 'Saving…'
                  : `💾 Save Day Logs${dayType ? ` (${dayType})` : ''}`}
            </button>
            {!dayType && !shiftState.isCompleted && (
              <p className="diary-trigger-hint">
                Record both a Time In and Time Out for at least one shift to save your day logs.
              </p>
            )}
          </div>

          <div className="view-center-action diary-trigger-wrap">
            <button
              onClick={() => setModalView('diary')}
              className={`punch-btn btn-indigo diary-trigger-btn${isDiaryButtonGlowing ? ' diary-btn-glow' : ''}`}
              disabled={!hasAnyPunchRecorded}
            >
              {activeDiaryEntry ? '✏️ Edit Daily Diary' : '📝 Daily Diary'}
            </button>
            {diaryGuardError ? (
              <p className="diary-guard-error" role="alert">
                ⚠️ {diaryGuardError}
              </p>
            ) : !hasAnyPunchRecorded && (
              <p className="diary-trigger-hint">
                Record a Time In or Time Out for either shift to unlock the diary.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ================================================================= */}
      {modalView !== 'closed' && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-window-card" onClick={(e) => e.stopPropagation()}>

            <button className="modal-close-corner-btn" onClick={closeModal}>&times;</button>

            <div className="modal-inner-content view-fade-in">
              <div className="panel-header-row">
                <h4 className="modal-panel-title">
                  {modalView === 'diary'
                    ? `📝 Diary — ${activeDateLabel}`
                    : shiftLabel}
                </h4>
              </div>

              {modalView === 'diary' ? (
                <>
                  <p className="time-entry-intro">
                    {activeDiaryEntry
                      ? `Editing the saved entry for ${activeDateLabel}. Saving will update it in place.`
                      : `Write about tasks and accomplishments for ${activeDateLabel}.`}
                  </p>
                  <textarea
                    autoFocus
                    value={diaryDraft}
                    onChange={handleDiaryDraftChange}
                    placeholder="Describe your output..."
                    className="diary-quick-textarea"
                  />
                  <div className="diary-quick-footer">
                    <span className="diary-quick-word-count">
                      {diaryWordCount} / {DIARY_WORD_LIMIT} words
                    </span>
                    <div className="diary-quick-actions">
                      <button type="button" className="btn-outline diary-quick-cancel" onClick={closeModal}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="punch-btn btn-blue"
                        onClick={saveDiaryEntry}
                        disabled={!diaryDraft.trim()}
                      >
                        {activeDiaryEntry ? 'Update Diary' : 'Save Diary'}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <p className="time-entry-intro">
                    Forgot to punch in or out? Record the actual time below.
                  </p>

                  <TimeEntrySection
                    label="Time In"
                    storedValue={timeInValue}
                    draft={draftIn}
                    onDraftChange={(e) => setDraftIn(e.target.value)}
                    onAutoFill={() => setDraftIn(currentTimeInputValue())}
                    onSave={saveTimeIn}
                    blockedMessage={timeInBlockedMessage}
                    isEditing={editingIn}
                    onStartEdit={() => setEditingIn(true)}
                    onCancelEdit={cancelEditIn}
                    canEdit={!shiftState.isCompleted}
                  />

                  <TimeEntrySection
                    label="Time Out"
                    storedValue={timeOutValue}
                    draft={draftOut}
                    onDraftChange={(e) => setDraftOut(e.target.value)}
                    onAutoFill={() => setDraftOut(currentTimeInputValue())}
                    onSave={saveTimeOut}
                    blockedMessage={timeOutBlockedMessage}
                    saveLabel={!isAm ? 'Save & Submit Day' : 'Save Time Out'}
                    isEditing={editingOut}
                    onStartEdit={() => setEditingOut(true)}
                    onCancelEdit={cancelEditOut}
                    canEdit={!shiftState.isCompleted}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}