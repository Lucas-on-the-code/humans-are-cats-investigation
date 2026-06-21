import Database from 'better-sqlite3';
import { readFileSync, appendFileSync, statSync, writeFileSync } from 'node:fs';
import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// SQLite DB path: production sets GAME_DB_PATH (JSON legacy name) — we swap the
// extension to .sqlite. Lives OUTSIDE the app dir (GAME_DB_PATH), so rsync/deploys
// never wipe user data. Falls back to app/data/ for dev.
const JSON_LEGACY_PATH = process.env.GAME_DB_PATH || join(fileURLToPath(new URL('..', import.meta.url)), 'data/game-auth-db.json');
const DB_FILE = JSON_LEGACY_PATH.replace(/\.json$/i, '.sqlite');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const RUN_TTL_MS = 1000 * 60 * 60 * 2;
const POW_DIFFICULTY = 3;
const SECRET = process.env.GAME_SERVER_SECRET || (() => {
  console.warn('[auth] GAME_SERVER_SECRET not set — using an ephemeral random secret. Set GAME_SERVER_SECRET in production; server.mjs enforces it on boot.');
  return randomBytes(32).toString('hex');
})();

const rateBuckets = new Map();
const powChallenges = new Map();

// ---------- DB open + schema ----------
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');       // concurrent readers + single writer, no full-table lock
db.pragma('synchronous = NORMAL');     // safe with WAL, faster commits
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE,
    passwordHash TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    createdIpHash TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions(userId);

  CREATE TABLE IF NOT EXISTS scores (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    playerName TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    runId TEXT NOT NULL UNIQUE,
    score INTEGER NOT NULL,
    distance INTEGER NOT NULL DEFAULT 0,
    evidence INTEGER NOT NULL DEFAULT 0,
    scans INTEGER NOT NULL DEFAULT 0,
    nearMisses INTEGER NOT NULL DEFAULT 0,
    bestCombo INTEGER NOT NULL DEFAULT 0,
    survivalTime INTEGER NOT NULL DEFAULT 0,
    title TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_scores_userId_score ON scores(userId, score DESC);
  CREATE INDEX IF NOT EXISTS idx_scores_score ON scores(score DESC);

  CREATE TABLE IF NOT EXISTS submitted_run_ids (
    runId TEXT PRIMARY KEY,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS miku_memories (
    userId TEXT PRIMARY KEY,
    memory TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS miku_usage (
    scopeKey TEXT PRIMARY KEY,
    sessionCount INTEGER NOT NULL DEFAULT 0,
    firstSessionAt INTEGER NOT NULL,
    lastSessionAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS survey_responses (
    scopeKey TEXT PRIMARY KEY,
    userId TEXT,
    guestId TEXT,
    q1 TEXT,
    q2 TEXT,
    q3 TEXT,
    q4 TEXT,
    q2Other TEXT,
    q4Other TEXT,
    email TEXT,
    reachedEmail INTEGER NOT NULL DEFAULT 0,
    usageSnapshot INTEGER NOT NULL DEFAULT 0,
    completedAt INTEGER,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    createdIpHash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_survey_email ON survey_responses(email) WHERE email IS NOT NULL;
`);

// ---------- one-time migration from legacy JSON ----------
function migrateFromJson() {
  try {
    const raw = readFileSync(JSON_LEGACY_PATH, 'utf8');
    const data = JSON.parse(raw);
    const hasData = (data.users?.length || data.scores?.length || data.sessions?.length);
    if (!hasData) return;
    const existing = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    if (existing > 0) return; // already populated
    const tx = db.transaction(() => {
      for (const u of (data.users || [])) {
        db.prepare('INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, createdIpHash) VALUES (?, ?, ?, ?, ?)')
          .run(u.id, u.username, u.passwordHash, u.createdAt ?? Date.now(), u.createdIpHash ?? null);
      }
      for (const s of (data.sessions || [])) {
        db.prepare('INSERT OR IGNORE INTO sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)')
          .run(s.token, s.userId, s.createdAt ?? Date.now(), s.expiresAt ?? Date.now());
      }
      for (const sc of (data.scores || [])) {
        db.prepare(`INSERT OR IGNORE INTO scores (id, userId, playerName, createdAt, runId, score, distance, evidence, scans, nearMisses, bestCombo, survivalTime, title)
          VALUES (@id, @userId, @playerName, @createdAt, @runId, @score, @distance, @evidence, @scans, @nearMisses, @bestCombo, @survivalTime, @title)`)
          .run({ id: sc.id, userId: sc.userId, playerName: sc.playerName, createdAt: sc.createdAt, runId: sc.runId,
                 score: sc.score, distance: sc.distance ?? 0, evidence: sc.evidence ?? 0, scans: sc.scans ?? 0,
                 nearMisses: sc.nearMisses ?? 0, bestCombo: sc.bestCombo ?? 0, survivalTime: sc.survivalTime ?? 0, title: sc.title ?? null });
      }
      for (const runId of (data.submittedRunIds || [])) {
        db.prepare('INSERT OR IGNORE INTO submitted_run_ids (runId, createdAt) VALUES (?, ?)').run(runId, Date.now());
      }
      for (const [uid, mem] of Object.entries(data.mikuMemories || {})) {
        db.prepare('INSERT OR REPLACE INTO miku_memories (userId, memory, updatedAt) VALUES (?, ?, ?)').run(uid, JSON.stringify(mem), Date.now());
      }
    });
    tx();
    console.log(`[auth] migrated ${data.users?.length || 0} users, ${data.scores?.length || 0} scores, ${data.sessions?.length || 0} sessions from legacy JSON`);
  } catch {
    // no legacy JSON — fresh DB
  }
}
migrateFromJson();

// ---------- prepared statements ----------
const stmt = {
  getUserByLowerName: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
  insertUser: db.prepare('INSERT INTO users (id, username, passwordHash, createdAt, createdIpHash) VALUES (?, ?, ?, ?, ?)'),
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expiresAt <= ?'),
  getSessionUserRow: db.prepare(`
    SELECT u.id AS id, u.username AS username, s.token AS token, s.userId AS userId
    FROM sessions s JOIN users u ON u.id = s.userId
    WHERE s.token = ? AND s.expiresAt > ?`),
  insertSession: db.prepare('INSERT INTO sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)'),
  deleteSessionByToken: db.prepare('DELETE FROM sessions WHERE token = ?'),
  insertScore: db.prepare(`INSERT INTO scores (id, userId, playerName, createdAt, runId, score, distance, evidence, scans, nearMisses, bestCombo, survivalTime, title)
    VALUES (@id, @userId, @playerName, @createdAt, @runId, @score, @distance, @evidence, @scans, @nearMisses, @bestCombo, @survivalTime, @title)`),
  runIdSubmitted: db.prepare('SELECT 1 FROM submitted_run_ids WHERE runId = ?'),
  insertRunId: db.prepare('INSERT OR IGNORE INTO submitted_run_ids (runId, createdAt) VALUES (?, ?)'),
  // Per-user best score = row_number()=1 within each userId partition, ranked globally.
  topScores: db.prepare(`SELECT * FROM (
    SELECT id, userId, playerName, createdAt, runId, score, distance, evidence, scans, nearMisses, bestCombo, survivalTime, title,
      ROW_NUMBER() OVER (PARTITION BY userId ORDER BY score DESC, createdAt ASC) AS rn
    FROM scores) WHERE rn = 1 ORDER BY score DESC, createdAt ASC LIMIT 50`),
  viewerBest: db.prepare(`SELECT * FROM (
    SELECT id, userId, playerName, createdAt, runId, score, distance, evidence, scans, nearMisses, bestCombo, survivalTime, title,
      ROW_NUMBER() OVER (PARTITION BY userId ORDER BY score DESC, createdAt ASC) AS rn
    FROM scores WHERE userId = ?) WHERE rn = 1`),
  viewerBestRank: db.prepare(`SELECT COUNT(*) + 1 AS rank FROM (
    SELECT userId, MAX(score) AS ms, MIN(createdAt) AS mc FROM scores GROUP BY userId
  ) WHERE ms > ? OR (ms = ? AND mc < ?)`),
  scoreById: db.prepare('SELECT * FROM scores WHERE id = ?'),
  getMikuMemory: db.prepare('SELECT memory FROM miku_memories WHERE userId = ?'),
  upsertMikuMemory: db.prepare('INSERT INTO miku_memories (userId, memory, updatedAt) VALUES (?, ?, ?) ON CONFLICT(userId) DO UPDATE SET memory = excluded.memory, updatedAt = excluded.updatedAt'),
  upsertMikuUsage: db.prepare(`INSERT INTO miku_usage (scopeKey, sessionCount, firstSessionAt, lastSessionAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scopeKey) DO UPDATE SET
      sessionCount = MAX(miku_usage.sessionCount, excluded.sessionCount),
      lastSessionAt = excluded.lastSessionAt`),
  getMikuUsage: db.prepare('SELECT sessionCount FROM miku_usage WHERE scopeKey = ?'),
  upsertSurvey: db.prepare(`INSERT INTO survey_responses
    (scopeKey, userId, guestId, q1, q2, q3, q4, q2Other, q4Other, email, reachedEmail, usageSnapshot, completedAt, createdAt, updatedAt, createdIpHash)
    VALUES (@scopeKey, @userId, @guestId, @q1, @q2, @q3, @q4, @q2Other, @q4Other, @email, @reachedEmail, @usageSnapshot, @completedAt, @createdAt, @updatedAt, @createdIpHash)
    ON CONFLICT(scopeKey) DO UPDATE SET
      userId = excluded.userId, guestId = excluded.guestId,
      q1 = excluded.q1, q2 = excluded.q2, q3 = excluded.q3, q4 = excluded.q4,
      q2Other = excluded.q2Other, q4Other = excluded.q4Other,
      email = COALESCE(excluded.email, survey_responses.email),
      reachedEmail = MAX(excluded.reachedEmail, survey_responses.reachedEmail),
      usageSnapshot = MAX(excluded.usageSnapshot, survey_responses.usageSnapshot),
      completedAt = COALESCE(excluded.completedAt, survey_responses.completedAt),
      updatedAt = excluded.updatedAt`),
  findSurveyByEmail: db.prepare('SELECT scopeKey FROM survey_responses WHERE email = ? LIMIT 1'),
};

// ---------- helpers (unchanged from JSON version) ----------
const readJsonBody = async (req) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  return JSON.parse(raw);
};

const writeJson = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

const TRUSTED_PROXY_HOPS = Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS || '0'));
const getIp = (req) => {
  // Prefer X-Real-IP (set by nginx to $remote_addr) — simpler and correct
  // for single-proxy setups where X-Forwarded-For has only one entry.
  const realIp = req.headers['x-real-ip'];
  if (realIp) return String(realIp).trim() || req.socket.remoteAddress || 'local';

  if (TRUSTED_PROXY_HOPS > 0) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const parts = String(Array.isArray(forwarded) ? forwarded[0] : forwarded)
        .split(',').map((s) => s.trim()).filter(Boolean);
      const clientIndex = parts.length - TRUSTED_PROXY_HOPS;
      if (clientIndex >= 0) return parts[clientIndex] || req.socket.remoteAddress || 'local';
    }
  }
  return req.socket.remoteAddress || 'local';
};
const hashIp = (ip) => createHash('sha256').update(`ip:${ip}`).digest('hex').slice(0, 24);

const hitRateLimit = (key, limit, windowMs) => {
  const now = Date.now();
  const bucket = rateBuckets.get(key) ?? [];
  const next = bucket.filter((time) => now - time < windowMs);
  next.push(now);
  rateBuckets.set(key, next);
  return next.length > limit;
};

const sanitizeUsername = (value) => String(value ?? '').trim().replace(/\s+/g, '_').slice(0, 18);
const validateUsername = (username) => /^[\p{L}\p{N}_-]{3,18}$/u.test(username);
const passwordHash = (password, salt = randomBytes(16).toString('hex')) => {
  const hash = pbkdf2Sync(String(password), salt, 210000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
};
const verifyPassword = (password, stored) => {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !expected) return false;
  const actual = passwordHash(password, salt).split(':')[1];
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
};
const publicUser = (user) => user ? ({ id: user.id, username: user.username }) : null;
const bearerToken = (req) => {
  const header = req.headers.authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match?.[1] || '';
};

// ---------- session / auth ----------
export const getSessionUser = (req) => {
  const now = Date.now();
  stmt.deleteExpiredSessions.run(now);
  const token = bearerToken(req);
  if (!token) return { user: null };
  const row = stmt.getSessionUserRow.get(token, now);
  if (!row) return { user: null };
  return { user: { id: row.id, username: row.username } };
};

const createSession = (userId) => {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  stmt.insertSession.run(token, userId, now, now + SESSION_TTL_MS);
  return token;
};

const signPayload = (payload) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
};
const verifySignedPayload = (token) => {
  const [encoded, sig] = String(token || '').split('.');
  if (!encoded || !sig) return null;
  const expected = createHmac('sha256', SECRET).update(encoded).digest('base64url');
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return null; }
};

// ---------- PoW ----------
const createChallenge = (ipHash) => {
  const challenge = { nonce: randomBytes(18).toString('base64url'), difficulty: POW_DIFFICULTY, ipHash, expiresAt: Date.now() + 1000 * 60 * 5 };
  powChallenges.set(challenge.nonce, challenge);
  return challenge;
};
const verifyChallenge = ({ nonce, answer }, ipHash) => {
  const challenge = powChallenges.get(String(nonce || ''));
  if (!challenge || challenge.expiresAt < Date.now() || challenge.ipHash !== ipHash) return false;
  const digest = createHash('sha256').update(`${challenge.nonce}:${answer}`).digest('hex');
  const ok = digest.startsWith('0'.repeat(challenge.difficulty));
  if (ok) powChallenges.delete(challenge.nonce);
  return ok;
};

// ---------- score validation ----------
// Known base values for each event type (anti-cheat: server-side replay).
// These must match the constants used in GameCanvas.tsx awardScore() calls.
const KNOWN_BASE_VALUES = {
  FISH: new Set([90]),
  DATA: new Set([1000]),
  MAGNET: new Set([180]),
  SHIELD: new Set([180]),
  NEAR: new Set([180, 220]),
  SCAN: new Set([240]),
  'SCAN TARGET': new Set([700]),
  'TAXI RIDE': new Set([620]),
};
const COMBO_WINDOW_REPLAY_MS = 4500;
const TAXI_FREERIDE_BONUS_REPLAY = 1800;
const TAXI_FREERIDE_THRESHOLD_REPLAY = 3;
// Legal combo multipliers — 1 + floor(combo/4)*0.25, capped at 5. New clients
// report the actual multiplier at award time so the server replays exact scoring
// instead of recomputing combo (which drifts: client combo resets on damage, line
// 1449, invisible to a timestamp-only server replay).
const LEGAL_MULTS = new Set([1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4, 4.25, 4.5, 4.75, 5]);

const normalizeSummary = (value) => ({
  score: Math.floor(Number(value?.score) || 0),
  distance: Math.floor(Number(value?.distance) || 0),
  evidence: Math.floor(Number(value?.evidence) || 0),
  scans: Math.floor(Number(value?.scans) || 0),
  nearMisses: Math.floor(Number(value?.nearMisses) || 0),
  bestCombo: Math.floor(Number(value?.bestCombo) || 0),
  survivalTime: Math.floor(Number(value?.survivalTime) || 0),
  title: String(value?.title || '见习调查员').slice(0, 24),
});

// Persist the full event log of every rejected submission to a JSONL file so a
// real mismatch can be replayed offline and the combo-replay drift pinned down.
// The file self-truncates past REJECT_DUMP_MAX_BYTES so it can't fill the disk.
// Override path with GAME_REJECT_DUMP; defaults to <app>/data/rejected-runs.jsonl.
const REJECT_DUMP_PATH = process.env.GAME_REJECT_DUMP || join(fileURLToPath(new URL('..', import.meta.url)), 'data/rejected-runs.jsonl');
const REJECT_DUMP_MAX_BYTES = 20 * 1024 * 1024;
const dumpRejectedRun = (errorCode, diag, events) => {
  try {
    appendFileSync(REJECT_DUMP_PATH, JSON.stringify({ at: new Date().toISOString(), errorCode, ...diag, events }) + '\n');
    // Trim AFTER the append — checking size first is a check-then-act race under
    // concurrent writers (all pass the guard, all append, file blows past the cap).
    // Keep the most recent half, line-aligned, so fresh diagnostic data survives
    // rotation instead of being wiped wholesale (we don't want to lose the very
    // case we're trying to capture).
    try {
      const { size } = statSync(REJECT_DUMP_PATH);
      if (size > REJECT_DUMP_MAX_BYTES) {
        const data = readFileSync(REJECT_DUMP_PATH, 'utf8');
        const cut = data.indexOf('\n', size - Math.floor(REJECT_DUMP_MAX_BYTES / 2));
        writeFileSync(REJECT_DUMP_PATH, cut >= 0 ? data.slice(cut + 1) : data);
      }
    } catch {}
  } catch (e) { console.warn('[leaderboard] reject-dump failed', e.message); }
};

// Replay the client's score event log server-side to verify the claimed score.
// Returns '' if OK, or an error code string if the score doesn't add up.
const replayScore = (events, summary, runPayload) => {
  if (!Array.isArray(events)) return 'NO_EVENTS';
  // DoS guard, NOT a player cap. A human run is bounded by RUN_TTL (2h) × peak
  // event rate (~20/s) ≈ 144k events; 200k is unreachable by any legitimate
  // player, so endurance runs are never capped. Score fraud is caught by the
  // SCORE_MISMATCH tolerance + validateScore ceiling; this only stops a malicious
  // client forcing an unbounded replay loop. Defence-in-depth alongside the
  // nginx client_max_body_size body limit.
  if (events.length > 200000) return 'TOO_MANY_EVENTS';
  if (events.length === 0 && summary.score > 0) return 'SCORE_MISMATCH';

  let replayedScore = 0;
  let taxiRides = 0;
  // Legacy fallback state: old clients don't send per-event `mult`, so for those
  // we recompute combo from event timestamps (drift-prone, but only affects
  // unrefreshed clients — new clients send mult and bypass this entirely).
  let legacyCombo = 0;
  let legacyLastComboAt = 0;

  for (const e of events) {
    const type = String(e?.type || '');
    const base = Math.floor(Number(e?.base) || 0);

    // Validate base value is a known constant for this type
    const validBases = KNOWN_BASE_VALUES[type];
    if (!validBases || !validBases.has(base)) return 'INVALID_EVENT';

    // Aggregated events (new clients) carry `count` = occurrences of (type,base,
    // mult); legacy per-event entries have count = 1.
    const count = e?.count !== undefined ? Math.floor(Number(e.count) || 0) : 1;
    if (count < 1) return 'INVALID_EVENT';

    // Count taxi rides for freeride bonus
    if (type === 'TAXI RIDE') taxiRides += count;

    // New clients send the actual multiplier at award time (exact match to client
    // scoring — immune to combo-state drift). Legacy clients omit it; we recompute.
    let appliedMult;
    const mult = e?.mult;
    if (mult === undefined || mult === null) {
      const t = Math.floor(Number(e?.t) || 0);
      legacyCombo = t - legacyLastComboAt <= COMBO_WINDOW_REPLAY_MS ? legacyCombo + 1 : 1;
      legacyLastComboAt = t;
      appliedMult = Math.min(5, 1 + Math.floor(legacyCombo / 4) * 0.25);
    } else {
      const m = Number(mult);
      if (!LEGAL_MULTS.has(m)) return 'INVALID_EVENT';
      appliedMult = m;
    }

    replayedScore += Math.round(base * appliedMult) * count;
  }

  // Add distance-based score (not tracked as discrete events; estimated from summary).
  // Client awards distance score continuously: per metre = (18 + heat*20), where
  // heat = min(1, distance_px / (CHUNK_LENGTH*18)). CHUNK_LENGTH=760px, PIXELS_PER_METER=100
  // → heat saturates at 136.8m. We mirror that exact piecewise integral instead of a
  // flat per-metre guess, so the only residual error is client frame-discretisation
  // noise (a few tens of points), well inside tolerance.
  const HEAT_FULL_M = 136.8;
  const D = summary.distance;
  const distScore = D <= HEAT_FULL_M
    ? 18 * D + (10 / HEAT_FULL_M) * D * D            // ∫₀ᴰ (18 + 20·d/H) dd
    : 28 * HEAT_FULL_M + (D - HEAT_FULL_M) * 38;     // ramp region + saturated (38/m)
  replayedScore += Math.round(distScore);

  // Add freeride bonus
  if (taxiRides >= TAXI_FREERIDE_THRESHOLD_REPLAY) {
    replayedScore += TAXI_FREERIDE_BONUS_REPLAY;
  }

  // Tolerance covers client frame-discretisation + combo-replay drift (combo is
  // recomputed here from event timestamps; edge cases near the 4.5s combo window,
  // and low-score runs where the absolute tolerance would otherwise shrink to a
  // few hundred points, can misfire on legitimate play). 25% with a 1500 floor;
  // the validateScore ceiling above still caps absolute fraud independent of this.
  const tolerance = Math.max(replayedScore * 0.25, 1500);
  if (Math.abs(replayedScore - summary.score) > tolerance) return 'SCORE_MISMATCH';

  return '';
};

const validateScore = (summary, runPayload) => {
  const now = Date.now();
  const elapsedSeconds = Math.floor((now - Number(runPayload.startAt || 0)) / 1000);
  if (!runPayload.runId || now - runPayload.startAt > RUN_TTL_MS) return 'RUN_EXPIRED';
  if (summary.score < 0 || summary.distance < 0 || summary.survivalTime < 3) return 'INVALID_SCORE';
  if (summary.survivalTime > elapsedSeconds + 8) return 'TIME_TRAVEL';
  // Tightened ceilings based on real game data analysis:
  // Max distance speed ~4.4m/s + dash/taxi buffer → 8m/s, conservative at 10
  if (summary.distance > summary.survivalTime * 10 + 150) return 'DISTANCE_TOO_HIGH';
  // Tightened score ceiling: real top players hit ~900 pts/sec at peak,
  // ~15 pts/m distance. Added 8000 base buffer. Old was 4200+90+60000.
  if (summary.score > summary.survivalTime * 1200 + summary.distance * 20 + 12000) return 'SCORE_TOO_HIGH';
  if (summary.bestCombo > 999 || summary.evidence > 999 || summary.scans > 999) return 'STAT_TOO_HIGH';
  return '';
};
const isScoreSuspicious = (summary) => {
  const ceiling = summary.survivalTime * 1200 + summary.distance * 20 + 12000;
  return summary.score > ceiling * 0.7;
};

// ---------- ranking (read helpers) ----------
const scoreRowToEntry = (row) => ({
  id: row.id, userId: row.userId, playerName: row.playerName,
  createdAt: new Date(row.createdAt).toISOString(),
  rank: row.rank ?? null,
  score: row.score, distance: row.distance, evidence: row.evidence, scans: row.scans,
  nearMisses: row.nearMisses, bestCombo: row.bestCombo, survivalTime: row.survivalTime, title: row.title,
});
const topScores = () => {
  const rows = stmt.topScores.all();
  return rows.map((row, i) => scoreRowToEntry({ ...row, rank: i + 1 }));
};
const userBestScore = (userId) => {
  const best = stmt.viewerBest.get(userId);
  if (!best) return null;
  const rankRow = stmt.viewerBestRank.get(best.score, best.score, best.createdAt);
  return scoreRowToEntry({ ...best, rank: rankRow.rank });
};

// ---------- miku memory sanitize (unchanged) ----------
const cleanText = (value, maxLength = 700) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
const emptyMikuMemory = () => ({ version: 1, sessionCount: 0, sessions: [] });
const sanitizeMikuMessages = (messages) => {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && cleanText(m.content))
    .slice(-80).map((m) => ({ role: m.role, content: cleanText(m.content) }));
};
const sanitizeMikuTopic = (topic, fallbackId) => {
  const title = cleanText(topic?.title, 80);
  const summary = cleanText(topic?.summary, 260);
  if (!title || !summary) return null;
  return {
    id: cleanText(topic?.id, 100) || fallbackId, title, summary,
    keywords: Array.isArray(topic?.keywords) ? topic.keywords.slice(0, 8).map((k) => cleanText(k, 40)).filter(Boolean) : [],
    startIndex: Number.isInteger(topic?.startIndex) ? topic.startIndex : undefined,
    endIndex: Number.isInteger(topic?.endIndex) ? topic.endIndex : undefined,
  };
};
const sanitizeMikuMemory = (memory) => {
  if (!memory || typeof memory !== 'object') return emptyMikuMemory();
  const sessions = Array.isArray(memory.sessions) ? memory.sessions.map((session) => {
    const id = cleanText(session?.id, 100);
    const createdAt = cleanText(session?.createdAt, 60);
    const messages = sanitizeMikuMessages(session?.messages);
    if (!id || !createdAt || messages.length === 0) return null;
    return {
      id, createdAt, messages,
      sessionSummary: cleanText(session?.sessionSummary, 360) || undefined,
      topics: Array.isArray(session?.topics) ? session.topics.slice(0, 10).map((t, i) => sanitizeMikuTopic(t, `${id}-topic-${i + 1}`)).filter(Boolean) : [],
      taggedTranscript: cleanText(session?.taggedTranscript, 8000) || undefined,
    };
  }).filter(Boolean) : [];
  const knowledgeContent = cleanText(memory.knowledge?.content, 4000);
  const pendingGreeting = cleanText(memory.pendingGreeting?.content, 120);
  return {
    version: 1,
    sessionCount: Math.max(Number(memory.sessionCount) || sessions.length, sessions.length),
    sessions,
    knowledge: knowledgeContent ? { content: knowledgeContent, updatedAt: cleanText(memory.knowledge?.updatedAt, 60) || new Date().toISOString(), sourceSessionIds: Array.isArray(memory.knowledge?.sourceSessionIds) ? memory.knowledge.sourceSessionIds.slice(-12).map((id) => cleanText(id, 100)).filter(Boolean) : [] } : undefined,
    pendingGreeting: pendingGreeting ? { content: pendingGreeting, generatedAt: cleanText(memory.pendingGreeting?.generatedAt, 60) || new Date().toISOString(), sourceSessionId: cleanText(memory.pendingGreeting?.sourceSessionId, 100) } : undefined,
  };
};
const mergeMikuMemories = (current, incoming, options = {}) => {
  const safeCurrent = sanitizeMikuMemory(current);
  const safeIncoming = sanitizeMikuMemory(incoming);
  const sessionsById = new Map();
  [...safeCurrent.sessions, ...safeIncoming.sessions].forEach((s) => sessionsById.set(s.id, s));
  const sessions = [...sessionsById.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const cur = Date.parse(safeCurrent.knowledge?.updatedAt || '') || 0;
  const inc = Date.parse(safeIncoming.knowledge?.updatedAt || '') || 0;
  return {
    version: 1,
    sessionCount: Math.max(safeCurrent.sessionCount, safeIncoming.sessionCount, sessions.length),
    sessions,
    knowledge: inc >= cur ? (safeIncoming.knowledge || safeCurrent.knowledge) : (safeCurrent.knowledge || safeIncoming.knowledge),
    pendingGreeting: options.clearPendingGreeting ? undefined : (safeIncoming.pendingGreeting || safeCurrent.pendingGreeting),
  };
};

// ---------- handlers ----------
export const handleMikuMemoryRequest = async (req, res) => {
  try {
    const { user } = getSessionUser(req);
    if (!user) return writeJson(res, 401, { error: 'LOGIN_REQUIRED' });

    if (req.method === 'GET') {
      const row = stmt.getMikuMemory.get(user.id);
      const memory = row ? JSON.parse(row.memory) : emptyMikuMemory();
      return writeJson(res, 200, { memory: sanitizeMikuMemory(memory) });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readJsonBody(req);
      const incoming = sanitizeMikuMemory(body.memory);
      const mode = cleanText(body.mode, 20);
      const row = stmt.getMikuMemory.get(user.id);
      const current = row ? JSON.parse(row.memory) : emptyMikuMemory();
      const next = mode === 'replace' ? incoming : mergeMikuMemories(current, incoming, { clearPendingGreeting: Boolean(body.clearPendingGreeting) });
      stmt.upsertMikuMemory.run(user.id, JSON.stringify(next), Date.now());
      return writeJson(res, 200, { memory: sanitizeMikuMemory(next) });
    }
    return writeJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  } catch (error) {
    console.error('[auth] miku-memory error', error);
    return writeJson(res, 500, { error: 'INTERNAL_ERROR' });
  }
};

export const handleAuthRequest = async (req, res) => {
  try {
    const path = new URL(req.url || '/', 'http://local').pathname.replace(/^\/api\/auth/, '') || '/me';
    const ipHash = hashIp(getIp(req));

    if (path === '/challenge' && req.method === 'POST') {
      if (hitRateLimit(`challenge:${ipHash}`, 60, 10 * 60 * 1000)) return writeJson(res, 429, { error: 'TOO_MANY_CHALLENGES' });
      const challenge = createChallenge(ipHash);
      return writeJson(res, 200, { nonce: challenge.nonce, difficulty: challenge.difficulty });
    }

    if (path === '/register' && req.method === 'POST') {
      if (hitRateLimit(`register:${ipHash}`, 30, 60 * 60 * 1000)) return writeJson(res, 429, { error: 'REGISTER_RATE_LIMITED' }); // 30/hour (was 5) — relaxed
      const body = await readJsonBody(req);
      const username = sanitizeUsername(body.username);
      const password = String(body.password || '');
      if (!verifyChallenge(body.pow, ipHash)) return writeJson(res, 400, { error: 'POW_REQUIRED' });
      if (!validateUsername(username)) return writeJson(res, 400, { error: 'BAD_USERNAME' });
      if (password.length < 8 || password.length > 80) return writeJson(res, 400, { error: 'BAD_PASSWORD' });

      if (stmt.getUserByLowerName.get(username)) return writeJson(res, 409, { error: 'USERNAME_TAKEN' });
      const user = { id: randomBytes(12).toString('base64url'), username, passwordHash: passwordHash(password), createdAt: Date.now(), createdIpHash: ipHash };
      const tx = db.transaction(() => {
        stmt.insertUser.run(user.id, user.username, user.passwordHash, user.createdAt, user.createdIpHash);
      });
      tx();
      const token = createSession(user.id);
      return writeJson(res, 200, { token, user: publicUser(user) });
    }

    if (path === '/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const username = sanitizeUsername(body.username);
      if (hitRateLimit(`login:${ipHash}:${username.toLowerCase()}`, 8, 10 * 60 * 1000)) return writeJson(res, 429, { error: 'LOGIN_RATE_LIMITED' });
      const user = stmt.getUserByLowerName.get(username);
      if (!user || !verifyPassword(body.password, user.passwordHash)) return writeJson(res, 401, { error: 'BAD_CREDENTIALS' });
      const token = createSession(user.id);
      return writeJson(res, 200, { token, user: publicUser(user) });
    }

    if (path === '/logout' && req.method === 'POST') {
      const token = bearerToken(req);
      if (token) stmt.deleteSessionByToken.run(token);
      return writeJson(res, 200, { ok: true });
    }

    if (path === '/me' && req.method === 'GET') {
      const { user } = getSessionUser(req);
      return writeJson(res, 200, { user: publicUser(user) });
    }

    return writeJson(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    console.error('[auth] auth error', error);
    return writeJson(res, 500, { error: 'INTERNAL_ERROR' });
  }
};

export const handleRunStartRequest = async (req, res) => {
  if (req.method !== 'POST') return writeJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const { user } = getSessionUser(req);
  const payload = { runId: randomBytes(14).toString('base64url'), startAt: Date.now(), userId: user?.id };
  return writeJson(res, 200, { runToken: signPayload(payload), runId: payload.runId });
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SURVEY_Q3_VALUES = ['yes', 'maybe', 'nah'];

const sanitizeSurveyMulti = (value) => JSON.stringify(
  Array.isArray(value)
    ? value.filter((x) => typeof x === 'string').slice(0, 20).map((s) => cleanText(s, 60)).filter(Boolean)
    : []
);

function buildSurveyAnswers(body, scopeKey, userId, guestId, email, ipHash, reachedEmail = 0) {
  const now = Date.now();
  const usageRow = stmt.getMikuUsage.get(scopeKey);
  const usageSnapshot = usageRow ? usageRow.sessionCount : 0;
  return {
    scopeKey,
    userId: userId || null,
    guestId: guestId || null,
    q1: cleanText(body.q1, 60) || null,
    q2: sanitizeSurveyMulti(body.q2),
    q3: SURVEY_Q3_VALUES.includes(body.q3) ? body.q3 : null,
    q4: sanitizeSurveyMulti(body.q4),
    q2Other: cleanText(body.q2Other, 400) || null,
    q4Other: cleanText(body.q4Other, 400) || null,
    email,
    reachedEmail,
    usageSnapshot,
    completedAt: reachedEmail ? now : null,
    createdAt: now,
    updatedAt: now,
    createdIpHash: ipHash,
  };
}

// 供 /api/miku-chat/end 计数钩子调用：记录一次 miku 会话（信任客户端 max 语义）
export const recordMikuSession = (scopeKey, sessionCount) => {
  if (!scopeKey || !(sessionCount > 0)) return;
  const now = Date.now();
  stmt.upsertMikuUsage.run(scopeKey, sessionCount, now, now);
};

export const handleSurveyRequest = async (req, res) => {
  if (req.method !== 'POST') return writeJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    const ipHash = hashIp(getIp(req));
    if (hitRateLimit(`survey:${ipHash}`, 10, 60 * 1000)) {
      return writeJson(res, 429, { error: 'RATE_LIMITED' });
    }

    const body = await readJsonBody(req);

    // 登录用户优先（只读 session，不强制登录）；否则用 guestId
    // userId 只来自 session —— body.userId 不可信（IDOR）：未登录请求可在 body 里伪造任意 userId
    const { user } = getSessionUser(req);
    const userId = user?.id || null;
    const guestId = !userId ? cleanText(body.guestId, 120) : null;
    const scopeKey = userId ? `u:${userId}` : (guestId ? `g:${guestId}` : null);
    if (!scopeKey) return writeJson(res, 400, { error: 'BAD_REQUEST' });

    // 邮箱：归一 + 校验
    const emailRaw = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (emailRaw && !EMAIL_RE.test(emailRaw)) {
      return writeJson(res, 200, { ok: false, error: 'EMAIL_INVALID' });
    }

    // 邮箱跨 scopeKey 去重
    let email = emailRaw || null;
    if (email) {
      const owner = stmt.findSurveyByEmail.get(email);
      if (owner && owner.scopeKey !== scopeKey) {
        // 邮箱已被别的设备登记：仍存问卷答案，但不覆盖 email
        email = null;
        const answers = buildSurveyAnswers(body, scopeKey, userId, guestId, null, ipHash, body.reachedEmail ? 1 : 0);
        stmt.upsertSurvey.run(answers);
        return writeJson(res, 200, { ok: false, error: 'EMAIL_ALREADY_REGISTERED' });
      }
    }

    const reachedEmail = body.reachedEmail ? 1 : 0;
    const answers = buildSurveyAnswers(body, scopeKey, userId, guestId, email, ipHash, reachedEmail);
    stmt.upsertSurvey.run(answers);

    return writeJson(res, 200, { ok: true });
  } catch (error) {
    console.error('[auth] survey error', error?.message || 'UNKNOWN_ERROR');
    return writeJson(res, 500, { error: 'INTERNAL_ERROR' });
  }
};

export const handleLeaderboardRequest = async (req, res) => {
  try {
    const path = new URL(req.url || '/', 'http://local').pathname;
    if ((path === '/' || path === '/api/leaderboard') && req.method === 'GET') {
      const { user } = getSessionUser(req);
      return writeJson(res, 200, { entries: topScores(), viewerBest: user ? userBestScore(user.id) : null });
    }

    if ((path === '/submit' || path === '/api/leaderboard/submit') && req.method === 'POST') {
      const { user } = getSessionUser(req);
      if (!user) return writeJson(res, 401, { error: 'LOGIN_REQUIRED' });
      if (hitRateLimit(`submit:${user.id}`, 10, 60 * 1000)) return writeJson(res, 429, { error: 'SUBMIT_RATE_LIMITED' });
      const body = await readJsonBody(req);
      const runPayload = verifySignedPayload(body.runToken);
      const summary = normalizeSummary(body.summary);
      const events = Array.isArray(body.events) ? body.events : [];
      // Diagnostic snapshot logged on every rejection — without this we cannot
      // tell which anti-cheat layer killed a legitimate score (validateScore and
      // replayScore return only an error code, so prod logs were blind).
      const diag = { user: user.id, runId: runPayload?.runId, score: summary.score, distance: summary.distance, survivalTime: summary.survivalTime, bestCombo: summary.bestCombo, events: events.length };
      if (!runPayload) { console.warn('[leaderboard] reject BAD_RUN_TOKEN', diag); dumpRejectedRun('BAD_RUN_TOKEN', diag, events); return writeJson(res, 400, { error: 'BAD_RUN_TOKEN' }); }
      if (runPayload.userId && runPayload.userId !== user.id) return writeJson(res, 403, { error: 'RUN_USER_MISMATCH' });
      const scoreError = validateScore(summary, runPayload);
      if (scoreError) { console.warn('[leaderboard] reject ' + scoreError, diag); dumpRejectedRun(scoreError, diag, events); return writeJson(res, 400, { error: scoreError }); }

      // Replay-based anti-cheat: verify the score event log matches the claimed score
      const replayError = replayScore(events, summary, runPayload);
      if (replayError) { console.warn('[leaderboard] reject ' + replayError, diag); dumpRejectedRun(replayError, diag, events); return writeJson(res, 400, { error: replayError }); }

      // Single transaction: replay check + insert score + record runId. SQLite's
      // writer lock serializes this atomically — replaces the old withDbMutex.
      const entry = {
        id: randomBytes(12).toString('base64url'),
        userId: user.id, playerName: user.username,
        createdAt: Date.now(), runId: runPayload.runId,
        ...summary,
      };
      let outcome;
      const tx = db.transaction(() => {
        if (stmt.runIdSubmitted.get(runPayload.runId)) return { status: 409 };
        if (isScoreSuspicious(summary)) {
          console.warn('[leaderboard] suspicious score', { user: user.id, runId: runPayload.runId, score: summary.score, survivalTime: summary.survivalTime, distance: summary.distance });
        }
        stmt.insertScore.run(entry);
        stmt.insertRunId.run(runPayload.runId, Date.now());
        return { status: 200 };
      });
      outcome = tx();
      if (outcome.status === 409) return writeJson(res, 409, { error: 'RUN_ALREADY_SUBMITTED' });

      const entries = topScores();
      const viewerBest = userBestScore(user.id);
      const submittedEntry = entries.find((e) => e.id === entry.id)
        || { ...scoreRowToEntry({ ...entry }), rank: viewerBest?.rank };
      return writeJson(res, 200, { entry: submittedEntry, entries, viewerBest });
    }

    return writeJson(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    console.error('[auth] leaderboard error', error);
    return writeJson(res, 500, { error: 'INTERNAL_ERROR' });
  }
};
