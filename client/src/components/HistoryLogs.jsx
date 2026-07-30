import React, { useState, useRef, useEffect } from 'react';
import {
  fetchLogs,
  updateLog as updateLogApi,
  deleteLog as deleteLogApi,
  upsertAttendanceByDate,
  saveDiaryOnly
} from '../services/attendanceapi';
import useSpeechRecognition from '../hooks/UsespeechRecognition';

// How many placeholder rows the skeleton loader shows while the first
// fetch is in flight. Picked to roughly fill the card without looking
// like an obviously-fake exact match to real row count.
const SKELETON_ROW_COUNT = 5;

// Minimal inline mic icon (kept dependency-free, identical glyph to the
// one used in PunchCard.jsx/DiaryForm.jsx so the mic affordance reads the
// same everywhere in the app).
function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 11a7 7 0 0 1-14 0M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// --- Speech-to-time parsing for the Time In / Time Out fields ---
// Same approach as PunchCard.jsx's parser (duplicated here rather than
// shared, matching how this codebase already keeps each component's
// speech-parsing logic local to itself). Converts a spoken phrase such as
// "eight thirty am", "8:30", "quarter past two pm", "0830", or "noon" into
// a 24-hour "HH:MM" string — the exact shape these <input type="time">
// fields already store — or returns null if it can't be confidently parsed.
const SPOKEN_NUMBER_WORDS = {
  zero: 0, oh: 0, o: 0,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50,
};

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

const spokenPhraseToNumber = (phrase) => {
  const trimmed = phrase.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return spokenWordsToNumber(trimmed.split(/\s+/).filter(Boolean));
};

const parseSpokenTimeToHHMM = (rawText) => {
  if (!rawText) return null;

  let text = rawText.toLowerCase().trim()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/(\d)\s*:\s*(\d)/, '$1:$2');

  if (!text) return null;

  if (/\bnoon\b/.test(text)) return '12:00';
  if (/\bmidnight\b/.test(text)) return '00:00';

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

  if (hour === null) {
    match = text.match(/^(\d{3,4})$/);
    if (match) {
      const digits = match[1];
      hour = digits.length === 3 ? Number(digits[0]) : Number(digits.slice(0, 2));
      minute = Number(digits.slice(-2));
    }
  }

  if (hour === null) {
    match = text.match(/^(\d{1,2})[:.\s]+(\d{2})$/);
    if (match) {
      hour = Number(match[1]);
      minute = Number(match[2]);
    }
  }

  if (hour === null) {
    const h = spokenPhraseToNumber(text);
    if (h !== null && h <= 24) {
      hour = h;
      minute = 0;
    }
  }

  if (hour === null) {
    const words = text.split(' ').filter(Boolean);
    if (words.length >= 2) {
      const h = spokenPhraseToNumber(words[0]);
      if (h !== null && h <= 24) {
        const restPhrase = words.slice(1).join(' ');
        const m = restPhrase === 'oh' ? 0 : spokenPhraseToNumber(restPhrase);
        if (m !== null && m < 60) {
          hour = h;
          minute = m;
        }
      }
    }
  }

  if (hour === null) return null;

  if (modifier === 'pm' && hour < 12) hour += 12;
  if (modifier === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || hour < 0 || minute < 0) return null;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

// --- Speech-to-date parsing for the "Date" field (Add Attendance History
// modal only — the Update modal's date is fixed to the log being edited).
// Handles relative phrases ("today", "yesterday"), spelled-out dates
// ("july 30 2026", "30 july 2026"), and numeric formats ("2026-07-30",
// "7/30/2026"), resolving to the "YYYY-MM-DD" string the <input type="date">
// field already expects. Returns null if it can't be confidently parsed.
const SPOKEN_MONTH_NAMES = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sept: 8, sep: 8, october: 9, oct: 9, november: 10, nov: 10,
  december: 11, dec: 11,
};

const toISODate = (year, monthIndex, day) => {
  const d = new Date(year, monthIndex, day);
  // Guards against nonsense like "february 31" silently rolling over into
  // March — if the constructed date doesn't land back on the day we asked
  // for, the input wasn't a valid calendar date.
  if (d.getFullYear() !== year || d.getMonth() !== monthIndex || d.getDate() !== day) return null;
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const parseSpokenDateToISO = (rawText) => {
  if (!rawText) return null;

  const text = rawText.toLowerCase().trim()
    .replace(/[.,]/g, ' ')
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return null;

  const now = new Date();

  if (/\btoday\b/.test(text)) {
    return toISODate(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (/\byesterday\b/.test(text)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return toISODate(d.getFullYear(), d.getMonth(), d.getDate());
  }

  let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    const [, y, mo, d] = match;
    return toISODate(Number(y), Number(mo) - 1, Number(d));
  }

  match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) {
    const [, mo, d, y] = match;
    return toISODate(Number(y), Number(mo) - 1, Number(d));
  }

  match = text.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/);
  if (match) {
    const [, monthWord, dayStr, yearStr] = match;
    const monthIndex = SPOKEN_MONTH_NAMES[monthWord];
    if (monthIndex !== undefined) {
      const year = yearStr ? Number(yearStr) : now.getFullYear();
      return toISODate(year, monthIndex, Number(dayStr));
    }
  }

  match = text.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/);
  if (match) {
    const [, dayStr, monthWord, yearStr] = match;
    const monthIndex = SPOKEN_MONTH_NAMES[monthWord];
    if (monthIndex !== undefined) {
      const year = yearStr ? Number(yearStr) : now.getFullYear();
      return toISODate(year, monthIndex, Number(dayStr));
    }
  }

  return null;
};

// Time In / Time Out input paired with its own mic button, status line, and
// error line — used for all 4 shift fields in both the Update and Add
// modals so the mic wiring isn't duplicated 8 separate times.
function TimeFieldWithMic({
  label,
  inputRef,
  max,
  value,
  onChange,
  onFocus,
  onBlur,
  isMicSupported,
  isMicActive,
  isMicDisabled,
  micInterimTranscript,
  micError,
  onToggleMic,
}) {
  return (
    <div className="form-input-field" onClick={(e) => e.stopPropagation()}>
      <label>{label}</label>
      <div className="field-input-mic-row">
        <input
          ref={inputRef}
          type="time"
          max={max}
          value={value || ''}
          onChange={onChange}
          onFocus={onFocus}
          onBlur={onBlur}
        />
        {isMicSupported && (
          <button
            type="button"
            className={`field-mic-btn${isMicActive ? ' field-mic-btn-active' : ''}`}
            onClick={onToggleMic}
            disabled={isMicDisabled}
            aria-label={isMicActive ? `Stop voice input for ${label}` : `Say the ${label}`}
            title={
              isMicActive
                ? 'Stop voice input'
                : `Say the ${label.toLowerCase()}, e.g. "8:30 AM"`
            }
          >
            <MicIcon />
          </button>
        )}
      </div>
      {isMicActive && (
        <p className="field-mic-status">🎙️ Listening… {micInterimTranscript}</p>
      )}
      {micError && (
        <p className="field-mic-error" role="alert">⚠️ {micError}</p>
      )}
    </div>
  );
}

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

  // --- Voice input: structured fields (Time In/Out + Date) ---
  // One shared mic instance for every Time In / Time Out field across both
  // the Update and Add modals, plus the Add modal's Date field — they're
  // all single short utterances, so continuous:false lets the engine stop
  // naturally after each one instead of staying hot like free dictation.
  // `activeFieldMic` tracks which field is listening, encoded as
  // "scope:field" (e.g. "update:amIn", "add:date"), since only one of
  // these fields is ever being spoken into at a time.
  const {
    transcript: fieldSpeechTranscript,
    interimTranscript: fieldInterimTranscript,
    isListening: isFieldMicListening,
    isSupported: isFieldMicSupported,
    error: fieldMicRawError,
    startListening: startFieldListening,
    stopListening: stopFieldListening,
    resetTranscript: resetFieldTranscript,
  } = useSpeechRecognition({ continuous: false, lang: 'en-US' });
  const [activeFieldMic, setActiveFieldMic] = useState(null);
  // Set when a transcript came back but couldn't be parsed as a time/date,
  // so the person knows to rephrase rather than wondering why nothing happened.
  const [fieldParseError, setFieldParseError] = useState(null);
  // Local copy of the hook's raw recognition error — mirrored via effect
  // rather than read directly, so a stale error from a previous attempt
  // can't linger on screen after a later attempt succeeds (same reasoning
  // as PunchCard's timeMicDisplayError).
  const [fieldMicDisplayError, setFieldMicDisplayError] = useState(null);

  // --- Voice input: free-form Diary dictation ---
  // Separate instance from the field mic above (continuous:true — an
  // open-ended dictation session rather than one short utterance), shared
  // between the Update modal's and Add modal's diary textareas via
  // `diaryMicScope` ('update' | 'add' | null).
  const {
    transcript: diarySpeechTranscript,
    interimTranscript: diaryInterimTranscript,
    isListening: isDiaryMicListening,
    isSupported: isDiaryMicSupported,
    error: diaryMicError,
    startListening: startDiaryListening,
    stopListening: stopDiaryListening,
    resetTranscript: resetDiaryTranscript,
  } = useSpeechRecognition({ continuous: true, lang: 'en-US' });
  const [diaryMicScope, setDiaryMicScope] = useState(null);
  // Snapshot of whatever text was already in the diary textarea the moment
  // dictation started, so spoken words are appended after it instead of
  // replacing it.
  const diaryBaseTextRef = useRef('');

  // Only one voice session (field or diary) is allowed at a time, so every
  // mic button outside the currently-active one disables itself instead of
  // letting a second engine try to run concurrently.
  const anyMicActive = isFieldMicListening || isDiaryMicListening;

  const handleToggleFieldMic = (scope, field) => {
    const key = `${scope}:${field}`;
    if (isFieldMicListening && activeFieldMic === key) {
      stopFieldListening();
      setActiveFieldMic(null);
      return;
    }
    setFieldParseError(null);
    setFieldMicDisplayError(null);
    setActiveFieldMic(key);
    resetFieldTranscript();
    startFieldListening();
  };

  // Parses each recognized utterance as a date (for the "date" field) or a
  // time (everything else) and writes it straight into the matching form.
  useEffect(() => {
    if (!fieldSpeechTranscript || !activeFieldMic) return;
    const [scope, field] = activeFieldMic.split(':');
    const raw = fieldSpeechTranscript.trim();

    if (field === 'date') {
      const parsedISO = parseSpokenDateToISO(raw);
      if (parsedISO) {
        setFieldParseError(null);
        setFieldMicDisplayError(null);
        handleAddFormChange('date', parsedISO);
      } else {
        setFieldParseError(`Didn't catch a date in "${raw}" — try saying it like "July 30 2026" or "today".`);
      }
      return;
    }

    const parsedTime = parseSpokenTimeToHHMM(raw);
    if (parsedTime) {
      setFieldParseError(null);
      setFieldMicDisplayError(null);
      if (scope === 'update') {
        handleFormChange(field, parsedTime);
      } else {
        handleAddFormChange(field, parsedTime);
      }
    } else {
      setFieldParseError(`Didn't catch a time in "${raw}" — try saying it like "8:30 AM".`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldSpeechTranscript]);

  // Mirrors a fresh raw recognition error into the locally-controlled copy
  // — only fires when the hook's error actually changes, so a stale error
  // left over from a previous, since-succeeded attempt never re-appears on
  // its own.
  useEffect(() => {
    if (fieldMicRawError) setFieldMicDisplayError(fieldMicRawError);
  }, [fieldMicRawError]);

  const handleToggleDiaryMic = (scope, currentText) => {
    if (isDiaryMicListening && diaryMicScope === scope) {
      stopDiaryListening();
      setDiaryMicScope(null);
      return;
    }
    diaryBaseTextRef.current = currentText;
    resetDiaryTranscript();
    setDiaryMicScope(scope);
    startDiaryListening();
  };

  // Merges each new finalized speech chunk onto the pre-dictation base text.
  useEffect(() => {
    if (!diarySpeechTranscript || !diaryMicScope) return;
    const base = diaryBaseTextRef.current;
    const merged = base
      ? (base.endsWith('\n') || base.endsWith(' ') ? `${base}${diarySpeechTranscript}` : `${base} ${diarySpeechTranscript}`)
      : diarySpeechTranscript;
    if (diaryMicScope === 'update') {
      handleFormChange('diaryText', merged);
    } else {
      handleAddFormChange('diaryText', merged);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diarySpeechTranscript, diaryMicScope]);

  // Release the Update modal's mic sessions the moment it closes, so a
  // background mic can't linger after the form disappears.
  useEffect(() => {
    if (!activeUpdateLog) {
      if (activeFieldMic?.startsWith('update:')) {
        stopFieldListening();
        resetFieldTranscript();
        setActiveFieldMic(null);
        setFieldParseError(null);
        setFieldMicDisplayError(null);
      }
      if (diaryMicScope === 'update') {
        stopDiaryListening();
        resetDiaryTranscript();
        setDiaryMicScope(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUpdateLog]);

  // Same cleanup for the Add modal.
  useEffect(() => {
    if (!isAddModalOpen) {
      if (activeFieldMic?.startsWith('add:')) {
        stopFieldListening();
        resetFieldTranscript();
        setActiveFieldMic(null);
        setFieldParseError(null);
        setFieldMicDisplayError(null);
      }
      if (diaryMicScope === 'add') {
        stopDiaryListening();
        resetDiaryTranscript();
        setDiaryMicScope(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAddModalOpen]);

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
    if (activeFieldMic === `update:${field}`) {
      stopFieldListening();
      setActiveFieldMic(null);
    }
    if (field === 'diaryText' && diaryMicScope === 'update') {
      stopDiaryListening();
      setDiaryMicScope(null);
    }
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
    if (activeFieldMic === `add:${field}`) {
      stopFieldListening();
      setActiveFieldMic(null);
    }
    if (field === 'diaryText' && diaryMicScope === 'add') {
      stopDiaryListening();
      setDiaryMicScope(null);
    }
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
                    <TimeFieldWithMic
                      label="Time In"
                      inputRef={amInputRef}
                      max="11:59"
                      value={updateFormData.amIn}
                      onChange={(e) => handleFormChange('amIn', e.target.value)}
                      onFocus={() => setActiveShiftField('AM')}
                      onBlur={() => setActiveShiftField(null)}
                      isMicSupported={isFieldMicSupported}
                      isMicActive={isFieldMicListening && activeFieldMic === 'update:amIn'}
                      isMicDisabled={anyMicActive && !(isFieldMicListening && activeFieldMic === 'update:amIn')}
                      micInterimTranscript={fieldInterimTranscript}
                      micError={activeFieldMic === 'update:amIn' ? (fieldParseError || fieldMicDisplayError) : null}
                      onToggleMic={() => handleToggleFieldMic('update', 'amIn')}
                    />
                    <TimeFieldWithMic
                      label="Time Out"
                      value={updateFormData.amOut}
                      onChange={(e) => handleFormChange('amOut', e.target.value)}
                      onFocus={() => setActiveShiftField('AM')}
                      onBlur={() => setActiveShiftField(null)}
                      isMicSupported={isFieldMicSupported}
                      isMicActive={isFieldMicListening && activeFieldMic === 'update:amOut'}
                      isMicDisabled={anyMicActive && !(isFieldMicListening && activeFieldMic === 'update:amOut')}
                      micInterimTranscript={fieldInterimTranscript}
                      micError={activeFieldMic === 'update:amOut' ? (fieldParseError || fieldMicDisplayError) : null}
                      onToggleMic={() => handleToggleFieldMic('update', 'amOut')}
                    />
                  </div>

                  <div 
                    className={`form-grid-section shift-focus-card clickable-form-card ${
                      activeShiftField === 'PM' ? 'focused-shift' : activeShiftField ? 'dimmed-shift' : ''
                    }`}
                    onClick={() => pmInputRef.current?.focus()}
                  >
                    <h5 className="form-section-heading">🌤️ Afternoon Shift (PM)</h5>
                    <TimeFieldWithMic
                      label="Time In"
                      inputRef={pmInputRef}
                      value={updateFormData.pmIn}
                      onChange={(e) => handleFormChange('pmIn', e.target.value)}
                      onFocus={() => setActiveShiftField('PM')}
                      onBlur={() => setActiveShiftField(null)}
                      isMicSupported={isFieldMicSupported}
                      isMicActive={isFieldMicListening && activeFieldMic === 'update:pmIn'}
                      isMicDisabled={anyMicActive && !(isFieldMicListening && activeFieldMic === 'update:pmIn')}
                      micInterimTranscript={fieldInterimTranscript}
                      micError={activeFieldMic === 'update:pmIn' ? (fieldParseError || fieldMicDisplayError) : null}
                      onToggleMic={() => handleToggleFieldMic('update', 'pmIn')}
                    />
                    <TimeFieldWithMic
                      label="Time Out"
                      value={updateFormData.pmOut}
                      onChange={(e) => handleFormChange('pmOut', e.target.value)}
                      onFocus={() => setActiveShiftField('PM')}
                      onBlur={() => setActiveShiftField(null)}
                      isMicSupported={isFieldMicSupported}
                      isMicActive={isFieldMicListening && activeFieldMic === 'update:pmOut'}
                      isMicDisabled={anyMicActive && !(isFieldMicListening && activeFieldMic === 'update:pmOut')}
                      micInterimTranscript={fieldInterimTranscript}
                      micError={activeFieldMic === 'update:pmOut' ? (fieldParseError || fieldMicDisplayError) : null}
                      onToggleMic={() => handleToggleFieldMic('update', 'pmOut')}
                    />
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
                    <div className="textarea-mic-row">
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
                      {isDiaryMicSupported && (
                        <button
                          type="button"
                          className={`field-mic-btn${isDiaryMicListening && diaryMicScope === 'update' ? ' field-mic-btn-active' : ''}`}
                          onClick={() => handleToggleDiaryMic('update', updateFormData.diaryText || '')}
                          disabled={anyMicActive && !(isDiaryMicListening && diaryMicScope === 'update')}
                          aria-label={isDiaryMicListening && diaryMicScope === 'update' ? 'Stop voice dictation' : 'Dictate summary by speaking'}
                          title={isDiaryMicListening && diaryMicScope === 'update' ? 'Stop voice dictation' : 'Dictate by speaking'}
                        >
                          <MicIcon />
                        </button>
                      )}
                    </div>
                    {isDiaryMicListening && diaryMicScope === 'update' && (
                      <p className="field-mic-status">🎙️ Listening… {diaryInterimTranscript}</p>
                    )}
                    {diaryMicScope === 'update' && diaryMicError && (
                      <p className="field-mic-error" role="alert">⚠️ {diaryMicError}</p>
                    )}
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
                <div className="form-input-field date-field-card">
                  <label htmlFor="add-history-date">📅 Date</label>
                  <div className="field-input-mic-row">
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
                    {isFieldMicSupported && (
                      <button
                        type="button"
                        className={`field-mic-btn${isFieldMicListening && activeFieldMic === 'add:date' ? ' field-mic-btn-active' : ''}`}
                        onClick={() => handleToggleFieldMic('add', 'date')}
                        disabled={anyMicActive && !(isFieldMicListening && activeFieldMic === 'add:date')}
                        aria-label={isFieldMicListening && activeFieldMic === 'add:date' ? 'Stop voice input for Date' : 'Say the date'}
                        title={
                          isFieldMicListening && activeFieldMic === 'add:date'
                            ? 'Stop voice input'
                            : 'Say the date, e.g. "July 30 2026" or "today"'
                        }
                      >
                        <MicIcon />
                      </button>
                    )}
                  </div>
                  {isFieldMicListening && activeFieldMic === 'add:date' && (
                    <p className="field-mic-status">🎙️ Listening… {fieldInterimTranscript}</p>
                  )}
                  {activeFieldMic === 'add:date' && (fieldParseError || fieldMicDisplayError) && (
                    <p className="field-mic-error" role="alert">⚠️ {fieldParseError || fieldMicDisplayError}</p>
                  )}
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
                    <TimeFieldWithMic
                      label="Time In"
                      inputRef={addAmInputRef}
                      max="11:59"
                      value={addFormData.amIn}
                      onChange={(e) => handleAddFormChange('amIn', e.target.value)}
                      onFocus={() => setActiveAddShiftField('AM')}
                      onBlur={() => setActiveAddShiftField(null)}
                      isMicSupported={isFieldMicSupported}
                      isMicActive={isFieldMicListening && activeFieldMic === 'add:amIn'}
                      isMicDisabled={anyMicActive && !(isFieldMicListening && activeFieldMic === 'add:amIn')}
                      micInterimTranscript={fieldInterimTranscript}
                      micError={activeFieldMic === 'add:amIn' ? (fieldParseError || fieldMicDisplayError) : null}
                      onToggleMic={() => handleToggleFieldMic('add', 'amIn')}
                    />
                    <TimeFieldWithMic
                      label="Time Out"
                      value={addFormData.amOut}
                      onChange={(e) => handleAddFormChange('amOut', e.target.value)}
                      onFocus={() => setActiveAddShiftField('AM')}
                      onBlur={() => setActiveAddShiftField(null)}
                      isMicSupported={isFieldMicSupported}
                      isMicActive={isFieldMicListening && activeFieldMic === 'add:amOut'}
                      isMicDisabled={anyMicActive && !(isFieldMicListening && activeFieldMic === 'add:amOut')}
                      micInterimTranscript={fieldInterimTranscript}
                      micError={activeFieldMic === 'add:amOut' ? (fieldParseError || fieldMicDisplayError) : null}
                      onToggleMic={() => handleToggleFieldMic('add', 'amOut')}
                    />
                  </div>

                  <div
                    className={`form-grid-section shift-focus-card clickable-form-card ${
                      activeAddShiftField === 'PM' ? 'focused-shift' : activeAddShiftField ? 'dimmed-shift' : ''
                    }`}
                    onClick={() => addPmInputRef.current?.focus()}
                  >
                    <h5 className="form-section-heading">🌤️ Afternoon Shift (PM)</h5>
                    <TimeFieldWithMic
                      label="Time In"
                      inputRef={addPmInputRef}
                      value={addFormData.pmIn}
                      onChange={(e) => handleAddFormChange('pmIn', e.target.value)}
                      onFocus={() => setActiveAddShiftField('PM')}
                      onBlur={() => setActiveAddShiftField(null)}
                      isMicSupported={isFieldMicSupported}
                      isMicActive={isFieldMicListening && activeFieldMic === 'add:pmIn'}
                      isMicDisabled={anyMicActive && !(isFieldMicListening && activeFieldMic === 'add:pmIn')}
                      micInterimTranscript={fieldInterimTranscript}
                      micError={activeFieldMic === 'add:pmIn' ? (fieldParseError || fieldMicDisplayError) : null}
                      onToggleMic={() => handleToggleFieldMic('add', 'pmIn')}
                    />
                    <TimeFieldWithMic
                      label="Time Out"
                      value={addFormData.pmOut}
                      onChange={(e) => handleAddFormChange('pmOut', e.target.value)}
                      onFocus={() => setActiveAddShiftField('PM')}
                      onBlur={() => setActiveAddShiftField(null)}
                      isMicSupported={isFieldMicSupported}
                      isMicActive={isFieldMicListening && activeFieldMic === 'add:pmOut'}
                      isMicDisabled={anyMicActive && !(isFieldMicListening && activeFieldMic === 'add:pmOut')}
                      micInterimTranscript={fieldInterimTranscript}
                      micError={activeFieldMic === 'add:pmOut' ? (fieldParseError || fieldMicDisplayError) : null}
                      onToggleMic={() => handleToggleFieldMic('add', 'pmOut')}
                    />
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
                    <div className="textarea-mic-row">
                      <textarea
                        ref={addDiaryInputRef}
                        value={addFormData.diaryText || ''}
                        onChange={(e) => handleAddFormChange('diaryText', e.target.value)}
                        rows={4}
                        onFocus={() => setActiveAddShiftField('DIARY')}
                        onBlur={() => setActiveAddShiftField(null)}
                        placeholder="Describe your primary technical operations, accomplishments..."
                      />
                      {isDiaryMicSupported && (
                        <button
                          type="button"
                          className={`field-mic-btn${isDiaryMicListening && diaryMicScope === 'add' ? ' field-mic-btn-active' : ''}`}
                          onClick={() => handleToggleDiaryMic('add', addFormData.diaryText || '')}
                          disabled={anyMicActive && !(isDiaryMicListening && diaryMicScope === 'add')}
                          aria-label={isDiaryMicListening && diaryMicScope === 'add' ? 'Stop voice dictation' : 'Dictate summary by speaking'}
                          title={isDiaryMicListening && diaryMicScope === 'add' ? 'Stop voice dictation' : 'Dictate by speaking'}
                        >
                          <MicIcon />
                        </button>
                      )}
                    </div>
                    {isDiaryMicListening && diaryMicScope === 'add' && (
                      <p className="field-mic-status">🎙️ Listening… {diaryInterimTranscript}</p>
                    )}
                    {diaryMicScope === 'add' && diaryMicError && (
                      <p className="field-mic-error" role="alert">⚠️ {diaryMicError}</p>
                    )}
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