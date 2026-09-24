/**
 * EduVault — Quiz & Feedback PRIMARY storage on the teacher's Google Drive.
 *
 * PostgreSQL holds only metadata/authorization references (quiz_id, emp_id,
 * status, deadline, drive file ids, submission receipts, HMAC tokens).
 * Actual questions, options, answers, results, feedback forms, responses
 * and reports live in THAT teacher's Drive under:
 *
 *   EduVault/Quizzes/<Quiz Name>/
 *     quiz.json
 *     submissions/<id>.json
 *     results.json
 *     results.csv
 *
 *   EduVault/Feedback/<Form Name>/
 *     feedback-form.json
 *     responses.json
 *     report.csv
 *
 * Ownership is always resolved from authenticated emp_id + DB — never from
 * client-supplied folder/file ids alone.
 */

const gdrive = require("./googleDrive");

function driveUnavailable(err) {
  const e = new Error(
    err && err.message
      ? err.message
      : "Google Drive is unavailable. Connect Google Drive and try again."
  );
  e.code = "DRIVE_UNAVAILABLE";
  e.status = 503;
  return e;
}

/**
 * Resolve a valid access token for emp_id using DB teacher_google_drive row.
 * @param {object} db - db module with getTeacherGoogleDrive + updateTeacherGoogleDriveTokens
 */
async function getTeacherAccessToken(db, emp_id) {
  // Same path as Materials (routes/materials.js):
  //   const driveRow = await db.getTeacherGoogleDrive(emp_id);
  //   const { accessToken } = await gdrive.getValidAccessToken(driveRow, db);
  const row = await db.getTeacherGoogleDrive(emp_id);
  if (!row || !row.refresh_token_enc) {
    const e = new Error("Google Drive is not connected. Please reconnect Google Drive.");
    e.status = 400;
    e.code = "DRIVE_NOT_CONNECTED";
    throw e;
  }
  try {
    const tok = await gdrive.getValidAccessToken(row, db);
    // getValidAccessToken returns { accessToken, row } — NOT a bare string.
    // Materials destructures .accessToken; Quiz/Feedback must do the same.
    const accessToken = tok && tok.accessToken;
    if (!accessToken || typeof accessToken !== "string") {
      throw new Error("Could not obtain a valid Google Drive access token. Reconnect Google Drive.");
    }
    return accessToken;
  } catch (err) {
    if (err && err.code === "DRIVE_NOT_CONNECTED") throw err;
    throw driveUnavailable(err);
  }
}

/**
 * Ensure full EduVault tree including Quizzes + Feedback; persist folder ids if columns exist.
 */
async function ensureTeacherDriveTree(db, emp_id) {
  const accessToken = await getTeacherAccessToken(db, emp_id);
  let folders;
  try {
    folders = await gdrive.ensureEduVaultFolders(accessToken);
  } catch (err) {
    throw driveUnavailable(err);
  }
  try {
    if (typeof db.updateTeacherGoogleDriveFolders === "function") {
      await db.updateTeacherGoogleDriveFolders(emp_id, folders);
    }
  } catch (_) {
    /* older schema without quizzes_folder columns is fine */
  }
  return { accessToken, folders };
}

function safeFolderName(title, fallback) {
  return gdrive.sanitizeDriveName(title || fallback, fallback);
}

// ---------------------------------------------------------------------------
// QUIZ — Drive primary
// ---------------------------------------------------------------------------

/**
 * Create quiz folder + quiz.json on teacher's Drive.
 * Returns { drive_folder_id, drive_quiz_file_id, quizPayload }
 */
async function driveCreateQuiz(db, emp_id, quizMeta) {
  const { accessToken, folders } = await ensureTeacherDriveTree(db, emp_id);
  const quizzesRoot = folders.quizzes_folder_id;
  if (!quizzesRoot) throw driveUnavailable(new Error("Quizzes folder missing"));

  const folderName = safeFolderName(quizMeta.title, "Quiz");
  let quizFolder;
  try {
    quizFolder = await gdrive.ensureFolder(accessToken, folderName, quizzesRoot);
  } catch (err) {
    throw driveUnavailable(err);
  }

  // Never include correct answers at create time
  const questions = (quizMeta.questions || []).map((q, i) => ({
    question_id: q.question_id || null,
    question_text: q.question_text,
    marks: q.marks || 1,
    display_order: i,
    options: (q.options || []).slice(0, 4).map((o, j) => ({
      option_id: o.option_id || null,
      option_text: typeof o === "string" ? o : o.option_text || o.text || "",
      display_order: j,
    })),
    // correct_option_id intentionally omitted
  }));

  const quizPayload = {
    quiz_id: quizMeta.quiz_id,
    emp_id: emp_id,
    title: quizMeta.title,
    subject: quizMeta.subject || null,
    class_label: quizMeta.class_label || null,
    instructions: quizMeta.instructions || null,
    deadline: quizMeta.deadline || null,
    status: quizMeta.status || "draft",
    results_published: false,
    evaluated_at: null,
    questions,
    updated_at: new Date().toISOString(),
  };

  let file;
  try {
    file = await gdrive.upsertJsonFile(accessToken, {
      filename: "quiz.json",
      parentFolderId: quizFolder.id,
      data: quizPayload,
    });
  } catch (err) {
    throw driveUnavailable(err);
  }

  return {
    drive_folder_id: quizFolder.id,
    drive_quiz_file_id: file.id,
    quizPayload,
    accessToken,
  };
}

async function driveReadQuiz(db, emp_id, drive_quiz_file_id) {
  if (!drive_quiz_file_id) {
    const e = new Error("Quiz Drive file is missing. Recreate the quiz after connecting Google Drive.");
    e.status = 400;
    throw e;
  }
  const accessToken = await getTeacherAccessToken(db, emp_id);
  try {
    return await gdrive.readJsonFile(accessToken, drive_quiz_file_id);
  } catch (err) {
    throw driveUnavailable(err);
  }
}

async function driveUpdateQuizJson(db, emp_id, drive_quiz_file_id, mutator) {
  const accessToken = await getTeacherAccessToken(db, emp_id);
  let current;
  try {
    current = await gdrive.readJsonFile(accessToken, drive_quiz_file_id);
  } catch (err) {
    throw driveUnavailable(err);
  }
  const next = typeof mutator === "function" ? mutator(current) : { ...current, ...mutator };
  next.updated_at = new Date().toISOString();
  try {
    await gdrive.updateJsonFile(accessToken, drive_quiz_file_id, next);
  } catch (err) {
    throw driveUnavailable(err);
  }
  return next;
}

async function driveSaveSubmission(db, emp_id, drive_folder_id, submission) {
  const accessToken = await getTeacherAccessToken(db, emp_id);
  let subFolder;
  try {
    subFolder = await gdrive.ensureFolder(accessToken, "submissions", drive_folder_id);
  } catch (err) {
    throw driveUnavailable(err);
  }
  const rollKey = submission.roll_no
    ? gdrive.sanitizeDriveName(String(submission.roll_no).toUpperCase(), "unknown")
    : gdrive.sanitizeDriveName(submission.submission_id, "sub");
  const filename = `${rollKey}.json`;
  // Store roll_no for teacher grading; not exposed in student-facing feedback
  try {
    const file = await gdrive.upsertJsonFile(accessToken, {
      filename,
      parentFolderId: subFolder.id,
      data: submission,
    });
    return { drive_file_id: file.id, accessToken };
  } catch (err) {
    throw driveUnavailable(err);
  }
}

async function driveListSubmissionFiles(db, emp_id, drive_folder_id) {
  const accessToken = await getTeacherAccessToken(db, emp_id);
  let subFolder;
  try {
    subFolder = await gdrive.findFolderByName
      ? await gdrive.ensureFolder(accessToken, "submissions", drive_folder_id)
      : await gdrive.ensureFolder(accessToken, "submissions", drive_folder_id);
  } catch (err) {
    throw driveUnavailable(err);
  }
  // list children via Drive API
  const data = await require("./googleDrive").driveRequest
    ? null
    : null;
  // Use findFileByName is one-by-one; list via driveRequest not exported.
  // Export path: download results from results.json instead for teacher results.
  return { accessToken, submissionsFolderId: subFolder.id };
}

async function driveWriteResults(db, emp_id, drive_folder_id, resultsPayload) {
  const accessToken = await getTeacherAccessToken(db, emp_id);
  try {
    const jsonFile = await gdrive.upsertJsonFile(accessToken, {
      filename: "results.json",
      parentFolderId: drive_folder_id,
      data: resultsPayload,
    });
    // CSV summary
    const rows = [["Roll Number", "Student Name", "Marks", "Percentage", "Submitted At", "Evaluated"]];
    for (const r of resultsPayload.results || []) {
      rows.push([
        r.roll_no || "",
        r.student_name || "",
        r.evaluated ? `${r.scored_marks}/${r.total_marks}` : "",
        r.evaluated ? String(r.percentage) : "",
        r.submitted_at || "",
        r.evaluated ? "yes" : "no",
      ]);
    }
    const csv = rows.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    await gdrive.upsertTextFile(accessToken, {
      filename: "results.csv",
      parentFolderId: drive_folder_id,
      text: csv,
      mimeType: "text/csv; charset=UTF-8",
    });
    return { drive_results_file_id: jsonFile.id };
  } catch (err) {
    throw driveUnavailable(err);
  }
}

async function driveReadResults(db, emp_id, drive_folder_id) {
  const accessToken = await getTeacherAccessToken(db, emp_id);
  try {
    const existing = await gdrive.findFileByName(accessToken, "results.json", drive_folder_id);
    if (!existing) return null;
    return await gdrive.readJsonFile(accessToken, existing.id);
  } catch (err) {
    throw driveUnavailable(err);
  }
}

// ---------------------------------------------------------------------------
// FEEDBACK — Drive primary (anonymous responses)
// ---------------------------------------------------------------------------

async function driveCreateFeedback(db, emp_id, formMeta) {
  const { accessToken, folders } = await ensureTeacherDriveTree(db, emp_id);
  const feedbackRoot = folders.feedback_folder_id;
  if (!feedbackRoot) throw driveUnavailable(new Error("Feedback folder missing"));

  const folderName = safeFolderName(formMeta.title, "Feedback");
  let formFolder;
  try {
    formFolder = await gdrive.ensureFolder(accessToken, folderName, feedbackRoot);
  } catch (err) {
    throw driveUnavailable(err);
  }

  const formPayload = {
    form_id: formMeta.form_id,
    emp_id,
    title: formMeta.title,
    subject: formMeta.subject || null,
    class_label: formMeta.class_label || null,
    deadline: formMeta.deadline || null,
    status: formMeta.status || "draft",
    questions: formMeta.questions || [],
    updated_at: new Date().toISOString(),
  };

  let file;
  try {
    file = await gdrive.upsertJsonFile(accessToken, {
      filename: "feedback-form.json",
      parentFolderId: formFolder.id,
      data: formPayload,
    });
    // empty responses file
    await gdrive.upsertJsonFile(accessToken, {
      filename: "responses.json",
      parentFolderId: formFolder.id,
      data: { form_id: formMeta.form_id, responses: [] },
    });
  } catch (err) {
    throw driveUnavailable(err);
  }

  return {
    drive_folder_id: formFolder.id,
    drive_form_file_id: file.id,
    formPayload,
  };
}

async function driveReadFeedbackForm(db, emp_id, drive_form_file_id) {
  const accessToken = await getTeacherAccessToken(db, emp_id);
  try {
    return await gdrive.readJsonFile(accessToken, drive_form_file_id);
  } catch (err) {
    throw driveUnavailable(err);
  }
}

async function driveUpdateFeedbackForm(db, emp_id, drive_form_file_id, mutator) {
  return driveUpdateQuizJson(db, emp_id, drive_form_file_id, mutator);
}

/**
 * Append anonymous response — NO roll/name/email in the stored object.
 */
async function driveAppendAnonymousResponse(db, emp_id, drive_folder_id, anonymousResponse) {
  const accessToken = await getTeacherAccessToken(db, emp_id);
  let responsesFile;
  try {
    responsesFile = await gdrive.findFileByName(accessToken, "responses.json", drive_folder_id);
    if (!responsesFile) {
      const created = await gdrive.upsertJsonFile(accessToken, {
        filename: "responses.json",
        parentFolderId: drive_folder_id,
        data: { responses: [] },
      });
      responsesFile = { id: created.id };
    }
    const doc = await gdrive.readJsonFile(accessToken, responsesFile.id);
    const list = Array.isArray(doc.responses) ? doc.responses : [];
    // Strip any accidental identity fields
    const clean = {
      response_id: anonymousResponse.response_id,
      answers: anonymousResponse.answers || {},
      comment: anonymousResponse.comment || null,
      submitted_at: anonymousResponse.submitted_at || new Date().toISOString(),
    };
    list.push(clean);
    await gdrive.updateJsonFile(accessToken, responsesFile.id, {
      form_id: doc.form_id || null,
      responses: list,
      updated_at: new Date().toISOString(),
    });
    // rebuild report.csv
    await driveRebuildFeedbackReport(accessToken, drive_folder_id, list, doc.form_id);
    return { count: list.length };
  } catch (err) {
    throw driveUnavailable(err);
  }
}

async function driveRebuildFeedbackReport(accessToken, drive_folder_id, responses, form_id) {
  // Aggregate option counts across responses
  const counts = {}; // questionKey -> option -> count
  const comments = [];
  for (const r of responses || []) {
    if (r.comment) comments.push(String(r.comment));
    const ans = r.answers || {};
    for (const [qid, val] of Object.entries(ans)) {
      if (!counts[qid]) counts[qid] = {};
      const key = String(val);
      counts[qid][key] = (counts[qid][key] || 0) + 1;
    }
  }
  const lines = [["Question ID", "Option", "Count"]];
  for (const [qid, opts] of Object.entries(counts)) {
    for (const [opt, c] of Object.entries(opts)) {
      lines.push([qid, opt, String(c)]);
    }
  }
  lines.push([]);
  lines.push(["Anonymous comments"]);
  for (const c of comments) lines.push([c.replace(/"/g, "'")]);
  const csv = lines.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  await gdrive.upsertTextFile(accessToken, {
    filename: "report.csv",
    parentFolderId: drive_folder_id,
    text: csv,
    mimeType: "text/csv; charset=UTF-8",
  });
  await gdrive.upsertJsonFile(accessToken, {
    filename: "report.json",
    parentFolderId: drive_folder_id,
    data: {
      form_id: form_id || null,
      response_count: (responses || []).length,
      counts,
      comments,
      generated_at: new Date().toISOString(),
    },
  });
}

async function driveReadFeedbackReport(db, emp_id, drive_folder_id) {
  const accessToken = await getTeacherAccessToken(db, emp_id);
  try {
    const f = await gdrive.findFileByName(accessToken, "report.json", drive_folder_id);
    if (f) return await gdrive.readJsonFile(accessToken, f.id);
    const resp = await gdrive.findFileByName(accessToken, "responses.json", drive_folder_id);
    if (!resp) return { response_count: 0, counts: {}, comments: [] };
    const doc = await gdrive.readJsonFile(accessToken, resp.id);
    return {
      response_count: (doc.responses || []).length,
      counts: {},
      comments: (doc.responses || []).map((r) => r.comment).filter(Boolean),
      responses: doc.responses || [],
    };
  } catch (err) {
    throw driveUnavailable(err);
  }
}


async function driveListSubmissions(db, emp_id, drive_folder_id) {
  const accessToken = await getTeacherAccessToken(db, emp_id);
  const gdrive = require("./googleDrive");
  let subFolder;
  try {
    subFolder = await gdrive.ensureFolder(accessToken, "submissions", drive_folder_id);
  } catch (err) {
    throw driveUnavailable(err);
  }
  const files = await gdrive.listFilesInFolder(accessToken, subFolder.id);
  const out = [];
  for (const f of files) {
    if (!f.name || !f.name.endsWith(".json")) continue;
    try {
      const data = await gdrive.readJsonFile(accessToken, f.id);
      out.push({ file_id: f.id, name: f.name, data });
    } catch (_) { /* skip bad file */ }
  }
  return out;
}

async function driveGetSubmissionByRoll(db, emp_id, drive_folder_id, roll_no) {
  const accessToken = await getTeacherAccessToken(db, emp_id);
  const gdrive = require("./googleDrive");
  const subFolder = await gdrive.ensureFolder(accessToken, "submissions", drive_folder_id);
  const safe = gdrive.sanitizeDriveName(String(roll_no).toUpperCase(), "unknown") + ".json";
  const existing = await gdrive.findFileByName(accessToken, safe, subFolder.id);
  if (!existing) return null;
  const data = await gdrive.readJsonFile(accessToken, existing.id);
  return { file_id: existing.id, data };
}

module.exports = {
  getTeacherAccessToken,
  ensureTeacherDriveTree,
  driveCreateQuiz,
  driveReadQuiz,
  driveUpdateQuizJson,
  driveSaveSubmission,
  driveListSubmissions,
  driveGetSubmissionByRoll,
  driveWriteResults,
  driveReadResults,
  driveCreateFeedback,
  driveReadFeedbackForm,
  driveUpdateFeedbackForm,
  driveAppendAnonymousResponse,
  driveReadFeedbackReport,
};
