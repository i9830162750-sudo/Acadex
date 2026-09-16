const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config({ path: '.env.local' });

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const app = express();

app.use(cors());
app.use(express.json({ limit: '25mb' }));

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function getExam(id) {
  const { rows } = await pool.query(`
    SELECT
      id,
      title,
      type,
      pdf_data_url,
      questions_json,
      student_password,
      duration_ms,
      created_at
    FROM exams
    WHERE id = $1
  `, [id]);

  return rows[0] || null;
}

function publicExam(exam) {
  let questions = [];

  if (exam.questions_json) {
    try {
      if (typeof exam.questions_json === 'string') {
        questions = JSON.parse(exam.questions_json);
      } else {
        questions = exam.questions_json;
      }
    } catch (_) {
      questions = [];
    }
  }

  return {
    examId: exam.id,
    title: exam.title,
    type: exam.type,
    pdfDataUrl: exam.pdf_data_url || null,
    questions,
    durationMs: Number(exam.duration_ms),
    createdAt: Number(exam.created_at)
  };
}

/* ─────────────────────────────────────────────
   GET /ping
───────────────────────────────────────────── */

app.get('/ping', (req, res) => {
  res.json({
    ok: true,
    ts: Date.now()
  });
});

/* ─────────────────────────────────────────────
   POST /exam/create

   Supports:
   - PDF exams
   - Phase 4 template exams
───────────────────────────────────────────── */

app.post('/exam/create', async (req, res) => {
  try {
    const {
      title,
      studentPassword,
      durationMs,
      type = 'pdf',
      pdfDataUrl = null,
      questions = []
    } = req.body || {};

    if (!title || typeof title !== 'string') {
      return res.status(400).json({
        error: 'title is required'
      });
    }

    if (!studentPassword || typeof studentPassword !== 'string') {
      return res.status(400).json({
        error: 'studentPassword is required'
      });
    }

    if (
      !durationMs ||
      typeof durationMs !== 'number' ||
      durationMs <= 0
    ) {
      return res.status(400).json({
        error: 'durationMs must be a positive number'
      });
    }

    if (type !== 'pdf' && type !== 'template') {
      return res.status(400).json({
        error: 'type must be pdf or template'
      });
    }

    if (type === 'pdf') {
      if (
        !pdfDataUrl ||
        typeof pdfDataUrl !== 'string' ||
        !pdfDataUrl.startsWith('data:application/pdf')
      ) {
        return res.status(400).json({
          error: 'pdfDataUrl must be a base64 PDF data URL'
        });
      }
    }

    if (type === 'template') {
      if (!Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({
          error: 'template exams require at least one question'
        });
      }

      for (const q of questions) {
        if (!q || !['mcq', 'tf'].includes(q.type)) {
          return res.status(400).json({
            error: 'invalid question type'
          });
        }

        if (
          typeof q.text !== 'string' ||
          !q.text.trim()
        ) {
          return res.status(400).json({
            error: 'every question needs text'
          });
        }

        if (q.type === 'mcq') {
          if (
            !Array.isArray(q.options) ||
            q.options.length !== 4 ||
            q.options.some(
              o => typeof o !== 'string' || !o.trim()
            ) ||
            !Number.isInteger(q.answer) ||
            q.answer < 0 ||
            q.answer > 3
          ) {
            return res.status(400).json({
              error: 'invalid MCQ question'
            });
          }
        }

        if (q.type === 'tf') {
          if (
            q.answer !== 'true' &&
            q.answer !== 'false'
          ) {
            return res.status(400).json({
              error: 'invalid True/False question'
            });
          }
        }
      }
    }

    const examId =
      'exam_' +
      crypto.randomBytes(12).toString('hex');

    const questionsJson =
      type === 'template'
        ? questions
        : null;

    await pool.query(`
      INSERT INTO exams (
        id,
        title,
        type,
        pdf_data_url,
        questions_json,
        student_password,
        duration_ms,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      examId,
      title,
      type,
      type === 'pdf' ? pdfDataUrl : null,
      questionsJson,
      studentPassword,
      durationMs,
      Date.now()
    ]);

    const baseUrl =
      process.env.PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get('host')}`;

    res.json({
      examId,
      url: `${baseUrl}/exam/${examId}`
    });

  } catch (error) {
    console.error('Create exam error:', error);

    res.status(500).json({
      error: 'Failed to create exam'
    });
  }
});

/* ─────────────────────────────────────────────
   GET /api/exam/:id

   Public metadata only.
───────────────────────────────────────────── */

app.get('/api/exam/:id', async (req, res) => {
  try {
    const exam = await getExam(req.params.id);

    if (!exam) {
      return res.status(404).json({
        error: 'Exam not found'
      });
    }

    const data = publicExam(exam);

    // Never expose password or exam contents
    // through this public metadata endpoint.
    delete data.pdfDataUrl;
    delete data.questions;

    res.json(data);

  } catch (error) {
    console.error('Get exam error:', error);

    res.status(500).json({
      error: 'Failed to load exam'
    });
  }
});

/* ─────────────────────────────────────────────
   POST /api/exam/:id/session

   First visit:
     body: { password }

   Refresh/resume:
     body: { sessionToken }

   Successful password entry creates a session.
   The token is stored by the student browser.
   Neon stores the authoritative end time.
───────────────────────────────────────────── */

app.post('/api/exam/:id/session', async (req, res) => {
  try {
    const exam = await getExam(req.params.id);

    if (!exam) {
      return res.status(404).json({
        error: 'Exam not found'
      });
    }

    const suppliedToken =
      typeof req.body?.sessionToken === 'string'
        ? req.body.sessionToken.trim()
        : '';

    /* ── Resume existing session ── */

    if (suppliedToken) {
      const { rows } = await pool.query(`
        SELECT
          token,
          exam_id,
          started_at,
          end_at,
          finished_at
        FROM exam_sessions
        WHERE token = $1
          AND exam_id = $2
      `, [
        suppliedToken,
        exam.id
      ]);

      const session = rows[0] || null;

      if (session) {
        if (
          session.finished_at ||
          Date.now() >= Number(session.end_at)
        ) {
          if (!session.finished_at) {
            await pool.query(`
              UPDATE exam_sessions
              SET finished_at = $1
              WHERE token = $2
            `, [
              Date.now(),
              session.token
            ]);
          }

          return res.status(410).json({
            error: 'Exam time is over',
            endAt: Number(session.end_at)
          });
        }

        return res.json({
          sessionToken: session.token,
          startedAt: Number(session.started_at),
          endAt: Number(session.end_at),
          ...publicExam(exam)
        });
      }
    }

    /* ── No valid session: require password ── */

    const password =
      typeof req.body?.password === 'string'
        ? req.body.password
        : '';

    if (!password) {
      return res.status(401).json({
        error: 'Password required'
      });
    }

    if (password !== exam.student_password) {
      return res.status(401).json({
        error: 'Incorrect password'
      });
    }

    const now = Date.now();
    const endAt =
      now + Number(exam.duration_ms);

    const token = makeToken();

    await pool.query(`
      INSERT INTO exam_sessions (
        token,
        exam_id,
        started_at,
        end_at,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5)
    `, [
      token,
      exam.id,
      now,
      endAt,
      now
    ]);

    res.json({
      sessionToken: token,
      startedAt: now,
      endAt,
      ...publicExam(exam)
    });

  } catch (error) {
    console.error('Session error:', error);

    res.status(500).json({
      error: 'Failed to create/resume session'
    });
  }
});

/* ─────────────────────────────────────────────
   POST /api/exam/:id/finish
───────────────────────────────────────────── */

app.post('/api/exam/:id/finish', async (req, res) => {
  try {
    const token =
      typeof req.body?.sessionToken === 'string'
        ? req.body.sessionToken.trim()
        : '';

    if (!token) {
      return res.status(400).json({
        error: 'sessionToken is required'
      });
    }

    const result = await pool.query(`
      UPDATE exam_sessions
      SET finished_at = $1
      WHERE token = $2
        AND exam_id = $3
        AND finished_at IS NULL
    `, [
      Date.now(),
      token,
      req.params.id
    ]);

    if (!result.rowCount) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    res.json({
      ok: true
    });

  } catch (error) {
    console.error('Finish session error:', error);

    res.status(500).json({
      error: 'Failed to finish session'
    });
  }
});

/* ─────────────────────────────────────────────
   STUDENT PAGE
───────────────────────────────────────────── */

app.get('/exam/:id', async (req, res) => {
  try {
    const exam = await getExam(req.params.id);

    if (!exam) {
      return res.status(404).send('Exam not found');
    }

    const safeId =
      JSON.stringify(exam.id);

    const safeTitle =
      JSON.stringify(exam.title);

    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(exam.title)}</title>

<style>
*{box-sizing:border-box}

html,body{
  margin:0;
  min-height:100%;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
  background:#0d0c0b;
  color:#f0ece4
}

#portal{
  position:fixed;
  inset:0;
  display:flex;
  align-items:center;
  justify-content:center;
  background:#0a0908;
  padding:24px
}

.card{
  width:min(410px,100%);
  padding:40px 32px;
  background:#181614;
  border:1px solid #ffffff18;
  border-radius:20px;
  text-align:center;
  box-shadow:0 24px 64px #0008
}

.card h1{
  margin:0 0 8px
}

.card p{
  color:#aaa;
  line-height:1.5
}

.card input{
  width:100%;
  padding:14px;
  border-radius:10px;
  border:1px solid #ffffff20;
  background:#0f0e0d;
  color:#fff;
  font-size:16px;
  outline:none
}

.card input:focus{
  border-color:#c94f1e
}

.card button{
  width:100%;
  margin-top:12px;
  padding:14px;
  border:0;
  border-radius:10px;
  font-weight:700;
  cursor:pointer
}

.card button:disabled{
  opacity:.6;
  cursor:wait
}

.err{
  min-height:20px;
  margin-top:10px;
  color:#f06b5c
}

#app{
  display:none;
  min-height:100vh
}

.top{
  position:sticky;
  top:0;
  z-index:100;
  display:flex;
  align-items:center;
  gap:16px;
  padding:12px 18px;
  background:#11100fee;
  border-bottom:1px solid #ffffff12;
  backdrop-filter:blur(10px)
}

.title{
  flex:1;
  font-weight:700;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap
}

.timer{
  font-weight:800;
  font-variant-numeric:tabular-nums;
  min-width:100px;
  text-align:center
}

.timer.warning{
  color:#e8a020
}

.timer.danger{
  color:#e84040
}

.controls{
  display:flex;
  gap:6px
}

.controls button{
  width:38px;
  height:34px;
  border:1px solid #ffffff18;
  border-radius:8px;
  background:#1b1917;
  color:#fff;
  cursor:pointer
}

#pdfViewer{
  padding:20px 12px 60px;
  display:flex;
  flex-direction:column;
  align-items:center;
  gap:18px
}

.page-wrap{
  overflow:hidden;
  background:#fff;
  box-shadow:0 10px 30px #0007;
  max-width:900px
}

.page-wrap canvas{
  display:block;
  transform-origin:top left
}

#templatePaper{
  width:min(850px,calc(100% - 24px));
  margin:28px auto 70px;
  padding:62px 70px;
  background:#fff;
  color:#202020;
  box-shadow:0 10px 40px #0008
}

.paper-title{
  font-size:30px;
  font-weight:700;
  line-height:1.2;
  margin-bottom:8px
}

.paper-meta{
  color:#666;
  font-size:13px;
  padding-bottom:16px;
  border-bottom:2px solid #202020;
  margin-bottom:32px
}

.q{
  display:grid;
  grid-template-columns:34px 1fr;
  gap:8px;
  margin-bottom:28px;
  break-inside:avoid
}

.qnum{
  font-weight:700
}

.qtext{
  font-size:16px;
  line-height:1.7;
  white-space:pre-wrap
}

.options{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:10px 28px;
  margin-top:12px
}

.option{
  font-size:15px;
  line-height:1.5
}

@media(max-width:700px){
  #templatePaper{
    padding:34px 24px;
    width:calc(100% - 16px)
  }

  .options{
    grid-template-columns:1fr
  }

  .top{
    flex-wrap:wrap
  }

  .title{
    width:100%
  }
}
</style>
</head>

<body>

<div id="portal">
  <div class="card">

    <h1>🔐 Exam Locked</h1>

    <p id="portalText">
      Enter your exam password to begin.
    </p>

    <input
      id="pwd"
      type="password"
      placeholder="Exam password"
      autocomplete="off"
      spellcheck="false"
    >

    <button id="enter">
      Enter Exam
    </button>

    <div id="err" class="err"></div>

  </div>
</div>

<div id="app">

  <div class="top">

    <div id="title" class="title">
      ${escapeHtml(exam.title)}
    </div>

    <div id="timer" class="timer">
      --:--:--
    </div>

    <div
      class="controls"
      id="pdfControls"
    >
      <button
        id="minus"
        aria-label="Zoom out"
      >−</button>

      <button id="reset">
        100%
      </button>

      <button
        id="plus"
        aria-label="Zoom in"
      >+</button>
    </div>

  </div>

  <div id="content"></div>

</div>

<script>

const EXAM_ID = ${safeId};
const EXAM_TITLE = ${safeTitle};

/*
  IndexedDB is used for student-side session persistence.

  It stores:
  - session token
  - timer deadline
  - started time
  - cached exam data

  This means a refresh does NOT restart
  the exam or ask for the password again
  on the same browser/device.
*/

const IDB_NAME = 'ExamToolDB';
const IDB_VERSION = 1;
const IDB_STORE = 'exam_sessions';

const $ = id =>
  document.getElementById(id);

let sessionToken = '';
let endAt = 0;
let timerId = null;
let zoom = 1;
let currentData = null;
let sessionState = null;

/* ─────────────────────────────────────────────
   INDEXEDDB
───────────────────────────────────────────── */

function openExamDB(){

  return new Promise((resolve,reject) => {

    const request =
      indexedDB.open(
        IDB_NAME,
        IDB_VERSION
      );

    request.onupgradeneeded = () => {

      const db =
        request.result;

      if(
        !db.objectStoreNames.contains(
          IDB_STORE
        )
      ){

        db.createObjectStore(
          IDB_STORE,
          {
            keyPath:'examId'
          }
        );

      }

    };

    request.onsuccess = () =>
      resolve(request.result);

    request.onerror = () =>
      reject(request.error);

  });

}

async function getStoredSession(){

  const db =
    await openExamDB();

  return new Promise(
    (resolve,reject) => {

      const tx =
        db.transaction(
          IDB_STORE,
          'readonly'
        );

      const request =
        tx
          .objectStore(IDB_STORE)
          .get(EXAM_ID);

      request.onsuccess = () =>
        resolve(
          request.result || null
        );

      request.onerror = () =>
        reject(request.error);

    }
  );

}

async function saveStoredSession(patch){

  const current =
    sessionState || {
      examId:EXAM_ID
    };

  sessionState = {
    ...current,
    ...patch,
    examId:EXAM_ID
  };

  try{

    const db =
      await openExamDB();

    await new Promise(
      (resolve,reject) => {

        const tx =
          db.transaction(
            IDB_STORE,
            'readwrite'
          );

        tx
          .objectStore(IDB_STORE)
          .put(sessionState);

        tx.oncomplete =
          resolve;

        tx.onerror = () =>
          reject(tx.error);

      }
    );

  }catch(_){}

}

async function deleteStoredSession(){

  sessionState = null;

  try{

    const db =
      await openExamDB();

    await new Promise(
      (resolve,reject) => {

        const tx =
          db.transaction(
            IDB_STORE,
            'readwrite'
          );

        tx
          .objectStore(IDB_STORE)
          .delete(EXAM_ID);

        tx.oncomplete =
          resolve;

        tx.onerror = () =>
          reject(tx.error);

      }
    );

  }catch(_){}

}

function cacheExamData(data){

  return {
    examId:data.examId,
    title:data.title,
    type:data.type,
    pdfDataUrl:
      data.pdfDataUrl || null,
    questions:
      data.questions || [],
    durationMs:data.durationMs,
    createdAt:data.createdAt
  };

}

/* ─────────────────────────────────────────────
   TIMER
───────────────────────────────────────────── */

function formatTime(ms){

  const total =
    Math.max(
      0,
      Math.floor(ms / 1000)
    );

  const h =
    Math.floor(total / 3600);

  const m =
    Math.floor(
      (total % 3600) / 60
    );

  const s =
    total % 60;

  return [h,m,s]
    .map(v =>
      String(v).padStart(2,'0')
    )
    .join(':');

}

function setTimerState(remaining){

  $('timer').textContent =
    formatTime(remaining);

  if(remaining <= 60000){

    $('timer').className =
      'timer danger';

  }else if(remaining <= 300000){

    $('timer').className =
      'timer warning';

  }else{

    $('timer').className =
      'timer';

  }

}

async function finishExam(){

  clearInterval(timerId);

  await saveStoredSession({

    finished:true,

    endAt:
      Number(
        endAt || Date.now()
      )

  });

  if(sessionToken){

    try{

      await fetch(
        '/api/exam/' +
        encodeURIComponent(EXAM_ID) +
        '/finish',
        {
          method:'POST',
          headers:{
            'Content-Type':
              'application/json'
          },
          body:JSON.stringify({
            sessionToken
          }),
          keepalive:true
        }
      );

    }catch(_){}

  }

  $('content').innerHTML = \`
    <div
      style="
        min-height:70vh;
        display:flex;
        align-items:center;
        justify-content:center;
        text-align:center;
        padding:30px
      "
    >
      <div>

        <div
          style="font-size:4rem"
        >🔒</div>

        <h1>Time is Over</h1>

        <p style="color:#aaa">
          The exam has been closed.
        </p>

      </div>
    </div>
  \`;

}

function tick(){

  const remaining =
    endAt - Date.now();

  if(remaining <= 0){

    setTimerState(0);

    finishExam();

    return;
  }

  setTimerState(remaining);

}

function startTicker(){

  clearInterval(timerId);

  tick();

  timerId =
    setInterval(
      tick,
      1000
    );

}

/* ─────────────────────────────────────────────
   SHOW EXAM
───────────────────────────────────────────── */

function showExam(data){

  currentData = data;

  $('portal').style.display =
    'none';

  $('app').style.display =
    'block';

  $('title').textContent =
    data.title;

  document.title =
    data.title;

  if(data.type === 'template'){

    $('pdfControls').style.display =
      'none';

    renderTemplate(
      data.questions || []
    );

  }else{

    $('pdfControls').style.display =
      'flex';

    renderPDF(
      data.pdfDataUrl
    );

  }

  startTicker();

}

/* ─────────────────────────────────────────────
   TEMPLATE RENDERER
───────────────────────────────────────────── */

function renderTemplate(questions){

  const content =
    $('content');

  if(!questions.length){

    content.innerHTML =
      '<div style="padding:40px;text-align:center">No questions found.</div>';

    return;

  }

  content.innerHTML = \`
    <main id="templatePaper">

      <div class="paper-title">
        \${escapeHtml(${JSON.stringify(exam.title)})}
      </div>

      <div class="paper-meta">
        Time limit:
        \${formatTime(${Number(exam.duration_ms)})}
      </div>

      \${questions.map((q,i) => \`

        <section class="q">

          <div class="qnum">
            \${i + 1}.
          </div>

          <div>

            <div class="qtext">
              \${escapeHtml(q.text || '')}
            </div>

            \${
              q.type === 'mcq'

                ? \\\`
                  <div class="options">

                    \${(q.options || [])
                      .map((o,oi) =>
                        \\\`
                        <div class="option">
                          \${String.fromCharCode(65 + oi)}.
                          \${escapeHtml(o || '')}
                        </div>
                        \\\`
                      )
                      .join('')}

                  </div>
                \\\`

                : \\\`
                  <div class="options">

                    <div class="option">
                      ☐ True
                    </div>

                    <div class="option">
                      ☐ False
                    </div>

                  </div>
                \\\`
            }

          </div>

        </section>

      \`).join('')}

    </main>
  \`;

}

/* ─────────────────────────────────────────────
   ESCAPE HTML
───────────────────────────────────────────── */

function escapeHtml(value){

  return String(value)

    .replace(
      /&/g,
      '&amp;'
    )

    .replace(
      /</g,
      '&lt;'
    )

    .replace(
      />/g,
      '&gt;'
    )

    .replace(
      /"/g,
      '&quot;'
    )

    .replace(
      /'/g,
      '&#039;'
    );

}

/* ─────────────────────────────────────────────
   PDF VIEWER
───────────────────────────────────────────── */

async function renderPDF(pdfDataUrl){

  if(
    typeof pdfjsLib ===
    'undefined'
  ){

    $('content').innerHTML =
      '<div style="padding:40px;text-align:center;color:#e84040">PDF viewer could not load.</div>';

    return;

  }

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  try{

    const pdf =
      await pdfjsLib
        .getDocument(pdfDataUrl)
        .promise;

    $('content').innerHTML =
      '<div id="pdfViewer"><div id="pdfLoadingMsg">Loading exam…</div></div>';

    const viewer =
      $('pdfViewer');

    viewer.innerHTML = '';

    for(
      let n = 1;
      n <= pdf.numPages;
      n++
    ){

      const page =
        await pdf.getPage(n);

      const base =
        page.getViewport({
          scale:1
        });

      const ratio =
        window.devicePixelRatio || 1;

      const desired =
        Math.min(
          900,
          window.innerWidth - 32
        );

      const scale =
        desired / base.width;

      const viewport =
        page.getViewport({
          scale:
            scale * ratio
        });

      const wrap =
        document.createElement(
          'div'
        );

      wrap.className =
        'page-wrap';

      const canvas =
        document.createElement(
          'canvas'
        );

      canvas.width =
        viewport.width;

      canvas.height =
        viewport.height;

      canvas.style.width =
        (viewport.width / ratio) +
        'px';

      canvas.style.height =
        (viewport.height / ratio) +
        'px';

      canvas.dataset.base =
        canvas.style.width;

      wrap.appendChild(canvas);

      viewer.appendChild(wrap);

      await page.render({

        canvasContext:
          canvas.getContext('2d'),

        viewport

      }).promise;

    }

    applyZoom();

  }catch(error){

    $('content').innerHTML =
      '<div style="padding:40px;text-align:center;color:#e84040">Failed to load PDF: ' +
      escapeHtml(error.message) +
      '</div>';

  }

}

function applyZoom(){

  document
    .querySelectorAll(
      '.page-wrap canvas'
    )
    .forEach(canvas => {

      canvas.style.width =
        (
          parseFloat(
            canvas.dataset.base
          ) * zoom
        ) + 'px';

    });

  $('reset').textContent =
    Math.round(zoom * 100) +
    '%';

}

$('plus').onclick = () => {

  zoom =
    Math.min(
      3,
      zoom + 0.2
    );

  applyZoom();

};

$('minus').onclick = () => {

  zoom =
    Math.max(
      1,
      zoom - 0.2
    );

  applyZoom();

};

$('reset').onclick = () => {

  zoom = 1;

  applyZoom();

};

/* ─────────────────────────────────────────────
   SESSION
───────────────────────────────────────────── */

async function createOrResumeSession(){

  sessionState =
    await getStoredSession();

  /* ── Existing browser session ── */

  if(
    sessionState &&
    sessionState.sessionToken &&
    sessionState.endAt
  ){

    if(sessionState.finished){

      throw new Error(
        'This exam has already been finished on this device.'
      );

    }

    endAt =
      Number(
        sessionState.endAt
      );

    sessionToken =
      sessionState.sessionToken;

    if(
      endAt <= Date.now()
    ){

      await saveStoredSession({
        finished:true
      });

      throw new Error(
        'Exam time is over.'
      );

    }

    /*
      Try Neon-backed server session first.
      If temporarily unavailable, IndexedDB
      still contains the session.
    */

    try{

      const response =
        await fetch(
          '/api/exam/' +
          encodeURIComponent(EXAM_ID) +
          '/session',
          {
            method:'POST',

            headers:{
              'Content-Type':
                'application/json'
            },

            body:JSON.stringify({
              sessionToken
            })

          }
        );

      const data =
        await response.json();

      if(response.ok){

        sessionToken =
          data.sessionToken;

        endAt =
          Number(data.endAt);

        await saveStoredSession({

          sessionToken,

          endAt,

          startedAt:
            Number(
              data.startedAt
            ),

          finished:false,

          examData:
            cacheExamData(data)

        });

        return data;

      }

    }catch(_){

      /*
        Continue with IndexedDB.
      */

    }

    if(sessionState.examData){

      return {

        ...sessionState.examData,

        sessionToken,

        endAt,

        startedAt:
          sessionState.startedAt

      };

    }

    throw new Error(
      'The exam server is unavailable and no local exam copy exists yet.'
    );

  }

  /* ── First visit ── */

  const password =
    typeof $('pwd').value === 'string'
      ? $('pwd').value
      : '';

  if(!password){

    throw new Error(
      'Password required'
    );

  }

  const response =
    await fetch(
      '/api/exam/' +
      encodeURIComponent(EXAM_ID) +
      '/session',
      {
        method:'POST',

        headers:{
          'Content-Type':
            'application/json'
        },

        body:JSON.stringify({
          password
        })

      }
    );

  const data =
    await response.json();

  if(!response.ok){

    throw new Error(
      data.error ||
      'Unable to start exam'
    );

  }

  sessionToken =
    data.sessionToken;

  endAt =
    Number(data.endAt);

  await saveStoredSession({

    sessionToken,

    endAt,

    startedAt:
      Number(
        data.startedAt
      ),

    finished:false,

    examData:
      cacheExamData(data)

  });

  return data;

}

/* ─────────────────────────────────────────────
   ENTER EXAM
───────────────────────────────────────────── */

async function enterExam(){

  const error =
    $('err');

  error.textContent = '';

  $('enter').disabled =
    true;

  $('enter').textContent =
    'Checking…';

  try{

    const data =
      await createOrResumeSession();

    showExam(data);

  }catch(error){

    $('err').textContent =
      error.message;

    $('enter').disabled =
      false;

    $('enter').textContent =
      'Enter Exam';

  }

}

/* ─────────────────────────────────────────────
   INIT
───────────────────────────────────────────── */

async function init(){

  try{

    sessionState =
      await getStoredSession();

    if(
      sessionState &&
      sessionState.finished
    ){

      $('portal').style.display =
        'none';

      $('app').style.display =
        'block';

      endAt =
        Number(
          sessionState.endAt ||
          Date.now()
        );

      await finishExam();

      return;

    }

    if(
      sessionState &&
      sessionState.sessionToken &&
      sessionState.endAt &&
      Number(
        sessionState.endAt
      ) > Date.now()
    ){

      try{

        const data =
          await createOrResumeSession();

        showExam(data);

        return;

      }catch(_){

        /*
          Server unavailable:
          resume entirely from IndexedDB.
        */

        if(
          sessionState.examData
        ){

          sessionToken =
            sessionState.sessionToken;

          endAt =
            Number(
              sessionState.endAt
            );

          showExam({

            ...sessionState.examData,

            sessionToken,

            endAt,

            startedAt:
              sessionState.startedAt

          });

          return;

        }

      }

    }

    $('pwd').focus();

  }catch(_){

    $('pwd').focus();

  }

}

$('enter').onclick =
  enterExam;

$('pwd').onkeydown =
  event => {

    if(event.key === 'Enter'){

      enterExam();

    }

  };

init();

</script>

<script
  src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"
  crossorigin="anonymous">
</script>

<script>

/*
  If pdf.js loads after the main script,
  retry PDF rendering for a PDF exam.
*/

window.addEventListener(
  'load',
  () => {

    if(
      currentData &&
      currentData.type === 'pdf' &&
      $('app').style.display ===
        'block'
    ){

      renderPDF(
        currentData.pdfDataUrl
      );

    }

  }
);

</script>

</body>
</html>`);

  } catch (error) {

    console.error(
      'Student page error:',
      error
    );

    res.status(500).send(
      'Failed to load exam'
    );

  }
});

/* ─────────────────────────────────────────────
   ESCAPE HTML
───────────────────────────────────────────── */

function escapeHtml(value) {

  return String(value)

    .replace(
      /&/g,
      '&amp;'
    )

    .replace(
      /</g,
      '&lt;'
    )

    .replace(
      />/g,
      '&gt;'
    )

    .replace(
      /"/g,
      '&quot;'
    )

    .replace(
      /'/g,
      '&#039;'
    );

}

/* ─────────────────────────────────────────────
   DATABASE INITIALIZATION
───────────────────────────────────────────── */

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
      exam_id TEXT NOT NULL
        REFERENCES exams(id)
        ON DELETE CASCADE,
      started_at BIGINT NOT NULL,
      end_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      finished_at BIGINT
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
      idx_exam_sessions_exam
    ON exam_sessions(exam_id);
  `);

  console.log(
    '✅ Neon database ready.'
  );

}

/* ─────────────────────────────────────────────
   START SERVER
───────────────────────────────────────────── */

const PORT =
  process.env.PORT || 3000;

(async () => {

  try {

    await initDatabase();

    app.listen(
      PORT,
      () => {

        console.log(
          \`Exam backend listening on port \${PORT}\`
        );

      }
    );

  } catch (error) {

    console.error(
      'Failed to initialize Neon database:',
      error
    );

    process.exit(1);

  }

})();
