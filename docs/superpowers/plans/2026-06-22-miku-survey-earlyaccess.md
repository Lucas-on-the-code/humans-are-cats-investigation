# Miku 问卷 + 内测邮箱征集 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在玩家死亡结算页向"试过 Miku AI"的玩家弹多步问卷（画像/痛点/新作意愿/流失归因），末尾征集邮箱，服务端按 Miku 会话数隐藏排序内测资格。

**Architecture:** 后端 better-sqlite3 加两表（`miku_usage` / `survey_responses`），`/api/miku-chat/end` 追加会话计数钩子，新增 `POST /api/survey` 收问卷+邮箱；前端新建 `SurveyPopup` 组件挂到 `App.tsx` 的死亡结算 overlay，`onGameOver` 时按 localStorage dismiss flag + sessionCount 判定弹出。

**Tech Stack:** React 19 + TS 5.8 + Vite 6 + Tailwind 3（前端）；Node `http` + better-sqlite3（后端，零框架）。

**测试约定（重要）**：项目**无测试框架/CI**（见 CLAUDE.md）。本计划用**手动验证**替代自动测试 —— 每步给出具体命令（`curl` / `sqlite3` / 浏览器操作）和**预期输出**，对应 spec 第 12 节。`.ts` 改动用 `npm run build` 做类型检查。

**对 spec 的实现微调（已确认合理）**：
- `survey_responses` 表用 `scopeKey` 作 PRIMARY KEY（spec 写的是独立 `id`；同设备一行，UPSERT 天然，去掉冗余 id 字段）。
- `getSessionUser` 当前未 export（`server/auth-leaderboard.mjs:214`），计划中改为 export 供 `/end` 钩子复用。

---

## File Structure

**新建**
- `components/SurveyPopup.tsx` — 问卷向导组件（状态机 + UI + 提交逻辑）

**修改**
- `server/auth-leaderboard.mjs` — 加两表 schema、prepared statements、`export getSessionUser`、`handleSurveyRequest`
- `server/deepseek-miku.mjs` — `handleMikuChatEndRequest` 末尾加会话计数钩子
- `server.mjs` — 加 `/api/survey` 路由（prod）
- `vite.config.ts` — 加 `/api/survey` 中间件（dev）
- `utils/mikuMemory.ts` — export `getMikuGuestId`
- `App.tsx` — `finalizeMikuChatMemory` 带 guestId；`onGameOver` 触发判定；渲染 `SurveyPopup`
- `i18n/locales/zh.ts` + `i18n/locales/en.ts` — 加 `survey.*` 命名空间

---

## Task 1: 后端 schema + prepared statements + export getSessionUser

**Files:**
- Modify: `server/auth-leaderboard.mjs`（`db.exec` schema 块 ~28-74；`stmt` 对象 ~117-146；`getSessionUser` 定义 ~214）

- [ ] **Step 1: 加两张表到 `db.exec`**

在 `server/auth-leaderboard.mjs` 的 `db.exec(` 模板字符串里，`miku_memories` 表定义**之后**追加：

```sql
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
```

- [ ] **Step 2: 加 prepared statements 到 `stmt` 对象**

在 `stmt` 对象（`const stmt = { ... };`）的 `upsertMikuMemory` 之后、闭合 `};` 之前追加：

```js
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
  findSurveyByEmail: db.prepare('SELECT scopeKey FROM survey_responses WHERE email = ? LIMIT 1`),
```

- [ ] **Step 3: export `getSessionUser`**

把 `server/auth-leaderboard.mjs:214` 的：
```js
const getSessionUser = (req) => {
```
改成：
```js
export const getSessionUser = (req) => {
```

- [ ] **Step 4: 验证表创建**

起 dev server（后台），用 sqlite3 查 schema：
```bash
GAME_SERVER_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm run dev &
sleep 4
sqlite3 data/game-auth-db.sqlite ".schema miku_usage"
sqlite3 data/game-auth-db.sqlite ".schema survey_responses"
```
Expected: 两张表的 CREATE 语句都打印出来，含上述所有字段。

杀掉 dev server：`kill %1`（或对应 PID）。

- [ ] **Step 5: Commit**

```bash
git add server/auth-leaderboard.mjs
git commit -m "feat(survey): 加 miku_usage/survey_responses 表与计数 prepared statements

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: handleSurveyRequest handler + 路由双入口

**Files:**
- Modify: `server/auth-leaderboard.mjs`（新增 handler，放 `handleLeaderboardRequest` 附近）
- Modify: `server.mjs:7`（import）、`server.mjs`（路由分发 ~36-68）
- Modify: `vite.config.ts:4`（import）、`vite.config.ts`（中间件 ~19-46）

- [ ] **Step 1: 加 `handleSurveyRequest` 到 `server/auth-leaderboard.mjs`**

在 `handleLeaderboardRequest` 定义**之前**（或 `handleRunStartRequest` 之后）追加。复用现有 `cleanText`、`readJsonBody`、`writeJson`、`getIp`、`hashIp`、`hitRateLimit`、`getSessionUser`、`stmt`：

```js
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SURVEY_Q3_VALUES = ['yes', 'maybe', 'nah'];

const sanitizeSurveyMulti = (value) => JSON.stringify(
  Array.isArray(value)
    ? value.filter((x) => typeof x === 'string').slice(0, 20).map((s) => cleanText(s, 60)).filter(Boolean)
    : []
);

export const handleSurveyRequest = async (req, res) => {
  if (req.method !== 'POST') return writeJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    const ipHash = hashIp(getIp(req));
    if (hitRateLimit(`survey:${ipHash}`, 10, 60 * 1000)) {
      return writeJson(res, 429, { error: 'RATE_LIMITED' });
    }

    const body = await readJsonBody(req);

    // 登录用户优先（只读 session，不强制登录）；否则用 guestId
    const { user } = getSessionUser(req);
    const userId = user?.id || cleanText(body.userId, 80) || null;
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
        const answers = buildSurveyAnswers(body, scopeKey, userId, guestId, null, ipHash);
        stmt.upsertSurvey.run(answers);
        return writeJson(res, 200, { ok: false, error: 'EMAIL_ALREADY_REGISTERED' });
      }
    }

    const reachedEmail = body.reachedEmail ? 1 : 0;
    const answers = buildSurveyAnswers(body, scopeKey, userId, guestId, email, ipHash, reachedEmail);
    stmt.upsertSurvey.run(answers);

    return writeJson(res, 200, { ok: true });
  } catch (error) {
    console.error('[auth] survey error', error);
    return writeJson(res, 500, { error: 'INTERNAL_ERROR' });
  }
};

// 放在 handleSurveyRequest 之前定义（hoisting：function 声明可前置；若是 const 箭头函数，确保定义顺序在前）
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
```

> 注：`buildSurveyAnswers` 用 `function` 声明（hoisting），放在 `handleSurveyRequest` 之前或之后均可，但为可读性放在它**之前**。

- [ ] **Step 2: 接 prod 路由 `server.mjs`**

`server.mjs:7` 的 import 行：
```js
import { handleAuthRequest, handleLeaderboardRequest, handleMikuMemoryRequest, handleRunStartRequest } from './server/auth-leaderboard.mjs';
```
改为：
```js
import { handleAuthRequest, handleLeaderboardRequest, handleMikuMemoryRequest, handleRunStartRequest, handleSurveyRequest } from './server/auth-leaderboard.mjs';
```

在 `server.mjs` 的 `createServer` 回调里，`/api/leaderboard` 分支**之前**追加：
```js
  if (req.url?.startsWith('/api/survey')) {
    await handleSurveyRequest(req, res);
    return;
  }
```

- [ ] **Step 3: 接 dev 路由 `vite.config.ts`**

`vite.config.ts:4` 的 import 行：
```js
import { handleAuthRequest, handleLeaderboardRequest, handleMikuMemoryRequest, handleRunStartRequest } from './server/auth-leaderboard.mjs';
```
改为：
```js
import { handleAuthRequest, handleLeaderboardRequest, handleMikuMemoryRequest, handleRunStartRequest, handleSurveyRequest } from './server/auth-leaderboard.mjs';
```

在 `configureServer` 里 `/api/leaderboard` 中间件**之前**追加：
```js
            server.middlewares.use('/api/survey', (req, res) => {
              void handleSurveyRequest(req, res);
            });
```

- [ ] **Step 4: 验证 dev 端 `POST /api/survey`**

起 dev server（需 `GAME_SERVER_SECRET`，见 Task 1 Step 4）。提交一份完整问卷：
```bash
curl -s -X POST http://localhost:3000/api/survey \
  -H 'Content-Type: application/json' \
  -d '{"guestId":"test-guest-123","q1":"玩过AI角色扮演的电子游戏","q2":["角色记不住人设","AI味太浓，容易出戏"],"q3":"yes","email":"tester@example.com","reachedEmail":true}'
```
Expected: `{"ok":true}`

查库：
```bash
sqlite3 data/game-auth-db.sqlite "SELECT scopeKey, q1, q3, email, reachedEmail, usageSnapshot, completedAt FROM survey_responses;"
```
Expected: 一行，`scopeKey=g:test-guest-123`，`q3=yes`，`email=tester@example.com`，`reachedEmail=1`，`usageSnapshot=0`（因为还没聊过 miku），`completedAt` 非 NULL。

- [ ] **Step 5: 验证邮箱校验 + 跨设备去重**

非法邮箱：
```bash
curl -s -X POST http://localhost:3000/api/survey -H 'Content-Type: application/json' \
  -d '{"guestId":"g2","email":"not-an-email","reachedEmail":true}'
```
Expected: `{"ok":false,"error":"EMAIL_INVALID"}`

跨设备重复邮箱：
```bash
curl -s -X POST http://localhost:3000/api/survey -H 'Content-Type: application/json' \
  -d '{"guestId":"another-device","q1":"我没接触过AI角色扮演","q3":"nah","email":"tester@example.com","reachedEmail":true}'
```
Expected: `{"ok":false,"error":"EMAIL_ALREADY_REGISTERED"}`
再查库确认第二行的 `email` 字段为 NULL（没覆盖），但 q1/q3 答案已存。

清理测试数据：
```bash
sqlite3 data/game-auth-db.sqlite "DELETE FROM survey_responses WHERE guestId IN ('test-guest-123','g2','another-device');"
```
杀 dev server。

- [ ] **Step 6: Commit**

```bash
git add server/auth-leaderboard.mjs server.mjs vite.config.ts
git commit -m "feat(survey): POST /api/survey handler + dev/prod 路由双入口

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: `/api/miku-chat/end` 会话计数钩子

**Files:**
- Modify: `server/deepseek-miku.mjs`（顶部 import；`handleMikuChatEndRequest` 末尾 ~728）

- [ ] **Step 1: import 计数 helper**

`server/deepseek-miku.mjs` 顶部 import 区追加（与现有 import 同处；注意无循环依赖：`auth-leaderboard.mjs` 不 import 本文件）：
```js
import { getSessionUser, stmt } from './auth-leaderboard.mjs';
```

- [ ] **Step 2: 在 `handleMikuChatEndRequest` 成功响应前加计数**

在 `handleMikuChatEndRequest` 里，`writeJson(res, 200, { topicMemory, knowledgeMemory, nextGreeting })` 这行**之前**插入：
```js
    // 会话计数（方案2：取客户端上报 sessionCount 的 max，不信任但用于隐藏资格排序）
    try {
      const { user } = getSessionUser(req);
      const userId = user?.id || null;
      const guestId = !userId ? cleanText(body.guestId, 120) : null;
      const scopeKey = userId ? `u:${userId}` : (guestId ? `g:${guestId}` : null);
      const reportedSessionCount = Math.max(0, Number(body.sessionCount) || 0);
      if (scopeKey && reportedSessionCount > 0) {
        const now = Date.now();
        stmt.upsertMikuUsage.run(scopeKey, reportedSessionCount, now, now);
      }
    } catch (countError) {
      console.error('[miku] usage count failed', countError);
      // 静默：不影响 miku 聊天主流程
    }
```

> 注：`body` 在该 handler 已通过 `readJsonBody(req)` 读出（见现有代码 `const body = await readJsonBody(req);`）。`cleanText` 在本文件已定义（sanitizeText 是别名/同义 helper —— 若 `cleanText` 未定义则改用 `sanitizeText`：先 `grep -n "cleanText\|sanitizeText" server/deepseek-miku.mjs` 确认存在的那个名字，用之）。

- [ ] **Step 3: 验证计数落库**

起 dev server。模拟一次 miku 会话结束（不需要真实 LLM 往返也能触发计数，因为计数在响应前；但 `/end` 会先调 DeepSeek 抽记忆。为隔离验证计数，可临时 mock 或直接测真实流程）。

最简验证（真实流程）：浏览器打开游戏 → 找 Miku NPC 聊一句 → 结束对话（或死亡触发 finalize）→ DevTools Network 找 `/api/miku-chat/end` 请求，确认其 request body 含 `guestId`（Task 6 会加，此刻可能还没有 —— 若没有，本步用 curl 直发）。

curl 直发（绕过 LLM 会触发 DeepSeek，需 `DEEPSEEK_API_KEY`；若无 key，跳过本步的 curl，改用 Task 6 后的真实浏览器验证）：
```bash
curl -s -X POST http://localhost:3000/api/miku-chat/end \
  -H 'Content-Type: application/json' \
  -d '{"guestId":"count-test","sessionCount":3,"messages":[{"role":"user","content":"嗨"}]}'
```
查库：
```bash
sqlite3 data/game-auth-db.sqlite "SELECT scopeKey, sessionCount FROM miku_usage WHERE scopeKey='g:count-test';"
```
Expected: `g:count-test|3`

再发一次 `sessionCount:5`，查库 Expected sessionCount=5（max 不回退）。再发 `sessionCount:2`，查库 Expected 仍为 5。

清理：`sqlite3 data/game-auth-db.sqlite "DELETE FROM miku_usage WHERE scopeKey='g:count-test';"`

- [ ] **Step 4: Commit**

```bash
git add server/deepseek-miku.mjs
git commit -m "feat(survey): /api/miku-chat/end 追加会话计数钩子(信任客户端 max)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: i18n `survey.*` 文案（中英）

**Files:**
- Modify: `i18n/locales/zh.ts` + `i18n/locales/en.ts`

- [ ] **Step 1: zh.ts 加 survey 命名空间**

在 `i18n/locales/zh.ts` 的 `'gameover.playAgain': '再玩一次',` 行之后追加：
```js
  // survey
  'survey.lead': '谢谢你陪我聊这么久！真的很开心～',
  'survey.leadSub': '我有几个小问题想问下你：',
  'survey.q1.label': '你熟悉AI角色扮演吗？',
  'survey.q1.opt1': '玩过AI角色扮演的电子游戏',
  'survey.q1.opt2': '我是酒馆（SillyTavern）/星野/猫箱/Glow用户',
  'survey.q1.opt3': '我直接用DeepSeek等AI玩角色扮演',
  'survey.q1.opt4': '我没接触过AI角色扮演',
  'survey.q2.label': '你觉得AI角色扮演最大的问题是？（多选）',
  'survey.q2.opt1': '角色记不住人设',
  'survey.q2.opt2': '没有动力/目标感',
  'survey.q2.opt3': '纯文字沉浸感不足',
  'survey.q2.opt4': '剧情节奏不稳定',
  'survey.q2.opt5': '剧情前后逻辑矛盾',
  'survey.q2.opt6': '埋一堆伏笔不回收',
  'survey.q2.opt7': 'AI幻觉胡编乱造',
  'survey.q2.opt8': '过度迎合用户',
  'survey.q2.opt9': '情节老套，太好猜',
  'survey.q2.opt10': 'AI味太浓，容易出戏',
  'survey.q2.other': '其他',
  'survey.q2.otherPh': '说说你的看法',
  'survey.q3.body': '偷偷说，我背后那群人在策划新的游戏～\n想做一款AI 边写边演的视觉小说，有精美的演出，会随着情节变CG和音乐氛围。剧情虽然是 AI 现场生成的，但我们人工分析了海量视觉小说的剧情节奏，教会AI顺着上下文决定情绪起伏。\n要不要来当第一批玩的人？',
  'survey.q3.yes': '要！想多了解',
  'survey.q3.maybe': '看看吧',
  'survey.q3.nah': '算了',
  'survey.q4.label': '不感兴趣的原因：（多选）',
  'survey.q4.opt1': '我不玩AI角色扮演',
  'survey.q4.opt2': '我不玩视觉小说/galgame/乙游',
  'survey.q4.opt3': '这不就是酒馆吗',
  'survey.q4.opt4': '我自己用AI就能玩，不需要游戏',
  'survey.q4.opt5': '我不相信你画的饼',
  'survey.q4.opt6': '担心很烧钱，游戏会很贵',
  'survey.q4.opt7': '我讨厌AI',
  'survey.q4.other': '其他',
  'survey.q4.otherPh': '说说为什么',
  'survey.end.willing': '感谢你的反馈！如果未来想要听到更多关于新作的消息，可以在这里留下邮箱，有机会获得内测资格！',
  'survey.end.pass': '感谢你的反馈！你的回答对我们的帮助很大。要是哪天改观了，也欢迎留个邮箱看看成品',
  'survey.privacy': '邮箱收集仅为通知内测目的，我们会保障您的隐私',
  'survey.emailPh': '邮箱地址',
  'survey.cta': '拿到内测资格',
  'survey.next': '下一题',
  'survey.back': '上一题',
  'survey.skip': '跳过邮箱',
  'survey.submitting': '提交中…',
  'survey.status.success': '嗯！记下了，新故事好了我去找你。',
  'survey.status.registered': '这个邮箱你留过啦，内测见。',
  'survey.status.invalidEmail': '邮箱好像不太对哦。',
  'survey.status.networkError': '唔，网络开了点小差，再试一次？',
  'survey.aria.progress': '第 {n}/{total} 题',
```

- [ ] **Step 2: en.ts 加 survey 命名空间**

在 `i18n/locales/en.ts` 的 `'gameover.playAgain': 'Run Again',` 行之后追加（英文，无 em dash）：
```js
  // survey
  'survey.lead': 'Thanks for chatting with me this long! I\'m really happy~',
  'survey.leadSub': 'I have a few little questions for you:',
  'survey.q1.label': 'How familiar are you with AI roleplay?',
  'survey.q1.opt1': 'I\'ve played AI roleplay games',
  'survey.q1.opt2': 'I use SillyTavern / Xingye / Maoxiang / Glow',
  'survey.q1.opt3': 'I roleplay directly with AI like DeepSeek',
  'survey.q1.opt4': 'I\'ve never tried AI roleplay',
  'survey.q2.label': 'What\'s the biggest problem with AI roleplay? (pick all that apply)',
  'survey.q2.opt1': 'Characters forget who they are',
  'survey.q2.opt2': 'No drive or sense of goal',
  'survey.q2.opt3': 'Pure text isn\'t immersive enough',
  'survey.q2.opt4': 'Pacing is unstable',
  'survey.q2.opt5': 'Plot contradicts itself',
  'survey.q2.opt6': 'Sets up threads it never pays off',
  'survey.q2.opt7': 'AI hallucinates and makes things up',
  'survey.q2.opt8': 'Too eager to please the user',
  'survey.q2.opt9': 'Plots feel generic and predictable',
  'survey.q2.opt10': 'Too obviously AI, breaks immersion',
  'survey.q2.other': 'Other',
  'survey.q2.otherPh': 'Tell us what',
  'survey.q3.body': 'Between us, the team behind me is cooking up a new game~\nA visual novel written and performed by AI in real time, with gorgeous presentation that shifts the CG and music to match each scene. The story is generated live, but we hand-analyzed a massive pile of visual novels to teach the AI how to shape the emotional flow moment to moment.\nWant in on the first wave?',
  'survey.q3.yes': 'Yes! Tell me more',
  'survey.q3.maybe': 'Maybe, show me',
  'survey.q3.nah': 'Nah, pass',
  'survey.q4.label': 'What\'s turning you off? (pick all that apply)',
  'survey.q4.opt1': 'I don\'t play AI roleplay',
  'survey.q4.opt2': 'I don\'t play visual novels / galgame / otome games',
  'survey.q4.opt3': 'Isn\'t this just SillyTavern?',
  'survey.q4.opt4': 'I can roleplay with AI myself, don\'t need a game',
  'survey.q4.opt5': 'I don\'t buy the pitch',
  'survey.q4.opt6': 'Worried it\'ll burn cash and the game will be pricey',
  'survey.q4.opt7': 'I hate AI',
  'survey.q4.other': 'Other',
  'survey.q4.otherPh': 'Tell us why',
  'survey.end.willing': 'Thanks for the feedback! If you want to hear more about the new game later, leave your email here for a shot at the beta!',
  'survey.end.pass': 'Thanks for the feedback, it really helps us. If you ever change your mind, feel free to leave an email and see how it turns out.',
  'survey.privacy': 'Email is collected only to notify you about the beta. Your privacy is safe with us.',
  'survey.emailPh': 'email',
  'survey.cta': 'Get beta access',
  'survey.next': 'Next',
  'survey.back': 'Back',
  'survey.skip': 'Skip email',
  'survey.submitting': 'Submitting…',
  'survey.status.success': 'Mm! Got it. I\'ll find you when it\'s ready.',
  'survey.status.registered': 'You\'ve already left this one. See you in the beta.',
  'survey.status.invalidEmail': 'That email doesn\'t look right.',
  'survey.status.networkError': 'Hmm, the connection tripped. Try again?',
  'survey.aria.progress': 'Question {n} of {total}',
```

- [ ] **Step 3: 验证 key 数量一致 + build 过**

```bash
grep -c "'survey\." i18n/locales/zh.ts
grep -c "'survey\." i18n/locales/en.ts
npm run build
```
Expected: 两个 grep 计数相等；`npm run build` 成功无类型错误。

- [ ] **Step 4: Commit**

```bash
git add i18n/locales/zh.ts i18n/locales/en.ts
git commit -m "feat(survey): i18n survey.* 文案中英双语

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: export `getMikuGuestId`

**Files:**
- Modify: `utils/mikuMemory.ts`（`getOrCreateGuestMemoryScope` 定义 ~135 之后）

- [ ] **Step 1: 加 export 函数**

在 `utils/mikuMemory.ts` 的 `getOrCreateGuestMemoryScope` 函数定义**之后**追加：
```ts
/**
 * 返回当前设备的 Miku guest id（纯 uuid）。
 * 登录用户改用 authUser.id；此函数仅给未登录的 /end 计数与 /survey 上报用。
 */
export const getMikuGuestId = (): string => {
  const scope = getOrCreateGuestMemoryScope(); // 'guest:<uuid>' 或 fallback 'guest'
  return scope.startsWith('guest:') ? scope.slice('guest:'.length) : scope;
};
```

- [ ] **Step 2: 验证 build**

```bash
npm run build
```
Expected: 成功。

- [ ] **Step 3: Commit**

```bash
git add utils/mikuMemory.ts
git commit -m "feat(survey): export getMikuGuestId 供计数/问卷上报

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: `finalizeMikuChatMemory` 带 guestId 上报

**Files:**
- Modify: `App.tsx`（`finalizeMikuChatMemory` ~1488-1510；import 区）

- [ ] **Step 1: import getMikuGuestId**

在 `App.tsx` 顶部 import `./utils/mikuMemory` 的现有 import 语句里追加 `getMikuGuestId`（先 `grep -n "from './utils/mikuMemory'" App.tsx` 找到该 import 行，把 `getMikuGuestId` 加进具名导入列表）。

- [ ] **Step 2: `/end` body 加 guestId**

`App.tsx` 的 `finalizeMikuChatMemory` 里，`fetch('/api/miku-chat/end', {...})` 的 `body: JSON.stringify({ ...prepared.request, locale })` 改成：
```ts
      body: JSON.stringify({ ...prepared.request, guestId: getMikuGuestId(), locale }),
```

- [ ] **Step 3: 验证**

起 dev server，浏览器玩到能和 Miku NPC 对话，发一条消息后结束对话或死亡。DevTools → Network → 找 `miku-chat/end` 请求 → Payload 应含 `guestId` 字段（一串 uuid）和 `sessionCount`。

服务端查库验证计数落库：
```bash
sqlite3 data/game-auth-db.sqlite "SELECT scopeKey, sessionCount FROM miku_usage;"
```
Expected: 出现 `g:<那个 uuid>` 行，sessionCount ≥ 1。

- [ ] **Step 4: Commit**

```bash
git add App.tsx
git commit -m "feat(survey): /end 上报 guestId 以便会话计数

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: SurveyPopup 组件

**Files:**
- Create: `components/SurveyPopup.tsx`

- [ ] **Step 1: 创建组件文件**

写入 `components/SurveyPopup.tsx`：

```tsx
import { useState } from 'react';
import { useI18n } from '../i18n';

type Step = 'q1' | 'q2' | 'q3' | 'q4' | 'emailWilling' | 'emailPass' | 'done';
type Status = 'success' | 'registered' | 'invalidEmail' | 'networkError' | null;

interface Props {
  userId: string | null;
  guestId: string;
  onComplete: () => void;
  onDismiss: () => void;
}

const PROGRESS_STEPS: Step[] = ['q1', 'q2', 'q3'];

export const SurveyPopup = ({ userId, guestId, onComplete, onDismiss }: Props) => {
  const { t, locale } = useI18n();
  const [step, setStep] = useState<Step>('q1');
  const [q1, setQ1] = useState<string | null>(null);
  const [q2, setQ2] = useState<string[]>([]);
  const [q2Other, setQ2Other] = useState('');
  const [q2OtherOn, setQ2OtherOn] = useState(false);
  const [q3, setQ3] = useState<'yes' | 'maybe' | 'nah' | null>(null);
  const [q4, setQ4] = useState<string[]>([]);
  const [q4Other, setQ4Other] = useState('');
  const [q4OtherOn, setQ4OtherOn] = useState(false);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [submitting, setSubmitting] = useState(false);

  const toggleMulti = (arr: string[], setArr: (v: string[]) => void, value: string) => {
    setArr(arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value]);
  };

  const submit = async (override: { reachedEmail: number; completedAt: number | null; email?: string | null }) => {
    setSubmitting(true);
    setStatus(null);
    try {
      const res = await fetch('/api/survey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId, guestId,
          q1, q2, q3, q4,
          q2Other: q2OtherOn ? q2Other : undefined,
          q4Other: q4OtherOn ? q4Other : undefined,
          email: override.email ?? null,
          reachedEmail: override.reachedEmail,
          locale,
        }),
      });
      const data = await res.json().catch(() => ({ ok: false }));
      if (res.ok && data.ok) {
        setStatus('success');
        onComplete();
        return;
      }
      if (data.error === 'EMAIL_INVALID') { setStatus('invalidEmail'); return; }
      if (data.error === 'EMAIL_ALREADY_REGISTERED') { setStatus('registered'); onComplete(); return; }
      setStatus('networkError');
    } catch {
      setStatus('networkError');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    // 中途关闭：有答案则落部分数据
    if (q1 || q2.length || q3 || q4.length) {
      void submit({ reachedEmail: 0, completedAt: null });
    }
    onDismiss();
  };

  const progressIndex = PROGRESS_STEPS.indexOf(step);
  const progressTotal = PROGRESS_STEPS.length;
  const isEmailStep = step === 'emailWilling' || step === 'emailPass';

  return (
    <div className="absolute right-4 top-4 md:right-6 md:top-6 z-50 w-[min(92vw,24rem)] game-panel rounded-lg p-4 text-left max-h-[88vh] overflow-y-auto bottom-4 md:bottom-auto inset-x-4 md:inset-x-auto">
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-1" aria-label={t('survey.aria.progress', { n: Math.max(1, progressIndex + 1), total: progressTotal })}>
          {PROGRESS_STEPS.map((_, i) => (
            <span key={i} className={`w-2 h-2 rounded-full ${i <= progressIndex ? 'bg-cyan-400' : 'bg-slate-600'}`} />
          ))}
        </div>
        <button onClick={handleClose} className="text-slate-400 hover:text-white text-xl leading-none" aria-label="close">×</button>
      </div>

      {step === 'q1' && (
        <div className="space-y-3">
          <p className="text-cyan-100 text-sm whitespace-pre-line">{t('survey.lead') + '\n' + t('survey.leadSub')}</p>
          <p className="text-white font-bold text-sm">{t('survey.q1.label')}</p>
          {[1, 2, 3, 4].map((i) => (
            <button key={i} onClick={() => setQ1(t(`survey.q1.opt${i}`))}
              className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${q1 === t(`survey.q1.opt${i}`) ? 'bg-cyan-500/30 text-cyan-50 ring-1 ring-cyan-400' : 'bg-slate-800/60 text-slate-200 hover:bg-slate-700/60'}`}>
              {t(`survey.q1.opt${i}`)}
            </button>
          ))}
          <div className="flex justify-end gap-2 pt-1">
            <button disabled={!q1 || submitting} onClick={() => setStep('q2')}
              className="px-4 py-2 game-button text-white text-sm rounded-md disabled:opacity-40">{t('survey.next')}</button>
          </div>
        </div>
      )}

      {step === 'q2' && (
        <div className="space-y-2">
          <p className="text-white font-bold text-sm">{t('survey.q2.label')}</p>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
            <label key={i} className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer ${q2.includes(t(`survey.q2.opt${i}`)) ? 'bg-cyan-500/20 ring-1 ring-cyan-400/60' : 'bg-slate-800/60 hover:bg-slate-700/60'}`}>
              <input type="checkbox" checked={q2.includes(t(`survey.q2.opt${i}`))} onChange={() => toggleMulti(q2, setQ2, t(`survey.q2.opt${i}`))} className="accent-cyan-400" />
              <span className="text-slate-200">{t(`survey.q2.opt${i}`)}</span>
            </label>
          ))}
          <label className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer ${q2OtherOn ? 'bg-cyan-500/20 ring-1 ring-cyan-400/60' : 'bg-slate-800/60 hover:bg-slate-700/60'}`}>
            <input type="checkbox" checked={q2OtherOn} onChange={() => setQ2OtherOn(!q2OtherOn)} className="accent-cyan-400" />
            <span className="text-slate-200">{t('survey.q2.other')}</span>
          </label>
          {q2OtherOn && (
            <textarea value={q2Other} onChange={(e) => setQ2Other(e.target.value)} placeholder={t('survey.q2.otherPh')}
              className="w-full bg-slate-900/70 border border-slate-700 rounded-md px-2 py-1 text-sm text-slate-100" rows={2} maxLength={400} />
          )}
          <div className="flex justify-between gap-2 pt-1">
            <button onClick={() => setStep('q1')} className="px-3 py-2 game-button-secondary text-sm rounded-md">{t('survey.back')}</button>
            <button disabled={submitting} onClick={() => setStep('q3')} className="px-4 py-2 game-button text-white text-sm rounded-md disabled:opacity-40">{t('survey.next')}</button>
          </div>
        </div>
      )}

      {step === 'q3' && (
        <div className="space-y-3">
          <p className="text-cyan-50 text-sm whitespace-pre-line leading-relaxed">{t('survey.q3.body')}</p>
          <div className="flex justify-between gap-2 pt-1">
            <button onClick={() => setStep('q2')} className="px-3 py-2 game-button-secondary text-sm rounded-md">{t('survey.back')}</button>
            <div className="flex gap-2">
              <button disabled={submitting} onClick={() => { setQ3('nah'); setStep('q4'); }} className="px-3 py-2 game-button-secondary text-sm rounded-md">{t('survey.q3.nah')}</button>
              <button disabled={submitting} onClick={() => { setQ3('maybe'); setStep('emailWilling'); }} className="px-3 py-2 game-button text-white text-sm rounded-md">{t('survey.q3.maybe')}</button>
              <button disabled={submitting} onClick={() => { setQ3('yes'); setStep('emailWilling'); }} className="px-3 py-2 game-button text-white text-sm rounded-md">{t('survey.q3.yes')}</button>
            </div>
          </div>
        </div>
      )}

      {step === 'q4' && (
        <div className="space-y-2">
          <p className="text-white font-bold text-sm">{t('survey.q4.label')}</p>
          {[1, 2, 3, 4, 5, 6, 7].map((i) => (
            <label key={i} className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer ${q4.includes(t(`survey.q4.opt${i}`)) ? 'bg-cyan-500/20 ring-1 ring-cyan-400/60' : 'bg-slate-800/60 hover:bg-slate-700/60'}`}>
              <input type="checkbox" checked={q4.includes(t(`survey.q4.opt${i}`))} onChange={() => toggleMulti(q4, setQ4, t(`survey.q4.opt${i}`))} className="accent-cyan-400" />
              <span className="text-slate-200">{t(`survey.q4.opt${i}`)}</span>
            </label>
          ))}
          <label className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer ${q4OtherOn ? 'bg-cyan-500/20 ring-1 ring-cyan-400/60' : 'bg-slate-800/60 hover:bg-slate-700/60'}`}>
            <input type="checkbox" checked={q4OtherOn} onChange={() => setQ4OtherOn(!q4OtherOn)} className="accent-cyan-400" />
            <span className="text-slate-200">{t('survey.q4.other')}</span>
          </label>
          {q4OtherOn && (
            <textarea value={q4Other} onChange={(e) => setQ4Other(e.target.value)} placeholder={t('survey.q4.otherPh')}
              className="w-full bg-slate-900/70 border border-slate-700 rounded-md px-2 py-1 text-sm text-slate-100" rows={2} maxLength={400} />
          )}
          <div className="flex justify-between gap-2 pt-1">
            <button onClick={() => setStep('q3')} className="px-3 py-2 game-button-secondary text-sm rounded-md">{t('survey.back')}</button>
            <button disabled={submitting} onClick={() => setStep('emailPass')} className="px-4 py-2 game-button text-white text-sm rounded-md disabled:opacity-40">{t('survey.next')}</button>
          </div>
        </div>
      )}

      {isEmailStep && (
        <div className="space-y-3">
          <p className="text-cyan-50 text-sm whitespace-pre-line">
            {step === 'emailWilling' ? t('survey.end.willing') : t('survey.end.pass')}
          </p>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('survey.emailPh')}
            className="w-full bg-slate-900/70 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100" />
          <p className="text-[10px] text-slate-500">{t('survey.privacy')}</p>
          {status && <p className={`text-xs ${status === 'success' || status === 'registered' ? 'text-cyan-300' : 'text-yellow-300'}`}>{t(`survey.status.${status}`)}</p>}
          <div className="flex justify-between gap-2 pt-1">
            <button onClick={() => setStep(q3 === 'nah' ? 'q4' : 'q3')} className="px-3 py-2 game-button-secondary text-sm rounded-md">{t('survey.back')}</button>
            <div className="flex gap-2">
              <button disabled={submitting} onClick={() => { void submit({ reachedEmail: 1, completedAt: Date.now(), email: null }); }} className="px-3 py-2 game-button-secondary text-sm rounded-md">{t('survey.skip')}</button>
              <button disabled={submitting || !email.trim()} onClick={() => { void submit({ reachedEmail: 1, completedAt: Date.now(), email: email.trim() }); }} className="px-4 py-2 game-button text-white text-sm rounded-md disabled:opacity-40">{submitting ? t('survey.submitting') : t('survey.cta')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: 验证 build**

```bash
npm run build
```
Expected: 成功无类型错误。

- [ ] **Step 3: Commit**

```bash
git add components/SurveyPopup.tsx
git commit -m "feat(survey): SurveyPopup 多步问卷向导组件

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: App.tsx 集成（触发判定 + 挂载 + dismiss）

**Files:**
- Modify: `App.tsx`（import 区；state 声明区 ~1164；`onGameOver` ~1895；`isGameOver` overlay ~1916）

- [ ] **Step 1: import SurveyPopup + loadMikuMemory**

`App.tsx` 顶部加：
```ts
import { SurveyPopup } from './components/SurveyPopup';
```
在 `./utils/mikuMemory` 的现有 import 里追加 `loadMikuMemory`、`mikuMemoryScopeForAccount`（若未导入）。

- [ ] **Step 2: 加 state**

在 `App.tsx` 的 `const [isGameOver, setIsGameOver] = useState(false);`（~1164）附近加：
```ts
  const [showSurvey, setShowSurvey] = useState(false);
```

- [ ] **Step 3: `onGameOver` 里加触发判定**

找到 `onGameOver={(summary) => { ... setIsGameOver(true); setIntroComplete(true); }}`（~1895）。在 `setIsGameOver(true);` **之前**插入触发判定：
```ts
            // 问卷触发判定：试过 miku（sessionCount>=1）且本设备未 dismiss
            try {
              const dismissed = localStorage.getItem('hac_survey_dismissed');
              const scope = mikuMemoryScopeForAccount(authUser?.id);
              const mem = loadMikuMemory(scope);
              if (!dismissed && mem.sessionCount >= 1) {
                setShowSurvey(true);
              }
            } catch { /* localStorage 不可用（隐私模式）→ 不弹 */ }
```

- [ ] **Step 4: 在 overlay 容器内渲染 SurveyPopup**

找到 `isGameOver ? (` 后的那个 `<div className="... max-w-4xl">`（~1916），在其**闭合 `</div>` 之前**（"再玩一次"按钮之后）追加：
```tsx
                 {showSurvey && (
                   <SurveyPopup
                     userId={authUser?.id ?? null}
                     guestId={getMikuGuestId()}
                     onComplete={() => { try { localStorage.setItem('hac_survey_dismissed', '1'); } catch { /* ignore */ } setShowSurvey(false); }}
                     onDismiss={() => { try { localStorage.setItem('hac_survey_dismissed', '1'); } catch { /* ignore */ } setShowSurvey(false); }}
                   />
                 )}
```

> 注：`getMikuGuestId` 已在 Task 6 import。`authUser` 是 App.tsx 现有登录态。

- [ ] **Step 5: 验证 build**

```bash
npm run build
```
Expected: 成功。

- [ ] **Step 6: Commit**

```bash
git add App.tsx
git commit -m "feat(survey): 死亡结算页挂载 SurveyPopup + 触发判定

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: 完整手动验证清单（spec 第 12 节）

**Files:** 无改动，纯验证。起 dev server 后逐条执行。

- [ ] **Step 1: 基础触发（guest 试聊 → 死亡 → 弹出）**
浏览器开无痕窗口（保证 guest + 无 dismiss flag）→ 玩到和 Miku NPC 对话至少一轮并结束 → 故意死亡 → Expected: 结算页右侧出现问卷卡片。

- [ ] **Step 2: 高意愿路径**
Q1 任选 → Q2 多选几项 → Q3 选「要！想多了解」→ 进 Q5 填 `me@test.com` 提交 → Expected: 显示 success 文案，卡片关闭。
查库：
```bash
sqlite3 data/game-auth-db.sqlite "SELECT q1,q3,email,reachedEmail,usageSnapshot,completedAt FROM survey_responses WHERE email='me@test.com';"
```
Expected: q3=yes, email=me@test.com, reachedEmail=1, usageSnapshot≥1, completedAt 非 NULL。

- [ ] **Step 3: 流失路径**
新无痕窗口 → 试聊 → 死亡 → Q3 选「算了」→ Q4 多选 → Q6 不填邮箱点「跳过邮箱」→ Expected: 卡片关闭。
查库该 scopeKey 行 email=NULL, reachedEmail=1, completedAt 非 NULL, q4 含所选项。

- [ ] **Step 4: 中途关闭**
新无痕 → 试聊 → 死亡 → Q1 选一项 → 点 ✕ → Expected: 卡片消失。
查库该 scopeKey 行 completedAt=NULL, reachedEmail=0, q1 有值。
再死亡 → Expected: 不再弹（dismiss flag 已写）。

- [ ] **Step 5: 未试过 miku 不弹**
新无痕 → 直接玩，**不**和 Miku 对话 → 死亡 → Expected: 不弹问卷。

- [ ] **Step 6: 邮箱去重**
用 Step 2 的 `me@test.com`，换无痕窗口（新 guestId）走流程提交同邮箱 → Expected: 显示 registered 文案。
查库：第二个 scopeKey 行 email=NULL（没覆盖），q1/q2 答案已存。

- [ ] **Step 7: 邮箱格式错**
Q5 填 `abc` 提交 → Expected: invalidEmail 文案，不关闭卡片，可改。

- [ ] **Step 8: 计数 max 不回退**
同一 guest 多轮聊 miku 后查 miku_usage.sessionCount，应只增不减（取客户端上报 max）。

- [ ] **Step 9: 中英文切换**
结算页右上角 中/EN 切换 → Expected: 问卷文案随之切换。

- [ ] **Step 10: 移动端布局**
DevTools 切窄屏（≤640px）→ Expected: 问卷变底部抽屉式（`bottom-0 inset-x-0`），不挡结算上半部分。

- [ ] **Step 11: 隐私模式降级**
浏览器开隐私/禁用 localStorage → 试聊 → 死亡 → Expected: 不弹、不报错。

- [ ] **Step 12: prod 路由**
`npm run build` 后用 `GAME_SERVER_SECRET=<32+字符> npm run serve` 起 prod → curl `POST /api/survey` → Expected: `{"ok":true}`，与 dev 一致。

- [ ] **Step 13: 清理验证数据**
```bash
sqlite3 data/game-auth-db.sqlite "DELETE FROM survey_responses WHERE email LIKE '%test%' OR guestId LIKE '%test%';"
```

- [ ] **Step 14: 收尾 commit（如有验证中发现的 hotfix）**

```bash
git add -A
git commit -m "fix(survey): 手动验证 hotfix

Co-Authored-By: Claude <noreply@anthropic.com>"
```
（无 hotfix 则跳过。）

---

## Self-Review（对照 spec）

- **Spec 覆盖**：spec §3 触发与展示 → Task 8；§4 数据模型 → Task 1；§5 状态机 → Task 7；§6 文案 → Task 4；§7 后端 API → Task 1/2/3；§8 前端组件 → Task 5/6/7/8；§9 隐藏排序 → Task 1（usageSnapshot）+ Task 2（写入）；§10 错误边界 → Task 2/7/8；§11 YAGNI → 未实现（符合）；§12 验证 → Task 9。无遗漏。
- **类型/命名一致**：`scopeKey`（`u:`/`g:`）、`getMikuGuestId`、`handleSurveyRequest`、`stmt.upsertMikuUsage/upsertSurvey/getMikuUsage/findSurveyByEmail`、`survey.*` key 在各 task 间一致。
- **占位符**：无 TBD/TODO；每步含完整代码或具体验证命令。
