const API_BASE = 'http://localhost:5000/api';

// Must match TOKEN_STORAGE_KEY in App.jsx — that's the actual key the
// token is stored under after login/register.
const TOKEN_STORAGE_KEY = 'ojt-auth-token';

function getToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getToken()}`,
  };
}

// --- Shared attendance-logs cache ------------------------------------------
// A single in-memory cache for the full completed-logs list, shared across
// every component that calls fetchLogs() (OJTDashboard on mount, and
// HistoryLogs' own load-on-tab-visit) — module state persists for the
// whole page session, independent of which component happens to be
// mounted, so navigating between tabs reuses it instead of re-hitting the
// network every time. Only cleared when a write actually happens
// (PunchCard's saveDay/saveDiaryOnly, or HistoryLogs' add/update/delete),
// so the next fetchLogs() call after a real change fetches fresh data —
// everything else transparently reuses what's already in memory.
let logsCache = null;

export function invalidateLogsCache() {
  logsCache = null;
}

// Normalizes a raw Postgres DATE value into a "YYYY-MM-DD" string.
//
// node-postgres (pg) parses DATE columns into JS Date objects by default —
// nothing in this codebase overrides that via pg.types.setTypeParser — so
// row.attendance_date is NOT always a string. The old code
// (`row.attendance_date?.split?.('T')[0] || row.attendance_date`) silently
// fell through to the raw Date object whenever `.split` didn't exist,
// which broke every strict `===` comparison against `.date` elsewhere in
// the app (list matching, "does a record already exist for this date"
// checks, sorting, filtering) since a Date object is never `===` to a
// string, even for the same calendar day. This is the single place that
// conversion happens now, so it can't drift out of sync between callers.
function normalizeDateToKey(rawDate) {
  if (!rawDate) return '';
  if (typeof rawDate === 'string') return rawDate.split('T')[0];
  if (rawDate instanceof Date) {
    // pg parses DATE columns at UTC midnight regardless of server/DB
    // timezone — use the UTC getters here, not local ones, so the
    // extracted key matches what was actually stored rather than
    // shifting a day off depending on the browser's timezone offset.
    const y = rawDate.getUTCFullYear();
    const m = String(rawDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(rawDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(rawDate);
}

// Maps a raw DB row (snake_case, separate diary_text/total_hours) into the
// shape HistoryLogs.jsx already expects (camelCase, hours/minutes split,
// a computed weekday label).
function mapLogFromApi(row) {
  const date = normalizeDateToKey(row.attendance_date);
  const day = date
    ? new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long' })
    : '';

  const totalHours = Number(row.total_hours) || 0;
  const hours = Math.floor(totalHours);
  const minutes = Math.round((totalHours - hours) * 60);

  return {
    id: row.id,
    date,
    day,
    amIn: row.morning_time_in,
    amOut: row.morning_time_out,
    pmIn: row.afternoon_time_in,
    pmOut: row.afternoon_time_out,
    hours,
    minutes,
    diaryText: row.diary_text || '',
    submittedAt: row.updated_at
      ? new Date(row.updated_at).toLocaleString()
      : '',
  };
}

// --- Time format bridge ---------------------------------------------------
// PunchCard/DiaryForm work in 12-hour strings ("8:30 AM"), matching what
// <input type="time"> conversions produce there. Postgres TIME columns
// come back as 24-hour strings ("08:30:00"). These two helpers are the only
// place that translation happens, kept separate from mapLogFromApi (which
// HistoryLogs already depends on in 24-hour form).
function to24HourForApi(time12h) {
  if (!time12h) return null;
  const match = time12h.match(/^(\d+):(\d+)\s*(AM|PM)$/i);
  if (!match) return null;
  let [, hours, minutes, modifier] = match;
  hours = Number(hours);
  if (modifier.toUpperCase() === 'PM' && hours !== 12) hours += 12;
  if (modifier.toUpperCase() === 'AM' && hours === 12) hours = 0;
  return `${String(hours).padStart(2, '0')}:${minutes}:00`;
}

function to12HourFromApi(time24h) {
  if (!time24h) return '';
  const [hStr, mStr] = time24h.split(':');
  let hours = Number(hStr);
  const modifier = hours >= 12 ? 'PM' : 'AM';
  let hours12 = hours % 12;
  if (hours12 === 0) hours12 = 12;
  return `${hours12}:${mStr} ${modifier}`;
}

// Maps a raw DB row into the shape PunchCard's shiftState expects (12-hour
// strings, isCompleted, date) — distinct from mapLogFromApi above, which
// HistoryLogs relies on in a different shape/format.
function mapRowToShiftState(row) {
  const dateKey = normalizeDateToKey(row.attendance_date);
  return {
    date: dateKey,
    amIn: to12HourFromApi(row.morning_time_in),
    amOut: to12HourFromApi(row.morning_time_out),
    pmIn: to12HourFromApi(row.afternoon_time_in),
    pmOut: to12HourFromApi(row.afternoon_time_out),
    isCompleted: Boolean(row.is_completed),
    diaryEntries: row.diary_text
      ? [{ id: row.id, date: dateKey, text: row.diary_text, timestamp: row.updated_at }]
      : [],
  };
}

// Fetches all COMPLETED attendance days for the logged-in user — the
// backend already excludes today's in-progress row (is_completed = false),
// so this is safe to use both for HistoryLogs and for the dashboard's
// grand-total calculation without double-counting today's live hours.
export async function fetchLogs() {
  if (logsCache) return [...logsCache];

  const res = await fetch(`${API_BASE}/attendance`, {
    headers: authHeaders(),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load attendance history');

  logsCache = data.logs.map(mapLogFromApi);
  return [...logsCache];
}

// Fetches the (possibly in-progress) attendance row for one specific date.
// Used by OJTDashboard on mount to seed shiftState — e.g. restoring an
// already-clocked-in morning after a page refresh. Returns null if
// nothing has been recorded for that date yet.
export async function fetchDay(date) {
  const res = await fetch(`${API_BASE}/attendance/day/${date}`, {
    headers: authHeaders(),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load attendance for this date');
  if (!data.log) return null;

  return mapRowToShiftState(data.log);
}

// Upserts the attendance (+ optional diary) row for a given date. Used by
// PunchCard on every Time In/Out save, and by the diary quick-entry modal.
// Pass diaryText only when actually writing diary content — omitting it
// leaves whatever diary text already exists untouched.
export async function saveDay({ date, amIn, amOut, pmIn, pmOut, diaryText, isCompleted }) {
  const body = {
    date,
    amIn: to24HourForApi(amIn),
    amOut: to24HourForApi(amOut),
    pmIn: to24HourForApi(pmIn),
    pmOut: to24HourForApi(pmOut),
    isCompleted,
  };
  if (diaryText !== undefined) body.diaryText = diaryText;

  const res = await fetch(`${API_BASE}/attendance/day`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to save attendance record');

  invalidateLogsCache();
  return mapRowToShiftState(data.log);
}

// Upserts ONLY the diary text for a date — used by DiaryForm's
// create/edit actions, which must never risk overwriting that day's
// already-recorded punch times.
export async function saveDiaryOnly(date, diaryText) {
  const res = await fetch(`${API_BASE}/attendance/day/${date}/diary`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ diaryText }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to save diary entry');

  invalidateLogsCache();
  return data.diary; // { attendance_id, date, diary_text, updated_at }
}

// Removes just the diary entry for a given date, leaving the attendance
// (clock in/out) row itself intact — matches DiaryForm's "delete entry"
// action, which only ever removes the narrative, not the day's punches.
export async function deleteDiaryEntry(date) {
  const res = await fetch(`${API_BASE}/attendance/day/${date}/diary`, {
    method: 'DELETE',
    headers: authHeaders(),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to delete diary entry');

  invalidateLogsCache();
  return data;
}

// Creates a missing historical attendance record, or updates it in place
// if one already exists for that date — used by HistoryLogs' "Add
// Attendance History" feature (e.g. the person forgot to log a past day).
// Reuses the same PUT /attendance/day endpoint PunchCard relies on for
// live punches, so duplicate-prevention comes for free from the backend's
// existing UNIQUE(internship_configuration_id, attendance_date) upsert —
// this never creates a second row for a date that already has one.
//
// That endpoint doesn't accept diary text directly (PunchCard's own calls
// intentionally omit it so a Time In/Out save never blanks out an
// existing diary entry), so diary text is attached as a second call to
// the dedicated diary-only endpoint, same as every other diary write in
// the app. Returns HistoryLogs' row shape (24-hour strings, day label,
// hours/minutes split), not PunchCard's shiftState shape.
export async function upsertAttendanceByDate({ date, amIn, amOut, pmIn, pmOut, diaryText }) {
  const res = await fetch(`${API_BASE}/attendance/day`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({
      date,
      amIn: amIn || null,
      amOut: amOut || null,
      pmIn: pmIn || null,
      pmOut: pmOut || null,
      isCompleted: true,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to save attendance record');

  invalidateLogsCache();
  let finalLog = data.log;

  if (diaryText !== undefined && diaryText.trim()) {
    const diary = await saveDiaryOnly(date, diaryText);
    finalLog = { ...finalLog, diary_text: diary.diary_text };
  }

  return mapLogFromApi(finalLog);
}

export async function updateLog(id, { amIn, amOut, pmIn, pmOut, diaryText }) {
  const res = await fetch(`${API_BASE}/attendance/${id}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ amIn, amOut, pmIn, pmOut, diaryText }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update attendance record');

  invalidateLogsCache();
  return mapLogFromApi(data.log);
}

export async function deleteLog(id) {
  const res = await fetch(`${API_BASE}/attendance/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to delete attendance record');

  invalidateLogsCache();
  return data;
}