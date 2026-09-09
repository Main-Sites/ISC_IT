# NOOTECH Gaming Exam UI

A responsive, gaming-inspired student examination frontend designed for GitHub Pages and backed by the verified NOOTECH Google Apps Script backend.

## Backend functions used

The UI is aligned with the currently verified backend functions:

- `createExamSession(studentName, stream, year, unit, chapter, numberOfQuestions)`
- `getStudentExam(examID)`
- `getStudentQuestionForDisplay(examID, questionNumber)`
- `saveStudentAnswer(examID, questionID, studentAnswer)`
- `getStudentQuestionNavigatorStatus(examID)`
- `submitExam(examID)`
- `getFinalExamResult(examID)`
- `getDetailedExamReview(examID)`

## Included examination features

1. Start/create exam
2. Secure question delivery
3. Four-option MCQ interface
4. Server-backed answer save
5. Previous/Next navigation
6. Question navigator
7. Answered/unanswered/current indicators
8. Live timer
9. Auto-save status
10. Submit confirmation
11. Auto-submit on timer expiry
12. Final result
13. Detailed review
14. Responsive mobile/tablet/desktop design
15. Loading and error states
16. GitHub Pages-ready static files

## Important backend integration

The frontend needs a small `doGet(e)` API router in the Apps Script web app. The existing backend functions are server-side Apps Script functions and cannot be called directly from a normal GitHub static page.

The frontend calls:

`YOUR_GAS_WEB_APP_URL?action=api&payload=<encoded JSON>`

where the payload is:

```json
{"fn":"createExamSession","args":["Student","Science","2026","Unit 1","Chapter 1",20]}
```

Your Apps Script `doGet(e)` should validate the requested function against an allow-list and call it server-side.

### Example router to add to Apps Script

```javascript
function doGet(e) {
  try {
    if (!e || !e.parameter || e.parameter.action !== 'api') {
      return jsonOutput({success:true, message:'NOOTECH ONLINE EXAM API ONLINE'});
    }

    const payload = JSON.parse(
      decodeURIComponent(e.parameter.payload || '{}')
    );

    const allowed = {
      createExamSession: createExamSession,
      getStudentExam: getStudentExam,
      getStudentQuestionForDisplay: getStudentQuestionForDisplay,
      saveStudentAnswer: saveStudentAnswer,
      getStudentQuestionNavigatorStatus: getStudentQuestionNavigatorStatus,
      submitExam: submitExam,
      getFinalExamResult: getFinalExamResult,
      getDetailedExamReview: getDetailedExamReview
    };

    if (!allowed[payload.fn]) {
      throw new Error('API function not allowed: ' + payload.fn);
    }

    const result = allowed[payload.fn].apply(
      null,
      Array.isArray(payload.args) ? payload.args : []
    );

    return jsonOutput({
      success: true,
      data: result
    });

  } catch (err) {
    return jsonOutput({
      success: false,
      message: err.message || String(err)
    });
  }
}

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

**Do not paste this router into the backend until the backend baseline has been backed up.** It is an integration layer, not a replacement for the verified backend.

## GitHub Pages setup

1. Create a GitHub repository.
2. Upload:
   - `index.html`
   - `styles.css`
   - `app.js`
3. In `app.js`, replace:

```javascript
const GAS_WEB_APP_URL = "PASTE_YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE";
```

with the deployed Apps Script Web App `/exec` URL.
4. Enable GitHub Pages from the repository's Pages settings.
5. Open the published site.

## Recommended deployment order

**Backend verified → add API router → deploy Apps Script as Web App → test API URL → configure `app.js` → publish GitHub Pages.**

Do not expose spreadsheet IDs, service-account keys, passwords, or other secrets in this repository.


## Footer
The UI now includes a responsive theme-matched footer with main-site navigation, contact links, social connection buttons, system status, and a separate copyright bar. Replace the placeholder `#` URLs and contact details in `index.html` with the official NOOTECH links before production.


## Backend hierarchy contract

The UI expects the Apps Script `getExamHierarchy()` response in this verified form:

- `streams`: array of stream names
- `years`: object keyed by stream
- `units`: object keyed by `STREAM|||YEAR|||`
- `chapters`: object keyed by `STREAM|||YEAR|||UNIT`

The current `app.js` maps these backend keys directly into the dependent Stream → Year → Unit → Chapter dropdowns.
