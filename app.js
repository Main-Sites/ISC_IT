/*
 * ============================================================================
 * NOOTECH ONLINE EXAM - GITHUB PAGES FRONTEND
 * ============================================================================
 *
 * PRODUCTION FRONTEND
 * ----------------------------------------------------------------------------
 * This is the complete browser-side controller for the NOOTECH Online Exam UI.
 *
 * BACKEND FUNCTIONS USED
 * ----------------------------------------------------------------------------
 * 1. getExamHierarchy()
 * 2. createExamSession(studentName, stream, year, unit, chapter, questionCount)
 * 3. getStudentQuestionForDisplay(examID, questionNumber)
 * 4. saveStudentAnswer(examID, questionID, studentAnswer)
 * 5. submitExam(examID)
 * 6. getFinalExamResult(examID)          [fallback only]
 * 7. getDetailedExamReview(examID)
 *
 * IMPORTANT ARCHITECTURE
 * ----------------------------------------------------------------------------
 * - No spreadsheet credentials are stored here.
 * - CorrectAnswer / Explanation / ExamTip are never requested during the
 *   active examination.
 * - Exam creation response is reused instead of immediately calling
 *   getStudentExam().
 * - The expensive server-side navigator is NOT requested during startup when
 *   createExamSession() already returns the selected question list.
 * - Questions are cached in browser memory.
 * - Answer state is updated locally immediately and persisted asynchronously.
 * - Only one request is made when an answer is selected.
 * - Final scoring remains entirely server-side.
 *
 * UI REQUIREMENT
 * ----------------------------------------------------------------------------
 * This file is designed for the existing NOOTECH gaming-theme index.html.
 * It expects the existing element IDs such as:
 * startForm, studentName, stream, year, unit, chapter, questionCount,
 * examScreen, navigatorGrid, questionText, options, prevBtn, nextBtn,
 * submitTopBtn, submitModal, confirmSubmit, cancelSubmit, resultScreen,
 * scorePercent, scoreValue, correctValue, wrongValue, unattemptedValue,
 * reviewBtn, reviewList, reviewBack, restartBtn, loading, loadingText,
 * toast, startError, questionError, resultError, liveExamId, playerLabel,
 * timer, navCount and saveStatus.
 * ============================================================================
 */


/* ============================================================================
 * 1. GOOGLE APPS SCRIPT WEB APP CONFIGURATION
 * ========================================================================== */

/*
 * Production Google Apps Script Web App URL.
 *
 * IMPORTANT:
 * - Use the deployed /exec URL.
 * - Do not use /dev.
 * - Do not remove /exec.
 */
const GAS_WEB_APP_URL =
  "https://script.google.com/macros/s/AKfycbyB2peSdXKhgFg9JdmbPV-dh1GKIaqlQL58aeS-sXM_TJMLr64XUqFUsxRQK75scqhsGg/exec";


/* ============================================================================
 * 2. FRONTEND STATE
 * ========================================================================== */

const state = {

  // Current examination ID.
  examID: null,

  // Metadata returned by createExamSession().
  exam: null,

  // Currently displayed question number.
  current: 1,

  // Local answer map:
  // { QuestionID: "A" }
  answers: {},

  // Local navigator map:
  // { 1: { questionNumber, questionID, answered, studentAnswer } }
  navigator: {},

  // Browser memory cache:
  // { 1: questionObject, 2: questionObject, ... }
  questionCache: {},

  // Timer interval handle.
  timer: null,

  // Absolute end time in milliseconds.
  endTime: null,

  // Prevent duplicate submission.
  submitted: false,

  // Prevent concurrent submission.
  submitting: false,

  // Cached detailed review.
  review: null,

  // Used to ignore stale question responses.
  questionRequestId: 0,

  // Used to prevent multiple simultaneous question loads.
  navigationBusy: false
};


/* ============================================================================
 * 3. EXAM HIERARCHY STATE
 * ========================================================================== */

/*
 * Backend returns:
 *
 * streams
 * years
 * units
 * chapters
 *
 * The frontend keeps the same backend data structure internally.
 */
const hierarchy = {

  streams: [],

  yearsByStream: {},

  unitsByStreamYear: {},

  chaptersByStreamYearUnit: {}
};


/* ============================================================================
 * 4. BASIC DOM HELPERS
 * ========================================================================== */

/*
 * Short, safe DOM selector.
 */
const $ = id =>
  document.getElementById(id);


/*
 * Display one application screen.
 */
function show(id) {

  document
    .querySelectorAll(".screen")
    .forEach(screen => {

      screen.classList.remove("active");

    });


  const target =
    $(id);


  if (target) {

    target.classList.add("active");

  }

}


/*
 * Display or hide the global loading layer.
 */
function loading(
  visible,
  message = "CONNECTING…"
) {

  if ($("loadingText")) {

    $("loadingText").textContent =
      message;

  }


  if ($("loading")) {

    $("loading")
      .classList
      .toggle(
        "hidden",
        !visible
      );

  }

}


/*
 * Display an error message inside a specific element.
 */
function error(
  elementId,
  message
) {

  const element =
    $(elementId);


  if (!element) {
    return;
  }


  element.textContent =
    message || "";


  element.classList.toggle(
    "hidden",
    !message
  );

}


/*
 * Small non-blocking notification.
 */
function toast(message) {

  const element =
    $("toast");


  if (!element) {
    return;
  }


  element.textContent =
    message || "";


  element.classList.add(
    "show"
  );


  window.clearTimeout(
    toast._timer
  );


  toast._timer =
    window.setTimeout(
      () => {

        element.classList.remove(
          "show"
        );

      },
      2200
    );

}


/*
 * Small asynchronous delay used by retry logic.
 */
function sleep(milliseconds) {

  return new Promise(
    resolve => {

      window.setTimeout(
        resolve,
        milliseconds
      );

    }
  );

}


/*
 * Safely escape text before inserting it as HTML.
 */
function escapeHtml(value) {

  const text =
    String(
      value ?? ""
    );


  return text.replace(
    /[&<>"']/g,
    character => ({

      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"

    }[character])
  );

}


/* ============================================================================
 * 5. BACKEND CONFIGURATION VALIDATION
 * ========================================================================== */

/*
 * Validate only the format of the configured URL.
 *
 * IMPORTANT:
 * The previous version incorrectly compared the URL against the actual
 * production URL. That made a valid URL appear invalid.
 */
function assertConfig() {

  if (
    typeof GAS_WEB_APP_URL !== "string" ||
    GAS_WEB_APP_URL.trim() === ""
  ) {

    throw new Error(
      "GAS Web App URL is not configured in app.js."
    );

  }


  const url =
    GAS_WEB_APP_URL.trim();


  if (
    !url.startsWith("https://")
  ) {

    throw new Error(
      "Invalid GAS Web App URL. HTTPS is required."
    );

  }


  if (
    !url.startsWith(
      "https://script.google.com/macros/s/"
    )
  ) {

    throw new Error(
      "Invalid GAS Web App URL. Use the deployed Google Apps Script /exec URL."
    );

  }


  if (
    !url.endsWith("/exec")
  ) {

    throw new Error(
      "Invalid GAS Web App URL. The URL must end with /exec."
    );

  }


  return true;

}


/* ============================================================================
 * 6. BACKEND API TRANSPORT
 * ========================================================================== */

/*
 * Build the GET request expected by the Apps Script doGet(e) router.
 */
function buildApiUrl(
  functionName,
  args = []
) {

  assertConfig();


  const payload =
    encodeURIComponent(
      JSON.stringify({

        fn:
          functionName,

        args:
          Array.isArray(args)
            ? args
            : []

      })
    );


  return (
    GAS_WEB_APP_URL +
    "?action=api&payload=" +
    payload
  );

}


/*
 * Determine whether a server status is worth retrying.
 *
 * 804 is not a standard HTTP status, but it has appeared in some gateway
 * paths. If the browser receives it, a short retry is safer than failing
 * immediately.
 */
function shouldRetryStatus(status) {

  return (
    status === 804 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );

}


/*
 * Fetch with a hard timeout.
 */
async function fetchWithTimeout(
  url,
  timeoutMilliseconds
) {

  const controller =
    new AbortController();


  const timeout =
    window.setTimeout(
      () => controller.abort(),
      timeoutMilliseconds
    );


  try {

    return await fetch(
      url,
      {
        method: "GET",
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal
      }
    );

  } finally {

    window.clearTimeout(
      timeout
    );

  }

}


/*
 * Main backend communication function.
 *
 * Performance characteristics:
 * - Retries only transient failures.
 * - Does not retry ordinary validation errors.
 * - Unwraps { success:true, data:... } automatically.
 */
async function gas(
  functionName,
  args = [],
  options = {}
) {

  assertConfig();


  const maxAttempts =
    Math.max(
      1,
      Number(
        options.maxAttempts || 2
      )
    );


  const timeoutMilliseconds =
    Math.max(
      5000,
      Number(
        options.timeoutMilliseconds || 30000
      )
    );


  const url =
    buildApiUrl(
      functionName,
      args
    );


  let lastError =
    null;


  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {

    try {

      console.info(
        `NOOTECH API: ${functionName} — attempt ${attempt}/${maxAttempts}`
      );


      const response =
        await fetchWithTimeout(
          url,
          timeoutMilliseconds
        );


      if (!response.ok) {

        const statusError =
          new Error(
            `Server HTTP ${response.status}`
          );


        statusError.httpStatus =
          response.status;


        if (
          attempt < maxAttempts &&
          shouldRetryStatus(
            response.status
          )
        ) {

          await sleep(
            600 * attempt
          );

          continue;

        }


        throw statusError;

      }


      const text =
        await response.text();


      let data;


      try {

        data =
          JSON.parse(text);

      } catch (parseError) {

        const preview =
          String(text || "")
            .replace(/\s+/g, " ")
            .slice(0, 220);


        const responseError =
          new Error(
            "Server returned a non-JSON response" +
            (
              preview
                ? `: ${preview}`
                : "."
            )
          );


        responseError.cause =
          parseError;


        throw responseError;

      }


      if (
        data &&
        data.success === false
      ) {

        throw new Error(
          data.message ||
          data.error ||
          "Backend request failed."
        );

      }


      /*
       * Apps Script router normally returns:
       *
       * {
       *   success: true,
       *   data: ...
       * }
       *
       * Accept both wrapped and direct responses.
       */
      return (
        data &&
        Object.prototype.hasOwnProperty.call(
          data,
          "data"
        )
      )
        ? data.data
        : data;

    } catch (err) {

      lastError =
        err;


      const aborted =
        err &&
        err.name === "AbortError";


      const transient =
        aborted ||
        (
          err &&
          shouldRetryStatus(
            err.httpStatus
          )
        );


      if (
        attempt < maxAttempts &&
        transient
      ) {

        console.warn(
          `NOOTECH API temporary failure for ${functionName}:`,
          err
        );


        await sleep(
          600 * attempt
        );


        continue;

      }


      if (aborted) {

        throw new Error(
          `${functionName} timed out. Please try again.`
        );

      }


      throw err;

    }

  }


  throw (
    lastError ||
    new Error(
      "Backend request failed."
    )
  );

}


/* ============================================================================
 * 7. EXAM HIERARCHY / DEPENDENT DROPDOWNS
 * ========================================================================== */

/*
 * Build the exact key used by getExamHierarchy().
 */
function hierarchyKey(
  stream,
  year,
  unit
) {

  return [
    stream,
    year,
    unit
  ]
    .map(
      value =>
        String(
          value || ""
        ).trim()
    )
    .join("|||");

}


/*
 * Safely populate a SELECT element.
 */
function setOptions(
  selectId,
  values,
  placeholder,
  disabled = false
) {

  const select =
    $(selectId);


  if (!select) {
    return;
  }


  select.innerHTML =
    "";


  const first =
    document.createElement(
      "option"
    );


  first.value =
    "";


  first.textContent =
    placeholder;


  select.appendChild(
    first
  );


  const list =
    Array.isArray(values)
      ? values
      : [];


  list.forEach(
    value => {

      const option =
        document.createElement(
          "option"
        );


      option.value =
        String(value);


      option.textContent =
        String(value);


      select.appendChild(
        option
      );

    }
  );


  select.disabled =
    disabled ||
    list.length === 0;

}


/*
 * Store hierarchy in sessionStorage.
 *
 * This is only a browser optimization. It does not replace the backend.
 */
function saveHierarchyToSessionCache() {

  try {

    sessionStorage.setItem(
      "NOOTECH_EXAM_HIERARCHY_V2",
      JSON.stringify(
        hierarchy
      )
    );

  } catch (err) {

    console.warn(
      "Hierarchy cache unavailable:",
      err
    );

  }

}


/*
 * Load hierarchy from browser session cache.
 */
function loadHierarchyFromSessionCache() {

  try {

    const raw =
      sessionStorage.getItem(
        "NOOTECH_EXAM_HIERARCHY_V2"
      );


    if (!raw) {
      return false;
    }


    const cached =
      JSON.parse(raw);


    if (
      !cached ||
      !Array.isArray(
        cached.streams
      ) ||
      !cached.yearsByStream ||
      !cached.unitsByStreamYear ||
      !cached.chaptersByStreamYearUnit
    ) {

      return false;

    }


    hierarchy.streams =
      cached.streams;


    hierarchy.yearsByStream =
      cached.yearsByStream;


    hierarchy.unitsByStreamYear =
      cached.unitsByStreamYear;


    hierarchy.chaptersByStreamYearUnit =
      cached.chaptersByStreamYearUnit;


    return true;

  } catch (err) {

    console.warn(
      "Unable to read hierarchy cache:",
      err
    );


    return false;

  }

}


/*
 * Render initial dropdown state.
 */
function resetDependentDropdowns() {

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

}


/*
 * Retrieve the complete exam catalog once.
 */
async function loadExamHierarchy() {

  /*
   * FIRST: use browser session cache.
   *
   * This avoids an unnecessary Apps Script request when the student refreshes
   * or returns to the start screen during the same browser session.
   */
  if (
    loadHierarchyFromSessionCache()
  ) {

    console.info(
      "NOOTECH: Exam hierarchy loaded from session cache."
    );


    setOptions(
      "stream",
      hierarchy.streams,
      "SELECT STREAM",
      hierarchy.streams.length === 0
    );


    resetDependentDropdowns();


    return;

  }


  loading(
    true,
    "LOADING EXAM CATALOG…"
  );


  try {

    const data =
      await gas(
        "getExamHierarchy",
        [],
        {
          maxAttempts: 3,
          timeoutMilliseconds: 25000
        }
      );


    hierarchy.streams =
      Array.isArray(
        data?.streams
      )
        ? data.streams
        : [];


    hierarchy.yearsByStream =
      (
        data &&
        typeof data.years === "object"
      )
        ? data.years
        : {};


    hierarchy.unitsByStreamYear =
      (
        data &&
        typeof data.units === "object"
      )
        ? data.units
        : {};


    hierarchy.chaptersByStreamYearUnit =
      (
        data &&
        typeof data.chapters === "object"
      )
        ? data.chapters
        : {};


    if (
      hierarchy.streams.length === 0
    ) {

      throw new Error(
        "No active Stream values were returned by QUESTION_BANK."
      );

    }


    saveHierarchyToSessionCache();


    setOptions(
      "stream",
      hierarchy.streams,
      "SELECT STREAM",
      false
    );


    resetDependentDropdowns();

  } catch (err) {

    console.error(
      "getExamHierarchy failed:",
      err
    );


    error(
      "startError",
      "Unable to load Stream / Unit / Chapter list. " +
      (
        err.message ||
        "Backend request failed."
      )
    );

  } finally {

    loading(false);

  }

}


/*
 * Connect the four dependent dropdowns.
 */
function wireHierarchyDropdowns() {

  const streamSelect =
    $("stream");

  const yearSelect =
    $("year");

  const unitSelect =
    $("unit");


  if (
    !streamSelect ||
    !yearSelect ||
    !unitSelect
  ) {

    console.warn(
      "Hierarchy dropdown elements were not found."
    );


    return;

  }


  /*
   * STREAM → YEAR
   */
  streamSelect.addEventListener(
    "change",
    () => {

      const stream =
        streamSelect.value;


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

    }
  );


  /*
   * YEAR → UNIT
   */
  yearSelect.addEventListener(
    "change",
    () => {

      const stream =
        streamSelect.value;


      const year =
        yearSelect.value;


      const key =
        hierarchyKey(
          stream,
          year,
          ""
        );


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

    }
  );


  /*
   * UNIT → CHAPTER
   */
  unitSelect.addEventListener(
    "change",
    () => {

      const stream =
        streamSelect.value;


      const year =
        yearSelect.value;


      const unit =
        unitSelect.value;


      const key =
        hierarchyKey(
          stream,
          year,
          unit
        );


      setOptions(
        "chapter",
        hierarchy.chaptersByStreamYearUnit[key] || [],
        "SELECT CHAPTER",
        !stream || !year || !unit
      );

    }
  );

}


/* ============================================================================
 * 8. EXAM INITIALIZATION
 * ========================================================================== */

/*
 * Convert the backend exam response to the local format.
 *
 * Kept as a separate function so future backend additions do not require
 * changing the rest of the frontend.
 */
function normalizeExam(exam) {

  return (
    exam &&
    typeof exam === "object"
  )
    ? exam
    : {};

}


/*
 * Build the navigator directly from the question list returned by
 * createExamSession().
 *
 * This avoids the expensive getStudentQuestionNavigatorStatus() request during
 * exam startup.
 */
function initializeNavigatorFromExam(
  exam
) {

  state.navigator =
    {};


  const questions =
    Array.isArray(
      exam?.questions
    )
      ? exam.questions
      : [];


  questions.forEach(
    (question, index) => {

      const number =
        Number(
          question.questionNumber ||
          question.QuestionNumber ||
          index + 1
        );


      const questionID =
        String(
          question.questionID ||
          question.QuestionID ||
          ""
        ).trim();


      state.navigator[number] = {

        questionNumber:
          number,

        questionID:
          questionID,

        answered:
          Boolean(
            question.studentAnswer
          ),

        studentAnswer:
          question.studentAnswer ||
          ""

      };

    }
  );


  /*
   * If createExamSession() returns no question list, build a blank navigator
   * from totalQuestions. This is a safe fallback.
   */
  if (
    Object.keys(
      state.navigator
    ).length === 0
  ) {

    const total =
      Number(
        exam?.totalQuestions ||
        0
      );


    for (
      let number = 1;
      number <= total;
      number++
    ) {

      state.navigator[number] = {

        questionNumber:
          number,

        questionID:
          "",

        answered:
          false,

        studentAnswer:
          ""

      };

    }

  }


  renderNavigator(
    Number(
      exam?.totalQuestions ||
      Object.keys(
        state.navigator
      ).length ||
      0
    )
  );

}


/*
 * Start a new exam session.
 */
async function initializeExam(
  event
) {

  event.preventDefault();


  error(
    "startError",
    ""
  );


  if (
    state.submitted ||
    state.submitting
  ) {

    return;

  }


  try {

    const studentName =
      $("studentName")
        .value
        .trim();


    const stream =
      $("stream")
        .value
        .trim();


    const year =
      $("year")
        .value
        .trim();


    const unit =
      $("unit")
        .value
        .trim();


    const chapter =
      $("chapter")
        .value
        .trim();


    const questionCount =
      Number(
        $("questionCount")
          .value
      );


    if (!studentName) {

      throw new Error(
        "Student name is required."
      );

    }


    if (
      !stream ||
      !year ||
      !unit ||
      !chapter
    ) {

      throw new Error(
        "Please select Stream, Year, Unit and Chapter."
      );

    }


    if (
      !Number.isInteger(
        questionCount
      ) ||
      questionCount < 1
    ) {

      throw new Error(
        "Please enter a valid question count."
      );

    }


    loading(
      true,
      "INITIALIZING EXAM…"
    );


    /*
     * IMPORTANT PERFORMANCE DECISION:
     *
     * createExamSession() already creates:
     * - ExamID
     * - timer
     * - question records
     * - answer records
     * - selected question list
     *
     * Therefore we reuse its response.
     *
     * We do NOT call getStudentExam() here.
     */
    const result =
      await gas(
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
          timeoutMilliseconds: 35000
        }
      );


    if (
      !result ||
      !result.examID
    ) {

      throw new Error(
        "The backend did not return a valid ExamID."
      );

    }


    /*
     * Reset local examination state.
     */
    state.examID =
      result.examID;


    state.exam =
      normalizeExam(
        result
      );


    state.current =
      1;


    state.answers =
      {};


    state.questionCache =
      {};


    state.submitted =
      false;


    state.submitting =
      false;


    state.questionRequestId =
      0;


    state.navigationBusy =
      false;


    /*
     * Reuse question list from createExamSession().
     */
    initializeNavigatorFromExam(
      result
    );


    /*
     * Update exam header.
     */
    if ($("liveExamId")) {

      $("liveExamId")
        .textContent =
          result.examID;

    }


    if ($("playerLabel")) {

      $("playerLabel")
        .textContent =
          result.studentName ||
          studentName;

    }


    /*
     * Move to exam screen before loading the first question.
     */
    show(
      "examScreen"
    );


    loading(
      true,
      "LOADING QUESTION 01…"
    );


    /*
     * Only ONE question request is needed at startup.
     *
     * The navigator was already built from the createExamSession response.
     */
    await loadQuestion(
      1,
      {
        showLoading: false
      }
    );


    /*
     * Start timer only after a valid first question is available.
     */
    startTimer(
      result.endTime
    );


    loading(false);


  } catch (err) {

    console.error(
      "Exam initialization failed:",
      err
    );


    loading(false);


    error(
      "startError",
      err.message ||
      "Unable to initialize examination."
    );


    show(
      "startScreen"
    );

  }

}


/* ============================================================================
 * 9. QUESTION LOADING AND CACHE
 * ========================================================================== */

/*
 * Load one question.
 *
 * If the question was previously loaded, render it immediately from browser
 * memory without another Apps Script request.
 */
async function loadQuestion(
  questionNumber,
  options = {}
) {

  const number =
    Number(
      questionNumber
    );


  if (
    !Number.isInteger(
      number
    ) ||
    number < 1
  ) {

    throw new Error(
      "Invalid question number."
    );

  }


  const total =
    Number(
      state.exam?.totalQuestions ||
      0
    );


  if (
    total > 0 &&
    number > total
  ) {

    throw new Error(
      `Question ${number} does not exist. Total questions: ${total}.`
    );

  }


  error(
    "questionError",
    ""
  );


  /*
   * CACHE HIT:
   *
   * Render immediately.
   */
  if (
    state.questionCache[number]
  ) {

    state.current =
      number;


    renderQuestion(
      state.questionCache[number]
    );


    return (
      state.questionCache[number]
    );

  }


  const requestId =
    ++state.questionRequestId;


  if (
    options.showLoading !== false
  ) {

    loading(
      true,
      `LOADING QUESTION ${String(number).padStart(2, "0")}…`
    );

  }


  try {

    const question =
      await gas(
        "getStudentQuestionForDisplay",
        [
          state.examID,
          number
        ],
        {
          maxAttempts: 3,
          timeoutMilliseconds: 25000
        }
      );


    if (!question) {

      throw new Error(
        "Question not found."
      );

    }


    /*
     * Ignore an old response if the student has already moved elsewhere.
     */
    if (
      requestId !==
      state.questionRequestId
    ) {

      return null;

    }


    state.current =
      number;


    /*
     * Restore server-supplied student answer, if present.
     */
    const questionID =
      String(
        question.questionID ||
        question.QuestionID ||
        ""
      ).trim();


    const serverAnswer =
      String(
        question.studentAnswer ||
        ""
      ).trim().toUpperCase();


    if (questionID) {

      state.answers[questionID] =
        serverAnswer ||
        state.answers[questionID] ||
        "";

    }


    /*
     * Cache the complete safe question payload.
     */
    state.questionCache[number] =
      question;


    renderQuestion(
      question
    );


    return question;


  } catch (err) {

    console.error(
      `Question ${number} loading failed:`,
      err
    );


    error(
      "questionError",
      err.message ||
      "Question could not be loaded."
    );


    throw err;


  } finally {

    if (
      options.showLoading !== false
    ) {

      loading(false);

    }

  }

}


/*
 * Render one question.
 */
function renderQuestion(
  question
) {

  if (!question) {
    return;
  }


  const total =
    Number(
      state.exam?.totalQuestions ||
      question.totalQuestions ||
      0
    );


  const number =
    Number(
      question.questionNumber ||
      state.current ||
      1
    );


  const questionID =
    String(
      question.questionID ||
      question.QuestionID ||
      ""
    ).trim();


  if ($("questionTag")) {

    $("questionTag")
      .textContent =
        `QUESTION ${String(number).padStart(2, "0")}`;

  }


  if ($("questionMarks")) {

    const marks =
      Number(
        question.marks ??
        question.Marks ??
        1
      );


    $("questionMarks")
      .textContent =
        `${marks} MARK${marks === 1 ? "" : "S"}`;

  }


  if ($("questionProgress")) {

    $("questionProgress")
      .textContent =
        `${String(number).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;

  }


  if ($("questionText")) {

    $("questionText")
      .textContent =
        question.question ||
        question.Question ||
        "";

  }


  const options = [

    [
      "A",
      question.optionA ??
      question.OptionA ??
      ""
    ],

    [
      "B",
      question.optionB ??
      question.OptionB ??
      ""
    ],

    [
      "C",
      question.optionC ??
      question.OptionC ??
      ""
    ],

    [
      "D",
      question.optionD ??
      question.OptionD ??
      ""
    ]

  ];


  const optionsContainer =
    $("options");


  if (!optionsContainer) {
    return;
  }


  optionsContainer.innerHTML =
    "";


  const selectedAnswer =
    String(
      question.studentAnswer ||
      state.answers[questionID] ||
      ""
    ).trim().toUpperCase();


  options.forEach(
    ([key, value]) => {

      const button =
        document.createElement(
          "button"
        );


      button.type =
        "button";


      button.className =
        "option";


      if (
        selectedAnswer === key
      ) {

        button.classList.add(
          "selected"
        );

      }


      button.innerHTML =
        `<span class="key">${key}</span>` +
        `<span>${escapeHtml(value)}</span>`;


      button.addEventListener(
        "click",
        () => {

          chooseAnswer(
            question,
            key
          );

        }
      );


      optionsContainer.appendChild(
        button
      );

    }
  );


  if ($("prevBtn")) {

    $("prevBtn").disabled =
      number <= 1;

  }


  if ($("nextBtn")) {

    $("nextBtn").innerHTML =
      number >= total
        ? `FINISH REVIEW <span>→</span>`
        : `NEXT QUESTION <span>→</span>`;

  }


  state.current =
    number;


  updateNavigatorUI();

}


/* ============================================================================
 * 10. ANSWER SAVE
 * ========================================================================== */

/*
 * Save the selected answer.
 *
 * UX:
 * - Update screen immediately.
 * - Update navigator immediately.
 * - Send one backend request.
 * - Roll back only if the server rejects the save.
 *
 * IMPORTANT:
 * The frontend deliberately does NOT call validateStudentAnswer() because
 * that would add another server round trip for every click.
 *
 * Final correctness and marks are still calculated server-side during submit.
 */
async function chooseAnswer(
  question,
  selectedKey
) {

  if (
    state.submitted ||
    state.submitting
  ) {

    return;

  }


  const questionID =
    String(
      question.questionID ||
      question.QuestionID ||
      ""
    ).trim();


  if (!questionID) {

    toast(
      "Question ID is missing."
    );


    return;

  }


  const key =
    String(
      selectedKey || ""
    ).trim().toUpperCase();


  if (
    !["A", "B", "C", "D"]
      .includes(key)
  ) {

    return;

  }


  const previousAnswer =
    state.answers[questionID] ||
    "";


  /*
   * Optimistic local update.
   */
  state.answers[questionID] =
    key;


  const questionNumber =
    Number(
      question.questionNumber ||
      state.current
    );


  if (
    state.questionCache[
      questionNumber
    ]
  ) {

    state.questionCache[
      questionNumber
    ].studentAnswer =
      key;


    state.questionCache[
      questionNumber
    ].answered =
      true;

  }


  if (
    state.navigator[
      questionNumber
    ]
  ) {

    state.navigator[
      questionNumber
    ].answered =
      true;


    state.navigator[
      questionNumber
    ].studentAnswer =
      key;

  }


  renderQuestion(
    state.questionCache[
      questionNumber
    ] ||
    question
  );


  if ($("saveStatus")) {

    $("saveStatus")
      .textContent =
        "SAVING…";

  }


  try {

    await gas(
      "saveStudentAnswer",
      [
        state.examID,
        questionID,
        key
      ],
      {
        maxAttempts: 3,
        timeoutMilliseconds: 20000
      }
    );


    if ($("saveStatus")) {

      $("saveStatus")
        .textContent =
          "SAVED";

    }


    toast(
      `Answer ${key} saved`
    );


    updateNavigatorUI();


  } catch (err) {

    /*
     * Roll back only the affected answer.
     */
    state.answers[questionID] =
      previousAnswer;


    if (
      state.questionCache[
        questionNumber
      ]
    ) {

      state.questionCache[
        questionNumber
      ].studentAnswer =
        previousAnswer;


      state.questionCache[
        questionNumber
      ].answered =
        Boolean(
          previousAnswer
        );

    }


    if (
      state.navigator[
        questionNumber
      ]
    ) {

      state.navigator[
        questionNumber
      ].answered =
        Boolean(
          previousAnswer
        );


      state.navigator[
        questionNumber
      ].studentAnswer =
        previousAnswer;

    }


    renderQuestion(
      state.questionCache[
        questionNumber
      ] ||
      question
    );


    if ($("saveStatus")) {

      $("saveStatus")
        .textContent =
          "SAVE ERROR";

    }


    toast(
      err.message ||
      "Unable to save answer."
    );

  }

}


/* ============================================================================
 * 11. NAVIGATOR
 * ========================================================================== */

/*
 * Render the question navigator.
 */
function renderNavigator(
  totalQuestions
) {

  const total =
    Number(
      totalQuestions || 0
    );


  const grid =
    $("navigatorGrid");


  if (!grid) {
    return;
  }


  const answeredCount =
    Object.values(
      state.navigator
    )
      .filter(
        item =>
          item &&
          item.answered === true
      )
      .length;


  if ($("navCount")) {

    $("navCount")
      .textContent =
        `${answeredCount}/${total}`;

  }


  grid.innerHTML =
    "";


  for (
    let number = 1;
    number <= total;
    number++
  ) {

    const item =
      state.navigator[number] ||
      {

        questionNumber:
          number,

        questionID:
          "",

        answered:
          false,

        studentAnswer:
          ""

      };


    const button =
      document.createElement(
        "button"
      );


    button.type =
      "button";


    button.className =
      "nav-btn";


    if (
      item.answered
    ) {

      button.classList.add(
        "answered"
      );

    }


    if (
      number === state.current
    ) {

      button.classList.add(
        "current"
      );

    }


    button.textContent =
      String(number)
        .padStart(2, "0");


    button.addEventListener(
      "click",
      async () => {

        if (
          number === state.current
        ) {

          return;

        }


        try {

          await loadQuestion(
            number
          );

        } catch (err) {

          /*
           * loadQuestion already displayed the error.
           */

        }

      }
    );


    grid.appendChild(
      button
    );

  }

}


/*
 * Refresh navigator without contacting the server.
 */
function updateNavigatorUI() {

  const total =
    Number(
      state.exam?.totalQuestions ||
      Object.keys(
        state.navigator
      ).length ||
      0
    );


  renderNavigator(
    total
  );

}


/* ============================================================================
 * 12. PREVIOUS / NEXT NAVIGATION
 * ========================================================================== */

async function goToQuestion(
  number
) {

  const target =
    Number(number);


  if (
    !Number.isInteger(target)
  ) {

    return;

  }


  if (
    state.navigationBusy
  ) {

    return;

  }


  state.navigationBusy =
    true;


  try {

    await loadQuestion(
      target
    );

  } finally {

    state.navigationBusy =
      false;

  }

}


/*
 * Previous button.
 */
if ($("prevBtn")) {

  $("prevBtn")
    .addEventListener(
      "click",
      () => {

        if (
          state.current > 1
        ) {

          goToQuestion(
            state.current - 1
          );

        }

      }
    );

}


/*
 * Next button.
 */
if ($("nextBtn")) {

  $("nextBtn")
    .addEventListener(
      "click",
      () => {

        const total =
          Number(
            state.exam?.totalQuestions ||
            0
          );


        if (
          state.current < total
        ) {

          goToQuestion(
            state.current + 1
          );

        } else {

          openSubmitModal();

        }

      }
    );

}


/* ============================================================================
 * 13. SERVER-SYNCHRONIZED TIMER
 * ========================================================================== */

function startTimer(
  endTime
) {

  const endMilliseconds =
    new Date(
      endTime
    ).getTime();


  if (
    !Number.isFinite(
      endMilliseconds
    )
  ) {

    console.warn(
      "Invalid exam end time:",
      endTime
    );


    if ($("timer")) {

      $("timer")
        .textContent =
          "--:--";

    }


    return;

  }


  state.endTime =
    endMilliseconds;


  window.clearInterval(
    state.timer
  );


  const tick =
    async () => {

      const remaining =
        Math.max(
          0,
          state.endTime -
          Date.now()
        );


      const totalSeconds =
        Math.floor(
          remaining / 1000
        );


      const minutes =
        Math.floor(
          totalSeconds / 60
        );


      const seconds =
        totalSeconds % 60;


      if ($("timer")) {

        $("timer")
          .textContent =
            `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

      }


      if (
        remaining <= 60000 &&
        $("timer")
      ) {

        $("timer")
          .style
          .color =
            "var(--yellow)";

      }


      if (
        remaining <= 0 &&
        !state.submitted &&
        !state.submitting
      ) {

        window.clearInterval(
          state.timer
        );


        toast(
          "TIME UP — SUBMITTING"
        );


        await doSubmit(
          true
        );

      }

    };


  tick();


  state.timer =
    window.setInterval(
      tick,
      1000
    );

}


/* ============================================================================
 * 14. SUBMISSION CONFIRMATION
 * ========================================================================== */

/*
 * Open the final submission confirmation modal.
 */
function openSubmitModal() {

  const answered =
    Object.values(
      state.navigator
    )
      .filter(
        item =>
          item &&
          item.answered === true
      )
      .length;


  const total =
    Number(
      state.exam?.totalQuestions ||
      Object.keys(
        state.navigator
      ).length ||
      0
    );


  if ($("modalAnswered")) {

    $("modalAnswered")
      .textContent =
        answered;

  }


  if ($("modalUnanswered")) {

    $("modalUnanswered")
      .textContent =
        Math.max(
          0,
          total - answered
        );

  }


  if ($("submitModal")) {

    $("submitModal")
      .classList
      .remove(
        "hidden"
      );

  }

}


/*
 * Submit button from the exam header.
 */
if ($("submitTopBtn")) {

  $("submitTopBtn")
    .addEventListener(
      "click",
      openSubmitModal
    );

}


/*
 * Cancel submission.
 */
if ($("cancelSubmit")) {

  $("cancelSubmit")
    .addEventListener(
      "click",
      () => {

        $("submitModal")
          .classList
          .add(
            "hidden"
          );

      }
    );

}


/*
 * Confirm submission.
 */
if ($("confirmSubmit")) {

  $("confirmSubmit")
    .addEventListener(
      "click",
      () => {

        doSubmit(
          false
        );

      }
    );

}


/* ============================================================================
 * 15. FINAL SUBMISSION
 * ========================================================================== */

/*
 * Submit the examination.
 *
 * Only ONE server operation is required here:
 *
 * submitExam(examID)
 *
 * The backend performs the authoritative:
 * - validation
 * - evaluation
 * - score calculation
 * - percentage calculation
 * - EXAM_RECORDS update
 * - completion
 */
async function doSubmit(
  automaticSubmission = false
) {

  if (
    state.submitted ||
    state.submitting ||
    !state.examID
  ) {

    return;

  }


  state.submitting =
    true;


  if ($("submitModal")) {

    $("submitModal")
      .classList
      .add(
        "hidden"
      );

  }


  try {

    loading(
      true,
      automaticSubmission
        ? "TIME EXPIRED — SUBMITTING…"
        : "SUBMITTING EXAM…"
    );


    const result =
      await gas(
        "submitExam",
        [
          state.examID
        ],
        {
          maxAttempts: 2,
          timeoutMilliseconds: 35000
        }
      );


    state.submitted =
      true;


    window.clearInterval(
      state.timer
    );


    /*
     * submitExam() should already return the complete result.
     * Therefore showResult() does not normally make another request.
     */
    showResult(
      result
    );


    loading(false);


  } catch (err) {

    console.error(
      "Exam submission failed:",
      err
    );


    loading(false);


    state.submitting =
      false;


    toast(
      err.message ||
      "Exam submission failed. Please try again."
    );

  }

}


/* ============================================================================
 * 16. RESULT SCREEN
 * ========================================================================== */

/*
 * Normalize possible backend result shapes.
 *
 * Supported:
 * 1. Direct result object
 * 2. { summary: {...} }
 * 3. { result: {...} }
 * 4. { data: {...} }
 */
function normalizeResult(
  response
) {

  if (
    !response ||
    typeof response !== "object"
  ) {

    return {};

  }


  if (
    response.summary &&
    typeof response.summary === "object"
  ) {

    return response.summary;

  }


  if (
    response.result &&
    typeof response.result === "object"
  ) {

    return response.result;

  }


  if (
    response.data &&
    typeof response.data === "object"
  ) {

    return response.data;

  }


  return response;

}


/*
 * Display the final result.
 *
 * IMPORTANT:
 * The percentage is read from the authoritative backend result.
 * If it is unavailable, it is safely calculated from obtained/total marks.
 */
async function showResult(
  response
) {

  let result =
    normalizeResult(
      response
    );


  /*
   * Fallback only:
   *
   * If submitExam() returned no usable result, retrieve the final result.
   * This should normally NOT happen.
   */
  if (
    !result ||
    !(
      "obtainedMarks" in result
    ) ||
    !(
      "totalMarks" in result
    )
  ) {

    try {

      result =
        normalizeResult(
          await gas(
            "getFinalExamResult",
            [
              state.examID
            ],
            {
              maxAttempts: 2,
              timeoutMilliseconds: 25000
            }
          )
        );

    } catch (err) {

      console.warn(
        "Final result fallback request failed:",
        err
      );

    }

  }


  const studentName =
    result.studentName ||
    state.exam?.studentName ||
    (
      $("studentName")
        ? $("studentName").value
        : ""
    );


  const obtained =
    Number(
      result.obtainedMarks ??
      result.score ??
      0
    );


  const total =
    Number(
      result.totalMarks ??
      state.exam?.totalMarks ??
      0
    );


  let percentage =
    Number(
      result.percentage
    );


  /*
   * Backend percentage is authoritative.
   *
   * Calculation is used only when the backend did not return a finite value.
   */
  if (
    !Number.isFinite(
      percentage
    )
  ) {

    percentage =
      total > 0
        ? (
            obtained /
            total
          ) *
          100
        : 0;

  }


  percentage =
    Math.max(
      0,
      Math.min(
        100,
        percentage
      )
    );


  if ($("resultStudent")) {

    $("resultStudent")
      .textContent =
        studentName;

  }


  if ($("scorePercent")) {

    $("scorePercent")
      .textContent =
        `${Math.round(percentage)}%`;

  }


  if ($("scoreValue")) {

    $("scoreValue")
      .textContent =
        `${obtained} / ${total}`;

  }


  if ($("correctValue")) {

    $("correctValue")
      .textContent =
        Number(
          result.correct || 0
        );

  }


  if ($("wrongValue")) {

    $("wrongValue")
      .textContent =
        Number(
          result.wrong || 0
        );

  }


  if ($("unattemptedValue")) {

    $("unattemptedValue")
      .textContent =
        Number(
          result.unattempted || 0
        );

  }


  /*
   * The existing CSS uses --score for the circular result indicator.
   */
  if (
    $("scorePercent") &&
    $("scorePercent").parentElement &&
    $("scorePercent").parentElement.parentElement
  ) {

    $("scorePercent")
      .parentElement
      .parentElement
      .style
      .setProperty(
        "--score",
        `${percentage}%`
      );

  }


  /*
   * Preserve the result locally for possible review navigation.
   */
  state.exam =
    {
      ...(state.exam || {}),
      ...result
    };


  show(
    "resultScreen"
  );

}


/* ============================================================================
 * 17. DETAILED REVIEW
 * ========================================================================== */

/*
 * Load and render the completed examination review.
 */
if ($("reviewBtn")) {

  $("reviewBtn")
    .addEventListener(
      "click",
      async () => {

        if (
          !state.examID
        ) {

          toast(
            "No completed examination is available."
          );


          return;

        }


        try {

          loading(
            true,
            "BUILDING REVIEW…"
          );


          const review =
            await gas(
              "getDetailedExamReview",
              [
                state.examID
              ],
              {
                maxAttempts: 2,
                timeoutMilliseconds: 35000
              }
            );


          state.review =
            review;


          renderReview(
            review
          );


          loading(false);


          show(
            "reviewScreen"
          );


        } catch (err) {

          console.error(
            "Detailed review failed:",
            err
          );


          loading(false);


          error(
            "resultError",
            err.message ||
            "Unable to load detailed review."
          );


          toast(
            err.message ||
            "Unable to load detailed review."
          );

        }

      }
    );

}


/*
 * Render detailed review.
 *
 * CorrectAnswer is intentionally used ONLY after the backend has completed
 * the examination and explicitly authorizes detailed review.
 */
function renderReview(
  data
) {

  const rows =
    Array.isArray(data)
      ? data
      : (
          data?.questions ||
          data?.review ||
          data?.records ||
          []
        );


  const reviewList =
    $("reviewList");


  if (!reviewList) {
    return;
  }


  if (
    rows.length === 0
  ) {

    reviewList.innerHTML =
      `
        <div class="panel review-item">
          No detailed review records were returned.
        </div>
      `;


    return;

  }


  reviewList.innerHTML =
    rows
      .map(
        (record, index) => {

          const question =
            record.question ??
            record.Question ??
            "";


          const studentAnswer =
            String(
              record.studentAnswer ??
              record.StudentAnswer ??
              ""
            )
              .trim()
              .toUpperCase();


          const correctAnswer =
            String(
              record.correctAnswer ??
              record.CorrectAnswer ??
              ""
            )
              .trim()
              .toUpperCase();


          const result =
            String(
              record.result ??
              record.Result ??
              ""
            )
              .trim()
              .toUpperCase();


          const explanation =
            record.explanation ??
            record.Explanation ??
            "";


          const options = [

            [
              "A",
              record.optionA ??
              record.OptionA ??
              ""
            ],

            [
              "B",
              record.optionB ??
              record.OptionB ??
              ""
            ],

            [
              "C",
              record.optionC ??
              record.OptionC ??
              ""
            ],

            [
              "D",
              record.optionD ??
              record.OptionD ??
              ""
            ]

          ];


          return `
            <article class="review-item panel">

              <div class="review-meta">

                <span>
                  QUESTION ${String(index + 1).padStart(2, "0")}
                </span>

                <span class="review-badge">
                  ${escapeHtml(result || "REVIEW")}
                </span>

              </div>


              <div class="review-q">
                ${escapeHtml(question)}
              </div>


              <div class="review-options">

                ${options
                  .map(
                    ([key, value]) => `

                      <div class="review-option ${
                        key === correctAnswer
                          ? "correct"
                          : ""
                      } ${
                        key === studentAnswer &&
                        studentAnswer !== correctAnswer
                          ? "wrong"
                          : ""
                      }">

                        <b>${key}</b>

                        ${escapeHtml(value)}

                      </div>

                    `
                  )
                  .join("")}

              </div>


              ${
                explanation
                  ? `
                    <div class="review-explanation">
                      ${escapeHtml(explanation)}
                    </div>
                  `
                  : ""
              }

            </article>
          `;

        }
      )
      .join("");

}


/* ============================================================================
 * 18. RESULT / REVIEW NAVIGATION
 * ========================================================================== */

/*
 * Return from review to result.
 */
if ($("reviewBack")) {

  $("reviewBack")
    .addEventListener(
      "click",
      () => {

        show(
          "resultScreen"
        );

      }
    );

}


/*
 * Start a completely fresh examination.
 */
if ($("restartBtn")) {

  $("restartBtn")
    .addEventListener(
      "click",
      () => {

        /*
         * Clear only browser-side examination state.
         * Completed backend records remain untouched.
         */
        window.clearInterval(
          state.timer
        );


        state.examID =
          null;


        state.exam =
          null;


        state.current =
          1;


        state.answers =
          {};


        state.navigator =
          {};


        state.questionCache =
          {};


        state.submitted =
          false;


        state.submitting =
          false;


        state.review =
          null;


        state.questionRequestId =
          0;


        /*
         * Return to start screen.
         */
        show(
          "startScreen"
        );


        /*
         * Keep catalog available from session cache.
         */
        resetDependentDropdowns();


        setOptions(
          "stream",
          hierarchy.streams,
          "SELECT STREAM",
          hierarchy.streams.length === 0
        );


        if ($("startForm")) {

          $("startForm")
            .reset();

        }


        /*
         * Restore question count after form reset.
         */
        if ($("questionCount")) {

          $("questionCount")
            .value =
              "20";

        }


        error(
          "startError",
          ""
        );


        error(
          "resultError",
          ""
        );


        if ($("saveStatus")) {

          $("saveStatus")
            .textContent =
              "READY";

        }

      }
    );

}


/* ============================================================================
 * 19. START FORM EVENT
 * ========================================================================== */

if ($("startForm")) {

  $("startForm")
    .addEventListener(
      "submit",
      initializeExam
    );

}


/* ============================================================================
 * 20. OPTIONAL DIAGNOSTIC FUNCTION
 * ========================================================================== */

/*
 * Run this from the browser console:
 *
 *     testBackendConfiguration()
 *
 * It confirms that the browser is executing THIS app.js and using the
 * expected production Apps Script URL.
 */
function testBackendConfiguration() {

  console.log(
    "=============================================="
  );


  console.log(
    "NOOTECH BACKEND CONFIGURATION TEST"
  );


  console.log(
    "=============================================="
  );


  console.log(
    "GAS_WEB_APP_URL:",
    GAS_WEB_APP_URL
  );


  try {

    assertConfig();


    console.log(
      "Configuration: PASSED"
    );


    console.log(
      "API example:",
      buildApiUrl(
        "getExamHierarchy",
        []
      )
    );


  } catch (err) {

    console.error(
      "Configuration: FAILED",
      err
    );

  }


  console.log(
    "=============================================="
  );

}


/* ============================================================================
 * 21. APPLICATION STARTUP
 * ========================================================================== */

/*
 * EXECUTION ORDER
 * ----------------------------------------------------------------------------
 *
 * PAGE LOAD
 *   ↓
 * wireHierarchyDropdowns()
 *   ↓
 * loadExamHierarchy()
 *   ↓
 * Stream becomes available
 *   ↓
 * Student selects Stream
 *   ↓
 * Year becomes available
 *   ↓
 * Student selects Year
 *   ↓
 * Unit becomes available
 *   ↓
 * Student selects Unit
 *   ↓
 * Chapter becomes available
 *   ↓
 * Student submits Mission Config
 *   ↓
 * createExamSession()
 *   ↓
 * Navigator created locally from returned question list
 *   ↓
 * Question 1 loaded
 *   ↓
 * Timer starts
 *   ↓
 * Student answers questions
 *   ↓
 * One saveStudentAnswer() request per answer
 *   ↓
 * Cached questions load instantly when revisited
 *   ↓
 * submitExam()
 *   ↓
 * Final score / percentage displayed
 *   ↓
 * Detailed review loaded only after completion
 *
 * NO SERVER NAVIGATOR REQUEST IS REQUIRED DURING NORMAL STARTUP.
 * ============================================================================
 */

wireHierarchyDropdowns();

loadExamHierarchy();

console.info(
  "NOOTECH Online Exam frontend initialized."
);
