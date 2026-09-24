const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const rateLimit = require("../lib/rateLimit");
const { parseDeadlineInput } = require("../lib/datetime");
const actionLimiter = rateLimit({ windowMs: 60 * 1000, max: 40 });

router.get("/mine", requireAuth("teacher"), async (req, res) => {
  try { res.json({ forms: await db.listFeedbackFormsByTeacher(req.auth.sub) }); }
  catch (e) { res.status(500).json({ error: "Could not load feedback forms." }); }
});

router.get("/student/available", requireAuth("student"), async (req, res) => {
  try {
    const forms = await db.listPublishedFeedbackForStudent(req.auth.sub);
    const withFlags = [];
    for (const f of forms) {
      withFlags.push({ ...f, already_submitted: await db.hasStudentSubmittedFeedback(f.form_id, req.auth.sub) });
    }
    res.json({ forms: withFlags });
  } catch (e) { res.status(500).json({ error: "Could not load feedback forms." }); }
});

router.get("/admin/list", requireAuth("admin"), async (req, res) => {
  try {
    res.json(await db.listAllFeedbackFormsAdmin({ q: req.query.q || "", emp_id: req.query.emp_id || "", limit: req.query.limit, offset: req.query.offset }));
  } catch (e) { res.status(500).json({ error: e.message || "Could not list feedback." }); }
});

router.post("/", requireAuth("teacher"), actionLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const form = await db.createFeedbackForm({ emp_id: req.auth.sub, title: body.title, subject: body.subject, class_label: body.class_label || body.class, deadline: parseDeadlineInput(body.deadline), questions: body.questions });
    res.json({ form });
  } catch (e) { res.status(400).json({ error: e.message || "Could not create feedback form." }); }
});

router.get("/:form_id", requireAuth(["teacher", "admin", "student"]), async (req, res) => {
  try {
    const form = await db.getFeedbackForm(req.params.form_id);
    if (!form) return res.status(404).json({ error: "Feedback form not found." });
    if (req.auth.role === "teacher" && String(form.emp_id).toLowerCase() !== String(req.auth.sub).toLowerCase()) return res.status(403).json({ error: "Not authorized." });
    if (req.auth.role === "student") {
      try {
        await db.assertStudentCanAccessFeedback(req.params.form_id, req.auth.sub);
      } catch (authErr) {
        return res.status(authErr.status || 403).json({ error: authErr.message || "Not authorized." });
      }
      if (form.status !== "open") return res.status(403).json({ error: "This feedback form is not available." });
      return res.json({ form: { form_id: form.form_id, title: form.title, subject: form.subject, class_label: form.class_label, deadline: form.deadline, status: form.status, questions: form.questions }, already_submitted: await db.hasStudentSubmittedFeedback(form.form_id, req.auth.sub) });
    }
    res.json({ form });
  } catch (e) { res.status(500).json({ error: e.message || "Could not load form." }); }
});

router.put("/:form_id", requireAuth("teacher"), actionLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    res.json({ form: await db.updateFeedbackForm(req.params.form_id, req.auth.sub, { title: body.title, subject: body.subject, class_label: body.class_label || body.class, deadline: body.deadline !== undefined ? parseDeadlineInput(body.deadline) : undefined, questions: body.questions }) });
  } catch (e) { res.status(400).json({ error: e.message || "Could not update form." }); }
});

router.post("/:form_id/publish", requireAuth("teacher"), actionLimiter, async (req, res) => {
  try { res.json({ form: await db.publishFeedbackForm(req.params.form_id, req.auth.sub) }); }
  catch (e) { res.status(400).json({ error: e.message || "Could not publish." }); }
});

router.post("/:form_id/close", requireAuth("teacher"), actionLimiter, async (req, res) => {
  try { res.json({ form: await db.closeFeedbackForm(req.params.form_id, req.auth.sub) }); }
  catch (e) { res.status(400).json({ error: e.message || "Could not close." }); }
});

router.delete("/:form_id", requireAuth("teacher"), actionLimiter, async (req, res) => {
  try { res.json({ form: await db.deleteFeedbackForm(req.params.form_id, req.auth.sub), deleted: true }); }
  catch (e) { res.status(400).json({ error: e.message || "Could not delete." }); }
});

router.get("/:form_id/results", requireAuth(["teacher", "admin"]), async (req, res) => {
  try {
    const form = await db.getFeedbackForm(req.params.form_id);
    if (!form) return res.status(404).json({ error: "Not found." });
    if (req.auth.role === "teacher" && String(form.emp_id).toLowerCase() !== String(req.auth.sub).toLowerCase()) return res.status(403).json({ error: "Not authorized." });
    res.json(await db.getFeedbackAggregates(req.params.form_id));
  } catch (e) { res.status(500).json({ error: e.message || "Could not load results." }); }
});

router.post("/:form_id/submit", requireAuth("student"), actionLimiter, async (req, res) => {
  try {
    await db.assertStudentCanAccessFeedback(req.params.form_id, req.auth.sub);
    const body = req.body || {};
    res.json(await db.submitAnonymousFeedback({ form_id: req.params.form_id, roll_no: req.auth.sub, answers: body.answers, comment_text: body.comment_text || body.comment }));
  } catch (e) { res.status(e.status || 400).json({ error: e.message || "Could not submit feedback." }); }
});

module.exports = router;
