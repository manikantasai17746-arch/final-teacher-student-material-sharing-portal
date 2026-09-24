/**
 * Google Drive OAuth 2.0 + Drive API helpers for EduVault.
 *
 * Tokens are encrypted at rest using AES-256-GCM with a key derived from
 * SESSION_SECRET. Never send tokens or client secrets to the browser.
 *
 * Requires env:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REDIRECT_URI  (e.g. https://your-app.example/api/google-drive/callback)
 *   SESSION_SECRET       (used to encrypt tokens)
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URLSearchParams } = require("url");

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

function isConfigured() {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getClientId() {
  return process.env.GOOGLE_CLIENT_ID || "";
}
function getClientSecret() {
  return process.env.GOOGLE_CLIENT_SECRET || "";
}
function getRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || "";
}

// ---- Token encryption (AES-256-GCM) ----------------------------------------

function deriveKey() {
  const secret = process.env.SESSION_SECRET || "eduvault-dev-insecure-secret";
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const key = deriveKey();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(ciphertext) {
  if (!ciphertext) return null;
  try {
    const buf = Buffer.from(String(ciphertext), "base64");
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const key = deriveKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch (err) {
    // Typical when SESSION_SECRET changed since the token was encrypted:
    // "Unsupported state or unable to authenticate data"
    console.warn(
      "[eduvault] Drive token decrypt failed (wrong SESSION_SECRET or corrupt token):",
      err && err.message ? err.message.slice(0, 80) : err
    );
    return null;
  }
}

// ---- OAuth state (CSRF) ---------------------------------------------------

function createOAuthState(emp_id) {
  const payload = {
    emp_id: String(emp_id),
    nonce: crypto.randomBytes(16).toString("hex"),
    exp: Date.now() + 15 * 60 * 1000,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", process.env.SESSION_SECRET || "eduvault-dev")
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

function verifyOAuthState(state) {
  if (!state || typeof state !== "string" || !state.includes(".")) return null;
  const [body, sig] = state.split(".");
  const expected = crypto
    .createHmac("sha256", process.env.SESSION_SECRET || "eduvault-dev")
    .update(body)
    .digest("base64url");
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function getAuthUrl(emp_id) {
  if (!isConfigured()) {
    throw new Error(
      "Google Drive is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI."
    );
  }
  const state = createOAuthState(emp_id);
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    state,
  };
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: getClientId(),
    client_secret: getClientSecret(),
    redirect_uri: getRedirectUri(),
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error_description || data.error || "Token exchange failed";
    throw new Error(msg);
  }
  return data; // { access_token, refresh_token, expires_in, token_type, scope }
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: getClientId(),
    client_secret: getClientSecret(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error_description || data.error || "Token refresh failed";
    throw new Error(msg);
  }
  return data;
}

async function fetchUserInfo(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Ensure we have a valid access token for the teacher; refresh if needed.
 * Returns { accessToken, row } and persists updated tokens via db callback.
 */
async function getValidAccessToken(row, db) {
  if (!row || !row.refresh_token_enc) {
    throw new Error("Google Drive is not connected for this teacher.");
  }
  const refreshToken = decrypt(row.refresh_token_enc);
  if (!refreshToken) {
    throw new Error(
      "Could not decrypt Google credentials. Set a stable SESSION_SECRET (same value as when Drive was connected), then disconnect and reconnect Google Drive."
    );
  }

  // Access token may fail to decrypt if it was encrypted under a different secret;
  // treat that as expired and refresh using the refresh token.
  let accessToken = null;
  if (row.access_token_enc) {
    accessToken = decrypt(row.access_token_enc);
  }
  const expiry = row.token_expiry ? new Date(row.token_expiry).getTime() : 0;
  const needsRefresh = !accessToken || Date.now() > expiry - 60 * 1000;

  if (needsRefresh) {
    try {
      const data = await refreshAccessToken(refreshToken);
      accessToken = data.access_token;
      const token_expiry = new Date(Date.now() + (data.expires_in || 3600) * 1000);
      await db.updateTeacherGoogleDriveTokens(row.emp_id, {
        access_token_enc: encrypt(accessToken),
        token_expiry,
        refresh_token_enc: data.refresh_token ? encrypt(data.refresh_token) : null,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      throw new Error(
        "Google Drive token refresh failed. Disconnect and reconnect Google Drive. (" +
          msg.slice(0, 120) +
          ")"
      );
    }
  }
  if (!accessToken) {
    throw new Error("Could not obtain a Google Drive access token. Reconnect Google Drive.");
  }
  return { accessToken, row };
}

// ---- Drive API helpers ----------------------------------------------------

async function driveRequest(accessToken, method, apiPath, { query, body, headers } = {}) {
  let url = `https://www.googleapis.com/drive/v3${apiPath}`;
  if (query) {
    const q = new URLSearchParams(query);
    url += (apiPath.includes("?") ? "&" : "?") + q.toString();
  }
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(headers || {}),
    },
  };
  if (body && !(body instanceof Buffer) && typeof body !== "string") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  } else if (body) {
    opts.body = body;
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      (data && data.error && data.error.message) ||
      (data && data.error) ||
      `Drive API ${res.status}`;
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = res.status;
    throw err;
  }
  return data;
}

async function findFolderByName(accessToken, name, parentId) {
  const escaped = String(name).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  let q = `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const data = await driveRequest(accessToken, "GET", "/files", {
    query: {
      q,
      fields: "files(id,name)",
      spaces: "drive",
      pageSize: "5",
    },
  });
  return data.files && data.files[0] ? data.files[0] : null;
}

async function createFolder(accessToken, name, parentId) {
  const meta = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) meta.parents = [parentId];
  return driveRequest(accessToken, "POST", "/files", {
    query: { fields: "id,name,webViewLink" },
    body: meta,
  });
}

async function ensureFolder(accessToken, name, parentId) {
  const existing = await findFolderByName(accessToken, name, parentId);
  if (existing) return existing;
  return createFolder(accessToken, name, parentId);
}

/**
 * Ensure EduVault / Materials / Submissions folder tree exists.
 * Returns { root_folder_id, materials_folder_id, submissions_folder_id }
 */
async function ensureEduVaultFolders(accessToken) {
  const root = await ensureFolder(accessToken, "EduVault", null);
  const materials = await ensureFolder(accessToken, "Materials", root.id);
  const submissions = await ensureFolder(accessToken, "Submissions", root.id);
  const quizzes = await ensureFolder(accessToken, "Quizzes", root.id);
  const feedback = await ensureFolder(accessToken, "Feedback", root.id);
  return {
    root_folder_id: root.id,
    materials_folder_id: materials.id,
    submissions_folder_id: submissions.id,
    quizzes_folder_id: quizzes.id,
    feedback_folder_id: feedback.id,
  };
}

function sanitizeDriveName(name, fallback = "file") {
  let s = String(name || fallback)
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  if (!s || s === "." || s === "..") s = fallback;
  return s;
}

/**
 * Upload a local file to Drive under parentFolderId.
 * Uses multipart upload.
 */
async function uploadFile(accessToken, {
  localPath,
  filename,
  mimeType,
  parentFolderId,
}) {
  const safeName = sanitizeDriveName(filename, "upload.bin");
  const metadata = {
    name: safeName,
    parents: parentFolderId ? [parentFolderId] : undefined,
  };
  const boundary = "eduvault_" + crypto.randomBytes(8).toString("hex");
  const metaPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n`;
  const fileHeader =
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`;
  const footer = `\r\n--${boundary}--`;

  const fileBuf = await fs.promises.readFile(localPath);
  const body = Buffer.concat([
    Buffer.from(metaPart, "utf8"),
    Buffer.from(fileHeader, "utf8"),
    fileBuf,
    Buffer.from(footer, "utf8"),
  ]);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink,mimeType,size",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
    }
  );
  const data = await res.json();
  if (!res.ok) {
    const msg =
      (data && data.error && data.error.message) ||
      data.error ||
      `Upload failed (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

/**
 * Stream a Drive file to an Express response using the teacher's access token.
 * Does not expose tokens or make the file public. Student never talks to Drive.
 */
async function streamFileToResponse(accessToken, fileId, res, {
  contentType,
  contentDispositionHeader,
} = {}) {
  if (!fileId) {
    const err = new Error("Missing Google Drive file id.");
    err.status = 404;
    throw err;
  }
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId
  )}?alt=media`;
  const driveRes = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!driveRes.ok) {
    const text = await driveRes.text().catch(() => "");
    const err = new Error(
      driveRes.status === 404
        ? "File not found in Google Drive."
        : `Could not retrieve file from Google Drive (${driveRes.status}).`
    );
    err.status = driveRes.status === 404 ? 404 : 502;
    err.detail = text.slice(0, 200);
    throw err;
  }
  if (contentType) res.set("Content-Type", contentType);
  else if (driveRes.headers.get("content-type")) {
    res.set("Content-Type", driveRes.headers.get("content-type"));
  }
  if (contentDispositionHeader) {
    res.set("Content-Disposition", contentDispositionHeader);
  }
  res.set("X-Content-Type-Options", "nosniff");
  const len = driveRes.headers.get("content-length");
  if (len) res.set("Content-Length", len);

  // Node 18+ fetch body is a web ReadableStream; convert for Express
  if (driveRes.body && typeof driveRes.body.getReader === "function") {
    const { Readable } = require("stream");
    const nodeStream = Readable.fromWeb(driveRes.body);
    await new Promise((resolve, reject) => {
      nodeStream.on("error", reject);
      res.on("error", reject);
      res.on("finish", resolve);
      nodeStream.pipe(res);
    });
  } else if (driveRes.body && typeof driveRes.body.pipe === "function") {
    await new Promise((resolve, reject) => {
      driveRes.body.on("error", reject);
      res.on("error", reject);
      res.on("finish", resolve);
      driveRes.body.pipe(res);
    });
  } else {
    const buf = Buffer.from(await driveRes.arrayBuffer());
    res.end(buf);
  }
}

/**
 * Permanently delete a file from Google Drive by ID.
 * Best-effort: treats 404 as success (already gone).
 */
async function deleteDriveFile(accessToken, fileId) {
  if (!fileId) return;
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.ok || res.status === 204 || res.status === 404) return;
  const text = await res.text().catch(() => "");
  const err = new Error(
    `Could not delete Drive file (${res.status}): ${text.slice(0, 120)}`
  );
  err.status = res.status;
  throw err;
}

/**
 * Best-effort delete of many Drive file IDs. Logs failures; does not throw.
 */
async function deleteDriveFilesBestEffort(accessToken, fileIds) {
  const ids = [...new Set((fileIds || []).filter(Boolean))];
  for (const id of ids) {
    try {
      await deleteDriveFile(accessToken, id);
    } catch (e) {
      console.warn("[eduvault] Failed to delete Drive file", id, e.message);
    }
  }
}


/**
 * Download a Drive file to a local path (for archive ZIP).
 */
async function downloadFileToPath(accessToken, fileId, destPath) {
  if (!fileId) throw new Error("Missing Drive file id.");
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Drive download failed (${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(destPath, buf);
  return destPath;
}

/**
 * Minimal ZIP (store method, no compression) — no extra npm dependency.
 * files: [{ path, name }]
 */
async function createZipFromFiles(files, destZipPath) {
  const parts = [];
  const central = [];
  let offset = 0;

  function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  }

  for (const f of files) {
    const data = await fs.promises.readFile(f.path);
    const name = String(f.name || "file").replace(/\\/g, "/").replace(/^\/+/, "");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await fs.promises.writeFile(destZipPath, Buffer.concat([...parts, ...central, end]));
  return destZipPath;
}


/**
 * Find a non-folder file by exact name under a parent folder.
 */
async function findFileByName(accessToken, name, parentId) {
  const escaped = String(name).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  let q = `name='${escaped}' and mimeType!='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const data = await driveRequest(accessToken, "GET", "/files", {
    query: { q, fields: "files(id,name,mimeType,modifiedTime)", pageSize: 5 },
  });
  const files = (data && data.files) || [];
  return files[0] || null;
}

/**
 * Upload JSON content as a new Drive file (application/json).
 */
async function uploadJsonFile(accessToken, { filename, parentFolderId, data }) {
  const safeName = sanitizeDriveName(filename, "data.json");
  const bodyStr = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const metadata = {
    name: safeName,
    parents: parentFolderId ? [parentFolderId] : undefined,
  };
  const boundary = "eduvault_" + crypto.randomBytes(8).toString("hex");
  const metaPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n`;
  const fileHeader =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n`;
  const footer = `\r\n--${boundary}--`;
  const fileBuf = Buffer.from(bodyStr, "utf8");
  const body = Buffer.concat([
    Buffer.from(metaPart, "utf8"),
    Buffer.from(fileHeader, "utf8"),
    fileBuf,
    Buffer.from(footer, "utf8"),
  ]);
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
    }
  );
  const out = await res.json();
  if (!res.ok) {
    const msg = (out && out.error && out.error.message) || "Drive JSON upload failed";
    throw new Error(msg);
  }
  return out;
}

/**
 * Overwrite an existing Drive file with new JSON (update in place).
 */
async function updateJsonFile(accessToken, fileId, data) {
  const bodyStr = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: bodyStr,
    }
  );
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (out && out.error && out.error.message) || "Drive JSON update failed";
    throw new Error(msg);
  }
  return out;
}

/**
 * Create or update a named JSON file under parentFolderId.
 * Returns { id, name, created: boolean }
 */
async function upsertJsonFile(accessToken, { filename, parentFolderId, data }) {
  const existing = await findFileByName(accessToken, sanitizeDriveName(filename, "data.json"), parentFolderId);
  if (existing) {
    await updateJsonFile(accessToken, existing.id, data);
    return { id: existing.id, name: existing.name, created: false };
  }
  const created = await uploadJsonFile(accessToken, { filename, parentFolderId, data });
  return { id: created.id, name: created.name, created: true };
}

/**
 * Download a Drive file and parse as JSON.
 */
async function readJsonFile(accessToken, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Could not read Drive file (${res.status}): ${t.slice(0, 120)}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Drive file is not valid JSON.");
  }
}

/**
 * Upload plain text/CSV content.
 */
async function upsertTextFile(accessToken, { filename, parentFolderId, text, mimeType }) {
  const safeName = sanitizeDriveName(filename, "report.csv");
  const existing = await findFileByName(accessToken, safeName, parentFolderId);
  const bodyStr = String(text == null ? "" : text);
  if (existing) {
    const res = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existing.id)}?uploadType=media`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": mimeType || "text/csv; charset=UTF-8",
        },
        body: bodyStr,
      }
    );
    if (!res.ok) throw new Error("Drive text update failed");
    return { id: existing.id, name: existing.name, created: false };
  }
  // multipart create
  const metadata = { name: safeName, parents: parentFolderId ? [parentFolderId] : undefined };
  const boundary = "eduvault_" + crypto.randomBytes(8).toString("hex");
  const metaPart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) + `\r\n`;
  const fileHeader =
    `--${boundary}\r\nContent-Type: ${mimeType || "text/csv; charset=UTF-8"}\r\n\r\n`;
  const footer = `\r\n--${boundary}--`;
  const body = Buffer.concat([
    Buffer.from(metaPart, "utf8"),
    Buffer.from(fileHeader, "utf8"),
    Buffer.from(bodyStr, "utf8"),
    Buffer.from(footer, "utf8"),
  ]);
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body,
    }
  );
  const out = await res.json();
  if (!res.ok) throw new Error((out.error && out.error.message) || "Drive text upload failed");
  return { id: out.id, name: out.name, created: true };
}



async function listFilesInFolder(accessToken, parentId, { mimePrefix } = {}) {
  if (!parentId) return [];
  let q = `'${parentId}' in parents and trashed=false`;
  if (mimePrefix) q += ` and mimeType contains '${String(mimePrefix).replace(/'/g, "\\'")}'`;
  const data = await driveRequest(accessToken, "GET", "/files", {
    query: {
      q,
      fields: "files(id,name,mimeType,modifiedTime,size)",
      pageSize: 200,
      orderBy: "name",
    },
  });
  return (data && data.files) || [];
}

module.exports = {
  isConfigured,
  getAuthUrl,
  verifyOAuthState,
  exchangeCode,
  fetchUserInfo,
  encrypt,
  decrypt,
  getValidAccessToken,
  ensureEduVaultFolders,
  ensureFolder,
  createFolder,
  findFileByName,
  listFilesInFolder,
  uploadFile,
  uploadJsonFile,
  updateJsonFile,
  upsertJsonFile,
  readJsonFile,
  upsertTextFile,
  streamFileToResponse,
  deleteDriveFile,
  deleteDriveFilesBestEffort,
  downloadFileToPath,
  createZipFromFiles,
  sanitizeDriveName,
  SCOPES,
};
