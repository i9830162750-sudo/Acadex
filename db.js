require("dotenv").config({ path: ".env.local" });

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exams (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'pdf',
      pdf_data_url TEXT,
      questions_json JSONB,
      student_password TEXT NOT NULL,
      duration_ms BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS exam_sessions (
      token TEXT PRIMARY KEY,
      exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      started_at BIGINT NOT NULL,
      end_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      finished_at BIGINT
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_exam_sessions_exam
    ON exam_sessions(exam_id);
  `);

  console.log("✅ Neon database ready.");
}

module.exports = {
  pool,
  initDatabase
};
