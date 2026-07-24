import React, { useState, useEffect, useMemo } from 'react';

// ==========================================
// ENVIRONMENT VARIABLE CONFIGURATION
// ==========================================
const GOOGLE_API_KEY = import.meta.env.VITE_GOOGLE_CALENDAR_API_KEY;

// Public Philippines Holiday Calendar ID — same calendar AttendanceCalendar
// displays. Fetched here independently (scoped to whichever years the
// forecast needs) purely so the projection walks real working days —
// Mon–Fri, minus public holidays — instead of raw calendar days.
const CALENDAR_ID = encodeURIComponent("en.philippines#holiday@group.v.calendar.google.com");

// Safety valve so a pathological input can never hang the browser walking
// forward indefinitely.
const MAX_LOOKAHEAD_DAYS = 5 * 365;

// Standard workday length used to (a) convert total required hours into a
// baseline number of required working days, and (b) translate the gap
// between logged hours and that baseline's expectation-by-now into an
// attendance-based schedule adjustment.
const STANDARD_HOURS_PER_WORKDAY = 8;

// ==========================================
// INTERNSHIP COMPLETION FORECAST — helpers
// ==========================================

function isWeekendDate(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

// Local calendar-day key (not UTC), so date-only comparisons never drift a
// day off in negative-UTC-offset timezones.
function toISODateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Fetches Philippines public holidays for the given years and returns a Set
// of "YYYY-MM-DD" strings.
async function fetchHolidaySet(years) {
  const holidaySet = new Set();

  if (!GOOGLE_API_KEY) {
    console.warn("Google Calendar API key missing. Forecast will skip weekends but not holidays until this is configured.");
    return holidaySet;
  }

  await Promise.all(years.map(async (year) => {
    const timeMin = encodeURIComponent(`${year}-01-01T00:00:00Z`);
    const timeMax = encodeURIComponent(`${year}-12-31T23:59:59Z`);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${CALENDAR_ID}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&key=${GOOGLE_API_KEY}`;

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch holiday calendar for ${year}`);
      const data = await response.json();
      (data.items || []).forEach(event => {
        const dateStr = event.start?.date || event.start?.dateTime?.split('T')[0];
        if (dateStr) holidaySet.add(dateStr);
      });
    } catch (error) {
      console.error("Forecast holiday fetch error:", error);
    }
  }));

  return holidaySet;
}

// Single primitive for every workday-calendar walk in this file: starting
// at `from`, steps forward day by day, skipping weekends and public
// holidays, until either `until` is reached (inclusive) or `targetCount`
// working days have been counted — whichever stopping condition is
// supplied. Both the "how many workdays have elapsed since start" count and
// the "what date lands N workdays from start" projection are the same walk
// with a different stop condition, so they share this one loop instead of
// duplicating it.
//
// Also doubles as the safety valve: MAX_LOOKAHEAD_DAYS caps how many
// calendar days it will ever step through, so a pathological input (e.g. a
// start date decades in the past, or a target count that's absurdly large)
// can't hang the browser walking forward indefinitely.
function walkWorkdays({ from, until = null, targetCount = null, holidaySet }) {
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);

  let untilMidnight = null;
  if (until) {
    untilMidnight = new Date(until);
    untilMidnight.setHours(0, 0, 0, 0);
  }

  if (targetCount != null && targetCount <= 0) {
    return { date: cursor, count: 0, safety: 0 };
  }
  if (untilMidnight && cursor > untilMidnight) {
    return { date: cursor, count: 0, safety: 0 };
  }

  let count = 0;
  let safety = 0;

  while (safety < MAX_LOOKAHEAD_DAYS) {
    const reachedEndDate = untilMidnight ? cursor > untilMidnight : false;
    const reachedTargetCount = untilMidnight ? false : count >= targetCount;
    if (reachedEndDate || reachedTargetCount) break;

    if (!isWeekendDate(cursor) && !holidaySet.has(toISODateKey(cursor))) {
      count += 1;
    }

    // In target-count mode, stop right on the day the count is reached so
    // the returned date lands on that working day, not the day after it.
    if (targetCount != null && count >= targetCount) break;

    cursor.setDate(cursor.getDate() + 1);
    safety += 1;
  }

  return { date: cursor, count, safety };
}

/**
 * Projects the intern's likely completion date using a standard 8-hour
 * workday as the baseline, then adjusts that baseline for how the intern
 * has actually been tracking against it.
 *
 * 1. Baseline duration: `estimatedHours / STANDARD_HOURS_PER_WORKDAY`,
 *    rounded up — the exact number of required working days assuming a
 *    full 8-hour day, every workday, no absences.
 * 2. Baseline mapping: that many working days are walked forward from
 *    `startDate` across the real calendar — Saturdays, Sundays, and public
 *    holidays are skipped — landing on an unadjusted target date.
 * 3. Attendance adjustment: `elapsedWorkdays * STANDARD_HOURS_PER_WORKDAY`
 *    is what a perfect-attendance intern would have logged by today.
 *    Comparing that to the intern's real `grandTotalHours` gives a surplus
 *    or deficit, converted to whole working days and added to (or
 *    subtracted from) the baseline day count before the final calendar walk
 *    — so a history of shorter/missed days pushes the date later, and a
 *    history of longer days or no absences pulls it earlier.
 *
 * Note: this only has access to a running hours total, not a per-day
 * attendance log, so "attendance pattern" here means cumulative logged
 * hours vs. the standard-pace expectation-by-now, not literal day-by-day
 * presence/absence flags.
 *
 * Returns a status object so the UI can render a specific message per state:
 *   - 'no-target'       estimatedHours isn't set yet
 *   - 'no-start-date'   startDate isn't set yet
 *   - 'completed'       required hours are already met
 *   - 'unbounded'       required working days is too large to project safely
 *   - 'projected'       { date, requiredWorkdays, adjustmentWorkdays, workdaysNeeded, isAdjustedForAttendance }
 */
function projectCompletionDate({ estimatedHours, grandTotalHours, startDate, holidaySet, today = new Date() }) {
  if (!startDate) {
    return { status: 'no-start-date' };
  }
  if (!estimatedHours || estimatedHours <= 0) {
    return { status: 'no-target' };
  }

  const remainingHours = Math.max(estimatedHours - grandTotalHours, 0);
  if (remainingHours <= 0) {
    return { status: 'completed' };
  }

  // Step 1: baseline required working days at a standard 8-hr/day pace.
  const requiredWorkdays = Math.ceil(estimatedHours / STANDARD_HOURS_PER_WORKDAY);

  // Step 3 inputs: how many working days have elapsed since start, and how
  // many hours a perfect-attendance intern would have logged by now.
  const elapsedWorkdays = walkWorkdays({ from: startDate, until: today, holidaySet }).count;
  const expectedHoursByNow = elapsedWorkdays * STANDARD_HOURS_PER_WORKDAY;

  // Positive delta = ahead of the standard pace, negative = behind. Convert
  // to whole working days and flip the sign: behind schedule -> positive
  // adjustment (pushes completion later); ahead -> negative (pulls it in).
  const attendanceDeltaHours = grandTotalHours - expectedHoursByNow;
  const adjustmentWorkdays = -Math.round(attendanceDeltaHours / STANDARD_HOURS_PER_WORKDAY);
  const isAdjustedForAttendance = elapsedWorkdays > 0 && adjustmentWorkdays !== 0;

  // Total working days to walk from startDate. Floored at elapsedWorkdays + 1
  // since remainingHours > 0 here, so there's always at least one working
  // day still ahead — this keeps a large "ahead of schedule" surplus from
  // ever projecting a completion date in the past.
  const totalWorkdaysFromStart = Math.max(
    requiredWorkdays + adjustmentWorkdays,
    elapsedWorkdays + 1
  );

  const { date, safety } = walkWorkdays({
    from: startDate,
    targetCount: totalWorkdaysFromStart,
    holidaySet,
  });

  if (safety >= MAX_LOOKAHEAD_DAYS) {
    return { status: 'unbounded' };
  }

  return {
    status: 'projected',
    date,
    requiredWorkdays,
    adjustmentWorkdays,
    workdaysNeeded: Math.max(totalWorkdaysFromStart - elapsedWorkdays, 0),
    isAdjustedForAttendance,
  };
}

export default function MetricHeader({
  estimatedHours,
  setEstimatedHours,
  grandTotalHours,
  startDate,
  setStartDate,
  onSave,
  isSaving,
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [draftHours, setDraftHours] = useState(estimatedHours);
  const [draftStartDate, setDraftStartDate] = useState(startDate || '');
  const [saveError, setSaveError] = useState(null);

  // Gates every other configuration option (the inline quick-edit trigger)
  // until both required setup fields have a real, saved value — not just
  // a truthy one, since 0 hours or an empty string are both "not set yet".
  const isHoursConfigured = Number.isInteger(estimatedHours) && estimatedHours > 0;
  const isStartDateConfigured = !!startDate && !Number.isNaN(new Date(startDate).getTime());
  const isConfigComplete = isHoursConfigured && isStartDateConfigured;

  // Same validation applied to the modal's in-progress draft values, so
  // "Save Changes" can't be clicked with an incomplete/invalid setup.
  const draftHoursNumber = parseInt(draftHours, 10);
  const isDraftHoursValid = Number.isInteger(draftHoursNumber) && draftHoursNumber > 0;
  const isDraftStartDateValid = !!draftStartDate && !Number.isNaN(new Date(draftStartDate).getTime());
  const isDraftValid = isDraftHoursValid && isDraftStartDateValid;

  // Calculate progress percentage, capped at 100% (guarded against divide-by-zero)
  const progressPercentage = estimatedHours > 0
    ? Math.min((grandTotalHours / estimatedHours) * 100, 100)
    : 0;

  const remainingHours = Math.max(estimatedHours - grandTotalHours, 0);

  // ==========================================
  // INTERNSHIP COMPLETION FORECAST
  // ==========================================
  // Holiday coverage: the intern's start year through one year past today,
  // which comfortably covers both the elapsed-workday count and the
  // forward-looking projection. Re-fetched only when the start date changes.
  const [holidaySet, setHolidaySet] = useState(new Set());
  const [isHolidayDataLoading, setIsHolidayDataLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const now = new Date();
    const startYear = startDate ? new Date(startDate).getFullYear() : now.getFullYear();
    const endYear = now.getFullYear() + 1;

    const years = [];
    for (let y = Math.min(startYear, endYear); y <= endYear; y++) years.push(y);

    setIsHolidayDataLoading(true);
    fetchHolidaySet(years).then((set) => {
      if (!cancelled) {
        setHolidaySet(set);
        setIsHolidayDataLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [startDate]);

  const forecast = useMemo(() => {
    return projectCompletionDate({
      estimatedHours,
      grandTotalHours,
      startDate,
      holidaySet,
      today: new Date(),
    });
  }, [estimatedHours, grandTotalHours, startDate, holidaySet]);

  const forecastDisplay = useMemo(() => {
    switch (forecast.status) {
      case 'completed':
        return { label: 'Target Reached', value: '🎉 Completed', hint: 'Required hours already met.' };
      case 'projected': {
        const dateLabel = forecast.date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
        const baselineNote = `Baseline: ${forecast.requiredWorkdays} working day${forecast.requiredWorkdays === 1 ? '' : 's'} at a standard 8 hrs/day, mapped from your start date.`;
        let attendanceNote = '';
        if (forecast.isAdjustedForAttendance) {
          const absDays = Math.abs(forecast.adjustmentWorkdays);
          attendanceNote = forecast.adjustmentWorkdays > 0
            ? ` You're currently behind that pace, adding ~${absDays} working day${absDays === 1 ? '' : 's'}.`
            : ` You're currently ahead of that pace, saving ~${absDays} working day${absDays === 1 ? '' : 's'}.`;
        }
        return {
          label: forecast.isAdjustedForAttendance ? 'Projected Completion (adjusted)' : 'Projected Completion',
          value: dateLabel,
          hint: `${baselineNote}${attendanceNote} ~${forecast.workdaysNeeded} working day${forecast.workdaysNeeded === 1 ? '' : 's'} remaining. Weekends and public holidays are excluded.`,
        };
      }
      case 'unbounded':
        return { label: 'Projected Completion', value: 'Unavailable', hint: 'Required hours are too large to project a reliable date right now.' };
      case 'no-start-date':
        return { label: 'Projected Completion', value: 'Set a start date', hint: 'Add an official start date in Update to enable forecasting.' };
      case 'no-target':
      default:
        return { label: 'Projected Completion', value: 'Set required hours', hint: 'Add your total required hours in Update to enable forecasting.' };
    }
  }, [forecast]);

  const openModal = () => {
    setDraftHours(estimatedHours);
    setDraftStartDate(startDate || '');
    setSaveError(null);
    setIsModalOpen(true);
  };

  // Persists via onSave (if provided — OJTDashboard passes a function that
  // calls the backend) before updating local state. Falls back to the raw
  // setters directly if no onSave is given, so this component still works
  // standalone (e.g. isolation/storybook-style previews) without a parent
  // wiring up persistence.
  const handleSave = async () => {
    if (!isDraftValid) return;

    const nextHours = draftHoursNumber;
    const nextStartDate = draftStartDate;

    if (typeof onSave === 'function') {
      try {
        setSaveError(null);
        await onSave({ estimatedHours: nextHours, startDate: nextStartDate });
        setIsModalOpen(false);
      } catch (err) {
        // Keep the modal open so the person can retry instead of silently
        // losing their edits.
        setSaveError(err.message || 'Failed to save. Please try again.');
      }
      return;
    }

    setEstimatedHours(nextHours);
    setStartDate(nextStartDate);
    setIsModalOpen(false);
  };

  const handleCancel = () => setIsModalOpen(false);

  return (
    <div className="metric-card">
      {/* Configuration Modal Trigger — pinned to the card's top-right corner */}
      <button 
        type="button"
        className="metric-config-button" 
        onClick={openModal}
        aria-label="Open internship configuration"
      >
        <span className="metric-config-icon" aria-hidden="true">⚙</span>
        Update
      </button>

      <div className="metric-layout-row">
        <div>
          <h2 className="metric-main-title">Internship Overview</h2>
          <p className="metric-subtitle">Track, monitor, and configure your overall training milestones.</p>
        </div>

        {!isConfigComplete && (
          <div role="status" className="metric-setup-banner">
            <span>⚠️ Finish setup to unlock the rest of your tracker:</span>
            <span className="metric-setup-banner-step">
              {isHoursConfigured ? '✅' : '① '} Required Hours
            </span>
            <span className="metric-setup-banner-step">
              {isStartDateConfigured ? '✅' : '② '} Start Date
            </span>
            <button
              type="button"
              onClick={openModal}
              className="metric-setup-banner-cta"
            >
              Complete Setup
            </button>
          </div>
        )}

        <div className="metric-badge-container">
          {/* Target Hour Display Block — read-only; all edits go through
              the Update button/modal above, which is also the only place
              the required Start Date can be set. */}
          <div className="metric-badge metric-badge-slate">
            <span className="metric-badge-label label-slate">Required Hours</span>
            <span className="metric-value-slate">
              {estimatedHours || 0}
            </span>
          </div>

          {/* Rendered Accumulator Display Badge */}
          <div className="metric-badge metric-badge-emerald">
            <span className="metric-badge-label label-emerald">Total Rendered</span>
            <span className="metric-value-emerald">
              {grandTotalHours.toFixed(1)} hrs
            </span>
          </div>

          {/* Remaining Hours Display Badge */}
          <div className="metric-badge metric-badge-amber">
            <span className="metric-badge-label label-amber">Remaining</span>
            <span className="metric-value-amber">
              {remainingHours.toFixed(1)} hrs
            </span>
          </div>

          {/* Forecasted Completion Date Badge */}
          <div
            className="metric-badge metric-badge-indigo"
            title={forecastDisplay.hint}
          >
            <span className="metric-badge-label label-indigo">
              {forecastDisplay.label}
              {isHolidayDataLoading && <span className="metric-forecast-spinner">⏳</span>}
            </span>
            <span className="metric-value-indigo">
              {forecastDisplay.value}
            </span>
          </div>
        </div>
      </div>

      {/* Progress Track Presentation */}
      <div className="progress-section">
        <div className="progress-text-row">
          <span>Completion Progress</span>
          <span className="progress-percent-count">{progressPercentage.toFixed(1)}%</span>
        </div>
        <div className="progress-track-wrapper">
          <div 
            className="progress-bar-fill" 
            style={{ width: `${progressPercentage}%` }}
          ></div>
        </div>
      </div>

      {/* Supplementary metrics derived from configuration */}
      {(startDate || forecast.status === 'projected') && (
        <div className="metric-meta-row">
          {startDate && (
            <span>Start Date: <strong>{new Date(startDate).toLocaleDateString()}</strong></span>
          )}
          {forecast.status === 'projected' && (
            <span>Est. Working Days Left: <strong>{forecast.workdaysNeeded}</strong></span>
          )}
        </div>
      )}

      {/* Configuration Modal */}
      {isModalOpen && (
        <div className="modal-overlay" onClick={handleCancel}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Internship Configuration</h3>
              <button 
                type="button"
                className="modal-close-btn" 
                onClick={handleCancel}
                aria-label="Close"
              >
                &times;
              </button>
            </div>

            <div className="modal-body">
              {saveError && (
                <p className="metric-config-error" role="alert">{saveError}</p>
              )}

              {!isDraftValid && (
                <div role="status" className="metric-modal-setup-banner">
                  <span>{isDraftHoursValid ? '✅' : '① '} Required Hours</span>
                  <span>{isDraftStartDateValid ? '✅' : '② '} Start Date</span>
                </div>
              )}

              <div className="modal-field">
                <label className="modal-label" htmlFor="required-hours-input">
                  Total Required Hours
                </label>
                <input
                  id="required-hours-input"
                  type="number"
                  min="0"
                  value={draftHours}
                  onChange={(e) => setDraftHours(e.target.value)}
                  className={`modal-input${!isDraftHoursValid ? ' modal-input-warning' : ''}`}
                />
              </div>

              <div className="modal-field">
                <label className="modal-label" htmlFor="start-date-input">
                  Official Start Date
                </label>
                <input
                  id="start-date-input"
                  type="date"
                  value={draftStartDate}
                  onChange={(e) => setDraftStartDate(e.target.value)}
                  className={`modal-input${!isDraftStartDateValid ? ' modal-input-warning' : ''}`}
                />
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="modal-btn modal-btn-secondary" onClick={handleCancel} disabled={isSaving}>
                Cancel
              </button>
              <button type="button" className="modal-btn modal-btn-primary" onClick={handleSave} disabled={isSaving || !isDraftValid}>
                {isSaving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}