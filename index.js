const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config({ path: '.env.local' });

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function makeDeviceId() {
  return crypto.randomBytes(24).toString('hex');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function getExam(id) {
  const { rows } = await pool.query(`
    SELECT id, title, type, pdf_data_url, questions_json,
           student_password, duration_ms, created_at
    FROM exams
    WHERE id = $1
  `, [id]);

  return rows[0] || null;
}

function publicExam(exam) {
  let questions = [];

  if (exam.questions_json) {
    try {
      questions = typeof exam.questions_json === 'string'
        ? JSON.parse(exam.questions_json)
        : exam.questions_json;
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

app.get('/ping', (req, res) => {
  res.json({
    ok: true,
    ts: Date.now()
  });
});


/* =========================================================
   CREATE EXAM
========================================================= */

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

    if (!durationMs ||
        typeof durationMs !== 'number' ||
        durationMs <= 0) {
      return res.status(400).json({
        error: 'durationMs must be a positive number'
      });
    }

    if (!['pdf', 'template'].includes(type)) {
      return res.status(400).json({
        error: 'type must be pdf or template'
      });
    }

    if (
      type === 'pdf' &&
      (
        !pdfDataUrl ||
        typeof pdfDataUrl !== 'string' ||
        !pdfDataUrl.startsWith('data:application/pdf')
      )
    ) {
      return res.status(400).json({
        error: 'pdfDataUrl must be a base64 PDF data URL'
      });
    }

    if (type === 'template') {
      if (!Array.isArray(questions) || !questions.length) {
        return res.status(400).json({
          error: 'template exams require at least one question'
        });
      }

      for (const q of questions) {
        if (
          !q ||
          !['mcq', 'tf'].includes(q.type) ||
          typeof q.text !== 'string' ||
          !q.text.trim()
        ) {
          return res.status(400).json({
            error: 'invalid question'
          });
        }

        if (
          q.type === 'mcq' &&
          (
            !Array.isArray(q.options) ||
            q.options.length !== 4 ||
            q.options.some(
              o => typeof o !== 'string' || !o.trim()
            ) ||
            !Number.isInteger(q.answer) ||
            q.answer < 0 ||
            q.answer > 3
          )
        ) {
          return res.status(400).json({
            error: 'invalid MCQ question'
          });
        }

        if (
          q.type === 'tf' &&
          q.answer !== 'true' &&
          q.answer !== 'false'
        ) {
          return res.status(400).json({
            error: 'invalid True/False question'
          });
        }
      }
    }

    const examId =
      'exam_' + crypto.randomBytes(12).toString('hex');

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
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      examId,
      title,
      type,
      type === 'pdf' ? pdfDataUrl : null,
      type === 'template' ? questions : null,
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


/* =========================================================
   PUBLIC EXAM METADATA
========================================================= */

app.get('/api/exam/:id', async (req, res) => {
  try {
    const exam = await getExam(req.params.id);

    if (!exam) {
      return res.status(404).json({
        error: 'Exam not found'
      });
    }

    const data = publicExam(exam);

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


/* =========================================================
   START / RESUME EXAM SESSION

   CHECK ORDER:

   1. SESSION TOKEN
   2. DEVICE
   3. STUDENT
   4. PASSWORD
   5. CREATE ATTEMPT
========================================================= */

app.post('/api/exam/:id/session', async (req, res) => {
  try {
    const exam = await getExam(req.params.id);

    if (!exam) {
      return res.status(404).json({
        error: 'Exam not found'
      });
    }

    const body = req.body || {};

    const suppliedToken =
      typeof body.sessionToken === 'string'
        ? body.sessionToken.trim()
        : '';

    const deviceId =
      typeof body.deviceId === 'string'
        ? body.deviceId.trim()
        : '';

    const studentId =
      typeof body.studentId === 'string'
        ? body.studentId.trim()
        : '';

    const studentName =
      typeof body.studentName === 'string'
        ? body.studentName.trim()
        : '';

    const password =
      typeof body.password === 'string'
        ? body.password
        : '';


    /* =====================================================
       RESUME USING SESSION TOKEN
    ===================================================== */

    if (suppliedToken) {
      const { rows } = await pool.query(`
        SELECT
          token,
          exam_id,
          student_id,
          student_name,
          device_id,
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

        const now = Date.now();

        if (
          session.finished_at ||
          now >= Number(session.end_at)
        ) {

          if (!session.finished_at) {
            await pool.query(`
              UPDATE exam_sessions
              SET finished_at = $1
              WHERE token = $2
            `, [
              now,
              session.token
            ]);
          }

          return res.status(410).json({
            error: 'This exam attempt is already finished.',
            endAt: Number(session.end_at)
          });
        }


        /* DEVICE MUST MATCH THE ORIGINAL DEVICE */

        if (
          deviceId &&
          session.device_id &&
          session.device_id !== deviceId
        ) {
          return res.status(403).json({
            error:
              'This exam attempt belongs to another device.'
          });
        }


        return res.json({
          sessionToken: session.token,
          studentId: session.student_id,
          studentName: session.student_name,
          deviceId: session.device_id,
          startedAt: Number(session.started_at),
          endAt: Number(session.end_at),
          ...publicExam(exam)
        });
      }
    }


    /* =====================================================
       NEW ATTEMPT REQUIRES IDENTITY
    ===================================================== */

    if (!deviceId) {
      return res.status(400).json({
        error: 'Device ID is required.'
      });
    }

    if (!studentId) {
      return res.status(400).json({
        error: 'Student ID is required.'
      });
    }

    if (!studentName) {
      return res.status(400).json({
        error: 'Student name is required.'
      });
    }

    if (studentId.length > 100) {
      return res.status(400).json({
        error: 'Student ID is too long.'
      });
    }

    if (studentName.length > 150) {
      return res.status(400).json({
        error: 'Student name is too long.'
      });
    }


    /* =====================================================
       1. DEVICE CHECK FIRST
    ===================================================== */

    const deviceResult = await pool.query(`
      SELECT
        token,
        student_id,
        student_name,
        device_id,
        started_at,
        end_at,
        finished_at
      FROM exam_sessions
      WHERE exam_id = $1
        AND device_id = $2
      ORDER BY created_at DESC
      LIMIT 1
    `, [
      exam.id,
      deviceId
    ]);

    const deviceSession = deviceResult.rows[0] || null;

    if (deviceSession) {

      const now = Date.now();

      /* Device has already completed/expired */

      if (
        deviceSession.finished_at ||
        now >= Number(deviceSession.end_at)
      ) {

        if (!deviceSession.finished_at) {
          await pool.query(`
            UPDATE exam_sessions
            SET finished_at = $1
            WHERE token = $2
          `, [
            now,
            deviceSession.token
          ]);
        }

        return res.status(409).json({
          error:
            'This device has already used this exam.'
        });
      }


      /* Same device, same student = resume */

      if (
        deviceSession.student_id === studentId
      ) {

        if (password !== exam.student_password) {
          return res.status(401).json({
            error: 'Incorrect password'
          });
        }

        return res.json({
          sessionToken: deviceSession.token,
          studentId: deviceSession.student_id,
          studentName: deviceSession.student_name,
          deviceId: deviceSession.device_id,
          startedAt: Number(deviceSession.started_at),
          endAt: Number(deviceSession.end_at),
          ...publicExam(exam)
        });
      }


      /* Same device, different student = BLOCK */

      return res.status(409).json({
        error:
          'This device has already been assigned to another student for this exam.'
      });
    }


    /* =====================================================
       2. STUDENT CHECK
    ===================================================== */

    const studentResult = await pool.query(`
      SELECT
        token,
        student_id,
        student_name,
        device_id,
        started_at,
        end_at,
        finished_at
      FROM exam_sessions
      WHERE exam_id = $1
        AND student_id = $2
      ORDER BY created_at DESC
      LIMIT 1
    `, [
      exam.id,
      studentId
    ]);

    const studentSession =
      studentResult.rows[0] || null;

    if (studentSession) {

      const now = Date.now();

      if (
        !studentSession.finished_at &&
        now >= Number(studentSession.end_at)
      ) {
        await pool.query(`
          UPDATE exam_sessions
          SET finished_at = $1
          WHERE token = $2
        `, [
          now,
          studentSession.token
        ]);
      }

      return res.status(409).json({
        error:
          'This student has already attempted this exam.'
      });
    }


    /* =====================================================
       3. PASSWORD CHECK
    ===================================================== */

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


    /* =====================================================
       4. CREATE NEW ATTEMPT
    ===================================================== */

    const now = Date.now();

    const endAt =
      now + Number(exam.duration_ms);

    const token = makeToken();

    try {

      await pool.query(`
        INSERT INTO exam_sessions (
          token,
          exam_id,
          student_id,
          student_name,
          device_id,
          started_at,
          end_at,
          created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        token,
        exam.id,
        studentId,
        studentName,
        deviceId,
        now,
        endAt,
        now
      ]);

    } catch (insertError) {

      /*
        PostgreSQL unique constraint can catch
        two simultaneous attempts.
      */

      if (insertError.code === '23505') {
        return res.status(409).json({
          error:
            'An exam attempt already exists for this student or device.'
        });
      }

      throw insertError;
    }


    res.json({
      sessionToken: token,
      studentId,
      studentName,
      deviceId,
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


/* =========================================================
   FINISH EXAM
========================================================= */

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
      SET finished_at = COALESCE(finished_at, $1)
      WHERE token = $2
        AND exam_id = $3
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


/* =========================================================
   STUDENT EXAM PAGE
========================================================= */

app.get('/exam/:id', async (req, res) => {
  try {

    const exam = await getExam(req.params.id);

    if (!exam) {
      return res.status(404).send('Exam not found');
    }

    const safeId = JSON.stringify(exam.id);
    const safeTitle = JSON.stringify(exam.title);

    res.type('html').send(`<!doctype html>
<html lang="en">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>${escapeHtml(exam.title)}</title>

<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>

<style>

*{
  box-sizing:border-box
}

html,
body{
  margin:0;
  min-height:100%;
  font-family:
    system-ui,
    -apple-system,
    "Segoe UI",
    sans-serif;
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
  padding:24px;
  overflow:auto
}

.card{
  width:min(430px,100%);
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
  margin-top:10px;
  border-radius:10px;
  border:1px solid #ffffff20;
  background:#0f0e0d;
  color:#fff;
  font-size:16px;
  outline:none
}

.card input:focus{
  border-color:#ffffff45
}

.card button{
  width:100%;
  margin-top:14px;
  padding:14px;
  border:0;
  border-radius:10px;
  font-weight:700;
  cursor:pointer
}

.card button:disabled{
  opacity:.5;
  cursor:not-allowed
}

.err{
  min-height:20px;
  margin-top:12px;
  color:#f06b5c;
  line-height:1.4
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
  background:#fff;
  box-shadow:0 10px 30px #0007;
  overflow:auto;
  max-width:100%
}

.page-wrap canvas{
  display:block;
  transform-origin:top left
}

#pdfStatus{
  padding:40px;
  text-align:center;
  color:#aaa
}

.pdf-error{
  color:#f06b5c
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
  margin-bottom:30px
}

.q{
  margin:0 0 26px
}

.q-num{
  font-weight:700;
  margin-bottom:10px
}

.opt{
  margin:7px 0
}

.tf-wrap{
  display:flex;
  gap:10px
}

.finish{
  display:block;
  margin:30px auto;
  padding:14px 24px;
  border:0;
  border-radius:10px;
  font-weight:700;
  cursor:pointer
}

.locked{
  font-size:15px;
  color:#aaa;
  margin-top:16px;
  line-height:1.5
}

@media(max-width:700px){

  #templatePaper{
    padding:30px 22px
  }

  .paper-title{
    font-size:24px
  }

  .top{
    gap:8px;
    padding:10px
  }

  .timer{
    min-width:80px
  }

}

</style>

</head>

<body>

<div id="portal">

  <div class="card">

    <h1>${escapeHtml(exam.title)}</h1>

    <p id="portalText">
      Enter your student details to begin or resume this exam.
    </p>

    <input
      id="studentName"
      autocomplete="name"
      placeholder="Student name"
      maxlength="150"
    >

    <input
      id="studentId"
      autocomplete="username"
      placeholder="Student ID / Roll No."
      maxlength="100"
    >

    <input
      id="password"
      type="password"
      autocomplete="current-password"
      placeholder="Exam password"
    >

    <button id="startBtn">
      Enter Exam
    </button>

    <div id="err" class="err"></div>

  </div>

</div>


<div id="app">

  <div class="top">

    <div
      class="title"
      id="topTitle"
    ></div>

    <div
      class="timer"
      id="timer"
    >
      --:--
    </div>

    <div class="controls">

      <button
        id="minus"
        type="button"
      >
        −
      </button>

      <button
        id="plus"
        type="button"
      >
        +
      </button>

    </div>

  </div>

  <div id="pdfViewer"></div>

  <div id="templatePaper"></div>

</div>


<script>

const EXAM_ID=${safeId};

const EXAM_TITLE=${safeTitle};

const DB_NAME='exam-tool-student';

const DB_VERSION=2;

const SESSION_STORE='sessions';

const META_STORE='meta';

let dbPromise;

let session=null;

let examData=null;

let timerId=null;

let pdfScale=1;

let renderedCanvases=[];

let deviceId=null;


/* =========================================================
   INDEXEDDB
========================================================= */

function openDB(){

  if(dbPromise){
    return dbPromise;
  }

  dbPromise=new Promise((resolve,reject)=>{

    const r=
      indexedDB.open(
        DB_NAME,
        DB_VERSION
      );

    r.onupgradeneeded=()=>{

      const db=r.result;

      if(
        !db.objectStoreNames.contains(
          SESSION_STORE
        )
      ){

        db.createObjectStore(
          SESSION_STORE,
          {keyPath:'examId'}
        );

      }

      if(
        !db.objectStoreNames.contains(
          META_STORE
        )
      ){

        db.createObjectStore(
          META_STORE
        );

      }

    };

    r.onsuccess=()=>{
      resolve(r.result);
    };

    r.onerror=()=>{
      reject(r.error);
    };

  });

  return dbPromise;
}


/* =========================================================
   DEVICE ID
========================================================= */

async function getDeviceId(){

  const db=await openDB();

  return new Promise((resolve,reject)=>{

    const tx=
      db.transaction(
        META_STORE,
        'readwrite'
      );

    const store=
      tx.objectStore(META_STORE);

    const get=
      store.get('deviceId');

    get.onsuccess=()=>{

      if(get.result){

        resolve(get.result);

        return;
      }

      let id='';

      try{

        if(
          crypto &&
          typeof crypto.randomUUID==='function'
        ){

          id=crypto.randomUUID();

        }

      }catch(_){}

      if(!id){

        id=
          Date.now().toString(36)+
          '-' +
          Math.random().toString(36).slice(2)+
          '-' +
          Math.random().toString(36).slice(2);

      }

      store.put(id,'deviceId');

      resolve(id);

    };

    get.onerror=()=>{
      reject(get.error);
    };

  });

}


/* =========================================================
   SESSION STORAGE
========================================================= */

async function getSaved(){

  const db=await openDB();

  return new Promise((resolve,reject)=>{

    const tx=
      db.transaction(
        SESSION_STORE,
        'readonly'
      );

    const r=
      tx.objectStore(
        SESSION_STORE
      ).get(EXAM_ID);

    r.onsuccess=()=>{
      resolve(r.result||null);
    };

    r.onerror=()=>{
      reject(r.error);
    };

  });

}


async function saveSaved(value){

  const db=await openDB();

  return new Promise((resolve,reject)=>{

    const tx=
      db.transaction(
        SESSION_STORE,
        'readwrite'
      );

    tx.objectStore(
      SESSION_STORE
    ).put(value);

    tx.oncomplete=()=>{
      resolve();
    };

    tx.onerror=()=>{
      reject(tx.error);
    };

  });

}


/* =========================================================
   TIMER
========================================================= */

function fmt(ms){

  ms=
    Math.max(
      0,
      Math.floor(ms/1000)
    );

  const m=
    Math.floor(ms/60);

  const s=
    ms%60;

  return (
    String(m).padStart(2,'0')+
    ':'+
    String(s).padStart(2,'0')
  );

}


function updateTimer(){

  if(!session){
    return;
  }

  const left=
    Math.max(
      0,
      session.endAt-Date.now()
    );

  const el=
    document.getElementById(
      'timer'
    );

  el.textContent=fmt(left);

  el.classList.toggle(
    'warning',
    left<=60000 &&
    left>10000
  );

  el.classList.toggle(
    'danger',
    left<=10000
  );

  if(left<=0){

    clearInterval(timerId);

    finishExam(true);

  }

}


function startTimer(){

  clearInterval(timerId);

  updateTimer();

  timerId=
    setInterval(
      updateTimer,
      500
    );

}


/* =========================================================
   API
========================================================= */

async function requestSession(body){

  const r=
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
        body:JSON.stringify(body)
      }
    );

  let data={};

  try{
    data=await r.json();
  }catch(_){}

  if(!r.ok){

    const error=
      new Error(
        data.error ||
        'Unable to start exam'
      );

    error.status=r.status;

    throw error;
  }

  return data;

}


/* =========================================================
   TEMPLATE
========================================================= */

function renderTemplate(){

  const paper=
    document.getElementById(
      'templatePaper'
    );

  const questions=
    examData.questions||[];

  paper.style.display='block';

  document.getElementById(
    'pdfViewer'
  ).style.display='none';

  let html=
    '<div class="paper-title">'+
    escapeHtml(
      examData.title||EXAM_TITLE
    )+
    '</div>';

  questions.forEach((q,i)=>{

    html+=
      '<div class="q">'+
      '<div class="q-num">'+
      (i+1)+
      '. '+
      escapeHtml(q.text)+
      '</div>';

    if(q.type==='mcq'){

      q.options.forEach((o,j)=>{

        html+=
          '<div class="opt">'+
          '<label>'+
          '<input '+
          'type="radio" '+
          'name="q'+i+'" '+
          'value="'+j+'">'+
          ' '+
          escapeHtml(o)+
          '</label>'+
          '</div>';

      });

    }else{

      html+=
        '<div class="tf-wrap">'+
        '<label>'+
        '<input '+
        'type="radio" '+
        'name="q'+i+'" '+
        'value="true">'+
        ' True'+
        '</label>'+
        '<label>'+
        '<input '+
        'type="radio" '+
        'name="q'+i+'" '+
        'value="false">'+
        ' False'+
        '</label>'+
        '</div>';

    }

    html+='</div>';

  });

  html+=
    '<button '+
    'class="finish" '+
    'id="finishBtn">'+
    'Finish Exam'+
    '</button>';

  paper.innerHTML=html;

  document.getElementById(
    'finishBtn'
  ).onclick=()=>{
    finishExam(false);
  };

}


/* =========================================================
   HTML ESCAPE
========================================================= */

function escapeHtml(value){

  return String(value??'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');

}


/* =========================================================
   PDF RENDERER
========================================================= */

async function renderPdf(){

  const viewer=
    document.getElementById(
      'pdfViewer'
    );

  const paper=
    document.getElementById(
      'templatePaper'
    );

  paper.style.display='none';

  viewer.style.display='flex';

  viewer.innerHTML=
    '<div id="pdfStatus">'+
    'Loading PDF…'+
    '</div>';

  renderedCanvases=[];

  if(!examData.pdfDataUrl){

    viewer.innerHTML=
      '<div id="pdfStatus" '+
      'class="pdf-error">'+
      'No PDF data was received '+
      'from the server.'+
      '</div>';

    return;
  }

  if(!window.pdfjsLib){

    viewer.innerHTML=
      '<div id="pdfStatus" '+
      'class="pdf-error">'+
      'PDF viewer library failed to load.'+
      '</div>';

    return;
  }

  try{

    pdfjsLib.GlobalWorkerOptions.workerSrc=
      'https://cdnjs.cloudflare.com/ajax/libs/' +
      'pdf.js/3.11.174/pdf.worker.min.js';

    const response=
      await fetch(
        examData.pdfDataUrl
      );

    const buffer=
      await response.arrayBuffer();

    const pdf=
      await pdfjsLib
        .getDocument({
          data:new Uint8Array(buffer)
        })
        .promise;

    viewer.innerHTML='';

    for(
      let pageNumber=1;
      pageNumber<=pdf.numPages;
      pageNumber++
    ){

      const page=
        await pdf.getPage(
          pageNumber
        );

      const viewport=
        page.getViewport({
          scale:1.35
        });

      const wrap=
        document.createElement(
          'div'
        );

      wrap.className=
        'page-wrap';

      const canvas=
        document.createElement(
          'canvas'
        );

      const context=
        canvas.getContext(
          '2d',
          {alpha:false}
        );

      const outputScale=
        Math.min(
          window.devicePixelRatio||1,
          2
        );

      canvas.width=
        Math.floor(
          viewport.width*
          outputScale
        );

      canvas.height=
        Math.floor(
          viewport.height*
          outputScale
        );

      canvas.style.width=
        viewport.width+'px';

      canvas.style.height=
        viewport.height+'px';

      context.setTransform(
        outputScale,
        0,
        0,
        outputScale,
        0,
        0
      );

      wrap.appendChild(canvas);

      viewer.appendChild(wrap);

      renderedCanvases.push({
        canvas,
        baseWidth:viewport.width,
        baseHeight:viewport.height
      });

      await page.render({
        canvasContext:context,
        viewport
      }).promise;

    }

    applyPdfScale();

  }catch(error){

    console.error(
      'PDF render error:',
      error
    );

    viewer.innerHTML=
      '<div id="pdfStatus" '+
      'class="pdf-error">'+
      'Could not render this PDF: '+
      escapeHtml(
        error.message||
        'Unknown error'
      )+
      '</div>';

  }

}


function applyPdfScale(){

  renderedCanvases.forEach(item=>{

    item.canvas.style.width=
      (
        item.baseWidth*
        pdfScale
      )+
      'px';

    item.canvas.style.height=
      (
        item.baseHeight*
        pdfScale
      )+
      'px';

  });

}


/* =========================================================
   SHOW EXAM
========================================================= */

function showApp(){

  document.getElementById(
    'portal'
  ).style.display='none';

  document.getElementById(
    'app'
  ).style.display='block';

  document.getElementById(
    'topTitle'
  ).textContent=
    examData.title||
    EXAM_TITLE;

  if(
    examData.type==='template'
  ){

    renderTemplate();

  }else{

    renderPdf();

  }

  startTimer();

}


/* =========================================================
   LOCK FINISHED ATTEMPT
========================================================= */

function lockExam(message){

  clearInterval(timerId);

  document.getElementById(
    'app'
  ).style.display='none';

  document.getElementById(
    'portal'
  ).style.display='flex';

  document.getElementById(
    'portalText'
  ).innerHTML=
    '<strong>'+escapeHtml(message)+'</strong>';

  document.getElementById(
    'studentName'
  ).disabled=true;

  document.getElementById(
    'studentId'
  ).disabled=true;

  document.getElementById(
    'password'
  ).disabled=true;

  const btn=
    document.getElementById(
      'startBtn'
    );

  btn.disabled=true;

  btn.textContent=
    'Attempt Closed';

}


/* =========================================================
   FINISH
========================================================= */

async function finishExam(auto){

  if(!session){
    return;
  }

  clearInterval(timerId);

  const currentSession=session;

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
          sessionToken:
            currentSession.sessionToken
        })
      }
    );

  }catch(_){}


  try{

    const saved=
      await getSaved();

    await saveSaved({
      ...(saved||{}),
      examId:EXAM_ID,
      sessionToken:
        currentSession.sessionToken,
      studentId:
        currentSession.studentId,
      studentName:
        currentSession.studentName,
      deviceId:
        currentSession.deviceId||
        deviceId,
      startedAt:
        currentSession.startedAt,
      endAt:
        currentSession.endAt,
      finishedAt:
        Date.now()
    });

  }catch(_){}


  lockExam(
    auto
      ? 'Time is up. This exam attempt is now closed.'
      : 'Exam submitted. This exam attempt is now closed.'
  );

}


/* =========================================================
   BOOT
========================================================= */

async function boot(){

  const nameInput=
    document.getElementById(
      'studentName'
    );

  const idInput=
    document.getElementById(
      'studentId'
    );

  const passwordInput=
    document.getElementById(
      'password'
    );

  document.getElementById(
    'startBtn'
  ).onclick=start;

  passwordInput.addEventListener(
    'keydown',
    e=>{
      if(e.key==='Enter'){
        start();
      }
    }
  );


  try{

    /*
      Generate/load the persistent
      browser device ID first.
    */

    deviceId=
      await getDeviceId();

    const saved=
      await getSaved();


    /* Already completed on this browser/device */

    if(
      saved &&
      saved.finishedAt
    ){

      if(saved.studentName){
        nameInput.value=
          saved.studentName;
      }

      if(saved.studentId){
        idInput.value=
          saved.studentId;
      }

      lockExam(
        'This device has already completed this exam.'
      );

      return;
    }


    /* Resume active session */

    if(
      saved &&
      saved.sessionToken &&
      saved.endAt>Date.now()
    ){

      try{

        session=
          await requestSession({
            sessionToken:
              saved.sessionToken,
            deviceId:
              deviceId
          });

        examData=session;

        await saveSaved({
          ...saved,
          ...session,
          deviceId
        });

        showApp();

        return;

      }catch(error){

        /*
          If the server explicitly says
          the attempt is closed or belongs
          to another device, do not silently
          bypass it.
        */

        if(
          error.status===403 ||
          error.status===409 ||
          error.status===410
        ){

          lockExam(
            error.message||
            'This exam attempt is closed.'
          );

          return;
        }

      }

    }


    /*
      Prefill identity if this browser
      previously entered it.
    */

    if(saved?.studentName){

      nameInput.value=
        saved.studentName;

    }

    if(saved?.studentId){

      idInput.value=
        saved.studentId;

    }

  }catch(error){

    console.warn(
      'Startup error:',
      error
    );

  }

}


/* =========================================================
   START EXAM
========================================================= */

async function start(){

  const btn=
    document.getElementById(
      'startBtn'
    );

  const err=
    document.getElementById(
      'err'
    );

  const studentName=
    document.getElementById(
      'studentName'
    ).value.trim();

  const studentId=
    document.getElementById(
      'studentId'
    ).value.trim();

  const password=
    document.getElementById(
      'password'
    ).value;

  err.textContent='';


  if(!studentName){

    err.textContent=
      'Enter your student name.';

    return;
  }

  if(!studentId){

    err.textContent=
      'Enter your student ID / roll number.';

    return;
  }

  if(!password){

    err.textContent=
      'Enter the exam password.';

    return;
  }

  btn.disabled=true;

  btn.textContent=
    'Checking…';


  try{

    /*
      Device ID is always sent first
      and checked server-side before
      the student attempt check.
    */

    session=
      await requestSession({

        deviceId,

        studentName,

        studentId,

        password

      });

    examData=session;


    await saveSaved({

      examId:EXAM_ID,

      sessionToken:
        session.sessionToken,

      studentId:
        session.studentId,

      studentName:
        session.studentName,

      deviceId:
        session.deviceId,

      startedAt:
        session.startedAt,

      endAt:
        session.endAt,

      title:
        session.title,

      examData:session

    });


    showApp();

  }catch(e){

    err.textContent=
      e.message||
      'Unable to start exam.';

  }finally{

    btn.disabled=false;

    btn.textContent=
      'Enter Exam';

  }

}


/* =========================================================
   PDF ZOOM
========================================================= */

document.getElementById(
  'minus'
).onclick=()=>{

  pdfScale=
    Math.max(
      .5,
      pdfScale-.1
    );

  applyPdfScale();

};


document.getElementById(
  'plus'
).onclick=()=>{

  pdfScale=
    Math.min(
      2.5,
      pdfScale+.1
    );

  applyPdfScale();

};


boot();

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


/* =========================================================
   DATABASE
========================================================= */

async function initDatabase(){

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
    )
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
    )
  `);


  /*
    MIGRATION FOR EXISTING DATABASES

    These columns are added safely even if
    exam_sessions already existed.
  */

  await pool.query(`
    ALTER TABLE exam_sessions
    ADD COLUMN IF NOT EXISTS student_id TEXT
  `);

  await pool.query(`
    ALTER TABLE exam_sessions
    ADD COLUMN IF NOT EXISTS student_name TEXT
  `);

  await pool.query(`
    ALTER TABLE exam_sessions
    ADD COLUMN IF NOT EXISTS device_id TEXT
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_exam_sessions_exam
    ON exam_sessions(exam_id)
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_exam_sessions_exam_student
    ON exam_sessions(exam_id, student_id)
  `);


  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_exam_sessions_exam_device
    ON exam_sessions(exam_id, device_id)
  `);


  /*
    HARD SERVER-SIDE ONE-ATTEMPT RULES

    Old sessions have NULL identity/device values,
    so partial unique indexes leave them alone.
  */

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    uq_exam_sessions_exam_student
    ON exam_sessions(exam_id, student_id)
    WHERE student_id IS NOT NULL
  `);


  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS
    uq_exam_sessions_exam_device
    ON exam_sessions(exam_id, device_id)
    WHERE device_id IS NOT NULL
  `);


  console.log(
    '✅ Neon database ready.'
  );

}


const PORT=
  process.env.PORT ||
  3000;


(async()=>{

  try{

    await initDatabase();

    app.listen(
      PORT,
      ()=>{
        console.log(
          'Exam backend listening on port '+
          PORT
        );
      }
    );

  }catch(error){

    console.error(
      'Failed to initialize Neon database:',
      error
    );

    process.exit(1);

  }

})();
