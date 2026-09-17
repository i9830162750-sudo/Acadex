const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config( {
  path: '.env.local'
});
const {
  Pool
}
= require('pg');
const pool = new Pool( {
  connectionString: process.env.DATABASE_URL, 
  ssl: {
    rejectUnauthorized: false
  }
});
const app = express();
app.use(cors());
app.use(express.json( {
  limit: '25mb'
}));
function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}
function makeDeviceId() {
  return crypto.randomBytes(24).toString('hex');
}
function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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
    );
    CREATE TABLE IF NOT EXISTS exam_sessions (
      token TEXT PRIMARY KEY, 
      exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE, 
      started_at BIGINT NOT NULL, 
      end_at BIGINT NOT NULL, 
      created_at BIGINT NOT NULL, 
      finished_at BIGINT, 
      student_id TEXT, 
      student_name TEXT, 
      device_id TEXT
    );
    ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS student_id TEXT;
    ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS student_name TEXT;
    ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS device_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_exam_sessions_exam ON exam_sessions(exam_id);
    CREATE INDEX IF NOT EXISTS idx_exam_sessions_device ON exam_sessions(exam_id, device_id);
    CREATE INDEX IF NOT EXISTS idx_exam_sessions_student ON exam_sessions(exam_id, student_id);
    CREATE TABLE IF NOT EXISTS exam_submissions (
      id TEXT PRIMARY KEY, 
      exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE, 
      session_token TEXT NOT NULL UNIQUE REFERENCES exam_sessions(token) ON DELETE CASCADE, 
      student_id TEXT NOT NULL, 
      student_name TEXT NOT NULL, 
      answers_json JSONB NOT NULL, 
      results_json JSONB NOT NULL, 
      score INTEGER NOT NULL, 
      total INTEGER NOT NULL, 
      percentage NUMERIC NOT NULL, 
      submitted_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_exam_submissions_exam ON exam_submissions(exam_id);
    CREATE INDEX IF NOT EXISTS idx_exam_submissions_student ON exam_submissions(exam_id, student_id);
  `);
  console.log('Neon database ready.');
}

async function getExam(id){
  const { rows } = await pool.query(`SELECT id,title,type,pdf_data_url,questions_json,student_password,duration_ms,created_at FROM exams WHERE id=$1`,[id]);
  return rows[0] || null;
}
function parseQuestions(exam){
  if(!exam.questions_json) return [];
  try { return typeof exam.questions_json === 'string' ? JSON.parse(exam.questions_json) : exam.questions_json; }
  catch(_){ return []; }
}
function publicExam(exam){
  return { examId:exam.id, title:exam.title, type:exam.type, pdfDataUrl:exam.pdf_data_url||null, questions:parseQuestions(exam), durationMs:Number(exam.duration_ms), createdAt:Number(exam.created_at) };
}

app.get('/ping', (req, res) => res.json({ok:true, ts:Date.now()}));

app.post('/exam/create', async(req, res) => {
  try{
    const {title, studentPassword, durationMs, type='pdf', pdfDataUrl=null, questions=[]}=req.body||{};
    if(!title || typeof title !== 'string') return res.status(400).json({error:'title is required'});
    if(!studentPassword || typeof studentPassword !== 'string') return res.status(400).json({error:'studentPassword is required'});
    if(typeof durationMs !== 'number' || durationMs<=0) return res.status(400).json({error:'durationMs must be a positive number'});
    if(!['pdf', 'template'].includes(type)) return res.status(400).json({error:'type must be pdf or template'});
    if(type === 'pdf' && (!pdfDataUrl || typeof pdfDataUrl !== 'string' || !pdfDataUrl.startsWith('data:application/pdf'))) return res.status(400).json({error:'pdfDataUrl must be a base64 PDF data URL'});
    if(type === 'template'){
      if(!Array.isArray(questions)||!questions.length) return res.status(400).json({error:'template exams require at least one question'});
      for(const q of questions){
        if(!q || !['mcq', 'tf'].includes(q.type) || typeof q.text !== 'string' || !q.text.trim()) return res.status(400).json({error:'invalid question'});
        if(q.type === 'mcq' && (!Array.isArray(q.options)||q.options.length !== 4||q.options.some(o => typeof o !== 'string'||!o.trim())||!Number.isInteger(q.answer)||q.answer<0||q.answer>3)) return res.status(400).json({error:'invalid MCQ question'});
        if(q.type === 'tf' && q.answer !== 'true' && q.answer !== 'false') return res.status(400).json({error:'invalid True/False question'});
      }
    }
    const examId='exam_'+crypto.randomBytes(12).toString('hex');
    await pool.query(`INSERT INTO exams(id,title,type,pdf_data_url,questions_json,student_password,duration_ms,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[examId,title,type,type==='pdf'?pdfDataUrl:null,type==='template'?questions:null,studentPassword,durationMs,Date.now()]);
    const baseUrl=process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({examId,url:`${baseUrl}/exam/${examId}`});
  }catch(error){ console.error('Create exam error:', error); res.status(500).json({error:'Failed to create exam'}); }
});

app.get('/api/exam/:id', async(req, res) => {
  try{
    const exam=await getExam(req.params.id); if(!exam) return res.status(404).json({error:'Exam not found'});
    const data=publicExam(exam); delete data.pdfDataUrl; delete data.questions; res.json(data);
  }catch(error){console.error(error);res.status(500).json({error:'Failed to load exam'});}
});

app.post('/api/exam/:id/session', async(req, res) => {
  try{
    const exam=await getExam(req.params.id); if(!exam) return res.status(404).json({error:'Exam not found'});
    const body=req.body||{};
    const token=typeof body.sessionToken === 'string'?body.sessionToken.trim():'';
    const deviceId=typeof body.deviceId === 'string'?body.deviceId.trim():'';
    const studentId=typeof body.studentId === 'string'?body.studentId.trim():'';
    const studentName=typeof body.studentName === 'string'?body.studentName.trim():'';
    const password=typeof body.password === 'string'?body.password:'';

    if(token){
      const {rows}=await pool.query(`SELECT token,exam_id,student_id,student_name,device_id,started_at,end_at,finished_at FROM exam_sessions WHERE token=$1 AND exam_id=$2`,[token,exam.id]);
      const s=rows[0];
      if(s){
        const now=Date.now();
        if(s.finished_at || now>=Number(s.end_at)){
          if(!s.finished_at) await pool.query(`UPDATE exam_sessions SET finished_at=$1 WHERE token=$2`,[now,s.token]);
          return res.status(410).json({error:'This exam attempt is already finished.', endAt:Number(s.end_at)});
        }
        if(deviceId && s.device_id && s.device_id !== deviceId) return res.status(403).json({error:'This exam attempt belongs to another device.'});
        return res.json({sessionToken:s.token, studentId:s.student_id, studentName:s.student_name, deviceId:s.device_id, startedAt:Number(s.started_at), endAt:Number(s.end_at), ...publicExam(exam)});
      }
    }

    if(!deviceId) return res.status(400).json({error:'Device ID is required.'});
    if(!studentId) return res.status(400).json({error:'Student ID is required.'});
    if(!studentName) return res.status(400).json({error:'Student name is required.'});
    if(studentId.length>100) return res.status(400).json({error:'Student ID is too long.'});
    if(studentName.length>150) return res.status(400).json({error:'Student name is too long.'});

    // DEVICE FIRST: one device can only ever have one attempt for this exam.
    const d=await pool.query(`SELECT token,student_id,student_name,device_id,started_at,end_at,finished_at FROM exam_sessions WHERE exam_id=$1 AND device_id=$2 ORDER BY created_at DESC LIMIT 1`,[exam.id,deviceId]);
    const ds=d.rows[0];
    if(ds){
      const now=Date.now();
      if(ds.finished_at || now>=Number(ds.end_at)){
        if(!ds.finished_at) await pool.query(`UPDATE exam_sessions SET finished_at=$1 WHERE token=$2`,[now,ds.token]);
        return res.status(409).json({error:'This device has already used this exam.'});
      }
      if(ds.student_id === studentId){
        return res.status(409).json({error:'This device has already used this exam.'});
      }

      return res.status(409).json({error:'This device has already started this exam with another student.'});
    }

    // STUDENT SECOND: a student can only have one attempt for this exam.
    const st=await pool.query(`SELECT token,student_id,student_name,device_id,started_at,end_at,finished_at FROM exam_sessions WHERE exam_id=$1 AND LOWER(student_id)=LOWER($2) ORDER BY created_at DESC LIMIT 1`,[exam.id,studentId]);
    const ss=st.rows[0];
    if(ss) return res.status(409).json({error:'This student has already used this exam.'});

    if(password !== exam.student_password) return res.status(401).json({error:'Incorrect password'});
    const now=Date.now(), endAt=now+Number(exam.duration_ms), newToken=makeToken();
    await pool.query(`INSERT INTO exam_sessions(token,exam_id,started_at,end_at,created_at,student_id,student_name,device_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[newToken,exam.id,now,endAt,now,studentId,studentName,deviceId]);
    res.json({sessionToken:newToken, studentId, studentName, deviceId, startedAt:now, endAt, ...publicExam(exam)});
  }catch(error){console.error('Session error:', error);res.status(500).json({error:'Failed to start exam'});}
});

function normalizeAnswer(value){
  if(value === undefined || value === null) return null;
  return String(value);
}
function gradeExam(exam, answers){
  const questions=parseQuestions(exam);
  const safeAnswers=answers && typeof answers === 'object' ? answers : {};
  let score=0;
  const results=questions.map((q, i) => {
    const raw=safeAnswers[i] ?? safeAnswers[String(i)];
    const your=normalizeAnswer(raw);
    let correctAnswer, correct=false;
    if(q.type === 'mcq'){
      const idx=Number(q.answer);
      correctAnswer=q.options[idx] ?? '';
      correct=your !== null && Number.isInteger(Number(your)) && Number(your) === idx;
    }else{
      correctAnswer=q.answer === 'true'?'True':'False';
      correct=your !== null && your.toLowerCase() === q.answer;
    }
    if(correct) score++;
    let yourAnswer='Unanswered';
    if(your !== null){
      if(q.type === 'mcq') yourAnswer=q.options[Number(your)] ?? 'Invalid answer';
      else yourAnswer=your.toLowerCase() === 'true'?'True':your.toLowerCase() === 'false'?'False':your;
    }
    return {questionNumber:i+1, question:q.text, type:q.type, yourAnswer, correctAnswer, correct};
  });
  const total=questions.length;
  const percentage=total?Number(((score/total)*100).toFixed(2)):0;
  return {score, total, percentage, results};
}

app.post('/api/exam/:id/finish', async(req, res) => {
  try{
    const exam=await getExam(req.params.id); if(!exam) return res.status(404).json({error:'Exam not found'});
    const token=typeof req.body?.sessionToken === 'string'?req.body.sessionToken.trim():'';
    if(!token) return res.status(400).json({error:'sessionToken is required'});
    const existing=await pool.query(`SELECT id,score,total,percentage,answers_json,results_json,submitted_at FROM exam_submissions WHERE session_token=$1 AND exam_id=$2`,[token,exam.id]);
    if(existing.rows[0]){
      const s=existing.rows[0];
      return res.json({submissionId:s.id, score:s.score, total:s.total, percentage:Number(s.percentage), answers:s.answers_json, results:s.results_json, submittedAt:Number(s.submitted_at)});
    }
    const sessionResult=await pool.query(`SELECT token,student_id,student_name,end_at,finished_at FROM exam_sessions WHERE token=$1 AND exam_id=$2`,[token,exam.id]);
    const session=sessionResult.rows[0]; if(!session) return res.status(404).json({error:'Session not found'});
    if(session.finished_at) return res.status(409).json({error:'This attempt is already closed.'});
    const answers=req.body?.answers && typeof req.body.answers === 'object'?req.body.answers:{};
    const graded=gradeExam(exam, answers);
    const submittedAt=Date.now();
    const submissionId='sub_'+crypto.randomBytes(12).toString('hex');
    await pool.query(`INSERT INTO exam_submissions(id,exam_id,session_token,student_id,student_name,answers_json,results_json,score,total,percentage,submitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[submissionId,exam.id,token,session.student_id,session.student_name,answers,graded.results,graded.score,graded.total,graded.percentage,submittedAt]);
    await pool.query(`UPDATE exam_sessions SET finished_at=$1 WHERE token=$2`,[submittedAt,token]);
    res.json({submissionId, ...graded, answers, submittedAt});
  }catch(error){console.error('Finish exam error:', error);res.status(500).json({error:'Failed to submit exam'});}
});

app.get('/api/exam/:id/result/:token', async(req, res) => {
  try{
    const {rows}=await pool.query(`SELECT id,student_id,student_name,answers_json,results_json,score,total,percentage,submitted_at FROM exam_submissions WHERE exam_id=$1 AND session_token=$2`,[req.params.id,req.params.token]);
    const s=rows[0]; if(!s) return res.status(404).json({error:'Result not found'});
    res.json({submissionId:s.id, studentId:s.student_id, studentName:s.student_name, answers:s.answers_json, results:s.results_json, score:s.score, total:s.total, percentage:Number(s.percentage), submittedAt:Number(s.submitted_at)});
  }catch(error){console.error(error);res.status(500).json({error:'Failed to load result'});}
});

app.get('/exam/:id', async(req, res) => {
  const exam=await getExam(req.params.id); if(!exam) return res.status(404).send('Exam not found');
  const safeId=JSON.stringify(exam.id), safeTitle=JSON.stringify(exam.title);
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(exam.title)}</title>
<style>
*{box-sizing:border-box}html, body{margin:0;min-height:100%;font-family:system-ui, -apple-system, "Segoe UI", sans-serif;background:#0d0c0b;color:#f0ece4}.hidden{display:none!important}
#portal{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0908;padding:24px}.card{width:min(450px, 100%);padding:34px 30px;background:#181614;border:1px solid #ffffff18;border-radius:20px;text-align:center;box-shadow:0 24px 64px #0008}.card h1{margin:0 0 8px}.card p{color:#aaa;line-height:1.5}.card input{width:100%;padding:13px;margin:7px 0;border:1px solid #ffffff22;border-radius:10px;background:#0e0d0c;color:#fff;font-size:16px}.card button, .finish{border:0;border-radius:10px;padding:13px 18px;font-size:16px;font-weight:700;cursor:pointer;background:#f0ece4;color:#111}.card button{width:100%;margin-top:10px}.err{color:#ff7b7b;min-height:22px;margin-top:10px}
#app{display:none;min-height:100vh;background:#f2f1ef;color:#171615;padding:24px}.top{max-width:900px;margin:0 auto 18px;display:flex;align-items:center;justify-content:space-between;gap:16px}.top h1{margin:0;font-size:24px}.timer{font-weight:800;background:#171615;color:#fff;padding:10px 14px;border-radius:10px}.paper{max-width:900px;margin:0 auto;background:#fff;color:#181716;padding:42px 52px;border-radius:5px;box-shadow:0 10px 35px #0001}.paper-title{text-align:center;font-size:25px;font-weight:800;margin-bottom:34px}.q{margin:0 0 28px;padding-bottom:22px;border-bottom:1px solid #eee}.q-num{font-weight:700;font-size:17px;line-height:1.5;margin-bottom:12px}.answer-option{display:flex;align-items:center;gap:12px;padding:13px 15px;margin:8px 0;border:1px solid #ddd;border-radius:10px;cursor:pointer;transition:.15s ease;background:#fff}.answer-option:hover{background:#f5f5f5}.answer-option input{width:18px;height:18px;cursor:pointer;flex:none}.answer-option span{cursor:pointer;flex:1}.review-head{text-align:center;border-bottom:1px solid #eee;padding-bottom:28px;margin-bottom:28px}.score{font-size:42px;font-weight:900}.pct{font-size:18px;color:#666}.review-item{padding:20px 0;border-bottom:1px solid #eee}.status{font-weight:800;margin-bottom:8px}.correct{color:#137333}.wrong{color:#b3261e}.unanswered{color:#666}.review-label{font-weight:700}.review-answer{margin:5px 0 10px;color:#444}
@media(max-width:650px){#app{padding:12px}.paper{padding:26px 18px}.top h1{font-size:18px}.score{font-size:34px}}
</style></head><body>
<div id="portal"><div class="card"><h1>${escapeHtml(exam.title)}</h1><p>Enter your student details and exam password to begin.</p><input id="studentId" placeholder="Student ID" autocomplete="off"><input id="studentName" placeholder="Student name" autocomplete="name"><input id="pwd" type="password" placeholder="Exam password" autocomplete="off"><div id="err" class="err"></div><button id="enter">Enter Exam</button></div></div>
<div id="app"><div class="top"><h1 id="examTitle"></h1><div id="timer" class="timer">--:--</div></div><div id="paper" class="paper"></div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script>
const EXAM_ID = ${safeId};
const EXAM_TITLE = ${safeTitle};
const API = '/api/exam/' + encodeURIComponent(EXAM_ID);
const DB_NAME = 'exam-tool-student';
const STORE = 'sessions';

let session = null;
let examData = null;
let timerId = null;
let submitting = false;

const $ = id => document.getElementById(id);

function getDeviceId() {
  let id = localStorage.getItem('exam_device_id');
  if (!id) {
    id = crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now();
    localStorage.setItem('exam_device_id', id);
  }
  return id;
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'examId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getSaved() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly')
      .objectStore(STORE).get(EXAM_ID);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function saveSaved(value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite')
      .objectStore(STORE).put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function formatTime(ms) {
  ms = Math.max(0, ms);
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours) {
    return String(hours).padStart(2, '0') + ':' +
           String(minutes).padStart(2, '0') + ':' +
           String(seconds).padStart(2, '0');
  }

  return String(minutes).padStart(2, '0') + ':' +
         String(seconds).padStart(2, '0');
}

function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setLoginBusy(busy) {
  $('enter').disabled = busy;
  $('enter').textContent = busy ? 'Checking…' : 'Enter Exam';
}

function showLoginError(message) {
  $('err').textContent = message || '';
}

async function requestSession(body) {
  const response = await fetch(API + '/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  let data = {};
  try {
    data = await response.json();
  } catch (_) {}

  return { response, data };
}

async function startSession() {
  const old = await getSaved();
  const device = getDeviceId();

  /*
    RESUME:
    The browser may resume only its own server-created session.
    IndexedDB is only a convenience; the server is authoritative.
  */
  if (old && old.sessionToken && !old.finishedAt) {
    const resumed = await requestSession({
      sessionToken: old.sessionToken,
      deviceId: device,
      studentId: old.studentId || '',
      studentName: old.studentName || ''
    });

    if (resumed.response.ok) {
      session = {
        ...old,
        ...resumed.data,
        examId: EXAM_ID,
        answers: old.answers || {}
      };
      examData = resumed.data;
      await saveSaved(session);
      return resumed.data;
    }

    if (resumed.response.status === 410) {
      session = { ...old, finishedAt: Date.now() };
      await saveSaved(session);
      throw new Error('This exam attempt is already finished.');
    }
  }

  const studentId = $('studentId').value.trim();
  const studentName = $('studentName').value.trim();
  const password = $('pwd').value;

  if (!studentId) throw new Error('Enter your Student ID.');
  if (!studentName) throw new Error('Enter your student name.');
  if (!password) throw new Error('Enter the exam password.');

  const result = await requestSession({
    deviceId: device,
    studentId,
    studentName,
    password
  });

  if (!result.response.ok) {
    if (result.response.status === 409) {
      throw new Error(result.data.error ||
        'This student or device has already used this exam.');
    }

    if (result.response.status === 403) {
      throw new Error(result.data.error ||
        'This attempt belongs to another device.');
    }

    if (result.response.status === 401) {
      throw new Error('Incorrect exam password.');
    }

    throw new Error(result.data.error || 'Could not start the exam.');
  }

  examData = result.data;
  session = {
    ...result.data,
    examId: EXAM_ID,
    answers: {}
  };

  await saveSaved(session);
  return result.data;
}

function renderTemplate() {
  const paper = $('paper');
  const questions = examData.questions || [];

  let html =
    '<div class="paper-title">' +
      escapeText(examData.title || EXAM_TITLE) +
    '</div>';

  questions.forEach((question, index) => {
    html +=
      '<div class="q">' +
        '<div class="q-num">' +
          (index + 1) + '. ' + escapeText(question.text) +
        '</div>';

    if (question.type === 'mcq') {
      (question.options || []).forEach((option, optionIndex) => {
        html +=
          '<label class="answer-option">' +
            '<input type="radio" name="q' + index +
              '" value="' + optionIndex + '">' +
            '<span>' + escapeText(option) + '</span>' +
          '</label>';
      });
    } else {
      html +=
        '<label class="answer-option">' +
          '<input type="radio" name="q' + index + '" value="true">' +
          '<span>True</span>' +
        '</label>' +
        '<label class="answer-option">' +
          '<input type="radio" name="q' + index + '" value="false">' +
          '<span>False</span>' +
        '</label>';
    }

    html += '</div>';
  });

  html += '<button class="finish" id="finishBtn">Finish Exam</button>';
  paper.innerHTML = html;

  /*
    Restore every locally saved answer after refresh.
  */
  Object.keys(session.answers || {}).forEach(index => {
    const input = paper.querySelector(
      'input[name="q' + index + '"][value="' +
      String(session.answers[index]) + '"]'
    );

    if (input) input.checked = true;
  });

  /*
    Save an answer immediately whenever the student clicks it.
  */
  paper.querySelectorAll('input[type="radio"]').forEach(input => {
    input.addEventListener('change', async () => {
      session.answers = session.answers || {};
      session.answers[input.name.slice(1)] = input.value;

      await saveSaved({
        ...session,
        examId: EXAM_ID
      });
    });
  });

  $('finishBtn').onclick = () => submitExam(false);
}

async function submitExam(autoSubmit) {
  if (!session || submitting) return;

  submitting = true;
  clearInterval(timerId);

  const button = $('finishBtn');

  if (button) {
    button.disabled = true;
    button.textContent =
      autoSubmit ? 'Time is up — submitting…' : 'Submitting…';
  }

  try {
    const response = await fetch(API + '/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionToken: session.sessionToken,
        answers: session.answers || {}
      })
    });

    let data = {};
    try {
      data = await response.json();
    } catch (_) {}

    if (!response.ok) {
      throw new Error(data.error || 'Could not submit the exam.');
    }

    session.finishedAt = data.submittedAt || Date.now();
    session.submissionId = data.submissionId;

    await saveSaved({
      ...session,
      examId: EXAM_ID,
      finishedAt: session.finishedAt
    });

    showReview(data);
  } catch (error) {
    console.error('Submission error:', error);
    submitting = false;

    if (button) {
      button.disabled = false;
      button.textContent = 'Finish Exam';
    }

    alert(error.message || 'Could not submit the exam.');
    startTimer();
  }
}

function showReview(data) {
  clearInterval(timerId);
  $('timer').style.display = 'none';

  let html =
    '<div class="review-head">' +
      '<div style="font-size:24px;font-weight:800">Exam Complete</div>' +
      '<div class="score">' +
        data.score + ' / ' + data.total +
      '</div>' +
      '<div class="pct">' + data.percentage + '%</div>' +
      '<p>This attempt is now closed. You cannot retake this exam.</p>' +
    '</div>';

  (data.results || []).forEach(result => {
    const unanswered = result.yourAnswer === 'Unanswered';
    const className = result.correct
      ? 'correct'
      : unanswered ? 'unanswered' : 'wrong';

    const status = result.correct
      ? 'Correct ✓'
      : unanswered ? 'Unanswered' : 'Wrong ✗';

    html +=
      '<div class="review-item">' +
        '<div class="status ' + className + '">' +
          status + ' — Question ' + result.questionNumber +
        '</div>' +
        '<div><b>' + escapeText(result.question) + '</b></div>' +
        '<div class="review-answer">' +
          '<span class="review-label">Your answer:</span> ' +
          escapeText(result.yourAnswer) +
        '</div>' +
        '<div class="review-answer">' +
          '<span class="review-label">Correct answer:</span> ' +
          escapeText(result.correctAnswer) +
        '</div>' +
      '</div>';
  });

  $('paper').innerHTML = html;
}

function startTimer() {
  clearInterval(timerId);

  const tick = async () => {
    if (!session || session.finishedAt) {
      clearInterval(timerId);
      return;
    }

    const remaining = Number(session.endAt) - Date.now();
    $('timer').textContent = formatTime(remaining);

    if (remaining <= 0) {
      clearInterval(timerId);
      await submitExam(true);
    }
  };

  tick();
  timerId = setInterval(tick, 250);
}

async function renderPDF(dataUrl) {
  $('paper').innerHTML = '';

  const bytes = atob(dataUrl.split(',')[1]);
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.35 });
    const canvas = document.createElement('canvas');

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';

    $('paper').appendChild(canvas);

    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport
    }).promise;
  }
}

async function showExam(data) {
  examData = data;

  $('portal').style.display = 'none';
  $('app').style.display = 'block';
  $('examTitle').textContent = data.title || EXAM_TITLE;

  if (data.type === 'template') {
    renderTemplate();
  } else {
    await renderPDF(data.pdfDataUrl);
  }

  startTimer();
}

async function enterExam() {
  showLoginError('');
  setLoginBusy(true);

  try {
    const data = await startSession();
    await showExam(data);
  } catch (error) {
    console.error('Exam start error:', error);
    showLoginError(error.message);
    setLoginBusy(false);
  }
}

$('enter').onclick = enterExam;

['studentId', 'studentName', 'pwd'].forEach(id => {
  $(id).onkeydown = event => {
    if (event.key === 'Enter') enterExam();
  };
});

/*
  Restore identity fields for an active local attempt.
  This never bypasses the server's device/student checks.
*/
(async () => {
  try {
    const old = await getSaved();

    if (old && old.sessionToken && !old.finishedAt) {
      $('studentId').value = old.studentId || '';
      $('studentName').value = old.studentName || '';
    }
  } catch (_) {}

  $('studentId').focus();
})();
</script></body></html>`);
});

initDatabase().then(()=>{const PORT=process.env.PORT||3000;app.listen(PORT,()=>console.log(`Exam backend listening on port ${PORT}`));}).catch(error=>{console.error('Database initialization failed:',error);process.exit(1)});
