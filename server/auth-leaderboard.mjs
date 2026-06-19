import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_PATH = join(fileURLToPath(new URL('..', import.meta.url)), 'data/game-auth-db.json');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const RUN_TTL_MS = 1000 * 60 * 60 * 2;
const POW_DIFFICULTY = 4;
const SECRET = process.env.GAME_SERVER_SECRET || (() => {
  console.warn('[auth] GAME_SERVER_SECRET not set — using an ephemeral random secret. Set GAME_SERVER_SECRET in production; server.mjs enforces it on boot.');
  return randomBytes(32).toString('hex');
})();

const rateBuckets = new Map();
const powChallenges = new Map();

const defaultDb = () => ({
  version: 1,
  users: [],
  sessions: [],
  scores: [],
  submittedRunIds: [],
  mikuMemories: {},
});

const readDb = async () => {
  try {
    const raw = await readFile(DATA_PATH, 'utf8');
    return { ...defaultDb(), ...JSON.parse(raw) };
  } catch {
    return defaultDb();
  }
};

// Serialize DB writes so concurrent read-modify-write cycles don't lose updates.
// Submit is the high-concurrency path on the leaderboard (H3).
let writeChain = Promise.resolve();
const writeDb = (db) => {
  const run = writeChain.then(async () => {
    await mkdir(dirname(DATA_PATH), { recursive: true });
    await writeFile(DATA_PATH, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
  });
  // Keep the chain alive even if one write rejects; the caller still sees the error.
  writeChain = run.catch(() => {});
  return run;
};

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

// Number of trusted reverse-proxy hops. 0 = ignore X-Forwarded-For entirely
// (safe default for direct deployment). Set to the proxy count when deployed
// behind nginx/Caddy so rate-limiting and PoW bind to the real client IP.
const TRUSTED_PROXY_HOPS = Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS || '0'));

const getIp = (req) => {
  if (TRUSTED_PROXY_HOPS > 0) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const parts = String(Array.isArray(forwarded) ? forwarded[0] : forwarded)
        .split(',')
        .map((segment) => segment.trim())
        .filter(Boolean);
      // XFF is appended left-to-right; the rightmost entry is the closest proxy.
      // Skip TRUSTED_PROXY_HOPS trusted proxies from the right; the entry to their
      // left is the real client. If there aren't enough entries, fall back to the
      // socket address (un-spoofable) — never parts[0], which is client-forged.
      const clientIndex = parts.length - TRUSTED_PROXY_HOPS - 1;
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

const getSessionUser = async (req, db = null) => {
  const token = bearerToken(req);
  if (!token) return { db: db ?? await readDb(), user: null, session: null };
  const loadedDb = db ?? await readDb();
  const now = Date.now();
  loadedDb.sessions = loadedDb.sessions.filter((session) => session.expiresAt > now);
  const session = loadedDb.sessions.find((item) => item.token === token);
  const user = session ? loadedDb.users.find((item) => item.id === session.userId) : null;
  return { db: loadedDb, user, session };
};

const createSession = (db, userId) => {
  const token = randomBytes(32).toString('base64url');
  db.sessions.push({
    token,
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
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
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

const createChallenge = (ipHash) => {
  const challenge = {
    nonce: randomBytes(18).toString('base64url'),
    difficulty: POW_DIFFICULTY,
    ipHash,
    expiresAt: Date.now() + 1000 * 60 * 5,
  };
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

const validateScore = (summary, runPayload) => {
  const now = Date.now();
  const elapsedSeconds = Math.floor((now - Number(runPayload.startAt || 0)) / 1000);
  if (!runPayload.runId || now - runPayload.startAt > RUN_TTL_MS) return 'RUN_EXPIRED';
  if (summary.score < 0 || summary.distance < 0 || summary.survivalTime < 3) return 'INVALID_SCORE';
  if (summary.survivalTime > elapsedSeconds + 8) return 'TIME_TRAVEL';
  if (summary.distance > summary.survivalTime * 45 + 120) return 'DISTANCE_TOO_HIGH';
  if (summary.score > summary.survivalTime * 4200 + summary.distance * 90 + 60000) return 'SCORE_TOO_HIGH';
  if (summary.bestCombo > 999 || summary.evidence > 999 || summary.scans > 999) return 'STAT_TOO_HIGH';
  return '';
};

// F1: flag scores that pass validateScore but sit near its ceiling. Accepted, logged for review.
// Full server-authoritative anti-cheat is a larger follow-up (see GSTACK_AUDIT.md F1).
const isScoreSuspicious = (summary) => {
  const ceiling = summary.survivalTime * 4200 + summary.distance * 90 + 60000;
  return summary.score > ceiling * 0.7;
};

// H3: serialize read-modify-write critical sections so concurrent ops don't lose updates.
let dbMutex = Promise.resolve();
const withDbMutex = (fn) => {
  const result = dbMutex.then(fn, fn);
  dbMutex = result.catch(() => {});
  return result;
};

const bestScoresByPlayer = (db) => {
  const bestByUser = new Map();
  for (const entry of db.scores) {
    const key = entry.userId || entry.playerName || entry.id;
    const current = bestByUser.get(key);
    if (
      !current
      || entry.score > current.score
      || (entry.score === current.score && entry.createdAt < current.createdAt)
    ) {
      bestByUser.set(key, entry);
    }
  }
  return [...bestByUser.values()];
};

const rankedScores = (db) => bestScoresByPlayer(db)
  .sort((a, b) => b.score - a.score || a.createdAt - b.createdAt)
  .map((entry, index) => ({
    ...entry,
    rank: index + 1,
    createdAt: new Date(entry.createdAt).toISOString(),
  }));

const topScores = (db) => rankedScores(db).slice(0, 50);

const userBestScore = (db, userId) => rankedScores(db).find((entry) => entry.userId === userId) || null;

const cleanText = (value, maxLength = 700) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);

const emptyMikuMemory = () => ({
  version: 1,
  sessionCount: 0,
  sessions: [],
});

const sanitizeMikuMessages = (messages) => {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant') && cleanText(message.content))
    .slice(-80)
    .map((message) => ({
      role: message.role,
      content: cleanText(message.content),
    }));
};

const sanitizeMikuTopic = (topic, fallbackId) => {
  const title = cleanText(topic?.title, 80);
  const summary = cleanText(topic?.summary, 260);
  if (!title || !summary) return null;
  return {
    id: cleanText(topic?.id, 100) || fallbackId,
    title,
    summary,
    keywords: Array.isArray(topic?.keywords) ? topic.keywords.slice(0, 8).map((keyword) => cleanText(keyword, 40)).filter(Boolean) : [],
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
      id,
      createdAt,
      messages,
      sessionSummary: cleanText(session?.sessionSummary, 360) || undefined,
      topics: Array.isArray(session?.topics)
        ? session.topics.slice(0, 10).map((topic, index) => sanitizeMikuTopic(topic, `${id}-topic-${index + 1}`)).filter(Boolean)
        : [],
      taggedTranscript: cleanText(session?.taggedTranscript, 8000) || undefined,
    };
  }).filter(Boolean) : [];
  const knowledgeContent = cleanText(memory.knowledge?.content, 4000);
  const pendingGreeting = cleanText(memory.pendingGreeting?.content, 120);
  return {
    version: 1,
    sessionCount: Math.max(Number(memory.sessionCount) || sessions.length, sessions.length),
    sessions,
    knowledge: knowledgeContent ? {
      content: knowledgeContent,
      updatedAt: cleanText(memory.knowledge?.updatedAt, 60) || new Date().toISOString(),
      sourceSessionIds: Array.isArray(memory.knowledge?.sourceSessionIds)
        ? memory.knowledge.sourceSessionIds.slice(-12).map((id) => cleanText(id, 100)).filter(Boolean)
        : [],
    } : undefined,
    pendingGreeting: pendingGreeting ? {
      content: pendingGreeting,
      generatedAt: cleanText(memory.pendingGreeting?.generatedAt, 60) || new Date().toISOString(),
      sourceSessionId: cleanText(memory.pendingGreeting?.sourceSessionId, 100),
    } : undefined,
  };
};

const mergeMikuMemories = (current, incoming, options = {}) => {
  const safeCurrent = sanitizeMikuMemory(current);
  const safeIncoming = sanitizeMikuMemory(incoming);
  const sessionsById = new Map();
  [...safeCurrent.sessions, ...safeIncoming.sessions].forEach((session) => {
    sessionsById.set(session.id, session);
  });
  const sessions = [...sessionsById.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const currentKnowledgeTime = Date.parse(safeCurrent.knowledge?.updatedAt || '') || 0;
  const incomingKnowledgeTime = Date.parse(safeIncoming.knowledge?.updatedAt || '') || 0;
  return {
    version: 1,
    sessionCount: Math.max(safeCurrent.sessionCount, safeIncoming.sessionCount, sessions.length),
    sessions,
    knowledge: incomingKnowledgeTime >= currentKnowledgeTime ? (safeIncoming.knowledge || safeCurrent.knowledge) : (safeCurrent.knowledge || safeIncoming.knowledge),
    pendingGreeting: options.clearPendingGreeting ? undefined : (safeIncoming.pendingGreeting || safeCurrent.pendingGreeting),
  };
};

export const handleMikuMemoryRequest = async (req, res) => {
  try {
    const { db, user } = await getSessionUser(req);
    if (!user) return writeJson(res, 401, { error: 'LOGIN_REQUIRED' });
    db.mikuMemories = db.mikuMemories && typeof db.mikuMemories === 'object' ? db.mikuMemories : {};

    if (req.method === 'GET') {
      await writeDb(db);
      return writeJson(res, 200, { memory: sanitizeMikuMemory(db.mikuMemories[user.id]) });
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readJsonBody(req);
      const incoming = sanitizeMikuMemory(body.memory);
      const mode = cleanText(body.mode, 20);
      db.mikuMemories[user.id] = mode === 'replace'
        ? incoming
        : mergeMikuMemories(db.mikuMemories[user.id], incoming, { clearPendingGreeting: Boolean(body.clearPendingGreeting) });
      await writeDb(db);
      return writeJson(res, 200, { memory: sanitizeMikuMemory(db.mikuMemories[user.id]) });
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
      if (hitRateLimit(`register:${ipHash}`, 5, 60 * 60 * 1000)) return writeJson(res, 429, { error: 'REGISTER_RATE_LIMITED' });
      const body = await readJsonBody(req);
      const username = sanitizeUsername(body.username);
      const password = String(body.password || '');
      if (!verifyChallenge(body.pow, ipHash)) return writeJson(res, 400, { error: 'POW_REQUIRED' });
      if (!validateUsername(username)) return writeJson(res, 400, { error: 'BAD_USERNAME' });
      if (password.length < 8 || password.length > 80) return writeJson(res, 400, { error: 'BAD_PASSWORD' });

      const db = await readDb();
      if (db.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) return writeJson(res, 409, { error: 'USERNAME_TAKEN' });
      const user = {
        id: randomBytes(12).toString('base64url'),
        username,
        passwordHash: passwordHash(password),
        createdAt: Date.now(),
        createdIpHash: ipHash,
      };
      db.users.push(user);
      const token = createSession(db, user.id);
      await writeDb(db);
      return writeJson(res, 200, { token, user: publicUser(user) });
    }

    if (path === '/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const username = sanitizeUsername(body.username);
      if (hitRateLimit(`login:${ipHash}:${username.toLowerCase()}`, 8, 10 * 60 * 1000)) return writeJson(res, 429, { error: 'LOGIN_RATE_LIMITED' });
      const db = await readDb();
      const user = db.users.find((item) => item.username.toLowerCase() === username.toLowerCase());
      if (!user || !verifyPassword(body.password, user.passwordHash)) return writeJson(res, 401, { error: 'BAD_CREDENTIALS' });
      const token = createSession(db, user.id);
      await writeDb(db);
      return writeJson(res, 200, { token, user: publicUser(user) });
    }

    if (path === '/logout' && req.method === 'POST') {
      const { db, session } = await getSessionUser(req);
      if (session) db.sessions = db.sessions.filter((item) => item.token !== session.token);
      await writeDb(db);
      return writeJson(res, 200, { ok: true });
    }

    if (path === '/me' && req.method === 'GET') {
      const { db, user } = await getSessionUser(req);
      await writeDb(db);
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
  const { user } = await getSessionUser(req);
  const payload = {
    runId: randomBytes(14).toString('base64url'),
    startAt: Date.now(),
    userId: user?.id,
  };
  return writeJson(res, 200, { runToken: signPayload(payload), runId: payload.runId });
};

export const handleLeaderboardRequest = async (req, res) => {
  try {
    const path = new URL(req.url || '/', 'http://local').pathname;
    if ((path === '/' || path === '/api/leaderboard') && req.method === 'GET') {
      const db = await readDb();
      const { user } = await getSessionUser(req, db);
      return writeJson(res, 200, { entries: topScores(db), viewerBest: user ? userBestScore(db, user.id) : null });
    }

    if ((path === '/submit' || path === '/api/leaderboard/submit') && req.method === 'POST') {
      const { user } = await getSessionUser(req);
      if (!user) return writeJson(res, 401, { error: 'LOGIN_REQUIRED' });
      // F1 anti-cheat (rate): cap submissions per user to blunt scripted flooding.
      if (hitRateLimit(`submit:${user.id}`, 10, 60 * 1000)) return writeJson(res, 429, { error: 'SUBMIT_RATE_LIMITED' });
      const body = await readJsonBody(req);
      const runPayload = verifySignedPayload(body.runToken);
      const summary = normalizeSummary(body.summary);
      if (!runPayload) return writeJson(res, 400, { error: 'BAD_RUN_TOKEN' });
      if (runPayload.userId && runPayload.userId !== user.id) return writeJson(res, 403, { error: 'RUN_USER_MISMATCH' });
      const scoreError = validateScore(summary, runPayload);
      if (scoreError) return writeJson(res, 400, { error: scoreError });

      // H3: re-read the latest DB under a mutex so concurrent submits can't
      // overwrite each other's new entry. runId replay is checked on the freshest data.
      const outcome = await withDbMutex(async () => {
        const freshDb = await readDb();
        if (freshDb.submittedRunIds.includes(runPayload.runId)) return { status: 409 };

        // F1 anti-cheat (review): scores near the validation ceiling are accepted but flagged.
        if (isScoreSuspicious(summary)) {
          console.warn('[leaderboard] suspicious score', { user: user.id, runId: runPayload.runId, score: summary.score, survivalTime: summary.survivalTime, distance: summary.distance });
        }

        const entry = {
          id: randomBytes(12).toString('base64url'),
          userId: user.id,
          playerName: user.username,
          createdAt: Date.now(),
          runId: runPayload.runId,
          ...summary,
        };
        freshDb.scores.push(entry);
        freshDb.submittedRunIds.push(runPayload.runId);
        freshDb.submittedRunIds = freshDb.submittedRunIds.slice(-5000);
        freshDb.scores = freshDb.scores.sort((a, b) => b.score - a.score).slice(0, 500);
        await writeDb(freshDb);
        const viewerBest = userBestScore(freshDb, user.id);
        const submittedEntry = rankedScores(freshDb).find((item) => item.id === entry.id) || { ...entry, rank: viewerBest?.rank, createdAt: new Date(entry.createdAt).toISOString() };
        return { status: 200, entry: submittedEntry, entries: topScores(freshDb), viewerBest };
      });

      if (outcome.status === 409) return writeJson(res, 409, { error: 'RUN_ALREADY_SUBMITTED' });
      return writeJson(res, 200, { entry: outcome.entry, entries: outcome.entries, viewerBest: outcome.viewerBest });
    }

    return writeJson(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    console.error('[auth] leaderboard error', error);
    return writeJson(res, 500, { error: 'INTERNAL_ERROR' });
  }
};
