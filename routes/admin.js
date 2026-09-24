const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const rateLimit = require("../lib/rateLimit");
const mailer = require("../lib/mailer");

const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const name = String(file.originalname || "").toLowerCase();
    if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv")) return cb(null, true);
    cb(new Error("Only .xlsx, .xls, or .csv files are allowed."));
  },
});

router.use(requireAuth("admin"));

const adminActionLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Invitations (no code yet) -----------------------------------------
router.get("/invitations", async (req, res) => {
  try {
    if (req.query.q != null || req.query.limit != null || req.query.status) {
      return res.json(await db.searchInvitations({ q: req.query.q || "", status: req.query.status || "", limit: req.query.limit, offset: req.query.offset }));
    }
    const invitations = await db.listInvitations();
    res.json({ invitations, total: invitations.length });
  } catch (err) {
    console.error("[eduvault] Failed to list invitations:", err);
    res.status(500).json({ error: "Could not load invitations." });
  }
});

// Admin enters one email → send invitation only (code is sent later by employee)
router.post("/invitations", adminActionLimiter, async (req, res) => {
  try {
    const { email, department, emp_id, name } = req.body;
    if (!email || !EMAIL_RE.test(String(email).trim())) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (!mailer.isConfigured()) {
      return res.status(503).json({
        error: "Email isn't configured on this server (MAIL_USER / MAIL_APP_PASSWORD).",
      });
    }

    const invitation = await db.createInvitation({
      email,
      department,
      employee_id: emp_id,
      name,
    });

    const registerUrl =
      process.env.PUBLIC_REGISTER_URL ||
      `${req.protocol}://${req.get("host")}/teacher-register.html`;

    try {
      await mailer.sendInvitationEmail({
        to: String(email).trim(),
        name,
        registerUrl,
      });
    } catch (mailErr) {
      console.error("[eduvault] Failed to send invitation email:", mailErr.message);
      return res.status(502).json({
        error: "Could not send the invitation email right now. Please try again.",
      });
    }

    res.status(201).json({
      sent: true,
      message: `Invitation sent to ${String(email).trim()}. The employee must open the registration page and click "Send verification code" to receive the code.`,
      invitation,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/invitations/:id/revoke", adminActionLimiter, async (req, res) => {
  try {
    const invitation = await db.revokeInvitation(req.params.id);
    res.json({ invitation });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/invitations/:id", adminActionLimiter, async (req, res) => {
  try {
    const invitation = await db.deleteInvitation(req.params.id);
    res.json({ invitation, deleted: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/invitations/import-excel", adminActionLimiter, excelUpload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: "Upload an Excel file (.xlsx or .xls)." });
    if (!mailer.isConfigured()) return res.status(503).json({ error: "Email isn't configured on this server (MAIL_USER / MAIL_APP_PASSWORD)." });
    let workbook;
    try { workbook = XLSX.read(req.file.buffer, { type: "buffer" }); } catch (e) { return res.status(400).json({ error: "Could not parse Excel file." }); }
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return res.status(400).json({ error: "Excel file has no sheets." });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
    if (!rows.length) return res.status(400).json({ error: "Excel file has no data rows." });
    if (rows.length > 500) return res.status(400).json({ error: "Maximum 500 rows per import." });
    const normalizeKey = (k) => String(k || "").trim().toLowerCase().replace(/[_\s]+/g, "");
    const pick = (row, names) => {
      const map = {};
      for (const [k, v] of Object.entries(row)) map[normalizeKey(k)] = v;
      for (const n of names) {
        if (map[normalizeKey(n)] != null && String(map[normalizeKey(n)]).trim() !== "") return String(map[normalizeKey(n)]).trim();
      }
      return "";
    };
    const seenEmails = new Set();
    const preview = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const email = pick(row, ["email", "e-mail", "mail"]);
      const name = pick(row, ["name", "teachername", "fullname"]);
      const department = pick(row, ["department", "dept", "branch"]);
      const employee_id = pick(row, ["employeeid", "employee_id", "empid", "emp_id", "id"]);
      const item = { row: i + 2, email, name, department, employee_id, status: "ok", reason: "" };
      if (!email || !EMAIL_RE.test(email)) { item.status = "invalid"; item.reason = "Invalid email"; }
      else {
        const key = email.toLowerCase();
        if (seenEmails.has(key)) { item.status = "duplicate"; item.reason = "Duplicate email in file"; }
        else {
          seenEmails.add(key);
          const teachers = await db.searchTeachers({ q: email, limit: 5, offset: 0 });
          if ((teachers.teachers || []).some((t) => t.email && String(t.email).toLowerCase() === key)) {
            item.status = "registered"; item.reason = "Already registered teacher";
          } else {
            const activeInv = await db.findActiveInvitation(email);
            if (activeInv) { item.status = "existing_invite"; item.reason = "Active invitation already exists"; }
          }
        }
      }
      preview.push(item);
    }
    const confirm = String(req.body.confirm || req.query.confirm || "").toLowerCase() === "true";
    if (!confirm) {
      return res.json({ preview: true, rows: preview, summary: {
        total: preview.length, ok: preview.filter((r) => r.status === "ok").length,
        invalid: preview.filter((r) => r.status === "invalid").length,
        duplicate: preview.filter((r) => r.status === "duplicate").length,
        registered: preview.filter((r) => r.status === "registered").length,
        existing_invite: preview.filter((r) => r.status === "existing_invite").length,
      }});
    }
    const registerUrl = process.env.PUBLIC_REGISTER_URL || (req.protocol + "://" + req.get("host") + "/teacher-register.html");
    const report = { successful: 0, skipped: [], failed: [] };
    for (const item of preview.filter((r) => r.status === "ok")) {
      try {
        await db.createInvitation({ email: item.email, name: item.name, department: item.department, employee_id: item.employee_id });
        try {
          await mailer.sendInvitationEmail({ to: item.email, name: item.name, registerUrl });
          report.successful += 1;
        } catch (mailErr) {
          report.failed.push({ email: item.email, reason: "Email send error: " + (mailErr.message || "unknown") });
        }
      } catch (e) { report.failed.push({ email: item.email, reason: e.message || "Create failed" }); }
    }
    for (const item of preview) {
      if (item.status !== "ok") report.skipped.push({ email: item.email, reason: item.reason });
    }
    res.json({ preview: false, report, message: report.successful + " invitation(s) sent. " + report.skipped.length + " skipped. " + report.failed.length + " failed." });
  } catch (err) {
    console.error("[eduvault] import-excel:", err);
    res.status(400).json({ error: err.message || "Import failed." });
  }
});

// Keep enrollment-codes list for issued codes
router.get("/enrollment-codes", async (req, res) => {
  try {
    const codes = await db.listEnrollmentCodes();
    res.json({ codes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/enrollment-codes/:id/revoke", adminActionLimiter, async (req, res) => {
  try {
    const code = await db.revokeEnrollmentCode(req.params.id);
    res.json({ code });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Employees (teachers) ---------------------------------------------
router.get("/teachers", async (req, res) => {
  try {
    if (req.query.q != null || req.query.limit != null) {
      return res.json(await db.searchTeachers({ q: req.query.q || "", limit: req.query.limit, offset: req.query.offset }));
    }
    const teachers = await db.listAllTeachers();
    res.json({ teachers, total: teachers.length });
  } catch (err) {
    console.error("[eduvault] Failed to list teachers:", err);
    res.status(500).json({ error: "Could not load teachers." });
  }
});

router.patch("/teachers/:emp_id/active", adminActionLimiter, async (req, res) => {
  try {
    const teacher = await db.setTeacherActive(req.params.emp_id, req.body.active);
    res.json({ teacher });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch("/teachers/:emp_id/role", adminActionLimiter, async (req, res) => {
  try {
    const teacher = await db.setTeacherRole(req.params.emp_id, req.body.role);
    res.json({ teacher });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/teachers/:emp_id", adminActionLimiter, async (req, res) => {
  try {
    const teacher = await db.deleteTeacher(req.params.emp_id);
    res.json({ teacher });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Students ---------------------------------------------------------
router.get("/students", async (req, res) => {
  try {
    if (req.query.q != null || req.query.limit != null) {
      return res.json(await db.searchStudents({ q: req.query.q || "", limit: req.query.limit, offset: req.query.offset }));
    }
    const students = await db.listAllStudents();
    res.json({ students: Array.isArray(students) ? students : [], total: Array.isArray(students) ? students.length : 0 });
  } catch (err) {
    console.error("[eduvault] Failed to list students:", err);
    res.status(500).json({
      error: "Could not load students.",
      detail: process.env.NODE_ENV === "production" ? undefined : String(err.message || err),
    });
  }
});

router.patch("/students/:roll_no/active", adminActionLimiter, async (req, res) => {
  try {
    const student = await db.setStudentActive(req.params.roll_no, req.body.active);
    res.json({ student });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/students/:roll_no", adminActionLimiter, async (req, res) => {
  try {
    const student = await db.deleteStudent(req.params.roll_no);
    res.json({ student });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
