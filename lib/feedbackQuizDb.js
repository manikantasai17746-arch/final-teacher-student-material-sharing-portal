// Feedback & Quiz data helpers (loaded by db.js)
module.exports = function attachFeedbackQuiz(ctx) {
  const driveStore = require("./quizFeedbackDrive");
  // db-like surface for token refresh (getTeacherGoogleDrive lives on main db module — pass via ctx if available)
  const driveDb = {
    getTeacherGoogleDrive: ctx.getTeacherGoogleDrive || (async () => null),
    updateTeacherGoogleDriveTokens: ctx.updateTeacherGoogleDriveTokens || (async () => null),
    updateTeacherGoogleDriveFolders: ctx.updateTeacherGoogleDriveFolders || (async () => null),
  };

  const { pool, newId, findTeacher, findStudent, sanitizeTeacher, sanitizeStudent, rowTeacher } = ctx;
  const crypto = require("crypto");

  function feedbackAnonToken(form_id, roll_no) {
    const secret = process.env.SESSION_SECRET || "eduvault-feedback";
    return crypto.createHmac("sha256", secret).update(String(form_id) + "|" + String(roll_no).toUpperCase()).digest("hex");
  }

  async function createFeedbackForm({ emp_id, title, subject, class_label, deadline, questions }) {
    const teacher = await findTeacher(emp_id);
    if (!teacher) throw new Error("Unknown teacher.");
    if (!title || !String(title).trim()) throw new Error("Title is required.");
    const form_id = newId();
    const qList = Array.isArray(questions) ? questions : [];
    const normalized = [];
    for (let i = 0; i < qList.length; i++) {
      const q = qList[i];
      if (!q || !q.question_text) continue;
      if (q.question_type === "text") {
        normalized.push({
          question_id: newId(),
          question_text: String(q.question_text).trim().slice(0, 500),
          question_type: "text",
          options: [],
          display_order: i,
          required: q.required !== false,
        });
      } else {
        const opts = normalizeFeedbackOptions(q.options, "Question " + (i + 1));
        normalized.push({
          question_id: newId(),
          question_text: String(q.question_text).trim().slice(0, 500),
          question_type: "rating",
          options: opts,
          display_order: i,
          required: q.required !== false,
        });
      }
    }
    if (!normalized.length) throw new Error("Add at least one question.");
    const dl = deadline ? new Date(deadline) : null;
    // DRIVE PRIMARY
    let driveResult;
    try {
      driveResult = await driveStore.driveCreateFeedback(driveDb, teacher.emp_id, {
        form_id,
        title: String(title).trim(),
        subject: subject || null,
        class_label: class_label || null,
        deadline: dl ? dl.toISOString() : null,
        status: "draft",
        questions: normalized,
      });
    } catch (driveErr) {
      const e = new Error(
        (driveErr && driveErr.message) ||
          "Google Drive is unavailable. The feedback form could not be saved. Connect Google Drive and try again."
      );
      e.status = driveErr.status || 503;
      throw e;
    }
    await pool.query(
      `INSERT INTO feedback_forms (form_id, emp_id, title, subject, class_label, deadline, status, drive_folder_id, drive_form_file_id)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8)`,
      [form_id, teacher.emp_id, String(title).trim(), subject || null, class_label || null, dl,
       driveResult.drive_folder_id, driveResult.drive_form_file_id]
    );
    for (let i = 0; i < normalized.length; i++) {
      const q = normalized[i];
      try {
        await pool.query(
          `INSERT INTO feedback_questions (question_id, form_id, question_text, question_type, options_json, display_order, required)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [q.question_id, form_id, q.question_text, q.question_type,
           JSON.stringify(q.options || []), i, q.required !== false]
        );
      } catch (_) {}
    }
    return getFeedbackForm(form_id);
  }

  async function getFeedbackForm(form_id) {
    const r = await pool.query(`SELECT * FROM feedback_forms WHERE form_id = $1`, [form_id]);
    if (!r.rows.length) return null;
    const meta = r.rows[0];
    if (meta.drive_form_file_id) {
      try {
        const driveForm = await driveStore.driveReadFeedbackForm(driveDb, meta.emp_id, meta.drive_form_file_id);
        return {
          ...meta,
          title: driveForm.title != null ? driveForm.title : meta.title,
          subject: driveForm.subject != null ? driveForm.subject : meta.subject,
          class_label: driveForm.class_label != null ? driveForm.class_label : meta.class_label,
          deadline: driveForm.deadline || meta.deadline,
          status: driveForm.status || meta.status,
          questions: Array.isArray(driveForm.questions) ? driveForm.questions : [],
        };
      } catch (err) {
        const e = new Error(err.message || "Google Drive is unavailable. Reconnect Google Drive.");
        e.status = err.status || 503;
        throw e;
      }
    }
    // Legacy PG-only form
    const q = await pool.query(`SELECT * FROM feedback_questions WHERE form_id = $1 ORDER BY display_order ASC`, [form_id]);
    meta.questions = q.rows.map((row) => ({ ...row, options: row.options_json || ["Bad", "Good", "Very Good", "Excellent"] }));
    return meta;
  }

  async function listFeedbackFormsByTeacher(emp_id) {
    const teacher = await findTeacher(emp_id);
    if (!teacher) return [];
    const r = await pool.query(
      `SELECT f.*, (SELECT COUNT(*)::int FROM feedback_responses fr WHERE fr.form_id = f.form_id) AS response_count
       FROM feedback_forms f WHERE f.emp_id = $1 ORDER BY f.created_at DESC`, [teacher.emp_id]);
    return r.rows;
  }

  async function listPublishedFeedbackForStudent(roll_no) {
    const r = await pool.query(
      `SELECT f.form_id, f.title, f.subject, f.class_label, f.deadline, f.status, f.emp_id, t.name AS teacher_name
       FROM feedback_forms f JOIN teachers t ON t.emp_id = f.emp_id
       WHERE f.status = 'open' AND (f.deadline IS NULL OR f.deadline > NOW())
       ORDER BY f.published_at DESC NULLS LAST, f.created_at DESC`);
    let rows = r.rows;
    if (roll_no) {
      const student = await findStudent(roll_no);
      if (!student) return [];
      rows = rows.filter(
        (f) =>
          studentHasBookmarkedTeacher(student, f.emp_id) &&
          studentMatchesClassLabel(student, f.class_label)
      );
    } else {
      return [];
    }
    return rows;
  }

  async function updateFeedbackForm(form_id, emp_id, patch) {
    const metaR = await pool.query(`SELECT * FROM feedback_forms WHERE form_id = $1`, [form_id]);
    if (!metaR.rows.length) throw new Error("Feedback form not found.");
    const meta = metaR.rows[0];
    const teacher = await findTeacher(emp_id);
    if (!teacher || String(meta.emp_id).toLowerCase() !== String(teacher.emp_id).toLowerCase()) throw new Error("Not authorized.");
    if (meta.status === "closed") throw new Error("Closed feedback forms cannot be edited.");
    const title = patch.title !== undefined ? String(patch.title).trim() : meta.title;
    const subject = patch.subject !== undefined ? patch.subject : meta.subject;
    const class_label = patch.class_label !== undefined ? patch.class_label : meta.class_label;
    const deadline = patch.deadline !== undefined ? (patch.deadline ? new Date(patch.deadline) : null) : meta.deadline;
    let questions = null;
    if (Array.isArray(patch.questions)) {
      questions = [];
      for (let i = 0; i < patch.questions.length; i++) {
        const q = patch.questions[i];
        if (!q || !q.question_text) continue;
        if (q.question_type === "text") {
          questions.push({
            question_id: q.question_id || newId(),
            question_text: String(q.question_text).trim().slice(0, 500),
            question_type: "text",
            options: [],
            display_order: i,
            required: q.required !== false,
          });
        } else {
          const opts = normalizeFeedbackOptions(q.options, "Question " + (i + 1));
          questions.push({
            question_id: q.question_id || newId(),
            question_text: String(q.question_text).trim().slice(0, 500),
            question_type: "rating",
            options: opts,
            display_order: i,
            required: q.required !== false,
          });
        }
      }
    }
    if (meta.drive_form_file_id) {
      await driveStore.driveUpdateFeedbackForm(driveDb, teacher.emp_id, meta.drive_form_file_id, (cur) => {
        const next = {
          ...cur,
          title,
          subject,
          class_label,
          deadline: deadline ? new Date(deadline).toISOString() : null,
        };
        if (questions) next.questions = questions;
        return next;
      });
    }
    await pool.query(`UPDATE feedback_forms SET title=$2, subject=$3, class_label=$4, deadline=$5, updated_at=NOW() WHERE form_id=$1`,
      [form_id, title, subject || null, class_label || null, deadline]);
    return getFeedbackForm(form_id);
  }

  async function publishFeedbackForm(form_id, emp_id) {
    const metaR = await pool.query(`SELECT * FROM feedback_forms WHERE form_id = $1`, [form_id]);
    if (!metaR.rows.length) throw new Error("Feedback form not found.");
    const meta = metaR.rows[0];
    const teacher = await findTeacher(emp_id);
    if (!teacher || String(meta.emp_id).toLowerCase() !== String(teacher.emp_id).toLowerCase()) throw new Error("Not authorized.");
    const form = await getFeedbackForm(form_id);
    if (!form.questions || !form.questions.length) throw new Error("Add at least one question before publishing.");
    if (meta.drive_form_file_id) {
      await driveStore.driveUpdateFeedbackForm(driveDb, teacher.emp_id, meta.drive_form_file_id, (cur) => ({
        ...cur,
        status: "open",
        published_at: cur.published_at || new Date().toISOString(),
      }));
    }
    await pool.query(`UPDATE feedback_forms SET status='open', published_at=COALESCE(published_at, NOW()), updated_at=NOW() WHERE form_id=$1`, [form_id]);
    return getFeedbackForm(form_id);
  }

  async function closeFeedbackForm(form_id, emp_id) {
    const metaR = await pool.query(`SELECT * FROM feedback_forms WHERE form_id = $1`, [form_id]);
    if (!metaR.rows.length) throw new Error("Feedback form not found.");
    const meta = metaR.rows[0];
    const teacher = await findTeacher(emp_id);
    if (!teacher || String(meta.emp_id).toLowerCase() !== String(teacher.emp_id).toLowerCase()) throw new Error("Not authorized.");
    if (meta.drive_form_file_id) {
      await driveStore.driveUpdateFeedbackForm(driveDb, teacher.emp_id, meta.drive_form_file_id, (cur) => ({
        ...cur,
        status: "closed",
        closed_at: new Date().toISOString(),
      }));
    }
    await pool.query(`UPDATE feedback_forms SET status='closed', closed_at=NOW(), updated_at=NOW() WHERE form_id=$1`, [form_id]);
    return getFeedbackForm(form_id);
  }

  async function deleteFeedbackForm(form_id, emp_id) {
    const metaR = await pool.query(`SELECT * FROM feedback_forms WHERE form_id = $1`, [form_id]);
    if (!metaR.rows.length) throw new Error("Feedback form not found.");
    const meta = metaR.rows[0];
    const teacher = await findTeacher(emp_id);
    if (!teacher || String(meta.emp_id).toLowerCase() !== String(teacher.emp_id).toLowerCase()) throw new Error("Not authorized.");
    if (meta.drive_folder_id) {
      try {
        const accessToken = await driveStore.getTeacherAccessToken(driveDb, teacher.emp_id);
        const gdrive = require("./googleDrive");
        await gdrive.deleteDriveFile(accessToken, meta.drive_folder_id);
      } catch (err) {
        const e = new Error(
          "Could not delete feedback folder from Google Drive: " +
            ((err && err.message) || "Drive error") +
            ". PostgreSQL record was not removed."
        );
        e.status = 503;
        throw e;
      }
    }
    await pool.query(`DELETE FROM feedback_forms WHERE form_id = $1`, [form_id]);
    return meta;
  }

  async function submitAnonymousFeedback({ form_id, roll_no, answers, comment_text }) {
    const form = await getFeedbackForm(form_id);
    if (!form) throw new Error("Feedback form not found.");
    if (form.status !== "open") throw new Error("This feedback form is not open for responses.");
    if (form.deadline && new Date(form.deadline) < new Date()) throw new Error("The deadline for this feedback has passed.");
    const token = feedbackAnonToken(form_id, roll_no);
    const existing = await pool.query(`SELECT 1 FROM feedback_response_tokens WHERE form_id = $1 AND token_hash = $2`, [form_id, token]);
    if (existing.rows.length) throw new Error("You have already submitted feedback for this form.");
    // Strip any identity-like keys a client might inject; keep only known question_ids
    const allowed = new Set((form.questions || []).map((q) => q.question_id));
    const clean = {};
    if (answers && typeof answers === "object") {
      for (const [k, v] of Object.entries(answers)) {
        if (!allowed.has(k)) continue;
        if (v == null) continue;
        clean[k] = String(v).slice(0, 500);
      }
    }
    const response_id = newId();
    // Authoritative anonymous response on teacher's Drive
    const formRow = await pool.query(`SELECT emp_id, drive_folder_id FROM feedback_forms WHERE form_id = $1`, [form_id]);
    if (!formRow.rows.length || !formRow.rows[0].drive_folder_id) {
      throw new Error("Feedback form is not available on Google Drive. Ask your teacher to reconnect Drive.");
    }
    await driveStore.driveAppendAnonymousResponse(driveDb, formRow.rows[0].emp_id, formRow.rows[0].drive_folder_id, {
      response_id,
      answers: clean,
      comment: comment_text ? String(comment_text).slice(0, 2000) : null,
      submitted_at: new Date().toISOString(),
    });
    // HMAC token only in PG (no identity on response content)
    try {
      await pool.query(`INSERT INTO feedback_response_tokens (form_id, token_hash) VALUES ($1, $2)`, [form_id, token]);
    } catch (e) {
      if (e && e.code === "23505") throw new Error("You have already submitted feedback for this form.");
      throw e;
    }
    return { ok: true, response_id };
  }

  async function hasStudentSubmittedFeedback(form_id, roll_no) {
    const token = feedbackAnonToken(form_id, roll_no);
    const r = await pool.query(`SELECT 1 FROM feedback_response_tokens WHERE form_id = $1 AND token_hash = $2`, [form_id, token]);
    return r.rows.length > 0;
  }

  async function getFeedbackAggregates(form_id) {
    const form = await getFeedbackForm(form_id);
    if (!form) return null;
    const formRow = await pool.query(`SELECT emp_id, drive_folder_id FROM feedback_forms WHERE form_id = $1`, [form_id]);
    let report = null;
    if (formRow.rows.length && formRow.rows[0].drive_folder_id) {
      try {
        report = await driveStore.driveReadFeedbackReport(driveDb, formRow.rows[0].emp_id, formRow.rows[0].drive_folder_id);
      } catch (err) {
        const e = new Error(err.message || "Could not load feedback report from Google Drive.");
        e.status = 503;
        throw e;
      }
    }
    if (report) {
      const aggregates = (form.questions || []).map((q) => {
        const counts = (report.counts && report.counts[q.question_id]) || {};
        const opts = Array.isArray(q.options) ? q.options : (q.options_json || []);
        const full = {};
        for (const o of opts) full[String(o)] = counts[String(o)] || 0;
        for (const [k, v] of Object.entries(counts)) full[k] = v;
        return {
          question_id: q.question_id,
          question_text: q.question_text,
          question_type: q.question_type,
          counts: full,
          answered: Object.values(full).reduce((a, b) => a + Number(b || 0), 0),
        };
      });
      return {
        form,
        response_count: report.response_count || 0,
        aggregates,
        comments: report.comments || [],
      };
    }
    return { form, response_count: 0, aggregates: [], comments: [] };
  }

  async function listAllFeedbackFormsAdmin({ q = "", emp_id = "", limit = 50, offset = 0 } = {}) {
    const params = [];
    const where = [];
    if (emp_id) { params.push(String(emp_id).trim()); where.push(`f.emp_id = $${params.length}`); }
    if (q && String(q).trim()) {
      const raw = String(q).trim();
      params.push("%" + raw.toLowerCase() + "%");
      const i = params.length;
      // Support Employee ID, teacher name, subject, class, form title
      where.push(`(
        LOWER(f.title) LIKE $${i}
        OR LOWER(COALESCE(f.subject,'')) LIKE $${i}
        OR LOWER(COALESCE(f.class_label,'')) LIKE $${i}
        OR LOWER(t.name) LIKE $${i}
        OR LOWER(t.emp_id) LIKE $${i}
        OR LOWER(COALESCE(t.email,'')) LIKE $${i}
      )`);
    }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    params.push(Math.max(1, Math.min(200, parseInt(limit, 10) || 50)));
    params.push(Math.max(0, parseInt(offset, 10) || 0));
    const countRes = await pool.query(`SELECT COUNT(*)::int AS c FROM feedback_forms f JOIN teachers t ON t.emp_id = f.emp_id ${whereSql}`, params.slice(0, -2));
    const r = await pool.query(
      `SELECT f.*, t.name AS teacher_name, (SELECT COUNT(*)::int FROM feedback_responses fr WHERE fr.form_id = f.form_id) AS response_count
       FROM feedback_forms f JOIN teachers t ON t.emp_id = f.emp_id ${whereSql}
       ORDER BY f.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { total: countRes.rows[0].c, forms: r.rows };
  }

  // ---- Quizzes (abbreviated but complete core) ----
  function normalizeFeedbackOptions(opts, questionLabel) {
    const texts = [];
    for (const o of (Array.isArray(opts) ? opts : [])) {
      const s = String(o == null ? "" : o).trim();
      if (s) texts.push(s.slice(0, 200));
    }
    if (texts.length !== 4) {
      throw new Error((questionLabel || "Each question") + " must have exactly 4 non-empty options (got " + texts.length + ").");
    }
    if (new Set(texts.map((t) => t.toLowerCase())).size !== 4) {
      throw new Error((questionLabel || "Each question") + " must have 4 unique options.");
    }
    return texts;
  }

  function normalizeFourOptions(opts, questionLabel) {
    const raw = Array.isArray(opts) ? opts : [];
    const texts = [];
    for (const o of raw) {
      const text = typeof o === "object" && o != null ? (o.option_text || o.text || "") : o;
      const s = String(text == null ? "" : text).trim();
      if (s) texts.push(s.slice(0, 500));
    }
    if (texts.length !== 4) {
      throw new Error((questionLabel || "Each question") + " must have exactly 4 non-empty options (got " + texts.length + ").");
    }
    const lower = texts.map((t) => t.toLowerCase());
    if (new Set(lower).size !== 4) {
      throw new Error((questionLabel || "Each question") + " must have 4 unique options.");
    }
    return texts;
  }

  async function replaceQuizQuestions(quiz_id, questions) {
    await pool.query(`DELETE FROM quiz_questions WHERE quiz_id = $1`, [quiz_id]);
    const qList = Array.isArray(questions) ? questions : [];
    if (!qList.length) throw new Error("Add at least one question.");
    for (let i = 0; i < qList.length; i++) {
      const q = qList[i];
      if (!q || !q.question_text || !String(q.question_text).trim()) {
        throw new Error("Question " + (i + 1) + " text is required.");
      }
      const texts = normalizeFourOptions(q.options, "Question " + (i + 1));
      const question_id = newId();
      await pool.query(`INSERT INTO quiz_questions (question_id, quiz_id, question_text, marks, display_order, correct_option_id) VALUES ($1,$2,$3,$4,$5,NULL)`,
        [question_id, quiz_id, String(q.question_text).trim().slice(0, 1000), Math.max(0.5, parseFloat(q.marks) || 1), i]);
      for (let j = 0; j < 4; j++) {
        await pool.query(`INSERT INTO quiz_options (option_id, question_id, option_text, display_order) VALUES ($1,$2,$3,$4)`,
          [newId(), question_id, texts[j], j]);
      }
    }
  }

  async function getQuiz(quiz_id, { includeCorrect = false } = {}) {
    const r = await pool.query(`SELECT * FROM quizzes WHERE quiz_id = $1`, [quiz_id]);
    if (!r.rows.length) return null;
    const meta = r.rows[0];
    // Authoritative content from teacher's Drive when pointer exists
    if (meta.drive_quiz_file_id) {
      try {
        const driveQuiz = await driveStore.driveReadQuiz(driveDb, meta.emp_id, meta.drive_quiz_file_id);
        const quiz = {
          ...meta,
          title: driveQuiz.title != null ? driveQuiz.title : meta.title,
          subject: driveQuiz.subject != null ? driveQuiz.subject : meta.subject,
          class_label: driveQuiz.class_label != null ? driveQuiz.class_label : meta.class_label,
          instructions: driveQuiz.instructions != null ? driveQuiz.instructions : meta.instructions,
          deadline: driveQuiz.deadline || meta.deadline,
          status: driveQuiz.status || meta.status,
          results_published: driveQuiz.results_published != null ? !!driveQuiz.results_published : !!meta.results_published,
          evaluated_at: driveQuiz.evaluated_at || meta.evaluated_at,
          questions: Array.isArray(driveQuiz.questions) ? driveQuiz.questions.map((q) => {
            const item = {
              question_id: q.question_id,
              question_text: q.question_text,
              marks: Number(q.marks) || 1,
              display_order: q.display_order,
              options: (q.options || []).map((o) => ({
                option_id: o.option_id,
                option_text: o.option_text || o.text || String(o),
                display_order: o.display_order,
              })),
            };
            if (includeCorrect) {
              item.correct_option_id = q.correct_option_id || (driveQuiz.correct_answers && driveQuiz.correct_answers[q.question_id]) || null;
            }
            return item;
          }) : [],
        };
        return quiz;
      } catch (err) {
        const e = new Error(err.message || "Google Drive is unavailable. Reconnect Google Drive.");
        e.status = err.status || 503;
        throw e;
      }
    }
    // Legacy PG-only quizzes (pre-Drive migration)
    const qs = await pool.query(`SELECT * FROM quiz_questions WHERE quiz_id = $1 ORDER BY display_order ASC`, [quiz_id]);
    const questions = [];
    for (const q of qs.rows) {
      const opts = await pool.query(`SELECT option_id, option_text, display_order FROM quiz_options WHERE question_id = $1 ORDER BY display_order ASC`, [q.question_id]);
      const item = { question_id: q.question_id, question_text: q.question_text, marks: Number(q.marks), display_order: q.display_order, options: opts.rows };
      if (includeCorrect) item.correct_option_id = q.correct_option_id;
      questions.push(item);
    }
    meta.questions = questions;
    return meta;
  }

  async function createQuiz({ emp_id, title, subject, class_label, instructions, deadline, questions }) {
    const teacher = await findTeacher(emp_id);
    if (!teacher) throw new Error("Unknown teacher.");
    if (!title || !String(title).trim()) throw new Error("Title is required.");
    if (!deadline) throw new Error("Deadline is required for quizzes.");
    const dl = new Date(deadline);
    if (Number.isNaN(dl.getTime())) throw new Error("Invalid deadline.");
    // Normalize questions (exactly 4 options) before Drive write
    const qList = Array.isArray(questions) ? questions : [];
    if (!qList.length) throw new Error("Add at least one question.");
    const normalized = [];
    for (let i = 0; i < qList.length; i++) {
      const q = qList[i];
      if (!q || !String(q.question_text || "").trim()) throw new Error("Question " + (i + 1) + " text is required.");
      const texts = normalizeFourOptions(q.options, "Question " + (i + 1));
      const question_id = newId();
      normalized.push({
        question_id,
        question_text: String(q.question_text).trim().slice(0, 1000),
        marks: Math.max(0.5, parseFloat(q.marks) || 1),
        options: texts.map((t, j) => ({ option_id: newId(), option_text: t, display_order: j })),
      });
    }
    const quiz_id = newId();
    // DRIVE PRIMARY: must succeed before any PostgreSQL row is written
    let driveResult;
    try {
      driveResult = await driveStore.driveCreateQuiz(driveDb, teacher.emp_id, {
        quiz_id,
        title: String(title).trim(),
        subject: subject || null,
        class_label: class_label || null,
        instructions: instructions || null,
        deadline: dl.toISOString(),
        status: "draft",
        questions: normalized,
      });
    } catch (driveErr) {
      const e = new Error(
        (driveErr && driveErr.message) ||
          "Google Drive is unavailable. The quiz could not be saved. Connect Google Drive and try again."
      );
      e.status = driveErr.status || 503;
      throw e;
    }
    // Minimal PostgreSQL metadata/index only (authorization + Drive pointers)
    await pool.query(
      `INSERT INTO quizzes (quiz_id, emp_id, title, subject, class_label, instructions, deadline, status, drive_folder_id, drive_quiz_file_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9)`,
      [quiz_id, teacher.emp_id, String(title).trim(), subject || null, class_label || null, instructions || null, dl,
       driveResult.drive_folder_id, driveResult.drive_quiz_file_id]
    );
    // Optional mirror of questions in PG for indexes only — Drive remains authoritative
    try {
      await replaceQuizQuestions(quiz_id, normalized.map((q) => ({
        question_text: q.question_text,
        marks: q.marks,
        options: q.options.map((o) => o.option_text),
      })));
    } catch (_) {}
    return getQuiz(quiz_id, { includeCorrect: false });
  }

  async function listQuizzesByTeacher(emp_id) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) return [];

  const r = await pool.query(
    `SELECT q.*,
            (SELECT COUNT(*)::int
             FROM quiz_submissions s
             WHERE s.quiz_id = q.quiz_id) AS submission_count,
            (SELECT COUNT(*)::int
             FROM quiz_questions qq
             WHERE qq.quiz_id = q.quiz_id
             AND qq.correct_option_id IS NOT NULL) AS correct_answers_set,
            (SELECT COUNT(*)::int
             FROM quiz_questions qq
             WHERE qq.quiz_id = q.quiz_id) AS question_count
     FROM quizzes q
     WHERE q.emp_id = $1
     ORDER BY q.created_at DESC`,
    [teacher.emp_id]
  );

  const results = [];

  for (const row of r.rows) {

    // Drive-backed quiz: Google Drive is authoritative
    if (row.drive_quiz_file_id) {
      try {
        const driveQuiz = await getQuiz(row.quiz_id, {
          includeCorrect: true
        });

        const questions = Array.isArray(driveQuiz?.questions)
          ? driveQuiz.questions
          : [];

        const hasCorrectAnswers =
          questions.length > 0 &&
          questions.every(q => !!q.correct_option_id);

        results.push({
          ...row,

          title: driveQuiz.title ?? row.title,
          subject: driveQuiz.subject ?? row.subject,
          class_label: driveQuiz.class_label ?? row.class_label,
          deadline: driveQuiz.deadline ?? row.deadline,
          status: driveQuiz.status ?? row.status,

          question_count: questions.length,

          correct_answers_set:
            hasCorrectAnswers ? questions.length : 0,

          has_correct_answers: hasCorrectAnswers,

          evaluated_at:
            driveQuiz.evaluated_at ?? row.evaluated_at,

          results_published:
            driveQuiz.results_published != null
              ? !!driveQuiz.results_published
              : !!row.results_published
        });

      } catch (err) {
        console.error(
          "[eduvault] Drive quiz list error:",
          err.message
        );

        results.push({
          ...row,
          has_correct_answers: false
        });
      }

      continue;
    }

    // Old PostgreSQL-only quiz
    results.push({
      ...row,
      has_correct_answers:
        Number(row.question_count || 0) > 0 &&
        Number(row.correct_answers_set || 0) ===
          Number(row.question_count || 0)
    });
  }

  return results;
}

  function studentMatchesClassLabel(student, class_label) {
    // Empty class_label = no class restriction (still requires bookmark elsewhere)
    if (!class_label || !String(class_label).trim()) return true;
    const label = String(class_label).toLowerCase().replace(/\s+/g, " ").trim();
    const dept = String(student.department || "").toLowerCase().trim();
    const sem = String(student.semester || "").toLowerCase().trim();
    const section = String(student.section || "").toLowerCase().trim();
    const studentClass = String(student.class_label || student.class || "").toLowerCase().trim();

    // Prefer exact / containment match against a combined student class string
    const studentBlob = [dept, sem, section, studentClass].filter(Boolean).join(" ");
    if (!studentBlob) return false; // strict: unknown student class does not match restricted quiz

    // Normalize common year forms: "2nd" "2" "second"
    function normTokens(s) {
      return s
        .replace(/\b(first|1st|i)\b/g, "1")
        .replace(/\b(second|2nd|ii)\b/g, "2")
        .replace(/\b(third|3rd|iii)\b/g, "3")
        .replace(/\b(fourth|4th|iv)\b/g, "4")
        .replace(/year/g, "")
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 1);
    }
    const labelTokens = normTokens(label);
    const studentTokens = new Set(normTokens(studentBlob));
    if (!labelTokens.length) return true;

    // Department must match when both sides have a department-like token
    if (dept) {
      const deptOk = label.includes(dept) || labelTokens.some((t) => t.length >= 2 && (dept.includes(t) || t.includes(dept.split(/\s+/)[0])));
      if (!deptOk) return false;
    }

    // Year/semester digit must match when label specifies a year number
    const yearInLabel = labelTokens.find((t) => /^[1-4]$/.test(t));
    if (yearInLabel) {
      const yearInStudent = normTokens(sem + " " + studentClass).find((t) => /^[1-4]$/.test(t));
      if (yearInStudent && yearInStudent !== yearInLabel) return false;
      if (!yearInStudent && !studentBlob.includes(yearInLabel)) return false;
    }

    // Section letter if present in label
    const secMatch = label.match(/\bsection\s*([a-z0-9])\b/) || label.match(/\bsec\.?\s*([a-z0-9])\b/);
    if (secMatch) {
      const want = secMatch[1];
      const have = section || (studentClass.match(/\b(?:section|sec\.?)\s*([a-z0-9])\b/) || [])[1] || "";
      if (have && have !== want) return false;
      if (!have && !studentBlob.includes(want)) return false;
    }

    // Overall: majority of significant label tokens (len>=2) appear in student blob
    const significant = labelTokens.filter((t) => t.length >= 2 || /^[1-4]$/.test(t));
    const hits = significant.filter((t) => studentTokens.has(t) || studentBlob.includes(t)).length;
    return hits >= Math.ceil(significant.length * 0.6);
  }


  function studentHasBookmarkedTeacher(student, emp_id) {
    if (!student || !emp_id) return false;
    const list = student.bookmarked_teachers || [];
    const target = String(emp_id).toUpperCase();
    return list.some((id) => String(id).toUpperCase() === target);
  }

  /** Student may access quiz only if bookmarked teacher AND class matches. */
  async function assertStudentCanAccessQuiz(quiz_id, roll_no) {
    const quiz = await getQuiz(quiz_id, { includeCorrect: false });
    if (!quiz) {
      const err = new Error("Quiz not found.");
      err.status = 404;
      throw err;
    }
    const student = await findStudent(roll_no);
    if (!student) {
      const err = new Error("Not authorized.");
      err.status = 403;
      throw err;
    }
    if (!studentHasBookmarkedTeacher(student, quiz.emp_id)) {
      const err = new Error("This quiz is only available to students who follow this teacher.");
      err.status = 403;
      throw err;
    }
    if (!studentMatchesClassLabel(student, quiz.class_label)) {
      const err = new Error("This quiz is not available for your class.");
      err.status = 403;
      throw err;
    }
    return { quiz, student };
  }

  async function assertStudentCanAccessFeedback(form_id, roll_no) {
    const form = await getFeedbackForm(form_id);
    if (!form) {
      const err = new Error("Feedback form not found.");
      err.status = 404;
      throw err;
    }
    const student = await findStudent(roll_no);
    if (!student) {
      const err = new Error("Not authorized.");
      err.status = 403;
      throw err;
    }
    if (!studentHasBookmarkedTeacher(student, form.emp_id)) {
      const err = new Error("This feedback form is only available to students who follow this teacher.");
      err.status = 403;
      throw err;
    }
    if (!studentMatchesClassLabel(student, form.class_label)) {
      const err = new Error("This feedback form is not available for your class.");
      err.status = 403;
      throw err;
    }
    return { form, student };
  }


  async function listOpenQuizzesForStudent(roll_no) {
    const r = await pool.query(
      `SELECT q.quiz_id, q.title, q.subject, q.class_label, q.deadline, q.status, q.results_published, q.emp_id, t.name AS teacher_name,
              (SELECT COALESCE(SUM(marks),0) FROM quiz_questions qq WHERE qq.quiz_id = q.quiz_id) AS total_marks
       FROM quizzes q JOIN teachers t ON t.emp_id = q.emp_id
       WHERE q.status = 'open' AND q.deadline IS NOT NULL AND q.deadline > NOW()
       ORDER BY q.published_at DESC NULLS LAST, q.created_at DESC`);
    let rows = r.rows;
    if (roll_no) {
      const student = await findStudent(roll_no);
      if (!student) return [];
      rows = rows.filter(
        (q) =>
          studentHasBookmarkedTeacher(student, q.emp_id) &&
          studentMatchesClassLabel(student, q.class_label)
      );
    } else {
      return [];
    }
    return rows;
  }

  async function updateQuiz(quiz_id, emp_id, patch) {
    const quiz = await getQuiz(quiz_id);
    if (!quiz) throw new Error("Quiz not found.");
    const teacher = await findTeacher(emp_id);
    if (!teacher || String(quiz.emp_id).toLowerCase() !== String(teacher.emp_id).toLowerCase()) throw new Error("Not authorized.");
    const title = patch.title !== undefined ? String(patch.title).trim() : quiz.title;
    const subject = patch.subject !== undefined ? patch.subject : quiz.subject;
    const class_label = patch.class_label !== undefined ? patch.class_label : quiz.class_label;
    const instructions = patch.instructions !== undefined ? patch.instructions : quiz.instructions;
    const deadline = patch.deadline !== undefined ? (patch.deadline ? new Date(patch.deadline) : null) : quiz.deadline;
    const meta = (await pool.query(`SELECT drive_quiz_file_id FROM quizzes WHERE quiz_id=$1`, [quiz_id])).rows[0];
    let normalized = null;
    if (Array.isArray(patch.questions) && quiz.status === "draft") {
      normalized = [];
      for (let i = 0; i < patch.questions.length; i++) {
        const q = patch.questions[i];
        if (!q || !String(q.question_text || "").trim()) continue;
        const texts = normalizeFourOptions(q.options, "Question " + (i + 1));
        normalized.push({
          question_id: q.question_id || newId(),
          question_text: String(q.question_text).trim().slice(0, 1000),
          marks: Math.max(0.5, parseFloat(q.marks) || 1),
          options: texts.map((t, j) => ({ option_id: newId(), option_text: t, display_order: j })),
        });
      }
    }
    if (meta && meta.drive_quiz_file_id) {
      await driveStore.driveUpdateQuizJson(driveDb, teacher.emp_id, meta.drive_quiz_file_id, (cur) => {
        const next = {
          ...cur,
          title, subject, class_label, instructions,
          deadline: deadline ? new Date(deadline).toISOString() : null,
        };
        if (normalized) next.questions = normalized;
        return next;
      });
    } else if (Array.isArray(patch.questions) && quiz.status === "draft") {
      // legacy PG-only
      await replaceQuizQuestions(quiz_id, patch.questions);
    }
    await pool.query(`UPDATE quizzes SET title=$2, subject=$3, class_label=$4, instructions=$5, deadline=$6, updated_at=NOW() WHERE quiz_id=$1`,
      [quiz_id, title, subject || null, class_label || null, instructions || null, deadline]);
    return getQuiz(quiz_id);
  }

  async function publishQuiz(quiz_id, emp_id) {
    const quiz = await getQuiz(quiz_id);
    if (!quiz) throw new Error("Quiz not found.");
    const teacher = await findTeacher(emp_id);
    if (!teacher || String(quiz.emp_id).toLowerCase() !== String(teacher.emp_id).toLowerCase()) throw new Error("Not authorized.");
    if (!quiz.questions || quiz.questions.length < 1) throw new Error("Add at least one question before publishing.");
    if (!quiz.deadline) throw new Error("A deadline is required before publishing the quiz.");
    if (new Date(quiz.deadline).getTime() <= Date.now()) throw new Error("Deadline must be in the future when publishing.");
    for (const q of quiz.questions) {
      if (!q.options || q.options.length !== 4) throw new Error("Each question must have exactly 4 options before publishing.");
    }
    const meta = (await pool.query(`SELECT drive_quiz_file_id, emp_id FROM quizzes WHERE quiz_id=$1`, [quiz_id])).rows[0];
    if (meta && meta.drive_quiz_file_id) {
      await driveStore.driveUpdateQuizJson(driveDb, meta.emp_id, meta.drive_quiz_file_id, (cur) => ({
        ...cur,
        status: "open",
        published_at: cur.published_at || new Date().toISOString(),
      }));
    }
    await pool.query(`UPDATE quizzes SET status='open', published_at=COALESCE(published_at, NOW()), updated_at=NOW() WHERE quiz_id=$1`, [quiz_id]);
    return getQuiz(quiz_id);
  }

  async function closeQuiz(quiz_id, emp_id) {
    const metaR = await pool.query(`SELECT * FROM quizzes WHERE quiz_id = $1`, [quiz_id]);
    if (!metaR.rows.length) throw new Error("Quiz not found.");
    const meta = metaR.rows[0];
    const teacher = await findTeacher(emp_id);
    if (!teacher || String(meta.emp_id).toLowerCase() !== String(teacher.emp_id).toLowerCase()) throw new Error("Not authorized.");
    if (meta.drive_quiz_file_id) {
      await driveStore.driveUpdateQuizJson(driveDb, teacher.emp_id, meta.drive_quiz_file_id, (cur) => ({
        ...cur,
        status: "closed",
        closed_at: new Date().toISOString(),
      }));
    }
    await pool.query(`UPDATE quizzes SET status='closed', closed_at=NOW(), updated_at=NOW() WHERE quiz_id=$1`, [quiz_id]);
    return getQuiz(quiz_id, { includeCorrect: true });
  }

  async function deleteQuiz(quiz_id, emp_id) {
    const metaR = await pool.query(`SELECT * FROM quizzes WHERE quiz_id = $1`, [quiz_id]);
    if (!metaR.rows.length) throw new Error("Quiz not found.");
    const meta = metaR.rows[0];
    const teacher = await findTeacher(emp_id);
    if (!teacher || String(meta.emp_id).toLowerCase() !== String(teacher.emp_id).toLowerCase()) throw new Error("Not authorized.");
    if (meta.drive_folder_id) {
      try {
        const accessToken = await driveStore.getTeacherAccessToken(driveDb, teacher.emp_id);
        const gdrive = require("./googleDrive");
        await gdrive.deleteDriveFile(accessToken, meta.drive_folder_id);
      } catch (err) {
        const e = new Error(
          "Could not delete quiz folder from Google Drive: " +
            ((err && err.message) || "Drive error") +
            ". PostgreSQL record was not removed."
        );
        e.status = 503;
        throw e;
      }
    }
    const countRes = await pool.query(`SELECT COUNT(*)::int AS c FROM quiz_submissions WHERE quiz_id = $1`, [quiz_id]);
    await pool.query(`DELETE FROM quizzes WHERE quiz_id = $1`, [quiz_id]);
    return { ...meta, deleted_submissions: countRes.rows[0].c };
  }

  async function setQuizCorrectAnswers(quiz_id, emp_id, answers) {
    const meta = await pool.query(`SELECT * FROM quizzes WHERE quiz_id = $1`, [quiz_id]);
    if (!meta.rows.length) throw new Error("Quiz not found.");
    const row = meta.rows[0];
    const teacher = await findTeacher(emp_id);
    if (!teacher || String(row.emp_id).toLowerCase() !== String(teacher.emp_id).toLowerCase()) throw new Error("Not authorized.");
    if (!row.deadline) throw new Error("This quiz has no deadline. Correct answers cannot be set.");
    if (new Date(row.deadline).getTime() > Date.now()) {
      throw new Error("Correct answers can only be set after the quiz deadline has passed (server time). Closing the quiz early does not unlock this.");
    }
    if (!row.drive_quiz_file_id) throw new Error("Quiz has no Google Drive file. Reconnect Drive and recreate the quiz.");
    const ansList = Array.isArray(answers) ? answers : [];
    const correct_answers = {};
    for (const a of ansList) {
      if (a && a.question_id && a.correct_option_id) correct_answers[a.question_id] = a.correct_option_id;
    }
    await driveStore.driveUpdateQuizJson(driveDb, teacher.emp_id, row.drive_quiz_file_id, (cur) => {
      const next = { ...cur, correct_answers, status: "closed" };
      if (Array.isArray(next.questions)) {
        next.questions = next.questions.map((q) => ({
          ...q,
          correct_option_id: correct_answers[q.question_id] || q.correct_option_id || null,
        }));
      }
      return next;
    });
    await pool.query(`UPDATE quizzes SET status='closed', closed_at=COALESCE(closed_at, NOW()), updated_at=NOW() WHERE quiz_id=$1`, [quiz_id]);
    return getQuiz(quiz_id, { includeCorrect: true });
  }

  async function evaluateQuiz(quiz_id, emp_id) {
    const meta = await pool.query(`SELECT * FROM quizzes WHERE quiz_id = $1`, [quiz_id]);
    if (!meta.rows.length) throw new Error("Quiz not found.");
    const row = meta.rows[0];
    const teacher = await findTeacher(emp_id);
    if (!teacher || String(row.emp_id).toLowerCase() !== String(teacher.emp_id).toLowerCase()) throw new Error("Not authorized.");
    if (!row.deadline || new Date(row.deadline).getTime() > Date.now()) {
      throw new Error("Evaluation is only available after the quiz deadline.");
    }
    if (!row.drive_quiz_file_id || !row.drive_folder_id) {
      throw new Error("Quiz Drive files missing. Reconnect Google Drive.");
    }
    const driveQuiz = await driveStore.driveReadQuiz(driveDb, teacher.emp_id, row.drive_quiz_file_id);
    const questions = driveQuiz.questions || [];
    for (const q of questions) {
      const cid = q.correct_option_id || (driveQuiz.correct_answers && driveQuiz.correct_answers[q.question_id]);
      if (!cid) throw new Error("Set correct answers for all questions before evaluating.");
    }
    const totalMarks = questions.reduce((s, q) => s + Number(q.marks || 0), 0);
    const files = await driveStore.driveListSubmissions(driveDb, teacher.emp_id, row.drive_folder_id);
    const results = [];
    for (const f of files) {
      const sub = f.data || {};
      let scored = 0;
      const answerDetails = [];
      for (const q of questions) {
        const correctId = q.correct_option_id || (driveQuiz.correct_answers && driveQuiz.correct_answers[q.question_id]);
        const selected = (sub.answers && (sub.answers[q.question_id] || sub.answers[String(q.question_id)])) || null;
        const isCorrect = selected && correctId && String(selected) === String(correctId);
        const marks = isCorrect ? Number(q.marks) : 0;
        scored += marks;
        answerDetails.push({ question_id: q.question_id, selected_option_id: selected, correct_option_id: correctId, is_correct: !!isCorrect, marks_awarded: marks });
      }
      const pct = totalMarks > 0 ? Math.round((scored / totalMarks) * 10000) / 100 : 0;
      const updated = {
        ...sub,
        evaluated: true,
        scored_marks: scored,
        total_marks: totalMarks,
        percentage: pct,
        answer_details: answerDetails,
        evaluated_at: new Date().toISOString(),
      };
      await driveStore.driveSaveSubmission(driveDb, teacher.emp_id, row.drive_folder_id, updated);
      results.push({
        roll_no: sub.roll_no,
        student_name: sub.student_name || null,
        scored_marks: scored,
        total_marks: totalMarks,
        percentage: pct,
        submitted_at: sub.submitted_at,
        evaluated: true,
      });
    }
    await driveStore.driveWriteResults(driveDb, teacher.emp_id, row.drive_folder_id, {
      quiz_id,
      title: driveQuiz.title,
      evaluated_at: new Date().toISOString(),
      results,
    });
    await driveStore.driveUpdateQuizJson(driveDb, teacher.emp_id, row.drive_quiz_file_id, (cur) => ({
      ...cur,
      evaluated_at: new Date().toISOString(),
      status: "closed",
    }));
    await pool.query(`UPDATE quizzes SET evaluated_at=NOW(), status='closed', closed_at=COALESCE(closed_at, NOW()), updated_at=NOW() WHERE quiz_id=$1`, [quiz_id]);
    return { quiz: await getQuiz(quiz_id, { includeCorrect: true }), total: results.length, results };
  }

  async function publishQuizResults(quiz_id, emp_id) {
    const meta = await pool.query(`SELECT * FROM quizzes WHERE quiz_id = $1`, [quiz_id]);
    if (!meta.rows.length) throw new Error("Quiz not found.");
    const row = meta.rows[0];
    const teacher = await findTeacher(emp_id);
    if (!teacher || String(row.emp_id).toLowerCase() !== String(teacher.emp_id).toLowerCase()) throw new Error("Not authorized.");
    if (!row.deadline || new Date(row.deadline).getTime() > Date.now()) {
      throw new Error("Publishing is only available after the quiz deadline.");
    }
    if (!row.evaluated_at) {
      // Check Drive results exist
      if (row.drive_folder_id) {
        const dr = await driveStore.driveReadResults(driveDb, teacher.emp_id, row.drive_folder_id);
        if (!dr || !dr.results || !dr.results.length) {
          throw new Error("Evaluate submissions before publishing results.");
        }
      } else {
        throw new Error("Evaluate submissions before publishing results.");
      }
    }
    if (row.drive_quiz_file_id) {
      await driveStore.driveUpdateQuizJson(driveDb, teacher.emp_id, row.drive_quiz_file_id, (cur) => ({
        ...cur,
        results_published: true,
        status: "closed",
      }));
    }
    await pool.query(`UPDATE quizzes SET results_published=true, status='closed', closed_at=COALESCE(closed_at, NOW()), updated_at=NOW() WHERE quiz_id=$1`, [quiz_id]);
    return getQuiz(quiz_id, { includeCorrect: true });
  }

  async function submitQuizAttempt({ quiz_id, roll_no, student_name, answers }) {
    const meta = await pool.query(`SELECT * FROM quizzes WHERE quiz_id = $1`, [quiz_id]);
    if (!meta.rows.length) throw new Error("Quiz not found.");
    const row = meta.rows[0];
    if (row.status !== "open") throw new Error("This quiz is not open for attempts.");
    if (row.deadline && new Date(row.deadline) < new Date()) throw new Error("The deadline for this quiz has passed.");
    if (!row.drive_folder_id || !row.drive_quiz_file_id) {
      throw new Error("Quiz is not available on Google Drive. Ask your teacher to reconnect Drive.");
    }
    // Duplicate check via Drive
    const existing = await driveStore.driveGetSubmissionByRoll(driveDb, row.emp_id, row.drive_folder_id, roll_no);
    if (existing) throw new Error("You have already submitted this quiz.");
    const submission_id = newId();
    const payload = {
      submission_id,
      quiz_id,
      roll_no: String(roll_no).trim(),
      student_name: student_name || null,
      answers: answers || {},
      submitted_at: new Date().toISOString(),
      evaluated: false,
    };
    await driveStore.driveSaveSubmission(driveDb, row.emp_id, row.drive_folder_id, payload);
    // Minimal PG receipt for indexing only
    try {
      await pool.query(
        `INSERT INTO quiz_submissions (submission_id, quiz_id, roll_no, student_name, drive_file_id) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT DO NOTHING`,
        [submission_id, quiz_id, String(roll_no).trim(), student_name || null, null]
      );
    } catch (_) {}
    return { ok: true, submission_id };
  }

  async function listQuizResults(quiz_id, emp_id, { q = "", limit = 100, offset = 0 } = {}) {
    const meta = await pool.query(`SELECT * FROM quizzes WHERE quiz_id = $1`, [quiz_id]);
    if (!meta.rows.length) throw new Error("Quiz not found.");
    const row = meta.rows[0];
    const teacher = await findTeacher(emp_id);
    if (!teacher || String(row.emp_id).toLowerCase() !== String(teacher.emp_id).toLowerCase()) throw new Error("Not authorized.");
    const quiz = await getQuiz(quiz_id, { includeCorrect: !!(row.deadline && new Date(row.deadline) <= new Date()) });
    let results = [];
    if (row.drive_folder_id) {
      try {
        const driveRes = await driveStore.driveReadResults(driveDb, teacher.emp_id, row.drive_folder_id);
        if (driveRes && Array.isArray(driveRes.results)) {
          results = driveRes.results;
        } else {
          const files = await driveStore.driveListSubmissions(driveDb, teacher.emp_id, row.drive_folder_id);
          results = files.map((f) => ({
            roll_no: f.data.roll_no,
            student_name: f.data.student_name,
            scored_marks: f.data.scored_marks,
            total_marks: f.data.total_marks,
            percentage: f.data.percentage,
            submitted_at: f.data.submitted_at,
            evaluated: !!f.data.evaluated,
          }));
        }
      } catch (err) {
        const e = new Error(err.message || "Could not load results from Google Drive.");
        e.status = 503;
        throw e;
      }
    }
    if (q && String(q).trim()) {
      const qq = String(q).trim().toLowerCase();
      results = results.filter((r) =>
        String(r.roll_no || "").toLowerCase().includes(qq) ||
        String(r.student_name || "").toLowerCase().includes(qq)
      );
    }
    results.sort((a, b) => String(a.roll_no || "").localeCompare(String(b.roll_no || ""), undefined, { sensitivity: "base" }));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const lim = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
    return { quiz, total: results.length, results: results.slice(off, off + lim) };
  }

  async function getStudentQuizResult(quiz_id, roll_no) {
    const rowR = await pool.query(`SELECT * FROM quizzes WHERE quiz_id = $1`, [quiz_id]);
    if (!rowR.rows.length) return null;
    const row = rowR.rows[0];
    let subData = null;
    if (row.drive_folder_id) {
      try {
        const found = await driveStore.driveGetSubmissionByRoll(driveDb, row.emp_id, row.drive_folder_id, roll_no);
        if (found) subData = found.data;
      } catch (err) {
        const e = new Error(err.message || "Google Drive is unavailable.");
        e.status = 503;
        throw e;
      }
    }
    const meta = await getQuiz(quiz_id, { includeCorrect: false });
    if (!subData) {
      return { quiz: { quiz_id: row.quiz_id, title: meta.title, results_published: !!meta.results_published, status: meta.status }, submission: null };
    }
    if (!meta.results_published) {
      return {
        quiz: { quiz_id: meta.quiz_id, title: meta.title, results_published: false, status: meta.status },
        submission: { submitted_at: subData.submitted_at, evaluated: false },
        message: "Results will be available after the teacher evaluates and publishes them.",
      };
    }
    const quiz = await getQuiz(quiz_id, { includeCorrect: true });
    const answers = (subData.answer_details || []).map((a) => ({
      question_id: a.question_id,
      selected_option_id: a.selected_option_id,
      is_correct: a.is_correct,
      marks_awarded: a.marks_awarded,
    }));
    return {
      quiz: { quiz_id: quiz.quiz_id, title: quiz.title, results_published: true, status: quiz.status, questions: quiz.questions },
      submission: {
        roll_no: subData.roll_no,
        student_name: subData.student_name,
        submitted_at: subData.submitted_at,
        scored_marks: subData.scored_marks,
        total_marks: subData.total_marks,
        percentage: subData.percentage,
        evaluated: !!subData.evaluated,
      },
      answers,
    };
  }

  return {
    createFeedbackForm, getFeedbackForm, listFeedbackFormsByTeacher, listPublishedFeedbackForStudent,
    updateFeedbackForm, publishFeedbackForm, closeFeedbackForm, deleteFeedbackForm,
    submitAnonymousFeedback, hasStudentSubmittedFeedback, getFeedbackAggregates, listAllFeedbackFormsAdmin,
    assertStudentCanAccessQuiz, assertStudentCanAccessFeedback,
    createQuiz, getQuiz, listQuizzesByTeacher, listOpenQuizzesForStudent, updateQuiz, publishQuiz, closeQuiz, deleteQuiz,
    setQuizCorrectAnswers, evaluateQuiz, publishQuizResults, submitQuizAttempt, listQuizResults, getStudentQuizResult,
  };
};
