import pool from '../config/database.js';

export async function findConfigByUserId(userId) {
  const result = await pool.query(
    'SELECT * FROM internship_configuration WHERE user_id = $1',
    [userId]
  );
  return result.rows[0];
}

// Single row per user (user_id is UNIQUE), so this always "just saves" —
// no separate create-vs-update branch needed on the frontend or controller.
// ON CONFLICT handles first-time setup and later edits with one query.
export async function upsertConfig(userId, { requiredHours, officialStartDate }) {
  const result = await pool.query(
    `INSERT INTO internship_configuration (user_id, required_hours, official_start_date)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id)
     DO UPDATE SET
       required_hours = EXCLUDED.required_hours,
       official_start_date = EXCLUDED.official_start_date,
       updated_at = CURRENT_TIMESTAMP
     RETURNING id, user_id, required_hours, official_start_date, created_at, updated_at`,
    [userId, requiredHours, officialStartDate]
  );
  return result.rows[0];
}