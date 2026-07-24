import React, { useState, useMemo, useEffect } from 'react';
import { saveDiaryOnly, deleteDiaryEntry } from '../services/attendanceapi';

const WORD_LIMIT = 1000;

function countWords(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

// Local calendar-day key (not UTC) so "today" matches what the user sees on their clock.
function getDateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The diary "business date" for the currently active shiftState: its own .date if one was
// set (e.g. re-opened from History Logs for a past day), otherwise today.
function getShiftDateKey(state) {
  return state.date || getDateKey(new Date());
}

// Formats a "YYYY-MM-DD" key as a local date, avoiding the UTC-midnight shift that
// `new Date("YYYY-MM-DD")` would introduce in negative-UTC-offset timezones.
function formatDateKeyLabel(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

// Derives the shift status label from a set of time-in/out fields — used
// both for today's in-progress shiftState and for any past entry's
// corresponding row in `logs`. A shift only counts as "done" once it has
// BOTH a Time In and Time Out; a lone Time In isn't enough.
function getShiftStatus({ amIn, amOut, pmIn, pmOut } = {}) {
  const isAmComplete = !!(amIn && amOut);
  const isPmComplete = !!(pmIn && pmOut);

  if (isAmComplete && isPmComplete) return { label: 'Whole Day', variant: 'whole' };
  if (isAmComplete || isPmComplete) return { label: 'Half Day', variant: 'half' };
  return { label: 'No Punch Data', variant: 'none' };
}

export default function DiaryForm({ shiftState, setShiftState, logs = [] }) {
  const entries = shiftState.diaryEntries || [];
  const locked = shiftState.isCompleted;

  const activeDateKey = getShiftDateKey(shiftState);
  const activeEntry = entries.find(entry => entry.date === activeDateKey);
  const isActiveUnlocked = !!(shiftState.amIn || shiftState.amOut || shiftState.pmIn || shiftState.pmOut);

  // --- "Create first entry for the active date" panel ---
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [newDraft, setNewDraft] = useState('');
  const newWordCount = useMemo(() => countWords(newDraft), [newDraft]);
  const newOverLimit = newWordCount > WORD_LIMIT;

  // --- View / Edit modal (View is the entry point; Edit lives inside it) ---
  const [activeViewEntryId, setActiveViewEntryId] = useState(null);
  const [editingEntryId, setEditingEntryId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const editWordCount = useMemo(() => countWords(editDraft), [editDraft]);
  const editOverLimit = editWordCount > WORD_LIMIT;

  // --- Delete confirmation & toast feedback (mirrors HistoryLogs) ---
  const [activeDeleteEntryId, setActiveDeleteEntryId] = useState(null);
  const [toastMessage, setToastMessage] = useState(null);
  const [isToastFading, setIsToastFading] = useState(false);
  const [isSavingEntry, setIsSavingEntry] = useState(false);
  const [isDeletingEntry, setIsDeletingEntry] = useState(false);

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

  const handleNewDraftChange = (e) => {
    const text = e.target.value;
    const words = text.trim() === '' ? [] : text.trim().split(/\s+/);
    setNewDraft(words.length <= WORD_LIMIT ? text : words.slice(0, WORD_LIMIT).join(' '));
  };

  const handleCreateNew = async () => {
    const trimmedText = newDraft.trim();
    if (!trimmedText || isSavingEntry) return;

    const previous = shiftState;
    const alreadyExists = (shiftState.diaryEntries || []).some(entry => entry.date === activeDateKey);
    if (alreadyExists) return; // already exists, nothing to do

    setShiftState(prev => ({
      ...prev,
      diaryEntries: [...(prev.diaryEntries || []), { id: Date.now(), date: activeDateKey, text: trimmedText, timestamp: new Date().toISOString() }],
    }));
    setNewDraft('');
    setIsAddingNew(false);

    setIsSavingEntry(true);
    try {
      await saveDiaryOnly(activeDateKey, trimmedText);
      setToastMessage({ text: 'Diary entry saved successfully!', type: 'success' });
      setIsToastFading(false);
    } catch (err) {
      setShiftState(previous);
      setToastMessage({ text: err.message || 'Failed to save diary entry.', type: 'danger' });
      setIsToastFading(false);
    } finally {
      setIsSavingEntry(false);
    }
  };

  const handleCancelNew = () => {
    setNewDraft('');
    setIsAddingNew(false);
  };

  // --- View modal open/close ---
  const openViewModal = (entry) => {
    setActiveViewEntryId(entry.id);
    setEditingEntryId(null);
    setEditDraft('');
  };

  const closeViewModal = () => {
    setActiveViewEntryId(null);
    setEditingEntryId(null);
    setEditDraft('');
  };

  // --- Editing, entered only from inside the View modal ---
  const startEditing = (entry) => {
    setEditDraft(entry.text);
    setEditingEntryId(entry.id);
  };

  const handleEditDraftChange = (e) => {
    const text = e.target.value;
    const words = text.trim() === '' ? [] : text.trim().split(/\s+/);
    setEditDraft(words.length <= WORD_LIMIT ? text : words.slice(0, WORD_LIMIT).join(' '));
  };

  // Always updates the existing entry in place — never creates a new card for the same date.
  // Saving closes the modal and confirms with a toast.
  const handleSaveEdit = async (entryId) => {
    const trimmedText = editDraft.trim();
    if (!trimmedText || isSavingEntry) return;

    const targetEntry = entries.find(entry => entry.id === entryId);
    if (!targetEntry) return;

    const previous = shiftState;

    setShiftState(prev => ({
      ...prev,
      diaryEntries: (prev.diaryEntries || []).map(entry =>
        entry.id === entryId ? { ...entry, text: trimmedText, timestamp: new Date().toISOString() } : entry
      ),
    }));
    setEditingEntryId(null);
    setEditDraft('');
    setActiveViewEntryId(null);

    setIsSavingEntry(true);
    try {
      await saveDiaryOnly(targetEntry.date, trimmedText);
      setToastMessage({ text: 'Diary entry updated successfully!', type: 'success' });
      setIsToastFading(false);
    } catch (err) {
      setShiftState(previous);
      setToastMessage({ text: err.message || 'Failed to update diary entry.', type: 'danger' });
      setIsToastFading(false);
    } finally {
      setIsSavingEntry(false);
    }
  };

  // Cancelling edit returns to the View state within the same modal, rather than closing it
  const handleCancelEdit = () => {
    setEditingEntryId(null);
    setEditDraft('');
  };

  // Opens the confirmation modal rather than deleting immediately
  const handleDeleteTrigger = (id) => {
    setActiveDeleteEntryId(id);
  };

  const confirmDeleteAction = async () => {
    if (isDeletingEntry) return;

    const targetEntry = entries.find(entry => entry.id === activeDeleteEntryId);
    if (!targetEntry) return;

    const previous = shiftState;
    const wasViewing = activeViewEntryId === activeDeleteEntryId;

    setShiftState(prev => ({
      ...prev,
      diaryEntries: (prev.diaryEntries || []).filter(entry => entry.id !== activeDeleteEntryId),
    }));
    if (wasViewing) {
      closeViewModal();
    }
    setActiveDeleteEntryId(null);

    setIsDeletingEntry(true);
    try {
      await deleteDiaryEntry(targetEntry.date);
      setToastMessage({ text: 'Diary entry deleted successfully!', type: 'danger' });
      setIsToastFading(false);
    } catch (err) {
      setShiftState(previous);
      setToastMessage({ text: err.message || 'Failed to delete diary entry.', type: 'danger' });
      setIsToastFading(false);
    } finally {
      setIsDeletingEntry(false);
    }
  };

  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => b.date.localeCompare(a.date)),
    [entries]
  );

  const entryPendingDelete = entries.find(entry => entry.id === activeDeleteEntryId);
  const viewEntry = entries.find(entry => entry.id === activeViewEntryId);
  const isEditingInModal = !!viewEntry && editingEntryId === viewEntry.id;

  return (
    <div className="diary-card">
      {/* SUCCESS / DELETION TOAST NOTIFICATIONS (shared pattern with History Logs) */}
      {toastMessage && (
        <div className={`toast-notification-banner toast-${toastMessage.type} ${isToastFading ? 'fade-out-active' : ''}`}>
          <span>{toastMessage.type === 'success' ? '✅' : '🗑️'} {toastMessage.text}</span>
        </div>
      )}

      <div className="diary-header">
        <div>
          <h3 className="diary-title">📝 Daily Accomplishment Diary</h3>
          <p className="diary-subtitle">
            Provide an informative account of assignments and technical competencies logged per day.
          </p>
        </div>
        {entries.length > 0 && (
          <div className="diary-count-badge">
            <span className="diary-count-number">{entries.length}</span> {entries.length === 1 ? 'entry' : 'entries'}
          </div>
        )}
      </div>

      {isActiveUnlocked && !activeEntry && !isAddingNew && (
        <button
          type="button"
          className="diary-btn diary-btn-primary diary-add-button"
          onClick={() => { setNewDraft(''); setIsAddingNew(true); }}
          disabled={locked}
        >
          + Add diary entry for {activeDateKey === getDateKey(new Date()) ? 'today' : formatDateKeyLabel(activeDateKey)}
        </button>
      )}

      {isAddingNew && (
        <div className="diary-entry-panel">
          <textarea
            autoFocus
            value={newDraft}
            onChange={handleNewDraftChange}
            placeholder="Describe your output clearly to authorize final afternoon clock-out submission..."
            className="diary-textarea"
          />
          <div className="diary-panel-footer">
            <span className={`diary-word-count ${newOverLimit ? 'diary-word-count-limit' : ''}`}>
              {newWordCount} / {WORD_LIMIT} words
            </span>
            <div className="diary-panel-actions">
              <button type="button" className="diary-btn diary-btn-outline" onClick={handleCancelNew}>
                Cancel
              </button>
              <button
                type="button"
                className="diary-btn diary-btn-primary"
                onClick={handleCreateNew}
                disabled={!newDraft.trim() || isSavingEntry}
              >
                {isSavingEntry ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {sortedEntries.length === 0 && (
        <div className="diary-empty-state">
          <span className="diary-empty-state-icon" aria-hidden="true">📭</span>
          <p className="diary-empty-state-text">No diary entries yet. Once you log one, it'll show up here.</p>
        </div>
      )}

      {sortedEntries.length > 0 && (
        <div className="diary-entries-list">
          <span className="diary-entries-label">📚 Logged Entries</span>
          {sortedEntries.map((entry) => {
            const isActiveDate = entry.date === activeDateKey;

            // Today's in-progress punches live in shiftState directly; any
            // other entry's punches come from the corresponding completed
            // row in `logs`, since shiftState only ever holds one day's
            // time data at a time.
            const punchSource = isActiveDate
              ? shiftState
              : (logs.find(log => log.date === entry.date) || {});
            const shiftStatus = getShiftStatus(punchSource);

            return (
              <div
                key={entry.id}
                className={`diary-entry-item ${isActiveDate ? 'diary-entry-item-active' : ''}`}
              >
                <div className="diary-entry-meta">
                  <span className="diary-entry-time">
                    {formatDateKeyLabel(entry.date)}
                    {isActiveDate && <span className="diary-entry-active-badge">Current</span>}
                  </span>
                  {!locked && (
                    <div className="diary-entry-meta-actions">
                      <button
                        type="button"
                        className="diary-entry-delete-btn"
                        onClick={() => handleDeleteTrigger(entry.id)}
                        aria-label="Delete entry"
                        title="Delete entry"
                      >
                        <span className="diary-entry-delete-icon" aria-hidden="true">✕</span>
                      </button>
                    </div>
                  )}
                </div>

                <div className="diary-inline-container">
                  <span className={`diary-shift-status-badge diary-shift-status-${shiftStatus.variant}`}>
                    {shiftStatus.label}
                  </span>
                  <button
                    type="button"
                    className="diary-view-trigger-btn"
                    onClick={() => openViewModal(entry)}
                  >
                    🔍 View Full
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {shiftState.isCompleted && (
        <div className="diary-validation-box">
          ✓ Diary validation successful. Log content locked and queued for evaluation.
        </div>
      )}

      {/* VIEW / EDIT MODAL — View is the entry point; Edit is reached from within it */}
      {viewEntry && (
        <div className="diary-modal-overlay" onClick={closeViewModal}>
          <div className="diary-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-card-header">
              <div>
                <h4 className="modal-card-title">
                  {isEditingInModal ? '🔄 Edit Diary Entry' : '📝 Full Narrative Accomplishment Diary'}
                </h4>
                <p className="modal-card-subtitle">
                  {formatDateKeyLabel(viewEntry.date)}
                  {viewEntry.date === activeDateKey && <span className="diary-entry-active-badge">Current</span>}
                </p>
              </div>
              <button type="button" className="modal-close-x-btn" onClick={closeViewModal}>✕</button>
            </div>

            {isEditingInModal ? (
              <>
                <div className="modal-card-body modal-form-scrollable">
                  <textarea
                    autoFocus
                    value={editDraft}
                    onChange={handleEditDraftChange}
                    className="diary-textarea"
                  />
                  <div className="diary-panel-footer">
                    <span className={`diary-word-count ${editOverLimit ? 'diary-word-count-limit' : ''}`}>
                      {editWordCount} / {WORD_LIMIT} words
                    </span>
                  </div>
                </div>
                <div className="modal-card-footer">
                  <button type="button" className="modal-cancel-inline-btn" onClick={handleCancelEdit}>Cancel</button>
                  <button
                    type="button"
                    className="modal-save-action-btn"
                    onClick={() => handleSaveEdit(viewEntry.id)}
                    disabled={!editDraft.trim() || isSavingEntry}
                  >
                    {isSavingEntry ? 'Saving…' : 'Save Changes'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-card-body max-height-view">
                  <p className={`modal-diary-fulltext ${!viewEntry.text?.trim() ? 'diary-entry-text-empty' : ''}`}>
                    {viewEntry.text?.trim() ? viewEntry.text : 'No content yet — click Edit to add your notes.'}
                  </p>
                </div>
                <div className="modal-card-footer">
                  {!locked && (
                    <button type="button" className="modal-cancel-inline-btn" onClick={() => startEditing(viewEntry)}>
                      🔄 Edit
                    </button>
                  )}
                  <button type="button" className="modal-close-action-btn" onClick={closeViewModal}>Close</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION MODAL (same structure/classes as History Logs) */}
      {activeDeleteEntryId && (
        <div className="diary-modal-overlay" onClick={() => setActiveDeleteEntryId(null)}>
          <div className="diary-modal-card confirm-delete-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-card-header delete-header">
              <div>
                <h4 className="modal-card-title text-danger">⚠️ Confirm Deletion</h4>
                <p className="modal-card-subtitle">This action cannot be undone</p>
              </div>
              <button type="button" className="modal-close-x-btn close-x-danger" onClick={() => setActiveDeleteEntryId(null)}>✕</button>
            </div>
            <div className="modal-card-body text-center-padding">
              <div className="delete-alert-icon">🗑️</div>
              <p className="delete-warning-text">
                Are you sure you want to delete the diary entry for{' '}
                {entryPendingDelete ? formatDateKeyLabel(entryPendingDelete.date) : 'this date'}? This entry will be permanently removed.
              </p>
            </div>
            <div className="modal-card-footer delete-footer">
              <button type="button" className="modal-cancel-inline-btn" onClick={() => setActiveDeleteEntryId(null)}>Cancel</button>
              <button type="button" className="modal-confirm-delete-btn" onClick={confirmDeleteAction} disabled={isDeletingEntry}>
                {isDeletingEntry ? 'Deleting…' : 'Yes, Delete Entry'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}