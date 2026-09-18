    const authUser=await getAuthUser(req);
    if(!authUser || authUser.role!=='student') return res.status(401).json({error:'Student account login is required.'});
    const token=typeof req.body?.sessionToken === 'string'?req.body.sessionToken.trim():'';
    if(!token) return res.status(400).json({error:'sessionToken is required'});
    const existing=await pool.query(`SELECT id,score,total,percentage,answers_json,results_json,submitted_at FROM exam_submissions WHERE session_token=$1 AND exam_id=$2`,[token,exam.id]);
    if(existing.rows[0]){
      const s=existing.rows[0];
      return res.json({submissionId:s.id, score:s.score, total:s.total, percentage:Number(s.percentage), answers:s.answers_json, results:s.results_json, submittedAt:Number(s.submitted_at)});
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
    await pool.query(`INSERT INTO exam_submissions(id,exam_id,session_token,student_id,student_name,answers_json,results_json,score,total,percentage,submitted_at,student_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[submissionId,exam.id,token,session.student_id,session.student_name,JSON.stringify(answers),JSON.stringify(graded.results),graded.score,graded.total,graded.percentage,submittedAt,session.student_user_id||null]);
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

app.get('/exam/:id', async(req, res) => {
  const exam=await getExam(req.params.id); if(!exam) return res.status(404).send('Exam not found');
  const safeId=JSON.stringify(exam.id), safeTitle=JSON.stringify(exam.title);
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(exam.title)}</title>
<style>
*{box-sizing:border-box}html, body{margin:0;min-height:100%;font-family:system-ui, -apple-system, "Segoe UI", sans-serif;background:#0d0c0b;color:#f0ece4}.hidden{display:none!important}
#portal{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0908;padding:24px}.card{width:min(450px, 100%);padding:34px 30px;background:#181614;border:1px solid #ffffff18;border-radius:20px;text-align:center;box-shadow:0 24px 64px #0008}.card h1{margin:0 0 8px}.card p{color:#aaa;line-height:1.5}.card input{width:100%;padding:13px;margin:7px 0;border:1px solid #ffffff22;border-radius:10px;background:#0e0d0c;color:#fff;font-size:16px}.card button, .finish{border:0;border-radius:10px;padding:13px 18px;font-size:16px;font-weight:700;cursor:pointer;background:#f0ece4;color:#111}.card button{width:100%;margin-top:10px}.err{color:#ff7b7b;min-height:22px;margin-top:10px}
#app{display:none;min-height:100vh;background:#f2f1ef;color:#171615;padding:24px}.top{max-width:900px;margin:0 auto 18px;display:flex;align-items:center;justify-content:space-between;gap:16px}.top h1{margin:0;font-size:24px}.timer{font-weight:800;background:#171615;color:#fff;padding:10px 14px;border-radius:10px}.paper{max-width:900px;margin:0 auto;background:#fff;color:#181716;padding:42px 52px;border-radius:5px;box-shadow:0 10px 35px #0001}.paper-title{text-align:center;font-size:25px;font-weight:800;margin-bottom:34px}.question-page{display:none}.question-page.active{display:block}.q{margin:0;padding-bottom:22px}.q-text{font-size:25px;line-height:1.45;font-weight:600;margin-bottom:28px;white-space:pre-wrap}.q-num{font-weight:700;font-size:14px;line-height:1.5;margin-bottom:12px;color:#777;text-transform:uppercase;letter-spacing:.06em}.answer-option{display:flex;align-items:center;gap:12px;padding:13px 15px;margin:8px 0;border:1px solid #ddd;border-radius:10px;cursor:pointer;transition:.15s ease;background:#fff}.answer-option:hover{background:#f5f5f5}.answer-option input{width:18px;height:18px;cursor:pointer;flex:none}.answer-option span{cursor:pointer;flex:1}.review-head{text-align:center;border-bottom:1px solid #eee;padding-bottom:28px;margin-bottom:28px}.score{font-size:42px;font-weight:900}.pct{font-size:18px;color:#666}.review-item{padding:20px 0;border-bottom:1px solid #eee}.status{font-weight:800;margin-bottom:8px}.correct{color:#137333}.wrong{color:#b3261e}.unanswered{color:#666}.review-label{font-weight:700}.review-answer{margin:5px 0 10px;color:#444}.pager-nav{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:14px;margin-top:28px}.pager-nav .finish{width:auto}.pager-nav .finish:last-child{justify-self:end}.pager-count{text-align:center;color:#666;font-weight:700;font-size:13px}
@media(max-width:650px){#app{padding:12px}.paper{padding:26px 18px}.top h1{font-size:18px}.score{font-size:34px}.q-text{font-size:21px}.pager-nav{grid-template-columns:1fr 1fr;}.pager-count{grid-column:1/-1;grid-row:1}.pager-nav .finish{width:100%}.pager-nav #nextBtn,.pager-nav #submitBtn{justify-self:stretch}}
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