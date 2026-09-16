const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const db = require('./db');

const app = express();

// Large limit: PDFs arrive as base64 data URLs in the JSON body.
app.use(cors());
app.use(express.json({ limit: '25mb' }));

/* ─────────────────────────────────────────────
   GET /ping
   Health check + cold-start warmer. The generator
   pings this on load so Render spins up before the
   teacher hits "Generate".
───────────────────────────────────────────── */
app.get('/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/* ─────────────────────────────────────────────
   POST /exam/create
   Body: { title, studentPassword, durationMs, pdfDataUrl }
   Returns: { examId, url }
───────────────────────────────────────────── */
app.post('/exam/create', (req, res) => {
  const { title, studentPassword, durationMs, pdfDataUrl } = req.body || {};

  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'title is required' });
  }
  if (!studentPassword || typeof studentPassword !== 'string') {
    return res.status(400).json({ error: 'studentPassword is required' });
  }
  if (!durationMs || typeof durationMs !== 'number' || durationMs <= 0) {
    return res.status(400).json({ error: 'durationMs must be a positive number' });
  }
  if (!pdfDataUrl || typeof pdfDataUrl !== 'string' || !pdfDataUrl.startsWith('data:application/pdf')) {
    return res.status(400).json({ error: 'pdfDataUrl must be a base64 PDF data URL' });
  }

  const examId = 'exam_' + crypto.randomBytes(12).toString('hex');

  db.prepare(`
    INSERT INTO exams (id, title, type, pdf_data_url, student_password, duration_ms, created_at)
    VALUES (?, ?, 'pdf', ?, ?, ?, ?)
  `).run(examId, title, pdfDataUrl, studentPassword, durationMs, Date.now());

  const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

  res.json({
    examId,
    url: `${baseUrl}/exam/${examId}`
  });
});

/* ─────────────────────────────────────────────
   GET /exam/:id
   Returns exam metadata needed to render the
   student page. Password is NOT returned — the
   client submits it to a check, handled client-side
   for now since verification happens in phase 3's
   student page build. Phase 2 just exposes the data
   the student page will need once wired up.
───────────────────────────────────────────── */
app.get('/exam/:id', (req, res) => {
  const exam = db.prepare(`
    SELECT id, title, type, pdf_data_url, duration_ms, created_at
    FROM exams WHERE id = ?
  `).get(req.params.id);

  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }

  res.json({
    examId: exam.id,
    title: exam.title,
    type: exam.type,
    pdfDataUrl: exam.pdf_data_url,
    durationMs: exam.duration_ms,
    createdAt: exam.created_at
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Exam backend listening on port ${PORT}`);
});
