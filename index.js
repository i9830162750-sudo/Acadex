const express = require('express');
const ACADEX_VERSION = 'v2.4.9';
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
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
const b2Configured=Boolean(process.env.B2_ENDPOINT&&process.env.B2_REGION&&process.env.B2_BUCKET&&process.env.B2_KEY_ID&&process.env.B2_APPLICATION_KEY);
const b2=b2Configured?new S3Client({endpoint:process.env.B2_ENDPOINT,region:process.env.B2_REGION,forcePathStyle:true,credentials:{accessKeyId:process.env.B2_KEY_ID,secretAccessKey:process.env.B2_APPLICATION_KEY}}):null;
function requireB2(){if(!b2)throw new Error('Backblaze B2 storage is not configured.');return b2;}
function pdfBufferFromDataUrl(dataUrl){
  if(typeof dataUrl!=='string')throw new Error('PDF data is missing.');
  if(dataUrl.startsWith('data:application/pdf+gzip;base64,'))dataUrl=decompressPdfDataUrl(dataUrl);
  if(!dataUrl.startsWith('data:application/pdf;base64,'))throw new Error('Invalid PDF data.');
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',')+1),'base64');
}
async function uploadPdfToB2(examId,dataUrl){
  const key=`exams/${examId}.pdf`;
  await requireB2().send(new PutObjectCommand({Bucket:process.env.B2_BUCKET,Key:key,Body:pdfBufferFromDataUrl(dataUrl),ContentType:'application/pdf',CacheControl:'private, max-age=3600'}));
  return key;
}
async function getPdfDataUrlFromB2(key){
  const out=await requireB2().send(new GetObjectCommand({Bucket:process.env.B2_BUCKET,Key:key}));
  const chunks=[];for await(const chunk of out.Body)chunks.push(Buffer.from(chunk));
  return 'data:application/pdf;base64,'+Buffer.concat(chunks).toString('base64');
}
async function deletePdfFromB2(key){if(key&&b2)await b2.send(new DeleteObjectCommand({Bucket:process.env.B2_BUCKET,Key:key}));}
async function uploadTemplateToB2(examId,questions){
  const key=`exams/${examId}.json`;
  await requireB2().send(new PutObjectCommand({
    Bucket:process.env.B2_BUCKET,Key:key,
    Body:Buffer.from(JSON.stringify(questions),'utf8'),
    ContentType:'application/json',
    CacheControl:'private, max-age=3600'
  }));
  return key;
}
async function getTemplateFromB2(key){
  const out=await requireB2().send(new GetObjectCommand({Bucket:process.env.B2_BUCKET,Key:key}));
  const chunks=[];for await(const chunk of out.Body)chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function getB2ObjectSize(key){
  if(!key||!b2)return 0;
  const out=await b2.send(new HeadObjectCommand({Bucket:process.env.B2_BUCKET,Key:key}));
  return Number(out.ContentLength||0);
}
const app = express();
app.use(cors());
app.use(express.json( {
  limit: '25mb'
}));
const ACADEX_MOBILE_NAV_FIX = `
<style id="acadex-mobile-nav-safe-area-fix">
@media (max-width:600px){
  .app{
    height:100dvh!important;
    min-height:100dvh!important;
    padding-bottom:0!important;
    box-sizing:border-box!important;
  }
  .main{
    height:100%!important;
    min-height:0!important;
  }
  .mobile-nav{
    position:fixed!important;
    left:0!important;
    right:0!important;
    top:auto!important;
    bottom:0!important;
    width:100vw!important;
    height:68px!important;
    min-height:68px!important;
    padding:7px 0 7px!important;
    margin:0!important;
    box-sizing:border-box!important;
    z-index:2147483647!important;
    flex:0 0 68px!important;
    transform:none!important;
    overflow:visible!important;
  }
  .app,.main,.content-scroll{
    position:relative!important;
  }
  .mobile-nav{
    isolation:isolate!important;
  }
  html{
    --acadex-system-nav-inset:0px!important;
  }
  .content-scroll{
    padding-bottom:calc(80px + var(--acadex-system-nav-inset, env(safe-area-inset-bottom)))!important;
    scroll-padding-bottom:calc(80px + var(--acadex-system-nav-inset, env(safe-area-inset-bottom)))!important;
  }
  .app{
    height:100dvh!important;
    min-height:0!important;
    overflow:hidden!important;
  }
  .topbar{
    position:fixed!important;
    top:0!important;
    left:0!important;
    right:0!important;
    width:100%!important;
    height:58px!important;
    z-index:10000!important;
  }
  .main{
    height:100dvh!important;
    min-height:0!important;
    max-height:none!important;
    overflow:hidden!important;
    display:block!important;
    padding-top:58px!important;
    padding-bottom:calc(68px + var(--acadex-system-nav-inset, env(safe-area-inset-bottom)))!important;
    box-sizing:border-box!important;
  }
  .content-scroll{
    height:100%!important;
    min-height:0!important;
    max-height:none!important;
    overflow-y:auto!important;
    overscroll-behavior-y:contain!important;
    box-sizing:border-box!important;
  }
  .home-panel.active{
    min-height:0!important;
    height:auto!important;
  }
  #appHome .home-wrap{
    padding-bottom:4px!important;
  }
  #appHome .home-hero{
    padding-top:clamp(6px,1.5vh,12px)!important;
    padding-bottom:clamp(4px,1vh,8px)!important;
  }
  #appHome .home-grid{
    margin-top:4px!important;
    gap:8px!important;
  }
  #appHome .home-card{
    padding:clamp(10px,2.5vw,14px)!important;
  }
  #appHome .home-stat-grid{
    margin-top:8px!important;
    gap:6px!important;
  }
  #appHome .home-stat{
    padding:8px!important;
  }
  .home-wrap{
    width:100%!important;
    max-width:none!important;
  }
  .home-hero{
    padding:clamp(10px,2.5vh,20px) 0 clamp(6px,1.5vh,12px)!important;
    gap:clamp(8px,2vw,14px)!important;
  }
  .home-title{
    font-size:clamp(1.65rem,7vw,2.05rem)!important;
    line-height:1.04!important;
  }
  .home-sub{
    font-size:clamp(.78rem,3.4vw,.88rem)!important;
    line-height:1.4!important;
    margin-top:7px!important;
  }
  .home-context{padding:8px 10px!important;}
  .home-grid{margin-top:clamp(6px,1.5vh,10px)!important;gap:10px!important;}
  .home-card{padding:clamp(12px,3.5vw,18px)!important;border-radius:15px!important;}
  .home-card h3{font-size:clamp(1rem,4.5vw,1.18rem)!important;}
  .home-card p{font-size:clamp(.74rem,3.2vw,.82rem)!important;line-height:1.4!important;}
  .home-action{margin-top:clamp(10px,2vh,18px)!important;padding:9px 12px!important;}
  .home-stat-grid{margin-top:10px!important;gap:8px!important;}
  .home-stat{padding:10px!important;border-radius:12px!important;}
  .home-stat-value{font-size:1.15rem!important;}
  .home-stat-label{font-size:.66rem!important;}

}
</style>
<script>
(function(){
  function updateAcadexSystemNavInset(){
    if(!window.matchMedia('(max-width:600px)').matches) return;
    var standalone=window.matchMedia('(display-mode:standalone)').matches || window.navigator.standalone===true;
    if(!standalone) return;

    var inset=0;
    try{
      var probe=document.createElement('div');
      probe.style.cssText='position:fixed;left:-9999px;bottom:0;width:1px;height:1px;padding-bottom:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none;';
      document.documentElement.appendChild(probe);
      inset=parseFloat(getComputedStyle(probe).paddingBottom)||0;
      probe.remove();
    }catch(_){}

    /*
      Android standalone PWAs can report a zero safe-area inset even when
      gesture/3-button navigation is consuming space at the bottom. In that
      case, use the difference between the physical screen and the layout
      viewport as a fallback. This is only applied in standalone mode so
      normal browser chrome does not get mistaken for the system nav bar.
    */
    /*
      Do not derive the system navigation height from screen.height -
      innerHeight. Android changes those values between gesture navigation,
      3-button navigation, keyboard visibility and viewport transitions.
      The fixed nav is anchored directly to the visual viewport instead.
    */
    document.documentElement.style.setProperty('--acadex-system-nav-inset','0px');
  }

  window.addEventListener('resize',updateAcadexSystemNavInset,{passive:true});
  window.addEventListener('orientationchange',function(){setTimeout(updateAcadexSystemNavInset,100)},{passive:true});
  if(window.visualViewport) window.visualViewport.addEventListener('resize',updateAcadexSystemNavInset,{passive:true});
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',updateAcadexSystemNavInset,{once:true});
  else updateAcadexSystemNavInset();
})();
</script>`;


app.get('/install', (req,res) => {
  try {
    const file = path.join(__dirname, 'public', 'install.html');
    res.type('html').send(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    res.status(500).send('Acadex install page is unavailable.');
  }
});

app.get('/', (req,res) => {
  try {
    const file = path.join(__dirname, 'public', 'pwa-loader.html');
    res.set('Cache-Control','public, max-age=0, must-revalidate');
    res.type('html').send(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    res.status(500).send('Acadex is unavailable.');
  }
});


app.get('/app/acadex-app-7f3c9e21', (req,res) => {
  try {
    const file = path.join(__dirname, 'public', 'index.html');
    let html = fs.readFileSync(file, 'utf8');
    html = html.replace('</head>', '<meta name="acadex-ui" content="combined"><style id="acadex-ui-endpoint">html,body{min-width:0;}body{overflow-x:hidden;}</style>' + ACADEX_MOBILE_NAV_FIX + '</head>');
    res.set('Cache-Control','no-store, no-cache, must-revalidate');
    res.type('html').send(html);
  } catch (_) {
    res.status(500).send('Acadex app is unavailable.');
  }
});


app.use(express.static(path.join(__dirname, 'public')));
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

function compressPdfDataUrl(dataUrl){
  if(typeof dataUrl!=='string'||!dataUrl.startsWith('data:application/pdf;base64,')) return dataUrl;
  const comma=dataUrl.indexOf(',');
  if(comma<0)return dataUrl;
  const source=Buffer.from(dataUrl.slice(comma+1),'base64');
  const compressed=zlib.gzipSync(source,{level:9});
  return 'data:application/pdf+gzip;base64,'+compressed.toString('base64');
}
function decompressPdfDataUrl(dataUrl){
  if(typeof dataUrl!=='string'||!dataUrl.startsWith('data:application/pdf+gzip;base64,')) return dataUrl;
  const comma=dataUrl.indexOf(',');
  if(comma<0)return dataUrl;
  const compressed=Buffer.from(dataUrl.slice(comma+1),'base64');
  const source=zlib.gunzipSync(compressed);
  return 'data:application/pdf;base64,'+source.toString('base64');
}
async function compressStoredPdfs(){
  const {rows}=await pool.query("SELECT id,pdf_data_url FROM exams WHERE type='pdf' AND pdf_data_url LIKE 'data:application/pdf;base64,%'");
  if(!rows.length)return;
  let saved=0;
  for(const row of rows){
    const compressed=compressPdfDataUrl(row.pdf_data_url);
    if(compressed!==row.pdf_data_url){
      await pool.query('UPDATE exams SET pdf_data_url=$1 WHERE id=$2',[compressed,row.id]);
      saved++;
    }
  }
  if(saved)console.log('Compressed '+saved+' existing PDF exam file'+(saved===1?'':'s')+' losslessly.');
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
      pdf_object_key TEXT, 
      content_object_key TEXT,
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
    ALTER TABLE exams ADD COLUMN IF NOT EXISTS pdf_object_key TEXT;
    ALTER TABLE exams ADD COLUMN IF NOT EXISTS content_object_key TEXT;
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
    /*
      Session identity is not globally unique: student IDs such as "Class VIII"
      can be shared, and a device can legitimately create a later attempt.
      Active-session checks are handled by the application below. Remove the
      legacy database-level uniqueness constraints so finished attempts never
      block a new attempt.
    */
    ALTER TABLE exam_sessions DROP CONSTRAINT IF EXISTS uq_exam_sessions_exam_student;
    ALTER TABLE exam_sessions DROP CONSTRAINT IF EXISTS uq_exam_sessions_exam_device;
    DROP INDEX IF EXISTS uq_exam_sessions_exam_student;
    DROP INDEX IF EXISTS uq_exam_sessions_exam_device;
    DROP INDEX IF EXISTS uq_exam_sessions_exam_student_active;
    DROP INDEX IF EXISTS uq_exam_sessions_exam_device_active;
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
  await migrateExamContentToB2();
  console.log('Neon database ready.');
}

async function migrateExamContentToB2(){
  if(!b2Configured){console.warn('Backblaze B2 is not configured; existing exam content remains in Neon.');return;}
  const {rows}=await pool.query(`SELECT id,type,pdf_data_url,pdf_object_key,content_object_key,questions_json FROM exams WHERE content_object_key IS NULL OR content_object_key=''`);
  let migrated=0;
  for(const row of rows){
    try{
      let key=null;
      if(row.type==='pdf'){
        if(row.pdf_object_key) key=row.pdf_object_key;
        else if(row.pdf_data_url) key=await uploadPdfToB2(row.id,row.pdf_data_url);
      }else if(row.type==='template' && row.questions_json){
        const questions=typeof row.questions_json==='string'?JSON.parse(row.questions_json):row.questions_json;
        key=await uploadTemplateToB2(row.id,questions);
      }
      if(key){
        await pool.query('UPDATE exams SET content_object_key=$1,pdf_data_url=NULL,pdf_object_key=NULL,questions_json=NULL WHERE id=$2',[key,row.id]);
        migrated++;
      }
    }catch(error){console.error('Could not migrate exam '+row.id+' content to B2:',error);}
  }
  if(migrated)console.log('Migrated '+migrated+' exam content object'+(migrated===1?'':'s')+' from Neon to Backblaze B2.');
}
async function getExam(id){
  const { rows } = await pool.query(`SELECT id,title,type,pdf_data_url,pdf_object_key,content_object_key,questions_json,student_password,duration_ms,created_at,owner_user_id FROM exams WHERE id=$1`,[id]);
  const exam=rows[0]||null;
  if(!exam)return null;
  if(exam.content_object_key){
    if(exam.type==='pdf')exam.pdf_data_url=await getPdfDataUrlFromB2(exam.content_object_key);
    else exam.questions_json=await getTemplateFromB2(exam.content_object_key);
  }else if(exam.pdf_object_key){
    exam.pdf_data_url=await getPdfDataUrlFromB2(exam.pdf_object_key);
  }else if(exam.pdf_data_url){
    exam.pdf_data_url=decompressPdfDataUrl(exam.pdf_data_url);
  }
  return exam;
}
function parseQuestions(exam){
  if(!exam.questions_json) return [];
  try { return typeof exam.questions_json === 'string' ? JSON.parse(exam.questions_json) : exam.questions_json; }
  catch(_){ return []; }
}
function publicExam(exam){
  return { examId:exam.id, title:exam.title, type:exam.type, pdfDataUrl:exam.pdf_data_url||null, questions:parseQuestions(exam), durationMs:Number(exam.duration_ms), createdAt:Number(exam.created_at), allowRetake:Boolean(exam.allow_retake), maxAttempts:exam.max_attempts===null||exam.max_attempts===undefined?null:Number(exam.max_attempts) };
}
function gradeExam(exam, answers){
  const questions=parseQuestions(exam);
  const submitted=answers && typeof answers==='object' ? answers : {};
  const results=[];
  let score=0;

  questions.forEach((q,i)=>{
    const key=String(i);
    const raw=submitted[key];
    const unanswered=raw===undefined||raw===null||String(raw)==='';
    let yourAnswer=unanswered?'Unanswered':String(raw);
    let correctAnswer='';

    if(q.type==='mcq'){
      const correctIndex=Number(q.answer);
      correctAnswer=Number.isInteger(correctIndex)&&q.options?.[correctIndex]!==undefined
        ? String(q.options[correctIndex])
        : '—';
      const selectedIndex=unanswered?null:Number(raw);
      const correct=!unanswered && Number.isInteger(selectedIndex) && selectedIndex===correctIndex;
      if(correct) score++;
      results.push({
        questionNumber:i+1,
        question:q.text||'',
        yourAnswer:unanswered?'Unanswered':(q.options?.[selectedIndex]!==undefined?String(q.options[selectedIndex]):String(raw)),
        correctAnswer,
        correct
      });
    }else if(q.type==='tf'){
      const correctValue=String(q.answer);
      correctAnswer=correctValue==='true'?'True':correctValue==='false'?'False':'—';
      const selected=unanswered?'':String(raw).toLowerCase();
      const correct=!unanswered && selected===correctValue;
      if(correct) score++;
      results.push({
        questionNumber:i+1,
        question:q.text||'',
        yourAnswer:unanswered?'Unanswered':(selected==='true'?'True':selected==='false'?'False':String(raw)),
        correctAnswer,
        correct
      });
    }
  });

  const total=questions.length;
  const percentage=total ? Number(((score/total)*100).toFixed(2)) : 0;
  return {score,total,percentage,results};
}



app.post('/api/auth/register', async(req,res)=>{ try{ const {role,email,password,displayName,studentId}=req.body||{}; if(!['teacher','student'].includes(role))return res.status(400).json({error:'Choose teacher or student.'}); const e=String(email||'').trim().toLowerCase(); const p=String(password||''); const n=String(displayName||'').trim(); if(!e||!e.includes('@'))return res.status(400).json({error:'Enter a valid email.'}); if(p.length<6)return res.status(400).json({error:'Password must be at least 6 characters.'}); if(n.length<2)return res.status(400).json({error:'Enter your name.'}); if(role==='student'&&!String(studentId||'').trim())return res.status(400).json({error:'Student ID is required.'}); const exists=await pool.query('SELECT id FROM users WHERE email=$1',[e]); if(exists.rows[0])return res.status(409).json({error:'An account with that email already exists.'}); const id='usr_'+crypto.randomBytes(12).toString('hex'); await pool.query('INSERT INTO users(id,role,email,password_hash,display_name,student_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,role,e,makePasswordHash(p),n,role==='student'?String(studentId).trim():null,Date.now()]); const token=makeToken(); await pool.query('INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)',[hashToken(token),id,Date.now(),Date.now()+1000*60*60*24*30]); res.json({token,user:{id,role,email:e,displayName:n,studentId:role==='student'?String(studentId).trim():null}}); }catch(err){console.error(err);res.status(500).json({error:'Could not create account.'});} });
app.post('/api/auth/login', async(req,res)=>{ try{ const e=String(req.body?.email||'').trim().toLowerCase(), p=String(req.body?.password||''); const {rows}=await pool.query('SELECT id,role,email,password_hash,display_name,student_id FROM users WHERE email=$1',[e]); const u=rows[0]; if(!u||!verifyPassword(p,u.password_hash))return res.status(401).json({error:'Incorrect email or password.'}); const token=makeToken(); await pool.query('INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES($1,$2,$3,$4)',[hashToken(token),u.id,Date.now(),Date.now()+1000*60*60*24*30]); res.json({token,user:{id:u.id,role:u.role,email:u.email,displayName:u.display_name,studentId:u.student_id}}); }catch(err){console.error(err);res.status(500).json({error:'Could not log in.'});} });
app.post('/api/auth/logout', async(req,res)=>{ try{ const raw=String(req.headers.authorization||'').replace(/^Bearer\s+/,'').trim(); if(raw)await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1',[hashToken(raw)]); res.json({ok:true}); }catch(err){res.status(500).json({error:'Could not log out.'});} });
app.delete('/api/auth/account', async(req,res)=>{
  const client=await pool.connect();
  try{
    const raw=String(req.headers.authorization||'').replace(/^Bearer\s+/,'').trim();
    if(!raw)return res.status(401).json({error:'Not logged in.'});
    const u=await getAuthUser(req);
    if(!u)return res.status(401).json({error:'Not logged in.'});
    const password=String(req.body?.password||'');
    if(!password)return res.status(400).json({error:'Password is required.'});
    const {rows}=await client.query('SELECT password_hash FROM users WHERE id=$1',[u.id]);
    if(!rows[0]||!verifyPassword(password,rows[0].password_hash))return res.status(401).json({error:'Password is incorrect.'});

    await client.query('BEGIN');
    const ownedExams=await client.query('SELECT content_object_key,pdf_object_key FROM exams WHERE owner_user_id=$1 AND (content_object_key IS NOT NULL OR pdf_object_key IS NOT NULL)',[u.id]);
    await client.query('DELETE FROM exams WHERE owner_user_id=$1',[u.id]);
    await client.query('DELETE FROM exam_submissions WHERE student_user_id=$1',[u.id]);
    await client.query('DELETE FROM exam_sessions WHERE student_user_id=$1',[u.id]);
    await client.query('DELETE FROM auth_sessions WHERE user_id=$1',[u.id]);
    await client.query('DELETE FROM users WHERE id=$1',[u.id]);
    await client.query('COMMIT');
    for(const row of ownedExams.rows){
      try{await deletePdfFromB2((row.content_object_key||row.pdf_object_key));}catch(error){console.error('Could not delete account PDF from B2:',error);}
    }
    res.json({ok:true});
  }catch(err){
    try{await client.query('ROLLBACK')}catch(_){}
    console.error(err);
    res.status(500).json({error:'Could not delete the account.'});
  }finally{client.release();}
});
app.get('/api/auth/me', async(req,res)=>{ try{const u=await getAuthUser(req); if(!u)return res.status(401).json({error:'Not logged in.'}); res.json({user:{id:u.id,role:u.role,email:u.email,displayName:u.display_name,studentId:u.student_id}});}catch(err){res.status(500).json({error:'Could not load account.'});} });
app.post('/api/auth/change-password', async(req,res)=>{ try{ const u=await getAuthUser(req); if(!u)return res.status(401).json({error:'Not logged in.'}); const current=String(req.body?.currentPassword||''); const next=String(req.body?.newPassword||''); if(!current||!next)return res.status(400).json({error:'Both fields are required.'}); if(next.length<6)return res.status(400).json({error:'New password must be at least 6 characters.'}); const {rows}=await pool.query('SELECT password_hash FROM users WHERE id=$1',[u.id]); if(!rows[0]||!verifyPassword(current,rows[0].password_hash))return res.status(401).json({error:'Current password is incorrect.'}); await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2',[makePasswordHash(next),u.id]); res.json({ok:true}); }catch(err){console.error(err);res.status(500).json({error:'Could not change password.'});} });
app.get('/api/admin/my-storage', async(req,res)=>{try{
  const u=await getAuthUser(req);if(!u)return res.status(401).json({error:'Not logged in.'});
  const {rows}=await pool.query(`SELECT id,title,type,created_at,content_object_key,pdf_object_key FROM exams WHERE owner_user_id=$1 ORDER BY created_at DESC`,[u.id]);
  const exams=[];
  let totalExamBytes=0;
  for(const r of rows){
    const key=r.content_object_key||r.pdf_object_key;
    let examBytes=0;
    if(key){try{examBytes=await getB2ObjectSize(key);}catch(_){}}
    exams.push({id:r.id,title:r.title,type:r.type,createdAt:Number(r.created_at),examBytes,submissionCount:0,submissionBytes:0,totalBytes:examBytes,storage:'B2',objectKey:key||null});
    totalExamBytes+=examBytes;
  }
  const sub=await pool.query(`SELECT s.exam_id,COUNT(*)::int AS count,COALESCE(SUM(length(COALESCE(s.answers_json::text,''))+length(COALESCE(s.results_json::text,'')))::bigint,0) AS bytes FROM exam_submissions s JOIN exams e ON e.id=s.exam_id WHERE e.owner_user_id=$1 GROUP BY s.exam_id`,[u.id]);
  const byExam=new Map(sub.rows.map(x=>[x.exam_id,{count:Number(x.count||0),bytes:Number(x.bytes||0)}]));
  let totalSubBytes=0;
  for(const e of exams){const x=byExam.get(e.id);if(x){e.submissionCount=x.count;e.submissionBytes=x.bytes;e.totalBytes+=x.bytes;totalSubBytes+=x.bytes;}}
  res.json({provider:'Backblaze B2',bucket:process.env.B2_BUCKET||null,exams,totalExamBytes,totalSubBytes,totalBytes:totalExamBytes+totalSubBytes});
}catch(err){console.error(err);res.status(500).json({error:'Could not fetch storage.'});}});

app.get('/api/admin/db-size', async(req,res)=>{ try{ const u=await getAuthUser(req); if(!u)return res.status(401).json({error:'Not logged in.'}); const {rows}=await pool.query("SELECT pg_database_size(current_database()) AS size"); const bytes=Number(rows[0].size); res.json({usedBytes:bytes,version:ACADEX_VERSION}); }catch(err){console.error(err);res.status(500).json({error:'Could not fetch DB size.'});} });
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
    const u=await requireRole(req,res,'teacher');if(!u)return;
    const {rows}=await pool.query(`SELECT id,title,type,student_password,duration_ms,created_at,folder_id FROM exams WHERE id=$1 AND owner_user_id=$2`,[req.params.id,u.id]);
    const e=rows[0];if(!e)return res.status(404).json({error:'Exam not found.'});
    const full=await getExam(e.id);
    const folder=await pool.query('SELECT name FROM exam_folders WHERE id=$1 AND owner_user_id=$2',[e.folder_id,u.id]);
    res.json({id:e.id,title:e.title,type:e.type,pdfDataUrl:full?.pdf_data_url||null,questions:parseQuestions(full),studentPassword:e.student_password,durationMs:Number(e.duration_ms),createdAt:Number(e.created_at),folderId:e.folder_id||null,folderName:folder.rows[0]?.name||null,url:(process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`)+`/exam/${encodeURIComponent(e.id)}`});
  }catch(err){console.error(err);res.status(500).json({error:'Could not load exam.'});}
});
app.patch('/api/teacher/exams/:id', async(req,res)=>{
  try{
    const u=await requireRole(req,res,'teacher');if(!u)return;
    const current=await pool.query('SELECT id,title,type,content_object_key,questions_json,pdf_data_url,pdf_object_key,student_password,duration_ms,folder_id,allow_retake,max_attempts FROM exams WHERE id=$1 AND owner_user_id=$2',[req.params.id,u.id]);
    const e=current.rows[0];if(!e)return res.status(404).json({error:'Exam not found.'});
    const body=req.body||{};
    const title=body.title===undefined?e.title:String(body.title||'').trim();
    const password=body.studentPassword===undefined?e.student_password:String(body.studentPassword||'');
    const duration=body.durationMs===undefined?Number(e.duration_ms):Number(body.durationMs);
    const type=body.type===undefined?e.type:String(body.type);
    const allowRetake=body.allowRetake===undefined?Boolean(e.allow_retake):Boolean(body.allowRetake);
    const maxAttempts=body.maxAttempts===undefined?e.max_attempts:(body.maxAttempts===null||body.maxAttempts===''?null:Number(body.maxAttempts));
    if(!title)return res.status(400).json({error:'title is required'});
    if(!password)return res.status(400).json({error:'studentPassword is required'});
    if(!Number.isFinite(duration)||duration<=0)return res.status(400).json({error:'durationMs must be a positive number'});
    if(!['pdf','template'].includes(type))return res.status(400).json({error:'type must be pdf or template'});
    let contentObjectKey=e.content_object_key||e.pdf_object_key||null,questions=e.questions_json?parseQuestions(e):[],pdfDataUrl=null;
    if(type==='pdf'){
      if(body.pdfDataUrl!==undefined){
        contentObjectKey=await uploadPdfToB2(req.params.id,body.pdfDataUrl);
      }else if(!contentObjectKey){
        return res.status(400).json({error:'pdfDataUrl is required for PDF exams'});
      }
      questions=[];
    }else{
      questions=body.questions===undefined?questions:body.questions;
      if(!Array.isArray(questions)||!questions.length)return res.status(400).json({error:'template exams require at least one question'});
      for(const q of questions){
        if(!q||!['mcq','tf'].includes(q.type)||typeof q.text!=='string'||!q.text.trim())return res.status(400).json({error:'invalid question'});
        if(q.type==='mcq'&&(!Array.isArray(q.options)||q.options.length!==4||q.options.some(o=>typeof o!=='string'||!o.trim())||!Number.isInteger(Number(q.answer))||Number(q.answer)<0||Number(q.answer)>3))return res.status(400).json({error:'invalid MCQ question'});
        if(q.type==='tf'&&q.answer!=='true'&&q.answer!=='false')return res.status(400).json({error:'invalid True/False question'});
      }
      contentObjectKey=await uploadTemplateToB2(req.params.id,questions);
    }
    let folderId=e.folder_id||null;
    if(body.folderId!==undefined){
      folderId=body.folderId===null||body.folderId===''?null:String(body.folderId);
      if(folderId){const f=await pool.query('SELECT id FROM exam_folders WHERE id=$1 AND owner_user_id=$2',[folderId,u.id]);if(!f.rows[0])return res.status(400).json({error:'Folder not found.'});}
    }
    await pool.query('UPDATE exams SET title=$1,type=$2,pdf_data_url=NULL,pdf_object_key=NULL,content_object_key=$3,questions_json=NULL,student_password=$4,duration_ms=$5,folder_id=$6,allow_retake=$7,max_attempts=$8 WHERE id=$9 AND owner_user_id=$10',[title,type,contentObjectKey,password,duration,folderId,allowRetake,maxAttempts,e.id,u.id]);
    if(e.content_object_key&&e.content_object_key!==contentObjectKey)await deletePdfFromB2(e.content_object_key);
    else if(e.pdf_object_key&&e.pdf_object_key!==contentObjectKey)await deletePdfFromB2(e.pdf_object_key);
    const baseUrl=process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`;
    res.json({ok:true,examId:e.id,url:`${baseUrl}/exam/${encodeURIComponent(e.id)}`});
  }catch(err){console.error(err);res.status(500).json({error:'Could not save exam changes.'});}
});
app.delete('/api/teacher/exams/:id', async(req,res)=>{
  try{
    const u=await requireRole(req,res,'teacher');if(!u)return;
    const current=await pool.query('SELECT id,content_object_key,pdf_object_key FROM exams WHERE id=$1 AND owner_user_id=$2',[req.params.id,u.id]);
    if(!current.rows[0])return res.status(404).json({error:'Exam not found.'});
    const result=await pool.query('DELETE FROM exams WHERE id=$1 AND owner_user_id=$2 RETURNING id',[req.params.id,u.id]);
    if(!result.rows[0])return res.status(404).json({error:'Exam not found.'});
    const key=current.rows[0].content_object_key||current.rows[0].pdf_object_key;
    if(key)await deletePdfFromB2(key);
    res.json({ok:true,examId:result.rows[0].id});
  }catch(err){console.error(err);res.status(500).json({error:'Could not delete exam.'});}
});
app.get('/api/teacher/exams/:id/results', async(req,res)=>{
  try{
    const u=await requireRole(req,res,'teacher'); if(!u)return;
    const {rows:er}=await pool.query('SELECT id,title,type FROM exams WHERE id=$1 AND owner_user_id=$2',[req.params.id,u.id]);
    if(!er[0])return res.status(404).json({error:'Exam not found.'});
    const exam=er[0];
    const examUrl=(process.env.PUBLIC_BASE_URL||req.protocol+'://'+req.get('host'))+'/exam/'+encodeURIComponent(req.params.id);

    if(exam.type==='pdf'){
      /*
        PDF exams are submission/attempt tracking only. There is deliberately
        no score/result view for them. Include active sessions as attempts and
        completed submissions as submitted attempts.
      */
      const {rows}=await pool.query(`
        SELECT
          es.token AS session_token,
          es.student_id,
          es.student_name,
          es.student_user_id,
          es.created_at,
          es.finished_at,
          s.id AS submission_id,
          s.submitted_at
        FROM exam_sessions es
        LEFT JOIN exam_submissions s ON s.session_token=es.token AND s.exam_id=es.exam_id
        WHERE es.exam_id=$1
        ORDER BY COALESCE(s.submitted_at,es.created_at) DESC
      `,[req.params.id]);
      return res.json({
        exam:{...exam,url:examUrl},
        pdf:true,
        results:rows.map(x=>({
          id:x.submission_id||null,
          sessionToken:x.session_token,
          studentId:x.student_id,
          studentName:x.student_name,
          studentUserId:x.student_user_id||null,
          submitted:Boolean(x.submission_id),
          attemptedAt:Number(x.created_at),
          submittedAt:x.submitted_at?Number(x.submitted_at):null
        }))
      });
    }

    const {rows}=await pool.query(`
      SELECT s.id,s.public_result_token,s.student_id,s.student_name,s.student_user_id,s.score,s.total,s.percentage,s.submitted_at,
        ROW_NUMBER() OVER (PARTITION BY s.student_user_id ORDER BY s.submitted_at ASC)::int AS attempt_number,
        COUNT(*) OVER (PARTITION BY s.student_user_id)::int AS attempt_count
      FROM exam_submissions s
      JOIN exams e ON e.id=s.exam_id
      WHERE s.exam_id=$1 AND e.type='template'
      ORDER BY s.student_user_id, s.submitted_at DESC
    `,[req.params.id]);
    res.json({
      exam:{...exam,url:examUrl},
      pdf:false,
      results:rows.map(x=>({...x,publicResultToken:x.public_result_token||null,publicResultUrl:x.public_result_token?((process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`)+`/result/${encodeURIComponent(x.public_result_token)}`):null,percentage:Number(x.percentage),submittedAt:Number(x.submitted_at)}))
    });
  }catch(err){console.error(err);res.status(500).json({error:'Could not load results.'});}
});
app.get('/api/teacher/submissions/:id', async(req,res)=>{ try{const u=await requireRole(req,res,'teacher');if(!u)return; const {rows}=await pool.query(`SELECT s.id,s.public_result_token,s.student_id,s.student_name,s.score,s.total,s.percentage,s.answers_json,s.results_json,s.submitted_at,e.id AS exam_id,e.title FROM exam_submissions s JOIN exams e ON e.id=s.exam_id WHERE s.id=$1 AND e.owner_user_id=$2 AND e.type='template'`,[req.params.id,u.id]);if(!rows[0])return res.status(404).json({error:'Result not found.'});const r=rows[0];res.json({submissionId:r.id,publicResultToken:r.public_result_token||null,publicResultUrl:r.public_result_token?((process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`)+`/result/${encodeURIComponent(r.public_result_token)}`):null,examId:r.exam_id,examTitle:r.title,studentId:r.student_id,studentName:r.student_name,score:r.score,total:r.total,percentage:Number(r.percentage),answers:r.answers_json,results:r.results_json,submittedAt:Number(r.submitted_at)});}catch(err){console.error(err);res.status(500).json({error:'Could not load result.'});} });
app.get('/api/student/results', async(req,res)=>{ try{const u=await requireRole(req,res,'student');if(!u)return; const {rows}=await pool.query(`SELECT s.id,s.public_result_token,s.exam_id,e.title,s.score,s.total,s.percentage,s.submitted_at,
      ROW_NUMBER() OVER (PARTITION BY s.exam_id ORDER BY s.submitted_at ASC)::int AS attempt_number,
      COUNT(*) OVER (PARTITION BY s.exam_id)::int AS attempt_count
      FROM exam_submissions s JOIN exams e ON e.id=s.exam_id WHERE s.student_user_id=$1 AND e.type='template' ORDER BY s.submitted_at DESC`,[u.id]);res.json({results:rows.map(x=>({...x,publicResultUrl:x.public_result_token?((process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`)+`/result/${encodeURIComponent(x.public_result_token)}`):null,percentage:Number(x.percentage),submittedAt:Number(x.submitted_at)}))});}catch(err){console.error(err);res.status(500).json({error:'Could not load results.'});} });

app.get('/api/student/results/:id', async(req,res)=>{ try{const u=await requireRole(req,res,'student');if(!u)return; const {rows}=await pool.query(`SELECT s.id,s.exam_id,e.title,s.score,s.total,s.percentage,s.answers_json,s.results_json,s.submitted_at FROM exam_submissions s JOIN exams e ON e.id=s.exam_id WHERE s.id=$1 AND s.student_user_id=$2 AND e.type='template'`,[req.params.id,u.id]); if(!rows[0])return res.status(404).json({error:'Result not found.'}); const r=rows[0]; res.json({submissionId:r.id,examId:r.exam_id,examTitle:r.title,score:r.score,total:r.total,percentage:Number(r.percentage),answers:r.answers_json,results:r.results_json,submittedAt:Number(r.submitted_at)}); }catch(err){console.error(err);res.status(500).json({error:'Could not load result.'});} });
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
      WHERE s.student_user_id=$1 AND e.owner_user_id=$2 AND e.type='template'
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
      WHERE s.id=$1 AND s.student_user_id=$2 AND e.owner_user_id=$3 AND e.type='template'`,[req.params.submissionId,req.params.studentId,u.id]);
    let r=rows[0];
    if(!r)return res.status(404).json({error:'Result not found.'});
    if(!r.public_result_token){
      r.public_result_token=makeToken();
      await pool.query('UPDATE exam_submissions SET public_result_token=$1 WHERE id=$2',[r.public_result_token,r.id]);
    }
    res.json({
      submissionId:r.id,publicResultUrl:((process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`)+`/result/${encodeURIComponent(r.public_result_token)}`),examId:r.exam_id,examTitle:r.title,
      studentId:r.student_id,studentName:r.student_name,studentEmail:r.student_email,
      score:Number(r.score),total:Number(r.total),percentage:Number(r.percentage),
      answers:r.answers_json,results:r.results_json,submittedAt:Number(r.submitted_at)
    });
  }catch(err){console.error(err);res.status(500).json({error:'Could not load result.'});}
});
app.get('/ping', (req, res) => res.json({ok:true, ts:Date.now()}));
app.get('/api/health', (req, res) => res.json({ok:true, ts:Date.now(), version:ACADEX_VERSION}));

app.post('/exam/create', async(req, res) => {
  try{
    const user=await requireRole(req,res,'teacher'); if(!user)return;
    const {title, studentPassword, durationMs, type='pdf', pdfDataUrl=null, questions=[], folderId=null, allowRetake=false, maxAttempts=null}=req.body||{};
    const safeAllowRetake=Boolean(allowRetake);
    const safeMaxAttempts=maxAttempts===null||maxAttempts===''||maxAttempts===undefined?null:Number(maxAttempts);
    if(safeMaxAttempts!==null && (!Number.isInteger(safeMaxAttempts)||safeMaxAttempts<1)) return res.status(400).json({error:'maxAttempts must be a positive integer or null'});
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
    const contentObjectKey=type==='pdf'
      ? await uploadPdfToB2(examId,pdfDataUrl)
      : await uploadTemplateToB2(examId,questions);
    await pool.query(`INSERT INTO exams(id,title,type,pdf_data_url,pdf_object_key,content_object_key,questions_json,student_password,duration_ms,created_at,owner_user_id,folder_id,allow_retake,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[examId,title,type,null,null,contentObjectKey,null,studentPassword,durationMs,Date.now(),user.id,safeFolderId,safeAllowRetake,safeMaxAttempts]);
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
    const exam=await getExam(req.params.id);
    if(!exam) return res.status(404).json({error:'Exam not found'});

    const body=req.body||{};
    const authUser=await getAuthUser(req);
    if(!authUser || authUser.role!=='student'){
      return res.status(401).json({error:'Student account login is required.'});
    }

    const token=typeof body.sessionToken==='string'?body.sessionToken.trim():'';
    const deviceId=typeof body.deviceId==='string'?body.deviceId.trim():'';
    let studentId=authUser.student_id||String(body.studentId||'').trim();
    let studentName=authUser.display_name||String(body.studentName||'').trim();
    const password=typeof body.password==='string'?body.password:'';

    // Resume an existing active session. The session token belongs to the
    // student account, so the student can move between devices.
    if(token){
      const {rows}=await pool.query(
        `SELECT token,exam_id,student_id,student_name,device_id,student_user_id,started_at,end_at,finished_at
         FROM exam_sessions WHERE token=$1 AND exam_id=$2`,
        [token,exam.id]
      );
      const existing=rows[0];
      if(existing){
        if(existing.student_user_id && existing.student_user_id!==authUser.id){
          return res.status(403).json({error:'This exam attempt belongs to another student account.'});
        }
        if(!existing.student_user_id){
          await pool.query('UPDATE exam_sessions SET student_user_id=$1 WHERE token=$2',[authUser.id,existing.token]);
        }
        const now=Date.now();
        if(existing.finished_at || now>=Number(existing.end_at)){
          if(!existing.finished_at){
            await pool.query('UPDATE exam_sessions SET finished_at=$1 WHERE token=$2',[now,existing.token]);
          }
          return res.status(410).json({error:'This exam attempt is already finished.',endAt:Number(existing.end_at)});
        }
        return res.json({
          sessionToken:existing.token,
          studentId:existing.student_id,
          studentName:existing.student_name,
          deviceId:existing.device_id,
          startedAt:Number(existing.started_at),
          endAt:Number(existing.end_at),
          ...publicExam(exam)
        });
      }
    }

    if(!studentId) return res.status(400).json({error:'Student ID is required.'});
    if(!studentName) return res.status(400).json({error:'Student name is required.'});
    if(studentId.length>100) return res.status(400).json({error:'Student ID is too long.'});
    if(studentName.length>150) return res.status(400).json({error:'Student name is too long.'});
    if(password!==exam.student_password) return res.status(401).json({error:'Incorrect password'});

    const completedResult=await pool.query(
      'SELECT COUNT(*)::int AS count FROM exam_submissions WHERE exam_id=$1 AND student_user_id=$2',
      [exam.id,authUser.id]
    );
    if(Number(completedResult.rows[0]?.count||0)>0){
      return res.status(409).json({error:'You have already completed this exam.'});
    }

    // An active attempt belongs to the authenticated student account only.
    // Do NOT match on student_id or device_id: class/student IDs can be shared
    // between accounts, and the same device can legitimately be used by
    // different students taking the same exam.
    const activeResult=await pool.query(
      `SELECT token,student_id,student_name,device_id,student_user_id,started_at,end_at,finished_at
       FROM exam_sessions
       WHERE exam_id=$1 AND finished_at IS NULL AND student_user_id=$2
       ORDER BY created_at DESC LIMIT 1`,
      [exam.id,authUser.id]
    );
    const active=activeResult.rows[0];
    if(active && Date.now()<Number(active.end_at)){
      if(active.student_user_id && active.student_user_id!==authUser.id){
        return res.status(409).json({error:'An active attempt for this exam is already associated with another student account.'});
      }
      if(!active.student_user_id){
        await pool.query('UPDATE exam_sessions SET student_user_id=$1 WHERE token=$2',[authUser.id,active.token]);
      }
      return res.json({
        sessionToken:active.token,
        studentId:active.student_id,
        studentName:active.student_name,
        deviceId:active.device_id,
        startedAt:Number(active.started_at),
        endAt:Number(active.end_at),
        ...publicExam(exam)
      });
    }

    const sessionToken=makeToken();
    const startedAt=Date.now();
    const endAt=startedAt+Math.max(1000,Number(exam.duration_ms)||3600000);

    await pool.query(
      `INSERT INTO exam_sessions(token,exam_id,started_at,end_at,created_at,finished_at,student_id,student_name,device_id,student_user_id)
       VALUES($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9)`,
      [sessionToken,exam.id,startedAt,endAt,startedAt,studentId,studentName,deviceId,authUser.id]
    );

    return res.json({
      sessionToken,
      studentId,
      studentName,
      deviceId,
      startedAt,
      endAt,
      ...publicExam(exam)
    });
  }catch(error){
    console.error('Start exam session error:',error);
    res.status(500).json({error:'Could not start exam session'});
  }
});

app.post('/api/exam/:id/finish', async(req,res) => {
  try{
    const exam=await getExam(req.params.id);
    if(!exam) return res.status(404).json({error:'Exam not found'});

    const authUser=await getAuthUser(req);
    if(!authUser || authUser.role!=='student'){
      return res.status(401).json({error:'Student account login is required.'});
    }

    const finishToken=typeof req.body?.sessionToken==='string'?req.body.sessionToken.trim():'';
    if(!finishToken) return res.status(400).json({error:'sessionToken is required'});

    const existing=await pool.query(
      `SELECT id,public_result_token,score,total,percentage,answers_json,results_json,submitted_at
       FROM exam_submissions WHERE session_token=$1 AND exam_id=$2`,
      [finishToken,exam.id]
    );
    if(existing.rows[0]){
      const x=existing.rows[0];
      return res.json({
        submissionId:x.id,
        publicResultToken:x.public_result_token||null,
        publicResultUrl:x.public_result_token?((process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`)+`/result/${encodeURIComponent(x.public_result_token)}`):null,
        score:x.score,total:x.total,percentage:Number(x.percentage),
        answers:x.answers_json,results:x.results_json,submittedAt:Number(x.submitted_at)
      });
    }

    const sessionResult=await pool.query(
      `SELECT token,student_id,student_name,student_user_id,end_at,finished_at
       FROM exam_sessions WHERE token=$1 AND exam_id=$2`,
      [finishToken,exam.id]
    );
    const session=sessionResult.rows[0];
    if(!session) return res.status(404).json({error:'Session not found'});
    if(session.student_user_id && session.student_user_id!==authUser.id){
      return res.status(403).json({error:'This exam attempt belongs to another student account.'});
    }
    if(!session.student_user_id){
      await pool.query('UPDATE exam_sessions SET student_user_id=$1 WHERE token=$2',[authUser.id,session.token]);
      session.student_user_id=authUser.id;
    }
    if(session.finished_at) return res.status(409).json({error:'This attempt is already closed.'});

    const answers=req.body?.answers && typeof req.body.answers==='object'?req.body.answers:{};
    const submittedAt=Date.now();

    if(exam.type==='pdf'){
      const submissionId='sub_'+crypto.randomBytes(12).toString('hex');
      await pool.query(
        `INSERT INTO exam_submissions(id,exam_id,session_token,student_id,student_name,answers_json,results_json,score,total,percentage,submitted_at,student_user_id,public_result_token)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL)`,
        [submissionId,exam.id,finishToken,session.student_id,session.student_name,'{}','[]',0,0,0,submittedAt,session.student_user_id]
      );
      await pool.query('UPDATE exam_sessions SET finished_at=$1 WHERE token=$2',[submittedAt,finishToken]);
      return res.json({submissionId,submittedAt,pdf:true});
    }

    const graded=gradeExam(exam,answers);
    const submissionId='sub_'+crypto.randomBytes(12).toString('hex');
    const publicResultToken=makeToken();

    await pool.query(
      `INSERT INTO exam_submissions(id,exam_id,session_token,student_id,student_name,answers_json,results_json,score,total,percentage,submitted_at,student_user_id,public_result_token)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [submissionId,exam.id,finishToken,session.student_id,session.student_name,JSON.stringify(answers),JSON.stringify(graded.results),graded.score,graded.total,graded.percentage,submittedAt,session.student_user_id,publicResultToken]
    );
    await pool.query('UPDATE exam_sessions SET finished_at=$1 WHERE token=$2',[submittedAt,finishToken]);

    res.json({submissionId,...graded,answers,submittedAt});
  }catch(error){
    console.error('Finish exam error:',error);
    res.status(500).json({error:'Failed to submit exam'});
  }
});

app.get('/api/exam/:id/attempts', async(req,res) => {
  try{
    const authUser=await getAuthUser(req);
    if(!authUser || authUser.role!=='student') return res.status(401).json({error:'Student account login is required.'});
    const exam=await getExam(req.params.id); if(!exam) return res.status(404).json({error:'Exam not found'});
    const {rows}=await pool.query(`SELECT s.id,s.public_result_token,s.score,s.total,s.percentage,s.submitted_at,
      ROW_NUMBER() OVER (ORDER BY s.submitted_at ASC)::int AS attempt_number
      FROM exam_submissions s JOIN exams e ON e.id=s.exam_id WHERE s.exam_id=$1 AND s.student_user_id=$2 AND e.type='template' ORDER BY s.submitted_at DESC`,[exam.id,authUser.id]);
    res.json({exam:{id:exam.id,title:exam.title,allowRetake:Boolean(exam.allow_retake),maxAttempts:exam.max_attempts===null?null:Number(exam.max_attempts)},attemptCount:rows.length,attempts:rows.map(x=>({id:x.id,attemptNumber:Number(x.attempt_number),score:Number(x.score),total:Number(x.total),percentage:Number(x.percentage),submittedAt:Number(x.submitted_at),publicResultUrl:x.public_result_token?((process.env.PUBLIC_BASE_URL||`${req.protocol}://${req.get('host')}`)+`/result/${encodeURIComponent(x.public_result_token)}`):null}))});
  }catch(err){console.error(err);res.status(500).json({error:'Could not load attempts.'});}
});

app.get('/api/exam/:id/result/:token', async(req, res) => {
  try{
    const authUser=await getAuthUser(req);
    if(!authUser || authUser.role!=='student') return res.status(401).json({error:'Student account login is required.'});
    const {rows}=await pool.query(`SELECT s.id,s.student_id,s.student_name,s.answers_json,s.results_json,s.score,s.total,s.percentage,s.submitted_at,s.student_user_id,e.type FROM exam_submissions s JOIN exams e ON e.id=s.exam_id WHERE s.exam_id=$1 AND s.session_token=$2 AND e.type='template'`,[req.params.id,req.params.token]);
    const s=rows[0]; if(!s) return res.status(404).json({error:'Result not found'});
    if(s.student_user_id && s.student_user_id!==authUser.id) return res.status(403).json({error:'This result belongs to another student account.'});
    res.json({submissionId:s.id, studentId:s.student_id, studentName:s.student_name, answers:s.answers_json, results:s.results_json, score:s.score, total:s.total, percentage:Number(s.percentage), submittedAt:Number(s.submitted_at)});
  }catch(error){console.error(error);res.status(500).json({error:'Failed to load result'});}
});

app.get('/result/:publicToken', async(req, res) => {
  try{
    const {rows}=await pool.query(`
      SELECT s.id,s.student_id,s.student_name,s.score,s.total,s.percentage,s.results_json,s.submitted_at,
             ROW_NUMBER() OVER (PARTITION BY s.student_user_id ORDER BY s.submitted_at ASC)::int AS attempt_number,
             COUNT(*) OVER (PARTITION BY s.student_user_id)::int AS attempt_count,
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
</style></head><body><main class="wrap"><section class="head"><h1>${escapeHtml(s.exam_title)}</h1><div class="muted">Shared exam result</div><div class="score">${Number(s.score)||0} / ${Number(s.total)||0}</div><div class="muted">${Number(s.percentage||0).toFixed(1)}% · Attempt ${Number(s.attempt_number)||1} of ${Number(s.attempt_count)||1} · submitted ${new Date(Number(s.submitted_at)).toLocaleString()}</div><div class="meta"><div><span>Student name</span><strong>${escapeHtml(s.student_name)}</strong></div>${emailRow}</div></section><section>${resultHtml||'<div class="q"><p>No question-level result data is available.</p></div>'}</section><div class="footer">Anyone with this link can view this shared result.</div></main></body></html>`);
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
/* PDF reading mode: the document owns the scroll, while the header floats above it. */
#app.pdf-mode{position:fixed;inset:0;min-height:100dvh;height:100dvh;padding:0;overflow:hidden;background:#f2f1ef}
#app.pdf-mode .top{position:fixed;top:14px;left:50%;z-index:20;width:min(900px,calc(100% - 28px));margin:0;transform:translateX(-50%);padding:11px 14px;background:rgba(255,255,255,.84);border:1px solid rgba(0,0,0,.1);border-radius:16px;box-shadow:0 12px 35px rgba(0,0,0,.14);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);transition:opacity .35s ease,transform .35s ease,filter .35s ease}
#app.pdf-mode .paper{width:100%;max-width:none;height:100dvh;margin:0;padding:88px 18px 60px;overflow-y:auto;overscroll-behavior:contain;border-radius:0;box-shadow:none;background:#f2f1ef}
#app.pdf-mode #paper{overflow-x:auto;overflow-y:auto;touch-action:pan-x pan-y}
#app.pdf-mode #paper canvas{display:block;width:auto;max-width:none;height:auto;margin:0 auto 22px;touch-action:pan-x pan-y}
#app.pdf-mode.pdf-reading .top{opacity:0;transform:translate(-50%,-18px);pointer-events:none}
#app.pdf-mode.pdf-reading{background:#111}
#app.pdf-mode.pdf-reading .paper{background:#111}
/* Custom PDF reader controls: hidden browser scrollbar, visible reader rail. */
#app.pdf-mode .paper{scrollbar-width:none;-ms-overflow-style:none;position:relative}
#app.pdf-mode .paper::-webkit-scrollbar{display:none}
.pdf-reader-rail{position:fixed;right:10px;top:50%;z-index:2147483000;transform:translateY(-50%);width:38px;display:flex;flex-direction:column;align-items:center;gap:8px;opacity:1;transition:opacity .35s ease;pointer-events:auto}
.pdf-bottom-page-count{position:fixed;left:16px;bottom:18px;z-index:2147483001;padding:7px 11px;border-radius:9px;background:rgba(255,255,255,.9);color:#222;font:800 12px Inter,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.16);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);opacity:1;transition:opacity .35s ease,transform .35s ease}
#app.pdf-mode.pdf-reading .pdf-bottom-page-count{opacity:0;transform:translateY(8px);pointer-events:none}
@media(max-width:650px){.pdf-bottom-page-count{left:10px;bottom:12px;font-size:11px;padding:6px 9px}}
.pdf-scroll-track{width:5px;height:min(52vh,420px);border-radius:99px;background:rgba(0,0,0,.14);position:relative}
.pdf-scroll-thumb{position:absolute;left:0;width:100%;min-height:30px;border-radius:99px;background:rgba(30,30,30,.6);transition:top .08s linear}

.pdf-zoom-controls{display:flex;flex-direction:column;gap:4px;pointer-events:auto}
.pdf-zoom-btn{width:34px;height:30px;border:1px solid rgba(0,0,0,.1);border-radius:9px;background:rgba(255,255,255,.88);color:#222;font-weight:900;font-size:16px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.12);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.pdf-zoom-btn:active{transform:scale(.95)}
#app.pdf-mode.pdf-reading .pdf-reader-rail{opacity:.88;pointer-events:auto}
#app.pdf-mode.pdf-reading .pdf-zoom-controls{pointer-events:none}
#app.pdf-mode.pdf-reading .pdf-page-count{background:rgba(30,30,30,.72);color:#fff}
#app.pdf-mode.pdf-reading .pdf-scroll-track{background:rgba(255,255,255,.18)}
#app.pdf-mode.pdf-reading .pdf-scroll-thumb{background:rgba(255,255,255,.72)}
@media(max-width:650px){
  .pdf-reader-rail{right:5px;width:31px}
  .pdf-scroll-track{height:58vh;width:4px}
  .pdf-page-count{min-width:30px;padding:4px;font-size:10px}
  .pdf-zoom-btn{width:30px;height:28px;font-size:15px}
}
#app.pdf-mode.pdf-reading .top h1{color:#fff}
#app.pdf-mode.pdf-reading .timer{background:#fff;color:#111}
@media(max-width:650px){
  #app.pdf-mode .top{top:10px;width:calc(100% - 20px);padding:9px 11px;border-radius:13px}
  #app.pdf-mode .top h1{font-size:16px}
  #app.pdf-mode .paper{padding:76px 8px 42px}
  #app.pdf-mode #paper canvas{margin-bottom:14px}
}
@media(max-width:650px){#app{padding:12px}.paper{padding:26px 18px}.top h1{font-size:18px}.score{font-size:34px}.q-text{font-size:21px}.pager-nav{grid-template-columns:1fr 1fr}.pager-count{grid-column:1/-1;grid-row:1}.pager-nav .finish{width:100%}.pager-nav #prevBtn,.pager-nav #nextBtn,.pager-nav #submitBtn{justify-self:stretch}}
</style></head><body>
<div id="portal"><div class="card"><h1>${escapeHtml(exam.title)}</h1><p id="accountPrompt">Sign in with your student account, or create one if you don't have an account yet.</p><div id="accountTabs" style="display:flex;gap:8px;margin-bottom:12px"><button type="button" id="showLogin" class="finish" style="flex:1">Sign In</button><button type="button" id="showRegister" class="finish" style="flex:1;background:#2a2927;color:#fff">Create Account</button></div><form id="accountStep" autocomplete="on"><input id="studentEmail" type="email" placeholder="Student account email" autocomplete="username"><input id="studentPassword" type="password" placeholder="Account password" autocomplete="current-password"><input id="studentName" class="register-only hidden" type="text" placeholder="Full name" autocomplete="name"><input id="studentId" class="register-only hidden" type="text" placeholder="Student ID" autocomplete="off"><button id="studentLogin" type="submit">Sign in as Student</button></form><form id="examStep" class="hidden"><div id="studentWelcome" style="margin:10px 0 16px;color:#bbb"></div><input id="pwd" type="password" placeholder="Exam password" autocomplete="off"><button id="enter" type="submit">Enter Exam</button></form><div id="err" class="err"></div></div></div>
<div id="app"><div class="top"><h1 id="examTitle"></h1><div style="display:flex;align-items:center;gap:10px"><button id="pdfSubmitBtn" class="finish hidden" type="button">Submit Exam</button><div id="timer" class="timer">--:--</div></div></div><div id="paper" class="paper"></div></div>
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
    const d=await r.json().catch(()=>({}));
    if(r.ok){
      if(!d.sessionToken) throw new Error('The server did not return a session token. Please try again.');
      session={...old, ...d, studentAuthToken, answers:old.answers||{}};
      await save({...session,examId:EXAM_ID});
      return d;
    }
    if(r.status === 410){throw new Error('This exam attempt is already finished.')}
    // If the saved session is stale/invalid, fall through and create a fresh
    // active session after verifying the exam password.
  }
  const body={deviceId:did, password:$('pwd').value};
  const r=await fetch(API+'/session', {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+studentAuthToken}, body:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||'Could not start exam');
  if(!d.sessionToken)throw new Error('The server did not return a session token. Please try again.');
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
async function submitExam(auto){if(!session)return;clearInterval(timerId);const r=await fetch(API+'/finish', {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+studentAuthToken}, body:JSON.stringify({sessionToken:session.sessionToken, answers:session.answers||{}})});const d=await r.json();if(!r.ok){if(!auto)alert(d.error||'Could not submit exam');startTimer();return false}session.finishedAt=d.submittedAt||Date.now();await save({...session, examId:EXAM_ID, finishedAt:session.finishedAt, submissionId:d.submissionId, answers:session.answers||{}});if(examData?.type==='pdf'){ $('pdfSubmitBtn').classList.add('hidden'); $('timer').style.display='none'; $('paper').innerHTML='<div class="review-head"><div style="font-size:24px;font-weight:800">Exam Submitted</div><p>Your PDF exam has been submitted and this attempt is now closed.</p></div>'; return true;}showReview(d);return true}
function showReview(d){$('timer').style.display='none';let html='<div class="review-head"><div style="font-size:24px;font-weight:800">Exam Complete</div><div class="score">'+d.score+' / '+d.total+'</div><div class="pct">'+d.percentage+'%</div><p>This attempt is now closed. You cannot retake this exam.</p></div>';d.results.forEach(r => {const cls=r.correct?'correct':r.yourAnswer === 'Unanswered'?'unanswered':'wrong';const status=r.correct?'Correct ✓':r.yourAnswer === 'Unanswered'?'Unanswered':'Wrong ✗';html+='<div class="review-item"><div class="status '+cls+'">'+status+' — Question '+r.questionNumber+'</div><div><b>'+esc(r.question)+'</b></div><div class="review-answer"><span class="review-label">Your answer:</span> '+esc(r.yourAnswer)+'</div><div class="review-answer"><span class="review-label">Correct answer:</span> '+esc(r.correctAnswer)+'</div></div>'});$('paper').innerHTML=html}
function startTimer(){clearInterval(timerId);timerId=setInterval(async() => {const left=Number(session.endAt)-Date.now();$('timer').textContent=fmt(left);if(left<=0){clearInterval(timerId);await submitExam(true)}}, 250);$('timer').textContent=fmt(Number(session.endAt)-Date.now())}
async function showExam(d){examData=d;$('portal').style.display='none';$('app').style.display='block';$('app').classList.toggle('pdf-mode',d.type==='pdf');$('app').classList.remove('pdf-reading');document.querySelector('.pdf-reader-rail')?.remove();$('examTitle').textContent=d.title||EXAM_TITLE;$('pdfSubmitBtn').classList.toggle('hidden',d.type!=='pdf');if(d.type==='pdf'){$('pdfSubmitBtn').onclick=()=>submitExam(false);setupPdfReadingMode()}if(d.type === 'template')renderTemplate();else await renderPDF(d.pdfDataUrl);startTimer()}
async function renderPDF(dataUrl){
  const paper=$('paper'); paper.innerHTML='';
  const rail=document.createElement('div'); rail.className='pdf-reader-rail';
  rail.innerHTML='<div class="pdf-bottom-page-count" id="pdfBottomPageCount">1 / 1</div><div class="pdf-scroll-track"><div class="pdf-scroll-thumb" id="pdfScrollThumb"></div></div><div class="pdf-zoom-controls"><button class="pdf-zoom-btn" id="pdfZoomIn" type="button" aria-label="Zoom in">+</button><button class="pdf-zoom-btn" id="pdfZoomOut" type="button" aria-label="Zoom out">−</button><button class="pdf-zoom-btn" id="pdfZoomReset" type="button" aria-label="Reset zoom">↺</button></div>';
  $('app').appendChild(rail);

  const pdf=await pdfjsLib.getDocument({data:atob(dataUrl.split(',')[1])}).promise;
  const renderScale=2.25;
  let zoomScale=1.35;
  const count=$('pdfBottomPageCount'), thumb=$('pdfScrollThumb');

  function updatePdfReaderPosition(){
    const maxY=paper.scrollHeight-paper.clientHeight;
    const ratioY=maxY>0?paper.scrollTop/maxY:0;
    const canvases=[...paper.querySelectorAll('canvas')];
    let page=1;
    canvases.forEach((canvas,index)=>{
      if(canvas.offsetTop <= paper.scrollTop + paper.clientHeight*.35) page=index+1;
    });
    page=Math.min(pdf.numPages,Math.max(1,page));
    count.textContent=page+' / '+pdf.numPages;
    const track=thumb.parentElement;
    const travel=Math.max(0,track.clientHeight-thumb.offsetHeight);
    thumb.style.top=(travel*ratioY)+'px';
  }

  function updateCanvasZoom(){
    const factor=zoomScale/renderScale;
    paper.querySelectorAll('canvas').forEach(canvas=>{
      const w=Number(canvas.dataset.baseWidth)||canvas.width;
      const h=Number(canvas.dataset.baseHeight)||canvas.height;
      canvas.style.width=(w*factor)+'px';
      canvas.style.height=(h*factor)+'px';
    });
    requestAnimationFrame(updatePdfReaderPosition);
  }

  function setZoom(next,anchorX=null,anchorY=null){
    const rect=paper.getBoundingClientRect();
    const oldScale=zoomScale;
    const nextScale=Math.min(3,Math.max(.7,Number(next.toFixed(2))));
    if(Math.abs(nextScale-oldScale)<.001)return;
    const x=anchorX===null?paper.clientWidth/2:anchorX-rect.left;
    const y=anchorY===null?paper.clientHeight/2:anchorY-rect.top;
    const contentX=(paper.scrollLeft+x)/oldScale;
    const contentY=(paper.scrollTop+y)/oldScale;
    zoomScale=nextScale;
    updateCanvasZoom();
    requestAnimationFrame(()=>{
      paper.scrollLeft=Math.max(0,contentX*zoomScale-x);
      paper.scrollTop=Math.max(0,contentY*zoomScale-y);
      updatePdfReaderPosition();
    });
  }

  for(let n=1;n<=pdf.numPages;n++){
    const page=await pdf.getPage(n);
    const vp=page.getViewport({scale:renderScale});
    const canvas=document.createElement('canvas');
    canvas.width=vp.width;
    canvas.height=vp.height;
    canvas.dataset.baseWidth=String(vp.width);
    canvas.dataset.baseHeight=String(vp.height);
    canvas.dataset.page=String(n);
    canvas.style.width=(vp.width*(zoomScale/renderScale))+'px';
    canvas.style.height=(vp.height*(zoomScale/renderScale))+'px';
    canvas.style.maxWidth='none';
    canvas.style.display='block';
    paper.appendChild(canvas);
    await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
  }

  paper.addEventListener('scroll',updatePdfReaderPosition,{passive:true});
  $('pdfZoomIn').onclick=()=>setZoom(zoomScale+.2);
  $('pdfZoomOut').onclick=()=>setZoom(zoomScale-.2);
  $('pdfZoomReset').onclick=()=>setZoom(1.35);

  /* Click-drag on desktop, one-finger drag on mobile, two-finger pinch zoom. */
  paper.style.touchAction='none';
  paper.style.cursor='grab';
  const pointers=new Map();
  let dragPointerId=null,dragX=0,dragY=0,dragScrollLeft=0,dragScrollTop=0;
  let pinchStartDistance=0,pinchBaseScale=zoomScale,pinchTargetScale=zoomScale;
  let pinchStartCenterX=0,pinchStartCenterY=0,pinchStartScrollLeft=0,pinchStartScrollTop=0;

  const point=e=>({x:e.clientX,y:e.clientY});
  const twoPointers=()=>{
    const v=[...pointers.values()];
    if(v.length<2)return null;
    const a=v[0],b=v[1];
    return {distance:Math.hypot(a.x-b.x,a.y-b.y),centerX:(a.x+b.x)/2,centerY:(a.y+b.y)/2};
  };

  paper.addEventListener('pointerdown',e=>{
    if(e.pointerType==='mouse'&&e.button!==0)return;
    pointers.set(e.pointerId,point(e));
    paper.setPointerCapture?.(e.pointerId);
    if(pointers.size===1){
      dragPointerId=e.pointerId; dragX=e.clientX; dragY=e.clientY;
      dragScrollLeft=paper.scrollLeft; dragScrollTop=paper.scrollTop;
      paper.style.cursor='grabbing';
    }else if(pointers.size===2){
      dragPointerId=null;
      const s=twoPointers();
      if(!s)return;
      pinchStartDistance=s.distance;
      pinchBaseScale=zoomScale;
      pinchTargetScale=zoomScale;
      pinchStartCenterX=s.centerX; pinchStartCenterY=s.centerY;
      pinchStartScrollLeft=paper.scrollLeft; pinchStartScrollTop=paper.scrollTop;
    }
  });

  paper.addEventListener('pointermove',e=>{
    if(!pointers.has(e.pointerId))return;
    pointers.set(e.pointerId,point(e));
    if(pointers.size>=2&&pinchStartDistance){
      e.preventDefault();
      const s=twoPointers();
      if(!s)return;
      pinchTargetScale=Math.min(3,Math.max(.7,pinchBaseScale*(s.distance/pinchStartDistance)));
      const rect=paper.getBoundingClientRect();
      const localX=s.centerX-rect.left, localY=s.centerY-rect.top;
      const contentX=(pinchStartScrollLeft+localX)/pinchBaseScale;
      const contentY=(pinchStartScrollTop+localY)/pinchBaseScale;
      const factor=pinchTargetScale/renderScale;
      paper.querySelectorAll('canvas').forEach(canvas=>{
        const w=Number(canvas.dataset.baseWidth),h=Number(canvas.dataset.baseHeight);
        canvas.style.width=(w*factor)+'px';
        canvas.style.height=(h*factor)+'px';
      });
      paper.scrollLeft=Math.max(0,contentX*pinchTargetScale-localX);
      paper.scrollTop=Math.max(0,contentY*pinchTargetScale-localY);
      updatePdfReaderPosition();
      return;
    }
    if(dragPointerId===e.pointerId){
      e.preventDefault();
      paper.scrollLeft=dragScrollLeft-(e.clientX-dragX);
      paper.scrollTop=dragScrollTop-(e.clientY-dragY);
      updatePdfReaderPosition();
    }
  });

  const finishPointer=e=>{
    pointers.delete(e.pointerId);
    try{paper.releasePointerCapture?.(e.pointerId)}catch(_){}
    if(pointers.size===0){
      if(pinchStartDistance){
        zoomScale=pinchTargetScale;
        pinchStartDistance=0;
        updateCanvasZoom();
      }
      dragPointerId=null;
      paper.style.cursor='grab';
    }else if(pointers.size===1){
      pinchStartDistance=0;
      const remaining=[...pointers.values()][0];
      dragPointerId=[...pointers.keys()][0];
      dragX=remaining.x; dragY=remaining.y;
      dragScrollLeft=paper.scrollLeft; dragScrollTop=paper.scrollTop;
      paper.style.cursor='grabbing';
    }
  };
  paper.addEventListener('pointerup',finishPointer);
  paper.addEventListener('pointercancel',finishPointer);

  updatePdfReaderPosition();
}
let pdfReadingTimer=null;
function setupPdfReadingMode(){
  clearTimeout(pdfReadingTimer);
  const app=$('app'), paper=$('paper');
  const wake=()=>{
    app.classList.remove('pdf-reading');
    clearTimeout(pdfReadingTimer);
    pdfReadingTimer=setTimeout(()=>app.classList.add('pdf-reading'),3500);
  };
  ['pointermove','pointerdown','touchstart','wheel','scroll','keydown'].forEach(evt=>{
    const target=evt==='scroll'?paper:window;
    target.addEventListener(evt,wake,{passive:true});
  });
  wake();
}
let pdfCloseSubmitted=false;
function submitPdfOnClose(){
  if(examData?.type!=='pdf'||!session||session.finishedAt||!studentAuthToken||pdfCloseSubmitted)return;
  pdfCloseSubmitted=true;
  const payload=JSON.stringify({sessionToken:session.sessionToken,answers:{}});
  try{fetch(API+'/finish',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json','Authorization':'Bearer '+studentAuthToken},body:payload});}catch(_){}
}
let accountMode='login';function setAccountMode(mode){accountMode=mode;$('err').textContent='';const register=mode==='register';$('studentName').classList.toggle('hidden',!register);$('studentId').classList.toggle('hidden',!register);$('studentLogin').textContent=register?'Create Student Account':'Sign in as Student';$('showLogin').style.background=register?'#2a2927':'';$('showLogin').style.color=register?'#fff':'';$('showRegister').style.background=register?'':'#2a2927';$('showRegister').style.color=register?'':'#fff';$('accountPrompt').textContent=register?'Create your student account, then enter the exam password.':'Sign in with your student account, or create one if you don’t have an account yet.';}async function loginStudent(){const btn=$('studentLogin');$('err').textContent='';btn.disabled=true;btn.textContent=accountMode==='register'?'Creating…':'Signing in…';try{const email=$('studentEmail').value.trim().toLowerCase(),password=$('studentPassword').value;if(!email||!password)throw new Error('Enter your student account email and password.');let d;if(accountMode==='register'){const name=$('studentName').value.trim(),studentId=$('studentId').value.trim();if(!name)throw new Error('Enter your full name.');if(!studentId)throw new Error('Enter your Student ID.');const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'student',email,password,displayName:name,studentId})});d=await r.json();if(!r.ok)throw new Error(d.error||'Could not create account.');}else{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});d=await r.json();if(!r.ok)throw new Error(d.error||'Could not sign in.');}if(!d.user||d.user.role!=='student')throw new Error('This is not a student account.');studentAuthToken=d.token;const old=await saved();if(old&&old.sessionToken&&!old.finishedAt){session={...old,studentAuthToken};await save({...session,examId:EXAM_ID});}$('studentWelcome').textContent='Signed in as '+(d.user.displayName||d.user.email)+(d.user.studentId?' · Student ID '+d.user.studentId:'');$('accountStep').classList.add('hidden');$('accountTabs').classList.add('hidden');$('examStep').classList.remove('hidden');$('pwd').focus();}catch(e){$('err').textContent=e.message;btn.disabled=false;btn.textContent=accountMode==='register'?'Create Student Account':'Sign in as Student'}}
async function enter(){const btn=$('enter');$('err').textContent='';btn.disabled=true;btn.textContent='Checking…';try{if(!studentAuthToken)throw new Error('Sign in to your student account first.');const d=await startSession();if(!d||!d.sessionToken||!session||!session.sessionToken)throw new Error('Could not establish an exam session. Please try again.');await showExam(d)}catch(e){console.error('Acadex exam start error:',e);$('err').textContent=e.message;btn.disabled=false;btn.textContent='Enter Exam'}}
window.addEventListener('pagehide',submitPdfOnClose);
window.addEventListener('beforeunload',submitPdfOnClose);
$('showLogin').addEventListener('click',()=>setAccountMode('login'));$('showRegister').addEventListener('click',()=>setAccountMode('register'));$('accountStep').addEventListener('submit', e => {e.preventDefault();loginStudent()});$('examStep').addEventListener('submit', e => {e.preventDefault();enter()});
(async() => {try{const old=await saved();if(old&&old.studentAuthToken&&!old.finishedAt){studentAuthToken=old.studentAuthToken;$('studentEmail').value='';}}catch(_){} $('studentEmail').focus()})();
</script></body></html>`);
});

initDatabase().then(()=>{const PORT=process.env.PORT||3000;app.listen(PORT,()=>console.log(`Exam backend listening on port ${PORT}`));}).catch(error=>{console.error('Database initialization failed:',error);process.exit(1)});






