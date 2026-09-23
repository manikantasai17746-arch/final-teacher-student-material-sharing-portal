const express = require("express");
const router = express.Router();

const db = require("../db");
const { requireAuth } = require("../lib/auth");
const gdrive = require("../lib/googleDrive");

/**
 * GET /api/google-drive/status
 * Returns connection status for the authenticated teacher (no secrets).
 */
router.get("/status", requireAuth(["teacher", "admin"]), async (req, res) => {
  try {
    const configured = gdrive.isConfigured();
    const row = await db.getTeacherGoogleDrive(req.auth.sub);
    if (!row) {
      return res.json({
        configured,
        connected: false,
        google_email: null,
        connected_at: null,
      });
    }
    return res.json({
      configured,
      connected: true,
      google_email: row.google_email || null,
      connected_at: row.connected_at,
      has_folders: !!(row.root_folder_id && row.materials_folder_id && row.submissions_folder_id),
    });
  } catch (e) {
    console.error("[eduvault] google-drive status:", e.message);
    return res.status(500).json({ error: "Could not check Google Drive status." });
  }
});

/**
 * GET /api/google-drive/auth
 * Redirect teacher to Google OAuth consent screen.
 * Accepts ?token= for browser navigation (requireAuth also reads query token).
 */
router.get("/auth", requireAuth(["teacher", "admin"]), async (req, res) => {
  try {
    if (!gdrive.isConfigured()) {
      return res.status(503).json({
        error:
          "Google Drive is not configured on this server. Ask the administrator to set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.",
      });
    }
    const { url } = gdrive.getAuthUrl(req.auth.sub);
    // Prefer redirect when Accept is HTML; otherwise return JSON url
    const acceptsHtml = (req.headers.accept || "").includes("text/html");
    if (acceptsHtml || req.query.redirect === "1") {
      return res.redirect(url);
    }
    return res.json({ url });
  } catch (e) {
    console.error("[eduvault] google-drive auth:", e.message);
    return res.status(500).json({ error: e.message || "Could not start Google authorization." });
  }
});

/**
 * GET /api/google-drive/callback
 * Google redirects here with ?code=&state=
 */
router.get("/callback", async (req, res) => {
  const fail = (msg) => {
    const dest = `/teacher-dashboard.html?gdrive=error&msg=${encodeURIComponent(msg)}`;
    return res.redirect(dest);
  };
  try {
    if (!gdrive.isConfigured()) return fail("Google Drive is not configured.");
    const { code, state, error } = req.query;
    if (error) return fail(String(error));
    if (!code || !state) return fail("Missing authorization code.");

    const payload = gdrive.verifyOAuthState(String(state));
    if (!payload || !payload.emp_id) return fail("Invalid or expired OAuth state. Try connecting again.");

    const tokens = await gdrive.exchangeCode(String(code));
    if (!tokens.access_token) return fail("Google did not return an access token.");
    if (!tokens.refresh_token) {
      // User may have already granted offline access before; still store if we have one from DB merge
      console.warn("[eduvault] Google did not return a refresh_token (may already be granted).");
    }

    const userInfo = await gdrive.fetchUserInfo(tokens.access_token);
    const refreshEnc = tokens.refresh_token
      ? gdrive.encrypt(tokens.refresh_token)
      : null;

    // If no new refresh token, keep existing one if present
    const existing = await db.getTeacherGoogleDrive(payload.emp_id);
    const refresh_token_enc =
      refreshEnc || (existing && existing.refresh_token_enc) || null;
    if (!refresh_token_enc) {
      return fail(
        "Google did not provide a refresh token. Revoke EduVault access in your Google Account permissions and try Connect again."
      );
    }

    const token_expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);

    // Ensure folder structure
    let folders = {};
    try {
      folders = await gdrive.ensureEduVaultFolders(tokens.access_token);
    } catch (folderErr) {
      console.error("[eduvault] ensure folders:", folderErr.message);
      // Still save connection; folders can be created on first upload
    }

    await db.upsertTeacherGoogleDrive({
      emp_id: payload.emp_id,
      google_account_id: userInfo && (userInfo.id || userInfo.sub),
      google_email: userInfo && userInfo.email,
      refresh_token_enc,
      access_token_enc: gdrive.encrypt(tokens.access_token),
      token_expiry,
      root_folder_id: folders.root_folder_id || null,
      materials_folder_id: folders.materials_folder_id || null,
      submissions_folder_id: folders.submissions_folder_id || null,
    });

    return res.redirect("/teacher-dashboard.html?gdrive=connected");
  } catch (e) {
    console.error("[eduvault] google-drive callback:", e.message);
    return fail(e.message || "Google authorization failed.");
  }
});

/**
 * POST /api/google-drive/disconnect
 * Removes OAuth credentials from EduVault. Does NOT delete Drive files.
 */
router.post("/disconnect", requireAuth(["teacher", "admin"]), async (req, res) => {
  try {
    await db.disconnectTeacherGoogleDrive(req.auth.sub);
    return res.json({ ok: true, connected: false });
  } catch (e) {
    console.error("[eduvault] google-drive disconnect:", e.message);
    return res.status(500).json({ error: "Could not disconnect Google Drive." });
  }
});

module.exports = router;
