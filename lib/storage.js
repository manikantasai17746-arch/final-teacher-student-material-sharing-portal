// ---------------------------------------------------------------------------
// EduVault file storage abstraction
// ---------------------------------------------------------------------------
// WHY THIS EXISTS:
// A Vercel serverless function's filesystem is read-only except /tmp, and
// /tmp itself is wiped between invocations -- anything written to local
// disk with STORAGE_DRIVER=local is NOT durable on Vercel. The original
// EduVault wrote uploads straight into ./uploads on local disk, which works
// fine on your own machine but silently loses every uploaded file in
// production.
//
// This module is the ONLY place that touches "where do uploaded bytes live".
// routes/materials.js never uses `fs` directly against the uploads folder --
// it calls the functions below. That means fixing storage for Vercel is a
// config change, not a rewrite.
//
// Two drivers are supported, chosen with STORAGE_DRIVER:
//
//   STORAGE_DRIVER=local (default)
//     Uploads are written to UPLOAD_DIR (default: ./uploads, or /tmp on
//     Vercel). Fine for local development only -- do NOT use this in
//     production on Vercel, since /tmp does not persist across requests.
//
//   STORAGE_DRIVER=s3  <-- use this on Vercel
//     Uploads are streamed to any S3-compatible object storage bucket
//     (AWS S3, Cloudflare R2, Backblaze B2, Supabase Storage, etc.) --
//     this is the required production setup on Vercel, since it's the
//     only way uploaded files persist and are shared across serverless
//     invocations/instances. Requires the optional @aws-sdk/client-s3
//     package (`npm install @aws-sdk/client-s3`) and the S3_* environment
//     variables documented in .env.example.
//
//     Supabase Storage specifically: it exposes an S3-compatible endpoint
//     at Project -> Storage -> S3 Configuration (generate an access key
//     pair there), so this same driver works against it with zero code
//     changes -- just point S3_ENDPOINT at
//     https://<project-ref>.supabase.co/storage/v1/s3 and S3_REGION at
//     the region shown on that page. Path-style bucket addressing (which
//     Supabase's S3 endpoint requires) is auto-enabled below whenever
//     S3_ENDPOINT looks like a supabase.co/supabase.com host.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");

const DRIVER = (process.env.STORAGE_DRIVER || "local").trim().toLowerCase();

// On Vercel the project filesystem is read-only except /tmp.
// Local driver still works for demos but files are lost when the instance
// recycles — set STORAGE_DRIVER=s3 (or R2/B2) for real persistence.
const isVercel = !!process.env.VERCEL;
const defaultLocalDir = isVercel
  ? path.join("/tmp", "eduvault-uploads")
  : path.join(__dirname, "..", "uploads");

const LOCAL_UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : defaultLocalDir;

if (DRIVER === "local") {
  try {
    if (!fs.existsSync(LOCAL_UPLOAD_DIR)) {
      fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
    }
  } catch (e) {
    console.error(
      "[eduvault] Cannot create local upload dir:",
      LOCAL_UPLOAD_DIR,
      e.message,
      "— set STORAGE_DRIVER=s3 and S3_* env vars on Vercel."
    );
  }
  if (isVercel && !process.env.UPLOAD_DIR) {
    console.warn(
      "[eduvault] STORAGE_DRIVER=local on Vercel uses ephemeral /tmp. " +
        "Uploads will disappear after cold starts. Prefer STORAGE_DRIVER=s3."
    );
  }
}

// ---- S3 driver (lazy-loaded so @aws-sdk/client-s3 is optional) -----------
let _s3 = null;
let _s3cmds = null;

function getS3() {
  if (_s3) return _s3;
  let S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand;
  try {
    ({ S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3"));
  } catch (e) {
    throw new Error(
      "STORAGE_DRIVER=s3 requires the @aws-sdk/client-s3 package. Install it with: npm install @aws-sdk/client-s3"
    );
  }
  if (!process.env.S3_BUCKET || !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) {
    throw new Error(
      "STORAGE_DRIVER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY to be set."
    );
  }

  const endpoint = process.env.S3_ENDPOINT || undefined; // set for R2/B2/Supabase Storage/MinIO; omit for real AWS S3
  const isSupabaseEndpoint = /supabase\.(co|com)/i.test(endpoint || "");

  // Supabase Storage's S3-compatible endpoint requires path-style bucket
  // addressing (https://<endpoint>/<bucket>/<key>) rather than AWS's
  // default virtual-hosted style (https://<bucket>.<endpoint>/<key>).
  // Auto-enable it when the endpoint looks like Supabase, same as db.js
  // auto-detects Supabase Postgres hosts and adjusts sslmode/pgbouncer --
  // still overridable via S3_FORCE_PATH_STYLE if you ever need to.
  const forcePathStyle =
    process.env.S3_FORCE_PATH_STYLE != null
      ? process.env.S3_FORCE_PATH_STYLE === "true"
      : isSupabaseEndpoint;

  _s3 = new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint,
    forcePathStyle,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
  _s3cmds = { PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
  return _s3;
}

/**
 * Move a file multer already wrote to a local temp path into permanent
 * storage under `key` (e.g. "3f1c...-a1.pdf"). Returns the stored key.
 */
async function saveFromTempPath(tempPath, key, contentType) {
  if (DRIVER === "s3") {
    const s3 = getS3();
    const body = fs.createReadStream(tempPath);
    await s3.send(
      new _s3cmds.PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType || "application/octet-stream",
      })
    );
    await fs.promises.unlink(tempPath).catch(() => {});
    return key;
  }

  // local
  const dest = path.join(LOCAL_UPLOAD_DIR, key);
  await pipeline(fs.createReadStream(tempPath), fs.createWriteStream(dest));
  await fs.promises.unlink(tempPath).catch(() => {});
  return key;
}

/** Stream a stored file to an Express response (used for view/download). */
async function streamTo(res, key) {
  if (DRIVER === "s3") {
    const s3 = getS3();
    const result = await s3.send(
      new _s3cmds.GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key })
    );
    await pipeline(result.Body, res);
    return;
  }

  const filePath = path.join(LOCAL_UPLOAD_DIR, key);
  if (!fs.existsSync(filePath)) {
    const err = new Error("File missing from storage.");
    err.code = "ENOENT";
    throw err;
  }
  await pipeline(fs.createReadStream(filePath), res);
}

async function deleteFile(key) {
  if (DRIVER === "s3") {
    const s3 = getS3();
    await s3.send(new _s3cmds.DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    return;
  }
  const filePath = path.join(LOCAL_UPLOAD_DIR, key);
  if (fs.existsSync(filePath)) await fs.promises.unlink(filePath);
}

module.exports = {
  driver: DRIVER,
  localUploadDir: LOCAL_UPLOAD_DIR,
  saveFromTempPath,
  streamTo,
  deleteFile,
};
