/*
 NOOTECH ONLINE EXAM - GitHub Static UI
 Backend contract matches the verified Apps Script backend:
 createExamSession(studentName, stream, year, unit, chapter, numberOfQuestions)
 getStudentExam(examID)
 getStudentQuestionForDisplay(examID, questionNumber)
 saveStudentAnswer(examID, questionID, studentAnswer)
 getStudentQuestionNavigatorStatus(examID)
 submitExam(examID)
 getFinalExamResult(examID)
 getDetailedExamReview(examID)
 getExamHierarchy()
*/

// Paste the deployed Google Apps Script Web App URL here.
// Example: https://script.google.com/macros/s/DEPLOYMENT_ID/exec
const GAS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyB2peSdXKhgFg9JdmbPV-dh1GKIaqlQL58aeS-sXM_TJMLr64XUqFUsxRQK75scqhsGg/exec";

const state = {
  examID:null, exam:null, current:1, answers:{}, timer:null,
  endTime:null, submitted:false, review:null
};

const $ = id => document.getElementById(id);
const hierarchy = {
  streams: [],
  yearsByStream: {},
  unitsByStreamYear: {},
  chaptersByStreamYearUnit: {}
};

function setOptions(selectId, values, placeholder, disabled=false){
  const select = $(selectId);
  select.innerHTML = `<option value="">${placeholder}</option>`;
  (values || []).forEach(value => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
  select.disabled = disabled || !(values && values.length);
}

function hierarchyKey(stream, year, unit){
  return [stream, year, unit].map(x => String(x || "").trim()).join("|||");
}

async function loadExamHierarchy(){
  loading(true,"LOADING EXAM CATALOG…");
  try{
    const data = await gas("getExamHierarchy",[]);
    hierarchy.streams = Array.isArray(data.streams) ? data.streams : [];
    hierarchy.yearsByStream = data.yearsByStream || {};
    hierarchy.unitsByStreamYear = data.unitsByStreamYear || {};
    hierarchy.chaptersByStreamYearUnit = data.chaptersByStreamYearUnit || {};

    setOptions("stream", hierarchy.streams, "SELECT STREAM", false);
    setOptions("year", [], "SELECT YEAR", true);
    setOptions("unit", [], "SELECT UNIT", true);
    setOptions("chapter", [], "SELECT CHAPTER", true);
  }catch(err){
    error("startError", `Unable to load Stream / Unit / Chapter list. ${err.message}`);
  }finally{
    loading(false);
  }
}

function wireHierarchyDropdowns(){
  $("stream").addEventListener("change",()=>{
    const stream=$("stream").value;
    setOptions("year", hierarchy.yearsByStream[stream] || [], "SELECT YEAR", !stream);
    setOptions("unit", [], "SELECT UNIT", true);
    setOptions("chapter", [], "SELECT CHAPTER", true);
  });

  $("year").addEventListener("change",()=>{
    const stream=$("stream").value;
    const year=$("year").value;
    const key=hierarchyKey(stream,year,"");
    setOptions("unit", hierarchy.unitsByStreamYear[key] || [], "SELECT UNIT", !stream || !year);
    setOptions("chapter", [], "SELECT CHAPTER", true);
  });

  $("unit").addEventListener("change",()=>{
    const stream=$("stream").value;
    const year=$("year").value;
    const unit=$("unit").value;
    const key=hierarchyKey(stream,year,unit);
    setOptions("chapter", hierarchy.chaptersByStreamYearUnit[key] || [], "SELECT CHAPTER", !stream || !year || !unit);
  });
}

const show = id => { document.querySelectorAll(".screen").forEach(x=>x.classList.remove("active")); $(id).classList.add("active"); };
const loading = (on,msg="CONNECTING…") => { $("loadingText").textContent=msg; $("loading").classList.toggle("hidden",!on); };
const error = (id,msg) => { const e=$(id); e.textContent=msg; e.classList.toggle("hidden",!msg); };
function toast(msg){const t=$("toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200)}
function assertConfig(){if(!GAS_WEB_APP_URL || GAS_WEB_APP_URL.includes("PASTE_YOUR")) throw new Error("Configure GAS_WEB_APP_URL in app.js before starting the exam.");}

async function gas(fn,args=[]){
  assertConfig();
  // JSONP-style GET avoids CORS restrictions on GitHub Pages.
  // The Apps Script deployment must expose a doGet(e) router.
  const payload = encodeURIComponent(JSON.stringify({fn,args}));
  const url = `${GAS_WEB_APP_URL}?action=api&payload=${payload}`;
  const r = await fetch(url,{method:"GET",redirect:"follow"});
  if(!r.ok) throw new Error(`Server HTTP ${r.status}`);
  const text = await r.text();
  let data;
  try { data=JSON.parse(text); } catch { throw new Error("Server returned a non-JSON response. Check the Apps Script Web App deployment."); }
  if(data && data.success===false) throw new Error(data.message || data.error || "Backend request failed.");
  return data && data.data !== undefined ? data.data : data;
}

function normalizeExam(exam){
  return exam || {};
}

wireHierarchyDropdowns();
loadExamHierarchy();

$("startForm").addEventListener("submit",async e=>{
  e.preventDefault(); error("startError","");
  try{
    loading(true,"INITIALIZING EXAM…");
    const result=await gas("createExamSession",[
      $("studentName").value.trim(),$("stream").value.trim(),$("year").value.trim(),
      $("unit").value.trim(),$("chapter").value.trim(),Number($("questionCount").value)
    ]);
    state.examID=result.examID;
    state.exam=normalizeExam(result);
    state.current=1;
    $("liveExamId").textContent=state.examID;
    $("playerLabel").textContent=result.studentName || $("studentName").value.trim();
    show("examScreen");
    await loadExam();
    startTimer(result.endTime);
    loading(false);
  }catch(err){loading(false);error("startError",err.message)}
});

async function loadExam(){
  try{
    loading(true,"LOADING QUESTION…");
    const exam=await gas("getStudentExam",[state.examID]);
    state.exam=normalizeExam(exam);
    const total=Number(state.exam.totalQuestions || state.exam.questions?.length || 0);
    $("questionProgress").textContent=`${String(state.current).padStart(2,"0")} / ${String(total).padStart(2,"0")}`;
    await loadQuestion(state.current);
    await refreshNavigator();
    loading(false);
  }catch(err){loading(false);error("questionError",err.message)}
}

async function loadQuestion(n){
  error("questionError","");
  try{
    const q=await gas("getStudentQuestionForDisplay",[state.examID,n]);
    if(!q) throw new Error("Question not found.");
    state.current=n;
    state.answers[q.questionID]=q.studentAnswer || state.answers[q.questionID] || "";
    renderQuestion(q);
    await refreshNavigator();
  }catch(err){error("questionError",err.message)}
}

function renderQuestion(q){
  const total=Number(state.exam?.totalQuestions || q.totalQuestions || 0);
  $("questionTag").textContent=`QUESTION ${String(q.questionNumber||state.current).padStart(2,"0")}`;
  $("questionMarks").textContent=`${q.marks ?? 1} MARK${Number(q.marks)==1?"":"S"}`;
  $("questionProgress").textContent=`${String(q.questionNumber||state.current).padStart(2,"0")} / ${String(total).padStart(2,"0")}`;
  $("questionText").textContent=q.question || q.Question || "";
  const options=[
    ["A",q.optionA ?? q.OptionA],["B",q.optionB ?? q.OptionB],
    ["C",q.optionC ?? q.OptionC],["D",q.optionD ?? q.OptionD]
  ];
  $("options").innerHTML="";
  options.forEach(([key,val])=>{
    const b=document.createElement("button"); b.className="option"; b.type="button";
    if((q.studentAnswer||state.answers[q.questionID])===key) b.classList.add("selected");
    b.innerHTML=`<span class="key">${key}</span><span>${escapeHtml(String(val??""))}</span>`;
    b.onclick=()=>chooseAnswer(q,key); $("options").appendChild(b);
  });
  $("prevBtn").disabled=(state.current<=1);
  $("nextBtn").textContent=state.current>=total?"FINISH REVIEW →":"NEXT QUESTION →";
}

async function chooseAnswer(q,key){
  state.answers[q.questionID]=key;
  document.querySelectorAll(".option").forEach(x=>x.classList.remove("selected"));
  [...document.querySelectorAll(".option")][["A","B","C","D"].indexOf(key)]?.classList.add("selected");
  $("saveStatus").textContent="SAVING…";
  try{
    await gas("saveStudentAnswer",[state.examID,q.questionID,key]);
    $("saveStatus").textContent="SAVED";
    toast(`Answer ${key} saved`);
    await refreshNavigator();
  }catch(err){$("saveStatus").textContent="SAVE ERROR";toast(err.message)}
}

$("prevBtn").onclick=()=>{if(state.current>1)loadQuestion(state.current-1)};
$("nextBtn").onclick=async()=>{
  const total=Number(state.exam?.totalQuestions || 0);
  if(state.current<total) await loadQuestion(state.current+1);
  else openSubmitModal();
};

async function refreshNavigator(){
  try{
    const nav=await gas("getStudentQuestionNavigatorStatus",[state.examID]);
    const items=nav.questions || nav.navigator || nav.items || [];
    const total=Number(nav.totalQuestions || state.exam?.totalQuestions || items.length || 0);
    $("navCount").textContent=`${Object.values(state.answers).filter(Boolean).length}/${total}`;
    $("navigatorGrid").innerHTML="";
    if(items.length){
      items.forEach((item,i)=>{
        const n=Number(item.questionNumber||item.number||i+1);
        const b=document.createElement("button"); b.className="nav-btn";
        if(item.answered || state.answers[item.questionID]) b.classList.add("answered");
        if(n===state.current) b.classList.add("current");
        b.textContent=String(n).padStart(2,"0"); b.onclick=()=>loadQuestion(n); $("navigatorGrid").appendChild(b);
      });
    }else{
      for(let i=1;i<=total;i++){const b=document.createElement("button");b.className="nav-btn";if(i===state.current)b.classList.add("current");if(Object.values(state.answers)[i-1])b.classList.add("answered");b.textContent=String(i).padStart(2,"0");b.onclick=()=>loadQuestion(i);$("navigatorGrid").appendChild(b)}
    }
  }catch(err){/* Navigator failure must not destroy the exam. */ }
}

function startTimer(end){
  state.endTime=new Date(end).getTime();
  clearInterval(state.timer);
  const tick=async()=>{
    const ms=Math.max(0,state.endTime-Date.now());
    const sec=Math.floor(ms/1000),m=Math.floor(sec/60),s=sec%60;
    $("timer").textContent=`${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
    if(ms<=60000)$("timer").style.color="var(--yellow)";
    if(ms<=0){clearInterval(state.timer);toast("TIME UP — SUBMITTING");await doSubmit(true)}
  };
  tick();state.timer=setInterval(tick,1000);
}

function openSubmitModal(){
  const answered=Object.values(state.answers).filter(Boolean).length;
  const total=Number(state.exam?.totalQuestions||0);
  $("modalAnswered").textContent=answered;$("modalUnanswered").textContent=Math.max(0,total-answered);
  $("submitModal").classList.remove("hidden");
}
$("submitTopBtn").onclick=openSubmitModal;$("cancelSubmit").onclick=()=>$("submitModal").classList.add("hidden");
$("confirmSubmit").onclick=()=>doSubmit(false);

async function doSubmit(auto=false){
  if(state.submitted)return;
  $("submitModal").classList.add("hidden");
  try{
    loading(true,auto?"TIME EXPIRED — SUBMITTING…":"SUBMITTING EXAM…");
    const result=await gas("submitExam",[state.examID]);
    state.submitted=true;clearInterval(state.timer);
    await showResult(result);
    loading(false);
  }catch(err){loading(false);toast(err.message)}
}

async function showResult(result){
  const r=result || await gas("getFinalExamResult",[state.examID]);
  $("resultStudent").textContent=state.exam?.studentName || $("studentName").value;
  const obtained=Number(r.obtainedMarks ?? r.score ?? 0), total=Number(r.totalMarks ?? state.exam?.totalMarks ?? 0);
  const pct=Number(r.percentage ?? (total?obtained/total*100:0));
  $("scorePercent").textContent=`${Math.round(pct)}%`;$("scoreValue").textContent=`${obtained} / ${total}`;
  $("correctValue").textContent=Number(r.correct||0);$("wrongValue").textContent=Number(r.wrong||0);$("unattemptedValue").textContent=Number(r.unattempted||0);
  $("scorePercent").parentElement.parentElement.style.setProperty("--score",`${Math.max(0,Math.min(100,pct))}%`);
  show("resultScreen");
}

$("reviewBtn").onclick=async()=>{
  try{loading(true,"BUILDING REVIEW…");const r=await gas("getDetailedExamReview",[state.examID]);state.review=r;renderReview(r);loading(false);show("reviewScreen")}
  catch(err){loading(false);toast(err.message)}
};
function renderReview(data){
  const rows=data.questions||data.review||data.records||[];
  $("reviewList").innerHTML=rows.map((r,i)=>{
    const q=r.question||r.Question||"";const ans=r.studentAnswer||r.StudentAnswer||"";const correct=r.correctAnswer||r.CorrectAnswer||"";
    const result=String(r.result||r.Result||"").toUpperCase();const opts=[["A",r.optionA||r.OptionA],["B",r.optionB||r.OptionB],["C",r.optionC||r.OptionC],["D",r.optionD||r.OptionD]];
    return `<article class="review-item panel"><div class="review-meta"><span>QUESTION ${String(i+1).padStart(2,"0")}</span><span class="review-badge">${escapeHtml(result||"REVIEW")}</span></div><div class="review-q">${escapeHtml(q)}</div><div class="review-options">${opts.map(([k,v])=>`<div class="review-option ${k===correct?"correct":""} ${k===ans&&ans!==correct?"wrong":""}"><b>${k}</b> ${escapeHtml(String(v??""))}</div>`).join("")}</div>${r.explanation||r.Explanation?`<div class="review-explanation">${escapeHtml(r.explanation||r.Explanation)}</div>`:""}</article>`
  }).join("") || `<div class="panel review-item">No detailed review records were returned.</div>`;
}
$("reviewBack").onclick=()=>show("resultScreen");
$("restartBtn").onclick=()=>location.reload();

function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
