import React, { useState, useEffect, useRef } from 'react';
import { saveDay, saveDiaryOnly, fetchDay } from '../services/attendanceapi';
import useSpeechRecognition from '../hooks/UsespeechRecognition';
import { checkGrammarViaApi } from '../services/grammarChecker';

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

// --- Speech-to-time parsing for the Time In / Time Out fields ---
// Converts a spoken phrase such as "eight thirty am", "8:30 AM", "quarter past
// two pm", "0830", or "noon" into a 24-hour "HH:MM" string — the same shape
// <input type="time"> already expects — or returns null if it can't be
// confidently parsed, so the caller can leave the field untouched.
const SPOKEN_NUMBER_WORDS = {
  zero: 0, oh: 0, o: 0,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50,
};

// Sums whatever number-words it recognizes in a phrase (e.g. "twenty" + "five" -> 25,
// "oh" + "five" -> 5, "thirty" -> 30). Returns null if no recognizable words are present.
const spokenWordsToNumber = (words) => {
  let total = 0;
  let matchedAny = false;
  for (const word of words) {
    if (word in SPOKEN_NUMBER_WORDS) {
      total += SPOKEN_NUMBER_WORDS[word];
      matchedAny = true;
    }
  }
  return matchedAny ? total : null;
};

// Accepts either a digit string ("8") or a word phrase ("eight thirty") and
// resolves it to a plain number.
const spokenPhraseToNumber = (phrase) => {
  const trimmed = phrase.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return spokenWordsToNumber(trimmed.split(/\s+/).filter(Boolean));
};

const parseSpokenTimeToHHMM = (rawText) => {
  if (!rawText) return null;

  let text = rawText.toLowerCase().trim()
    .replace(/[.,]/g, '')   // "a.m." -> "am", "8, 30" -> "8 30"
    .replace(/\s+/g, ' ')
    .replace(/(\d)\s*:\s*(\d)/, '$1:$2');   // "8: 30" / "8 : 30" -> "8:30"

  if (!text) return null;

  // --- Fixed phrases ---
  if (/\bnoon\b/.test(text)) return '12:00';
  if (/\bmidnight\b/.test(text)) return '00:00';

  // --- Detect an AM/PM (or morning/afternoon/evening/night) modifier, then
  // strip it out so it doesn't interfere with hour/minute parsing below. ---
  let modifier = null;
  if (/\b(a\s?m|in the morning)\b/.test(text)) modifier = 'am';
  if (/\b(p\s?m|in the afternoon|in the evening|at night)\b/.test(text)) modifier = 'pm';
  text = text
    .replace(/\ba\s?m\b/g, '')
    .replace(/\bp\s?m\b/g, '')
    .replace(/\bin the morning\b/g, '')
    .replace(/\bin the afternoon\b/g, '')
    .replace(/\bin the evening\b/g, '')
    .replace(/\bat night\b/g, '')
    .trim();

  if (!text) return null;

  let hour = null;
  let minute = 0;

  // --- "quarter past/to H", "half past H" ---
  let match = text.match(/^(quarter|half)\s+(past|after|to|til|till)\s+(.+)$/);
  if (match) {
    const [, unit, direction, hourPhrase] = match;
    const baseHour = spokenPhraseToNumber(hourPhrase);
    if (baseHour !== null) {
      if (unit === 'quarter') {
        if (direction === 'to' || direction === 'til' || direction === 'till') {
          hour = baseHour - 1;
          minute = 45;
        } else {
          hour = baseHour;
          minute = 15;
        }
      } else {
        hour = baseHour;
        minute = 30;
      }
    }
  }

  // --- "H o'clock" ---
  if (hour === null) {
    match = text.match(/^(.+?)\s*o'?\s?clock$/);
    if (match) {
      const h = spokenPhraseToNumber(match[1]);
      if (h !== null) {
        hour = h;
        minute = 0;
      }
    }
  }

  // --- Military-style digit block, e.g. "830" or "0830" ---
  if (hour === null) {
    match = text.match(/^(\d{3,4})$/);
    if (match) {
      const digits = match[1];
      hour = digits.length === 3 ? Number(digits[0]) : Number(digits.slice(0, 2));
      minute = Number(digits.slice(-2));
    }
  }

  // --- Digit form with separator: "8:30", "08.30", "8 30" ---
  if (hour === null) {
    match = text.match(/^(\d{1,2})[:.\s]+(\d{2})$/);
    if (match) {
      hour = Number(match[1]);
      minute = Number(match[2]);
    }
  }

  // --- Bare hour, digit or spelled: "8", "eight" ---
  if (hour === null) {
    const h = spokenPhraseToNumber(text);
    if (h !== null && h <= 24) {
      hour = h;
      minute = 0;
    }
  }

  // --- Spelled-out "hour [minute]", e.g. "eight thirty", "eight oh five",
  // "twelve fifteen" ---
  if (hour === null) {
    const words = text.split(' ').filter(Boolean);
    if (words.length >= 2) {
      const h = spokenPhraseToNumber(words[0]);
      if (h !== null && h <= 24) {
        const m = spokenWordsToNumber(words.slice(1));
        if (m !== null) {
          hour = h;
          minute = m;
        }
      }
    }
  }

  if (hour === null || minute < 0 || minute > 59) return null;
  hour = ((hour % 24) + 24) % 24;

  if (modifier === 'pm' && hour >= 1 && hour <= 11) hour += 12;
  if (modifier === 'am' && hour === 12) hour = 0;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

// Recognizes a spoken confirmation once a time has already been filled in —
// "save", "confirm", "yes", "save time in/out", etc. Kept intentionally small
// and literal (no fuzzy matching) so an unrelated phrase never gets
// misread as a confirmation and saves the wrong thing.
const CONFIRM_PHRASE_PATTERN = /^(save|confirm|confirmed|yes|correct|submit|save it|save that|that's right|thats right|save time|save time in|save time out)$/;

const isSpokenConfirmPhrase = (rawText) => {
  if (!rawText) return false;
  const normalized = rawText.toLowerCase().trim().replace(/[.,!]/g, '');
  return CONFIRM_PHRASE_PATTERN.test(normalized);
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

// Minimal inline mic icon (kept dependency-free, no icon library import needed)
function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 11a7 7 0 0 1-14 0M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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
  isMicSupported,
  isMicListening,
  micInterimTranscript,
  micError,
  onToggleMic,
  pendingConfirm,
}) {
  const isLocked = !!storedValue;
  const showControls = isEditing || (!isLocked && !blockedMessage);
  const spokenDraftTime = pendingConfirm ? from24HourInputValue(draft) : '';

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
          <div className="time-entry-input-row">
            <input
              type="time"
              value={draft}
              onChange={onDraftChange}
              className="time-entry-input"
            />
            {isMicSupported && (
              <button
                type="button"
                className={`time-entry-mic-btn${isMicListening ? ' time-entry-mic-btn-active' : ''}`}
                onClick={onToggleMic}
                aria-label={isMicListening ? `Stop voice dictation for ${label}` : `Say the ${label} time`}
                title={
                  isMicListening
                    ? 'Stop voice dictation'
                    : pendingConfirm
                      ? `Say "save" to confirm, or say the corrected ${label.toLowerCase()}`
                      : `Say the ${label.toLowerCase()}, e.g. "8:30 AM"`
                }
              >
                <MicIcon />
              </button>
            )}
          </div>
          {isMicListening ? (
            <p className="time-entry-mic-status">
              🎙️ {pendingConfirm ? `Listening for "save"… ${micInterimTranscript}` : `Listening… ${micInterimTranscript}`}
            </p>
          ) : pendingConfirm && spokenDraftTime ? (
            <p className="time-entry-mic-status">
              Heard <strong>{spokenDraftTime}</strong> — say "save" to confirm, or tap the mic and say the correct time.
            </p>
          ) : null}
          {micError && (
            <p className="time-entry-mic-error" role="alert">⚠️ {micError}</p>
          )}
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

  // --- Voice dictation for the diary textarea ---
  const {
    transcript: speechTranscript,
    interimTranscript,
    isListening: isMicListening,
    isSupported: isMicSupported,
    error: micError,
    startListening,
    stopListening,
    resetTranscript,
  } = useSpeechRecognition({ continuous: true, lang: 'en-US' });

  // Diary text as it was right before the current dictation session started,
  // so recognized speech is appended to it rather than overwriting it.
  const diaryBaseTextRef = useRef('');

  // --- Voice dictation for the Time In / Time Out fields ---
  // Reuses the same useSpeechRecognition hook as the diary, but as its own
  // instance configured for a single short utterance (continuous: false)
  // rather than an open-ended dictation session — a person says one time
  // ("8:30 AM") and the mic naturally stops, instead of staying hot the way
  // the diary's freeform dictation does.
  const {
    transcript: timeSpeechTranscript,
    interimTranscript: timeInterimTranscript,
    isListening: isTimeMicListening,
    isSupported: isTimeMicSupported,
    error: timeMicRawError,
    startListening: startTimeListening,
    stopListening: stopTimeListening,
    resetTranscript: resetTimeTranscript,
  } = useSpeechRecognition({ continuous: false, lang: 'en-US' });

  // Which draft ('in' | 'out' | null) the next recognized transcript should
  // be applied to — since Time In and Time Out share this one mic instance.
  const [activeTimeMicField, setActiveTimeMicField] = useState(null);
  // Set only when a transcript came back but couldn't be parsed as a time,
  // so the person knows to try rephrasing rather than wondering why nothing happened.
  const [timeParseError, setTimeParseError] = useState(null);
  // Local copy of the hook's raw recognition error (mic permission denied, no
  // speech detected, etc). We don't read timeMicRawError directly for display —
  // some browsers leave a stale error sitting in the hook's state even after a
  // later attempt succeeds, which would otherwise show a false error forever.
  // This copy is explicitly cleared on every new session and on every
  // successful parse, so it can never outlive the attempt that caused it.
  const [timeMicDisplayError, setTimeMicDisplayError] = useState(null);
  // Field ('in' | 'out' | null) that just had a time successfully recognized
  // and is now waiting on a spoken "save" to confirm it (or a re-spoken time
  // to correct it) — the voice equivalent of tapping the Save button.
  const [pendingConfirmField, setPendingConfirmField] = useState(null);
  // Holds the short delay before automatically reopening the mic to listen
  // for that confirmation, so a person can just keep talking without
  // tapping the mic button again.
  const confirmListenTimeoutRef = useRef(null);

  // --- Grammar check for the diary textarea ---
  const [isCheckingGrammar, setIsCheckingGrammar] = useState(false);
  const [grammarError, setGrammarError] = useState(null);
  const [canUndoGrammarCheck, setCanUndoGrammarCheck] = useState(false);
  const preGrammarCheckDraftRef = useRef('');

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

  // Clamp to DIARY_WORD_LIMIT without truncating mid-word. Shared by manual
  // typing and by dictated speech so both respect the same cap.
  const clampToDiaryWordLimit = (text) => {
    const words = text.trim() === '' ? [] : text.trim().split(/\s+/);
    return words.length <= DIARY_WORD_LIMIT ? text : words.slice(0, DIARY_WORD_LIMIT).join(' ');
  };

  const handleDiaryDraftChange = (e) => {
    setDiaryDraft(clampToDiaryWordLimit(e.target.value));
  };

  // Start/stop the mic. On start, snapshot whatever's already in the
  // textarea so recognized speech is appended to it, not over it.
  const handleToggleMic = () => {
    if (isMicListening) {
      stopListening();
      return;
    }
    diaryBaseTextRef.current = diaryDraft;
    resetTranscript();
    startListening();
  };

  // Merge each new finalized speech chunk onto the pre-dictation base text.
  useEffect(() => {
    if (!speechTranscript) return;
    const base = diaryBaseTextRef.current;
    const merged = base ? `${base} ${speechTranscript}` : speechTranscript;
    setDiaryDraft(clampToDiaryWordLimit(merged));
  }, [speechTranscript]);

  // Start/stop the Time In / Time Out mic for a given field ('in' | 'out').
  // Toggling off whichever field is already listening always just stops it;
  // starting on the other field's button hands the mic over to that field.
  const handleToggleTimeMic = (field) => {
    if (confirmListenTimeoutRef.current) {
      clearTimeout(confirmListenTimeoutRef.current);
      confirmListenTimeoutRef.current = null;
    }
    if (isTimeMicListening) {
      stopTimeListening();
      return;
    }
    setTimeParseError(null);
    setTimeMicDisplayError(null);
    // Switching to the other field drops any confirmation pending on this one.
    if (pendingConfirmField !== field) {
      setPendingConfirmField(null);
    }
    setActiveTimeMicField(field);
    resetTimeTranscript();
    startTimeListening();
  };

  // Handles each recognized utterance for the Time In / Time Out mic. Two
  // things can happen here, depending on whether this field already has a
  // just-recognized time waiting on confirmation:
  //   - Not pending: parse the speech as a time and fill the draft, then
  //     automatically reopen the mic briefly so a "save" can follow it
  //     without another tap.
  //   - Pending: check for a spoken "save" (confirms and actually submits
  //     the field, same as tapping the Save button) — or, if it's a new
  //     valid time instead, treat it as a correction and listen again.
  useEffect(() => {
    if (!timeSpeechTranscript || !activeTimeMicField) return;
    const field = activeTimeMicField;
    const raw = timeSpeechTranscript.trim();

    if (pendingConfirmField === field && isSpokenConfirmPhrase(raw)) {
      setPendingConfirmField(null);
      setTimeParseError(null);
      setTimeMicDisplayError(null);
      if (field === 'in') {
        saveTimeIn();
      } else {
        saveTimeOut();
      }
      return;
    }

    const parsed = parseSpokenTimeToHHMM(raw);
    if (parsed) {
      if (field === 'in') {
        setDraftIn(parsed);
      } else {
        setDraftOut(parsed);
      }
      setTimeParseError(null);
      setTimeMicDisplayError(null);
      setPendingConfirmField(field);

      // Give the person a beat, then reopen the mic so they can just say
      // "save" (or a corrected time) without tapping the mic again. Only
      // fires off this one successful recognition — if the follow-up
      // listen comes back empty or unrecognized, it stops there rather
      // than looping the mic open indefinitely.
      if (confirmListenTimeoutRef.current) clearTimeout(confirmListenTimeoutRef.current);
      confirmListenTimeoutRef.current = setTimeout(() => {
        resetTimeTranscript();
        startTimeListening();
      }, 500);
    } else if (pendingConfirmField === field) {
      setTimeParseError(`Didn't catch that — say "save" to confirm, or say the corrected time.`);
    } else {
      setTimeParseError(`Didn't catch a time in "${raw}" — try saying it like "8:30 AM".`);
    }
    // Note: activeTimeMicField is deliberately left set (not reset to null)
    // so a parse error can still be attributed to the correct field below —
    // it only changes when the other field's mic is used, or the modal closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeSpeechTranscript]);

  // Mirror a fresh raw recognition error into our locally-controlled copy.
  // This only fires when the hook's error value actually changes, so a
  // stale error left over from a previous, since-succeeded attempt never
  // re-appears on its own — it can only be cleared or replaced explicitly.
  useEffect(() => {
    if (timeMicRawError) {
      setTimeMicDisplayError(timeMicRawError);
    }
  }, [timeMicRawError]);

  // Release the time-field mic and clear its state whenever the shift modal
  // isn't the active view (closed, or the diary modal opened instead) —
  // mirrors the diary's own mic-cleanup effect below.
  useEffect(() => {
    if (modalView !== 'am' && modalView !== 'pm') {
      if (confirmListenTimeoutRef.current) {
        clearTimeout(confirmListenTimeoutRef.current);
        confirmListenTimeoutRef.current = null;
      }
      stopTimeListening();
      resetTimeTranscript();
      setActiveTimeMicField(null);
      setTimeParseError(null);
      setTimeMicDisplayError(null);
      setPendingConfirmField(null);
    }
  }, [modalView, stopTimeListening, resetTimeTranscript]);

  // Also clear it on switching which field is being edited, so a stale
  // error from Time In doesn't linger under Time Out (or vice versa).
  useEffect(() => {
    setTimeParseError(null);
    setTimeMicDisplayError(null);
    setPendingConfirmField(null);
  }, [editingIn, editingOut]);

  // Guards against a scheduled auto-relisten still firing after unmount.
  useEffect(() => () => {
    if (confirmListenTimeoutRef.current) clearTimeout(confirmListenTimeoutRef.current);
  }, []);

  // Runs a chunk of text through grammar correction and applies the result.
  // checkGrammarViaApi never throws — on any failure it resolves with the
  // original text and corrected: false, so this never needs a catch block.
  const runGrammarCheck = async (textToCheck) => {
    const trimmedText = textToCheck.trim();
    if (!trimmedText || isCheckingGrammar) return;

    setGrammarError(null);
    setIsCheckingGrammar(true);
    const preCheckDraft = textToCheck;
    const { correctedText, corrected } = await checkGrammarViaApi(trimmedText);
    setIsCheckingGrammar(false);

    if (!corrected) {
      setGrammarError('Grammar check is unavailable right now — kept your original text.');
      return;
    }
    preGrammarCheckDraftRef.current = preCheckDraft;
    setDiaryDraft(clampToDiaryWordLimit(correctedText));
    setCanUndoGrammarCheck(true);
  };

  // Manual trigger for the "Check Grammar" button — checks whatever is
  // currently in the textarea, typed or dictated.
  const handleCheckGrammar = () => runGrammarCheck(diaryDraft);

  const handleUndoGrammarCheck = () => {
    setDiaryDraft(preGrammarCheckDraftRef.current);
    setCanUndoGrammarCheck(false);
  };

  // Automatic pipeline: Speech Recognition -> Transcript -> Grammar Service
  // -> Diary Textarea. The moment dictation stops (mic toggled off while the
  // diary modal is still open), whatever was just recognized is sent for
  // correction automatically — no manual click required for dictated text.
  const wasMicListeningRef = useRef(false);
  useEffect(() => {
    const justStoppedListening = wasMicListeningRef.current && !isMicListening;
    wasMicListeningRef.current = isMicListening;

    if (justStoppedListening && modalView === 'diary' && speechTranscript.trim()) {
      // Recompute the merged text from source (base + speechTranscript)
      // instead of reading `diaryDraft` state. When the final onresult and
      // onend fire in the same batched commit, the merge effect that sets
      // diaryDraft hasn't been reflected in this render's closure yet, so
      // diaryDraft can be one chunk behind here.
      const base = diaryBaseTextRef.current;
      const finalMerged = base ? `${base} ${speechTranscript}` : speechTranscript;
      runGrammarCheck(clampToDiaryWordLimit(finalMerged));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMicListening]);

  // Release the mic and clear any in-progress dictation whenever the diary
  // modal isn't the active view (closed, or a shift modal opened instead).
  useEffect(() => {
    if (modalView !== 'diary') {
      stopListening();
      resetTranscript();
      setGrammarError(null);
      setCanUndoGrammarCheck(false);
    }
  }, [modalView, stopListening, resetTranscript]);

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

  // Surfaces either a raw recognition error (mic permission denied, no speech
  // detected, etc.) or a parsing error (recognized speech that didn't read as
  // a time) — whichever applies — under the field currently/most-recently in use.
  const timeMicError = timeMicDisplayError || timeParseError;

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
                  <div className="diary-textarea-wrap">
                    <textarea
                      autoFocus
                      value={diaryDraft}
                      onChange={handleDiaryDraftChange}
                      placeholder="Describe your output..."
                      className="diary-quick-textarea"
                    />
                    {isMicSupported && (
                      <button
                        type="button"
                        className={`diary-mic-btn${isMicListening ? ' diary-mic-btn-active' : ''}`}
                        onClick={handleToggleMic}
                        aria-label={isMicListening ? 'Stop voice dictation' : 'Start voice dictation'}
                        title={isMicListening ? 'Stop voice dictation' : 'Start voice dictation'}
                      >
                        <MicIcon />
                      </button>
                    )}
                  </div>
                  {isMicListening && (
                    <p className="diary-mic-status">
                      🎙️ Listening… {interimTranscript}
                    </p>
                  )}
                  {micError && (
                    <p className="diary-mic-error" role="alert">⚠️ {micError}</p>
                  )}
                  <div className="diary-grammar-row">
                    <button
                      type="button"
                      className="diary-grammar-btn"
                      onClick={handleCheckGrammar}
                      disabled={!diaryDraft.trim() || isCheckingGrammar}
                    >
                      {isCheckingGrammar ? 'Checking…' : '✓ Check Grammar'}
                    </button>
                    {canUndoGrammarCheck && (
                      <button type="button" className="diary-grammar-undo" onClick={handleUndoGrammarCheck}>
                        Undo
                      </button>
                    )}
                  </div>
                  {grammarError && (
                    <p className="diary-mic-error" role="alert">⚠️ {grammarError}</p>
                  )}
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
                    isMicSupported={isTimeMicSupported}
                    isMicListening={isTimeMicListening && activeTimeMicField === 'in'}
                    micInterimTranscript={timeInterimTranscript}
                    micError={activeTimeMicField === 'in' ? timeMicError : null}
                    onToggleMic={() => handleToggleTimeMic('in')}
                    pendingConfirm={pendingConfirmField === 'in'}
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
                    isMicSupported={isTimeMicSupported}
                    isMicListening={isTimeMicListening && activeTimeMicField === 'out'}
                    micInterimTranscript={timeInterimTranscript}
                    micError={activeTimeMicField === 'out' ? timeMicError : null}
                    onToggleMic={() => handleToggleTimeMic('out')}
                    pendingConfirm={pendingConfirmField === 'out'}
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