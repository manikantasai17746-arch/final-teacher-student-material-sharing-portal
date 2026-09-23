# EduVault — Feature Changes (Forgot Password + Starred Teacher Notifications)

## Summary

Two major features were added without breaking existing registration, login, enrollment, material upload/download, bookmarks, or admin flows.

---

### 1. Forgot Password / Reset Password

**Database (`db.js`)**
- New table `password_reset_tokens` (id, email, role, owner_id, token_hash, expires_at, used_at, created_at).
- `findUserByEmail(email)` — looks up active student or teacher/admin by email (no role leakage in API responses).
- `createPasswordResetToken` — cryptographically random 32-byte token; only SHA-256 hash stored; previous unused tokens for that email are invalidated.
- `findValidResetToken` / `markResetTokenUsed` — single-use, 30-minute expiry.
- `updateUserPassword` — uses existing `hashPassword` (scrypt + salt); never stores plaintext.

**API (`routes/auth.js` — new)**
- `POST /api/auth/forgot-password` `{ email }` — generic success message always (no email enumeration); rate-limited.
- `POST /api/auth/reset-password` `{ token, password, confirmPassword }` — validates match + min 8 chars; marks token used; returns appropriate login path.
- `GET /api/auth/validate-reset-token?token=` — used by the reset page to detect expired/used links.

**Email (`lib/mailer.js`)**
- `sendPasswordResetEmail` — uses existing `MAIL_USER` / `MAIL_APP_PASSWORD`.
- Reset link built from `PUBLIC_APP_URL` (not localhost).

**UI**
- `public/forgot-password.html` — email form, consistent EduVault styling.
- `public/reset-password.html` — new + confirm password; validates token first.
- “Forgot Password?” link on `student-login.html` and `teacher-login.html`.

**Server**
- `app.use("/api/auth", authRoutes)` in `server.js`.

**Env**
- `PUBLIC_APP_URL=https://your-project.vercel.app` documented in `.env.example`.

---

### 2. Starred Teacher Material Notifications

**Database**
- Reuses existing `students.bookmarked_teachers` JSONB (no duplicate tables).
- `getStudentsWhoBookmarkedTeacher(emp_id)` — returns active students with email who starred that teacher.

**Upload flow (`routes/materials.js`)**
- After material is saved successfully, notifications are sent in the background (`setImmediate`).
- Individual emails per student (no shared BCC list that could leak addresses).
- Upload **always succeeds** even if email fails; failures are logged only.
- Email content matches the requested template (title, subject, optional unit/semester as description).

**Email**
- `sendMaterialUploadNotification` in `lib/mailer.js`.

**UI**
- Existing star (★/☆) button and bookmark chips unchanged.

---

### Security checklist

| Requirement | Implementation |
|-------------|----------------|
| No plaintext passwords | scrypt + salt via existing `hashPassword` |
| Secure reset tokens | `crypto.randomBytes(32)`; only hash stored |
| Single-use + 30 min expiry | DB `used_at` + `expires_at` |
| No email enumeration | Generic response on forgot-password |
| No role leakage | Same message for student/teacher/admin |
| Credentials in env only | MAIL_* and PUBLIC_APP_URL |
| Upload isolation | Notification errors never fail the upload |

---

### Files modified / added

| File | Change |
|------|--------|
| `db.js` | Schema + reset token helpers + bookmark query |
| `lib/mailer.js` | Reset + material notification emails |
| `routes/auth.js` | **New** — forgot / reset / validate |
| `routes/materials.js` | Post-upload star notifications |
| `server.js` | Mount `/api/auth` |
| `public/forgot-password.html` | **New** |
| `public/reset-password.html` | **New** |
| `public/student-login.html` | Forgot Password link |
| `public/teacher-login.html` | Forgot Password link |
| `.env.example` | `PUBLIC_APP_URL` |

### Deployment note

Set on Vercel / host:

```
PUBLIC_APP_URL=https://your-actual-deployment.vercel.app
MAIL_USER=...
MAIL_APP_PASSWORD=...
```

Redeploy after setting env vars so the `password_reset_tokens` table is created on next schema init.
