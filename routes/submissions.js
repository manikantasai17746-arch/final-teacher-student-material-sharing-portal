const express = require("express");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const router = express.Router();
const db = require("../db");
const { requireAuth, getAuthFromRequest } = require("../lib/auth");
const rateLimit = require("../lib/rateLimit");
const { toSafeFilename } = require("../lib/filename");
const gdrive = require("../lib/googleDrive");

const TEMP_DIR = path.join(os.tmpdir(), "eduvault-submissions-tmp");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const DEFAULT_EXT = [
  ".pdf",
  ".ppt",
  ".pptx",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".txt",
  ".jpg",
  ".jpeg",
  ".png",
  ".zip",
];

const tempStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".bin";
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

function makeUpload(maxFiles, maxSizeMb) {
  return multer({
    storage: tempStorage,
    limits: {
      fileSize: Math.max(1, maxSizeMb || 25) * 1024 * 1024,
      files: Math.max(1, maxFiles || 5),
    },
  });
}

const teacherLimiter = rateLimit({ windowMs: 60 * 1000, max: 40 });
const publicGetLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const publicPostLimiter = rateLimit({ windowMs: 60 * 1000, max: 15 });

function parseAllowedExt(str) {
  if (!str) return new Set(DEFAULT_EXT);
  return new Set(
    String(str)
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.startsWith("."))
  );
}

function cleanupFiles(files) {
  if (!files) return;
  const list = Array.isArray(files) ? files : [files];
  for (const f of list) {
    if (f && f.path) fs.promises.unlink(f.path).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Teacher: create / list / get / update / delete submission requests
// ---------------------------------------------------------------------------

router.post(
  "/requests",
  teacherLimiter,
  requireAuth(["teacher", "admin"]),
  async (req, res) => {
    try {
      const body = req.body || {};
      const request = await db.createSubmissionRequest({
        emp_id: req.auth.sub,
        title: body.title,
        description: body.description,
        deadline: body.deadline,
        allow_multiple: !!body.allow_multiple,
        max_files: body.max_files,
        max_file_size_mb: body.max_file_size_mb,
        allowed_extensions: body.allowed_extensions,
        fields: body.fields,
      });
      return res.status(201).json({ request });
    } catch (e) {
      console.error("[eduvault] create submission request:", e.message);
      return res.status(400).json({ error: e.message || "Could not create request." });
    }
  }
);

router.get(
  "/requests",
  teacherLimiter,
  requireAuth(["teacher", "admin"]),
  async (req, res) => {
    try {
      const list = await db.listSubmissionRequestsByTeacher(req.auth.sub);
      return res.json({ requests: list });
    } catch (e) {
      console.error("[eduvault] list submission requests:", e.message);
      return res.status(500).json({ error: "Could not load submission requests." });
    }
  }
);

router.get(
  "/requests/:id",
  teacherLimiter,
  requireAuth(["teacher", "admin"]),
  async (req, res) => {
    try {
      const request = await db.getSubmissionRequest(req.params.id);
      if (!request) return res.status(404).json({ error: "Request not found." });
      if (request.emp_id !== req.auth.sub) {
        return res.status(403).json({ error: "Not authorized." });
      }
      return res.json({ request });
    } catch (e) {
      return res.status(500).json({ error: "Could not load request." });
    }
  }
);

router.patch(
  "/requests/:id",
  teacherLimiter,
  requireAuth(["teacher", "admin"]),
  async (req, res) => {
    try {
      const request = await db.updateSubmissionRequest(req.params.id, req.auth.sub, req.body || {});
      return res.json({ request });
    } catch (e) {
      const status = /not authorized/i.test(e.message) ? 403 : 400;
      return res.status(status).json({ error: e.message || "Could not update request." });
    }
  }
);

router.delete(
  "/requests/:id",
  teacherLimiter,
  requireAuth(["teacher", "admin"]),
  async (req, res) => {
    try {
      await db.deleteSubmissionRequest(req.params.id, req.auth.sub);
      return res.json({ ok: true });
    } catch (e) {
      const status = /not authorized/i.test(e.message) ? 403 : 400;
      return res.status(status).json({ error: e.message || "Could not delete request." });
    }
  }
);

router.get(
  "/requests/:id/submissions",
  teacherLimiter,
  requireAuth(["teacher", "admin"]),
  async (req, res) => {
    try {
      const data = await db.listSubmissionsForRequest(req.params.id, req.auth.sub);
      if (!data) return res.status(404).json({ error: "Request not found." });
      return res.json(data);
    } catch (e) {
      const status = /not authorized/i.test(e.message) ? 403 : 500;
      return res.status(status).json({ error: e.message || "Could not load submissions." });
    }
  }
);

router.get(
  "/:submissionId/detail",
  teacherLimiter,
  requireAuth(["teacher", "admin"]),
  async (req, res) => {
    try {
      const data = await db.getSubmissionDetail(req.params.submissionId, req.auth.sub);
      if (!data) return res.status(404).json({ error: "Submission not found." });
      return res.json(data);
    } catch (e) {
      const status = /not authorized/i.test(e.message) ? 403 : 500;
      return res.status(status).json({ error: e.message || "Could not load submission." });
    }
  }
);

/**
 * GET /api/submissions/files/:fileId/download
 * Teacher-only: stream a submission file from the teacher's Google Drive
 * through EduVault (authorized identity from session).
 */
router.get(
  "/files/:fileId/download",
  teacherLimiter,
  requireAuth(["teacher", "admin"]),
  async (req, res) => {
    try {
      const file = await db.getSubmissionFileWithOwner(req.params.fileId);
      if (!file) {
        return res.status(404).json({ error: "File not found." });
      }
      if (file.teacher_emp_id !== req.auth.sub) {
        return res.status(403).json({ error: "Not authorized to access this file." });
      }
      if (!file.drive_file_id) {
        return res.status(404).json({ error: "File is not stored in Google Drive." });
      }
      const driveRow = await db.getTeacherGoogleDrive(req.auth.sub);
      if (!driveRow) {
        return res.status(503).json({
          error: "Please connect Google Drive to download submission files.",
        });
      }
      const { accessToken } = await gdrive.getValidAccessToken(driveRow, db);
      const { contentDisposition } = require("../lib/filename");
      const safeName = gdrive.sanitizeDriveName(file.original_name || "file");
      await gdrive.streamFileToResponse(accessToken, file.drive_file_id, res, {
        contentType: file.mime_type || "application/octet-stream",
        contentDispositionHeader: contentDisposition("attachment", safeName),
      });
    } catch (e) {
      console.error("[eduvault] submission file download:", e.message);
      if (!res.headersSent) {
        return res.status(e.status || 500).json({
          error: e.message || "Could not download file.",
        });
      }
    }
  }
);

// ---------------------------------------------------------------------------
// Public form by token
// ---------------------------------------------------------------------------

router.get("/form/:token", publicGetLimiter, async (req, res) => {
  try {
    const request = await db.getSubmissionRequestByToken(req.params.token);
    if (!request) return res.status(404).json({ error: "Submission form not found." });

    const teacher = await db.findTeacher(request.emp_id);
    const now = Date.now();
    const deadlineMs = request.deadline ? new Date(request.deadline).getTime() : null;
    const closed = !request.active || (deadlineMs != null && now > deadlineMs);

    // Optional prefill if student is logged in
    let student = null;
    const auth = getAuthFromRequest(req);
    if (auth && auth.role === "student") {
      const s = await db.findStudent(auth.sub);
      if (s) student = { roll_no: s.roll_no, name: s.name };
    }

    return res.json({
      form: {
        title: request.title,
        description: request.description,
        deadline: request.deadline,
        active: request.active,
        closed,
        max_files: request.max_files,
        max_file_size_mb: request.max_file_size_mb,
        allowed_extensions: request.allowed_extensions,
        allow_multiple: request.allow_multiple,
        fields: (request.fields || []).map((f) => ({
          field_id: f.field_id,
          field_type: f.field_type,
          label: f.label,
          required: f.required,
          display_order: f.display_order,
        })),
        teacher_name: teacher ? teacher.name : null,
      },
      student,
    });
  } catch (e) {
    console.error("[eduvault] get form:", e.message);
    return res.status(500).json({ error: "Could not load form." });
  }
});

router.post("/form/:token", publicPostLimiter, (req, res) => {
  // Use a generous multer first; request-specific limits enforced after we load the request
  const upload = makeUpload(10, 200);
  upload.array("files", 10)(req, res, async (err) => {
    if (err) {
      cleanupFiles(req.files);
      return res.status(400).json({
        error:
          err.code === "LIMIT_FILE_SIZE"
            ? "File is too large."
            : err.message || "Upload failed.",
      });
    }

    const files = req.files || [];
    try {
      const request = await db.getSubmissionRequestByToken(req.params.token);
      if (!request) {
        cleanupFiles(files);
        return res.status(404).json({ error: "Submission form not found." });
      }

      if (!request.active) {
        cleanupFiles(files);
        return res.status(403).json({ error: "This submission form is closed." });
      }
      if (request.deadline && Date.now() > new Date(request.deadline).getTime()) {
        cleanupFiles(files);
        return res.status(403).json({ error: "Submission closed. The deadline has passed." });
      }

      const allowed = parseAllowedExt(request.allowed_extensions);
      const maxFiles = request.max_files || 1;
      const maxBytes = (request.max_file_size_mb || 25) * 1024 * 1024;

      if (files.length > maxFiles) {
        cleanupFiles(files);
        return res.status(400).json({
          error: `You may upload at most ${maxFiles} file(s).`,
        });
      }

      for (const f of files) {
        const ext = path.extname(f.originalname || "").toLowerCase();
        if (!allowed.has(ext)) {
          cleanupFiles(files);
          return res.status(400).json({
            error: `File type ${ext || "(none)"} is not allowed. Allowed: ${[...allowed].join(", ")}`,
          });
        }
        if (f.size > maxBytes) {
          cleanupFiles(files);
          return res.status(400).json({
            error: `File exceeds the maximum size of ${request.max_file_size_mb} MB.`,
          });
        }
      }

      // Parse answers (JSON string field or individual fields)
      let answers = {};
      if (req.body.answers) {
        try {
          answers =
            typeof req.body.answers === "string"
              ? JSON.parse(req.body.answers)
              : req.body.answers;
        } catch {
          answers = {};
        }
      }
      // Also accept flat body keys matching field labels / ids
      for (const f of request.fields || []) {
        if (req.body[f.field_id] != null) answers[f.field_id] = String(req.body[f.field_id]);
        else if (req.body[f.label] != null) answers[f.field_id] = String(req.body[f.label]);
      }

      // Validate required fields (file upload fields are validated via files array)
      for (const f of request.fields || []) {
        if (!f.required) continue;
        if (f.field_type === "file" || f.field_type === "file_upload") {
          if (!files.length) {
            cleanupFiles(files);
            return res.status(400).json({ error: `"${f.label}" is required.` });
          }
          continue;
        }
        const val = answers[f.field_id];
        if (val == null || String(val).trim() === "") {
          cleanupFiles(files);
          return res.status(400).json({ error: `"${f.label}" is required.` });
        }
      }

      // Identity: prefer logged-in student; otherwise use submitted name/roll
      let roll_no = null;
      let student_name = null;
      const auth = getAuthFromRequest(req);
      if (auth && auth.role === "student") {
        const s = await db.findStudent(auth.sub);
        if (s) {
          roll_no = s.roll_no;
          student_name = s.name;
        }
      }
      if (!student_name) {
        // Try common field types
        for (const f of request.fields || []) {
          if (f.field_type === "student_name" || /name/i.test(f.label)) {
            student_name = answers[f.field_id] || student_name;
          }
          if (f.field_type === "roll_number" || /roll/i.test(f.label)) {
            roll_no = answers[f.field_id] || roll_no;
          }
        }
        student_name =
          student_name ||
          req.body.student_name ||
          req.body.name ||
          null;
        roll_no = roll_no || req.body.roll_no || req.body.roll_number || null;
      }

      // Duplicate handling
      if (!request.allow_multiple && roll_no) {
        const existing = await db.findExistingSubmission(request.request_id, roll_no);
        if (existing && req.body.replace !== "1" && req.body.replace !== true) {
          cleanupFiles(files);
          return res.status(409).json({
            error: "You have already submitted. Send replace=1 to replace your previous submission.",
            existing_submission_id: existing.submission_id,
            can_replace: true,
          });
        }
        if (existing && (req.body.replace === "1" || req.body.replace === true)) {
          // Delete previous record only after new upload succeeds — mark for later
          req._replaceSubmissionId = existing.submission_id;
        }
      }

      // Submissions require the teacher's Google Drive — no silent local/S3 fallback
      if (!gdrive.isConfigured()) {
        cleanupFiles(files);
        return res.status(503).json({
          error: "Teacher storage is not configured. Please contact the teacher.",
        });
      }
      const driveRow = await db.getTeacherGoogleDrive(request.emp_id);
      if (!driveRow) {
        cleanupFiles(files);
        return res.status(503).json({
          error: "Teacher storage is not configured. Please contact the teacher.",
        });
      }

      let driveFolderId = request.drive_folder_id || null;
      let accessToken;
      try {
        const tok = await gdrive.getValidAccessToken(driveRow, db);
        accessToken = tok.accessToken;
        let submissionsRoot = driveRow.submissions_folder_id;
        if (!submissionsRoot) {
          const folders = await gdrive.ensureEduVaultFolders(accessToken);
          await db.updateTeacherGoogleDriveFolders(request.emp_id, folders);
          submissionsRoot = folders.submissions_folder_id;
        }
        if (!driveFolderId) {
          const folder = await gdrive.ensureFolder(
            accessToken,
            gdrive.sanitizeDriveName(request.title, "Submission"),
            submissionsRoot
          );
          driveFolderId = folder.id;
          await db.updateSubmissionRequest(request.request_id, request.emp_id, {
            drive_folder_id: driveFolderId,
          });
        }
      } catch (driveErr) {
        console.error("[eduvault] Drive prep for submission:", driveErr.message);
        cleanupFiles(files);
        return res.status(502).json({
          error: "Teacher storage is not configured. Please contact the teacher.",
        });
      }

      // Track every Drive file ID uploaded in this attempt so we can roll back
      // on any later failure (DB error or a subsequent file upload failure).
      const uploadedDriveIds = [];
      const uploadedMeta = [];

      // If replacing, load old Drive file IDs now (delete only after new success).
      let oldDriveFileIds = [];
      if (req._replaceSubmissionId) {
        try {
          const oldFiles = await db.listSubmissionFiles(req._replaceSubmissionId);
          oldDriveFileIds = (oldFiles || [])
            .map((f) => f.drive_file_id)
            .filter(Boolean);
        } catch (listErr) {
          console.warn("[eduvault] could not list old submission files:", listErr.message);
        }
      }

      const rollbackNewDriveUploads = async () => {
        if (uploadedDriveIds.length && accessToken) {
          await gdrive.deleteDriveFilesBestEffort(accessToken, uploadedDriveIds);
        }
      };

      try {
        for (const f of files) {
          const safeOriginal = toSafeFilename
            ? toSafeFilename(f.originalname)
            : path.basename(f.originalname || "file").replace(/[^\w.\-()+ ]/g, "_");
          const displayName = (() => {
            // Prefer authenticated student roll number; never invent identity.
            const roll = (roll_no && String(roll_no).trim()) || "unknown";
            const baseName = path.basename(safeOriginal || f.originalname || "file");
            const ext = path.extname(baseName);
            const stem = path.basename(baseName, ext) || "file";
            // Collision-safe index among files in this submission batch
            const idx = String(uploadedMeta.length + 1).padStart(2, "0");
            // Format: <ROLL>_<NN>_<originalStem><ext>
            return gdrive.sanitizeDriveName(`${roll}_${idx}_${stem}${ext}`, `${roll}_${idx}${ext || ".bin"}`);
          })();

          let uploaded;
          try {
            uploaded = await gdrive.uploadFile(accessToken, {
              localPath: f.path,
              filename: displayName,
              mimeType: f.mimetype,
              parentFolderId: driveFolderId,
            });
          } catch (upErr) {
            console.error("[eduvault] Drive upload failed:", upErr.message);
            await rollbackNewDriveUploads();
            cleanupFiles(files);
            return res.status(502).json({
              error:
                "Could not store your file in the teacher's Google Drive. Please try again later.",
            });
          }

          if (uploaded && uploaded.id) {
            uploadedDriveIds.push(uploaded.id);
          }
          uploadedMeta.push({
            original_name: f.originalname,
            mime_type: f.mimetype,
            size_bytes: f.size,
            drive_file_id: uploaded.id,
            drive_web_url: uploaded.webViewLink || null,
            storage_key: null,
          });
        }

        // All Drive uploads succeeded — create submission + file rows in ONE
        // PostgreSQL transaction. On any DB failure: ROLLBACK then delete the
        // newly uploaded Drive files. Old submission (if replacing) stays intact.
        let record;
        try {
          const result = await db.createSubmissionWithFiles({
            request_id: request.request_id,
            roll_no,
            student_name,
            answers_json: answers,
            drive_folder_id: driveFolderId,
            files: uploadedMeta,
          });
          record = result.submission;
        } catch (dbErr) {
          console.error("[eduvault] submission DB transaction failed:", dbErr.message);
          await rollbackNewDriveUploads();
          cleanupFiles(files);
          return res.status(500).json({
            error: "Could not save submission. Please try again.",
          });
        }

        // Transaction committed. Only now remove the previous submission.
        if (req._replaceSubmissionId) {
          try {
            await db.deleteSubmissionRecord(req._replaceSubmissionId);
          } catch (delErr) {
            console.warn(
              "[eduvault] failed to delete old submission record:",
              delErr.message
            );
          }
          if (oldDriveFileIds.length) {
            await gdrive.deleteDriveFilesBestEffort(accessToken, oldDriveFileIds);
          }
        }

        cleanupFiles(files);

        return res.status(201).json({
          ok: true,
          message: "Submission successful.",
          submission_id: record.submission_id,
          submitted_at: record.submitted_at,
        });
      } catch (innerErr) {
        console.error("[eduvault] submit form inner:", innerErr);
        await rollbackNewDriveUploads();
        cleanupFiles(files);
        return res.status(500).json({
          error: innerErr.message || "Submission failed. Please try again.",
        });
      }
    } catch (e) {
      console.error("[eduvault] submit form:", e);
      cleanupFiles(files);
      return res.status(500).json({
        error: e.message || "Submission failed. Please try again.",
      });
    }
  });
});


/**
 * GET /api/submissions/files/:fileId/view
 * Teacher-only inline stream (PDF/images) via Drive — no tokens to client.
 */
router.get(
  "/files/:fileId/view",
  teacherLimiter,
  requireAuth(["teacher", "admin"]),
  async (req, res) => {
    try {
      const file = await db.getSubmissionFileWithOwner(req.params.fileId);
      if (!file) return res.status(404).json({ error: "File not found." });
      if (file.teacher_emp_id !== req.auth.sub) {
        return res.status(403).json({ error: "Not authorized to access this file." });
      }
      if (!file.drive_file_id) {
        return res.status(404).json({ error: "File is not stored in Google Drive." });
      }
      const driveRow = await db.getTeacherGoogleDrive(req.auth.sub);
      if (!driveRow) {
        return res.status(503).json({ error: "Please connect Google Drive." });
      }
      const { accessToken } = await gdrive.getValidAccessToken(driveRow, db);
      const { contentDisposition } = require("../lib/filename");
      const safeName = gdrive.sanitizeDriveName(file.original_name || "file");
      const ext = path.extname(safeName).toLowerCase();
      const inlineOk = new Set([".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".txt"]);
      await gdrive.streamFileToResponse(accessToken, file.drive_file_id, res, {
        contentType: file.mime_type || "application/octet-stream",
        contentDispositionHeader: contentDisposition(
          inlineOk.has(ext) ? "inline" : "attachment",
          safeName
        ),
      });
    } catch (e) {
      console.error("[eduvault] submission file view:", e.message);
      if (!res.headersSent) {
        return res.status(e.status || 500).json({ error: e.message || "Could not view file." });
      }
    }
  }
);

/**
 * POST /api/submissions/requests/:id/archive
 * Body: { mode: "backup_delete" | "delete_only" }
 * Teacher-only. Verifies ownership. Never touches Materials or other requests.
 */
router.post(
  "/requests/:id/archive",
  teacherLimiter,
  requireAuth(["teacher", "admin"]),
  async (req, res) => {
    const os = require("os");
    const fs = require("fs");
    const crypto = require("crypto");
    const mode = (req.body && req.body.mode) || "";
    if (mode !== "backup_delete" && mode !== "delete_only") {
      return res.status(400).json({
        error: 'mode must be "backup_delete" or "delete_only".',
      });
    }

    let tempZipPath = null;
    let tempDir = null;
    try {
      const request = await db.getSubmissionRequest(req.params.id);
      if (!request) return res.status(404).json({ error: "Request not found." });
      if (request.emp_id !== req.auth.sub) {
        return res.status(403).json({ error: "Not authorized." });
      }

      // Collect ONLY files belonging to this request via DB (never trust client file IDs)
      const listed = await db.listSubmissionsForRequest(request.request_id, req.auth.sub);
      const submissions = (listed && listed.submissions) || [];
      const allFiles = [];
      for (const sub of submissions) {
        const files = await db.listSubmissionFiles(sub.submission_id);
        for (const f of files) {
          if (f.drive_file_id) allFiles.push({ ...f, roll_no: sub.roll_no, student_name: sub.student_name });
        }
      }

      if (!allFiles.length) {
        return res.json({
          ok: true,
          message: "No Google Drive files found for this request.",
          deleted: 0,
          failed: [],
        });
      }

      const driveRow = await db.getTeacherGoogleDrive(req.auth.sub);
      if (!driveRow) {
        return res.status(503).json({ error: "Please connect Google Drive first." });
      }
      const { accessToken } = await gdrive.getValidAccessToken(driveRow, db);

      // ---- backup_delete: download all first, build ZIP, only then delete ----
      if (mode === "backup_delete") {
        tempDir = path.join(os.tmpdir(), "eduvault-archive-" + crypto.randomUUID());
        fs.mkdirSync(tempDir, { recursive: true });
        const downloaded = [];

        for (const f of allFiles) {
          const safeOrig = gdrive.sanitizeDriveName(f.original_name || "file");
          const roll = (f.roll_no && String(f.roll_no).trim()) || "unknown";
          const entryName = gdrive.sanitizeDriveName(`${roll}_${safeOrig}`, safeOrig);
          const localPath = path.join(tempDir, `${crypto.randomUUID()}_${entryName}`);
          try {
            await gdrive.downloadFileToPath(accessToken, f.drive_file_id, localPath);
            downloaded.push({ localPath, entryName, file_id: f.file_id, drive_file_id: f.drive_file_id });
          } catch (dlErr) {
            console.error("[eduvault] archive download failed:", f.drive_file_id, dlErr.message);
            // Abort entirely — do not delete anything
            try {
              fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (_) {}
            return res.status(502).json({
              error:
                "Could not download all files for the backup. No Google Drive files were deleted. " +
                (dlErr.message || ""),
            });
          }
        }

        // Build ZIP
        tempZipPath = path.join(os.tmpdir(), `eduvault-request-${request.request_id}-${Date.now()}.zip`);
        try {
          await gdrive.createZipFromFiles(downloaded.map((d) => ({ path: d.localPath, name: d.entryName })), tempZipPath);
          const st = fs.statSync(tempZipPath);
          if (!st.size || st.size < 22) {
            throw new Error("ZIP archive is empty or invalid.");
          }
        } catch (zipErr) {
          console.error("[eduvault] zip failed:", zipErr.message);
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
          try { if (tempZipPath) fs.unlinkSync(tempZipPath); } catch (_) {}
          return res.status(500).json({
            error: "Could not create backup ZIP. No Google Drive files were deleted.",
          });
        }

        // ZIP is valid — now delete Drive files
        const failed = [];
        let deleted = 0;
        for (const d of downloaded) {
          try {
            await gdrive.deleteDriveFile(accessToken, d.drive_file_id);
            deleted += 1;
            // Clear drive ids in metadata (keep submission records)
            await db.clearSubmissionFileDriveIds(d.file_id);
          } catch (delErr) {
            failed.push({ drive_file_id: d.drive_file_id, error: delErr.message });
          }
        }

        // Stream ZIP to teacher
        const zipName = gdrive.sanitizeDriveName(
          `EduVault_Archive_${request.title || request.request_id}.zip`,
          "archive.zip"
        );
        const { contentDisposition } = require("../lib/filename");
        res.set("Content-Type", "application/zip");
        res.set("Content-Disposition", contentDisposition("attachment", zipName));
        res.set("X-EduVault-Deleted", String(deleted));
        res.set("X-EduVault-Failed", String(failed.length));
        const stream = fs.createReadStream(tempZipPath);
        stream.on("close", () => {
          try { fs.unlinkSync(tempZipPath); } catch (_) {}
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
        });
        stream.on("error", () => {
          try { fs.unlinkSync(tempZipPath); } catch (_) {}
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
        });
        stream.pipe(res);
        return;
      }

      // ---- delete_only ----
      const failed = [];
      let deleted = 0;
      for (const f of allFiles) {
        try {
          await gdrive.deleteDriveFile(accessToken, f.drive_file_id);
          deleted += 1;
          await db.clearSubmissionFileDriveIds(f.file_id);
        } catch (delErr) {
          failed.push({
            file_id: f.file_id,
            original_name: f.original_name,
            error: delErr.message,
          });
        }
      }
      return res.json({
        ok: true,
        message: `Removed ${deleted} student file(s) from Google Drive. Submission records remain.`,
        deleted,
        failed,
      });
    } catch (e) {
      console.error("[eduvault] archive:", e);
      try { if (tempZipPath) fs.unlinkSync(tempZipPath); } catch (_) {}
      try { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      if (!res.headersSent) {
        return res.status(500).json({ error: e.message || "Archive operation failed." });
      }
    }
  }
);


module.exports = router;
