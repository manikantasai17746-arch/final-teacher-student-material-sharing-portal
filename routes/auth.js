const express = require("express");
const router = express.Router();

const db = require("../db");
const mailer = require("../lib/mailer");
const rateLimit = require("../lib/rateLimit");

const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8 });
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

function publicAppUrl() {
  const raw =
    process.env.PUBLIC_APP_URL ||
    process.env.PUBLIC_REGISTER_URL ||
    "";
  let base = String(raw).trim().replace(/\/$/, "");
  // If PUBLIC_REGISTER_URL was a full page path, strip to origin
  try {
    if (base && /teacher-register\.html/i.test(base)) {
      const u = new URL(base);
      base = u.origin;
    }
  } catch (_) {}
  return base || "http://localhost:3000";
}

/**
 * POST /api/auth/forgot-password
 * Body: { email }
 * Always returns a generic success message (no email enumeration).
 */
router.post("/forgot-password", forgotLimiter, async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || "").trim();
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Please enter a valid email address." });
    }

    const genericMsg =
      "If an account exists with that email, a password reset link has been sent. Check your inbox (and spam folder).";

    const user = await db.findUserByEmail(email);
    if (!user) {
      // Same response whether or not the email exists
      return res.json({ message: genericMsg });
    }

    if (!mailer.isConfigured()) {
      console.error("[eduvault] Forgot password: email not configured");
      return res.status(503).json({
        error: "Email is not configured on the server. Please contact the administrator.",
      });
    }

    const { rawToken, expires_at } = await db.createPasswordResetToken({
      email: user.email,
      role: user.role,
      owner_id: user.owner_id,
    });

    const base = publicAppUrl();
    const resetUrl = `${base}/reset-password.html?token=${encodeURIComponent(rawToken)}`;

    try {
      await mailer.sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        resetUrl,
        expiresMinutes: 30,
      });
    } catch (mailErr) {
      console.error("[eduvault] Failed to send password reset email:", mailErr.message || mailErr);
      return res.status(503).json({
        error: "Could not send the reset email. Please try again later.",
      });
    }

    return res.json({ message: genericMsg });
  } catch (err) {
    console.error("[eduvault] forgot-password error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

/**
 * POST /api/auth/reset-password
 * Body: { token, password, confirmPassword }
 */
router.post("/reset-password", resetLimiter, async (req, res) => {
  try {
    const token = String((req.body && req.body.token) || "").trim();
    const password = (req.body && req.body.password) || "";
    const confirmPassword = (req.body && req.body.confirmPassword) || "";

    if (!token) {
      return res.status(400).json({ error: "Reset token is missing or invalid." });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: "Passwords do not match." });
    }

    const row = await db.findValidResetToken(token);
    if (!row) {
      return res.status(400).json({
        error: "This reset link is invalid, has already been used, or has expired. Please request a new one.",
      });
    }

    await db.updateUserPassword({
      role: row.role,
      owner_id: row.owner_id,
      newPassword: password,
    });
    await db.markResetTokenUsed(row.id);

    let loginPath = "/student-login.html";
    if (row.role === "teacher" || row.role === "admin") {
      loginPath = "/teacher-login.html";
    }

    return res.json({
      message: "Password updated successfully. You can now log in with your new password.",
      loginPath,
    });
  } catch (err) {
    console.error("[eduvault] reset-password error:", err);
    return res.status(400).json({
      error: err.message || "Could not reset password. Please try again.",
    });
  }
});

/**
 * GET /api/auth/validate-reset-token?token=...
 * Optional helper so the reset page can show "link expired" before submit.
 */
router.get("/validate-reset-token", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    if (!token) return res.json({ valid: false });
    const row = await db.findValidResetToken(token);
    return res.json({ valid: !!row });
  } catch (_) {
    return res.json({ valid: false });
  }
});

module.exports = router;
