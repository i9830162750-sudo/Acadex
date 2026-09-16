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
   Health check + cold-start warmer.
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
    return res.status(400).json({
      error: 'durationMs must be a positive number'
    });
  }

  if (
    !pdfDataUrl ||
    typeof pdfDataUrl !== 'string' ||
    !pdfDataUrl.startsWith('data:application/pdf')
  ) {
    return res.status(400).json({
      error: 'pdfDataUrl must be a base64 PDF data URL'
    });
  }

  const examId =
    'exam_' + crypto.randomBytes(12).toString('hex');

  db.prepare(`
    INSERT INTO exams (
      id,
      title,
      type,
      pdf_data_url,
      student_password,
      duration_ms,
      created_at
    )
    VALUES (?, ?, 'pdf', ?, ?, ?, ?)
  `).run(
    examId,
    title,
    pdfDataUrl,
    studentPassword,
    durationMs,
    Date.now()
  );

  const baseUrl =
    process.env.PUBLIC_BASE_URL ||
    `${req.protocol}://${req.get('host')}`;

  res.json({
    examId,
    url: `${baseUrl}/exam/${examId}`
  });
});

/* ─────────────────────────────────────────────
   GET /api/exam/:id
   JSON metadata endpoint.

   IMPORTANT:
   This is separate from /exam/:id so the browser
   doesn't display raw JSON when opening the exam.
───────────────────────────────────────────── */
app.get('/api/exam/:id', (req, res) => {
  const exam = db.prepare(`
    SELECT
      id,
      title,
      type,
      duration_ms,
      created_at
    FROM exams
    WHERE id = ?
  `).get(req.params.id);

  if (!exam) {
    return res.status(404).json({
      error: 'Exam not found'
    });
  }

  res.json({
    examId: exam.id,
    title: exam.title,
    type: exam.type,
    durationMs: exam.duration_ms,
    createdAt: exam.created_at
  });
});

/* ─────────────────────────────────────────────
   POST /api/exam/:id/verify

   Checks the student password.

   The password itself is NOT returned to the
   browser.
───────────────────────────────────────────── */
app.post('/api/exam/:id/verify', (req, res) => {
  const password = req.body && req.body.password;

  if (typeof password !== 'string' || !password) {
    return res.status(400).json({
      error: 'password is required'
    });
  }

  const exam = db.prepare(`
    SELECT
      id,
      title,
      type,
      pdf_data_url,
      duration_ms,
      created_at,
      student_password
    FROM exams
    WHERE id = ?
  `).get(req.params.id);

  if (!exam) {
    return res.status(404).json({
      error: 'Exam not found'
    });
  }

  if (password !== exam.student_password) {
    return res.status(401).json({
      error: 'Incorrect password'
    });
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

/* ─────────────────────────────────────────────
   GET /exam/:id

   STUDENT-FACING EXAM PAGE.

   Previously this route returned raw JSON,
   which caused the giant base64 PDF text dump.

   It now serves an actual HTML exam page.
───────────────────────────────────────────── */
app.get('/exam/:id', (req, res) => {
  const exam = db.prepare(`
    SELECT id
    FROM exams
    WHERE id = ?
  `).get(req.params.id);

  if (!exam) {
    return res.status(404).send('Exam not found');
  }

  const examId = JSON.stringify(exam.id);

  res.type('html').send(`
<!doctype html>
<html lang="en">
<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>Exam</title>

<script
  src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js">
</script>

<style>

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  min-height: 100%;
  font-family:
    system-ui,
    -apple-system,
    "Segoe UI",
    sans-serif;

  background: #0d0c0b;
  color: #f0ece4;
}

/* ─────────────────────────
   PASSWORD PORTAL
───────────────────────── */

#portal {
  position: fixed;
  inset: 0;

  display: flex;
  align-items: center;
  justify-content: center;

  background: #0a0908;
  padding: 24px;
}

.card {
  width: min(400px, 100%);

  padding: 40px 32px;

  background: #181614;

  border: 1px solid #ffffff18;
  border-radius: 20px;

  text-align: center;

  box-shadow:
    0 24px 64px #0008;
}

.card h1 {
  margin: 0 0 8px;
}

.card p {
  color: #aaa;
}

.card input {
  width: 100%;

  padding: 14px;

  border-radius: 10px;
  border: 1px solid #ffffff20;

  background: #0f0e0d;
  color: #fff;

  font-size: 16px;
}

.card button {
  width: 100%;

  margin-top: 12px;

  padding: 14px;

  border: 0;
  border-radius: 10px;

  font-weight: 700;

  cursor: pointer;
}

.err {
  height: 20px;

  margin-top: 10px;

  color: #f06b5c;
}

/* ─────────────────────────
   EXAM APP
───────────────────────── */

#app {
  display: none;
}

.top {
  position: sticky;
  top: 0;

  z-index: 2;

  display: flex;
  align-items: center;

  gap: 12px;

  padding: 12px 16px;

  background: #11100fee;

  border-bottom:
    1px solid #ffffff12;
}

.title {
  flex: 1;

  font-weight: 700;

  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timer {
  font-weight: 800;

  font-variant-numeric:
    tabular-nums;
}

.danger {
  color: #ff6658;
}

/* ─────────────────────────
   ZOOM CONTROLS
───────────────────────── */

.controls {
  display: flex;
  gap: 6px;
}

.controls button {
  height: 34px;
  min-width: 38px;

  border:
    1px solid #ffffff18;

  border-radius: 8px;

  background: #1b1917;
  color: #fff;

  cursor: pointer;
}

/* ─────────────────────────
   PDF VIEWER
───────────────────────── */

.viewer {
  padding: 20px 12px 60px;

  display: flex;
  flex-direction: column;
  align-items: center;

  gap: 18px;

  overflow: auto;
}

.page-wrap {
  overflow: hidden;

  background: #fff;

  box-shadow:
    0 10px 30px #0007;
}

.page-wrap canvas {
  display: block;

  transform-origin:
    top left;
}

</style>

</head>

<body>

<!-- PASSWORD PORTAL -->

<div id="portal">

  <div class="card">

    <h1>🔒 Exam Locked</h1>

    <p id="label">
      Enter the student password to begin.
    </p>

    <input
      id="pwd"
      type="password"
      placeholder="Student password"
      autocomplete="off"
    >

    <button id="enter">
      Enter Exam
    </button>

    <div
      id="err"
      class="err">
    </div>

  </div>

</div>


<!-- EXAM -->

<div id="app">

  <div class="top">

    <div
      id="title"
      class="title">
      Exam
    </div>

    <div class="controls">

      <button id="minus">
        −
      </button>

      <button id="reset">
        100%
      </button>

      <button id="plus">
        +
      </button>

    </div>

    <div
      id="timer"
      class="timer">
      00:00:00
    </div>

  </div>

  <div
    id="viewer"
    class="viewer">
  </div>

</div>


<script>

const ID = ${examId};

const $ = id =>
  document.getElementById(id);

let endAt = 0;
let timerId = null;
let zoom = 1;


/* ─────────────────────────
   PDF.JS
───────────────────────── */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';


/* ─────────────────────────
   TIMER
───────────────────────── */

const fmt = ms => {

  let s =
    Math.max(
      0,
      Math.floor(ms / 1000)
    );

  let h =
    Math.floor(s / 3600);

  let m =
    Math.floor((s % 3600) / 60);

  let x =
    s % 60;

  return [
    h,
    m,
    x
  ]
    .map(v =>
      String(v).padStart(2, '0')
    )
    .join(':');
};


function tick() {

  const left =
    endAt - Date.now();

  $('timer').textContent =
    fmt(left);

  if (left <= 0) {

    clearInterval(timerId);

    $('timer')
      .classList
      .add('danger');

    $('viewer')
      .style
      .pointerEvents = 'none';
  }
}


/* ─────────────────────────
   RENDER PDF
───────────────────────── */

async function render(data) {

  $('title').textContent =
    data.title;

  document.title =
    data.title;

  $('portal').style.display =
    'none';

  $('app').style.display =
    'block';


  /* Timer */

  endAt =
    Date.now() +
    data.durationMs;

  tick();

  timerId =
    setInterval(
      tick,
      250
    );


  /* PDF */

  const pdf =
    await pdfjsLib
      .getDocument(
        data.pdfDataUrl
      )
      .promise;


  $('viewer').innerHTML =
    '';


  for (
    let n = 1;
    n <= pdf.numPages;
    n++
  ) {

    const page =
      await pdf.getPage(n);

    const base =
      page.getViewport({
        scale: 1
      });


    const ratio =
      window.devicePixelRatio || 1;


    const scale =
      Math.min(
        900,
        window.innerWidth - 32
      ) / base.width;


    const vp =
      page.getViewport({
        scale:
          scale * ratio
      });


    const wrap =
      document.createElement('div');

    const canvas =
      document.createElement('canvas');


    wrap.className =
      'page-wrap';


    canvas.width =
      vp.width;

    canvas.height =
      vp.height;


    canvas.style.width =
      (vp.width / ratio) + 'px';

    canvas.style.height =
      (vp.height / ratio) + 'px';


    canvas.dataset.base =
      canvas.style.width;


    wrap.appendChild(canvas);

    $('viewer')
      .appendChild(wrap);


    await page
      .render({
        canvasContext:
          canvas.getContext('2d'),

        viewport: vp
      })
      .promise;
  }
}


/* ─────────────────────────
   PASSWORD VERIFICATION
───────────────────────── */

$('enter').onclick =
  async () => {

    const error =
      $('err');

    error.textContent =
      '';

    $('enter').disabled =
      true;

    $('enter').textContent =
      'Checking…';


    try {

      const response =
        await fetch(
          '/api/exam/' +
          encodeURIComponent(ID) +
          '/verify',
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({
                password:
                  $('pwd').value
              })
          }
        );


      const data =
        await response.json();


      if (!response.ok) {

        throw new Error(
          data.error ||
          'Unable to enter exam'
        );
      }


      await render(data);


    } catch (error) {

      $('err').textContent =
        error.message;

      $('enter').disabled =
        false;

      $('enter').textContent =
        'Enter Exam';
    }
  };


/* Enter key */

$('pwd').onkeydown =
  event => {

    if (
      event.key === 'Enter'
    ) {
      $('enter').click();
    }
  };


/* ─────────────────────────
   ZOOM
───────────────────────── */

function applyZoom() {

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
    Math.round(
      zoom * 100
    ) + '%';
}


$('plus').onclick =
  () => {

    zoom =
      Math.min(
        3,
        zoom + 0.2
      );

    applyZoom();
  };


$('minus').onclick =
  () => {

    zoom =
      Math.max(
        1,
        zoom - 0.2
      );

    applyZoom();
  };


$('reset').onclick =
  () => {

    zoom = 1;

    applyZoom();
  };

</script>

</body>
</html>
  `);
});


/* ─────────────────────────────────────────────
   SERVER
───────────────────────────────────────────── */

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(
    `Exam backend listening on port ${PORT}`
  );

});
