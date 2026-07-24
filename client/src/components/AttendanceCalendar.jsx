import React, { useEffect, useState } from 'react';

// ==========================================
// ENVIRONMENT VARIABLE CONFIGURATION
// ==========================================
// For Vite projects, use: import.meta.env.VITE_GOOGLE_CALENDAR_API_KEY
// For Create React App (CRA) projects, use: process.env.REACT_APP_GOOGLE_CALENDAR_API_KEY
const GOOGLE_API_KEY = import.meta.env.VITE_GOOGLE_CALENDAR_API_KEY;

// Public Philippines Holiday Calendar ID
const CALENDAR_ID = encodeURIComponent("en.philippines#holiday@group.v.calendar.google.com");

function getSystemDateSnapshot() {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth(), // 0-indexed
    day: now.getDate(),
  };
}

function getMonthGridDetails(year, month) {
  return {
    daysInMonth: new Date(year, month + 1, 0).getDate(),
    firstWeekdayOffset: new Date(year, month, 1).getDay(),
    monthLabel: new Date(year, month).toLocaleDateString([], { month: 'long', year: 'numeric' }),
  };
}

// A day counts as a completed shift if either the AM pair or the PM pair is fully punched.
// This mirrors how HistoryLogs' update form treats all four fields as required per row,
// so any row present in `logs` should already have both pairs filled — but we check
// defensively in case of partially-migrated or manually-edited data.
function logHasCompleteShift(log) {
  if (!log) return false;
  const amComplete = !!(log.amIn && log.amOut);
  const pmComplete = !!(log.pmIn && log.pmOut);
  return amComplete || pmComplete;
}

export default function AttendanceCalendar({ shiftState, logs = [], isConfigComplete = true, startDate = '' }) {
  const [realToday, setRealToday] = useState(getSystemDateSnapshot);
  const [viewDate, setViewDate] = useState(() => {
    const system = getSystemDateSnapshot();
    return { year: system.year, month: system.month };
  });

  // The calendar defaults to today's month on mount (above), which is
  // correct for the locked placeholder state. Once a Start Date exists —
  // whether that's on first unlock or after the person edits it later —
  // jump the view to that date's month instead. Runs only when the
  // `startDate` value itself changes, so it won't fight the person's own
  // Prev/Next navigation afterward.
  useEffect(() => {
    if (!startDate) return;
    const parsed = new Date(startDate + 'T00:00:00');
    if (Number.isNaN(parsed.getTime())) return;
    setViewDate({ year: parsed.getFullYear(), month: parsed.getMonth() });
  }, [startDate]);

  const [holidays, setHolidays] = useState({});
  const [isLoadingHolidays, setIsLoadingHolidays] = useState(false);

  // Modal state for the read-only "View Attendance" popup, opened by clicking
  // any Present-marked day cell.
  const [activeViewRecord, setActiveViewRecord] = useState(null);

  // Modal state for the read-only "View Holiday" popup, opened by clicking
  // any Holiday-marked day cell.
  const [activeHolidayRecord, setActiveHolidayRecord] = useState(null);

  // Auto-rollover clock logic (midnight check)
  useEffect(() => {
    const intervalId = setInterval(() => {
      setRealToday(prev => {
        const next = getSystemDateSnapshot();
        return (next.day !== prev.day || next.month !== prev.month || next.year !== prev.year) ? next : prev;
      });
    }, 60 * 1000);
    return () => clearInterval(intervalId);
  }, []);

  // Fetch from Google Calendar API when the viewed year changes
  useEffect(() => {
    // If the API key isn't loaded correctly, log a warning and skip the request
    if (!GOOGLE_API_KEY) {
      console.warn("Google Calendar API key missing. Please check your .env file setup.");
      return;
    }

    const fetchGoogleCalendarHolidays = async () => {
      setIsLoadingHolidays(true);

      // Filter parameters to fetch events for the entire calendar year
      const timeMin = encodeURIComponent(`${viewDate.year}-01-01T00:00:00Z`);
      const timeMax = encodeURIComponent(`${viewDate.year}-12-31T23:59:59Z`);

      const url = `https://www.googleapis.com/calendar/v3/calendars/${CALENDAR_ID}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&key=${GOOGLE_API_KEY}`;

      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Failed to fetch Google Calendar events");

        const data = await response.json();
        const holidayMap = {};

        if (data.items) {
          data.items.forEach(event => {
            // Read both all-day event string flags "YYYY-MM-DD" or split timestamp strings
            const dateStr = event.start.date || event.start.dateTime?.split('T')[0];
            if (dateStr) {
              // Store both the holiday name and whatever type/notes info the
              // calendar provides in `description` (e.g. "Public holiday",
              // "Special non-working holiday", "Observance"). The Philippines
              // holiday calendar doesn't always populate this field, so we
              // fall back to a generic label when it's missing.
              holidayMap[dateStr] = {
                name: event.summary || "Holiday",
                type: event.description?.trim() || "Holiday",
              };
            }
          });
        }

        setHolidays(holidayMap);
      } catch (error) {
        console.error("Google Calendar API Error:", error);
      } finally {
        setIsLoadingHolidays(false);
      }
    };

    fetchGoogleCalendarHolidays();
  }, [viewDate.year]);

  const handlePrevMonth = () => {
    setViewDate(prev => {
      // Can't go earlier than the month the Start Date falls in.
      if (startDateObj
        && prev.year === startDateObj.getFullYear()
        && prev.month === startDateObj.getMonth()) {
        return prev;
      }
      return prev.month === 0 ? { year: prev.year - 1, month: 11 } : { ...prev, month: prev.month - 1 };
    });
  };

  const handleNextMonth = () => {
    setViewDate(prev => (prev.month === 11 ? { year: prev.year + 1, month: 0 } : { ...prev, month: prev.month + 1 }));
  };

  const handleResetToCurrent = () => {
    setViewDate({ year: realToday.year, month: realToday.month });
  };

  // Formats a "HH:MM" 24h time string into a friendly 12h display, matching
  // the same formatting HistoryLogs uses for its punch times.
  const formatTimeToShow = (timeStr) => {
    if (!timeStr) return '--:--';
    const [hours, minutes] = timeStr.split(':');
    const h = parseInt(hours, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const displayHour = h % 12 === 0 ? 12 : h % 12;
    return `${displayHour}:${minutes} ${ampm}`;
  };

  // Builds the normalized record shown in the View Attendance modal, whether
  // the source is a historical log row or today's in-progress/completed shiftState.
  const openAttendanceView = (record, dateISOKey, dayLabel) => {
    setActiveViewRecord({
      date: record.date || dateISOKey,
      day: record.day || dayLabel,
      amIn: record.amIn,
      amOut: record.amOut,
      pmIn: record.pmIn,
      pmOut: record.pmOut,
      diaryText: record.diaryText,
      submittedAt: record.submittedAt,
    });
  };

  // Builds the normalized record shown in the View Holiday modal.
  const openHolidayView = (holidayData, dateISOKey, dayLabel) => {
    setActiveHolidayRecord({
      date: dateISOKey,
      day: dayLabel,
      name: holidayData.name,
      type: holidayData.type,
    });
  };

  const { daysInMonth, firstWeekdayOffset, monthLabel } = getMonthGridDetails(viewDate.year, viewDate.month);
  const isViewingCurrentMonth = viewDate.year === realToday.year && viewDate.month === realToday.month;

  // Precise "today" Date object (midnight) used for reliable past/present/future
  // comparisons that work correctly across month and year boundaries.
  const todayDateObj = new Date(realToday.year, realToday.month, realToday.day);

  // Precise Start Date object (midnight), used both to block navigating to
  // earlier months and to neutralize Present/Absent flags on any day that
  // falls before it — even within the start month itself, if the
  // configured date lands mid-month rather than on the 1st.
  const startDateObj = startDate ? new Date(startDate + 'T00:00:00') : null;
  const isViewingStartMonth = !!startDateObj
    && viewDate.year === startDateObj.getFullYear()
    && viewDate.month === startDateObj.getMonth();
  const isBeforeStartMonth = !!startDateObj
    && (viewDate.year < startDateObj.getFullYear()
      || (viewDate.year === startDateObj.getFullYear() && viewDate.month < startDateObj.getMonth()));
  return (
    <div className="calendar-card">
      <div className="calendar-card-header">
        <h3 className="calendar-title">📆 Attendance Calendar</h3>
        {isConfigComplete && !isViewingCurrentMonth && (
          <button onClick={handleResetToCurrent} className="calendar-today-btn">Today</button>
        )}
      </div>

      {!isConfigComplete ? (
        <div className="calendar-locked-state" role="status">
          <span className="calendar-locked-icon" aria-hidden="true">🔒</span>
          <p className="calendar-locked-text">
            Complete your Required Hours and Start Date setup above to unlock the attendance calendar.
          </p>
        </div>
      ) : (
        <>
      <div className="calendar-inner-box">
        <div className="calendar-navigation-header">
          <button
            onClick={handlePrevMonth}
            className="calendar-nav-btn"
            disabled={isViewingStartMonth || isBeforeStartMonth}
            title={(isViewingStartMonth || isBeforeStartMonth) ? "Can't go earlier than your configured start date" : undefined}
          >&lt;</button>
          <div className="calendar-month-label">
            {monthLabel} {isLoadingHolidays && <span className="calendar-spinner">⏳</span>}
          </div>
          <button onClick={handleNextMonth} className="calendar-nav-btn">&gt;</button>
        </div>

        <div className="calendar-week-labels">
          <span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span>
        </div>

        <div className="calendar-days-grid">
          {Array.from({ length: firstWeekdayOffset }, (_, i) => (
            <div key={`pad-${i}`} className="calendar-day-cell day-pad" aria-hidden="true"></div>
          ))}

          {Array.from({ length: daysInMonth }, (_, index) => {
            const currentDayNumber = index + 1;
            const currentMonthString = String(viewDate.month + 1).padStart(2, '0');
            const currentDayString = String(currentDayNumber).padStart(2, '0');
            const dateISOKey = `${viewDate.year}-${currentMonthString}-${currentDayString}`;

            const isHoliday = holidays[dateISOKey];
            const dayOfWeek = new Date(viewDate.year, viewDate.month, currentDayNumber).getDay();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            const dayLabel = new Date(viewDate.year, viewDate.month, currentDayNumber).toLocaleDateString([], { weekday: 'long' });

            const cellDateObj = new Date(viewDate.year, viewDate.month, currentDayNumber);
            const isPastDate = cellDateObj < todayDateObj;
            const isTodayCell = cellDateObj.getTime() === todayDateObj.getTime();
            // Only relevant within the start month itself — a date's cell can
            // land before the configured Start Date even though the whole
            // month isn't blocked (Prev navigation already stops the month
            // before this one; this catches the remaining days-of-month case
            // when the Start Date falls mid-month rather than on the 1st).
            const isBeforeStartDate = !!startDateObj && cellDateObj < startDateObj;

            let cellStyle = "calendar-day-cell";
            let tooltipText;
            // Holds whichever record (a historical log row, or today's shiftState)
            // should be shown if this cell turns out to be clickable (Present).
            let presentRecord = null;

            if (isHoliday) {
              // Holidays are excluded from attendance tracking entirely, regardless of
              // whether logs exist for that date (e.g. optional overtime on a holiday).
              cellStyle += " day-holiday";
              tooltipText = `${isHoliday.name} — click to view details`;
            } else if (isWeekend) {
              // Weekends are excluded from attendance tracking entirely, same reasoning.
              cellStyle += " day-weekend";
            } else if (isBeforeStartDate) {
              // Present/Absent tracking only applies from the configured Start
              // Date onward — days before it are neutral, non-interactive, and
              // never flagged either way, even if they're otherwise a normal
              // past working day.
              cellStyle += " day-upcoming";
              tooltipText = "Before your configured start date — not tracked";
            } else if (isPastDate) {
              // Standard working day that has already passed: evaluate Present/Absent
              // strictly from the historical logs array.
              const dayLog = logs.find(log => log.date === dateISOKey);
              const isPresent = logHasCompleteShift(dayLog);
              cellStyle += isPresent ? " day-present" : " day-absent";
              tooltipText = isPresent ? "Present — click to view details" : "Absent";
              if (isPresent) presentRecord = dayLog;
            } else if (isTodayCell) {
              if (shiftState.isCompleted) {
                // Today's shift is fully wrapped up — evaluate it exactly like a past day.
                const isPresent = logHasCompleteShift(shiftState);
                cellStyle += isPresent ? " day-present" : " day-absent";
                tooltipText = isPresent ? "Present — click to view details" : "Absent";
                if (isPresent) presentRecord = shiftState;
              } else {
                cellStyle += " day-current";
              }
            } else {
              // Future working day — nothing to evaluate yet.
              cellStyle += " day-upcoming";
            }

            const isClickablePresent = cellStyle.includes("day-present");
            const isClickableHoliday = cellStyle.includes("day-holiday");
            const isClickableCell = isClickablePresent || isClickableHoliday;

            const handleCellActivate = () => {
              if (isClickablePresent) {
                openAttendanceView(presentRecord, dateISOKey, dayLabel);
              } else if (isClickableHoliday) {
                openHolidayView(isHoliday, dateISOKey, dayLabel);
              }
            };

            return (
              <div
                key={currentDayNumber}
                className={cellStyle}
                title={tooltipText}
                role={isClickableCell ? "button" : undefined}
                tabIndex={isClickableCell ? 0 : undefined}
                onClick={isClickableCell ? handleCellActivate : undefined}
                onKeyDown={isClickableCell ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleCellActivate();
                  }
                } : undefined}
              >
                {currentDayNumber}
                {isHoliday && <span className="holiday-indicator-dot"></span>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="calendar-legend">
        <div className="legend-columns">
          <div className="legend-item">
            <span className="legend-dot dot-green"></span>
            <span>Present</span>
          </div>
          <div className="legend-item">
            <span className="legend-dot dot-red"></span>
            <span>Absent</span>
          </div>
          <div className="legend-item">
            <span className="legend-dot dot-yellow"></span>
            <span>Holiday (Google Calendar)</span>
          </div>
        </div>
      </div>

      {/* VIEW ATTENDANCE MODAL — read-only, mirrors HistoryLogs' view modal styling */}
      {activeViewRecord && (
        <div className="diary-modal-overlay" onClick={() => setActiveViewRecord(null)}>
          <div className="diary-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-card-header">
              <div>
                <h4 className="modal-card-title">📅 View Attendance Details</h4>
                <p className="modal-card-subtitle">{activeViewRecord.date} ({activeViewRecord.day})</p>
              </div>
              <button className="modal-close-x-btn" onClick={() => setActiveViewRecord(null)}>✕</button>
            </div>

            <div className="modal-card-body modal-form-scrollable">
              <div className="modal-form-grid">
                <div className="form-grid-section shift-focus-card standard-diary-layout">
                  <h5 className="form-section-heading">🌅 Morning Shift (AM)</h5>
                  <div className="form-input-field">
                    <label>Time In</label>
                    <div className="view-readonly-value">{formatTimeToShow(activeViewRecord.amIn)}</div>
                  </div>
                  <div className="form-input-field">
                    <label>Time Out</label>
                    <div className="view-readonly-value">{formatTimeToShow(activeViewRecord.amOut)}</div>
                  </div>
                </div>

                <div className="form-grid-section shift-focus-card standard-diary-layout">
                  <h5 className="form-section-heading">🌤️ Afternoon Shift (PM)</h5>
                  <div className="form-input-field">
                    <label>Time In</label>
                    <div className="view-readonly-value">{formatTimeToShow(activeViewRecord.pmIn)}</div>
                  </div>
                  <div className="form-input-field">
                    <label>Time Out</label>
                    <div className="view-readonly-value">{formatTimeToShow(activeViewRecord.pmOut)}</div>
                  </div>
                </div>
              </div>

              <div className="form-textarea-section shift-focus-card standard-diary-layout">
                <h5 className="form-section-heading">📝 Accomplishment Summary</h5>
                <div className="modal-card-body max-height-view no-side-padding">
                  <p className="modal-diary-fulltext">
                    {activeViewRecord.diaryText ? `"${activeViewRecord.diaryText}"` : "No diary entry recorded for this date."}
                  </p>
                </div>
              </div>
            </div>

            <div className="modal-card-footer">
              <span className="modal-footer-timestamp">✍️ Logged: {activeViewRecord.submittedAt || "N/A"}</span>
              <button type="button" className="modal-close-action-btn" onClick={() => setActiveViewRecord(null)}>Close View</button>
            </div>
          </div>
        </div>
      )}

      {/* VIEW HOLIDAY MODAL — read-only, mirrors the View Attendance modal styling */}
      {activeHolidayRecord && (
        <div className="diary-modal-overlay" onClick={() => setActiveHolidayRecord(null)}>
          <div className="diary-modal-card holiday-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-card-header">
              <div>
                <h4 className="modal-card-title">🎉 View Holiday Details</h4>
                <p className="modal-card-subtitle">{activeHolidayRecord.date} ({activeHolidayRecord.day})</p>
              </div>
              <button className="modal-close-x-btn" onClick={() => setActiveHolidayRecord(null)}>✕</button>
            </div>

            <div className="modal-card-body">
              <div className="form-grid-section shift-focus-card standard-diary-layout holiday-detail-card">
                <div className="form-input-field">
                  <label>Holiday Name</label>
                  <div className="view-readonly-value holiday-readonly-value">{activeHolidayRecord.name}</div>
                </div>
                <div className="form-input-field">
                  <label>Type</label>
                  <div className="view-readonly-value holiday-readonly-value">{activeHolidayRecord.type}</div>
                </div>
              </div>
            </div>

            <div className="modal-card-footer">
              <button type="button" className="modal-close-action-btn" onClick={() => setActiveHolidayRecord(null)}>Close View</button>
            </div>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}