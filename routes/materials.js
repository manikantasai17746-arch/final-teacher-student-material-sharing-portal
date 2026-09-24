const express = require("express");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const router = express.Router();

const db = require("../db");
const { requireAuth } = require("../lib/auth");
const rateLimit = require("../lib/rateLimit");
const { toSafeFilename, contentDisposition } = require("../lib/filename");
const storage = require("../lib/storage");
const mailer = require("../lib/mailer");
const gdrive = require("../lib/googleDrive");

async function withDbRetry(fn, label) {
  let last;
  for (let i = 1; i <= 3; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String(e && e.message ? e.message : e);
      if (
        i < 3 &&
        /ssl|tls|ECONNRESET|timeout|EPROTO|handshake|Connection terminated|too many clients/i.test(
          msg
        )
      ) {
        console.warn(`[eduvault] ${label} retry ${i}/3:`, msg.slice(0, 160));
        await new Promise((r) => setTimeout(r, 300 * i));
        continue;
      }
      throw e;
    }
  }
  throw last;
}


// ---------------------------------------------------------------------------
// TEMP UPLOAD DIRECTORY
// ---------------------------------------------------------------------------

const TEMP_DIR = path.join(os.tmpdir(), "eduvault-uploads-tmp");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// ALLOWED FILE TYPES
// ---------------------------------------------------------------------------

const ALLOWED_EXT = [
  // Documents
  ".pdf",
  ".ppt",
  ".pptx",
  ".doc",
  ".docx",
  ".txt",
  ".csv",
  ".xls",
  ".xlsx",

  // Archives
  ".zip",
  ".rar",
  ".7z",

  // Images
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",

  // Audio
  ".mp3",
  ".wav",

  // Video
  ".mp4",
  ".webm",

  // Source code
  ".py",
  ".java",
  ".cpp",
  ".c",
];

// ---------------------------------------------------------------------------
// FILE TYPES THAT MAY BE DISPLAYED INLINE
// ---------------------------------------------------------------------------

const INLINE_SAFE_EXT = new Set([
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".mp3",
  ".wav",
  ".mp4",
  ".webm",
  ".txt",
]);

// ---------------------------------------------------------------------------
// CONTENT TYPE
// ---------------------------------------------------------------------------

function extToContentType(ext) {
  const map = {
    ".pdf": "application/pdf",

    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",

    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",

    ".mp4": "video/mp4",
    ".webm": "video/webm",

    ".txt": "text/plain; charset=utf-8",
  };

  return map[ext] || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// MULTER TEMP STORAGE
// ---------------------------------------------------------------------------

const tempStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMP_DIR);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

// ---------------------------------------------------------------------------
// MULTER UPLOAD CONFIGURATION
// ---------------------------------------------------------------------------

const upload = multer({
  storage: tempStorage,

  limits: {
    fileSize: 200 * 1024 * 1024, // 200 MB
  },

  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (!ALLOWED_EXT.includes(ext)) {
      return cb(
        new Error(
          "Unsupported file type. Allowed: PDF, PPT/PPTX, DOC/DOCX, TXT, CSV, XLS/XLSX, ZIP, RAR, 7Z, images, audio, video and a few source-code formats."
        )
      );
    }

    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// RATE LIMITERS
// ---------------------------------------------------------------------------

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
});

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
});

const listLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
});

const viewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
});

// ---------------------------------------------------------------------------
// TEACHER UPLOAD
// ---------------------------------------------------------------------------

router.post(
  "/upload",
  requireAuth("teacher"),
  uploadLimiter,
  (req, res) => {
    upload.single("file")(req, res, async (err) => {
      // Multer error
      if (err) {
        return res.status(400).json({
          error: err.message,
        });
      }

      // Remove temporary file if something fails
      const cleanupTemp = () => {
        if (req.file) {
          fs.promises
            .unlink(req.file.path)
            .catch(() => {});
        }
      };

      try {
        // ---------------------------------------------------------------
        // GET EMPLOYEE ID FROM AUTH TOKEN
        // ---------------------------------------------------------------

        const emp_id = req.auth.sub;

        // IMPORTANT:
        // findTeacher() is async in db.js
        const account = await withDbRetry(
          () => db.findTeacher(emp_id),
          "findTeacher"
        );

        if (!account || !account.email_verified) {
          cleanupTemp();

          return res.status(403).json({
            error:
              "Your account hasn't completed Enrollment Code verification yet, so it can't upload files.",
          });
        }

        // ---------------------------------------------------------------
        // FORM DATA
        // ---------------------------------------------------------------

        const {
          subject,
          title,
          unit,
          semester,
        } = req.body;

        if (!subject || !title) {
          cleanupTemp();

          return res.status(400).json({
            error: "subject and title are required.",
          });
        }

        if (!req.file) {
          return res.status(400).json({
            error: "A file is required.",
          });
        }

        // ---------------------------------------------------------------
        // FILE INFORMATION
        // ---------------------------------------------------------------

        const originalName = req.file.originalname;
        const ext = path.extname(originalName).toLowerCase();
        const storedKey = req.file.filename;
        const contentType = extToContentType(ext);

        // ---------------------------------------------------------------
        // SAVE FILE TO TEACHER'S GOOGLE DRIVE (required — no silent fallback)
        // ---------------------------------------------------------------
        if (!gdrive.isConfigured()) {
          cleanupTemp();
          return res.status(503).json({
            error:
              "Google Drive is not configured on this server. Ask the administrator to set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.",
          });
        }

        const driveRow = await db.getTeacherGoogleDrive(emp_id);
        if (!driveRow) {
          cleanupTemp();
          return res.status(400).json({
            error: "Please connect Google Drive before uploading materials.",
          });
        }

        let drive_file_id = null;
        let drive_web_url = null;
        let accessToken;

        try {
          const tok = await gdrive.getValidAccessToken(driveRow, db);
          accessToken = tok.accessToken;
          let materialsFolderId = driveRow.materials_folder_id;
          if (!materialsFolderId) {
            const folders = await gdrive.ensureEduVaultFolders(accessToken);
            await db.updateTeacherGoogleDriveFolders(emp_id, folders);
            materialsFolderId = folders.materials_folder_id;
          }
          // Optional subject subfolder under EduVault/Materials/
          let parentId = materialsFolderId;
          if (subject && String(subject).trim()) {
            const sub = await gdrive.ensureFolder(
              accessToken,
              gdrive.sanitizeDriveName(String(subject).trim(), "Subject"),
              materialsFolderId
            );
            parentId = sub.id;
          }
          const uploaded = await gdrive.uploadFile(accessToken, {
            localPath: req.file.path,
            filename: gdrive.sanitizeDriveName(originalName, storedKey),
            mimeType: contentType,
            parentFolderId: parentId,
          });
          drive_file_id = uploaded.id;
          drive_web_url = uploaded.webViewLink || null;
          await fs.promises.unlink(req.file.path).catch(() => {});
          req.file = null;
        } catch (driveErr) {
          console.error("[eduvault] Material Drive upload failed:", driveErr.message);
          cleanupTemp();
          return res.status(502).json({
            error:
              driveErr.message ||
              "Could not upload to Google Drive. Please try again or reconnect Google Drive.",
          });
        }

        // Metadata only in Postgres — file lives in teacher's Drive
        const file_url = `gdrive:${drive_file_id}`;
        const storage_backend = "gdrive";

        // ---------------------------------------------------------------
        // SAVE MATERIAL RECORD TO POSTGRESQL
        // ---------------------------------------------------------------
        let material;
        try {
          material = await withDbRetry(
            () =>
              db.addMaterial({
                emp_id,
                subject,
                title,
                unit,
                semester,
                file_url,
                original_name: originalName,
                drive_file_id,
                drive_web_url,
                storage_backend,
              }),
            "addMaterial"
          );
        } catch (dbErr) {
          // Roll back the Drive upload so we never leave an orphaned material file
          if (drive_file_id && accessToken) {
            await gdrive.deleteDriveFilesBestEffort(accessToken, [drive_file_id]);
          }
          throw dbErr;
        }

        // ---------------------------------------------------------------
        // NOTIFY STUDENTS WHO STARRED THIS TEACHER (non-blocking)
        // ---------------------------------------------------------------
        // Upload must succeed even if email fails. Errors are logged only.
        try {
          if (mailer.isConfigured()) {
            const teacherName = (account && account.name) || emp_id;
            const unitPart = unit ? String(unit).trim() : "";
            const description = unitPart
              ? (semester ? `Unit: ${unitPart} · Semester: ${semester}` : `Unit: ${unitPart}`)
              : (semester ? `Semester: ${semester}` : "");

            // Fire-and-forget so the HTTP response is not delayed
            setImmediate(async () => {
              try {
                const subscribers = await db.getStudentsWhoBookmarkedTeacher(emp_id);
                for (const s of subscribers) {
                  if (!s.email) continue;
                  try {
                    await mailer.sendMaterialUploadNotification({
                      to: s.email,
                      studentName: s.name,
                      teacherName,
                      title: String(title),
                      subject: String(subject),
                      description,
                    });
                  } catch (oneErr) {
                    console.error(
                      "[eduvault] Star notification failed for",
                      s.email,
                      oneErr.message || oneErr
                    );
                  }
                }
              } catch (batchErr) {
                console.error(
                  "[eduvault] Star notification batch error:",
                  batchErr.message || batchErr
                );
              }
            });
          }
        } catch (notifySetupErr) {
          console.error(
            "[eduvault] Star notification setup error:",
            notifySetupErr.message || notifySetupErr
          );
        }

        // ---------------------------------------------------------------
        // RETURN SUCCESS
        // ---------------------------------------------------------------

        return res.status(201).json({
          material,
        });
      } catch (e) {
        console.error(
          "[eduvault] Material upload failed:",
          e
        );

        cleanupTemp();

        // Never leak low-level SSL / connection internals to the browser.
        const msg = String(e && e.message ? e.message : e);
        const isInfra =
          /ssl|tls|econnrefused|enotfound|timeout|handshake|EPROTO|self-signed/i.test(
            msg
          );
        return res.status(isInfra ? 503 : 400).json({
          error: isInfra
            ? "Database connection failed. Check DATABASE_URL (use Supabase Transaction pooler, port 6543) and SSL settings."
            : msg,
        });
      }
    });
  }
);

// ---------------------------------------------------------------------------
// LIST MATERIALS FOR A TEACHER
// ---------------------------------------------------------------------------
//
// This is the important fix.
//
// db.findTeacher() and db.materialsByTeacher() are async PostgreSQL
// functions, so they MUST be awaited.
// ---------------------------------------------------------------------------

router.get(
  "/teacher/:emp_id",
  listLimiter,
  async (req, res) => {
    try {
      const emp_id = req.params.emp_id;

      // IMPORTANT: await
      const teacher = await db.findTeacher(emp_id);

      if (!teacher) {
        return res.status(404).json({
          error: "Teacher not found.",
        });
      }

      // Use the teacher's canonical stored emp_id (not the raw URL param)
      // -- findTeacher now matches case-insensitively, but materials.emp_id
      // is an exact-match foreign key, so a differently-cased URL param
      // would silently return zero materials for a teacher who actually
      // has some.
      // IMPORTANT: await
      const materials = await db.materialsByTeacher(teacher.emp_id);

      console.log(
        `[eduvault] Loaded ${materials.length} materials for teacher ${emp_id}`
      );

      return res.json({
        teacher: db.sanitizeTeacher(teacher),
        materials,
      });
    } catch (err) {
      console.error(
        "[eduvault] Failed to load teacher materials:",
        err
      );

      return res.status(500).json({
        error: "Could not load teacher materials.",
      });
    }
  }
);

// ---------------------------------------------------------------------------
// VIEW MATERIAL INLINE
// ---------------------------------------------------------------------------

router.get(
  "/view/:material_id",
  requireAuth(["teacher", "student", "admin"]),
  viewLimiter,
  async (req, res) => {
    try {
      // IMPORTANT: await
      const material = await db.findMaterial(
        req.params.material_id
      );

      if (!material) {
        return res.status(404).json({
          error: "Material not found.",
        });
      }

      // Teachers may only view their own materials. Students (and admin)
      // may view any material they can discover via the teacher lookup.
      if (
        req.auth.role === "teacher" &&
        String(material.emp_id).toLowerCase() !==
          String(req.auth.sub).toLowerCase()
      ) {
        return res.status(403).json({
          error: "You can only view your own materials.",
        });
      }

      const ext = path
        .extname(
          material.original_name ||
            material.file_url
        )
        .toLowerCase();

      const niceName = toSafeFilename(
        material.title,
        ext
      );

      const disposition = contentDisposition(
        INLINE_SAFE_EXT.has(ext) ? "inline" : "attachment",
        niceName
      );
      if (INLINE_SAFE_EXT.has(ext)) {
        // Allow same-origin iframe preview; do not send DENY
        res.removeHeader("X-Frame-Options");
        res.set("Content-Security-Policy", "frame-ancestors 'self'");
      }

      // Drive-backed materials: stream via teacher's OAuth (student never
      // gets a Drive link or token).
      if (
        material.storage_backend === "gdrive" ||
        material.drive_file_id ||
        (material.file_url && String(material.file_url).startsWith("gdrive:"))
      ) {
        const fileId =
          material.drive_file_id ||
          String(material.file_url || "").replace(/^gdrive:/, "");
        if (!fileId) {
          return res.status(404).json({ error: "File missing from storage." });
        }
        const driveRow = await db.getTeacherGoogleDrive(material.emp_id);
        if (!driveRow) {
          return res.status(503).json({
            error:
              "This material is stored in Google Drive, but the teacher is no longer connected. Contact the teacher.",
          });
        }
        const { accessToken } = await gdrive.getValidAccessToken(driveRow, db);
        await gdrive.streamFileToResponse(accessToken, fileId, res, {
          contentType: extToContentType(ext),
          contentDispositionHeader: disposition,
        });
        return;
      }

      // Legacy local/S3 materials (pre-Drive records only)
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Content-Type", extToContentType(ext));
      res.set("Content-Disposition", disposition);
      await storage.streamTo(res, path.basename(material.file_url));
    } catch (e) {
      console.error(
        "[eduvault] Failed to view material:",
        e
      );

      if (!res.headersSent) {
        return res.status(e.status || 404).json({
          error: e.message || "File missing from storage.",
        });
      }
    }
  }
);

// ---------------------------------------------------------------------------
// DOWNLOAD MATERIAL
// ---------------------------------------------------------------------------

router.get(
  "/download/:material_id",
  requireAuth("student"),
  downloadLimiter,
  async (req, res) => {
    try {
      // IMPORTANT: await
      const material = await db.findMaterial(
        req.params.material_id
      );

      if (!material) {
        return res.status(404).json({
          error: "Material not found.",
        });
      }

      if (
        req.auth.role === "teacher" &&
        String(material.emp_id).toLowerCase() !== String(req.auth.sub).toLowerCase()
      ) {
        return res.status(403).json({ error: "You can only download your own materials." });
      }

      // ---------------------------------------------------------------
      // LOG ACCESS USING VERIFIED STUDENT ID
      // ---------------------------------------------------------------

      // IMPORTANT: logAccess() is async
      await db.logAccess({
        roll_no: req.auth.sub,
        material_id: material.material_id,
      });

      const ext = path
        .extname(
          material.original_name ||
            material.file_url
        )
        .toLowerCase();

      const downloadName = toSafeFilename(
        material.title,
        ext
      );

      const disposition = contentDisposition("attachment", downloadName);

      if (
        material.storage_backend === "gdrive" ||
        material.drive_file_id ||
        (material.file_url && String(material.file_url).startsWith("gdrive:"))
      ) {
        const fileId =
          material.drive_file_id ||
          String(material.file_url || "").replace(/^gdrive:/, "");
        if (!fileId) {
          return res.status(404).json({ error: "File missing on server." });
        }
        const driveRow = await db.getTeacherGoogleDrive(material.emp_id);
        if (!driveRow) {
          return res.status(503).json({
            error:
              "This material is stored in Google Drive, but the teacher is no longer connected. Contact the teacher.",
          });
        }
        const { accessToken } = await gdrive.getValidAccessToken(driveRow, db);
        await gdrive.streamFileToResponse(accessToken, fileId, res, {
          contentType: extToContentType(ext),
          contentDispositionHeader: disposition,
        });
        return;
      }

      res.set("Content-Disposition", disposition);
      res.set("Content-Type", extToContentType(ext));
      await storage.streamTo(res, path.basename(material.file_url));
    } catch (e) {
      console.error(
        "[eduvault] Failed to download material:",
        e
      );

      if (!res.headersSent) {
        return res.status(e.status || 404).json({
          error: e.message || "File missing on server.",
        });
      }
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE MATERIAL
// ---------------------------------------------------------------------------
//
// Teacher can delete only their own material.
// Employee ID comes from authentication token.
// ---------------------------------------------------------------------------

router.delete(
  "/:material_id",
  requireAuth("teacher"),
  async (req, res) => {
    try {
      const emp_id = req.auth.sub;

      // IMPORTANT: deleteMaterial() is async
      const removed = await db.deleteMaterial(
        req.params.material_id,
        emp_id
      );

      // Delete physical file from storage
      await storage.deleteFile(
        path.basename(removed.file_url)
      );

      return res.json({
        success: true,
      });
    } catch (err) {
      console.error(
        "[eduvault] Failed to delete material:",
        err
      );

      return res.status(400).json({
        error: err.message,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// EXPORT ROUTER
// ---------------------------------------------------------------------------

module.exports = router;
