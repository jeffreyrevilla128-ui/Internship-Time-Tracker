import pg from 'pg';
const { Pool, types } = pg;

// Force PostgreSQL DATE columns to return as plain strings (YYYY-MM-DD)
// instead of JavaScript Date objects, preventing timezone date shifts.
types.setTypeParser(1082, (value) => value);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

pool.connect()
  .then((client) => {
    console.log('✅ Connected to Supabase Postgres');
    client.release();
  })
  .catch((err) => {
    console.error('❌ Database connection error:', err.message);
  });

export default pool;