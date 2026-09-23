// ---------------------------------------------------------------------------
// EduVault data layer — PostgreSQL via pg (Supabase compatible)
// Supports both local PostgreSQL and Supabase deployments
// ---------------------------------------------------------------------------

const crypto = require("crypto");
const { Pool } = require("pg");

// Connection pool — works with local PostgreSQL and Supabase (Vercel serverless).
// CRITICAL for Supabase + Vercel:
// 1. Prefer Transaction pooler URI (port 6543) from Supabase → Settings → Database.
// 2. We auto-add pgbouncer=true for pooler hosts.
// 3. SSL is configured ONLY via the Pool `ssl` option (rejectUnauthorized: false
//    for remote/Supabase). We intentionally strip sslmode from the connection
//    string because node-pg merges parsed URL params ON TOP of the config
//    object (Object.assign({}, config, parse(connectionString))), so an
//    sslmode=require in the URL would overwrite ssl: { rejectUnauthorized: false }
//    and cause SELF_SIGNED_CERT_IN_CHAIN against Supabase's cert chain.
// 4. max: 1 + query retries avoid transient SSL/handshake failures on cold starts.
function normalizeDatabaseUrl(raw) {
  let url = (raw || "postgresql://localhost/eduvault").trim();
  // Strip accidental quotes from Vercel env UI copy-paste
  if (
    (url.startsWith('"') && url.endsWith('"')) ||
    (url.startsWith("'") && url.endsWith("'"))
  ) {
    url = url.slice(1, -1);
  }

  const isLocal = /localhost|127\.0\.0\.1/.test(url);
  if (isLocal) return url;

  const isSupabase = /supabase\.(co|com)|pooler\.supabase/i.test(url);
  const isPooler = /pooler\.supabase|:6543\b/i.test(url);

  try {
    const u = new URL(url);
    // Do NOT set sslmode here — SSL is applied via Pool config below.
    // If a caller already put sslmode in DATABASE_URL, strip it so it cannot
    // override ssl: { rejectUnauthorized: false }.
    u.searchParams.delete("sslmode");
    // Transaction-mode PgBouncer (port 6543) breaks prepared statements unless flagged
    if (isPooler || isSupabase) {
      if (!u.searchParams.has("pgbouncer")) u.searchParams.set("pgbouncer", "true");
    }
    return u.toString();
  } catch {
    // Fallback string surgery if URL parser fails on unusual schemes
    url = url.replace(/([?&])sslmode=[^&]*/gi, "$1").replace(/[?&]$/, "");
    url = url.replace(/\?&/, "?").replace(/&&+/g, "&");
    if ((isPooler || isSupabase) && !/pgbouncer=/i.test(url)) {
      url += (url.includes("?") ? "&" : "?") + "pgbouncer=true";
    }
    return url;
  }
}

function buildPoolConfig() {
  const connectionString = normalizeDatabaseUrl(
    process.env.DATABASE_URL || "postgresql://localhost/eduvault"
  );

  const isLocal =
    /localhost|127\.0\.0\.1/.test(connectionString) &&
    !process.env.DATABASE_SSL;

  // Remote / Supabase always needs TLS. Localhost stays plain unless
  // DATABASE_SSL=true is set explicitly for a local Postgres with certs.
  const needsSsl =
    !isLocal ||
    process.env.DATABASE_SSL === "true" ||
    /supabase/i.test(connectionString);

  const isServerless = !!(
    process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.FUNCTION_NAME
  );

  if (process.env.DATABASE_URL) {
    // Log host only (never password) so Vercel runtime logs help debugging.
    // This is also the easiest way to CONFIRM local dev and Vercel
    // production are pointed at the same Supabase project: run the app
    // locally and check this line in your terminal, then check the same
    // line in Vercel's Runtime Logs after deploying -- the `host=` value
    // should be identical in both. If it isn't, your local .env and your
    // Vercel Environment Variable have different DATABASE_URL values
    // (e.g. two different Supabase projects, or a stale value in one
    // place), and you'll see accounts that exist in one environment but
    // not the other.
    try {
      const u = new URL(connectionString);
      console.log(
        `[eduvault] Postgres host=${u.hostname} port=${u.port || "5432"} ssl=${!!needsSsl} serverless=${isServerless}`
      );
    } catch (_) {}
  }

  // Hard safety check: a serverless Vercel function has no "localhost" of
  // its own to connect to -- if DATABASE_URL wasn't set as a Vercel
  // Environment Variable, buildPoolConfig() silently falls back to
  // postgresql://localhost/eduvault, which will just hang/fail to connect
  // on every request in production. Fail loudly instead of ambiguously.
  if (isServerless && /localhost|127\.0\.0\.1/.test(connectionString)) {
    console.error(
      "[eduvault] FATAL: running on Vercel (serverless) but DATABASE_URL is unset or points at " +
        "localhost. Set DATABASE_URL as a Vercel Environment Variable (Project -> Settings -> " +
        "Environment Variables) to your Supabase Transaction pooler URL, then redeploy."
    );
  }

  // Explicit ssl object is the source of truth. sslmode has been stripped
  // from the connection string so pg-connection-string cannot overwrite this.
  return {
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: isServerless ? 1 : 10,
    idleTimeoutMillis: isServerless ? 5000 : 30000,
    connectionTimeoutMillis: 20000,
    allowExitOnIdle: isServerless,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  };
}

const pool = new Pool(buildPoolConfig());

// Handle connection errors
pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
});

// Retry transient SSL / connection drops (common on Vercel cold start + Supabase)
const TRANSIENT_RE =
  /ssl|tls|ECONNRESET|ECONNREFUSED|Connection terminated|timeout|EPROTO|handshake|Client has encountered a connection|Connection ended unexpectedly|sorry, too many clients/i;

const _rawQuery = pool.query.bind(pool);
pool.query = async function queryWithRetry(text, params) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await _rawQuery(text, params);
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message ? err.message : err);
      if (attempt < 3 && TRANSIENT_RE.test(msg)) {
        console.warn(
          `[eduvault] DB transient error (attempt ${attempt}/3):`,
          msg.slice(0, 180)
        );
        // Drop bad clients from the pool, then brief backoff
        await new Promise((r) => setTimeout(r, 300 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
};

// Initialize database schema on startup
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS teachers (
        emp_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        department TEXT,
        subjects_handled TEXT,
        email TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'teacher',
        active BOOLEAN NOT NULL DEFAULT true,
        email_verified BOOLEAN NOT NULL DEFAULT false,
        seeded BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS students (
        roll_no TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        department TEXT,
        semester TEXT,
        email TEXT,
        password_hash TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        bookmarked_teachers JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS materials (
        material_id TEXT PRIMARY KEY,
        emp_id TEXT NOT NULL REFERENCES teachers(emp_id),
        subject TEXT,
        title TEXT,
        unit TEXT,
        semester TEXT,
        file_url TEXT,
        original_name TEXT,
        upload_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS access_logs (
        log_id TEXT PRIMARY KEY,
        roll_no TEXT NOT NULL REFERENCES students(roll_no),
        material_id TEXT NOT NULL REFERENCES materials(material_id),
        accessed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS trusted_devices (
        id SERIAL PRIMARY KEY,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(owner_type, owner_id, token_hash)
      );

      CREATE TABLE IF NOT EXISTS enrollment_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL,
        email TEXT NOT NULL,
        employee_id TEXT,
        department TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT,
        employee_id TEXT,
        department TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TIMESTAMP,
        used_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_enrollment_email ON enrollment_codes(email);
      CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);
      CREATE INDEX IF NOT EXISTS idx_materials_emp ON materials(emp_id);
      CREATE INDEX IF NOT EXISTS idx_access_material ON access_logs(material_id);
      CREATE INDEX IF NOT EXISTS idx_reset_token_hash ON password_reset_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_reset_email ON password_reset_tokens(email);

      CREATE TABLE IF NOT EXISTS teacher_google_drive (
        emp_id TEXT PRIMARY KEY REFERENCES teachers(emp_id) ON DELETE CASCADE,
        google_account_id TEXT,
        google_email TEXT,
        refresh_token_enc TEXT NOT NULL,
        access_token_enc TEXT,
        token_expiry TIMESTAMP,
        root_folder_id TEXT,
        materials_folder_id TEXT,
        submissions_folder_id TEXT,
        connected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS submission_requests (
        request_id TEXT PRIMARY KEY,
        emp_id TEXT NOT NULL REFERENCES teachers(emp_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        public_token TEXT NOT NULL UNIQUE,
        deadline TIMESTAMP,
        active BOOLEAN NOT NULL DEFAULT true,
        allow_multiple BOOLEAN NOT NULL DEFAULT false,
        max_files INTEGER NOT NULL DEFAULT 1,
        max_file_size_mb INTEGER NOT NULL DEFAULT 25,
        allowed_extensions TEXT NOT NULL DEFAULT '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.jpg,.jpeg,.png,.zip',
        drive_folder_id TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_subreq_emp ON submission_requests(emp_id);
      CREATE INDEX IF NOT EXISTS idx_subreq_token ON submission_requests(public_token);

      CREATE TABLE IF NOT EXISTS submission_form_fields (
        field_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES submission_requests(request_id) ON DELETE CASCADE,
        field_type TEXT NOT NULL,
        label TEXT NOT NULL,
        required BOOLEAN NOT NULL DEFAULT true,
        options_json JSONB,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_subfields_req ON submission_form_fields(request_id);

      CREATE TABLE IF NOT EXISTS submission_records (
        submission_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES submission_requests(request_id) ON DELETE CASCADE,
        roll_no TEXT,
        student_name TEXT,
        answers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'submitted',
        drive_folder_id TEXT,
        submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_subrec_req ON submission_records(request_id);
      CREATE INDEX IF NOT EXISTS idx_subrec_roll ON submission_records(roll_no);

      CREATE TABLE IF NOT EXISTS submission_files (
        file_id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL REFERENCES submission_records(submission_id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        mime_type TEXT,
        size_bytes BIGINT,
        drive_file_id TEXT,
        drive_web_url TEXT,
        storage_key TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_subfiles_sub ON submission_files(submission_id);
    `);
    console.log("✓ Database schema initialized");
  } catch (err) {
    console.error("Error initializing database:", err);
  }
}

// ---------------------------------------------------------------------------
// Safe sequential schema bootstrap
// ---------------------------------------------------------------------------
// Older EduVault databases may predate columns/tables added in later versions.
// CREATE TABLE IF NOT EXISTS does NOT alter existing tables, so every column
// the app expects on an existing relation is added via ALTER ... IF NOT EXISTS.
// All steps run one after another — concurrent CREATE TABLE can race on
// PostgreSQL type catalog (pg_type_typname_nsp_index).
// ---------------------------------------------------------------------------

async function ensureTeacherSchema() {
  try {
    await pool.query(`
      ALTER TABLE teachers ADD COLUMN IF NOT EXISTS department TEXT;
      ALTER TABLE teachers ADD COLUMN IF NOT EXISTS subjects_handled TEXT;
      ALTER TABLE teachers ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE teachers ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'teacher';
      ALTER TABLE teachers ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE teachers ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE teachers ADD COLUMN IF NOT EXISTS seeded BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE teachers ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
    `);
  } catch (err) {
    console.warn("[eduvault] ensureTeacherSchema:", err.message);
  }
}

async function ensureStudentSchema() {
  try {
    await pool.query(`
      ALTER TABLE students ADD COLUMN IF NOT EXISTS semester TEXT;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS department TEXT;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS bookmarked_teachers JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
    `);
  } catch (err) {
    console.warn("[eduvault] ensureStudentSchema:", err.message);
  }
}

async function ensureMaterialsDriveColumns() {
  try {
    await pool.query(`
      ALTER TABLE materials ADD COLUMN IF NOT EXISTS subject TEXT;
      ALTER TABLE materials ADD COLUMN IF NOT EXISTS title TEXT;
      ALTER TABLE materials ADD COLUMN IF NOT EXISTS unit TEXT;
      ALTER TABLE materials ADD COLUMN IF NOT EXISTS semester TEXT;
      ALTER TABLE materials ADD COLUMN IF NOT EXISTS file_url TEXT;
      ALTER TABLE materials ADD COLUMN IF NOT EXISTS original_name TEXT;
      ALTER TABLE materials ADD COLUMN IF NOT EXISTS upload_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE materials ADD COLUMN IF NOT EXISTS drive_file_id TEXT;
      ALTER TABLE materials ADD COLUMN IF NOT EXISTS drive_web_url TEXT;
      ALTER TABLE materials ADD COLUMN IF NOT EXISTS storage_backend TEXT DEFAULT 'local';
    `);
  } catch (err) {
    console.warn("[eduvault] ensureMaterialsDriveColumns:", err.message);
  }
}

async function ensureAccessLogsSchema() {
  try {
    await pool.query(`
      ALTER TABLE access_logs ADD COLUMN IF NOT EXISTS accessed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
    `);
  } catch (err) {
    console.warn("[eduvault] ensureAccessLogsSchema:", err.message);
  }
}

async function ensureSubmissionSchema() {
  try {
    // Tables only — never DROP. Concurrent callers removed; sequential only.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS teacher_google_drive (
        emp_id TEXT PRIMARY KEY REFERENCES teachers(emp_id) ON DELETE CASCADE,
        google_account_id TEXT,
        google_email TEXT,
        refresh_token_enc TEXT NOT NULL,
        access_token_enc TEXT,
        token_expiry TIMESTAMP,
        root_folder_id TEXT,
        materials_folder_id TEXT,
        submissions_folder_id TEXT,
        connected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS submission_requests (
        request_id TEXT PRIMARY KEY,
        emp_id TEXT NOT NULL REFERENCES teachers(emp_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        public_token TEXT NOT NULL UNIQUE,
        deadline TIMESTAMP,
        active BOOLEAN NOT NULL DEFAULT true,
        allow_multiple BOOLEAN NOT NULL DEFAULT false,
        max_files INTEGER NOT NULL DEFAULT 1,
        max_file_size_mb INTEGER NOT NULL DEFAULT 25,
        allowed_extensions TEXT NOT NULL DEFAULT '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.jpg,.jpeg,.png,.zip',
        drive_folder_id TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_subreq_emp ON submission_requests(emp_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_subreq_token ON submission_requests(public_token)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS submission_form_fields (
        field_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES submission_requests(request_id) ON DELETE CASCADE,
        field_type TEXT NOT NULL,
        label TEXT NOT NULL,
        required BOOLEAN NOT NULL DEFAULT true,
        options_json JSONB,
        display_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_subfields_req ON submission_form_fields(request_id)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS submission_records (
        submission_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES submission_requests(request_id) ON DELETE CASCADE,
        roll_no TEXT,
        student_name TEXT,
        answers_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'submitted',
        drive_folder_id TEXT,
        submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_subrec_req ON submission_records(request_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_subrec_roll ON submission_records(roll_no)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS submission_files (
        file_id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL REFERENCES submission_records(submission_id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        mime_type TEXT,
        size_bytes BIGINT,
        drive_file_id TEXT,
        drive_web_url TEXT,
        storage_key TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_subfiles_sub ON submission_files(submission_id)`);
  } catch (err) {
    console.warn("[eduvault] ensureSubmissionSchema:", err.message);
  }
}

/**
 * Ordered database bootstrap. Call once at process start and await it
 * before seed admin / accepting traffic that needs schema.
 */
async function startDatabase() {
  await initializeDatabase();
  await ensureTeacherSchema();
  await ensureStudentSchema();
  await ensureMaterialsDriveColumns();
  await ensureAccessLogsSchema();
  await ensureSubmissionSchema();
  console.log("✓ Database migrations complete");
}

// Do NOT fire migrations concurrently on module load — callers must await
// startDatabase() (see server.js).

// ---- Utility Functions -----
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}

function newId() {
  return crypto.randomUUID();
}

function hashDeviceToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// ID normalization (emp_id / roll_no)
// ---------------------------------------------------------------------------
// BUG FIX: registration always trimmed these IDs before insert, but login
// (routes/teachers.js, routes/students.js) passed req.body.emp_id /
// req.body.roll_no straight into the lookup query with no trim and no case
// normalization. Since these columns are TEXT PRIMARY KEY (case-sensitive,
// exact-match in Postgres), a student who registered as "22CS1042" but
// typed/pasted "22cs1042" or "22CS1042 " at login got "No student found"
// even though the account exists.
//
// Fix, applied centrally here so every caller (routes, admin actions,
// device-trust, bookmarks, etc.) benefits without having to remember to
// normalize at every call site:
//   1. Always trim before using an ID in any query.
//   2. Lookups (findStudent/findTeacher, and therefore every
//      authenticate*/analytics/bookmark/admin function built on top of
//      them) match case-INsensitively via UPPER(...) = UPPER($1), so
//      existing rows are unaffected regardless of what case they were
//      originally stored in.
//   3. The stored value itself is left as the user typed it at
//      registration (just trimmed) -- we don't force-uppercase on write,
//      since ID cards may be printed in mixed case and students expect to
//      see their own ID back exactly as entered.
//   4. Any UPDATE/DELETE by ID (activate/deactivate, delete, bookmark)
//      first resolves the canonical stored value via findStudent/
//      findTeacher, then uses THAT exact value in the write query -- never
//      the raw, possibly differently-cased input -- so the write always
//      targets the correct row.
function normalizeId(id) {
  return String(id || "").trim();
}

function rowTeacher(t) {
  if (!t) return null;
  return {
    emp_id: t.emp_id,
    name: t.name,
    department: t.department,
    subjects_handled: t.subjects_handled,
    email: t.email,
    password_hash: t.password_hash,
    role: t.role,
    active: Boolean(t.active),
    email_verified: Boolean(t.email_verified),
    seeded: Boolean(t.seeded),
    created_at: t.created_at,
  };
}

function parseBookmarks(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value == null || value === "") return [];
  if (typeof value === "string") {
    const s = value.trim();
    // Postgres text[] literal form: {a,b} or {"a","b"}
    if (s.startsWith("{") && s.endsWith("}")) {
      const inner = s.slice(1, -1).trim();
      if (!inner) return [];
      // naive split that respects simple quoted items
      const out = [];
      let cur = "";
      let inQ = false;
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === "," && !inQ) {
          if (cur.trim()) out.push(cur.trim());
          cur = "";
          continue;
        }
        cur += ch;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    }
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return s ? [s] : [];
    }
  }
  return [];
}

function rowStudent(s) {
  if (!s) return null;
  return {
    roll_no: s.roll_no,
    name: s.name,
    department: s.department,
    semester: s.semester,
    email: s.email,
    password_hash: s.password_hash,
    // pg may return boolean or (rarely) string/int depending on driver/settings
    active: s.active === true || s.active === 1 || s.active === "t" || s.active === "true",
    bookmarked_teachers: parseBookmarks(s.bookmarked_teachers),
    created_at: s.created_at,
  };
}

function rowMaterial(m) {
  if (!m) return null;
  return { ...m };
}

function rowEnrollment(c) {
  if (!c) return null;
  return {
    id: c.id,
    code_hash: c.code_hash,
    email: c.email,
    employee_id: c.employee_id,
    department: c.department,
    attempts: c.attempts,
    expires_at: c.expires_at,
    used_at: c.used_at,
    created_at: c.created_at,
    revoked_at: c.revoked_at,
  };
}

// ---- Device Trust ----
async function trustDevice(owner_type, owner_id, device_token) {
  if (!device_token) return;
  const token_hash = hashDeviceToken(device_token);
  try {
    await pool.query(
      `INSERT INTO trusted_devices (owner_type, owner_id, token_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_type, owner_id, token_hash) DO NOTHING`,
      [owner_type, owner_id, token_hash]
    );
  } catch (_) {
    // ignore conflicts
  }
}

async function isDeviceTrusted(owner_type, owner_id, device_token) {
  if (!device_token) return false;
  const token_hash = hashDeviceToken(device_token);
  const result = await pool.query(
    `SELECT 1 as ok FROM trusted_devices
     WHERE owner_type = $1 AND owner_id = $2 AND token_hash = $3`,
    [owner_type, owner_id, token_hash]
  );
  return result.rows.length > 0;
}

async function isIdCardAlreadyRegistered(id) {
  const normalizedId = normalizeId(id);
  const studentResult = await pool.query(
    `SELECT roll_no FROM students WHERE UPPER(roll_no) = UPPER($1)`,
    [normalizedId]
  );
  if (studentResult.rows.length) return { exists: true, role: "student" };

  const teacherResult = await pool.query(
    `SELECT emp_id FROM teachers WHERE UPPER(emp_id) = UPPER($1)`,
    [normalizedId]
  );
  if (teacherResult.rows.length) return { exists: true, role: "teacher" };

  return { exists: false, role: null };
}

// ---- Teachers ----
async function createTeacher({
  emp_id,
  name,
  department,
  subjects_handled,
  email,
  password,
  role,
  email_verified,
  seeded,
}) {
  const id = normalizeId(emp_id);
  const existing = await pool.query(`SELECT emp_id FROM teachers WHERE UPPER(emp_id) = UPPER($1)`, [id]);
  if (existing.rows.length) throw new Error("A teacher with this Employee ID already exists.");

  const password_hash = hashPassword(password);
  const roleVal = role === "admin" ? "admin" : "teacher";

  const result = await pool.query(
    `INSERT INTO teachers
     (emp_id, name, department, subjects_handled, email, password_hash, role, active, email_verified, seeded)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9)
     RETURNING *`,
    [
      id,
      name,
      department,
      subjects_handled,
      email,
      password_hash,
      roleVal,
      email_verified ? true : false,
      seeded ? true : false,
    ]
  );

  return sanitizeTeacher(rowTeacher(result.rows[0]));
}

async function findTeacher(emp_id) {
  const id = normalizeId(emp_id);
  const result = await pool.query(`SELECT * FROM teachers WHERE UPPER(emp_id) = UPPER($1)`, [id]);
  return result.rows.length ? rowTeacher(result.rows[0]) : null;
}

async function listTeachers() {
  const result = await pool.query(`SELECT * FROM teachers`);
  return result.rows.map((t) => sanitizeTeacher(rowTeacher(t)));
}

function sanitizeTeacher(t) {
  if (!t) return null;
  const { password_hash, ...rest } = t;
  return rest;
}

async function authenticateTeacher(emp_id, password) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) throw new Error("No teacher found with that Employee ID.");
  if (!verifyPassword(password, teacher.password_hash)) {
    throw new Error("Incorrect password.");
  }
  if (teacher.active === false) {
    const err = new Error("This account has been deactivated. Contact your administrator.");
    err.code = "ACCOUNT_INACTIVE";
    throw err;
  }
  return sanitizeTeacher(teacher);
}

async function authenticateTeacherByCard(emp_id, device_token) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) {
    const err = new Error("No teacher account is registered for this ID card yet.");
    err.code = "UNKNOWN_CARD";
    throw err;
  }
  if (!(await isDeviceTrusted("teacher", teacher.emp_id, device_token))) {
    const err = new Error(
      "This device hasn't been used with your password yet. Please log in with your Employee ID and password once to enable one-tap card login on this device."
    );
    err.code = "DEVICE_NOT_TRUSTED";
    throw err;
  }
  if (teacher.active === false) {
    const err = new Error("This account has been deactivated. Contact your administrator.");
    err.code = "ACCOUNT_INACTIVE";
    throw err;
  }
  return sanitizeTeacher(teacher);
}

// ---- Students ----
async function createStudent({ roll_no, name, department, semester, email, password }) {
  const id = normalizeId(roll_no);
  if (!id) throw new Error("Roll Number is required.");

  const existing = await pool.query(`SELECT roll_no FROM students WHERE UPPER(roll_no) = UPPER($1)`, [id]);
  if (existing.rows.length) throw new Error("A student with this Roll Number already exists.");

  const password_hash = hashPassword(password);

  // Omit bookmarked_teachers on INSERT so the column DEFAULT applies
  // (works for both text[] DEFAULT '{}' and jsonb DEFAULT '[]').
  const result = await pool.query(
    `INSERT INTO students
     (roll_no, name, department, semester, email, password_hash, active)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     RETURNING *`,
    [
      id,
      String(name || "").trim(),
      department ? String(department).trim() : null,
      semester ? String(semester).trim() : null,
      email ? String(email).trim() : null,
      password_hash,
    ]
  );

  if (!result.rows.length) {
    throw new Error("Student was not saved. Please try again.");
  }

  return sanitizeStudent(rowStudent(result.rows[0]));
}

async function findStudent(roll_no) {
  const id = normalizeId(roll_no);
  const result = await pool.query(`SELECT * FROM students WHERE UPPER(roll_no) = UPPER($1)`, [id]);
  return result.rows.length ? rowStudent(result.rows[0]) : null;
}

function sanitizeStudent(s) {
  if (!s) return null;
  const { password_hash, ...rest } = s;
  return rest;
}

async function authenticateStudent(roll_no, password) {
  const student = await findStudent(roll_no);
  if (!student) throw new Error("No student found with that Roll Number.");
  if (!verifyPassword(password, student.password_hash)) {
    throw new Error("Incorrect password.");
  }
  if (student.active === false) {
    const err = new Error("This account has been deactivated. Contact your administrator.");
    err.code = "ACCOUNT_INACTIVE";
    throw err;
  }
  return sanitizeStudent(student);
}

async function authenticateStudentByCard(roll_no, device_token) {
  const student = await findStudent(roll_no);
  if (!student) {
    const err = new Error("No student account is registered for this ID card yet.");
    err.code = "UNKNOWN_CARD";
    throw err;
  }
  if (!(await isDeviceTrusted("student", student.roll_no, device_token))) {
    const err = new Error(
      "This device hasn't been used with your password yet. Please log in with your Roll Number and password once to enable one-tap card login on this device."
    );
    err.code = "DEVICE_NOT_TRUSTED";
    throw err;
  }
  if (student.active === false) {
    const err = new Error("This account has been deactivated. Contact your administrator.");
    err.code = "ACCOUNT_INACTIVE";
    throw err;
  }
  return sanitizeStudent(student);
}

// Cached once per process: actual PG type of students.bookmarked_teachers
// Older EduVault DBs used text[]; newer schema uses jsonb. Never change the
// column type — adapt the write format to whatever already exists.
let _bookmarksColKind = null; // "array" | "jsonb" | "unknown"

async function detectBookmarksColumnKind() {
  if (_bookmarksColKind) return _bookmarksColKind;
  try {
    const r = await pool.query(
      `SELECT data_type, udt_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'students'
         AND column_name = 'bookmarked_teachers'
       LIMIT 1`
    );
    if (r.rows.length) {
      const udt = String(r.rows[0].udt_name || "").toLowerCase();
      const dt = String(r.rows[0].data_type || "").toLowerCase();
      if (udt === "_text" || udt === "_varchar" || dt === "array" || udt.startsWith("_")) {
        _bookmarksColKind = "array";
      } else if (udt === "jsonb" || udt === "json" || dt.includes("json")) {
        _bookmarksColKind = "jsonb";
      } else {
        _bookmarksColKind = "unknown";
      }
    } else {
      _bookmarksColKind = "unknown";
    }
  } catch {
    _bookmarksColKind = "unknown";
  }
  return _bookmarksColKind;
}

async function writeBookmarks(roll_no, list) {
  const kind = await detectBookmarksColumnKind();
  const arr = Array.isArray(list) ? list.map(String) : [];

  if (kind === "array") {
    // Native JS array → PostgreSQL text[] (correct binding; avoids
    // "malformed array literal" from JSON.stringify'd strings)
    await pool.query(
      `UPDATE students SET bookmarked_teachers = $1::text[] WHERE roll_no = $2`,
      [arr, roll_no]
    );
    return;
  }
  if (kind === "jsonb") {
    await pool.query(
      `UPDATE students SET bookmarked_teachers = $1::jsonb WHERE roll_no = $2`,
      [JSON.stringify(arr), roll_no]
    );
    return;
  }
  // Unknown: try array first (matches production error), then jsonb
  try {
    await pool.query(
      `UPDATE students SET bookmarked_teachers = $1::text[] WHERE roll_no = $2`,
      [arr, roll_no]
    );
    _bookmarksColKind = "array";
  } catch (e1) {
    await pool.query(
      `UPDATE students SET bookmarked_teachers = $1::jsonb WHERE roll_no = $2`,
      [JSON.stringify(arr), roll_no]
    );
    _bookmarksColKind = "jsonb";
  }
}

async function toggleBookmark(roll_no, emp_id) {
  const student = await findStudent(roll_no);
  if (!student) throw new Error("Student not found.");

  // Resolve to the teacher's canonical stored emp_id, same reasoning as
  // findStudent/findTeacher above -- otherwise a bookmark toggle sent with
  // different casing than what's stored would add a duplicate entry
  // instead of removing the existing one (or vice versa).
  const teacher = await findTeacher(emp_id);
  const canonicalEmpId = teacher ? teacher.emp_id : normalizeId(emp_id);

  let list = (student.bookmarked_teachers || []).slice();
  const idx = list.findIndex(
    (id) => String(id).toUpperCase() === String(canonicalEmpId).toUpperCase()
  );
  if (idx >= 0) list.splice(idx, 1);
  else list.push(canonicalEmpId);

  await writeBookmarks(student.roll_no, list);
  return list;
}

// ---- Invitations ----
async function createInvitation({ email, name, department, employee_id }) {
  const norm = normalizeEmail(email);
  if (!norm) throw new Error("Email is required.");

  const invitationId = newId();
  const now = new Date();

  await pool.query(
    `UPDATE invitations SET revoked_at = $1
     WHERE email = $2 AND used_at IS NULL AND revoked_at IS NULL`,
    [now, norm]
  );

  const result = await pool.query(
    `INSERT INTO invitations
     (id, email, name, employee_id, department, created_at, revoked_at, used_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)
     RETURNING *`,
    [invitationId, norm, name || null, employee_id ? String(employee_id).trim() : null, department || null, now]
  );

  return sanitizeInvitation(result.rows[0]);
}

function sanitizeInvitation(inv) {
  if (!inv) return null;
  let status = "pending";
  if (inv.revoked_at) status = "revoked";
  else if (inv.used_at) status = "used";
  return { ...inv, status };
}

async function listInvitations() {
  const result = await pool.query(
    `SELECT * FROM invitations ORDER BY created_at DESC`
  );
  return result.rows.map(sanitizeInvitation);
}

async function findActiveInvitation(email) {
  const norm = normalizeEmail(email);
  const result = await pool.query(
    `SELECT * FROM invitations
     WHERE email = $1 AND used_at IS NULL AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [norm]
  );
  return result.rows.length ? sanitizeInvitation(result.rows[0]) : null;
}

async function revokeInvitation(id) {
  const result = await pool.query(`SELECT * FROM invitations WHERE id = $1`, [id]);
  if (!result.rows.length) throw new Error("Invitation not found.");
  if (result.rows[0].used_at) throw new Error("This invitation has already been used.");

  const now = new Date();
  await pool.query(`UPDATE invitations SET revoked_at = $1 WHERE id = $2`, [now, id]);

  const updated = await pool.query(`SELECT * FROM invitations WHERE id = $1`, [id]);
  return sanitizeInvitation(updated.rows[0]);
}

async function markInvitationUsed(email) {
  const norm = normalizeEmail(email);
  const now = new Date();
  await pool.query(
    `UPDATE invitations SET used_at = $1
     WHERE email = $2 AND used_at IS NULL AND revoked_at IS NULL`,
    [now, norm]
  );
}

// ---- Enrollment Codes ----
const ENROLLMENT_CODE_TTL_MINUTES = Number(process.env.ENROLLMENT_CODE_TTL_MINUTES) || 15;
const ENROLLMENT_RESEND_COOLDOWN_SEC = Number(process.env.ENROLLMENT_RESEND_COOLDOWN_SEC) || 60;
const ENROLLMENT_MAX_REQUESTS_PER_HOUR = Number(process.env.ENROLLMENT_MAX_REQUESTS_PER_HOUR) || 5;
const ENROLLMENT_MAX_VERIFY_ATTEMPTS = 5;

function hashEnrollmentCode(code, email) {
  const key = process.env.SESSION_SECRET || "eduvault-dev-only-key";
  return crypto.createHmac("sha256", key).update(`${email}:${code}`).digest("hex");
}

function generateEnrollmentCode() {
  const n = crypto.randomInt(0, 1000000);
  return `EDU-${String(n).padStart(6, "0")}`;
}

async function canRequestEnrollmentCode(email) {
  const norm = normalizeEmail(email);
  const now = Date.now();
  
  const result = await pool.query(
    `SELECT * FROM enrollment_codes WHERE email = $1 ORDER BY created_at DESC`,
    [norm]
  );
  
  const recent = result.rows.map(rowEnrollment);

  if (recent.length) {
    const lastMs = new Date(recent[0].created_at).getTime();
    const elapsedSec = (now - lastMs) / 1000;
    if (elapsedSec < ENROLLMENT_RESEND_COOLDOWN_SEC) {
      return {
        allowed: false,
        reason: "cooldown",
        retryAfterSec: Math.ceil(ENROLLMENT_RESEND_COOLDOWN_SEC - elapsedSec),
      };
    }
  }

  const lastHour = recent.filter((c) => now - new Date(c.created_at).getTime() < 60 * 60 * 1000);
  if (lastHour.length >= ENROLLMENT_MAX_REQUESTS_PER_HOUR) {
    return { allowed: false, reason: "hourly_limit", retryAfterSec: 60 * 60 };
  }

  return { allowed: true };
}

async function createEnrollmentCode({ email, department, employee_id }) {
  const norm = normalizeEmail(email);
  const now = new Date();

  await pool.query(
    `UPDATE enrollment_codes
     SET revoked_at = $1
     WHERE email = $2 AND used_at IS NULL AND revoked_at IS NULL`,
    [now, norm]
  );

  const code = generateEnrollmentCode();
  const codeId = newId();
  const expiresAt = new Date(Date.now() + ENROLLMENT_CODE_TTL_MINUTES * 60 * 1000);

  const result = await pool.query(
    `INSERT INTO enrollment_codes
     (id, code_hash, email, employee_id, department, attempts, expires_at, used_at, created_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6, NULL, $7, NULL)
     RETURNING *`,
    [
      codeId,
      hashEnrollmentCode(code, norm),
      norm,
      employee_id ? String(employee_id).trim() : null,
      department || null,
      expiresAt,
      now,
    ]
  );

  return { code, record: sanitizeEnrollmentCode(result.rows[0]) };
}

function sanitizeEnrollmentCode(c) {
  if (!c) return null;
  const { code_hash, ...rest } = c;
  const now = Date.now();
  let status = "active";
  if (c.revoked_at) status = "revoked";
  else if (c.used_at) status = "used";
  else if (new Date(c.expires_at).getTime() < now) status = "expired";
  return { ...rest, status };
}

async function listEnrollmentCodes() {
  const result = await pool.query(
    `SELECT * FROM enrollment_codes ORDER BY created_at DESC`
  );
  return result.rows.map((c) => sanitizeEnrollmentCode(rowEnrollment(c)));
}

async function revokeEnrollmentCode(id) {
  const result = await pool.query(`SELECT * FROM enrollment_codes WHERE id = $1`, [id]);
  if (!result.rows.length) throw new Error("Enrollment code not found.");
  if (result.rows[0].used_at) throw new Error("This code has already been used and cannot be revoked.");

  const now = new Date();
  await pool.query(`UPDATE enrollment_codes SET revoked_at = $1 WHERE id = $2`, [now, id]);

  const updated = await pool.query(`SELECT * FROM enrollment_codes WHERE id = $1`, [id]);
  return sanitizeEnrollmentCode(rowEnrollment(updated.rows[0]));
}

async function verifyEnrollmentCode(email, code) {
  const norm = normalizeEmail(email);
  const result = await pool.query(
    `SELECT * FROM enrollment_codes
     WHERE email = $1 AND used_at IS NULL AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [norm]
  );

  if (!result.rows.length) return { ok: false, reason: "invalid" };
  
  const candidate = result.rows[0];
  if (new Date(candidate.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (candidate.attempts >= ENROLLMENT_MAX_VERIFY_ATTEMPTS) {
    await pool.query(
      `UPDATE enrollment_codes SET revoked_at = $1 WHERE id = $2`,
      [new Date(), candidate.id]
    );
    return { ok: false, reason: "locked" };
  }

  const suppliedHash = hashEnrollmentCode(String(code || "").trim().toUpperCase(), norm);
  const candidateHashBuf = Buffer.from(candidate.code_hash, "hex");
  const suppliedHashBuf = Buffer.from(suppliedHash, "hex");
  const matches =
    candidateHashBuf.length === suppliedHashBuf.length &&
    crypto.timingSafeEqual(candidateHashBuf, suppliedHashBuf);

  if (!matches) {
    await pool.query(
      `UPDATE enrollment_codes SET attempts = attempts + 1 WHERE id = $1`,
      [candidate.id]
    );
    return { ok: false, reason: "invalid" };
  }

  const now = new Date();
  await pool.query(`UPDATE enrollment_codes SET used_at = $1 WHERE id = $2`, [now, candidate.id]);
  const updated = await pool.query(`SELECT * FROM enrollment_codes WHERE id = $1`, [candidate.id]);
  return { ok: true, record: sanitizeEnrollmentCode(rowEnrollment(updated.rows[0])) };
}

// ---- Admin ----
async function ensureSeedAdmin() {
  const emp_id = normalizeId(process.env.ADMIN_EMP_ID || "mani@1774admin");
  const password = process.env.ADMIN_PASSWORD || "mani@1774";

  const existing = await pool.query(`SELECT * FROM teachers WHERE UPPER(emp_id) = UPPER($1)`, [emp_id]);
  if (existing.rows.length) {
    const teacher = existing.rows[0];
    if (teacher.role !== "admin" || !teacher.seeded) {
      await pool.query(
        `UPDATE teachers SET role = 'admin', seeded = true, email_verified = true, active = true WHERE emp_id = $1`,
        [teacher.emp_id]
      );
    }
    const updated = await pool.query(`SELECT * FROM teachers WHERE emp_id = $1`, [teacher.emp_id]);
    return sanitizeTeacher(rowTeacher(updated.rows[0]));
  }

  const password_hash = hashPassword(password);
  const email = process.env.ADMIN_EMAIL || "";

  const result = await pool.query(
    `INSERT INTO teachers
     (emp_id, name, department, subjects_handled, email, password_hash, role, active, email_verified, seeded)
     VALUES ($1, $2, $3, $4, $5, $6, 'admin', true, true, true)
     RETURNING *`,
    [emp_id, "System Administrator", "Administration", "", email, password_hash]
  );

  return sanitizeTeacher(rowTeacher(result.rows[0]));
}

async function listAllTeachers() {
  const result = await pool.query(`SELECT * FROM teachers`);
  return result.rows.map((t) => sanitizeTeacher(rowTeacher(t)));
}

async function listAllStudents() {
  const result = await pool.query(
    `SELECT * FROM students ORDER BY created_at DESC NULLS LAST, roll_no ASC`
  );
  const out = [];
  for (const row of result.rows) {
    try {
      const mapped = sanitizeStudent(rowStudent(row));
      if (mapped && mapped.roll_no) out.push(mapped);
    } catch (err) {
      // Never let one bad row wipe the whole admin list
      console.error("[eduvault] Skipping bad student row:", row && row.roll_no, err.message);
      if (row && row.roll_no) {
        out.push({
          roll_no: row.roll_no,
          name: row.name || "(unknown)",
          department: row.department || null,
          semester: row.semester || null,
          email: row.email || null,
          active: true,
          bookmarked_teachers: [],
          created_at: row.created_at || null,
        });
      }
    }
  }
  return out;
}

async function setTeacherActive(emp_id, active) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) throw new Error("Teacher not found.");
  if (teacher.seeded && !active) throw new Error("The system administrator account cannot be deactivated.");

  // Use the canonical stored emp_id (teacher.emp_id), not the raw input --
  // input casing/whitespace may differ from what's actually stored.
  await pool.query(`UPDATE teachers SET active = $1 WHERE emp_id = $2`, [active, teacher.emp_id]);
  return sanitizeTeacher(await findTeacher(teacher.emp_id));
}

async function setTeacherRole(emp_id, role) {
  if (!["teacher", "admin"].includes(role)) throw new Error("Invalid role.");
  const teacher = await findTeacher(emp_id);
  if (!teacher) throw new Error("Teacher not found.");

  await pool.query(`UPDATE teachers SET role = $1 WHERE emp_id = $2`, [role, teacher.emp_id]);
  return sanitizeTeacher(await findTeacher(teacher.emp_id));
}

async function deleteTeacher(emp_id) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) throw new Error("Teacher not found.");
  if (teacher.seeded) throw new Error("The system administrator account cannot be deleted.");

  await pool.query(`DELETE FROM teachers WHERE emp_id = $1`, [teacher.emp_id]);
  return sanitizeTeacher(teacher);
}

async function setStudentActive(roll_no, active) {
  const student = await findStudent(roll_no);
  if (!student) throw new Error("Student not found.");

  await pool.query(`UPDATE students SET active = $1 WHERE roll_no = $2`, [active, student.roll_no]);
  return sanitizeStudent(await findStudent(student.roll_no));
}

async function deleteStudent(roll_no) {
  const student = await findStudent(roll_no);
  if (!student) throw new Error("Student not found.");

  await pool.query(`DELETE FROM students WHERE roll_no = $1`, [student.roll_no]);
  return sanitizeStudent(student);
}

// ---- Materials ----
async function addMaterial({
  emp_id,
  subject,
  title,
  unit,
  semester,
  file_url,
  original_name,
  drive_file_id = null,
  drive_web_url = null,
  storage_backend = "local",
}) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) throw new Error("Unknown teacher Employee ID.");

  const materialId = newId();
  const result = await pool.query(
    `INSERT INTO materials
     (material_id, emp_id, subject, title, unit, semester, file_url, original_name,
      drive_file_id, drive_web_url, storage_backend)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      materialId,
      emp_id,
      subject,
      title,
      unit || "",
      semester || "",
      file_url,
      original_name,
      drive_file_id,
      drive_web_url,
      storage_backend || "local",
    ]
  );

  return result.rows[0];
}

async function materialsByTeacher(emp_id) {
  const result = await pool.query(
    `SELECT * FROM materials WHERE emp_id = $1 ORDER BY upload_date DESC`,
    [emp_id]
  );
  return result.rows.map(rowMaterial);
}

async function findMaterial(material_id) {
  const result = await pool.query(`SELECT * FROM materials WHERE material_id = $1`, [material_id]);
  return result.rows.length ? rowMaterial(result.rows[0]) : null;
}

async function findMaterialByStoredFilename(filename) {
  // Match by trailing path segment without loading every row into memory.
  const result = await pool.query(
    `SELECT * FROM materials
     WHERE file_url = $1
        OR file_url LIKE $2
        OR file_url LIKE $3
     LIMIT 1`,
    [filename, `%/${filename}`, `%\\${filename}`]
  );
  return result.rows.length ? rowMaterial(result.rows[0]) : null;
}

async function deleteMaterial(material_id, emp_id) {
  const result = await pool.query(
    `SELECT * FROM materials WHERE material_id = $1 AND emp_id = $2`,
    [material_id, emp_id]
  );
  if (!result.rows.length) throw new Error("Material not found for this teacher.");

  const material = result.rows[0];
  await pool.query(
    `DELETE FROM materials WHERE material_id = $1 AND emp_id = $2`,
    [material_id, emp_id]
  );
  return rowMaterial(material);
}

// ---- Access Logs ----
async function logAccess({ roll_no, material_id }) {
  const logId = newId();
  const now = new Date();
  
  const result = await pool.query(
    `INSERT INTO access_logs (log_id, roll_no, material_id, accessed_on)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [logId, roll_no, material_id, now]
  );

  return result.rows[0];
}

async function accessCountsForTeacher(emp_id) {
  const materials = await materialsByTeacher(emp_id);
  const materialIds = materials.map((m) => m.material_id);
  
  if (!materialIds.length) return {};

  const placeholders = materialIds.map((_, i) => `$${i + 1}`).join(",");
  const result = await pool.query(
    `SELECT material_id, COUNT(*) AS cnt FROM access_logs
     WHERE material_id IN (${placeholders})
     GROUP BY material_id`,
    materialIds
  );

  const counts = {};
  result.rows.forEach((r) => {
    counts[r.material_id] = parseInt(r.cnt);
  });
  return counts;
}


// ---- Password Reset ----
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function hashResetToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken)).digest("hex");
}

/**
 * Look up a user by email across students and teachers (including admin).
 * Returns { role, owner_id, email, name } or null.
 * Does not reveal which table matched to callers that only need existence.
 */
async function findUserByEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm) return null;

  const teacherResult = await pool.query(
    `SELECT emp_id, name, email, role FROM teachers
     WHERE LOWER(TRIM(email)) = $1 AND active = true
     LIMIT 1`,
    [norm]
  );
  if (teacherResult.rows.length) {
    const t = teacherResult.rows[0];
    return {
      role: t.role === "admin" ? "admin" : "teacher",
      owner_id: t.emp_id,
      email: normalizeEmail(t.email),
      name: t.name,
    };
  }

  const studentResult = await pool.query(
    `SELECT roll_no, name, email FROM students
     WHERE LOWER(TRIM(email)) = $1 AND active = true
     LIMIT 1`,
    [norm]
  );
  if (studentResult.rows.length) {
    const s = studentResult.rows[0];
    return {
      role: "student",
      owner_id: s.roll_no,
      email: normalizeEmail(s.email),
      name: s.name,
    };
  }

  return null;
}

/**
 * Create a one-time password reset token for the given user.
 * Returns the raw token (to email) — only the hash is stored.
 * Invalidates any previous unused tokens for the same email.
 */
async function createPasswordResetToken({ email, role, owner_id }) {
  const norm = normalizeEmail(email);
  if (!norm) throw new Error("Email is required.");

  const rawToken = crypto.randomBytes(32).toString("hex");
  const token_hash = hashResetToken(rawToken);
  const id = newId();
  const now = new Date();
  const expires_at = new Date(now.getTime() + RESET_TOKEN_TTL_MS);

  // Invalidate previous unused tokens for this email
  await pool.query(
    `UPDATE password_reset_tokens SET used_at = $1
     WHERE email = $2 AND used_at IS NULL`,
    [now, norm]
  );

  await pool.query(
    `INSERT INTO password_reset_tokens
     (id, email, role, owner_id, token_hash, expires_at, used_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, $7)`,
    [id, norm, role, owner_id, token_hash, expires_at, now]
  );

  return { rawToken, expires_at };
}

/**
 * Find a valid (unused, unexpired) reset token by raw token string.
 */
async function findValidResetToken(rawToken) {
  if (!rawToken || typeof rawToken !== "string") return null;
  const token_hash = hashResetToken(rawToken.trim());
  const result = await pool.query(
    `SELECT * FROM password_reset_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [token_hash]
  );
  return result.rows.length ? result.rows[0] : null;
}

async function markResetTokenUsed(tokenId) {
  await pool.query(
    `UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`,
    [tokenId]
  );
}

/**
 * Update password for student or teacher/admin by owner_id + role.
 */
async function updateUserPassword({ role, owner_id, newPassword }) {
  if (!newPassword || String(newPassword).length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const password_hash = hashPassword(newPassword);

  if (role === "student") {
    const student = await findStudent(owner_id);
    if (!student) throw new Error("Account not found.");
    await pool.query(
      `UPDATE students SET password_hash = $1 WHERE roll_no = $2`,
      [password_hash, student.roll_no]
    );
    return { role: "student", owner_id: student.roll_no };
  }

  const teacher = await findTeacher(owner_id);
  if (!teacher) throw new Error("Account not found.");
  await pool.query(
    `UPDATE teachers SET password_hash = $1 WHERE emp_id = $2`,
    [password_hash, teacher.emp_id]
  );
  return { role: teacher.role === "admin" ? "admin" : "teacher", owner_id: teacher.emp_id };
}

/**
 * Students who have bookmarked (starred) a given teacher.
 * Returns [{ roll_no, name, email }] — only those with a non-empty email.
 */
async function getStudentsWhoBookmarkedTeacher(emp_id) {
  const teacher = await findTeacher(emp_id);
  const canonical = teacher ? teacher.emp_id : normalizeId(emp_id);
  if (!canonical) return [];

  // JSONB array contains — case-insensitive match via EXISTS on elements
  const result = await pool.query(
    `SELECT roll_no, name, email, bookmarked_teachers
     FROM students
     WHERE active = true
       AND email IS NOT NULL
       AND TRIM(email) <> ''
       AND EXISTS (
         SELECT 1
         FROM jsonb_array_elements_text(COALESCE(bookmarked_teachers, '[]'::jsonb)) AS bt(emp)
         WHERE UPPER(bt.emp) = UPPER($1)
       )`,
    [canonical]
  );

  return result.rows
    .map((r) => ({
      roll_no: r.roll_no,
      name: r.name,
      email: normalizeEmail(r.email),
    }))
    .filter((r) => r.email);
}

// ---------------------------------------------------------------------------
// Google Drive account helpers (tokens stored encrypted by caller)
// ---------------------------------------------------------------------------

async function upsertTeacherGoogleDrive({
  emp_id,
  google_account_id,
  google_email,
  refresh_token_enc,
  access_token_enc,
  token_expiry,
  root_folder_id,
  materials_folder_id,
  submissions_folder_id,
}) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) throw new Error("Unknown teacher.");
  await pool.query(
    `INSERT INTO teacher_google_drive (
       emp_id, google_account_id, google_email, refresh_token_enc, access_token_enc,
       token_expiry, root_folder_id, materials_folder_id, submissions_folder_id, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP)
     ON CONFLICT (emp_id) DO UPDATE SET
       google_account_id = EXCLUDED.google_account_id,
       google_email = EXCLUDED.google_email,
       refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, teacher_google_drive.refresh_token_enc),
       access_token_enc = EXCLUDED.access_token_enc,
       token_expiry = EXCLUDED.token_expiry,
       root_folder_id = COALESCE(EXCLUDED.root_folder_id, teacher_google_drive.root_folder_id),
       materials_folder_id = COALESCE(EXCLUDED.materials_folder_id, teacher_google_drive.materials_folder_id),
       submissions_folder_id = COALESCE(EXCLUDED.submissions_folder_id, teacher_google_drive.submissions_folder_id),
       updated_at = CURRENT_TIMESTAMP`,
    [
      teacher.emp_id,
      google_account_id || null,
      google_email || null,
      refresh_token_enc,
      access_token_enc || null,
      token_expiry || null,
      root_folder_id || null,
      materials_folder_id || null,
      submissions_folder_id || null,
    ]
  );
  return getTeacherGoogleDrive(teacher.emp_id);
}

async function getTeacherGoogleDrive(emp_id) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) return null;
  const result = await pool.query(
    `SELECT * FROM teacher_google_drive WHERE emp_id = $1`,
    [teacher.emp_id]
  );
  return result.rows[0] || null;
}

async function disconnectTeacherGoogleDrive(emp_id) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) return false;
  const result = await pool.query(
    `DELETE FROM teacher_google_drive WHERE emp_id = $1 RETURNING emp_id`,
    [teacher.emp_id]
  );
  return result.rows.length > 0;
}

async function updateTeacherGoogleDriveFolders(emp_id, folders) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) return null;
  await pool.query(
    `UPDATE teacher_google_drive SET
       root_folder_id = COALESCE($2, root_folder_id),
       materials_folder_id = COALESCE($3, materials_folder_id),
       submissions_folder_id = COALESCE($4, submissions_folder_id),
       updated_at = CURRENT_TIMESTAMP
     WHERE emp_id = $1`,
    [
      teacher.emp_id,
      folders.root_folder_id || null,
      folders.materials_folder_id || null,
      folders.submissions_folder_id || null,
    ]
  );
  return getTeacherGoogleDrive(teacher.emp_id);
}

async function updateTeacherGoogleDriveTokens(emp_id, { access_token_enc, token_expiry, refresh_token_enc }) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) return null;
  await pool.query(
    `UPDATE teacher_google_drive SET
       access_token_enc = COALESCE($2, access_token_enc),
       token_expiry = COALESCE($3, token_expiry),
       refresh_token_enc = COALESCE($4, refresh_token_enc),
       updated_at = CURRENT_TIMESTAMP
     WHERE emp_id = $1`,
    [teacher.emp_id, access_token_enc || null, token_expiry || null, refresh_token_enc || null]
  );
  return getTeacherGoogleDrive(teacher.emp_id);
}

// ---------------------------------------------------------------------------
// Submission requests / forms / records
// ---------------------------------------------------------------------------

function newPublicToken() {
  return crypto.randomBytes(24).toString("base64url");
}

async function createSubmissionRequest({
  emp_id,
  title,
  description,
  deadline,
  allow_multiple,
  max_files,
  max_file_size_mb,
  allowed_extensions,
  fields,
}) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) throw new Error("Unknown teacher.");
  if (!title || !String(title).trim()) throw new Error("Title is required.");

  const request_id = newId();
  const public_token = newPublicToken();
  const ext =
    allowed_extensions && String(allowed_extensions).trim()
      ? String(allowed_extensions).trim()
      : ".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.jpg,.jpeg,.png,.zip";

  await pool.query(
    `INSERT INTO submission_requests (
       request_id, emp_id, title, description, public_token, deadline,
       active, allow_multiple, max_files, max_file_size_mb, allowed_extensions
     ) VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10)`,
    [
      request_id,
      teacher.emp_id,
      String(title).trim(),
      description ? String(description).trim() : null,
      public_token,
      deadline ? new Date(deadline) : null,
      !!allow_multiple,
      Math.max(1, Math.min(10, parseInt(max_files, 10) || 1)),
      Math.max(1, Math.min(200, parseInt(max_file_size_mb, 10) || 25)),
      ext,
    ]
  );

  const fieldList = Array.isArray(fields) ? fields : [];
  for (let i = 0; i < fieldList.length; i++) {
    const f = fieldList[i];
    if (!f || !f.label || !f.field_type) continue;
    await pool.query(
      `INSERT INTO submission_form_fields
         (field_id, request_id, field_type, label, required, options_json, display_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        newId(),
        request_id,
        String(f.field_type).slice(0, 40),
        String(f.label).trim().slice(0, 200),
        f.required !== false,
        f.options ? JSON.stringify(f.options) : null,
        typeof f.display_order === "number" ? f.display_order : i,
      ]
    );
  }

  return getSubmissionRequest(request_id);
}

async function getSubmissionRequest(request_id) {
  const result = await pool.query(
    `SELECT * FROM submission_requests WHERE request_id = $1`,
    [request_id]
  );
  if (!result.rows.length) return null;
  const req = result.rows[0];
  const fields = await pool.query(
    `SELECT * FROM submission_form_fields WHERE request_id = $1 ORDER BY display_order ASC, created_at ASC`,
    [request_id]
  );
  req.fields = fields.rows;
  return req;
}

async function getSubmissionRequestByToken(token) {
  if (!token) return null;
  const result = await pool.query(
    `SELECT * FROM submission_requests WHERE public_token = $1`,
    [String(token)]
  );
  if (!result.rows.length) return null;
  const req = result.rows[0];
  const fields = await pool.query(
    `SELECT * FROM submission_form_fields WHERE request_id = $1 ORDER BY display_order ASC, created_at ASC`,
    [req.request_id]
  );
  req.fields = fields.rows;
  return req;
}

async function listSubmissionRequestsByTeacher(emp_id) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) return [];
  const result = await pool.query(
    `SELECT r.*,
            (SELECT COUNT(*)::int FROM submission_records s WHERE s.request_id = r.request_id) AS submission_count
     FROM submission_requests r
     WHERE r.emp_id = $1
     ORDER BY r.created_at DESC`,
    [teacher.emp_id]
  );
  return result.rows;
}

async function updateSubmissionRequest(request_id, emp_id, patch) {
  const existing = await getSubmissionRequest(request_id);
  if (!existing) throw new Error("Submission request not found.");
  const teacher = await findTeacher(emp_id);
  if (!teacher || teacher.emp_id !== existing.emp_id) {
    throw new Error("Not authorized to edit this request.");
  }

  const title = patch.title != null ? String(patch.title).trim() : existing.title;
  const description =
    patch.description !== undefined
      ? patch.description
        ? String(patch.description).trim()
        : null
      : existing.description;
  const deadline =
    patch.deadline !== undefined
      ? patch.deadline
        ? new Date(patch.deadline)
        : null
      : existing.deadline;
  const active = patch.active !== undefined ? !!patch.active : existing.active;
  const allow_multiple =
    patch.allow_multiple !== undefined ? !!patch.allow_multiple : existing.allow_multiple;
  const max_files =
    patch.max_files !== undefined
      ? Math.max(1, Math.min(10, parseInt(patch.max_files, 10) || 1))
      : existing.max_files;
  const max_file_size_mb =
    patch.max_file_size_mb !== undefined
      ? Math.max(1, Math.min(200, parseInt(patch.max_file_size_mb, 10) || 25))
      : existing.max_file_size_mb;
  const allowed_extensions =
    patch.allowed_extensions !== undefined
      ? String(patch.allowed_extensions)
      : existing.allowed_extensions;
  const drive_folder_id =
    patch.drive_folder_id !== undefined ? patch.drive_folder_id : existing.drive_folder_id;

  await pool.query(
    `UPDATE submission_requests SET
       title = $2, description = $3, deadline = $4, active = $5,
       allow_multiple = $6, max_files = $7, max_file_size_mb = $8,
       allowed_extensions = $9, drive_folder_id = $10, updated_at = CURRENT_TIMESTAMP
     WHERE request_id = $1`,
    [
      request_id,
      title,
      description,
      deadline,
      active,
      allow_multiple,
      max_files,
      max_file_size_mb,
      allowed_extensions,
      drive_folder_id,
    ]
  );

  if (Array.isArray(patch.fields)) {
    await pool.query(`DELETE FROM submission_form_fields WHERE request_id = $1`, [request_id]);
    for (let i = 0; i < patch.fields.length; i++) {
      const f = patch.fields[i];
      if (!f || !f.label || !f.field_type) continue;
      await pool.query(
        `INSERT INTO submission_form_fields
           (field_id, request_id, field_type, label, required, options_json, display_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          newId(),
          request_id,
          String(f.field_type).slice(0, 40),
          String(f.label).trim().slice(0, 200),
          f.required !== false,
          f.options ? JSON.stringify(f.options) : null,
          typeof f.display_order === "number" ? f.display_order : i,
        ]
      );
    }
  }

  return getSubmissionRequest(request_id);
}

async function deleteSubmissionRequest(request_id, emp_id) {
  const existing = await getSubmissionRequest(request_id);
  if (!existing) return false;
  const teacher = await findTeacher(emp_id);
  if (!teacher || teacher.emp_id !== existing.emp_id) {
    throw new Error("Not authorized to delete this request.");
  }
  await pool.query(`DELETE FROM submission_requests WHERE request_id = $1`, [request_id]);
  return true;
}

async function createSubmissionRecord({
  request_id,
  roll_no,
  student_name,
  answers_json,
  drive_folder_id,
}) {
  const submission_id = newId();
  const result = await pool.query(
    `INSERT INTO submission_records
       (submission_id, request_id, roll_no, student_name, answers_json, status, drive_folder_id)
     VALUES ($1,$2,$3,$4,$5,'submitted',$6)
     RETURNING *`,
    [
      submission_id,
      request_id,
      roll_no || null,
      student_name || null,
      JSON.stringify(answers_json || {}),
      drive_folder_id || null,
    ]
  );
  return result.rows[0];
}

async function addSubmissionFile({
  submission_id,
  original_name,
  mime_type,
  size_bytes,
  drive_file_id,
  drive_web_url,
  storage_key,
}) {
  const file_id = newId();
  const result = await pool.query(
    `INSERT INTO submission_files
       (file_id, submission_id, original_name, mime_type, size_bytes, drive_file_id, drive_web_url, storage_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      file_id,
      submission_id,
      original_name,
      mime_type || null,
      size_bytes || null,
      drive_file_id || null,
      drive_web_url || null,
      storage_key || null,
    ]
  );
  return result.rows[0];
}

/**
 * Atomically create a submission_records row and all submission_files rows.
 * Uses a single PostgreSQL transaction so a failure cannot leave a record
 * without its file metadata (or vice versa).
 */
async function createSubmissionWithFiles({
  request_id,
  roll_no,
  student_name,
  answers_json,
  drive_folder_id,
  files,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const submission_id = newId();
    const rec = await client.query(
      `INSERT INTO submission_records
         (submission_id, request_id, roll_no, student_name, answers_json, status, drive_folder_id)
       VALUES ($1,$2,$3,$4,$5,'submitted',$6)
       RETURNING *`,
      [
        submission_id,
        request_id,
        roll_no || null,
        student_name || null,
        JSON.stringify(answers_json || {}),
        drive_folder_id || null,
      ]
    );

    const fileRows = [];
    for (const meta of files || []) {
      const file_id = newId();
      const fr = await client.query(
        `INSERT INTO submission_files
           (file_id, submission_id, original_name, mime_type, size_bytes, drive_file_id, drive_web_url, storage_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          file_id,
          submission_id,
          meta.original_name,
          meta.mime_type || null,
          meta.size_bytes || null,
          meta.drive_file_id || null,
          meta.drive_web_url || null,
          meta.storage_key || null,
        ]
      );
      fileRows.push(fr.rows[0]);
    }

    await client.query("COMMIT");
    return { submission: rec.rows[0], files: fileRows };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore rollback errors */
    }
    throw e;
  } finally {
    client.release();
  }
}

async function listSubmissionsForRequest(request_id, emp_id) {
  const req = await getSubmissionRequest(request_id);
  if (!req) return null;
  const teacher = await findTeacher(emp_id);
  if (!teacher || teacher.emp_id !== req.emp_id) {
    throw new Error("Not authorized to view these submissions.");
  }
  const result = await pool.query(
    `SELECT s.*,
            (SELECT COUNT(*)::int FROM submission_files f WHERE f.submission_id = s.submission_id) AS file_count
     FROM submission_records s
     WHERE s.request_id = $1
     ORDER BY s.submitted_at DESC`,
    [request_id]
  );
  return { request: req, submissions: result.rows };
}

async function getSubmissionDetail(submission_id, emp_id) {
  const result = await pool.query(
    `SELECT * FROM submission_records WHERE submission_id = $1`,
    [submission_id]
  );
  if (!result.rows.length) return null;
  const sub = result.rows[0];
  const req = await getSubmissionRequest(sub.request_id);
  if (!req) return null;
  const teacher = await findTeacher(emp_id);
  if (!teacher || teacher.emp_id !== req.emp_id) {
    throw new Error("Not authorized to view this submission.");
  }
  const files = await pool.query(
    `SELECT * FROM submission_files WHERE submission_id = $1 ORDER BY created_at ASC`,
    [submission_id]
  );
  return { request: req, submission: sub, files: files.rows };
}

async function findExistingSubmission(request_id, roll_no) {
  if (!roll_no) return null;
  const result = await pool.query(
    `SELECT * FROM submission_records WHERE request_id = $1 AND roll_no = $2 ORDER BY submitted_at DESC LIMIT 1`,
    [request_id, roll_no]
  );
  return result.rows[0] || null;
}

async function listSubmissionFiles(submission_id) {
  const result = await pool.query(
    `SELECT * FROM submission_files WHERE submission_id = $1 ORDER BY created_at ASC`,
    [submission_id]
  );
  return result.rows;
}

async function deleteSubmissionRecord(submission_id) {
  await pool.query(`DELETE FROM submission_files WHERE submission_id = $1`, [submission_id]);
  await pool.query(`DELETE FROM submission_records WHERE submission_id = $1`, [submission_id]);
}

/**
 * Resolve a submission file and owning teacher emp_id for authorization.
 */
async function clearSubmissionFileDriveIds(file_id) {
  await pool.query(
    `UPDATE submission_files
     SET drive_file_id = NULL, drive_web_url = NULL
     WHERE file_id = $1`,
    [file_id]
  );
}

async function getSubmissionFileWithOwner(file_id) {
  const result = await pool.query(
    `SELECT f.*, s.request_id, r.emp_id AS teacher_emp_id
     FROM submission_files f
     JOIN submission_records s ON s.submission_id = f.submission_id
     JOIN submission_requests r ON r.request_id = s.request_id
     WHERE f.file_id = $1`,
    [file_id]
  );
  return result.rows[0] || null;
}


module.exports = {
  createTeacher,
  findTeacher,
  listTeachers,
  authenticateTeacher,
  authenticateTeacherByCard,
  sanitizeTeacher,
  createStudent,
  findStudent,
  authenticateStudent,
  authenticateStudentByCard,
  sanitizeStudent,
  toggleBookmark,
  addMaterial,
  materialsByTeacher,
  findMaterial,
  findMaterialByStoredFilename,
  deleteMaterial,
  logAccess,
  accessCountsForTeacher,

  isIdCardAlreadyRegistered,

  trustDevice,
  isDeviceTrusted,

  createEnrollmentCode,
  canRequestEnrollmentCode,
  verifyEnrollmentCode,
  listEnrollmentCodes,
  revokeEnrollmentCode,

  createInvitation,
  listInvitations,
  findActiveInvitation,
  revokeInvitation,
  markInvitationUsed,

  startDatabase,
  ensureSeedAdmin,
  listAllTeachers,
  listAllStudents,
  setTeacherActive,
  setTeacherRole,
  deleteTeacher,
  setStudentActive,
  deleteStudent,

  findUserByEmail,
  createPasswordResetToken,
  findValidResetToken,
  markResetTokenUsed,
  updateUserPassword,
  getStudentsWhoBookmarkedTeacher,

  upsertTeacherGoogleDrive,
  getTeacherGoogleDrive,
  disconnectTeacherGoogleDrive,
  updateTeacherGoogleDriveFolders,
  updateTeacherGoogleDriveTokens,

  createSubmissionRequest,
  getSubmissionRequest,
  getSubmissionRequestByToken,
  listSubmissionRequestsByTeacher,
  updateSubmissionRequest,
  deleteSubmissionRequest,
  createSubmissionRecord,
  createSubmissionWithFiles,
  addSubmissionFile,
  listSubmissionsForRequest,
  getSubmissionDetail,
  findExistingSubmission,
  listSubmissionFiles,
  deleteSubmissionRecord,
  clearSubmissionFileDriveIds,
  getSubmissionFileWithOwner,
};
