# Google Drive setup for EduVault

EduVault can store **teacher materials** and **student submission files** in each teacher’s own Google Drive. The app never asks for a Google password. Teachers authorize EduVault once via Google OAuth 2.0.

PostgreSQL stores only metadata and Drive file IDs. File bytes live in Drive when connected.

## 1. Create a Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or select an existing one), e.g. `EduVault`.

## 2. Enable Google Drive API

1. **APIs & Services → Library**.
2. Search for **Google Drive API** → **Enable**.
3. Also enable **Google People API** or ensure userinfo scopes work (Drive + userinfo is enough for email).

## 3. Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. Choose **External** (or **Internal** if you use Google Workspace and only your org).
3. App name: `EduVault` (or your university name).
4. User support email: your email.
5. Add scopes:
   - `https://www.googleapis.com/auth/drive.file` (files created by the app only)
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`
6. If the app is in **Testing** mode, add each teacher’s Google account under **Test users**.

## 4. Create OAuth client credentials

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Name: `EduVault Web`.
4. **Authorized redirect URIs** (must match exactly):
   - Local: `http://localhost:3000/api/google-drive/callback`
   - Production: `https://YOUR-DOMAIN/api/google-drive/callback`
5. Copy the **Client ID** and **Client secret**.

## 5. Environment variables

Add to `.env` (local) or your host’s environment settings:

```
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=....
GOOGLE_REDIRECT_URI=https://YOUR-DOMAIN/api/google-drive/callback
SESSION_SECRET=<long random string>   # required; used to encrypt refresh tokens
```

Never commit real secrets. `.env.example` only has placeholders.

## 6. Start the application

```bash
npm install
npm start
```

## 7. Connect a teacher’s Google Drive

1. Log in as a teacher → **Teacher Dashboard**.
2. Open the **Google Drive** card → **Connect Google Drive**.
3. Sign in with Google and grant access.
4. You should return to the dashboard with **Google Drive: Connected ✓**.

## 8. Test upload

1. Upload a material from the dashboard. If Drive is connected, the file is stored under:

   `EduVault / Materials / <Subject> /`

2. Create a **Submission Request**, copy the link, open it as a student, and submit a file. Files go under:

   `EduVault / Submissions / <Request title> /`

## Notes and limitations

- **Testing vs Production**: Google may restrict unverified OAuth apps to test users only. For campus-wide use, complete Google’s verification or use Internal (Workspace).
- **Disconnect** removes OAuth credentials from EduVault only. Files already in Drive are **not** deleted.
- If Drive is not connected or OAuth is not configured, EduVault falls back to the existing local/S3 storage driver for materials and submissions.
- Tokens are encrypted at rest with a key derived from `SESSION_SECRET`. They are never sent to the browser.
- Scope `drive.file` only allows access to files the app creates — not the teacher’s entire Drive.

## Security checklist

- [ ] `SESSION_SECRET` set to a strong random value  
- [ ] Redirect URI matches the deployed URL  
- [ ] Client secret only on the server  
- [ ] HTTPS in production  
- [ ] Test users configured while app is in Testing mode  
