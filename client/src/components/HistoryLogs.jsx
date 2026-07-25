import React, { useState, useRef, useEffect } from 'react';
import {
  fetchLogs,
  updateLog as updateLogApi,
  deleteLog as deleteLogApi,
  upsertAttendanceByDate,
  saveDiaryOnly
} from '../services/attendanceapi';

// How many placeholder rows the skeleton loader shows while the first
// fetch is in flight. Picked to roughly fill the card without looking
// like an obviously-fake exact match to real row count.
const SKELETON_ROW_COUNT = 5;

export default function HistoryLogs({ logs, setLogs, startDate }) {
  // Search and Filter State Managers
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("All");

  // Backend fetch state — separate from the modal/toast state below.
  const [isLoadingLogs, setIsLoadingLogs] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Modal Overlay & Status Banner State Managers
  const [activeViewLog, setActiveViewLog] = useState(null);    
  const [activeUpdateLog, setActiveUpdateLog] = useState(null); 
  const [activeDeleteLogId, setActiveDeleteLogId] = useState(null); 
  const [updateFormData, setUpdateFormData] = useState({});      
  const [activeShiftField, setActiveShiftField] = useState(null); 
  const [toastMessage, setToastMessage] = useState(null);
  const [isToastFading, setIsToastFading] = useState(false);

  // "Add Attendance History" — for backfilling a day the user forgot to
  // record. Separate state from the Update modal above since it needs an
  // editable Date field and starts from a blank form, not an existing log.
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [addFormData, setAddFormData] = useState({ date: '', amIn: '', amOut: '', pmIn: '', pmOut: '', diaryText: '' });
  const [activeAddShiftField, setActiveAddShiftField] = useState(null);
  const [isAdding, setIsAdding] = useState(false);
  const addAmInputRef = useRef(null);
  const addPmInputRef = useRef(null);
  const addDiaryInputRef = useRef(null);

  // DOM references to allow full card click targeting
  const amInputRef = useRef(null);
  const pmInputRef = useRef(null);
  const diaryInputRef = useRef(null);

  const isFormDirty = () => {
    if (!activeUpdateLog) return false;
    return (
      updateFormData.amIn !== activeUpdateLog.amIn ||
      updateFormData.amOut !== activeUpdateLog.amOut ||
      updateFormData.pmIn !== activeUpdateLog.pmIn ||
      updateFormData.pmOut !== activeUpdateLog.pmOut ||
      updateFormData.diaryText !== activeUpdateLog.diaryText
    );
  };

  // Same lenient rule as the Add modal's isAddFormValid: a record only
  // needs at least one shift time filled in — a lone Morning or Afternoon
  // shift (or even a single Time In with no Time Out yet) is a valid,
  // savable record on its own. Neither shift is individually required.
  const isUpdateFormValid = !!(
    updateFormData.amIn || updateFormData.amOut || updateFormData.pmIn || updateFormData.pmOut
  );

  // Hours/minutes are now computed server-side (attendance.service.js) and
  // returned by the API, so this component no longer calculates them —
  // it just displays whatever total_hours the backend already validated.

  const handleUpdateClick = (log) => {
    setActiveUpdateLog(log);
    setUpdateFormData({ ...log });
    setActiveShiftField(null); 
  };

  const handleFormChange = (field, value) => {
    setUpdateFormData(prev => ({ ...prev, [field]: value }));
  };

  // Looked up from `logs` (already in memory — no extra fetch needed) so
  // the Add modal can tell the person up front that saving this date will
  // update an existing record rather than create a new one.
  const existingLogForAddDate = addFormData.date
    ? logs.find(log => log.date === addFormData.date)
    : null;

  // Plain string comparison is safe here since both sides are ISO
  // 'YYYY-MM-DD' — no timezone conversion needed, unlike comparing Date
  // objects (which would shift the "today" boundary around midnight
  // depending on the browser's local timezone).
  const todayISO = new Date().toISOString().split('T')[0];
  const isAddDateInFuture = !!addFormData.date && addFormData.date > todayISO;

  // Same string-comparison approach, against the internship's configured
  // Start Date (set via MetricHeader's Update modal) — a backfilled record
  // can't predate the internship itself. Only checked once a start date is
  // actually configured; isConfigComplete elsewhere already guards the
  // whole History tab from being reachable before that's set.
  const isAddDateBeforeStart = !!addFormData.date && !!startDate && addFormData.date < startDate;

  const handleOpenAddModal = () => {
    setAddFormData({ date: '', amIn: '', amOut: '', pmIn: '', pmOut: '', diaryText: '' });
    setActiveAddShiftField(null);
    setIsAddModalOpen(true);
  };

  const handleAddFormChange = (field, value) => {
    setAddFormData(prev => ({ ...prev, [field]: value }));
  };

  const loadAttendanceLogs = async () => {
    setIsLoadingLogs(true);
    setLoadError(null);

    try {
      const data = await fetchLogs();
     setLogs(data);
   } catch (err) {
      setLoadError(err.message || 'Failed to load attendance history.');
   } finally {
      setIsLoadingLogs(false);
   }
  };

  const isAddFormValid = !!addFormData.date
    && !isAddDateInFuture
    && !isAddDateBeforeStart
    && (addFormData.amIn || addFormData.amOut || addFormData.pmIn || addFormData.pmOut);

  // Narrower than isAddFormValid — only true when the date itself is fine
  // and the sole remaining problem is a missing shift, so the footer hint
  // doesn't compete with the date-field error message above it.
  const isAddMissingShift = !!addFormData.date && !isAddDateInFuture && !isAddDateBeforeStart
    && !(addFormData.amIn || addFormData.amOut || addFormData.pmIn || addFormData.pmOut);

  const handleSaveAdd = async (e) => {
    e.preventDefault();
   if (!isAddFormValid || isAdding) return;

    const wasExisting = !!existingLogForAddDate;
   setIsAdding(true);

    try {
      // STEP 1: Save attendance first
      await upsertAttendanceByDate({
        date: addFormData.date,
        amIn: addFormData.amIn || null,
        amOut: addFormData.amOut || null,
        pmIn: addFormData.pmIn || null,
        pmOut: addFormData.pmOut || null,
        isCompleted: true,
      });

      // STEP 2: Save diary separately for the same date
      if (addFormData.diaryText?.trim()) {
        await saveDiaryOnly(
          addFormData.date,
          addFormData.diaryText.trim()
        );
      }

      // STEP 3: Reload all logs from the database
      await loadAttendanceLogs();

      // STEP 4: Reset the modal form
      setIsAddModalOpen(false);
      setAddFormData({
        date: '',
        amIn: '',
        amOut: '',
        pmIn: '',
        pmOut: '',
        diaryText: '',
      });

      // STEP 5: Show success message
      setToastMessage({
        text: wasExisting
          ? 'Existing record updated successfully!'
          : 'Attendance record added successfully!',
        type: 'success',
      });
      setIsToastFading(false);

    } catch (err) {
      setToastMessage({
        text: err.message || 'Failed to save attendance record.',
        type: 'danger',
      });
      setIsToastFading(false);
    } finally {
      setIsAdding(false);
    }
  };
    
  const handleSaveUpdate = async (e) => {
    e.preventDefault();
    if (!isFormDirty() || !isUpdateFormValid || isSaving) return;

    const id = activeUpdateLog.id;
    setIsSaving(true);

    try {
      const updatedLog = await updateLogApi(id, {
        amIn: updateFormData.amIn,
        amOut: updateFormData.amOut,
        pmIn: updateFormData.pmIn,
        pmOut: updateFormData.pmOut,
        diaryText: updateFormData.diaryText,
      });

      setLogs(prevLogs =>
        prevLogs.map(log =>
          log.id === id
            ? { ...log, ...updatedLog, submittedAt: updatedLog.submittedAt + " (Updated)" }
            : log
        )
      );

      setActiveUpdateLog(null);
      setToastMessage({ text: "Changes saved successfully!", type: "success" });
      setIsToastFading(false);
    } catch (err) {
      setToastMessage({ text: err.message || "Failed to save changes.", type: "danger" });
      setIsToastFading(false);
    } finally {
      setIsSaving(false);
    }
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

  useEffect(() => {
    loadAttendanceLogs();
  }, []);

  const handleDeleteTrigger = (id) => {
    setActiveDeleteLogId(id);
  };

  const confirmDeleteAction = async () => {
    const id = activeDeleteLogId;
    setIsDeleting(true);

    try {
      await deleteLogApi(id);
      setLogs(prevLogs => prevLogs.filter(log => log.id !== id));
      setActiveDeleteLogId(null);
      setToastMessage({ text: "Successfully deleted", type: "danger" });
      setIsToastFading(false);
    } catch (err) {
      setToastMessage({ text: err.message || "Failed to delete entry.", type: "danger" });
      setIsToastFading(false);
    } finally {
      setIsDeleting(false);
    }
  };

  const formatTimeToShow = (timeStr) => {
    if (!timeStr) return '--:--';
    const [hours, minutes] = timeStr.split(':');
    const h = parseInt(hours, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const displayHour = h % 12 === 0 ? 12 : h % 12;
    return `${displayHour}:${minutes} ${ampm}`;
  };

  const formatDateToShow = (dateString) => {
    if (!dateString) return '';

   // Split the YYYY-MM-DD string manually to avoid UTC timezone conversion
    const [year, month, day] = dateString.split('-').map(Number);

   // Create a local date instead of using new Date(dateString)
    const date = new Date(year, month - 1, day);

    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const renderDurationText = (hours, minutes) => {
    const hourLabel = hours === 1 ? 'Hour' : 'Hours';
    const minuteLabel = minutes === 1 ? 'minute' : 'minutes';
    
    if (minutes === 0) {
      return <span className="duration-line-hours">{hours} {hourLabel}</span>;
    }

    return (
      <div className="duration-stacked-layout">
        <span className="duration-line-hours">{hours} {hourLabel} &</span>
        <span className="duration-line-minutes">{minutes} {minuteLabel}</span>
      </div>
    );
  };

  // Combined Search and Filtering Matrix Engine
  const filteredLogs = logs.filter(log => {
    if (selectedMonth !== "All") {
      const logMonthNumber = parseInt(log.date.split('-')[1], 10);
      if (logMonthNumber !== parseInt(selectedMonth, 10)) return false;
    }

    const normalizedQuery = searchQuery.toLowerCase().trim();
    if (!normalizedQuery) return true;

    return (
      log.date.toLowerCase().includes(normalizedQuery) ||
      log.day.toLowerCase().includes(normalizedQuery) ||
      log.diaryText.toLowerCase().includes(normalizedQuery) ||
      (log.submittedAt && log.submittedAt.toLowerCase().includes(normalizedQuery))
    );
  });

  return (
    <div className="history-page-focused-container">
      <div className="history-card">
        {/* SUCCESS / DELETION TOAST NOTIFICATIONS — rendered inside a
            zero-height sticky anchor so the toast itself stays pinned at
            the vertical middle of the viewport while the (potentially very
            tall) log list scrolls underneath it, instead of being anchored
            to the bottom of the ever-growing card. */}
        <div className="toast-sticky-anchor">
          {toastMessage && (
            <div className={`toast-notification-banner toast-${toastMessage.type} ${isToastFading ? 'fade-out-active' : ''}`}>
              <span>{toastMessage.type === 'success' ? '✅' : '🗑️'} {toastMessage.text}</span>
            </div>
          )}
        </div>

        <div className="history-header">
          <div>
            <h3 className="history-title">📋 Attendance History & Narrative Archive</h3>
            <p className="history-subtitle">Review, update, search, or clear historical logging rows effortlessly.</p>
          </div>
        </div>

        {/* SEARCH AND FILTER INTERACTION BAR */}
        <div className="filter-utilities-panel">
          <div className="search-input-wrapper">
            <span className="input-utility-icon">🔍</span>
            <input 
              type="text"
              className="filter-search-field"
              placeholder="Search dates, days, keywords, accomplishments..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="dropdown-select-wrapper">
            <span className="input-utility-icon">📅</span>
            <select 
              className="filter-dropdown-select"
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
            >
              <option value="All">All Months</option>
              <option value="01">January</option>
              <option value="02">February</option>
              <option value="03">March</option>
              <option value="04">April</option>
              <option value="05">May</option>
              <option value="06">June</option>
              <option value="07">July</option>
              <option value="08">August</option>
              <option value="09">September</option>
              <option value="10">October</option>
              <option value="11">November</option>
              <option value="12">December</option>
            </select>
          </div>
        </div>

        {/* DATA CONTAINER INTERACTIVE GRID */}
        {isLoadingLogs ? (
          <div className="table-responsive">
            <table className="history-table" aria-hidden="true" aria-busy="true">
              <thead>
                <tr>
                  <th>Timeline Info</th>
                  <th>Morning (AM)</th>
                  <th>Afternoon (PM)</th>
                  <th>Total Duration</th>
                  <th>Narrative Diary Summary</th>
                  <th className="text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
                  <tr key={`skeleton-${i}`} className="skeleton-tr">
                    <td data-label="Timeline Info" className="history-date-cell">
                      <span className="skeleton-bar skeleton-bar-date" />
                      <span className="skeleton-bar skeleton-bar-day" />
                    </td>

                    <td data-label="Morning (AM)">
                      <span className="skeleton-bar skeleton-bar-time" />
                      <span className="skeleton-bar skeleton-bar-time" />
                    </td>

                    <td data-label="Afternoon (PM)">
                      <span className="skeleton-bar skeleton-bar-time" />
                      <span className="skeleton-bar skeleton-bar-time" />
                    </td>

                    <td data-label="Total Duration" className="history-hours-cell">
                      <span className="skeleton-bar skeleton-bar-duration" />
                    </td>

                    <td data-label="Narrative Diary" className="history-diary-cell">
                      <span className="skeleton-bar skeleton-bar-diary-1" />
                      <span className="skeleton-bar skeleton-bar-diary-2" />
                    </td>

                    <td data-label="Actions" className="history-actions-cell">
                      <div className="actions-btn-stack">
                        <span className="skeleton-bar skeleton-bar-btn" />
                        <span className="skeleton-bar skeleton-bar-btn" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : loadError ? (
          <div className="empty-state-fallback">
            <div className="empty-state-icon">⚠️</div>
            <h4 className="empty-state-title">Couldn't load attendance history</h4>
            <p className="empty-state-subtitle">{loadError}</p>
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="empty-state-fallback">
            <div className="empty-state-icon">📂</div>
            <h4 className="empty-state-title">No attendance records found</h4>
            <p className="empty-state-subtitle">Try selecting a different month status or modifying your current search query keywords.</p>
          </div>
        ) : (
          <div className="table-responsive">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Timeline Info</th>
                  <th>Morning (AM)</th>
                  <th>Afternoon (PM)</th>
                  <th>Total Duration</th>
                  <th>Narrative Diary Summary</th>
                  <th className="text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((log) => (
                  <tr key={log.id}>
                    <td data-label="Timeline Info" className="history-date-cell">
                      <div className="log-primary-date">{formatDateToShow(log.date)}</div>
                      <div className="log-secondary-day">{log.day}</div>
                    </td>
                    
                    <td data-label="Morning (AM)">
                      <div className="punch-sub-row">In: <span className="time-val">{formatTimeToShow(log.amIn)}</span></div>
                      <div className="punch-sub-row">Out: <span className="time-val">{formatTimeToShow(log.amOut)}</span></div>
                    </td>
                    
                    <td data-label="Afternoon (PM)">
                      <div className="punch-sub-row">In: <span className="time-val">{formatTimeToShow(log.pmIn)}</span></div>
                      <div className="punch-sub-row">Out: <span className="time-val">{formatTimeToShow(log.pmOut)}</span></div>
                    </td>
                    
                    <td data-label="Total Duration" className="history-hours-cell">
                      {renderDurationText(log.hours, log.minutes)}
                    </td>
                    
                    <td data-label="Narrative Diary" className="history-diary-cell">
                      <div className="diary-inline-container">
                        <p className="row-truncated-text">"{log.diaryText}"</p>
                        <button 
                          type="button"
                          className="diary-view-trigger-btn"
                          onClick={() => setActiveViewLog(log)}
                        >
                          🔍 View Full
                        </button>
                      </div>
                    </td>
                    
                    <td data-label="Actions" className="history-actions-cell">
                      <div className="actions-btn-stack">
                        <button 
                          onClick={() => handleUpdateClick(log)} 
                          className="action-btn btn-update"
                        >
                          🔄 Update
                        </button>
                        <button 
                          onClick={() => handleDeleteTrigger(log.id)} 
                          className="action-btn btn-delete"
                        >
                          🗑️ Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!isLoadingLogs && !loadError && (
          <button
            type="button"
            className="add-history-btn"
            onClick={handleOpenAddModal}
          >
            ➕ Add Attendance History
          </button>
        )}

        {/* MODAL VIEWERS */}
        {activeViewLog && (
          <div className="diary-modal-overlay" onClick={() => setActiveViewLog(null)}>
            <div className="diary-modal-card" onClick={(e) => e.stopPropagation()}>
              <div className="modal-card-header">
                <div>
                  <h4 className="modal-card-title">📝 Full Narrative Accomplishment Diary</h4>
                  <p className="modal-card-subtitle">{formatDateToShow(activeViewLog.date)} ({activeViewLog.day})</p>
                </div>
                <button className="modal-close-x-btn" onClick={() => setActiveViewLog(null)}>✕</button>
              </div>
              <div className="modal-card-body max-height-view">
                <p className="modal-diary-fulltext">"{activeViewLog.diaryText}"</p>
              </div>
              <div className="modal-card-footer">
                <span className="modal-footer-timestamp">✍️ Logged: {activeViewLog.submittedAt}</span>
                <button type="button" className="modal-close-action-btn" onClick={() => setActiveViewLog(null)}>Close View</button>
              </div>
            </div>
          </div>
        )}

        {activeUpdateLog && (
          <div className="diary-modal-overlay" onClick={() => setActiveUpdateLog(null)}>
            <form className="diary-modal-card diary-modal-card-wide" onClick={(e) => e.stopPropagation()} onSubmit={handleSaveUpdate}>
              <div className="modal-card-header">
                <div>
                  <h4 className="modal-card-title">🔄 Update Attendance & Narrative Logs</h4>
                  <p className="modal-card-subtitle">Editing entry for {formatDateToShow(activeUpdateLog.date)} ({activeUpdateLog.day})</p>
                </div>
                <button type="button" className="modal-close-x-btn" onClick={() => setActiveUpdateLog(null)}>✕</button>
              </div>
              
              <div className="modal-card-body modal-form-scrollable">
                <div className="modal-form-desktop-split">
                <div className="modal-form-grid">
                  <div 
                    className={`form-grid-section shift-focus-card clickable-form-card ${
                      activeShiftField === 'AM' ? 'focused-shift' : activeShiftField ? 'dimmed-shift' : ''
                    }`}
                    onClick={() => amInputRef.current?.focus()}
                  >
                    <h5 className="form-section-heading">🌅 Morning Shift (AM)</h5>
                    <div className="form-input-field" onClick={(e) => e.stopPropagation()}>
                      <label>Time In</label>
                      <input 
                        ref={amInputRef}
                        type="time" 
                        max="11:59" 
                        value={updateFormData.amIn || ''} 
                        onChange={(e) => handleFormChange('amIn', e.target.value)} 
                        onFocus={() => setActiveShiftField('AM')}
                        onBlur={() => setActiveShiftField(null)}
                      />
                    </div>
                    <div className="form-input-field" onClick={(e) => e.stopPropagation()}>
                      <label>Time Out</label>
                      <input 
                        type="time" 
                        value={updateFormData.amOut || ''} 
                        onChange={(e) => handleFormChange('amOut', e.target.value)} 
                        onFocus={() => setActiveShiftField('AM')}
                        onBlur={() => setActiveShiftField(null)}
                      />
                    </div>
                  </div>

                  <div 
                    className={`form-grid-section shift-focus-card clickable-form-card ${
                      activeShiftField === 'PM' ? 'focused-shift' : activeShiftField ? 'dimmed-shift' : ''
                    }`}
                    onClick={() => pmInputRef.current?.focus()}
                  >
                    <h5 className="form-section-heading">🌤️ Afternoon Shift (PM)</h5>
                    <div className="form-input-field" onClick={(e) => e.stopPropagation()}>
                      <label>Time In</label>
                      <input 
                        ref={pmInputRef}
                        type="time" 
                        value={updateFormData.pmIn || ''} 
                        onChange={(e) => handleFormChange('pmIn', e.target.value)} 
                        onFocus={() => setActiveShiftField('PM')}
                        onBlur={() => setActiveShiftField(null)}
                      />
                    </div>
                    <div className="form-input-field" onClick={(e) => e.stopPropagation()}>
                      <label>Time Out</label>
                      <input 
                        type="time" 
                        value={updateFormData.pmOut || ''} 
                        onChange={(e) => handleFormChange('pmOut', e.target.value)} 
                        onFocus={() => setActiveShiftField('PM')}
                        onBlur={() => setActiveShiftField(null)}
                      />
                    </div>
                  </div>
                </div>

                <div 
                  className={`form-textarea-section shift-focus-card clickable-form-card ${
                    activeShiftField === 'DIARY' ? 'focused-diary' : 'standard-diary-layout'
                  }`}
                  onClick={() => diaryInputRef.current?.focus()}
                >
                  <h5 className="form-section-heading">📝 Accomplishment Summary</h5>
                  <div className="form-textarea-field" onClick={(e) => e.stopPropagation()}>
                    <label>Narrative Diary Summary</label>
                    <textarea 
                      ref={diaryInputRef}
                      value={updateFormData.diaryText || ''} 
                      onChange={(e) => handleFormChange('diaryText', e.target.value)} 
                      rows={4} 
                      onFocus={() => setActiveShiftField('DIARY')}
                      onBlur={() => setActiveShiftField(null)}
                      placeholder="Describe your primary technical operations, accomplishments..."
                      required
                    />
                  </div>
                </div>
                </div>
              </div>

              <div className="modal-card-footer">
                {!isUpdateFormValid && (
                  <span className="field-error-text modal-footer-hint">
                    ⚠️ At least one shift time is required.
                  </span>
                )}
                <button type="button" className="modal-cancel-inline-btn" onClick={() => setActiveUpdateLog(null)}>Cancel</button>
                <button type="submit" className="modal-save-action-btn" disabled={!isFormDirty() || !isUpdateFormValid || isSaving}>
                  {isSaving ? 'Saving…' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        )}

        {isAddModalOpen && (
          <div className="diary-modal-overlay" onClick={() => setIsAddModalOpen(false)}>
            <form className="diary-modal-card diary-modal-card-wide" onClick={(e) => e.stopPropagation()} onSubmit={handleSaveAdd}>
              <div className="modal-card-header">
                <div>
                  <h4 className="modal-card-title">➕ Add Attendance History</h4>
                  <p className="modal-card-subtitle">Backfill a day you forgot to record.</p>
                </div>
                <button type="button" className="modal-close-x-btn" onClick={() => setIsAddModalOpen(false)}>✕</button>
              </div>

              <div className="modal-card-body modal-form-scrollable">
                <div className="form-input-field">
                  <label htmlFor="add-history-date">Date</label>
                  <input
                    id="add-history-date"
                    type="date"
                    value={addFormData.date}
                    onChange={(e) => handleAddFormChange('date', e.target.value)}
                    min={startDate || undefined}
                    max={todayISO}
                    required
                    aria-invalid={isAddDateInFuture || isAddDateBeforeStart}
                    aria-describedby={(isAddDateInFuture || isAddDateBeforeStart) ? 'add-history-date-error' : undefined}
                    className={(isAddDateInFuture || isAddDateBeforeStart) ? 'field-input-error' : undefined}
                  />
                  {isAddDateInFuture && (
                    <p id="add-history-date-error" className="field-error-text">
                      ⚠️ Attendance date can't be in the future.
                    </p>
                  )}
                  {!isAddDateInFuture && isAddDateBeforeStart && (
                    <p id="add-history-date-error" className="field-error-text">
                      ⚠️ Attendance date can't be earlier than the internship's Start Date ({new Date(startDate).toLocaleDateString()}).
                    </p>
                  )}
                </div>

                {existingLogForAddDate && (
                  <p className="existing-record-notice">
                    ⚠️ A record for this date already exists. Saving will update that entry instead of creating a new one.
                  </p>
                )}

                <div className="modal-form-desktop-split">
                <div className="modal-form-grid">
                  <div
                    className={`form-grid-section shift-focus-card clickable-form-card ${
                      activeAddShiftField === 'AM' ? 'focused-shift' : activeAddShiftField ? 'dimmed-shift' : ''
                    }`}
                    onClick={() => addAmInputRef.current?.focus()}
                  >
                    <h5 className="form-section-heading">🌅 Morning Shift (AM)</h5>
                    <div className="form-input-field" onClick={(e) => e.stopPropagation()}>
                      <label>Time In</label>
                      <input
                        ref={addAmInputRef}
                        type="time"
                        max="11:59"
                        value={addFormData.amIn || ''}
                        onChange={(e) => handleAddFormChange('amIn', e.target.value)}
                        onFocus={() => setActiveAddShiftField('AM')}
                        onBlur={() => setActiveAddShiftField(null)}
                      />
                    </div>
                    <div className="form-input-field" onClick={(e) => e.stopPropagation()}>
                      <label>Time Out</label>
                      <input
                        type="time"
                        value={addFormData.amOut || ''}
                        onChange={(e) => handleAddFormChange('amOut', e.target.value)}
                        onFocus={() => setActiveAddShiftField('AM')}
                        onBlur={() => setActiveAddShiftField(null)}
                      />
                    </div>
                  </div>

                  <div
                    className={`form-grid-section shift-focus-card clickable-form-card ${
                      activeAddShiftField === 'PM' ? 'focused-shift' : activeAddShiftField ? 'dimmed-shift' : ''
                    }`}
                    onClick={() => addPmInputRef.current?.focus()}
                  >
                    <h5 className="form-section-heading">🌤️ Afternoon Shift (PM)</h5>
                    <div className="form-input-field" onClick={(e) => e.stopPropagation()}>
                      <label>Time In</label>
                      <input
                        ref={addPmInputRef}
                        type="time"
                        value={addFormData.pmIn || ''}
                        onChange={(e) => handleAddFormChange('pmIn', e.target.value)}
                        onFocus={() => setActiveAddShiftField('PM')}
                        onBlur={() => setActiveAddShiftField(null)}
                      />
                    </div>
                    <div className="form-input-field" onClick={(e) => e.stopPropagation()}>
                      <label>Time Out</label>
                      <input
                        type="time"
                        value={addFormData.pmOut || ''}
                        onChange={(e) => handleAddFormChange('pmOut', e.target.value)}
                        onFocus={() => setActiveAddShiftField('PM')}
                        onBlur={() => setActiveAddShiftField(null)}
                      />
                    </div>
                  </div>
                </div>

                <div
                  className={`form-textarea-section shift-focus-card clickable-form-card ${
                    activeAddShiftField === 'DIARY' ? 'focused-diary' : 'standard-diary-layout'
                  }`}
                  onClick={() => addDiaryInputRef.current?.focus()}
                >
                  <h5 className="form-section-heading">📝 Accomplishment Summary</h5>
                  <div className="form-textarea-field" onClick={(e) => e.stopPropagation()}>
                    <label>Narrative Diary Summary (optional)</label>
                    <textarea
                      ref={addDiaryInputRef}
                      value={addFormData.diaryText || ''}
                      onChange={(e) => handleAddFormChange('diaryText', e.target.value)}
                      rows={4}
                      onFocus={() => setActiveAddShiftField('DIARY')}
                      onBlur={() => setActiveAddShiftField(null)}
                      placeholder="Describe your primary technical operations, accomplishments..."
                    />
                  </div>
                </div>
                </div>
              </div>

              <div className="modal-card-footer">
                {isAddMissingShift && (
                  <span className="field-error-text modal-footer-hint">
                    ⚠️ At least one shift time is required.
                  </span>
                )}
                <button type="button" className="modal-cancel-inline-btn" onClick={() => setIsAddModalOpen(false)}>Cancel</button>
                <button type="submit" className="modal-save-action-btn" disabled={!isAddFormValid || isAdding}>
                  {isAdding
                    ? 'Saving…'
                    : existingLogForAddDate
                      ? 'Update Existing Record'
                      : 'Add Record'}
                </button>
              </div>
            </form>
          </div>
        )}

        {activeDeleteLogId && (
          <div className="diary-modal-overlay" onClick={() => setActiveDeleteLogId(null)}>
            <div className="diary-modal-card confirm-delete-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-card-header delete-header">
                <div>
                  <h4 className="modal-card-title text-danger">⚠️ Confirm Deletion</h4>
                  <p className="modal-card-subtitle">This action cannot be undone</p>
                </div>
                <button type="button" className="modal-close-x-btn close-x-danger" onClick={() => setActiveDeleteLogId(null)}>✕</button>
              </div>
              <div className="modal-card-body text-center-padding">
                <div className="delete-alert-icon">🗑️</div>
                <p className="delete-warning-text">
                  Are you absolutely sure you want to delete this historical entry? All associated afternoon/morning time punch files and daily narrative logs will be permanently erased.
                </p>
              </div>
              <div className="modal-card-footer delete-footer">
                <button type="button" className="modal-cancel-inline-btn" onClick={() => setActiveDeleteLogId(null)}>Cancel</button>
                <button type="button" className="modal-confirm-delete-btn" onClick={confirmDeleteAction} disabled={isDeleting}>
                  {isDeleting ? 'Deleting…' : 'Yes, Delete Entry'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}