const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const rateLimit = require("../lib/rateLimit");
const { parseDeadlineInput } = require("../lib/datetime");
const actionLimiter = rateLimit({ windowMs: 60 * 1000, max: 40 });

router.get("/mine", requireAuth("teacher"), async (req, res) => {
  try { res.json({ quizzes: await db.listQuizzesByTeacher(req.auth.sub) }); }
  catch (e) { res.status(500).json({ error: "Could not load quizzes." }); }
});

router.get("/student/available", requireAuth("student"), async (req, res) => {
  try { res.json({ quizzes: await db.listOpenQuizzesForStudent(req.auth.sub) }); }
  catch (e) { res.status(500).json({ error: "Could not load quizzes." }); }
});

router.post("/", requireAuth("teacher"), actionLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    let questions = body.questions;
    if (typeof questions === "string") {
      try { questions = JSON.parse(questions); } catch (_) {
        return res.status(400).json({ error: "questions must be a valid JSON array." });
      }
    }
    if (questions != null && !Array.isArray(questions)) {
      return res.status(400).json({ error: "questions must be an array." });
    }
    const deadline = parseDeadlineInput(body.deadline);
    if (body.deadline && !deadline) {
      return res.status(400).json({ error: "Invalid deadline. Use a valid date/time." });
    }
    const quiz = await db.createQuiz({
      emp_id: req.auth.sub,
      title: body.title,
      subject: body.subject,
      class_label: body.class_label || body.class,
      instructions: body.instructions,
      deadline,
      questions,
    });
    res.json({ quiz, drive_backup_error: quiz.drive_backup_error || null });
  } catch (e) {
    const status = e.status || 400;
    res.status(status).json({ error: e.message || "Could not create quiz." });
  }
});

router.get("/:quiz_id", requireAuth(["teacher", "student", "admin"]), async (req, res) => {
  try {
    const quiz = await db.getQuiz(req.params.quiz_id, { includeCorrect: false });
    if (!quiz) return res.status(404).json({ error: "Quiz not found." });
    if (req.auth.role === "teacher" && String(quiz.emp_id).toLowerCase() !== String(req.auth.sub).toLowerCase()) {
      return res.status(403).json({ error: "Not authorized." });
    }
    if (req.auth.role === "student") {
      try {
        await db.assertStudentCanAccessQuiz(req.params.quiz_id, req.auth.sub);
      } catch (authErr) {
        return res.status(authErr.status || 403).json({ error: authErr.message || "Not authorized." });
      }
      if (quiz.status !== "open") return res.status(403).json({ error: "This quiz is not open." });
      if (!quiz.deadline || new Date(quiz.deadline) < new Date()) {
        return res.status(403).json({ error: "The deadline for this quiz has passed." });
      }
      return res.json({ quiz });
    }
    // Teacher: correct answers only after deadline
    const pastDeadline = quiz.deadline && new Date(quiz.deadline).getTime() <= Date.now();
    const full = await db.getQuiz(req.params.quiz_id, { includeCorrect: !!pastDeadline });
    return res.json({ quiz: full, can_set_correct_answers: !!pastDeadline });
  } catch (e) { res.status(500).json({ error: e.message || "Could not load quiz." }); }
});

router.put("/:quiz_id", requireAuth("teacher"), actionLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    let questions = body.questions;
    if (typeof questions === "string") {
      try { questions = JSON.parse(questions); } catch (_) {
        return res.status(400).json({ error: "questions must be a valid JSON array." });
      }
    }
    res.json({ quiz: await db.updateQuiz(req.params.quiz_id, req.auth.sub, {
      title: body.title,
      subject: body.subject,
      class_label: body.class_label || body.class,
      instructions: body.instructions,
      deadline: body.deadline !== undefined ? parseDeadlineInput(body.deadline) : undefined,
      questions,
    }) });
  } catch (e) { res.status(e.status || 400).json({ error: e.message || "Could not update quiz." }); }
});

router.post("/:quiz_id/publish", requireAuth("teacher"), actionLimiter, async (req, res) => {
  try { res.json({ quiz: await db.publishQuiz(req.params.quiz_id, req.auth.sub) }); }
  catch (e) { res.status(400).json({ error: e.message || "Could not publish quiz." }); }
});

router.post("/:quiz_id/close", requireAuth("teacher"), actionLimiter, async (req, res) => {
  try { res.json({ quiz: await db.closeQuiz(req.params.quiz_id, req.auth.sub) }); }
  catch (e) { res.status(400).json({ error: e.message || "Could not close quiz." }); }
});

router.delete("/:quiz_id", requireAuth("teacher"), actionLimiter, async (req, res) => {
  try { res.json({ deleted: true, quiz: await db.deleteQuiz(req.params.quiz_id, req.auth.sub) }); }
  catch (e) { res.status(400).json({ error: e.message || "Could not delete quiz." }); }
});

router.post("/:quiz_id/correct-answers", requireAuth("teacher"), actionLimiter, async (req, res) => {
  try { res.json({ quiz: await db.setQuizCorrectAnswers(req.params.quiz_id, req.auth.sub, (req.body && req.body.answers) || []) }); }
  catch (e) { res.status(400).json({ error: e.message || "Could not set correct answers." }); }
});

router.post("/:quiz_id/evaluate", requireAuth("teacher"), actionLimiter, async (req, res) => {
  try {
    const data = await db.evaluateQuiz(req.params.quiz_id, req.auth.sub);
    res.json({ ...data, results_published: false, message: "Evaluation complete. Students cannot see scores until you Publish Results." });
  } catch (e) { res.status(400).json({ error: e.message || "Could not evaluate quiz." }); }
});

router.post("/:quiz_id/publish-results", requireAuth("teacher"), actionLimiter, async (req, res) => {
  try { res.json({ quiz: await db.publishQuizResults(req.params.quiz_id, req.auth.sub) }); }
  catch (e) { res.status(400).json({ error: e.message || "Could not publish results." }); }
});

router.get("/:quiz_id/results", requireAuth("teacher"), async (req, res) => {
  try { res.json(await db.listQuizResults(req.params.quiz_id, req.auth.sub, { q: req.query.q || "", limit: req.query.limit, offset: req.query.offset })); }
  catch (e) { res.status(400).json({ error: e.message || "Could not load results." }); }
});

router.post("/:quiz_id/submit", requireAuth("student"), actionLimiter, async (req, res) => {
  try {
    await db.assertStudentCanAccessQuiz(req.params.quiz_id, req.auth.sub);
    const student = await db.findStudent(req.auth.sub);
    res.json(await db.submitQuizAttempt({ quiz_id: req.params.quiz_id, roll_no: req.auth.sub, student_name: student ? student.name : null, answers: (req.body && req.body.answers) || {} }));
  } catch (e) { res.status(e.status || 400).json({ error: e.message || "Could not submit quiz." }); }
});

router.get("/:quiz_id/results/:roll_no", requireAuth("teacher"), async (req, res) => {
  try {
    const data = await db.listQuizResults(req.params.quiz_id, req.auth.sub, { q: req.params.roll_no, limit: 5, offset: 0 });
    const row = (data.results || []).find((r) => String(r.roll_no).toUpperCase() === String(req.params.roll_no).toUpperCase());
    if (!row) return res.status(404).json({ error: "Submission not found." });
    const detail = await db.getStudentQuizResult(req.params.quiz_id, row.roll_no);
    // Teacher can see answers after evaluation even before student-facing publish
    res.json({ quiz: data.quiz, submission: row, detail });
  } catch (e) { res.status(e.status || 400).json({ error: e.message || "Could not load answers." }); }
});

router.get("/:quiz_id/my-result", requireAuth("student"), async (req, res) => {
  try {
    await db.assertStudentCanAccessQuiz(req.params.quiz_id, req.auth.sub);
    const data = await db.getStudentQuizResult(req.params.quiz_id, req.auth.sub);
    if (!data) return res.status(404).json({ error: "Not found." });
    res.json(data);
  } catch (e) { res.status(e.status || 500).json({ error: e.message || "Could not load result." }); }
});

module.exports = router;
