import pool from '../config/database.js';

// Converts "HH:MM" pairs into { hours, minutes } worked, same logic as
// the frontend's calculateHoursAndMinutes, kept server-side so totals are
// trustworthy even if a client sends stale/tampered numbers.
function calculateHoursAndMinutes(amIn, amOut, pmIn, pmOut) {
  let totalMinutes = 0;
  const baseDate = '2026-01-01 ';

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
    totalHours: Number((totalMinutes / 60).toFixed(2)),
  };
}

function totalHoursForPair(timeIn, timeOut) {
  const baseDate = '2026-01-01 ';
  const diffMs = new Date(baseDate + timeOut) - new Date(baseDate + timeIn);
  return diffMs > 0 ? Number((diffMs / (1000 * 60 * 60)).toFixed(2)) : 0;
}

// Resolves the internship_configuration row owned by this user — every
// attendance/diary query is scoped through this so one user can never
// read or modify another user's logs.
async function getConfigIdForUser(userId) {
  const result = await pool.query(
    'SELECT id FROM internship_configuration WHERE user_id = $1',
    [userId]
  );
  return result.rows[0]?.id || null;
}

// Only returns *completed* days — this is what HistoryLogs and the
// dashboard's grand-total calculation treat as "finished history".
// Today's in-progress row (is_completed = false) is deliberately excluded
// here; it's fetched separately via getDayForUser to seed shiftState,
// so it's never counted or displayed twice.
export async function getAllLogsForUser(userId) {
  const configId = await getConfigIdForUser(userId);
  if (!configId) return [];

  const result = await pool.query(
    `SELECT
       a.id,
       a.attendance_date,
       a.morning_time_in,
       a.morning_time_out,
       a.afternoon_time_in,
       a.afternoon_time_out,
       a.total_hours,
       a.status,
       a.is_completed,
       a.updated_at,
       d.diary_text
     FROM attendance a
     LEFT JOIN daily_diaries d ON d.attendance_id = a.id
     WHERE a.internship_configuration_id = $1
       AND a.is_completed = true
     ORDER BY a.attendance_date DESC`,
    [configId]
  );

  return result.rows;
}

// Fetches the (possibly in-progress) attendance row for one specific date —
// used to seed PunchCard's shiftState on page load/refresh, regardless of
// whether it's completed yet. Returns null if no row exists for that date.
export async function getDayForUser(userId, date) {
  const configId = await getConfigIdForUser(userId);
  if (!configId) return null;

  const result = await pool.query(
    `SELECT
       a.id,
       a.attendance_date,
       a.morning_time_in,
       a.morning_time_out,
       a.afternoon_time_in,
       a.afternoon_time_out,
       a.total_hours,
       a.is_completed,
       a.updated_at,
       d.diary_text
     FROM attendance a
     LEFT JOIN daily_diaries d ON d.attendance_id = a.id
     WHERE a.internship_configuration_id = $1
       AND a.attendance_date = $2`,
    [configId, date]
  );

  return result.rows[0] || null;
}

export async function updateLogForUser(userId, attendanceId, { amIn, amOut, pmIn, pmOut, diaryText }) {
  const configId = await getConfigIdForUser(userId);
  if (!configId) throw new Error('No internship configuration found for this user');

  const { hours, minutes, totalHours } = calculateHoursAndMinutes(amIn, amOut, pmIn, pmOut);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Scoped by internship_configuration_id too, so a user can't update
    // another user's attendance row even by guessing an id.
    const attendanceResult = await client.query(
      `UPDATE attendance
       SET morning_time_in = $1,
           morning_time_out = $2,
           afternoon_time_in = $3,
           afternoon_time_out = $4,
           morning_hours = $5,
           afternoon_hours = $6,
           total_hours = $7,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $8 AND internship_configuration_id = $9
       RETURNING *`,
      [
        amIn || null,
        amOut || null,
        pmIn || null,
        pmOut || null,
        amIn && amOut ? totalHoursForPair(amIn, amOut) : 0,
        pmIn && pmOut ? totalHoursForPair(pmIn, pmOut) : 0,
        totalHours,
        attendanceId,
        configId,
      ]
    );

    if (attendanceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return null; // not found or not owned by this user
    }

    const diaryResult = await client.query(
      `INSERT INTO daily_diaries (attendance_id, diary_text)
       VALUES ($1, $2)
       ON CONFLICT (attendance_id)
       DO UPDATE SET diary_text = EXCLUDED.diary_text, updated_at = CURRENT_TIMESTAMP
       RETURNING diary_text`,
      [attendanceId, diaryText || '']
    );

    await client.query('COMMIT');

    return {
      ...attendanceResult.rows[0],
      diary_text: diaryResult.rows[0].diary_text,
      hours,
      minutes,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Creates or updates the attendance row for a given calendar date — used by
// PunchCard on every Time In/Out save. PunchCard always has the full
// current shiftState in scope, so it's safe to overwrite all four time
// fields here; this is never called with partial data.
export async function upsertDayForUser(userId, { date, amIn, amOut, pmIn, pmOut, isCompleted }) {
  const configId = await getConfigIdForUser(userId);
  if (!configId) throw new Error('No internship configuration found for this user');

  const { hours, minutes, totalHours } = calculateHoursAndMinutes(amIn, amOut, pmIn, pmOut);

  const result = await pool.query(
    `INSERT INTO attendance (
       internship_configuration_id, attendance_date,
       morning_time_in, morning_time_out, afternoon_time_in, afternoon_time_out,
       morning_hours, afternoon_hours, total_hours, is_completed
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (internship_configuration_id, attendance_date)
     DO UPDATE SET
       morning_time_in = EXCLUDED.morning_time_in,
       morning_time_out = EXCLUDED.morning_time_out,
       afternoon_time_in = EXCLUDED.afternoon_time_in,
       afternoon_time_out = EXCLUDED.afternoon_time_out,
       morning_hours = EXCLUDED.morning_hours,
       afternoon_hours = EXCLUDED.afternoon_hours,
       total_hours = EXCLUDED.total_hours,
       is_completed = EXCLUDED.is_completed,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [
      configId,
      date,
      amIn || null,
      amOut || null,
      pmIn || null,
      pmOut || null,
      amIn && amOut ? totalHoursForPair(amIn, amOut) : 0,
      pmIn && pmOut ? totalHoursForPair(pmIn, pmOut) : 0,
      totalHours,
      Boolean(isCompleted),
    ]
  );

  const attendanceRow = result.rows[0];
  const existingDiary = await pool.query(
    'SELECT diary_text FROM daily_diaries WHERE attendance_id = $1',
    [attendanceRow.id]
  );

  return {
    ...attendanceRow,
    diary_text: existingDiary.rows[0]?.diary_text ?? '',
    hours,
    minutes,
  };
}

// Upserts ONLY the diary text for an existing attendance day — deliberately
// never touches morning_time_in/out or afternoon_time_in/out. DiaryForm can
// edit a diary entry independently of PunchCard, so this must not risk
// nulling out already-recorded punches the way a full day-upsert would if
// time fields were omitted.
export async function upsertDiaryOnlyForUser(userId, date, diaryText) {
  const configId = await getConfigIdForUser(userId);
  if (!configId) throw new Error('No internship configuration found for this user');

  const attendanceResult = await pool.query(
    'SELECT id FROM attendance WHERE internship_configuration_id = $1 AND attendance_date = $2',
    [configId, date]
  );
  const attendanceRow = attendanceResult.rows[0];
  if (!attendanceRow) return null; // no punches recorded for this date yet

  const diaryResult = await pool.query(
    `INSERT INTO daily_diaries (attendance_id, diary_text)
     VALUES ($1, $2)
     ON CONFLICT (attendance_id)
     DO UPDATE SET diary_text = EXCLUDED.diary_text, updated_at = CURRENT_TIMESTAMP
     RETURNING diary_text, updated_at`,
    [attendanceRow.id, diaryText || '']
  );

  return {
    attendance_id: attendanceRow.id,
    date,
    diary_text: diaryResult.rows[0].diary_text,
    updated_at: diaryResult.rows[0].updated_at,
  };
}

export async function deleteDiaryForUserAndDate(userId, date) {
  const configId = await getConfigIdForUser(userId);
  if (!configId) throw new Error('No internship configuration found for this user');

  const result = await pool.query(
    `DELETE FROM daily_diaries d
     USING attendance a
     WHERE d.attendance_id = a.id
       AND a.internship_configuration_id = $1
       AND a.attendance_date = $2
     RETURNING d.id`,
    [configId, date]
  );

  return result.rows[0] || null;
}

export async function deleteLogForUser(userId, attendanceId) {
  const configId = await getConfigIdForUser(userId);
  if (!configId) throw new Error('No internship configuration found for this user');

  // daily_diaries row is removed automatically via ON DELETE CASCADE.
  const result = await pool.query(
    'DELETE FROM attendance WHERE id = $1 AND internship_configuration_id = $2 RETURNING id',
    [attendanceId, configId]
  );

  return result.rows[0] || null;
}