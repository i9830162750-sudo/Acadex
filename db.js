const Database = require('better-sqlite3');
const path = require('path');

// Render's disk persists under /data if you attach a persistent disk.
// Falls back to a local file for dev.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'exams.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS exams (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    type              TEXT NOT NULL DEFAULT 'pdf',   -- 'pdf' | 'template' (template arrives in phase 4)
    pdf_data_url      TEXT,                          -- base64 data URL, phase 2 scope: pdf only
    student_password  TEXT NOT NULL,
    duration_ms       INTEGER NOT NULL,
    created_at        INTEGER NOT NULL
  );
`);

module.exports = db;
