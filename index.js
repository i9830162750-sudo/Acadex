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
function hashToken(token){ return crypto.createHash('sha256').update(token).digest('hex'); }
function hashPassword(password, salt){ return crypto.scryptSync(password, salt, 64).toString('hex'); }
function makePasswordHash(password){ const salt=crypto.randomBytes(16).toString('hex'); return salt+':'+hashPassword(password,salt); }
function verifyPassword(password, stored){ try{ const [salt,hex]=String(stored).split(':'); if(!salt||!hex)return false; const a=Buffer.from(hashPassword(password,salt),'hex'); const b=Buffer.from(hex,'hex'); return a.length===b.length && crypto.timingSafeEqual(a,b); }catch(_){return false;} }
async function getAuthUser(req){ const raw=typeof req.headers.authorization==='string'&&req.headers.authorization.startsWith('Bearer ')?req.headers.authorization.slice(7).trim():''; if(!raw)return null; const {rows}=await pool.query(`SELECT u.id,u.role,u.email,u.display_name,u.student_id FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2`,[hashToken(raw),Date.now()]); return rows[0]||null; }
async function requireRole(req,res,role){ const user=await getAuthUser(req); if(!user){res.status(401).json({error:'Login required.'});return null;} if(user.role!==role){res.status(403).json({error:'This account does not have access to this area.'});return null;} req.user=user; return user; }
function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function initDatabase(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('teacher','student')),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      student_id TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
    CREATE TABLE IF NOT EXISTS exams (
      id TEXT PRIMARY KEY, 
      title TEXT NOT NULL, 
      type TEXT NOT NULL DEFAULT 'pdf', 
      pdf_data_url TEXT, 
      questions_json JSONB, 
      student_password TEXT NOT NULL, 
      duration_ms BIGINT NOT NULL, 
      created_at BIGINT NOT NULL,
      owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
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
    ALTER TABLE exam_sessions ADD COLUMN IF NOT EXISTS student_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE exams ADD COLUMN IF NOT EXISTS owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS exam_folders (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    ALTER TABLE exams ADD COLUMN IF NOT EXISTS folder_id TEXT REFERENCES exam_folders(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_exam_folders_owner ON exam_folders(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_exams_owner_folder ON exams(owner_user_id, folder_id);
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
      submitted_at BIGINT NOT NULL,
      student_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
    );
    ALTER TABLE exam_submissions ADD COLUMN IF NOT EXISTS student_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE exam_submissions ADD COLUMN IF NOT EXISTS public_result_token TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_submissions_public_result_token ON exam_submissions(public_result_token) WHERE public_result_token IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_exam_submissions_exam ON exam_submissions(exam_id);
    CREATE INDEX IF NOT EXISTS idx_exam_submissions_student ON exam_submissions(exam_id, student_id);
  `);
  console.log('Neon database ready.');
}

async function getExam(id){
  const { rows } = await pool.query(`SELECT id,title,type,pdf_data_url,questions_json,student_password,duration_ms,created_at,owner_user_id FROM exams WHERE id=$1`,[id]);
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


app.post('/api/auth/register', async(req,res)=>{ try{ const {role,email,password,displayName,studentId}=req.body||{}; if(!['teacher','student'].includes(role))return res.status(400).json({error:'Choose teacher or student.'}); const e=String(email||'').trim().toLowerCase(); const p=String(password||''); const n=String(displayName||'').trim(); if(!e||!e.includes('@'))return res.status(400).json({error:'Enter a valid email.'}); if(p.length<6)return res.status(400).json({error:'Password must be at least 6 characters.'}); if(n.length<2)return res.status(400).json({error:'Enter your name.'}); if(role==='student'&&!String(studentId||'').trim())return res.status(400).json({error:'Student ID is required.'}); const exists=await pool.query('SELECT id FROM users WHERE email=$1',[e]); if(exists.rows[0])return res.status(409).json({error:'An account with that email already exists.'}); const id='usr_'+crypto.randomBytes(12).toString('hex'); await pool.query('INSERT INTO users(id,role,email,password_hash,display_name,student_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,role,e,makePasswordHash(p),n,role==='student'?String(studentId).trim():null,Date.now()]); const token=makeToken(); await pool.query('INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)',[hashToken(token),id,Date.now(),Date.now()+1000*60*60*24*30]); res.json({token,user:{id,role,email:e,displayName:n,studentId:role==='student'?String(studentId).trim():null}}); }catch(err){console.error(err);res.status(500).json({error:'Could not create account.'});} });
app.post('/api/auth/login', async(req,res)=>{ try{ const e=String(req.body?.email||'').trim().toLowerCase(), p=String(req.body?.password||''); const {rows}=await pool.query('SELECT id,role,email,password_hash,display_name,student_id FROM users WHERE email=$1',[e]); const u=rows[0]; if(!u||!verifyPassword(p,u.password_hash))return res.status(401).json({error:'Incorrect email or password.'}); const token=makeToken(); await pool.query('INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)',[hashToken(token),u.id,Date.now(),Date.now()+1000*60*60*24*30]); res.json({token,user:{id:u.id,role:u.role,email:u.email,displayName:u.display_name,studentId:u.student_id}}); }catch(err){console.error(err);res.status(500).json({error:'Could not log in.'});} });
app.post('/api/auth/logout', async(req,res)=>{ try{ const raw=String(req.headers.authorization||'').replace(/^Bearer\s+/,'').trim(); if(raw)await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1',[hashToken(raw)]); res.json({ok:true}); }catch(err){res.status(500).json({error:'Could not log out.'});} });
app.get('/api/auth/me', async(req,res)=>{ try{const u=await getAuthUser(req); if(!u)return res.status(401).json({error:'Not logged in.'}); res.json({user:{id:u.id,role:u.role,email:u.email,displayName:u.display_name,studentId:u.student_id}});}catch(err){res.status(500).json({error:'Could not load account.'});} });
app.get('/api/teacher/exams', async(req,res)=>{ try{const u=await requireRole(req,res,'teacher');if(!u)return; const {rows}=await pool.query(`SELECT e.id,e.title,e.type,e.duration_ms,e.created_at,e.folder_id,f.name AS folder_name,COUNT(s.token)::int AS attempts FROM exams e LEFT JOIN exam_sessions s ON s.exam_id=e.id LEFT JOIN exam_folders f ON f.id=e.folder_id WHERE e.owner_user_id=$1 GROUP BY e.id,f.name ORDER BY e.created_at DESC`,[u.id]); res.json({exams:rows.map(x=>({...x,durationMs:Number(x.duration_ms),createdAt:Number(x.created_at)}))});}catch(err){console.error(err);res.status(500).json({error:'Could not load exams.'});} });

app.get('/api/teacher/folders', async(req,res)=>{
  try{
    const u=await requireRole(req,res,'teacher'); if(!u)return;
    const {rows}=await pool.query(`SELECT f.id,f.name,f.created_at,COUNT(e.id)::int AS exam_count FROM exam_folders f LEFT JOIN exams e ON e.folder_id=f.id AND e.owner_user_id=$1 WHERE f.owner_user_id=$1 GROUP BY f.id ORDER BY f.created_at ASC`,[u.id]);
    res.json({folders:rows.map(x=>({...x,examCount:Number(x.exam_count||0),createdAt:Number(x.created_at)}))});
  }catch(err){console.error(err);res.status(500).json({error:'Could not load folders.'});}
});
app.post('/api/teacher/folders', async(req,res)=>{
  try{
    const u=await requireRole(req,res,'teacher'); if(!u)return;
    const name=String(req.body?.name||'').trim();
    if(!name)return res.status(400).json({error:'Folder name is required.'});
    if(name.length>80)return res.status(400).json({error:'Folder name is too long.'});
    const duplicate=await pool.query('SELECT id FROM exam_folders WHERE owner_user_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1',[u.id,name]);
    if(duplicate.rows[0])return res.status(409).json({error:'A folder with that name already exists.'});
    const id='folder_'+crypto.randomBytes(12).toString('hex');
    const createdAt=Date.now();
    await pool.query('INSERT INTO exam_folders(id,owner_user_id,name,created_at) VALUES($1,$2,$3,$4)',[id,u.id,name,createdAt]);
    res.status(201).json({folder:{id,name,createdAt}});
  }catch(err){console.error(err);res.status(500).json({error:'Could not create folder.'});}
});
app.patch('/api/teacher/folders/:id', async(req,res)=>{
  try{
    const u=await requireRole(req,res,'teacher'); if(!u)return;
    const name=String(req.body?.name||'').trim();
    if(!name)return res.status(400).json({error:'Folder name is required.'});
    if(name.length>80)return res.status(400).json({error:'Folder name is too long.'});
    const duplicate=await pool.query('SELECT id FROM exam_folders WHERE owner_user_id=$1 AND LOWER(name)=LOWER($2) AND id<>$3 LIMIT 1',[u.id,name,req.params.id]);
    if(duplicate.rows[0])return res.status(409).json({error:'A folder with that name already exists.'});
    const result=await pool.query('UPDATE exam_folders SET name=$1 WHERE id=$2 AND owner_user_id=$3 RETURNING id,name,created_at',[name,req.params.id,u.id]);
    if(!result.rows[0])return res.status(404).json({error:'Folder not found.'});
    const f=result.rows[0];
    res.json({folder:{id:f.id,name:f.name,createdAt:Number(f.created_at)}});
  }catch(err){console.error(err);res.status(500).json({error:'Could not rename folder.'});}
});
app.delete('/api/teacher/folders/:id', async(req,res)=>{
  try{
    const u=await requireRole(req,res,'teacher'); if(!u)return;
    const result=await pool.query('DELETE FROM exam_folders WHERE id=$1 AND owner_user_id=$2 RETURNING id',[req.params.id,u.id]);
    if(!result.rows[0])return res.status(404).json({error:'Folder not found.'});
    res.json({ok:true});
  }catch(err){console.error(err);res.status(500).json({error:'Could not delete folder.'});}
});
app.get('/api/teacher/exams/:id', async(req,res)=>{
  try{
    const u=await requireRole(req,res,'teacher'); if(!u)return;
    const {rows}=await pool.query(`SELECT e.id,e.title,e.type,e.pdf_data_url,e.questions_json,e.student_password,e.duration_ms,e.created_at,e.owner_user_id,e.folder_id,f.name AS folder_name FROM exams e LEFT JOIN exam_folders f ON f.id=e.folder_id WHERE e.id=$1 AND e.owner_user_id=$2`,[req.params.id,u.id]);
    const e=rows[0]; if(!e)return res.status(404).json({error:'Exam not found.'});
    res.json({id:e.id,title:e.title,type:e.type,pdfDataUrl:e.pdf_data_url||null,questions:parseQuestions(e),studentPassword:e.student_password,durationMs:Number(e.duration_ms),createdAt:Number(e.created_at),folderId:e.folder_id||null,folderName:e.folder_name||null,url:(process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`)+`/exam/${encodeURIComponent(e.id)}`});
  }catch(err){console.error(err);res.status(500).json({error:'Could not load exam.'});}
});
app.patch('/api/teacher/exams/:id', async(req,res)=>{
  try{
    const u=await requireRole(req,res,'teacher'); if(!u)return;
    const current=await pool.query('SELECT id,title,type,pdf_data_url,questions_json,student_password,duration_ms,folder_id FROM exams WHERE id=$1 AND owner_user_id=$2',[req.params.id,u.id]);
    const e=current.rows[0]; if(!e)return res.status(404).json({error:'Exam not found.'});
    const body=req.body||{};
    const title=body.title===undefined?e.title:String(body.title||'').trim();
    const password=body.studentPassword===undefined?e.student_password:String(body.studentPassword||'');
    const duration=body.durationMs===undefined?Number(e.duration_ms):Number(body.durationMs);
    const type=body.type===undefined?e.type:String(body.type);
    if(!title)return res.status(400).json({error:'title is required'});
    if(!password)return res.status(400).json({error:'studentPassword is required'});
    if(!Number.isFinite(duration)||duration<=0)return res.status(400).json({error:'durationMs must be a positive number'});
    if(!['pdf','template'].includes(type))return res.status(400).json({error:'type must be pdf or template'});
    let pdf=e.pdf_data_url||null, questions=parseQuestions(e);
    if(type==='pdf'){
      if(body.pdfDataUrl!==undefined) pdf=body.pdfDataUrl;
      if(!pdf||typeof pdf!=='string'||!pdf.startsWith('data:application/pdf'))return res.status(400).json({error:'pdfDataUrl must be a base64 PDF data URL'});
      questions=[];
    }else{
      questions=body.questions===undefined?questions:body.questions;
      if(!Array.isArray(questions)||!questions.length)return res.status(400).json({error:'template exams require at least one question'});
      for(const q of questions){
        if(!q||!['mcq','tf'].includes(q.type)||typeof q.text!=='string'||!q.text.trim())return res.status(400).json({error:'invalid question'});
        if(q.type==='mcq'&&(!Array.isArray(q.options)||q.options.length!==4||q.options.some(o=>typeof o!=='string'||!o.trim())||!Number.isInteger(Number(q.answer))||Number(q.answer)<0||Number(q.answer)>3))return res.status(400).json({error:'invalid MCQ question'});
        if(q.type==='tf'&&q.answer!=='true'&&q.answer!=='false')return res.status(400).json({error:'invalid True/False question'});
      }
      pdf=null;
    }
    let folderId=e.folder_id||null;
    if(body.folderId!==undefined){
      folderId=body.folderId===null||body.folderId===''?null:String(body.folderId);
      if(folderId){const f=await pool.query('SELECT id FROM exam_folders WHERE id=$1 AND owner_user_id=$2',[folderId,u.id]);if(!f.rows[0])return res.status(400).json({error:'Folder not found.'});}
    }
    await pool.query('UPDATE exams SET title=$1,type=$2,pdf_data_url=$3,questions_json=$4,student_password=$5,duration_ms=$6,folder_id=$7 WHERE id=$8 AND owner_user_id=$9',[title,type,pdf,type==='template'?JSON.stringify(questions):null,password,duration,folderId,e.id,u.id]);
    const baseUrl=process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`;
    res.json({ok:true,examId:e.id,url:`${baseUrl}/exam/${encodeURIComponent(e.id)}`});
  }catch(err){console.error(err);res.status(500).json({error:'Could not save exam changes.'});}
});
app.delete('/api/teacher/exams/:id', async(req,res)=>{
  try{
    const u=await requireRole(req,res,'teacher'); if(!u)return;
    const result=await pool.query('DELETE FROM exams WHERE id=$1 AND owner_user_id=$2 RETURNING id',[req.params.id,u.id]);
    if(!result.rows[0]) return res.status(404).json({error:'Exam not found.'});
    res.json({ok:true,examId:result.rows[0].id});
  }catch(err){
    console.error(err);
    res.status(500).json({error:'Could not delete exam.'});
  }
});
app.get('/api/teacher/exams/:id/results', async(req,res)=>{ try{const u=await requireRole(req,res,'teacher');if(!u)return; const {rows:er}=await pool.query('SELECT id,title FROM exams WHERE id=$1 AND owner_user_id=$2',[req.params.id,u.id]);if(!er[0])return res.status(404).json({error:'Exam not found.'}); const {rows}=await pool.query(`SELECT s.id,s.public_result_token,s.student_id,s.student_name,s.student_user_id,s.score,s.total,s.percentage,s.submitted_at FROM exam_submissions s WHERE s.exam_id=$1 ORDER BY s.submitted_at DESC`,[req.params.id]); res.json({exam:er[0],results:rows.map(x=>({...x,publicResultToken:x.public_result_token||null,publicResultUrl:x.public_result_token?((process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`)+`/result/${encodeURIComponent(x.public_result_token)}`):null,percentage:Number(x.percentage),submittedAt:Number(x.submitted_at)}))});}catch(err){console.error(err);res.status(500).json({error:'Could not load results.'});} });
app.get('/api/teacher/submissions/:id', async(req,res)=>{ try{const u=await requireRole(req,res,'teacher');if(!u)return; const {rows}=await pool.query(`SELECT s.id,s.public_result_token,s.student_id,s.student_name,s.score,s.total,s.percentage,s.answers_json,s.results_json,s.submitted_at,e.id AS exam_id,e.title FROM exam_submissions s JOIN exams e ON e.id=s.exam_id WHERE s.id=$1 AND e.owner_user_id=$2`,[req.params.id,u.id]);if(!rows[0])return res.status(404).json({error:'Result not found.'});const r=rows[0];res.json({submissionId:r.id,publicResultToken:r.public_result_token||null,publicResultUrl:r.public_result_token?((process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`)+`/result/${encodeURIComponent(r.public_result_token)}`):null,examId:r.exam_id,examTitle:r.title,studentId:r.student_id,studentName:r.student_name,score:r.score,total:r.total,percentage:Number(r.percentage),answers:r.answers_json,results:r.results_json,submittedAt:Number(r.submitted_at)});}catch(err){console.error(err);res.status(500).json({error:'Could not load result.'});} });
app.get('/api/student/results', async(req,res)=>{ try{const u=await requireRole(req,res,'student');if(!u)return; const {rows}=await pool.query(`SELECT s.id,s.public_result_token,s.exam_id,e.title,s.score,s.total,s.percentage,s.submitted_at FROM exam_submissions s JOIN exams e ON e.id=s.exam_id WHERE s.student_user_id=$1 ORDER BY s.submitted_at DESC`,[u.id]);res.json({results:rows.map(x=>({...x,publicResultUrl:x.public_result_token?((process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`)+`/result/${encodeURIComponent(x.public_result_token)}`):null,percentage:Number(x.percentage),submittedAt:Number(x.submitted_at)}))});}catch(err){console.error(err);res.status(500).json({error:'Could not load results.'});} });

app.get('/api/student/results/:id', async(req,res)=>{ try{const u=await requireRole(req,res,'student');if(!u)return; const {rows}=await pool.query(`SELECT s.id,s.exam_id,e.title,s.score,s.total,s.percentage,s.answers_json,s.results_json,s.submitted_at FROM exam_submissions s JOIN exams e ON e.id=s.exam_id WHERE s.id=$1 AND s.student_user_id=$2`,[req.params.id,u.id]); if(!rows[0])return res.status(404).json({error:'Result not found.'}); const r=rows[0]; res.json({submissionId:r.id,examId:r.exam_id,examTitle:r.title,score:r.score,total:r.total,percentage:Number(r.percentage),answers:r.answers_json,results:r.results_json,submittedAt:Number(r.submitted_at)}); }catch(err){console.error(err);res.status(500).json({error:'Could not load result.'});} });
app.get('/api/student/teachers', async(req,res)=>{ try{const u=await requireRole(req,res,'student');if(!u)return; const {rows}=await pool.query(`SELECT DISTINCT t.id,t.email,t.display_name FROM users t JOIN exams e ON e.owner_user_id=t.id JOIN exam_submissions s ON s.exam_id=e.id WHERE s.student_user_id=$1 AND t.role='teacher' ORDER BY t.display_name`,[u.id]); res.json({teachers:rows.map(x=>({id:x.id,email:x.email,displayName:x.display_name}))}); }catch(err){console.error(err);res.status(500).json({error:'Could not load teachers.'});} });
app.get('/api/teacher/students', async(req,res)=>{ try{const u=await requireRole(req,res,'teacher');if(!u)return; const {rows}=await pool.query(`SELECT DISTINCT u.id,u.email,u.display_name,u.student_id FROM users u JOIN exam_submissions s ON s.student_user_id=u.id JOIN exams e ON e.id=s.exam_id WHERE e.owner_user_id=$1 ORDER BY u.display_name`,[u.id]);res.json({students:rows});}catch(err){console.error(err);res.status(500).json({error:'Could not load students.'});} });
app.get('/api/teacher/students/:studentId', async(req,res)=>{
  try{
    const u=await requireRole(req,res,'teacher'); if(!u)return;
    const studentId=String(req.params.studentId||'').trim();
    const student=await pool.query(`SELECT DISTINCT u.id,u.email,u.display_name,u.student_id
      FROM users u
      JOIN exam_submissions s ON s.student_user_id=u.id
      JOIN exams e ON e.id=s.exam_id
      WHERE u.id=$1 AND e.owner_user_id=$2
      LIMIT 1`,[studentId,u.id]);
    const st=student.rows[0];
    if(!st)return res.status(404).json({error:'Student not found.'});
    const {rows}=await pool.query(`SELECT s.id,s.public_result_token,s.exam_id,e.title,s.score,s.total,s.percentage,s.submitted_at
      FROM exam_submissions s
      JOIN exams e ON e.id=s.exam_id
      WHERE s.student_user_id=$1 AND e.owner_user_id=$2
      ORDER BY s.submitted_at DESC`,[studentId,u.id]);
    const results=rows.map(x=>({...x,score:Number(x.score),total:Number(x.total),percentage:Number(x.percentage),submittedAt:Number(x.submitted_at),publicResultUrl:x.public_result_token?((process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`)+`/result/${encodeURIComponent(x.public_result_token)}`):null}));
    const average=results.length ? Number((results.reduce((sum,x)=>sum+Number(x.percentage||0),0)/results.length).toFixed(2)) : 0;
    res.json({
      student:{id:st.id,email:st.email,displayName:st.display_name,studentId:st.student_id},
      averageScore:average,
      examsTaken:results.length,
      results
    });
  }catch(err){console.error(err);res.status(500).json({error:'Could not load student.'});}
});
app.get('/api/teacher/students/:studentId/results/:submissionId', async(req,res)=>{
  try{
    const u=await requireRole(req,res,'teacher'); if(!u)return;
    const {rows}=await pool.query(`SELECT s.id,s.public_result_token,s.student_id,s.student_name,s.score,s.total,s.percentage,s.answers_json,s.results_json,s.submitted_at,
      e.id AS exam_id,e.title,e.owner_user_id,u.email AS student_email,u.display_name AS student_display_name
      FROM exam_submissions s
      JOIN exams e ON e.id=s.exam_id
      JOIN users u ON u.id=s.student_user_id
      WHERE s.id=$1 AND s.student_user_id=$2 AND e.owner_user_id=$3`,[req.params.submissionId,req.params.studentId,u.id]);
    const r=rows[0];
    if(!r)return res.status(404).json({error:'Result not found.'});
    res.json({
      submissionId:r.id,publicResultUrl:r.public_result_token?((process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`)+`/result/${encodeURIComponent(r.public_result_token)}`):null,examId:r.exam_id,examTitle:r.title,
      studentId:r.student_id,studentName:r.student_name,studentEmail:r.student_email,
      score:Number(r.score),total:Number(r.total),percentage:Number(r.percentage),
      answers:r.answers_json,results:r.results_json,submittedAt:Number(r.submitted_at)
    });
  }catch(err){console.error(err);res.status(500).json({error:'Could not load result.'});}
});
app.post('/api/teacher/students/:studentId/results/upload', async(req,res)=>{
  try{
    const u=await requireRole(req,res,'teacher'); if(!u)return;
    const studentUserId=String(req.params.studentId||'').trim();
    const body=req.body||{};
    const examId=String(body.examId||'').trim();
    if(!examId)return res.status(400).json({error:'examId is required.'});
    const examQ=await pool.query('SELECT id,title,type,owner_user_id FROM exams WHERE id=$1 AND owner_user_id=$2',[examId,u.id]);
    const exam=examQ.rows[0];
    if(!exam)return res.status(404).json({error:'Exam not found.'});
    const studentQ=await pool.query('SELECT id,display_name,email,student_id FROM users WHERE id=$1 AND role=$2',[studentUserId,'student']);
    const student=studentQ.rows[0];
    if(!student)return res.status(404).json({error:'Student not found.'});
    const score=Number(body.score), total=Number(body.total);
    if(!Number.isFinite(score)||!Number.isFinite(total)||total<=0||score<0||score>total)return res.status(400).json({error:'score and total must be valid.'});
    const percentage=Number.isFinite(Number(body.percentage))?Number(body.percentage):Number(((score/total)*100).toFixed(2));
    const answers=body.answers&&typeof body.answers==='object'?body.answers:{};
    const results=Array.isArray(body.results)?body.results:[];
    const submittedAt=Number.isFinite(Number(body.submittedAt))?Number(body.submittedAt):Date.now();
    const sessionToken='manual_'+crypto.randomBytes(24).toString('hex');
    const sessionCreated=Date.now();
    await pool.query(`INSERT INTO exam_sessions(token,exam_id,started_at,end_at,created_at,finished_at,student_id,student_name,student_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [sessionToken,exam.id,sessionCreated,sessionCreated,sessionCreated,submittedAt,student.student_id||'',student.display_name,student.id]);
    const submissionId='sub_'+crypto.randomBytes(12).toString('hex');
    await pool.query(`INSERT INTO exam_submissions(id,exam_id,session_token,student_id,student_name,answers_json,results_json,score,total,percentage,submitted_at,student_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [submissionId,exam.id,sessionToken,student.student_id||'',student.display_name,JSON.stringify(answers),JSON.stringify(results),Math.round(score),Math.round(total),percentage,submittedAt,student.id]);
    res.status(201).json({ok:true,submissionId});
  }catch(err){console.error(err);res.status(500).json({error:'Could not upload result.'});}
});



app.get('/ping', (req, res) => res.json({ok:true, ts:Date.now()}));

app.post('/exam/create', async(req, res) => {
  try{
    const user=await requireRole(req,res,'teacher'); if(!user)return;
    const {title, studentPassword, durationMs, type='pdf', pdfDataUrl=null, questions=[], folderId=null}=req.body||{};
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
    let safeFolderId=null;
    if(folderId!==null && folderId!==''){
      const folder=await pool.query('SELECT id FROM exam_folders WHERE id=$1 AND owner_user_id=$2',[String(folderId),user.id]);
      if(!folder.rows[0])return res.status(400).json({error:'Folder not found.'});
      safeFolderId=String(folderId);
    }
    const examId='exam_'+crypto.randomBytes(12).toString('hex');
    await pool.query(`INSERT INTO exams(id,title,type,pdf_data_url,questions_json,student_password,duration_ms,created_at,owner_user_id,folder_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[examId,title,type,type==='pdf'?pdfDataUrl:null,type==='template'?JSON.stringify(questions):null,studentPassword,durationMs,Date.now(),user.id,safeFolderId]);
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
    const authUser=await getAuthUser(req);
    if(!authUser || authUser.role!=='student') return res.status(401).json({error:'Student account login is required.'});
    const deviceId=typeof body.deviceId === 'string'?body.deviceId.trim():'';
    let studentId=typeof body.studentId === 'string'?body.studentId.trim():'';
    let studentName=typeof body.studentName === 'string'?body.studentName.trim():'';
    if(authUser && authUser.role==='student'){ studentId=authUser.student_id||studentId; studentName=authUser.display_name||studentName; }
    const password=typeof body.password === 'string'?body.password:'';

    if(token){
      const {rows}=await pool.query(`SELECT token,exam_id,student_id,student_name,device_id,started_at,end_at,finished_at FROM exam_sessions WHERE token=$1 AND exam_id=$2`,[token,exam.id]);
      const s=rows[0];
      if(s){
        if(s.student_user_id && s.student_user_id !== authUser.id) return res.status(403).json({error:'This exam attempt belongs to another student account.'});
        if(!s.student_user_id) await pool.query('UPDATE exam_sessions SET student_user_id=$1 WHERE token=$2',[authUser.id,s.token]);
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
    const d=await pool.query(`SELECT token,student_id,student_name,device_id,student_user_id,started_at,end_at,finished_at FROM exam_sessions WHERE exam_id=$1 AND device_id=$2 ORDER BY created_at DESC LIMIT 1`,[exam.id,deviceId]);
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
    const st=await pool.query(`SELECT token,student_id,student_name,device_id,student_user_id,started_at,end_at,finished_at FROM exam_sessions WHERE exam_id=$1 AND LOWER(student_id)=LOWER($2) ORDER BY created_at DESC LIMIT 1`,[exam.id,studentId]);
    const ss=st.rows[0];
    if(ss) return res.status(409).json({error:'This student has already used this exam.'});

    if(password !== exam.student_password) return res.status(401).json({error:'Incorrect password'});
    const now=Date.now(), endAt=now+Number(exam.duration_ms), newToken=makeToken();
    await pool.query(`INSERT INTO exam_sessions(token,exam_id,started_at,end_at,created_at,student_id,student_name,device_id,student_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[newToken,exam.id,now,endAt,now,studentId,studentName,deviceId,authUser?.id||null]);
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
    const authUser=await getAuthUser(req);
    if(!authUser || authUser.role!=='student') return res.status(401).json({error:'Student account login is required.'});
    const token=typeof req.body?.sessionToken === 'string'?req.body.sessionToken.trim():'';
    if(!token) return res.status(400).json({error:'sessionToken is required'});
    const existing=await pool.query(`SELECT id,public_result_token,score,total,percentage,answers_json,results_json,submitted_at FROM exam_submissions WHERE session_token=$1 AND exam_id=$2`,[token,exam.id]);
    if(existing.rows[0]){
      const s=existing.rows[0];
      return res.json({submissionId:s.id, publicResultToken:s.public_result_token||null, publicResultUrl:s.public_result_token?((process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`)+`/result/${encodeURIComponent(s.public_result_token)}`):null, score:s.score, total:s.total, percentage:Number(s.percentage), answers:s.answers_json, results:s.results_json, submittedAt:Number(s.submitted_at)});
    }
    const sessionResult=await pool.query(`SELECT token,student_id,student_name,student_user_id,end_at,finished_at FROM exam_sessions WHERE token=$1 AND exam_id=$2`,[token,exam.id]);
    const session=sessionResult.rows[0]; if(!session) return res.status(404).json({error:'Session not found'});
    if(session.student_user_id && session.student_user_id !== authUser.id) return res.status(403).json({error:'This exam attempt belongs to another student account.'});
    if(!session.student_user_id) await pool.query('UPDATE exam_sessions SET student_user_id=$1 WHERE token=$2',[authUser.id,session.token]);
    if(session.finished_at) return res.status(409).json({error:'This attempt is already closed.'});
    const answers=req.body?.answers && typeof req.body.answers === 'object'?req.body.answers:{};
    const graded=gradeExam(exam, answers);
    const submittedAt=Date.now();
    const submissionId='sub_'+crypto.randomBytes(12).toString('hex');
    const publicResultToken=makeToken();
    await pool.query(`INSERT INTO exam_submissions(id,exam_id,session_token,student_id,student_name,answers_json,results_json,score,total,percentage,submitted_at,student_user_id,public_result_token) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[submissionId,exam.id,token,session.student_id,session.student_name,JSON.stringify(answers),JSON.stringify(graded.results),graded.score,graded.total,graded.percentage,submittedAt,session.student_user_id||null,publicResultToken]);
    await pool.query(`UPDATE exam_sessions SET finished_at=$1 WHERE token=$2`,[submittedAt,token]);
    res.json({submissionId, ...graded, answers, submittedAt});
  }catch(error){console.error('Finish exam error:', error);res.status(500).json({error:'Failed to submit exam'});}
});

app.get('/api/exam/:id/result/:token', async(req, res) => {
  try{
    const authUser=await getAuthUser(req);
    if(!authUser || authUser.role!=='student') return res.status(401).json({error:'Student account login is required.'});
    const {rows}=await pool.query(`SELECT id,student_id,student_name,answers_json,results_json,score,total,percentage,submitted_at,student_user_id FROM exam_submissions WHERE exam_id=$1 AND session_token=$2`,[req.params.id,req.params.token]);
    const s=rows[0]; if(!s) return res.status(404).json({error:'Result not found'});
    if(s.student_user_id && s.student_user_id!==authUser.id) return res.status(403).json({error:'This result belongs to another student account.'});
    res.json({submissionId:s.id, studentId:s.student_id, studentName:s.student_name, answers:s.answers_json, results:s.results_json, score:s.score, total:s.total, percentage:Number(s.percentage), submittedAt:Number(s.submitted_at)});
  }catch(error){console.error(error);res.status(500).json({error:'Failed to load result'});}
});

app.get('/result/:publicToken', async(req, res) => {
  try{
    const {rows}=await pool.query(`
      SELECT s.id,s.student_id,s.student_name,s.score,s.total,s.percentage,s.results_json,s.submitted_at,
             u.email AS student_email,e.title AS exam_title
      FROM exam_submissions s
      JOIN exams e ON e.id=s.exam_id
      LEFT JOIN users u ON u.id=s.student_user_id
      WHERE s.public_result_token=$1
      LIMIT 1
    `,[req.params.publicToken]);
    const s=rows[0];
    if(!s) return res.status(404).type('html').send('<h1>Result not found</h1>');
    const results=Array.isArray(s.results_json)?s.results_json:[];
    const resultHtml=results.map((q,i)=>{
      const cls=q.correct?'correct':'wrong';
      return '<article class="q '+cls+'"><div class="status">'+(q.correct?'✓ CORRECT':'✕ INCORRECT')+'</div><h3>'+escapeHtml(q.questionNumber||i+1)+'. '+escapeHtml(q.question||'Question')+'</h3><p><b>Student answered:</b> '+escapeHtml(q.yourAnswer||'Unanswered')+'</p><p><b>Correct answer:</b> '+escapeHtml(q.correctAnswer||'—')+'</p></article>';
    }).join('');
    const emailRow='<div><span>Student ID</span><strong>'+escapeHtml(s.student_id||'—')+'</strong></div><div><span>Email</span><strong>'+escapeHtml(s.student_email||'—')+'</strong></div>';
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Result — ${escapeHtml(s.exam_title)}</title>
<style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#171615;background:#f2f1ef}*{box-sizing:border-box}body{margin:0;padding:28px}.wrap{max-width:900px;margin:0 auto}.head,.q{background:#fff;border:1px solid #ddd;border-radius:16px;padding:22px;margin-bottom:14px;box-shadow:0 6px 24px #00000008}.head h1{margin:0 0 8px;font-size:28px}.muted{color:#666}.meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:18px}.meta div{background:#f7f7f7;border-radius:10px;padding:12px}.meta span{display:block;color:#777;font-size:12px}.meta strong{display:block;margin-top:4px}.score{font-size:42px;font-weight:900;margin-top:12px}.q.correct{border-left:5px solid #18864b}.q.wrong{border-left:5px solid #c43d3d}.status{font-weight:800;margin-bottom:8px}.correct .status{color:#18864b}.wrong .status{color:#c43d3d}.q h3{margin:0 0 12px;line-height:1.4}.q p{line-height:1.5}.footer{color:#777;font-size:12px;margin-top:18px}@media(max-width:650px){body{padding:12px}.meta{grid-template-columns:1fr}.score{font-size:34px}}
</style></head><body><main class="wrap"><section class="head"><h1>${escapeHtml(s.exam_title)}</h1><div class="muted">Shared exam result</div><div class="score">${Number(s.score)||0} / ${Number(s.total)||0}</div><div class="muted">${Number(s.percentage||0).toFixed(1)}% · submitted ${new Date(Number(s.submitted_at)).toLocaleString()}</div><div class="meta"><div><span>Student name</span><strong>${escapeHtml(s.student_name)}</strong></div>${emailRow}</div></section><section>${resultHtml||'<div class="q"><p>No question-level result data is available.</p></div>'}</section><div class="footer">Anyone with this link can view this shared result.</div></main></body></html>`);
  }catch(err){console.error(err);res.status(500).type('html').send('<h1>Could not load result</h1>');}
});

app.get('/exam/:id', async(req, res) => {
  const exam=await getExam(req.params.id); if(!exam) return res.status(404).send('Exam not found');
  const safeId=JSON.stringify(exam.id), safeTitle=JSON.stringify(exam.title);
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(exam.title)}</title>
<style>
*{box-sizing:border-box}html, body{margin:0;min-height:100%;font-family:system-ui, -apple-system, "Segoe UI", sans-serif;background:#0d0c0b;color:#f0ece4}.hidden{display:none!important}
#portal{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0908;padding:24px}.card{width:min(450px, 100%);padding:34px 30px;background:#181614;border:1px solid #ffffff18;border-radius:20px;text-align:center;box-shadow:0 24px 64px #0008}.card h1{margin:0 0 8px}.card p{color:#aaa;line-height:1.5}.card input{width:100%;padding:13px;margin:7px 0;border:1px solid #ffffff22;border-radius:10px;background:#0e0d0c;color:#fff;font-size:16px}.card button, .finish{border:0;border-radius:10px;padding:13px 18px;font-size:16px;font-weight:700;cursor:pointer;background:#f0ece4;color:#111}.card button{width:100%;margin-top:10px}.err{color:#ff7b7b;min-height:22px;margin-top:10px}
#app{display:none;min-height:100vh;background:#f2f1ef;color:#171615;padding:24px}.top{max-width:900px;margin:0 auto 18px;display:flex;align-items:center;justify-content:space-between;gap:16px}.top h1{margin:0;font-size:24px}.timer{font-weight:800;background:#171615;color:#fff;padding:10px 14px;border-radius:10px}.paper{max-width:900px;margin:0 auto;background:#fff;color:#181716;padding:42px 52px;border-radius:5px;box-shadow:0 10px 35px #0001}.paper-title{text-align:center;font-size:25px;font-weight:800;margin-bottom:34px}.question-page{display:none}.question-page.active{display:block}.q-text{font-size:25px;line-height:1.45;font-weight:600;margin-bottom:28px;white-space:pre-wrap}.q{margin:0 0 28px;padding-bottom:22px;border-bottom:1px solid #eee}.q-num{font-weight:700;font-size:17px;line-height:1.5;margin-bottom:12px}.answer-option{display:flex;align-items:center;gap:12px;padding:13px 15px;margin:8px 0;border:1px solid #ddd;border-radius:10px;cursor:pointer;transition:.15s ease;background:#fff}.answer-option:hover{background:#f5f5f5}.pager-nav{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:14px;margin-top:28px}.pager-nav .finish{width:auto}.pager-nav #prevBtn{justify-self:start}.pager-nav #nextBtn,.pager-nav #submitBtn{justify-self:end}.pager-count{text-align:center;color:#666;font-weight:700;font-size:13px}.answer-option input{width:18px;height:18px;cursor:pointer;flex:none}.answer-option span{cursor:pointer;flex:1}.review-head{text-align:center;border-bottom:1px solid #eee;padding-bottom:28px;margin-bottom:28px}.score{font-size:42px;font-weight:900}.pct{font-size:18px;color:#666}.review-item{padding:20px 0;border-bottom:1px solid #eee}.status{font-weight:800;margin-bottom:8px}.correct{color:#137333}.wrong{color:#b3261e}.unanswered{color:#666}.review-label{font-weight:700}.review-answer{margin:5px 0 10px;color:#444}
@media(max-width:650px){#app{padding:12px}.paper{padding:26px 18px}.top h1{font-size:18px}.score{font-size:34px}.q-text{font-size:21px}.pager-nav{grid-template-columns:1fr 1fr}.pager-count{grid-column:1/-1;grid-row:1}.pager-nav .finish{width:100%}.pager-nav #prevBtn,.pager-nav #nextBtn,.pager-nav #submitBtn{justify-self:stretch}}
</style></head><body>
<div id="portal"><div class="card"><h1>${escapeHtml(exam.title)}</h1><p>Sign in with your student account, then enter the exam password.</p><form id="accountStep" autocomplete="on"><input id="studentEmail" type="email" placeholder="Student account email" autocomplete="username"><input id="studentPassword" type="password" placeholder="Account password" autocomplete="current-password"><button id="studentLogin" type="submit">Sign in as Student</button></form><form id="examStep" class="hidden"><div id="studentWelcome" style="margin:10px 0 16px;color:#bbb"></div><input id="pwd" type="password" placeholder="Exam password" autocomplete="off"><button id="enter" type="submit">Enter Exam</button></form><div id="err" class="err"></div></div></div>
<div id="app"><div class="top"><h1 id="examTitle"></h1><div id="timer" class="timer">--:--</div></div><div id="paper" class="paper"></div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script>
  const EXAM_ID=${safeId};
  const EXAM_TITLE=${safeTitle};
  const API='/api/exam/'+encodeURIComponent(EXAM_ID);
  const DB_NAME='exam-tool-student';
  const STORE='sessions';
  let session=null, examData=null, timerId=null, studentAuthToken='';
  const $=id => document.getElementById(id);
  function deviceId() {
    let id=localStorage.getItem('exam_device_id');
    if(!id) {
      id=(crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2)+Date.now());
      localStorage.setItem('exam_device_id', id)
    }
    return id
  }
  function idb() {
    return new Promise((resolve, reject) => {
      const r=indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded=() => {
        if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE, {
          keyPath:'examId'
        })
      };
      r.onsuccess=() => resolve(r.result);
      r.onerror=() => reject(r.error)
    })
  }
  async function saved() {
    const db=await idb();
    return new Promise((resolve, reject) => {
      const r=db.transaction(STORE, 'readonly').objectStore(STORE).get(EXAM_ID);
      r.onsuccess=() => resolve(r.result||null);
      r.onerror=() => reject(r.error)
    })
  }
  async function save(v) {
    const db=await idb();
    return new Promise((resolve, reject) => {
      const r=db.transaction(STORE, 'readwrite').objectStore(STORE).put(v);
      r.onsuccess=resolve;
      r.onerror=() => reject(r.error)
    })
  }
  function fmt(ms) {
    ms=Math.max(0, ms);
    const s=Math.floor(ms/1000), h=Math.floor(s/3600), m=Math.floor(s%3600/60), x=s%60;
    return h?String(h).padStart(2, '0')+':'+String(m).padStart(2, '0')+':'+String(x).padStart(2, '0'):String(m).padStart(2, '0')+':'+String(x).padStart(2, '0')
  }
  function esc(v) {
    return String(v??'').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')}
async function startSession(){
  const old=await saved(); const did=deviceId();
  if(old&&old.sessionToken&&!old.finishedAt){
    const resumeToken=studentAuthToken||old.studentAuthToken||'';
    if(!resumeToken) throw new Error('Please sign in to your student account to resume this exam.');
    studentAuthToken=resumeToken;
    const r=await fetch(API+'/session', {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+studentAuthToken}, body:JSON.stringify({sessionToken:old.sessionToken, deviceId:did, studentId:old.studentId, studentName:old.studentName})});
    if(r.ok){const d=await r.json();session={...old, ...d, studentAuthToken, answers:old.answers||{}};return d}
    if(r.status === 410){throw new Error('This exam attempt is already finished.')}
  }
  const body={deviceId:did, password:$('pwd').value};
  const r=await fetch(API+'/session', {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+studentAuthToken}, body:JSON.stringify(body)});
  const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not start exam');
  session={...d, studentAuthToken, answers:{}};await save({...session, examId:EXAM_ID});return d;
}
function renderTemplate(){
  const paper=$('paper'); const qs=examData.questions||[];
  let html='<div class="paper-title">'+esc(examData.title||EXAM_TITLE)+'</div><div id="questionPager">';
  qs.forEach((q,i)=>{
    html+='<div class="q question-page'+(i===0?' active':'')+'" data-question="'+i+'"><div class="q-num">Question '+(i+1)+' of '+qs.length+'</div><div class="q-text">'+esc(q.text)+'</div>';
    if(q.type==='mcq') q.options.forEach((o,j)=>{html+='<label class="answer-option"><input type="radio" name="q'+i+'" value="'+j+'"><span>'+esc(o)+'</span></label>'});
    else html+='<label class="answer-option"><input type="radio" name="q'+i+'" value="true"><span>True</span></label><label class="answer-option"><input type="radio" name="q'+i+'" value="false"><span>False</span></label>';
    html+='</div>';
  });
  html+='</div><div class="pager-nav"><button class="finish" id="prevBtn" type="button">← Previous</button><div class="pager-count" id="pagerCount">1 / '+qs.length+'</div><button class="finish" id="nextBtn" type="button">Next →</button><button class="finish hidden" id="submitBtn" type="button">Submit Exam</button></div>';
  paper.innerHTML=html;
  Object.keys(session.answers||{}).forEach(i=>{const input=paper.querySelector('input[name="q'+i+'"][value="'+String(session.answers[i])+'"]');if(input)input.checked=true});
  paper.querySelectorAll('input[type="radio"]').forEach(input=>input.addEventListener('change',async()=>{session.answers=session.answers||{};session.answers[input.name.slice(1)]=input.value;await save({...session,examId:EXAM_ID})}));
  let current=0;
  const update=()=>{paper.querySelectorAll('.question-page').forEach((el,i)=>el.classList.toggle('active',i===current));$('prevBtn').disabled=current===0;const last=current===qs.length-1;$('nextBtn').classList.toggle('hidden',last);$('submitBtn').classList.toggle('hidden',!last);$('pagerCount').textContent=(current+1)+' / '+qs.length};
  $('prevBtn').onclick=()=>{if(current>0){current--;update()}};
  $('nextBtn').onclick=()=>{if(current<qs.length-1){current++;update()}};
  $('submitBtn').onclick=()=>submitExam(false);
  update();
}
async function submitExam(auto){if(!session)return;clearInterval(timerId);const r=await fetch(API+'/finish', {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+studentAuthToken}, body:JSON.stringify({sessionToken:session.sessionToken, answers:session.answers||{}})});const d=await r.json();if(!r.ok){alert(d.error||'Could not submit exam');startTimer();return}session.finishedAt=d.submittedAt||Date.now();await save({...session, examId:EXAM_ID, finishedAt:session.finishedAt, submissionId:d.submissionId, answers:session.answers||{}});showReview(d)}
function showReview(d){$('timer').style.display='none';let html='<div class="review-head"><div style="font-size:24px;font-weight:800">Exam Complete</div><div class="score">'+d.score+' / '+d.total+'</div><div class="pct">'+d.percentage+'%</div><p>This attempt is now closed. You cannot retake this exam.</p></div>';d.results.forEach(r => {const cls=r.correct?'correct':r.yourAnswer === 'Unanswered'?'unanswered':'wrong';const status=r.correct?'Correct ✓':r.yourAnswer === 'Unanswered'?'Unanswered':'Wrong ✗';html+='<div class="review-item"><div class="status '+cls+'">'+status+' — Question '+r.questionNumber+'</div><div><b>'+esc(r.question)+'</b></div><div class="review-answer"><span class="review-label">Your answer:</span> '+esc(r.yourAnswer)+'</div><div class="review-answer"><span class="review-label">Correct answer:</span> '+esc(r.correctAnswer)+'</div></div>'});$('paper').innerHTML=html}
function startTimer(){clearInterval(timerId);timerId=setInterval(async() => {const left=Number(session.endAt)-Date.now();$('timer').textContent=fmt(left);if(left<=0){clearInterval(timerId);await submitExam(true)}}, 250);$('timer').textContent=fmt(Number(session.endAt)-Date.now())}
async function showExam(d){examData=d;$('portal').style.display='none';$('app').style.display='block';$('examTitle').textContent=d.title||EXAM_TITLE;if(d.type === 'template')renderTemplate();else await renderPDF(d.pdfDataUrl);startTimer()}
async function renderPDF(dataUrl){$('paper').innerHTML='';const pdf=await pdfjsLib.getDocument({data:atob(dataUrl.split(',')[1])}).promise;for(let n=1;n<=pdf.numPages;n++){const page=await pdf.getPage(n), vp=page.getViewport({scale:1.35}), canvas=document.createElement('canvas');canvas.width=vp.width;canvas.height=vp.height;canvas.style.width='100%';canvas.style.height='auto';$('paper').appendChild(canvas);await page.render({canvasContext:canvas.getContext('2d'), viewport:vp}).promise}}
async function loginStudent(){const btn=$('studentLogin');$('err').textContent='';btn.disabled=true;btn.textContent='Signing in…';try{const email=$('studentEmail').value.trim().toLowerCase(),password=$('studentPassword').value;if(!email||!password)throw new Error('Enter your student account email and password.');const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not sign in.');if(!d.user||d.user.role!=='student')throw new Error('This is not a student account.');studentAuthToken=d.token;const old=await saved();if(old&&old.sessionToken&&!old.finishedAt){session={...old,studentAuthToken};await save({...session,examId:EXAM_ID});}$('studentWelcome').textContent='Signed in as '+(d.user.displayName||d.user.email)+(d.user.studentId?' · Student ID '+d.user.studentId:'');$('accountStep').classList.add('hidden');$('examStep').classList.remove('hidden');$('pwd').focus();}catch(e){$('err').textContent=e.message;btn.disabled=false;btn.textContent='Sign in as Student'}}
async function enter(){const btn=$('enter');$('err').textContent='';btn.disabled=true;btn.textContent='Checking…';try{if(!studentAuthToken)throw new Error('Sign in to your student account first.');const d=await startSession();await showExam(d)}catch(e){$('err').textContent=e.message;btn.disabled=false;btn.textContent='Enter Exam'}}
$('accountStep').addEventListener('submit', e => {e.preventDefault();loginStudent()});$('examStep').addEventListener('submit', e => {e.preventDefault();enter()});
(async() => {try{const old=await saved();if(old&&old.studentAuthToken&&!old.finishedAt){studentAuthToken=old.studentAuthToken;$('studentEmail').value='';}}catch(_){} $('studentEmail').focus()})();
</script></body></html>`);
});

initDatabase().then(()=>{const PORT=process.env.PORT||3000;app.listen(PORT,()=>console.log(`Exam backend listening on port ${PORT}`));}).catch(error=>{console.error('Database initialization failed:',error);process.exit(1)});