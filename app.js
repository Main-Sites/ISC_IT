/*
 * ============================================================================
 * NOOTECH ONLINE EXAM - GITHUB PAGES FRONTEND
 * ============================================================================
 *
 * PURPOSE
 * -------
 * This file connects the static GitHub Pages examination UI to the verified
 * NOOTECH Google Apps Script backend.
 *
 * BACKEND CONTRACT (UNCHANGED)
 * ----------------------------
 * createExamSession(studentName, stream, year, unit, chapter, numberOfQuestions)
 * getStudentExam(examID)
 * getStudentQuestionForDisplay(examID, questionNumber)
 * saveStudentAnswer(examID, questionID, studentAnswer)
 * getStudentQuestionNavigatorStatus(examID)
 * submitExam(examID)
 * getFinalExamResult(examID)
 * getDetailedExamReview(examID)
 * getExamHierarchy()
 *
 * PERFORMANCE DESIGN
 * ------------------
 * 1. Exam creation response is reused; getStudentExam() is NOT called again
 *    during normal exam startup.
 * 2. Question 1 and the navigator are requested in parallel.
 * 3. Navigator is loaded once at startup and then maintained locally.
 * 4. Previously loaded questions are cached in memory for instant navigation.
 * 5. Exam hierarchy is cached in sessionStorage to avoid unnecessary requests.
 * 6. Transient server failures are retried automatically with short backoff.
 * 7. A request timeout prevents the UI from appearing frozen indefinitely.
 * 8. Duplicate / stale question responses cannot overwrite a newer selection.
 *
 * SECURITY NOTE
 * -------------
 * The browser must never contain spreadsheet credentials or private keys.
 * Student-facing question data is expected to come from the backend's safe
 * getStudentQuestionForDisplay() function.
 * ============================================================================
 */

// ============================================================================
// 1. GOOGLE APPS SCRIPT WEB APP URL
// ============================================================================

const GAS_WEB_APP_URL =
  "https://script.google.com/macros/s/AKfycbyB2peSdXKhgFg9JdmbPV-dh1GKIaqlQL58aeS-sXM_TJMLr64XUqFUsxRQK75scqhsGg/exec";


// ============================================================================
// 2. FRONTEND STATE
// ============================================================================

const state = {
  examID: null,
  exam: null,
  current: 1,
  answers: {},
  navigator: {},
  questionCache: {},
  timer: null,
  endTime: null,
  submitted: false,
  submitting: false,
  review: null,
  questionRequestId: 0
};


// ============================================================================
// 3. SMALL DOM / UI HELPERS
// ============================================================================

const $ = id => document.getElementById(id);


const hierarchy = {
  streams: [],
  yearsByStream: {},
  unitsByStreamYear: {},
  chaptersByStreamYearUnit: {}
};


function show(id) {
  document
    .querySelectorAll(".screen")
    .forEach(x => x.classList.remove("active"));

  const target = $(id);

  if (target) {
    target.classList.add("active");
  }
}


function loading(on, msg = "CONNECTING…") {
  if ($("loadingText")) {
    $("loadingText").textContent = msg;
  }

  if ($("loading")) {
    $("loading").classList.toggle("hidden", !on);
  }
}


function error(id, msg) {
  const element = $(id);

  if (!element) {
    return;
  }

  element.textContent = msg || "";
  element.classList.toggle("hidden", !msg);
}


function toast(msg) {
  const element = $("toast");

  if (!element) {
    return;
  }

  element.textContent = msg || "";
  element.classList.add("show");

  window.clearTimeout(toast._timer);

  toast._timer = window.setTimeout(() => {
    element.classList.remove("show");
  }, 2200);
}


function assertConfig() {
  if (
    !GAS_WEB_APP_URL ||
    GAS_WEB_APP_URL.includes("https://script.google.com/macros/s/AKfycbyB2peSdXKhgFg9JdmbPV-dh1GKIaqlQL58aeS-sXM_TJMLr64XUqFUsxRQK75scqhsGg/exec")
  ) {
    throw new Error(
      "Configure GAS_WEB_APP_URL in app.js before starting the exam."
    );
  }
}


function escapeHtml(value) {
  const s = String(value ?? "");

  return s.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[character]));
}


// ============================================================================
// 4. DEPENDENT STREAM → YEAR → UNIT → CHAPTER DROPDOWNS
// ============================================================================

function hierarchyKey(stream, year, unit) {
  return [stream, year, unit]
    .map(value => String(value || "").trim())
    .join("|||");
}


function setOptions(selectId, values, placeholder, disabled = false) {
  const select = $(selectId);

  if (!select) {
    return;
  }

  select.innerHTML = "";

  const firstOption = document.createElement("option");
  firstOption.value = "";
  firstOption.textContent = placeholder;
  select.appendChild(firstOption);

  (Array.isArray(values) ? values : []).forEach(value => {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = String(value);
    select.appendChild(option);
  });

  select.disabled =
    disabled ||
    !Array.isArray(values) ||
    values.length === 0;
}


function saveHierarchyToSessionCache() {
  try {
    sessionStorage.setItem(
      "NOOTECH_EXAM_HIERARCHY_V1",
      JSON.stringify(hierarchy)
    );
  } catch (err) {
    // Session storage is optional. Never block the examination because it
    // is unavailable or restricted by the browser.
    console.warn("Hierarchy session cache unavailable:", err);
  }
}


function loadHierarchyFromSessionCache() {
  try {
    const raw = sessionStorage.getItem(
      "NOOTECH_EXAM_HIERARCHY_V1"
    );

    if (!raw) {
      return false;
    }

    const cached = JSON.parse(raw);

    if (
      !cached ||
      !Array.isArray(cached.streams) ||
      typeof cached.yearsByStream !== "object" ||
      typeof cached.unitsByStreamYear !== "object" ||
      typeof cached.chaptersByStreamYearUnit !== "object"
    ) {
      return false;
    }

    hierarchy.streams = cached.streams;
    hierarchy.yearsByStream = cached.yearsByStream || {};
    hierarchy.unitsByStreamYear = cached.unitsByStreamYear || {};
    hierarchy.chaptersByStreamYearUnit =
      cached.chaptersByStreamYearUnit || {};

    return true;
  } catch (err) {
    console.warn("Unable to read hierarchy cache:", err);
    return false;
  }
}


async function loadExamHierarchy() {

  // --------------------------------------------------------------
  // FIRST: USE THE CURRENT BROWSER SESSION CACHE
  // --------------------------------------------------------------

  if (loadHierarchyFromSessionCache()) {

    console.info("NOOTECH: Exam hierarchy loaded from session cache.");

    setOptions(
      "stream",
      hierarchy.streams,
      "SELECT STREAM",
      false
    );

    setOptions(
      "year",
      [],
      "SELECT YEAR",
      true
    );

    setOptions(
      "unit",
      [],
      "SELECT UNIT",
      true
    );

    setOptions(
      "chapter",
      [],
      "SELECT CHAPTER",
      true
    );

    return;
  }


  loading(true, "LOADING EXAM CATALOG…");

  try {

    const data = await gas("getExamHierarchy", []);

    hierarchy.streams = Array.isArray(data.streams)
      ? data.streams
      : [];

    hierarchy.yearsByStream = data.years || {};
    hierarchy.unitsByStreamYear = data.units || {};
    hierarchy.chaptersByStreamYearUnit = data.chapters || {};

    saveHierarchyToSessionCache();

    setOptions(
      "stream",
      hierarchy.streams,
      "SELECT STREAM",
      false
    );

    setOptions(
      "year",
      [],
      "SELECT YEAR",
      true
    );

    setOptions(
      "unit",
      [],
      "SELECT UNIT",
      true
    );

    setOptions(
      "chapter",
      [],
      "SELECT CHAPTER",
      true
    );

  } catch (err) {

    console.error("getExamHierarchy failed:", err);

    error(
      "startError",
      `Unable to load Stream / Unit / Chapter list. ${err.message}`
    );

  } finally {

    loading(false);

  }
}


function wireHierarchyDropdowns() {

  // --------------------------------------------------------------
  // STREAM → YEAR
  // --------------------------------------------------------------

  $("stream").addEventListener("change", () => {

    const stream = $("stream").value;

    setOptions(
      "year",
      hierarchy.yearsByStream[stream] || [],
      "SELECT YEAR",
      !stream
    );

    setOptions(
      "unit",
      [],
      "SELECT UNIT",
      true
    );

    setOptions(
      "chapter",
      [],
      "SELECT CHAPTER",
      true
    );

  });


  // --------------------------------------------------------------
  // YEAR → UNIT
  // --------------------------------------------------------------

  $("year").addEventListener("change", () => {

    const stream = $("stream").value;
    const year = $("year").value;
    const key = hierarchyKey(stream, year, "");

    setOptions(
      "unit",
      hierarchy.unitsByStreamYear[key] || [],
      "SELECT UNIT",
      !stream || !year
    );

    setOptions(
      "chapter",
      [],
      "SELECT CHAPTER",
      true
    );

  });


  // --------------------------------------------------------------
  // UNIT → CHAPTER
  // --------------------------------------------------------------

  $("unit").addEventListener("change", () => {

    const stream = $("stream").value;
    const year = $("year").value;
    const unit = $("unit").value;
    const key = hierarchyKey(stream, year, unit);

    setOptions(
      "chapter",
      hierarchy.chaptersByStreamYearUnit[key] || [],
      "SELECT CHAPTER",
      !stream || !year || !unit
    );

  });
}


// ============================================================================
// 5. BACKEND API TRANSPORT
// ============================================================================

function sleep(milliseconds) {
  return new Promise(resolve => {
    window.setTimeout(resolve, milliseconds);
  });
}


function buildApiUrl(fn, args) {
  const payload = encodeURIComponent(
    JSON.stringify({
      fn: fn,
      args: Array.isArray(args) ? args : []
    })
  );

  return `${GAS_WEB_APP_URL}?action=api&payload=${payload}`;
}


function shouldRetryStatus(status) {
  // Apps Script commonly surfaces transient gateway/server failures as
  // 5xx responses. 804 is not a standard HTTP status, but if an upstream
  // proxy presents it, retrying is safer than immediately killing the exam.
  return (
    status === 804 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}


async function fetchWithTimeout(url, timeoutMilliseconds) {

  const controller = new AbortController();

  const timeout = window.setTimeout(() => {
    controller.abort();
  }, timeoutMilliseconds);

  try {

    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: controller.signal
    });

  } finally {

    window.clearTimeout(timeout);

  }
}


async function gas(fn, args = [], options = {}) {

  assertConfig();

  const maxAttempts = Number(options.maxAttempts || 3);
  const timeoutMilliseconds = Number(
    options.timeoutMilliseconds || 25000
  );

  const url = buildApiUrl(fn, args);

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {

    try {

      console.info(
        `NOOTECH API: ${fn} — attempt ${attempt}/${maxAttempts}`
      );

      const response = await fetchWithTimeout(
        url,
        timeoutMilliseconds
      );

      if (!response.ok) {

        const statusError = new Error(
          `Server HTTP ${response.status}`
        );

        statusError.httpStatus = response.status;

        if (
          attempt < maxAttempts &&
          shouldRetryStatus(response.status)
        ) {

          await sleep(500 * attempt);
          continue;

        }

        throw statusError;
      }

      const text = await response.text();

      let data;

      try {
        data = JSON.parse(text);
      } catch (parseError) {

        const preview = String(text || "")
          .replace(/\s+/g, " ")
          .slice(0, 180);

        const responseError = new Error(
          `Server returned a non-JSON response${
            preview ? `: ${preview}` : "."
          }`
        );

        responseError.cause = parseError;
        throw responseError;
      }

      if (data && data.success === false) {
        throw new Error(
          data.message ||
          data.error ||
          "Backend request failed."
        );
      }

      return data && data.data !== undefined
        ? data.data
        : data;

    } catch (err) {

      lastError = err;

      const isAbort =
        err && err.name === "AbortError";

      const isTransient =
        isAbort ||
        (err && shouldRetryStatus(err.httpStatus));

      if (
        attempt < maxAttempts &&
        isTransient
      ) {

        console.warn(
          `NOOTECH API temporary failure for ${fn}:`,
          err
        );

        await sleep(500 * attempt);
        continue;
      }

      if (isAbort) {
        throw new Error(
          `${fn} timed out. Please check the Apps Script Web App and try again.`
        );
      }

      throw err;
    }
  }

  throw lastError || new Error("Backend request failed.");
}


// ============================================================================
// 6. EXAM INITIALIZATION
// ============================================================================

$("startForm").addEventListener("submit", async event => {

  event.preventDefault();

  error("startError", "");

  try {

    const studentName = $("studentName").value.trim();
    const stream = $("stream").value.trim();
    const year = $("year").value.trim();
    const unit = $("unit").value.trim();
    const chapter = $("chapter").value.trim();
    const questionCount = Number($("questionCount").value);

    if (!studentName) {
      throw new Error("Student name is required.");
    }

    if (!stream || !year || !unit || !chapter) {
      throw new Error(
        "Please select Stream, Year, Unit and Chapter."
      );
    }

    loading(true, "INITIALIZING EXAM…");

    // ------------------------------------------------------------
    // CREATE EXAM
    // ------------------------------------------------------------
    //
    // The verified backend already returns exam metadata including:
    // examID, endTime, totalQuestions and totalMarks.
    // Therefore we do NOT immediately call getStudentExam().
    // This removes one complete server round trip.
    // ------------------------------------------------------------

    const result = await gas(
      "createExamSession",
      [
        studentName,
        stream,
        year,
        unit,
        chapter,
        questionCount
      ],
      {
        maxAttempts: 2,
        timeoutMilliseconds: 30000
      }
    );

    if (!result || !result.examID) {
      throw new Error(
        "The backend created no valid ExamID."
      );
    }

    state.examID = result.examID;
    state.exam = normalizeExam(result);
    state.current = 1;
    state.answers = {};
    state.navigator = {};
    state.questionCache = {};
    state.submitted = false;
    state.submitting = false;
    state.questionRequestId = 0;

    $("liveExamId").textContent = state.examID;
    $("playerLabel").textContent =
      result.studentName || studentName;

    show("examScreen");

    // ------------------------------------------------------------
    // LOAD QUESTION 1 + NAVIGATOR IN PARALLEL
    // ------------------------------------------------------------

    loading(true, "LOADING QUESTION…");

    await Promise.all([
      loadQuestion(1, { showLoading: false }),
      refreshNavigator({ showLoading: false })
    ]);

    // ------------------------------------------------------------
    // START SERVER-SYNCHRONIZED TIMER
    // ------------------------------------------------------------

    startTimer(result.endTime);

    loading(false);

  } catch (err) {

    console.error("Exam initialization failed:", err);

    loading(false);

    error(
      "startError",
      err.message || "Unable to initialize examination."
    );

    show("startScreen");

  }
});


function normalizeExam(exam) {
  return exam || {};
}


// ============================================================================
// 7. QUESTION LOADING
// ============================================================================

async function loadQuestion(questionNumber, options = {}) {

  const n = Number(questionNumber);

  if (!Number.isInteger(n) || n < 1) {
    throw new Error("Invalid question number.");
  }

  error("questionError", "");

  // --------------------------------------------------------------
  // MEMORY CACHE
  // --------------------------------------------------------------

  if (state.questionCache[n]) {

    state.current = n;

    renderQuestion(
      state.questionCache[n]
    );

    return state.questionCache[n];
  }

  const requestId = ++state.questionRequestId;

  if (options.showLoading !== false) {
    loading(true, `LOADING QUESTION ${String(n).padStart(2, "0")}…`);
  }

  try {

    const q = await gas(
      "getStudentQuestionForDisplay",
      [state.examID, n],
      {
        maxAttempts: 3,
        timeoutMilliseconds: 25000
      }
    );

    if (!q) {
      throw new Error("Question not found.");
    }

    // ------------------------------------------------------------
    // IGNORE A LATE RESPONSE FROM AN OLDER REQUEST
    // ------------------------------------------------------------

    if (requestId !== state.questionRequestId) {
      return null;
    }

    state.current = n;

    state.answers[q.questionID] =
      q.studentAnswer ||
      (q.answered ? q.studentAnswer : "") ||
      state.answers[q.questionID] ||
      "";

    state.questionCache[n] = q;

    renderQuestion(q);

    return q;

  } catch (err) {

    console.error(
      `Question ${n} loading failed:`,
      err
    );

    error(
      "questionError",
      err.message || "Question could not be loaded."
    );

    throw err;

  } finally {

    if (options.showLoading !== false) {
      loading(false);
    }
  }
}


function renderQuestion(q) {

  const total = Number(
    state.exam?.totalQuestions ||
    q.totalQuestions ||
    0
  );

  const number = Number(
    q.questionNumber ||
    state.current ||
    1
  );

  $("questionTag").textContent =
    `QUESTION ${String(number).padStart(2, "0")}`;

  $("questionMarks").textContent =
    `${q.marks ?? 1} MARK${Number(q.marks) === 1 ? "" : "S"}`;

  $("questionProgress").textContent =
    `${String(number).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;

  $("questionText").textContent =
    q.question ||
    q.Question ||
    "";

  const options = [
    ["A", q.optionA ?? q.OptionA],
    ["B", q.optionB ?? q.OptionB],
    ["C", q.optionC ?? q.OptionC],
    ["D", q.optionD ?? q.OptionD]
  ];

  $("options").innerHTML = "";

  const selectedAnswer =
    q.studentAnswer ||
    state.answers[q.questionID] ||
    "";

  options.forEach(([key, value]) => {

    const button = document.createElement("button");

    button.className = "option";
    button.type = "button";

    if (selectedAnswer === key) {
      button.classList.add("selected");
    }

    button.innerHTML =
      `<span class="key">${key}</span>` +
      `<span>${escapeHtml(String(value ?? ""))}</span>`;

    button.addEventListener("click", () => {
      chooseAnswer(q, key);
    });

    $("options").appendChild(button);
  });

  $("prevBtn").disabled =
    state.current <= 1;

  $("nextBtn").textContent =
    state.current >= total
      ? "FINISH REVIEW →"
      : "NEXT QUESTION →";

  updateLocalNavigatorCurrentState();
}


// ============================================================================
// 8. ANSWER SAVE
// ============================================================================

async function chooseAnswer(q, key) {

  const previousAnswer =
    state.answers[q.questionID] ||
    "";

  state.answers[q.questionID] = key;

  // Update the cached question immediately so navigating back is instant.
  if (state.questionCache[q.questionNumber]) {
    state.questionCache[q.questionNumber].studentAnswer = key;
    state.questionCache[q.questionNumber].answered = true;
  }

  // Update local navigator immediately; no extra server request is needed.
  if (state.navigator[q.questionNumber]) {
    state.navigator[q.questionNumber].answered = true;
    state.navigator[q.questionNumber].studentAnswer = key;
  }

  renderQuestion(q);

  $("saveStatus").textContent = "SAVING…";

  try {

    await gas(
      "saveStudentAnswer",
      [state.examID, q.questionID, key],
      {
        maxAttempts: 3,
        timeoutMilliseconds: 20000
      }
    );

    $("saveStatus").textContent = "SAVED";

    toast(`Answer ${key} saved`);

    updateNavigatorUI();

  } catch (err) {

    // Revert the local state if the server rejected the answer.
    state.answers[q.questionID] = previousAnswer;

    if (state.questionCache[q.questionNumber]) {
      state.questionCache[q.questionNumber].studentAnswer =
        previousAnswer;
      state.questionCache[q.questionNumber].answered =
        Boolean(previousAnswer);
    }

    if (state.navigator[q.questionNumber]) {
      state.navigator[q.questionNumber].answered =
        Boolean(previousAnswer);
      state.navigator[q.questionNumber].studentAnswer =
        previousAnswer;
    }

    renderQuestion(q);

    $("saveStatus").textContent = "SAVE ERROR";

    toast(err.message || "Unable to save answer.");
  }
}


// ============================================================================
// 9. PREVIOUS / NEXT NAVIGATION
// ============================================================================

$("prevBtn").addEventListener("click", async () => {

  if (state.current <= 1) {
    return;
  }

  try {
    await loadQuestion(state.current - 1);
  } catch (err) {
    // loadQuestion already displays the error.
  }
});


$("nextBtn").addEventListener("click", async () => {

  const total = Number(
    state.exam?.totalQuestions ||
    0
  );

  if (state.current < total) {

    try {
      await loadQuestion(state.current + 1);
    } catch (err) {
      // loadQuestion already displays the error.
    }

  } else {

    openSubmitModal();

  }
});


// ============================================================================
// 10. QUESTION NAVIGATOR
// ============================================================================

async function refreshNavigator(options = {}) {

  if (!state.examID) {
    return;
  }

  if (options.showLoading !== false) {
    loading(true, "SYNCHRONIZING QUESTION GRID…");
  }

  try {

    const nav = await gas(
      "getStudentQuestionNavigatorStatus",
      [state.examID],
      {
        maxAttempts: 3,
        timeoutMilliseconds: 30000
      }
    );

    const items =
      nav.questions ||
      nav.navigator ||
      nav.items ||
      [];

    const total = Number(
      nav.totalQuestions ||
      state.exam?.totalQuestions ||
      items.length ||
      0
    );

    state.navigator = {};

    if (items.length) {

      items.forEach((item, index) => {

        const number = Number(
          item.questionNumber ||
          item.number ||
          index + 1
        );

        state.navigator[number] = {
          questionNumber: number,
          questionID: item.questionID || "",
          answered:
            item.answered === true ||
            Boolean(item.studentAnswer),
          studentAnswer:
            item.studentAnswer || ""
        };
      });

    } else {

      for (let number = 1; number <= total; number++) {

        state.navigator[number] = {
          questionNumber: number,
          questionID: "",
          answered: false,
          studentAnswer: ""
        };
      }
    }

    // Apply any locally saved answers that may have been made since the
    // navigator request began.
    Object.keys(state.navigator).forEach(numberKey => {

      const number = Number(numberKey);
      const item = state.navigator[number];

      if (!item) {
        return;
      }

      if (item.questionID && state.answers[item.questionID]) {
        item.answered = true;
        item.studentAnswer = state.answers[item.questionID];
      }
    });

    renderNavigator(total);

    return nav;

  } catch (err) {

    console.warn(
      "Navigator synchronization failed:",
      err
    );

    // Navigator is useful but not essential to the examination. The exam
    // continues if this one request fails.
    renderNavigator(
      Number(state.exam?.totalQuestions || 0)
    );

    return null;

  } finally {

    if (options.showLoading !== false) {
      loading(false);
    }
  }
}


function renderNavigator(total) {

  const totalQuestions = Number(total || 0);

  const answeredCount = Object.values(state.navigator)
    .filter(item => item && item.answered === true)
    .length;

  $("navCount").textContent =
    `${answeredCount}/${totalQuestions}`;

  $("navigatorGrid").innerHTML = "";

  for (let number = 1; number <= totalQuestions; number++) {

    const item = state.navigator[number] || {
      questionNumber: number,
      answered: false,
      studentAnswer: ""
    };

    const button = document.createElement("button");

    button.className = "nav-btn";

    if (item.answered) {
      button.classList.add("answered");
    }

    if (number === state.current) {
      button.classList.add("current");
    }

    button.textContent =
      String(number).padStart(2, "0");

    button.addEventListener("click", async () => {

      try {
        await loadQuestion(number);
      } catch (err) {
        // loadQuestion already displays the error.
      }
    });

    $("navigatorGrid").appendChild(button);
  }
}


function updateNavigatorUI() {

  const total = Number(
    state.exam?.totalQuestions ||
    Object.keys(state.navigator).length ||
    0
  );

  renderNavigator(total);
}


function updateLocalNavigatorCurrentState() {
  updateNavigatorUI();
}


// ============================================================================
// 11. TIMER
// ============================================================================

function startTimer(end) {

  const endMilliseconds =
    new Date(end).getTime();

  if (!Number.isFinite(endMilliseconds)) {

    console.warn(
      "Invalid exam end time:",
      end
    );

    $("timer").textContent = "--:--";
    return;
  }

  state.endTime = endMilliseconds;

  window.clearInterval(state.timer);

  const tick = async () => {

    const millisecondsRemaining =
      Math.max(
        0,
        state.endTime - Date.now()
      );

    const seconds = Math.floor(
      millisecondsRemaining / 1000
    );

    const minutes = Math.floor(
      seconds / 60
    );

    const remainingSeconds =
      seconds % 60;

    $("timer").textContent =
      `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;

    if (millisecondsRemaining <= 60000) {
      $("timer").style.color = "var(--yellow)";
    }

    if (
      millisecondsRemaining <= 0 &&
      !state.submitted &&
      !state.submitting
    ) {

      window.clearInterval(state.timer);

      toast("TIME UP — SUBMITTING");

      await doSubmit(true);
    }
  };

  tick();

  state.timer = window.setInterval(
    tick,
    1000
  );
}


// ============================================================================
// 12. SUBMIT CONFIRMATION
// ============================================================================

function openSubmitModal() {

  const answered = Object.values(state.navigator)
    .filter(item => item && item.answered === true)
    .length;

  const total = Number(
    state.exam?.totalQuestions ||
    Object.keys(state.navigator).length ||
    0
  );

  $("modalAnswered").textContent = answered;
  $("modalUnanswered").textContent =
    Math.max(0, total - answered);

  $("submitModal").classList.remove("hidden");
}


$("submitTopBtn").addEventListener("click", openSubmitModal);


$("cancelSubmit").addEventListener("click", () => {
  $("submitModal").classList.add("hidden");
});


$("confirmSubmit").addEventListener("click", () => {
  doSubmit(false);
});


// ============================================================================
// 13. SUBMISSION
// ============================================================================

async function doSubmit(auto = false) {

  if (
    state.submitted ||
    state.submitting ||
    !state.examID
  ) {
    return;
  }

  state.submitting = true;

  $("submitModal").classList.add("hidden");

  try {

    loading(
      true,
      auto
        ? "TIME EXPIRED — SUBMITTING…"
        : "SUBMITTING EXAM…"
    );

    const result = await gas(
      "submitExam",
      [state.examID],
      {
        maxAttempts: 2,
        timeoutMilliseconds: 30000
      }
    );

    state.submitted = true;

    window.clearInterval(state.timer);

    await showResult(result);

    loading(false);

  } catch (err) {

    console.error(
      "Exam submission failed:",
      err
    );

    loading(false);

    state.submitting = false;

    toast(
      err.message ||
      "Exam submission failed. Please try again."
    );

  }
}


// ============================================================================
// 14. RESULT
// ============================================================================

async function showResult(result) {

  const r =
    result ||
    await gas(
      "getFinalExamResult",
      [state.examID],
      {
        maxAttempts: 2,
        timeoutMilliseconds: 25000
      }
    );

  $("resultStudent").textContent =
    state.exam?.studentName ||
    $("studentName").value;

  const obtained = Number(
    r.obtainedMarks ??
    r.score ??
    0
  );

  const total = Number(
    r.totalMarks ??
    state.exam?.totalMarks ??
    0
  );

  const percentage = Number(
    r.percentage ??
    (total
      ? obtained / total * 100
      : 0)
  );

  $("scorePercent").textContent =
    `${Math.round(percentage)}%`;

  $("scoreValue").textContent =
    `${obtained} / ${total}`;

  $("correctValue").textContent =
    Number(r.correct || 0);

  $("wrongValue").textContent =
    Number(r.wrong || 0);

  $("unattemptedValue").textContent =
    Number(r.unattempted || 0);

  $("scorePercent")
    .parentElement
    .parentElement
    .style
    .setProperty(
      "--score",
      `${Math.max(0, Math.min(100, percentage))}%`
    );

  show("resultScreen");
}


// ============================================================================
// 15. DETAILED REVIEW
// ============================================================================

$("reviewBtn").addEventListener("click", async () => {

  try {

    loading(true, "BUILDING REVIEW…");

    const review = await gas(
      "getDetailedExamReview",
      [state.examID],
      {
        maxAttempts: 2,
        timeoutMilliseconds: 30000
      }
    );

    state.review = review;

    renderReview(review);

    loading(false);

    show("reviewScreen");

  } catch (err) {

    loading(false);

    toast(
      err.message ||
      "Unable to load detailed review."
    );
  }
});


function renderReview(data) {

  const rows =
    data.questions ||
    data.review ||
    data.records ||
    [];

  $("reviewList").innerHTML = rows
    .map((record, index) => {

      const question =
        record.question ||
        record.Question ||
        "";

      const studentAnswer =
        record.studentAnswer ||
        record.StudentAnswer ||
        "";

      const correctAnswer =
        record.correctAnswer ||
        record.CorrectAnswer ||
        "";

      const result = String(
        record.result ||
        record.Result ||
        ""
      ).toUpperCase();

      const options = [
        ["A", record.optionA ?? record.OptionA],
        ["B", record.optionB ?? record.OptionB],
        ["C", record.optionC ?? record.OptionC],
        ["D", record.optionD ?? record.OptionD]
      ];

      const explanation =
        record.explanation ||
        record.Explanation ||
        "";

      return `
        <article class="review-item panel">
          <div class="review-meta">
            <span>QUESTION ${String(index + 1).padStart(2, "0")}</span>
            <span class="review-badge">${escapeHtml(result || "REVIEW")}</span>
          </div>

          <div class="review-q">
            ${escapeHtml(question)}
          </div>

          <div class="review-options">
            ${options.map(([key, value]) => `
              <div class="review-option ${
                key === correctAnswer ? "correct" : ""
              } ${
                key === studentAnswer && studentAnswer !== correctAnswer
                  ? "wrong"
                  : ""
              }">
                <b>${key}</b>
                ${escapeHtml(String(value ?? ""))}
              </div>
            `).join("")}
          </div>

          ${explanation
            ? `<div class="review-explanation">${escapeHtml(explanation)}</div>`
            : ""
          }
        </article>
      `;
    })
    .join("") ||
    `<div class="panel review-item">No detailed review records were returned.</div>`;
}


$("reviewBack").addEventListener("click", () => {
  show("resultScreen");
});


$("restartBtn").addEventListener("click", () => {
  window.location.reload();
});


// ============================================================================
// 16. APPLICATION STARTUP
// ============================================================================
//
// Order is intentional:
//
// 1. Wire dropdown events.
// 2. Load Stream/Year/Unit/Chapter hierarchy.
//
// No examination session is created during page load.
// ============================================================================

wireHierarchyDropdowns();
loadExamHierarchy();
