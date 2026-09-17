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
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:#0d0c0b;color:#f0ece4}.hidden{display:none!important}
#portal{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0908;padding:24px}.card{width:min(450px,100%);padding:34px 30px;background:#181614;border:1px solid #ffffff18;border-radius:20px;text-align:center;box-shadow:0 24px 64px #0008}.card h1{margin:0 0 8px}.card p{color:#aaa;line-height:1.5}.card input{width:100%;padding:13px;margin:7px 0;border:1px solid #ffffff22;border-radius:10px;background:#0e0d0c;color:#fff;font-size:16px;outline:none}.card input:focus{border-color:#777}.card button{border:0;border-radius:10px;padding:13px 18px;font-size:16px;font-weight:700;cursor:pointer;background:#f0ece4;color:#111;width:100%;margin-top:10px}.err{color:#ff7b7b;min-height:22px;margin-top:10px}
#app{display:none;min-height:100vh;background:#0d0d0d;color:#111}.exam-header{height:76px;border-bottom:1px solid #262626;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 28px;background:#0d0d0d;color:#fff;position:sticky;top:0;z-index:20}.exam-title{font-size:18px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.timer{justify-self:center;font:800 22px/1 monospace;background:#191919;border:1px solid #303030;padding:14px 20px;border-radius:11px;min-width:150px;text-align:center}.header-spacer{justify-self:end}
.exam-wrap{min-height:calc(100vh - 76px);display:flex;align-items:center;justify-content:center;padding:34px 22px 42px}.paper{width:min(760px,100%);min-height:520px;background:#faf8f2;color:#111;padding:54px 58px 36px;box-shadow:0 12px 40px #0006;display:flex;flex-direction:column}.paper-head{text-align:center;margin-bottom:30px}.paper-head h1{font-size:30px;margin:0 0 7px}.paper-head p{margin:0;color:#666;font-size:14px}.question{display:none;flex:1}.question.active{display:block}.q-number{font:800 13px/1 JetBrains Mono,monospace;letter-spacing:.09em;text-transform:uppercase;color:#777;margin-bottom:18px}.q-text{font-size:25px;line-height:1.45;font-weight:600;margin-bottom:30px;word-break:break-word}.options{display:grid;gap:13px}.answer-option{display:flex;align-items:center;gap:13px;padding:15px 16px;border:1.5px solid #d7d4cc;border-radius:10px;cursor:pointer;background:#fff;font-size:17px;transition:.15s ease}.answer-option:hover{border-color:#999;background:#f7f6f2}.answer-option:has(input:checked){border-color:#111;background:#111;color:#fff}.answer-option input{width:19px;height:19px;margin:0;accent-color:#111;flex:none}.answer-option:has(input:checked) input{accent-color:#fff}
.bottom-nav{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:14px;margin-top:34px;padding-top:4px}.nav-btn{border:1px solid #d0cdc5;background:#fff;color:#111;border-radius:10px;padding:13px 20px;font-size:15px;font-weight:700;cursor:pointer}.nav-btn:hover{background:#f0eee9}.nav-btn:disabled{opacity:.35;cursor:not-allowed}.prev{justify-self:start}.next{justify-self:end}.submit{justify-self:center;background:#111;color:#fff;border-color:#111}.submit:hover{background:#222}.progress{text-align:center;color:#777;font-size:13px;font-weight:600}
.review{width:min(760px,100%);background:#faf8f2;color:#111;padding:54px 58px;box-shadow:0 12px 40px #0006}.review-head{text-align:center;border-bottom:1px solid #ddd;padding-bottom:28px;margin-bottom:18px}.review-head h2{font-size:30px;margin:0 0 15px}.score{font-size:44px;font-weight:900}.pct{font-size:18px;color:#666}.review-item{padding:18px 0;border-bottom:1px solid #ddd}.status{font-weight:800;margin-bottom:7px}.correct{color:#137333}.wrong{color:#b3261e}.unanswered{color:#666}.review-label{font-weight:700}.review-answer{margin:5px 0 10px;color:#444}
.pdf-paper{width:min(900px,100%);background:#fff;padding:42px 52px;color:#111;box-shadow:0 12px 40px #0006}.pdf-paper canvas{display:block;width:100%;height:auto;margin-bottom:20px}
@media(max-width:650px){.exam-header{height:68px;grid-template-columns:1fr auto 1fr;padding:0 12px}.exam-title{font-size:15px}.timer{font-size:17px;min-width:125px;padding:12px 10px}.exam-wrap{min-height:calc(100vh - 68px);padding:18px 10px 28px;align-items:stretch}.paper{min-height:calc(100vh - 110px);padding:34px 20px 22px}.paper-head h1{font-size:25px}.q-text{font-size:21px}.answer-option{font-size:16px;padding:14px}.bottom-nav{position:sticky;bottom:0;background:#faf8f2;padding-top:14px}.nav-btn{padding:11px 14px}.progress{font-size:12px}.review{padding:34px 20px}.pdf-paper{padding:18px}}
</style></head><body>
<div id="portal"><div class="card"><h1>${escapeHtml(exam.title)}</h1><p>Enter your student details and exam password to begin.</p><input id="studentId" placeholder="Student ID" autocomplete="off"><input id="studentName" placeholder="Student name" autocomplete="name"><input id="pwd" type="password" placeholder="Exam password" autocomplete="off"><div id="err" class="err"></div><button id="enter">Enter Exam</button></div></div>
<div id="app"><header class="exam-header"><div class="exam-title">${escapeHtml(exam.title)}</div><div id="timer" class="timer">--:--</div><div class="header-spacer"></div></header><main class="exam-wrap"><section id="paper" class="paper"></section><section id="pdfPaper" class="pdf-paper hidden"></section><section id="review" class="review hidden"></section></main></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>
const EXAM_ID=${safeId};const EXAM_TITLE=${safeTitle};const API='/api/exam/'+encodeURIComponent(EXAM_ID);const DB_NAME='exam-tool-student';const STORE='sessions';let session=null,examData=null,timerId=null,current=0;
const $=id=>document.getElementById(id);
function deviceId(){let id=localStorage.getItem('exam_device_id');if(!id){id=crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)+Date.now();localStorage.setItem('exam_device_id',id)}return id}
function idb(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE,{keyPath:'examId'})};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function saved(){const db=await idb();return new Promise((resolve,reject)=>{const r=db.transaction(STORE,'readonly').objectStore(STORE).get(EXAM_ID);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error)})}
async function save(v){const db=await idb();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put({...v,examId:EXAM_ID});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}
function fmt(ms){ms=Math.max(0,ms);const s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return h?String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0'):String(m).padStart(2,'0')+':'+String(x).padStart(2,'0')}
function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
async function startSession(){const old=await saved(),did=deviceId();if(old&&old.sessionToken&&!old.finishedAt){const r=await fetch(API+'/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionToken:old.sessionToken,deviceId:did,studentId:old.studentId,studentName:old.studentName})});if(r.ok){const d=await r.json();session={...old,...d,answers:old.answers||{}};return d}if(r.status===410)throw new Error('This exam attempt is already finished.')}const body={deviceId:did,studentId:$('studentId').value.trim(),studentName:$('studentName').value.trim(),password:$('pwd').value};const r=await fetch(API+'/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not start exam');session={...d,answers:{}};await save(session);return d}
function renderTemplate(){const qs=examData.questions||[];const paper=$('paper');paper.classList.remove('hidden');$('pdfPaper').classList.add('hidden');$('review').classList.add('hidden');current=0;let html='<div class="paper-head"><h1>'+esc(examData.title||EXAM_TITLE)+'</h1><p>Question <span id="questionMeta">1</span> of '+qs.length+'</p></div><div id="questionHost">';qs.forEach((q,i)=>{html+='<div class="question'+(i===0?' active':'')+'" data-index="'+i+'"><div class="q-number">Question '+(i+1)+'</div><div class="q-text">'+esc(q.text)+'</div><div class="options">';const values=q.type==='mcq'?q.options:['True','False'];values.forEach((label,j)=>{const value=q.type==='mcq'?String(j):label.toLowerCase();html+='<label class="answer-option"><input type="radio" name="q'+i+'" value="'+value+'"><span>'+esc(label)+'</span></label>'});html+='</div></div>'});html+='</div><div class="bottom-nav"><button id="prev" class="nav-btn prev">← Previous</button><button id="submit" class="nav-btn submit">Submit</button><button id="next" class="nav-btn next">Next →</button></div>';paper.innerHTML=html;Object.keys(session.answers||{}).forEach(i=>{const input=paper.querySelector('input[name="q'+i+'"][value="'+String(session.answers[i])+'"]');if(input)input.checked=true});paper.querySelectorAll('input[type="radio"]').forEach(input=>input.addEventListener('change',async()=>{session.answers=session.answers||{};session.answers[input.name.slice(1)]=input.value;await save(session)}));$('prev').onclick=()=>{if(current>0){current--;updateQuestion()}};$('next').onclick=()=>{if(current<qs.length-1){current++;updateQuestion()}};$('submit').onclick=()=>submitExam(false);updateQuestion()}
function updateQuestion(){const qs=examData.questions||[];document.querySelectorAll('.question').forEach((el,i)=>el.classList.toggle('active',i===current));$('prev').disabled=current===0;$('next').disabled=current===qs.length-1;$('questionMeta').textContent=current+1}
async function submitExam(auto){if(!session)return;clearInterval(timerId);const r=await fetch(API+'/finish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionToken:session.sessionToken,answers:session.answers||{}})});const d=await r.json();if(!r.ok){alert(d.error||'Could not submit exam');startTimer();return}session.finishedAt=d.submittedAt||Date.now();await save({...session,finishedAt:session.finishedAt,submissionId:d.submissionId});showReview(d)}
function showReview(d){$('paper').classList.add('hidden');$('pdfPaper').classList.add('hidden');$('review').classList.remove('hidden');$('timer').style.display='none';let html='<div class="review-head"><h2>Exam submitted</h2><div class="score">'+d.score+' / '+d.total+'</div><div class="pct">'+d.percentage+'%</div></div>';(d.results||[]).forEach(r=>{const cls=r.correct?'correct':r.yourAnswer==='Unanswered'?'unanswered':'wrong';html+='<div class="review-item"><div class="status '+cls+'">'+(r.correct?'Correct':r.yourAnswer==='Unanswered'?'Unanswered':'Incorrect')+' — Question '+r.questionNumber+'</div><div><b>'+esc(r.question)+'</b></div><div class="review-answer"><span class="review-label">Your answer:</span> '+esc(r.yourAnswer)+'</div><div class="review-answer"><span class="review-label">Correct answer:</span> '+esc(r.correctAnswer)+'</div></div>'});$('review').innerHTML=html}
function startTimer(){clearInterval(timerId);const tick=()=>{const left=Number(session.endAt)-Date.now();$('timer').textContent=fmt(left);if(left<=0){clearInterval(timerId);submitExam(true)}};tick();timerId=setInterval(tick,250)}
async function renderPDF(dataUrl){$('paper').classList.add('hidden');$('review').classList.add('hidden');const box=$('pdfPaper');box.classList.remove('hidden');box.innerHTML='';const pdf=await pdfjsLib.getDocument({data:atob(dataUrl.split(',')[1])}).promise;for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n),vp=page.getViewport({scale:1.35}),canvas=document.createElement('canvas');canvas.width=vp.width;canvas.height=vp.height;canvas.style.width='100%';canvas.style.height='auto';canvas.style.display='block';canvas.style.marginBottom='20px';box.appendChild(canvas);await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise}}
async function showExam(d){examData=d;$('portal').style.display='none';$('app').style.display='block';$('timer').style.display='block';if(d.type==='template')renderTemplate();else await renderPDF(d.pdfDataUrl);startTimer()}
async function enter(){const btn=$('enter');$('err').textContent='';btn.disabled=true;btn.textContent='Checking…';try{const d=await startSession();await showExam(d)}catch(e){$('err').textContent=e.message||'Could not start exam.';btn.disabled=false;btn.textContent='Enter Exam'}}
$('enter').onclick=enter;['studentId','studentName','pwd'].forEach(id=>$(id).addEventListener('keydown',e=>{if(e.key==='Enter')enter()}));
(async()=>{try{const old=await saved();if(old&&!old.finishedAt){$('studentId').value=old.studentId||'';$('studentName').value=old.studentName||''}}catch(_){}$('studentId').focus()})();
<\/script></body></html>`);
});

initDatabase().then(()=>{const PORT=process.env.PORT||3000;app.listen(PORT,()=>console.log(`Exam backend listening on port ${PORT}`));}).catch(error=>{console.error('Database initialization failed:',error);process.exit(1)});
