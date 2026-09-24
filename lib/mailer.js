const nodemailer = require("nodemailer");

function isConfigured() {
  return Boolean(process.env.MAIL_USER && process.env.MAIL_APP_PASSWORD);
}

function getTransporter() {
  if (!isConfigured()) {
    throw new Error("Email is not configured (MAIL_USER / MAIL_APP_PASSWORD).");
  }
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_APP_PASSWORD,
    },
  });
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Invitation only — NO code.
 * Admin sends this first. Employee must go to the register page and click Verify.
 */
async function sendInvitationEmail({ to, name, registerUrl }) {
  const transporter = getTransporter();
  const fromName = process.env.MAIL_FROM_NAME || "EduVault";
  const greeting = name ? `Hi ${escapeHtml(name)},` : "Hi,";
  const url =
    registerUrl ||
    process.env.PUBLIC_REGISTER_URL ||
    "http://localhost:3000/teacher-register.html";

  const text =
    `${greeting}\n\n` +
    `This is your EduVault Teacher Invitation. You have been invited to register as a faculty member on EduVault.\n\n` +
    `To complete registration:\n` +
    `1. Open the registration page: ${url}\n` +
    `2. Enter this same email address.\n` +
    `3. Click "Send verification code".\n` +
    `4. Enter the code you receive and finish creating your account.\n\n` +
    `If you did not expect this invitation, you can ignore this email.\n\n` +
    `-- EduVault`;

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#16302B;">
    <div style="background:#023436;padding:18px 24px;border-radius:10px 10px 0 0;">
      <span style="color:#02C39A;font-weight:bold;font-size:20px;">EduVault</span>
    </div>
    <div style="border:1px solid #DCEAE8;border-top:none;border-radius:0 0 10px 10px;padding:24px;">
      <p style="font-size:12px;letter-spacing:0.04em;color:#028090;font-weight:bold;text-transform:uppercase;">Teacher Invitation</p>
      <p>${greeting}</p>
      <p>This is your <strong>EduVault Teacher Invitation</strong>. You have been invited to register as a faculty member on EduVault.</p>
      <p>To finish registration:</p>
      <ol style="padding-left:18px;line-height:1.6;">
        <li>Open the registration page</li>
        <li>Enter <strong>this same email</strong></li>
        <li>Click <strong>Send verification code</strong></li>
        <li>Enter the code from your inbox and complete the form</li>
      </ol>
      <div style="text-align:center;margin:22px 0;">
        <a href="${escapeHtml(url)}" style="display:inline-block;background:#028090;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;">Open registration page</a>
      </div>
      <p style="font-size:13px;color:#5B7A75;">No account is created until you verify with the code sent after you click the button on the registration page.</p>
    </div>
    <p style="font-size:11px;color:#9aa;text-align:center;margin-top:14px;">EduVault Teacher Invitation — Aditya University</p>
  </div>`;

  await transporter.sendMail({
    from: `"${fromName}" <${process.env.MAIL_USER}>`,
    to,
    subject: "EduVault Teacher Invitation — Register as Faculty",
    text,
    html,
  });
}

/**
 * Code email — only sent when the employee clicks Verify on the register page.
 */
async function sendEnrollmentCodeEmail({ to, name, code, expiresMinutes }) {
  const transporter = getTransporter();
  const fromName = process.env.MAIL_FROM_NAME || "EduVault";
  const greeting = name ? `Hi ${escapeHtml(name)},` : "Hi,";

  const text =
    `${greeting}\n\n` +
    `Your EduVault Employee Enrollment Code is: ${code}\n\n` +
    `This code expires in ${expiresMinutes} minutes and can only be used once.\n\n` +
    `Enter it on the EduVault registration page to verify your college email ` +
    `and finish creating your faculty account.\n\n` +
    `If you didn't request this, you can safely ignore this email.\n\n` +
    `-- EduVault`;

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#16302B;">
    <div style="background:#023436;padding:18px 24px;border-radius:10px 10px 0 0;">
      <span style="color:#02C39A;font-weight:bold;font-size:20px;">EduVault</span>
    </div>
    <div style="border:1px solid #DCEAE8;border-top:none;border-radius:0 0 10px 10px;padding:24px;">
      <p>${greeting}</p>
      <p>Use this code to verify your college email and finish creating your EduVault faculty account:</p>
      <div style="text-align:center;margin:22px 0;">
        <span style="display:inline-block;background:#F2F8F7;border:1px solid #DCEAE8;border-radius:8px;padding:14px 28px;font-size:26px;letter-spacing:2px;font-weight:bold;color:#028090;">${escapeHtml(code)}</span>
      </div>
      <p style="font-size:14px;color:#5B7A75;">This code expires in <strong>${expiresMinutes} minutes</strong> and can only be used once.</p>
      <p style="font-size:13px;color:#B23A2E;">Didn't request this? Ignore this email.</p>
    </div>
    <p style="font-size:11px;color:#9aa;text-align:center;margin-top:14px;">EduVault — Employee Enrollment Verification</p>
  </div>`;

  await transporter.sendMail({
    from: `"${fromName}" <${process.env.MAIL_USER}>`,
    to,
    subject: "EduVault Employee Enrollment Code",
    text,
    html,
  });
}


/**
 * Password reset email — secure one-time link.
 */
async function sendPasswordResetEmail({ to, name, resetUrl, expiresMinutes }) {
  const transporter = getTransporter();
  const fromName = process.env.MAIL_FROM_NAME || "EduVault";
  const greeting = name ? `Hi ${escapeHtml(name)},` : "Hi,";
  const mins = expiresMinutes || 30;

  const text =
    `${greeting}\n\n` +
    `We received a request to reset your EduVault password.\n\n` +
    `Open this link to set a new password (valid for ${mins} minutes, one-time use only):\n` +
    `${resetUrl}\n\n` +
    `If you did not request this, you can safely ignore this email. Your password will not change.\n\n` +
    `-- EduVault`;

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#16302B;">
    <div style="background:#023436;padding:18px 24px;border-radius:10px 10px 0 0;">
      <span style="color:#02C39A;font-weight:bold;font-size:20px;">EduVault</span>
    </div>
    <div style="border:1px solid #DCEAE8;border-top:none;border-radius:0 0 10px 10px;padding:24px;">
      <p>${greeting}</p>
      <p>We received a request to reset your EduVault password.</p>
      <div style="text-align:center;margin:22px 0;">
        <a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#028090;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;">Reset Password</a>
      </div>
      <p style="font-size:13px;color:#5B7A75;">This link expires in <strong>${mins} minutes</strong> and can only be used once.</p>
      <p style="font-size:13px;color:#B23A2E;">Didn't request this? Ignore this email — your password will stay the same.</p>
    </div>
    <p style="font-size:11px;color:#9aa;text-align:center;margin-top:14px;">EduVault — Password Reset</p>
  </div>`;

  await transporter.sendMail({
    from: `"${fromName}" <${process.env.MAIL_USER}>`,
    to,
    subject: "Reset your EduVault password",
    text,
    html,
  });
}

/**
 * Notify a student that a starred teacher uploaded new material.
 * Send individually (no BCC list leakage).
 */
async function sendMaterialUploadNotification({
  to,
  studentName,
  teacherName,
  title,
  subject,
  description,
}) {
  const transporter = getTransporter();
  const fromName = process.env.MAIL_FROM_NAME || "EduVault";
  const greeting = studentName
    ? `Hello ${escapeHtml(studentName)},`
    : "Hello,";
  const descLine = description
    ? `* Description: ${description}\n`
    : "";

  const text =
    `${greeting}\n\n` +
    `Your starred teacher ${teacherName} has uploaded new study material.\n\n` +
    `Material Details:\n` +
    `* Title: ${title}\n` +
    `* Subject: ${subject}\n` +
    descLine +
    `\nLogin to EduVault to view and download the material.\n\n` +
    `Thank you,\nEduVault Team`;

  const htmlDesc = description
    ? `<li><strong>Description:</strong> ${escapeHtml(description)}</li>`
    : "";

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#16302B;">
    <div style="background:#023436;padding:18px 24px;border-radius:10px 10px 0 0;">
      <span style="color:#02C39A;font-weight:bold;font-size:20px;">EduVault</span>
    </div>
    <div style="border:1px solid #DCEAE8;border-top:none;border-radius:0 0 10px 10px;padding:24px;">
      <p>${greeting}</p>
      <p>Your starred teacher <strong>${escapeHtml(teacherName)}</strong> has uploaded new study material.</p>
      <p style="margin:16px 0 8px;"><strong>Material Details:</strong></p>
      <ul style="padding-left:18px;line-height:1.6;margin:0;">
        <li><strong>Title:</strong> ${escapeHtml(title)}</li>
        <li><strong>Subject:</strong> ${escapeHtml(subject)}</li>
        ${htmlDesc}
      </ul>
      <p style="margin-top:18px;">Login to EduVault to view and download the material.</p>
      <p style="margin-top:20px;">Thank you,<br><strong>EduVault Team</strong></p>
    </div>
    <p style="font-size:11px;color:#9aa;text-align:center;margin-top:14px;">EduVault — Starred Teacher Notification</p>
  </div>`;

  await transporter.sendMail({
    from: `"${fromName}" <${process.env.MAIL_USER}>`,
    to,
    subject: "New Material Uploaded by Your Starred Teacher",
    text,
    html,
  });
}

module.exports = {
  isConfigured,
  sendInvitationEmail,
  sendEnrollmentCodeEmail,
  sendPasswordResetEmail,
  sendMaterialUploadNotification,
};
