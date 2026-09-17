const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config( {
  path: '.env.local'
});
const {
  Pool
}= require('pg');
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
    await pool.query(`INSERT INTO exams(id,title,type,pdf_data_url,questions_json,student_password,duration_ms,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[examId,title,type,type==='pdf'?pdfDataUrl:null,type==='template'?JSON.stringify(questions):null,studentPassword,durationMs,Date.now()]);
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
    await pool.query(`INSERT INTO exam_submissions(id,exam_id,session_token,student_id,student_name,answers_json,results_json,score,total,percentage,submitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[submissionId,exam.id,token,session.student_id,session.student_name,JSON.stringify(answers),JSON.stringify(graded.results),graded.score,graded.total,graded.percentage,submittedAt]);
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
*{box-sizing:border-box}html,body{margin:0;padding:0;background:#0d0d0d;color:#fff;font-family:Arial,sans-serif}body{min-height:100vh}.top{height:76px;border-bottom:1px solid #262626;display:flex;align-items:center;justify-content:space-between;padding:0 28px}.title{font-size:20px;font-weight:700}.timer{display:flex;gap:12px;align-items:center}.timer span{color:#aaa;font-size:12px;letter-spacing:1.5px}.clock{font-size:24px;font-weight:700;background:#191919;border:1px solid #303030;border-radius:10px;padding:14px 18px;min-width:180px;text-align:center}.wrap{max-width:980px;margin:32px auto;padding:0 20px}.card{background:#151515;border:1px solid #2a2a2a;border-radius:16px;padding:28px}.hidden{display:none!important}label{display:block;color:#aaa;font-size:13px;margin:0 0 7px}input{width:100%;padding:13px 14px;border-radius:10px;border:1px solid #383838;background:#101010;color:#fff;font-size:15px;outline:none}input:focus{border-color:#777}.field{margin-bottom:16px}button{border:0;border-radius:10px;padding:13px 18px;background:#fff;color:#111;font-weight:700;cursor:pointer}button.secondary{background:#262626;color:#fff;border:1px solid #3b3b3b}.error{margin-top:12px;color:#ff8585}.paper{background:#faf8f2;color:#111;max-width:760px;margin:0 auto;padding:55px 65px;box-shadow:0 10px 35px rgba(0,0,0,.35)}.paper h1{margin:0 0 8px;font-size:34px}.meta{color:#555;margin-bottom:24px}.rule{height:2px;background:#222;margin:18px 0 30px}.q{margin:0 0 30px}.qtext{font-size:18px;line-height:1.5;margin-bottom:12px}.qnum{font-weight:700;margin-right:10px}.options{display:grid;gap:9px;margin-left:34px}.opt{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border-radius:7px}.opt input{width:auto;margin-top:3px}.review{margin-top:24px}.review-row{padding:14px 0;border-bottom:1px solid #ddd}.correct{color:#177245}.wrong{color:#b42318}.score{font-size:30px;font-weight:700;margin:10px 0}.small{color:#666;font-size:13px}.loader{padding:30px;text-align:center;color:#aaa}
</style></head><body>
<header class="top"><div class="title">${escapeHtml(exam.title)}</div><div class="timer"><span>TIME LEFT</span><div id="clock" class="clock">--:--:--</div></div></header>
<main class="wrap"><section id="portal" class="card"><h2>Enter exam</h2><div class="field"><label>Student ID</label><input id="studentId" autocomplete="off"></div><div class="field"><label>Student name</label><input id="studentName" autocomplete="name"></div><div class="field"><label>Password</label><input id="password" type="password" autocomplete="off"></div><button id="startBtn">Start exam</button><div id="loginError" class="error"></div></section>
<section id="app" class="hidden"><div id="paper" class="paper"><div class="loader">Loading exam…</div></div></section></main>
<script>
const EXAM_ID = ${safeId};
const EXAM_TITLE = ${safeTitle};
const API = '/api/exam/' + encodeURIComponent(EXAM_ID);
const DB_NAME = 'exam-tool-student';
const STORE = 'sessions';
let session=null, examData=null, timerId=null, submitting=false;
function getDeviceId(){let id=localStorage.getItem('exam_device_id');if(!id){id=(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(16).slice(2));localStorage.setItem('exam_device_id',id)}return id}
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE,{keyPath:'examId'})};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function getSaved(){const db=await openDB();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readonly');const r=tx.objectStore(STORE).get(EXAM_ID);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error)})}
async function saveSaved(data){const db=await openDB();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put({...data,examId:EXAM_ID});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}
async function requestSession(body){const r=await fetch(API+'/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});let data={};try{data=await r.json()}catch(_){}if(!r.ok){const e=new Error(data.error||'Could not start exam');e.status=r.status;throw e}return data}
async function startSession(){const deviceId=getDeviceId();const saved=await getSaved();if(saved&&saved.sessionToken&&!saved.finishedAt){try{return await requestSession({sessionToken:saved.sessionToken,deviceId,studentId:saved.studentId,studentName:saved.studentName})}catch(e){if(e.status===410){await saveSaved({...saved,finishedAt:Date.now()})}}}
const studentId=document.getElementById('studentId').value.trim();const studentName=document.getElementById('studentName').value.trim();const password=document.getElementById('password').value;if(!studentId||!studentName||!password)throw new Error('Enter your Student ID, name, and password.');return await requestSession({deviceId,studentId,studentName,password})}
function renderTemplate(){const paper=document.getElementById('paper');paper.innerHTML='<h1>'+escapeHtml(examData.title)+'</h1><div class="meta">Time limit: '+Math.ceil(examData.durationMs/60000)+' min</div><div class="rule"></div>';const answers=(session.answers&&typeof session.answers==='object')?session.answers:{};examData.questions.forEach((q,i)=>{const box=document.createElement('div');box.className='q';const text=document.createElement('div');text.className='qtext';text.innerHTML='<span class="qnum">'+(i+1)+'.</span>'+escapeHtml(q.text);box.appendChild(text);const opts=document.createElement('div');opts.className='options';const values=q.type==='mcq'?q.options:['True','False'];values.forEach((label,j)=>{const value=q.type==='mcq'?String(j):label.toLowerCase();const row=document.createElement('label');row.className='opt';const input=document.createElement('input');input.type='radio';input.name='q'+i;input.value=value;if(String(answers[i]??'')===value)input.checked=true;input.addEventListener('change',async()=>{session.answers=session.answers||{};session.answers[i]=value;await saveSaved(session)});row.append(input,document.createTextNode(label));opts.appendChild(row)});box.appendChild(opts);paper.appendChild(box)});const btn=document.createElement('button');btn.textContent='Submit exam';btn.addEventListener('click',()=>submitExam(false));paper.appendChild(btn)}
function escapeHtml(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
async function submitExam(autoSubmit){if(submitting)return;submitting=true;clearInterval(timerId);try{const r=await fetch(API+'/finish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionToken:session.sessionToken,answers:session.answers||{}})});const data=await r.json();if(!r.ok)throw new Error(data.error||'Submission failed');session.finishedAt=Date.now();session.submissionId=data.submissionId;await saveSaved(session);showReview(data,autoSubmit)}catch(e){submitting=false;alert(e.message||'Submission failed')}}
function showReview(data){const paper=document.getElementById('paper');paper.innerHTML='<h1>Exam submitted</h1><div class="score">'+data.score+' / '+data.total+'</div><div class="small">'+data.percentage+'%</div><div class="review">'+(data.results||[]).map(r=>'<div class="review-row"><b>'+r.questionNumber+'. '+escapeHtml(r.question)+'</b><div class="'+(r.correct?'correct':'wrong')+'">'+(r.correct?'Correct':'Incorrect')+'</div><div>Your answer: '+escapeHtml(r.yourAnswer)+'</div><div>Correct answer: '+escapeHtml(r.correctAnswer)+'</div></div>').join('')+'</div>'}
function startTimer(){function tick(){const left=Math.max(0,Number(session.endAt)-Date.now());const sec=Math.floor(left/1000),h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;document.getElementById('clock').textContent=[h,m,s].map((v,i)=>String(v).padStart(i?'2':'2','0')).join(':');if(left<=0){clearInterval(timerId);submitExam(true)}}tick();timerId=setInterval(tick,1000)}
async function enterExam(){const err=document.getElementById('loginError');err.textContent='';const btn=document.getElementById('startBtn');btn.disabled=true;btn.textContent='Starting…';try{session=await startSession();examData=session;session.answers=session.answers||{};await saveSaved(session);document.getElementById('portal').classList.add('hidden');document.getElementById('app').classList.remove('hidden');renderTemplate();startTimer()}catch(e){err.textContent=e.message||'Could not start exam.'}finally{btn.disabled=false;btn.textContent='Start exam'}}
document.getElementById('startBtn').addEventListener('click',enterExam);['studentId','studentName','password'].forEach(id=>document.getElementById(id).addEventListener('keydown',e=>{if(e.key==='Enter')enterExam()}));
(async()=>{const saved=await getSaved();if(saved&&!saved.finishedAt){document.getElementById('studentId').value=saved.studentId||'';document.getElementById('studentName').value=saved.studentName||''}})();
</script></body></html>`);
});

const PORT=process.env.PORT||10000;
initDatabase().then(()=>app.listen(PORT,()=>console.log(`Exam backend listening on port ${PORT}`))).catch(error=>{console.error('Database initialization failed:',error);process.exit(1)});
