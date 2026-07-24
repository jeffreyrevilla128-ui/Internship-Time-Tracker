import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../config/database.js';

const SALT_ROUNDS = 10;

export async function findUserByEmail(email) {
  const result = await pool.query(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );
  return result.rows[0];
}

// Used by login — accepts either email or username in one field,
// matching the frontend's single "identifier" input.
export async function findUserByIdentifier(identifier) {
  const result = await pool.query(
    'SELECT * FROM users WHERE email = $1 OR username = $1',
    [identifier]
  );
  return result.rows[0];
}

// Used by GET /api/auth/me — looks the user up by the id decoded from
// their JWT (req.user.id), rather than anything they typed in. Excludes
// password_hash directly in the query, so it's never in memory here at all.
export async function findUserById(id) {
  const result = await pool.query(
    'SELECT id, username, email, role, created_at FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

export async function createUser({ username, email, password, role = 'intern' }) {
  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

  const result = await pool.query(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, email, role, created_at`,
    [username, email, password_hash, role]
  );

  return result.rows[0];
}

export function generateToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );
}

export async function validatePassword(plainPassword, hash) {
  return bcrypt.compare(plainPassword, hash);
}