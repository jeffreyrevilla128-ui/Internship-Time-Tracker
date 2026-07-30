import React, { useState, useMemo, useEffect } from 'react';
import { saveDiaryOnly, deleteDiaryEntry } from '../services/attendanceapi';
import UseSpeechRecognition from '../hooks/UsespeechRecognition';

const WORD_LIMIT = 1000;

// Minimal inline speaker icon (kept dependency-free, mirrors PunchCard's MicIcon)
function SpeakerIcon({ active }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 9v6h4l5 4V5L8 9H4Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {active ? (
        <path d="M18 8a6 6 0 0 1 0 8M15 10.5a2.5 2.5 0 0 1 0 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M16 9a4 4 0 0 1 0 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

// How many placeholder entry cards the skeleton loader shows while
// shiftState/logs are still being fetched by the parent.
const SKELETON_ENTRY_COUNT = 3;

function countWords(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

// Truncates free text to at most `limit` words — shared by both the
// "new entry" and "edit entry" textareas so the word-limit behavior
// can't drift between the two.
function clampToWordLimit(text, limit = WORD_LIMIT) {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const words = trimmed.split(/\s+/);
  return words.length <= limit ? text : words.slice(0, limit).join(' ');
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

// Shared by both the "new entry" and "edit entry" panels so the word
// count + over-limit check isn't computed two separate ways.
function useWordCount(text) {
  return useMemo(() => {
    const count = countWords(text);
    return { count, overLimit: count > WORD_LIMIT };
  }, [text]);
}

// Placeholder shown while shiftState/logs are still loading. Reuses the
// real .diary-card / .diary-entry-item markup and classes so it inherits
// the exact same layout — only the text content is swapped for
// shimmering bars, the same approach used by HistoryLogs' skeleton.
function DiarySkeleton() {
  return (
    <div className="diary-card" aria-hidden="true" aria-busy="true">
      <div className="diary-header">
        <div className="skeleton-header-text">
          <span className="skeleton-bar skeleton-bar-title" />
          <span className="skeleton-bar skeleton-bar-subtitle" />
        </div>
        <span className="skeleton-bar skeleton-bar-badge" />
      </div>

      <span className="skeleton-bar skeleton-bar-add-btn" />

      <div className="diary-entries-list">
        <span className="skeleton-bar skeleton-bar-label" />
        {Array.from({ length: SKELETON_ENTRY_COUNT }).map((_, i) => (
          <div className="diary-entry-item skeleton-entry" key={`diary-skeleton-${i}`}>
            <div className="diary-entry-meta">
              <span className="skeleton-bar skeleton-bar-date" />
              <span className="skeleton-bar skeleton-bar-delete" />
            </div>
            <div className="diary-inline-container">
              <span className="skeleton-bar skeleton-bar-status" />
              <span className="skeleton-bar skeleton-bar-view" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DiaryForm({ shiftState = {}, setShiftState, logs = [], isLoading = false }) {
  const entries = shiftState.diaryEntries || [];
  const locked = shiftState.isCompleted;

  const activeDateKey = getShiftDateKey(shiftState);
  const activeEntry = entries.find(entry => entry.date === activeDateKey);
  const isActiveUnlocked = !!(shiftState.amIn || shiftState.amOut || shiftState.pmIn || shiftState.pmOut);

  // --- "Create first entry for the active date" panel ---
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [newDraft, setNewDraft] = useState('');
  const { count: newWordCount, overLimit: newOverLimit } = useWordCount(newDraft);

  // --- View / Edit modal (View is the entry point; Edit lives inside it) ---
  const [activeViewEntryId, setActiveViewEntryId] = useState(null);
  const [editingEntryId, setEditingEntryId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const { count: editWordCount, overLimit: editOverLimit } = useWordCount(editDraft);

  // --- Delete confirmation & toast feedback (mirrors HistoryLogs) ---
  const [activeDeleteEntryId, setActiveDeleteEntryId] = useState(null);
  const [toastMessage, setToastMessage] = useState(null);
  const [isToastFading, setIsToastFading] = useState(false);
  const [isSavingEntry, setIsSavingEntry] = useState(false);
  const [isDeletingEntry, setIsDeletingEntry] = useState(false);

  // --- Text-to-speech: read the in-progress draft back out loud, for the
  // "new entry" panel and the "edit entry" panel inside the View modal. Both
  // share a single TTS instance (only one draft is ever being written at a
  // time), with `ttsTarget` tracking which one ('new' | 'edit') is reading.
  const {
    isSpeaking,
    isSupported: isTtsSupported,
    error: ttsError,
    speak,
    stop: stopSpeaking,
  } = UseSpeechRecognition({ lang: 'en-US' });
  const [ttsTarget, setTtsTarget] = useState(null);

  // Toggles read-aloud for a given panel ('new' | 'edit'). Tapping the
  // button on whichever panel is already reading stops it; tapping it on
  // the other panel hands the voice over to that one instead.
  const handleToggleReadAloud = (target, text) => {
    if (isSpeaking && ttsTarget === target) {
      stopSpeaking();
      setTtsTarget(null);
      return;
    }
    setTtsTarget(target);
    speak(text);
  };

  // If the person keeps typing while their own draft is being read back,
  // stop — otherwise the voice reads a version of the text that's already
  // out of date the moment they touch the keyboard.
  const stopReadAloudIfActive = (target) => {
    if (isSpeaking && ttsTarget === target) {
      stopSpeaking();
      setTtsTarget(null);
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

  // Shared by every save/update/delete outcome below so the
  // "set message, reset fade state" pair isn't repeated six times.
  const showToast = (text, type) => {
    setToastMessage({ text, type });
    setIsToastFading(false);
  };

  const handleNewDraftChange = (e) => {
    setNewDraft(clampToWordLimit(e.target.value));
    stopReadAloudIfActive('new');
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
    stopReadAloudIfActive('new');

    setIsSavingEntry(true);
    try {
      await saveDiaryOnly(activeDateKey, trimmedText);
      showToast('Diary entry saved successfully!', 'success');
    } catch (err) {
      setShiftState(previous);
      showToast(err.message || 'Failed to save diary entry.', 'danger');
    } finally {
      setIsSavingEntry(false);
    }
  };

  const handleCancelNew = () => {
    setNewDraft('');
    setIsAddingNew(false);
    stopReadAloudIfActive('new');
  };

  // --- View modal open/close ---
  const openViewModal = (entry) => {
    setActiveViewEntryId(entry.id);
    setEditingEntryId(null);
    setEditDraft('');
    stopReadAloudIfActive('edit');
  };

  const closeViewModal = () => {
    setActiveViewEntryId(null);
    setEditingEntryId(null);
    setEditDraft('');
    stopReadAloudIfActive('edit');
  };

  // --- Editing, entered only from inside the View modal ---
  const startEditing = (entry) => {
    setEditDraft(entry.text);
    setEditingEntryId(entry.id);
  };

  const handleEditDraftChange = (e) => {
    setEditDraft(clampToWordLimit(e.target.value));
    stopReadAloudIfActive('edit');
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
    stopReadAloudIfActive('edit');

    setIsSavingEntry(true);
    try {
      await saveDiaryOnly(targetEntry.date, trimmedText);
      showToast('Diary entry updated successfully!', 'success');
    } catch (err) {
      setShiftState(previous);
      showToast(err.message || 'Failed to update diary entry.', 'danger');
    } finally {
      setIsSavingEntry(false);
    }
  };

  // Cancelling edit returns to the View state within the same modal, rather than closing it
  const handleCancelEdit = () => {
    setEditingEntryId(null);
    setEditDraft('');
    stopReadAloudIfActive('edit');
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
      showToast('Diary entry deleted successfully!', 'danger');
    } catch (err) {
      setShiftState(previous);
      showToast(err.message || 'Failed to delete diary entry.', 'danger');
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

  // All hooks above have already run unconditionally by this point, so
  // branching on isLoading here is safe — it only affects what gets
  // rendered, not the hook call order.
  if (isLoading) {
    return <DiarySkeleton />;
  }

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
          <div className="diary-textarea-wrap">
            <textarea
              autoFocus
              value={newDraft}
              onChange={handleNewDraftChange}
              placeholder="Describe your output clearly to authorize final afternoon clock-out submission..."
              className="diary-textarea"
            />
            {isTtsSupported && (
              <button
                type="button"
                className={`diary-tts-btn${isSpeaking && ttsTarget === 'new' ? ' diary-tts-btn-active' : ''}`}
                onClick={() => handleToggleReadAloud('new', newDraft)}
                disabled={!newDraft.trim()}
                aria-label={isSpeaking && ttsTarget === 'new' ? 'Stop reading draft aloud' : 'Read draft aloud'}
                title={isSpeaking && ttsTarget === 'new' ? 'Stop reading' : 'Read draft aloud'}
              >
                <SpeakerIcon active={isSpeaking && ttsTarget === 'new'} />
              </button>
            )}
          </div>
          {isSpeaking && ttsTarget === 'new' && (
            <p className="diary-tts-status">🔊 Reading your draft aloud…</p>
          )}
          {ttsTarget === 'new' && ttsError && (
            <p className="diary-tts-error" role="alert">⚠️ {ttsError}</p>
          )}
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
                  <div className="diary-textarea-wrap">
                    <textarea
                      autoFocus
                      value={editDraft}
                      onChange={handleEditDraftChange}
                      className="diary-textarea"
                    />
                    {isTtsSupported && (
                      <button
                        type="button"
                        className={`diary-tts-btn${isSpeaking && ttsTarget === 'edit' ? ' diary-tts-btn-active' : ''}`}
                        onClick={() => handleToggleReadAloud('edit', editDraft)}
                        disabled={!editDraft.trim()}
                        aria-label={isSpeaking && ttsTarget === 'edit' ? 'Stop reading draft aloud' : 'Read draft aloud'}
                        title={isSpeaking && ttsTarget === 'edit' ? 'Stop reading' : 'Read draft aloud'}
                      >
                        <SpeakerIcon active={isSpeaking && ttsTarget === 'edit'} />
                      </button>
                    )}
                  </div>
                  {isSpeaking && ttsTarget === 'edit' && (
                    <p className="diary-tts-status">🔊 Reading your draft aloud…</p>
                  )}
                  {ttsTarget === 'edit' && ttsError && (
                    <p className="diary-tts-error" role="alert">⚠️ {ttsError}</p>
                  )}
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