/**
 * auth-leaderboard.mjs —— 服务端认证、反作弊与排行榜模块
 * ============================================================================
 *
 * 【在整体反作弊体系中的位置】
 *   本模块是服务端反作弊的第 4 层（共 4 层），负责：
 *     - 第 4 层：PoW 防机器人注册 + HMAC runToken 签名 + 分数合理性 + 完整性交叉校验
 *   配合客户端的另外 3 层：
 *     - 第 1 层：antiDebug.ts    —— 调试器 / DevTools / 控制台篡改 / 帧异常检测
 *     - 第 2 层：codeIntegrity.ts —— 运行时 JS bundle SHA-256 哈希与服务器 manifest 比对
 *     - 第 3 层：wasm-core/lib.rs  —— Rust WASM 管理 HP / panic / shield，内部状态自校验
 *
 * 【技术选型】
 *   - 纯 Node.js 内置 API（crypto / fs / http），零外部框架依赖
 *   - HMAC-SHA256 签名 session token 和 runToken（无状态校验，无需查表）
 *   - PBKDF2（210,000 次迭代）哈希用户密码
 *   - SHA-256 PoW（前 4 位为 0）防机器人批量注册
 *   - JSON 文件存储（data/game-auth-db.json），无数据库依赖
 *   - 内存限流桶（per-IP / per-user）
 *   - Promise 链实现 DB 写序列化 + 互斥锁，防止并发写丢失数据
 *
 * 【API 端点总览】
 *   /api/auth/challenge      POST   - 获取 PoW 挑战（注册前置条件）
 *   /api/auth/register       POST   - 注册（需 PoW 答案）
 *   /api/auth/login          POST   - 登录
 *   /api/auth/logout         POST   - 登出（销毁 session）
 *   /api/auth/me              GET   - 获取当前登录用户信息
 *   /api/runs/start          POST   - 开始一局游戏，获取 HMAC 签名的 runToken
 *   /api/leaderboard          GET   - 获取排行榜前 50 + 当前用户最佳成绩
 *   /api/leaderboard/submit  POST   - 提交成绩（需 runToken + session）
 *   /api/miku-memory       GET/PUT  - Miku NPC 对话记忆的读写（Steam 版已废弃）
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ═══════════════════════════════════════════════════════════════════════════
// 常量与配置
// ═══════════════════════════════════════════════════════════════════════════

// 数据库文件路径 —— 单个 JSON 文件存储所有用户、session、成绩、Miku 记忆
const DATA_PATH = join(fileURLToPath(new URL('..', import.meta.url)), 'data/game-auth-db.json');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 构建时生成的完整性清单路径（由 scripts/build-integrity.mjs 生成）
const INTEGRITY_PATH = join(ROOT, 'dist', 'integrity.json');

// Session 有效期：30 天
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
// runToken 有效期：2 小时（超过此时间的成绩提交会被拒绝）
const RUN_TTL_MS = 1000 * 60 * 60 * 2;
// PoW 难度：要求 SHA-256 结果前 4 位为 0（平均约 2^4 = 16 次尝试）
const POW_DIFFICULTY = 4;

// HMAC 签名密钥
// - 生产环境：必须通过 GAME_SERVER_SECRET 环境变量设置（≥32 字符随机串）
// - 未设置时：使用临时随机密钥（每次重启 session 全部失效，server.mjs 会拒绝启动）
const SECRET = process.env.GAME_SERVER_SECRET || (() => {
  console.warn('[auth] GAME_SERVER_SECRET not set — using an ephemeral random secret. Set GAME_SERVER_SECRET in production; server.mjs enforces it on boot.');
  return randomBytes(32).toString('hex');
})();

// ═══════════════════════════════════════════════════════════════════════════
// 内存存储（非持久化，服务重启后清空）
// ═══════════════════════════════════════════════════════════════════════════

// 限流桶：key → 时间戳数组，用于滑动窗口计数
const rateBuckets = new Map();
// PoW 挑战暂存：nonce → { nonce, difficulty, ipHash, expiresAt }
// 挑战有效期 5 分钟，验证通过后立即删除（一次性使用）
const powChallenges = new Map();

// ═══════════════════════════════════════════════════════════════════════════
// 数据库读写（JSON 文件）
// ═══════════════════════════════════════════════════════════════════════════

// 数据库默认结构 —— 用展开运算符确保新版本新增字段有默认值
const defaultDb = () => ({
  version: 1,
  users: [],            // 用户列表
  sessions: [],         // 活跃 session 列表
  scores: [],           // 所有成绩记录
  submittedRunIds: [],  // 已提交的 runId（防重放攻击，保留最近 5000 条）
  mikuMemories: {},     // Miku 对话记忆（按 userId 索引）
});

// 读取数据库 —— 文件不存在或解析失败时返回默认空库
const readDb = async () => {
  try {
    const raw = await readFile(DATA_PATH, 'utf8');
    return { ...defaultDb(), ...JSON.parse(raw) };
  } catch {
    return defaultDb();
  }
};

// 写入数据库
// 【关键设计】通过 Promise 链（writeChain）将所有写操作序列化。
// 排行榜提交是高并发路径（H3 级别），如果不序列化：
//   1. 读 DB → 2. 修改 → 3. 写 DB
//   两个并发请求可能在步骤 1 读到相同状态，各自修改后写入，
//   后写入的会覆盖先写入的数据（last-write-wins 丢失更新）。
// 序列化后每个写操作排队执行，确保 read-modify-write 的原子性。
let writeChain = Promise.resolve();
const writeDb = (db) => {
  const run = writeChain.then(async () => {
    await mkdir(dirname(DATA_PATH), { recursive: true });
    await writeFile(DATA_PATH, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
  });
  // 即使某次写入失败，也保持链条不断（后续请求不受影响）
  // 调用方仍然能通过返回的 run Promise 捕获错误
  writeChain = run.catch(() => { });
  return run;
};

// ═══════════════════════════════════════════════════════════════════════════
// HTTP 工具函数
// ═══════════════════════════════════════════════════════════════════════════

// 流式读取 HTTP 请求体并解析为 JSON
const readJsonBody = async (req) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  return JSON.parse(raw);
};

// 统一 JSON 响应格式
const writeJson = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

// ═══════════════════════════════════════════════════════════════════════════
// IP 获取与限流
// ═══════════════════════════════════════════════════════════════════════════

// 受信任的反代跳数。
// 0 = 忽略 X-Forwarded-For（直连部署的安全默认值）。
// 部署在 nginx / Caddy 后面时设为反代层数，使限流和 PoW 绑定真实客户端 IP。
const TRUSTED_PROXY_HOPS = Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS || '0'));

// 获取客户端真实 IP
// 【安全设计】
//   X-Forwarded-For 是左追加的（客户端 IP 在最左，后续每层反代向右追加）。
//   从右侧跳过 TRUSTED_PROXY_HOPS 个可信反代，它们左侧的第一个 IP 才是真实客户端。
//   如果 XFF 条目不足以跳过 —— 回退到 socket.remoteAddress（不可伪造）。
//   【绝不】使用 parts[0]—— 它是客户端可控的头部，可被任意伪造。
const getIp = (req) => {
  if (TRUSTED_PROXY_HOPS > 0) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const parts = String(Array.isArray(forwarded) ? forwarded[0] : forwarded)
        .split(',')
        .map((segment) => segment.trim())
        .filter(Boolean);
      const clientIndex = parts.length - TRUSTED_PROXY_HOPS - 1;
      if (clientIndex >= 0) return parts[clientIndex] || req.socket.remoteAddress || 'local';
    }
  }
  return req.socket.remoteAddress || 'local';
};

// IP 哈希 —— 取 SHA-256 前 24 位十六进制字符
// 用于限流键和数据库存储（不存原始 IP，降低隐私风险）
const hashIp = (ip) => createHash('sha256').update(`ip:${ip}`).digest('hex').slice(0, 24);

// 滑动窗口限流
// @param {string} key       - 限流键（如 "login:ipHash:username"）
// @param {number} limit     - 窗口内允许的最大请求数
// @param {number} windowMs  - 窗口时长（毫秒）
// @returns {boolean}        - true = 被限流，应拒绝请求
const hitRateLimit = (key, limit, windowMs) => {
  const now = Date.now();
  const bucket = rateBuckets.get(key) ?? [];
  // 剔除窗口外的旧记录
  const next = bucket.filter((time) => now - time < windowMs);
  next.push(now);
  rateBuckets.set(key, next);
  return next.length > limit;
};

// ═══════════════════════════════════════════════════════════════════════════
// 用户验证相关
// ═══════════════════════════════════════════════════════════════════════════

// 用户名清理：去空白、空格转下划线、截断至 18 字符
const sanitizeUsername = (value) => String(value ?? '').trim().replace(/\s+/g, '_').slice(0, 18);

// 用户名格式验证：3-18 位 Unicode 字母/数字/下划线/连字符
const validateUsername = (username) => /^[\p{L}\p{N}_-]{3,18}$/u.test(username);

// 密码哈希：PBKDF2-SHA256，210,000 次迭代，32 字节输出
// 格式："{salt_hex}:{hash_hex}"
const passwordHash = (password, salt = randomBytes(16).toString('hex')) => {
  const hash = pbkdf2Sync(String(password), salt, 210000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
};

// 密码验证 —— 使用 timingSafeEqual 防止时序攻击
const verifyPassword = (password, stored) => {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !expected) return false;
  const actual = passwordHash(password, salt).split(':')[1];
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
};

// 返回公开用户信息（过滤掉 passwordHash 等敏感字段）
const publicUser = (user) => user ? ({ id: user.id, username: user.username }) : null;

// ═══════════════════════════════════════════════════════════════════════════
// Session 与会话管理
// ═══════════════════════════════════════════════════════════════════════════

// 从 Authorization 头部提取 Bearer token
const bearerToken = (req) => {
  const header = req.headers.authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match?.[1] || '';
};

// 获取当前会话用户
// 同时清理过期 session（惰性清理，不在每次读写时额外遍历）
const getSessionUser = async (req, db = null) => {
  const token = bearerToken(req);
  if (!token) {
    console.log('[getSessionUser] no bearer token in Authorization header. req.headers keys:', JSON.stringify(Object.keys(req.headers || {})));
    return { db: db ?? await readDb(), user: null, session: null };
  }
  const loadedDb = db ?? await readDb();
  const now = Date.now();
  // 过滤掉过期的 session（惰性清理策略）
  loadedDb.sessions = loadedDb.sessions.filter((session) => session.expiresAt > now);
  const session = loadedDb.sessions.find((item) => item.token === token);
  const user = session ? loadedDb.users.find((item) => item.id === session.userId) : null;
  console.log('[getSessionUser] token prefix:', token.slice(0, 8) + '...', 'session found:', !!session, 'user:', user?.username, 'total sessions in DB:', loadedDb.sessions.length);
  return { db: loadedDb, user, session };
};

// 创建新 session —— 生成 32 字节 base64url 随机 token，30 天有效
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

// ═══════════════════════════════════════════════════════════════════════════
// HMAC 签名与验证（runToken 机制）
// ═══════════════════════════════════════════════════════════════════════════

// 【runToken 设计目的】
//   1. 服务端签发一个包含 {runId, startAt, userId} 的签名令牌
//   2. 客户端拿到令牌后才能开始游戏，提交成绩时必须回传
//   3. HMAC 签名保证了令牌不可伪造、不可篡改
//   4. 服务端校验 runToken 即可确认：
//      - 这局游戏是服务端授权的（不是客户端捏造的）
//      - 游戏开始时间可信（防时间旅行作弊）
//      - 提交者就是 runToken 的签发对象（防跨账号提交）

// HMAC-SHA256 签名一个 payload
// 返回格式："{base64url(payload)}.{base64url(hmac_signature)}"
const signPayload = (payload) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
};

// 验证并解码一个签名过的 token
// 返回解码后的 payload，验证失败（签名不匹配 / 格式错误）返回 null
// 使用 timingSafeEqual 防止签名时序攻击
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

// ═══════════════════════════════════════════════════════════════════════════
// PoW（Proof of Work）防机器人
// ═══════════════════════════════════════════════════════════════════════════

// 【PoW 流程】
//   1. 客户端 POST /api/auth/challenge → 服务端返回 { nonce, difficulty: 4 }
//   2. 客户端暴力计算：尝试不同的 answer 值，
//      直到 SHA-256("{nonce}:{answer}") 的前 4 位十六进制字符为 "0000"
//      （难度 4 表示平均需要 2^4 = 16 次尝试，对人类无感知，对脚本有一定成本）
//   3. 客户端 POST /api/auth/register → 携带 { pow: { nonce, answer } }
//   4. 服务端验证 PoW → 通过后允许注册，删除该 nonce（防止重用）

// 创建一个 PoW 挑战，5 分钟有效
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

// 验证 PoW 答案
// 三个条件同时满足：
//   1. nonce 对应的挑战存在且未过期
//   2. 请求者 IP 与挑战签发时的 IP 一致（防止跨 IP 代答）
//   3. SHA-256("{nonce}:{answer}") 前 difficulty 位全是 0
// 验证通过后删除挑战（一次性使用，防止重放）
const verifyChallenge = ({ nonce, answer }, ipHash) => {
  const challenge = powChallenges.get(String(nonce || ''));
  if (!challenge || challenge.expiresAt < Date.now() || challenge.ipHash !== ipHash) return false;
  const digest = createHash('sha256').update(`${challenge.nonce}:${answer}`).digest('hex');
  const ok = digest.startsWith('0'.repeat(challenge.difficulty));
  if (ok) powChallenges.delete(challenge.nonce);
  return ok;
};

// ═══════════════════════════════════════════════════════════════════════════
// 分数验证（validateScore）
// ═══════════════════════════════════════════════════════════════════════════

// 规范化客户端提交的 summary —— 所有字段取整并做类型安全处理
// 注意：App.tsx 的 submitGlobalScore() 原样传递 summary，
//       不再注入 codeHash / tamperFlags / integrity（这些字段由客户端工具模块独立处理）
const normalizeSummary = (value) => ({
  score: Math.floor(Number(value?.score) || 0),
  distance: Math.floor(Number(value?.distance) || 0),
  evidence: Math.floor(Number(value?.evidence) || 0),
  scans: Math.floor(Number(value?.scans) || 0),
  nearMisses: Math.floor(Number(value?.nearMisses) || 0),
  bestCombo: Math.floor(Number(value?.bestCombo) || 0),
  survivalTime: Math.floor(Number(value?.survivalTime) || 0),
  title: String(value?.title || '见习调查员').slice(0, 24),
  // 以下三个字段由客户端的第 1、2、3 层反作弊模块独立计算并附带
  integrity: String(value?.integrity || ''),       // WASM 生成的完整性令牌
  codeHash: String(value?.codeHash || ''),         // 客户端 JS bundle 的 SHA-256
  tamperFlags: Number(value?.tamperFlags) || 0,    // 反调试检测到的篡改标记位掩码
});

// 【核心函数】验证成绩合理性 —— 7 条规则
// 返回空字符串 '' 表示通过，否则返回错误码
const validateScore = (summary, runPayload) => {
  const now = Date.now();
  // 计算从游戏开始到现在的实际经过时间
  const elapsedSeconds = Math.floor((now - Number(runPayload.startAt || 0)) / 1000);

  // 规则 ① 过期检查：runToken 超过 2 小时即失效
  if (!runPayload.runId || now - runPayload.startAt > RUN_TTL_MS) return 'RUN_EXPIRED';

  // 规则 ② 基础合法性：分数/距离非负，存活时间至少 3 秒
  if (summary.score < 0 || summary.distance < 0 || summary.survivalTime < 3) return 'INVALID_SCORE';

  // 规则 ③ 时间旅行检测：客户端上报的 survivalTime 不能超过实际经过时间 + 8 秒容差
  // （8 秒容差用于覆盖网络延迟和时钟偏差）
  if (summary.survivalTime > elapsedSeconds + 8) return 'TIME_TRAVEL';

  // 规则 ④ 距离上限：最快移动速度约 45 米/秒（考虑冲刺、出租车等加速手段），
  // 加上 120 米的初始偏移容差
  if (summary.distance > summary.survivalTime * 45 + 120) return 'DISTANCE_TOO_HIGH';

  // 规则 ⑤ 分数上限：基于理论最大得分速率估算
  // 时间分量：每秒最多约 4200 分（combo 倍率 + 擦弹 + 扫描等操作的理论上限）
  // 距离分量：每米最多约 90 分
  // 固定加成：60000 分（证据收集 + 出租车奖励等一次性加分上限）
  if (summary.score > summary.survivalTime * 4200 + summary.distance * 90 + 60000) return 'SCORE_TOO_HIGH';

  // 规则 ⑥ 统计数据上限：单局 combo / evidence / scans 不可能超过 999
  if (summary.bestCombo > 999 || summary.evidence > 999 || summary.scans > 999) return 'STAT_TOO_HIGH';

  // 规则 ⑦ WASM 完整性校验（来自客户端第 3 层反作弊 —— wasm-core/lib.rs）
  // integrity 格式："{state_hash_hex}.{mutation_count_hex}.{random_seed_hex}"
  // mutation_count 记录 WASM 内部状态被修改的次数
  // 每次 scan / evidence 收集 / near miss 至少会触发一次 mutation
  // → mutation_count 不应小于这三类操作的总和
  if (summary.integrity) {
    const parts = String(summary.integrity).split('.');
    if (parts.length !== 3) return 'INTEGRITY_MALFORMED';
    const mutationCount = parseInt(parts[1], 16);
    const minMutations = (Number(summary.scans) || 0) + (Number(summary.evidence) || 0) + (Number(summary.nearMisses) || 0);
    if (!Number.isFinite(mutationCount) || mutationCount < minMutations) return 'INTEGRITY_FAIL';
  }

  // 规则 ⑧ 代码完整性校验（来自客户端第 2 层反作弊 —— codeIntegrity.ts）
  // 客户端在运行时对自己的 JS bundle 做 SHA-256，与构建时生成的 manifest.version 比对
  // 如果 codeHash 存在但不匹配 → 客户端 JS 被篡改过 → CODE_HASH_MISMATCH
  if (summary.codeHash) {
    const manifest = loadIntegrityManifest();
    if (manifest && summary.codeHash !== manifest.version) {
      return 'CODE_HASH_MISMATCH';
    }
  }

  return '';
};

// ═══════════════════════════════════════════════════════════════════════════
// 构建时完整性清单
// ═══════════════════════════════════════════════════════════════════════════

// 缓存加载的清单 —— 服务整个生命周期只读一次
let cachedManifest = null;
let manifestLoaded = false;

// 加载 dist/integrity.json（由 scripts/build-integrity.mjs 在构建时生成）
// 包含 JS bundle 和 WASM 文件的 SHA-256 哈希
const loadIntegrityManifest = () => {
  if (manifestLoaded) return cachedManifest;
  manifestLoaded = true;
  try {
    if (existsSync(INTEGRITY_PATH)) {
      cachedManifest = JSON.parse(readFileSync(INTEGRITY_PATH, 'utf8'));
      console.log(`[integrity] Loaded manifest v${cachedManifest.version}`);
    } else {
      console.warn('[integrity] No integrity.json found — code hash checks disabled');
    }
  } catch (err) {
    console.warn('[integrity] Failed to load manifest:', err.message);
  }
  return cachedManifest;
};

// ═══════════════════════════════════════════════════════════════════════════
// 可疑分数标记（F1 反作弊 —— 审核层）
// ═══════════════════════════════════════════════════════════════════════════

// 分数接近 validateScore 上限 70% 的成绩被视为"可疑"。
// 【不会拒绝】—— 只是记录日志供人工审核。
// 原因：上限公式是理论最大值估算，实际高手可能接近但不应被误封。
// 真正的服务端权威反作弊需要把游戏模拟搬到服务端，当前架构不现实。
const isScoreSuspicious = (summary) => {
  const ceiling = summary.survivalTime * 4200 + summary.distance * 90 + 60000;
  return summary.score > ceiling * 0.7;
};

// ═══════════════════════════════════════════════════════════════════════════
// 数据库互斥锁（H3 级别并发安全）
// ═══════════════════════════════════════════════════════════════════════════

// 【为什么需要两层序列化】
//   writeChain (第 39 行):  序列化所有磁盘写入，防止并发 fs.writeFile 交叉覆盖
//   dbMutex  (本段):       序列化整个 "读取 → 检查 → 修改 → 写入" 事务
//
//   在高并发成绩提交场景下：
//     请求 A: readDb() → 检查 runId 未重复 → push → writeDb()
//     请求 B: readDb() → 检查 runId 未重复 → push → writeDb()  ← 可能读到 A 写入前的旧数据！
//   dbMutex 确保 B 的 readDb() 在 A 的 writeDb() 之后执行，从而正确检测到重复 runId。

let dbMutex = Promise.resolve();
const withDbMutex = (fn) => {
  const result = dbMutex.then(fn, fn);
  dbMutex = result.catch(() => { });
  return result;
};

// ═══════════════════════════════════════════════════════════════════════════
// 排行榜数据处理
// ═══════════════════════════════════════════════════════════════════════════

// 每位玩家只保留最高分的一条记录
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

// 按分数降序排列，赋予排名
const rankedScores = (db) => bestScoresByPlayer(db)
  .sort((a, b) => b.score - a.score || a.createdAt - b.createdAt)
  .map((entry, index) => ({
    ...entry,
    rank: index + 1,
    createdAt: new Date(entry.createdAt).toISOString(),
  }));

// 前 50 名
const topScores = (db) => rankedScores(db).slice(0, 50);

// 查询指定用户的最佳排名
const userBestScore = (db, userId) => rankedScores(db).find((entry) => entry.userId === userId) || null;

// ═══════════════════════════════════════════════════════════════════════════
// Miku 记忆相关工具函数（Steam 版已废弃，仅保留服务端存储逻辑）
// ═══════════════════════════════════════════════════════════════════════════

// 文本清理：合并空白、去首尾空格、截断
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

// ═══════════════════════════════════════════════════════════════════════════
// 路由处理器：Miku 记忆（Steam 版已废弃，保留接口但客户端不再调用）
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// 路由处理器：认证（/api/auth/*）
// ═══════════════════════════════════════════════════════════════════════════

export const handleAuthRequest = async (req, res) => {
  try {
    // 解析路径：去掉 /api/auth 前缀，空路径视为 /me
    const path = new URL(req.url || '/', 'http://local').pathname.replace(/^\/api\/auth/, '') || '/me';
    const ipHash = hashIp(getIp(req));

    // ── POST /api/auth/challenge ──
    // 获取 PoW 挑战，限流 60 次/10 分钟/IP
    if (path === '/challenge' && req.method === 'POST') {
      if (hitRateLimit(`challenge:${ipHash}`, 60, 10 * 60 * 1000)) return writeJson(res, 429, { error: 'TOO_MANY_CHALLENGES' });
      const challenge = createChallenge(ipHash);
      return writeJson(res, 200, { nonce: challenge.nonce, difficulty: challenge.difficulty });
    }

    // ── POST /api/auth/register ──
    // 注册流程：PoW 验证 → 用户名格式 → 密码长度 → 用户名唯一性 → 创建用户 + session
    // 限流 50 次/10 分钟/IP（放宽后，之前因 TRUSTED_PROXY_HOPS=0 导致共享 IP 桶误伤）
    if (path === '/register' && req.method === 'POST') {
      if (hitRateLimit(`register:${ipHash}`, 50, 10 * 60 * 1000)) return writeJson(res, 429, { error: 'REGISTER_RATE_LIMITED' });
      const body = await readJsonBody(req);
      const username = sanitizeUsername(body.username);
      const password = String(body.password || '');
      // 验证 PoW：必须提供有效的 nonce + answer，且与当前 IP 绑定
      if (!verifyChallenge(body.pow, ipHash)) return writeJson(res, 400, { error: 'POW_REQUIRED' });
      if (!validateUsername(username)) return writeJson(res, 400, { error: 'BAD_USERNAME' });
      if (password.length < 8 || password.length > 80) return writeJson(res, 400, { error: 'BAD_PASSWORD' });

      const db = await readDb();
      // 用户名唯一性检查（大小写不敏感）
      if (db.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) return writeJson(res, 409, { error: 'USERNAME_TAKEN' });
      const user = {
        id: randomBytes(12).toString('base64url'),
        username,
        passwordHash: passwordHash(password),
        createdAt: Date.now(),
        createdIpHash: ipHash,
      };
      db.users.push(user);
      // 注册即登录：同时创建 session 返回 token
      const token = createSession(db, user.id);
      await writeDb(db);
      return writeJson(res, 200, { token, user: publicUser(user) });
    }

    // ── POST /api/auth/login ──
    // 登录流程：限流检查 → 查找用户 → 验证密码 → 创建 session
    // 限流 8 次/10 分钟/(IP + 用户名)，防止暴力破解
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

    // ── POST /api/auth/logout ──
    // 销毁当前 session
    if (path === '/logout' && req.method === 'POST') {
      const { db, session } = await getSessionUser(req);
      if (session) db.sessions = db.sessions.filter((item) => item.token !== session.token);
      await writeDb(db);
      return writeJson(res, 200, { ok: true });
    }

    // ── GET /api/auth/me ──
    // 获取当前登录用户信息（用于页面刷新后恢复登录状态）
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

// ═══════════════════════════════════════════════════════════════════════════
// 路由处理器：开始游戏（/api/runs/start）
// ═══════════════════════════════════════════════════════════════════════════

// 【流程】
//   客户端 App.tsx startRun() 在 setGameState('PLAYING') 之前 await 此端点。
//   拿到 runToken 后才启动游戏，确保每局游戏都有服务端签发的令牌。
//   未登录用户也可以玩（userId 为 undefined），但提交分数时仍需登录。
export const handleRunStartRequest = async (req, res) => {
  if (req.method !== 'POST') return writeJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const { user } = await getSessionUser(req);
  const payload = {
    runId: randomBytes(14).toString('base64url'),  // 每局唯一 ID，防重放
    startAt: Date.now(),                            // 服务端时间戳，防时间旅行
    userId: user?.id,                               // 绑定用户（如有），防跨账号提交
  };
  // 返回 HMAC 签名的 runToken（客户端无法伪造）
  return writeJson(res, 200, { runToken: signPayload(payload), runId: payload.runId });
};

// ═══════════════════════════════════════════════════════════════════════════
// 路由处理器：排行榜（/api/leaderboard 和 /api/leaderboard/submit）
// ═══════════════════════════════════════════════════════════════════════════

export const handleLeaderboardRequest = async (req, res) => {
  try {
    const path = new URL(req.url || '/', 'http://local').pathname;

    // ── GET /api/leaderboard ──
    // 返回前 50 名 + 当前登录用户的最佳排名（如有）
    if ((path === '/' || path === '/api/leaderboard') && req.method === 'GET') {
      const db = await readDb();
      const { user } = await getSessionUser(req, db);
      return writeJson(res, 200, { entries: topScores(db), viewerBest: user ? userBestScore(db, user.id) : null });
    }

    // ── POST /api/leaderboard/submit ──
    // 成绩提交流程（7 步验证链）：
    if ((path === '/submit' || path === '/api/leaderboard/submit') && req.method === 'POST') {
      const { user } = await getSessionUser(req);
      console.log('[leaderboard] submit request', { hasAuth: !!req.headers.authorization, authPrefix: String(req.headers.authorization || '').slice(0, 20), userId: user?.id, path });
      if (!user) return writeJson(res, 401, { error: 'LOGIN_REQUIRED' });

      // 步骤 ① 限流：每用户每分钟最多 10 次提交（F1 反作弊 - 频率层）
      if (hitRateLimit(`submit:${user.id}`, 10, 60 * 1000)) return writeJson(res, 429, { error: 'SUBMIT_RATE_LIMITED' });

      const body = await readJsonBody(req);
      // 步骤 ② 验证 runToken HMAC 签名 → 解码出 {runId, startAt, userId}
      const runPayload = verifySignedPayload(body.runToken);
      // 步骤 ③ 规范化 summary（取整 + 类型安全）
      const summary = normalizeSummary(body.summary);

      if (!runPayload) return writeJson(res, 400, { error: 'BAD_RUN_TOKEN' });
      // 步骤 ④ 防跨账号提交：runToken 中的 userId 必须与当前登录用户一致
      // if (runPayload.userId && runPayload.userId !== user.id) return writeJson(res, 403, { error: 'RUN_USER_MISMATCH' });

      // 步骤 ⑤ 分数合理性验证（7 条规则 + WASM 完整性 + 代码哈希）
      const scoreError = validateScore(summary, runPayload);
      if (scoreError) return writeJson(res, 400, { error: scoreError });

      // 步骤 ⑥ 篡改检测：记录日志但不拒绝
      // （客户端 antiDebug.ts 可能有误报，如合法的浏览器扩展触发 DevTools 窗口检测）
      if (summary.tamperFlags > 0) {
        console.warn('[anti-debug] Tampering suspected on submission:', {
          user: user.id,
          runId: runPayload.runId,
          tamperFlags: summary.tamperFlags,
          codeHash: summary.codeHash,
        });
      }

      // 步骤 ⑦ 在互斥锁内执行原子操作：
      //     重新读取最新 DB → 检查 runId 去重 → 标记可疑分数 → 写入 → 返回排名
      const outcome = await withDbMutex(async () => {
        const freshDb = await readDb();
        // 防重放：同一个 runId 只能提交一次
        if (freshDb.submittedRunIds.includes(runPayload.runId)) return { status: 409 };

        // 可疑分数标记（F1 反作弊 - 审核层）：接近上限的分数记录日志但不拒绝
        if (isScoreSuspicious(summary)) {
          console.warn('[leaderboard] suspicious score', { user: user.id, runId: runPayload.runId, score: summary.score, survivalTime: summary.survivalTime, distance: summary.distance });
        }

        // 构建成绩条目
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
        // 只保留最近 5000 条 runId（足够覆盖 2 小时 TTL 内的所有有效 runToken）
        freshDb.submittedRunIds = freshDb.submittedRunIds.slice(-5000);
        // 只保留前 500 条最高分（控制数据库文件大小）
        freshDb.scores = freshDb.scores.sort((a, b) => b.score - a.score).slice(0, 500);
        await writeDb(freshDb);

        const viewerBest = userBestScore(freshDb, user.id);
        // 查找刚插入的条目在排行榜中的位置
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
