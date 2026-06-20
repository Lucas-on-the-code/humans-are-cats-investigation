# 架构体检报告 — Humans are Cats: Investigation

> 生成时间：2026-06-19
> 工具：CodeGraph（585 节点 / 567 边）+ ast-grep + LSP + 逐文件复核
> 项目状态：单 commit "Initial game project import"，git 干净，未安装未构建未跑过

---

## 0. 一句话定性

**一个从 Google AI Studio fork 下来的 VOCALOID 主题横版潜行游戏。源项目用 Gemini，本副本本地化为 DeepSeek + bilibili VOCALOID 热曲库 + 中文 P 主别名库，接入了相当认真的 PoW 防作弊 + HMAC session 后端。代码卫生出乎意料地好（零 TODO/FIXME/eval/dangerouslySetInnerHTML），主要债是两个巨石文件和文档不一致。**

技术栈：React 19 + TS 5.8 + Vite 6 + Tailwind 3，纯原生 Canvas 2D 渲染（无 Phaser/Pixi），后端纯 Node `http`（零框架）。

---

## 1. 严重度分级

### 🔴 Critical（上线前必须修）

#### C1. SECRET 回退随机，重启即会话全失效
- **位置**：`server/auth-leaderboard.mjs:10`
- **现状**：`const SECRET = process.env.GAME_SERVER_SECRET || randomBytes(32).toString('hex');`
- **后果**：未设环境变量时，进程每次重启 SECRET 重新随机 → 所有已签发 session 失效 + 所有 runToken 失效 + 排行榜提交全部 BAD_RUN_TOKEN。生产环境静默故障。
- **影响面**：4 个符号（auth-leaderboard.mjs 的 signPayload/verifySignedPayload，server.mjs，vite.config.ts）
- **修复**：部署时强制注入 `GAME_SERVER_SECRET`；启动时检测未设则拒绝 boot（fail-loud 而非 fail-silent）。

#### C2. getIp 信任 X-Forwarded-For，无反代时可绕过限流
- **位置**：`server/auth-leaderboard.mjs:51-54`
- **现状**：直接读 `req.headers['x-forwarded-for']`，取第一个值。
- **后果**：直连部署时，攻击者伪造 `X-Forwarded-For: <随机IP>` 即可绕过 register/challenge 的 IP 限流（5次/小时、60次/10分钟），还能让 PoW challenge 绑定到伪造 IP。
- **修复**：确认始终部署在 nginx/Caddy 后；或在反代层 strip + 重设该 header；或加 `TRUSTED_PROXY_HOPS` 配置。

#### C3. 三方文档不一致，误导新人
- **README.md** 说 "set the GEMINI_API_KEY"，还挂着 `ai.studio/apps/drive/...` 链接
- **.env.example** 写的是 `DEEPSEEK_API_KEY` + `DEEPSEEK_MODEL=deepseek-v4-flash` + `DEEPSEEK_BASE_URL`
- **metadata.json** 描述还提 "based on Luo Tianyi's music video"
- **实际后端**：用 DeepSeek（`server/deepseek-miku.mjs`）
- **修复**：重写 README（去掉 Gemini 和 AI Studio 痕迹），明确 DeepSeek 依赖和 `GAME_SERVER_SECRET` 必设项。

#### C4. vite.config.ts 残留死代码 GEMINI_API_KEY define
- **位置**：`vite.config.ts:78-82`，`define: { 'process.env.API_KEY': ..., 'process.env.GEMINI_API_KEY': ... }`
- **现状**：后端早不用 Gemini，但 dev 配置还在把 `env.GEMINI_API_KEY` 注入前端 bundle。
- **修复**：删掉这段 define。

---

### 🟠 High（建议尽快修）

#### H1. 巨石文件，维护成本高
- **App.tsx**：2016 行 / 84 符号。把 VOCALOID 知识查询、模糊匹配（`getEditDistance`/`getFuzzySimilarity`/`scoreBiliboardSong`）、VocaDb JSONP 浏览器端调用、所有 fetch API 客户端、`NpcChatBox`/`TypewriterEffect` UI 组件全塞一个文件。
- **GameCanvas.tsx**：2412 行 / 94KB / 105 符号。整个游戏引擎。
- **拆分建议**：
  - 从 App.tsx 抽出 `lib/vocadb.ts`（查询/匹配）、`lib/biliboard.ts`（榜单数据加载）、`api/client.ts`（fetch 封装）、`components/NpcChatBox.tsx`、`components/TypewriterEffect.tsx`
  - GameCanvas 拆 `engine/loop.ts`、`engine/physics.ts`、`engine/render.ts`、`engine/input.ts`，组件只做挂载和 React 桥接
- **注意**：引擎循环本身写得很对（见 §3），不要在拆分中破坏现有 invariants。

#### H2. CURATED_VOCALOID_CLASSICS 重复对象数组
- **位置**：`App.tsx:233+`，约 10 个同 shape 的对象（每个有 title/aliases/producers/vocalists/bvids/bilibiliUrls/bestRank/appearances/searchText）
- **问题**：手抄数据，错一个字段 TS 不报错（推断为宽类型）；扩展困难。
- **修复**：定义 `BiliboardHotSong` 类型（types.ts 里已有），把数据挪到 `public/data/curated-classics.json`，运行时加载。

#### H3. JSON 文件 DB 并发写竞态
- **位置**：`server/auth-leaderboard.mjs:24-36`（readDb + writeDb 整库 read-modify-write）
- **现状**：`handleLeaderboardRequest` 提交时 `readDb` → 修改 → `writeDb`，全程无锁。
- **后果**：两个并发提交可能 read 到同一份 → 后写覆盖前写 → 丢一条记录。游戏体量小概率低，但排行榜正是高并发场景。
- **修复**：加进程内互斥（一个 Promise 链串行化写），或改 SQLite。

#### H4. DeepSeek 调用无超时控制
- **位置**：`server/deepseek-miku.mjs:175-205`（`callDeepSeek`）
- **现状**：`fetch` 无 `AbortController`，DeepSeek 慢响应会挂住请求 → 占用 Node 事件循环连接 → 累积可拖垮服务。
- **修复**：加 `AbortSignal.timeout(15000)`，超时返回固定兜底话术。

---

### 🟡 Medium

#### M1. handleRunStartRequest 未登录可拿 runToken（设计待确认）
- **位置**：`server/auth-leaderboard.mjs:397-405`
- **现状**：`const { user } = await getSessionUser(req);` 未登录 user 为 undefined，但**仍签发 runToken**，`runPayload.userId = undefined`。
- **链路验证**：提交时 `handleLeaderboardRequest` 先 `if (!user) return 401 LOGIN_REQUIRED`，且 `if (runPayload.userId && runPayload.userId !== user.id) return 403` —— guest 拿的 runToken 提交时会被拦。
- **结论**：这是有意的 guest-run 设计（让未登录玩家先玩后登录再提交），链路自洽。但建议在注释里写明意图，否则容易被当 bug 改掉。

#### M2. scripts 是爬虫，上游变更即断
- **scripts/build-biliboard-hot-db.mjs** 抓 Biliboard 公开 API + voca.wiki
- **scripts/collect-producer-aliases-cn.mjs** 同上
- **风险**：bilibili/voca.wiki 改版 → 数据库构建脚本失效 → 已生成的 JSON 仍可用但会过期。
- **修复**：脚本加 CI 定期跑 + 失败告警；数据 JSON 提交进仓（已做）保证脱机可用。

#### M3. 零测试、零 CI
- 无任何 `*.test.*` 文件
- 无 `.github/workflows/`
- **优先补**：`auth-leaderboard.mjs` 的 PoW/session/密码哈希是安全核心，应有单测；`scoreBiliboardSong` 模糊匹配逻辑应有快照测试。

#### M4. `.mjs` 无 TS 类型检查
- 三个 server 文件 + 两个 scripts 全是 `.mjs`
- **修复**：加 `jsconfig.json` + `tsc --checkJs`，或迁移到 `.ts`。安全核心代码（密码/PoW）值得类型守护。

---

### 🟢 Low / 备注

- **零 TODO/FIXME/HACK/XXX/@ts-ignore/dangerouslySetInnerHTML/eval/new Function**（全仓 grep 0 命中）—— 代码卫生极佳，fork 维护者很用心。
- **prompt-injection 面**（`deepseek-miku.mjs:3-35` 系统提示词）：玩家自由文本进 messages，system prompt 主要防编造歌词/P主，没显式防 "ignore previous instructions"。但 `polishMikuReply` 有后处理兜底，且 max_tokens 180 限制了爆炸半径。低风险。
- **GameCanvas.tsx:424** `as Navigator & { deviceMemory?: number }` —— 必要的类型断言，可接受。
- **audio URL 命名**（`constants.ts:170` `jump: "/audio/jump_remote.mp3"`）—— 命名带 "remote" 后缀但同目录有 `jump.mp3`，疑似历史遗留，不影响功能。

---

## 2. 安全链路完整复核（已用 codegraph trace 验证）

### 2.1 注册/登录 → PoW → session
`handleAuthRequest`（auth-leaderboard.mjs:331）：
- `/challenge` POST：IP 限流 60次/10分钟 → `createChallenge(ipHash)` 返回 nonce + difficulty（4）
- `/register` POST：限流 5次/小时 → `verifyChallenge(body.pow, ipHash)` → `sanitizeUsername` + `validateUsername` → 密码长度 8-80 → 用户名去重（大小写不敏感）→ `passwordHash`（PBKDF2 210000 次 sha256 32字节 + random salt）→ 写 session
- ✅ PoW 验证在注册前，防刷
- ✅ 密码哈希强度合格（OWASP 2023 推荐 ≥600000 次 sha256，这里 210000 略低但可接受；建议提到 600000）

### 2.2 排行榜提交 → runToken → 写库
`handleLeaderboardRequest:submit`（auth-leaderboard.mjs:417-441）：
- ✅ 必须登录（`if (!user) return 401`）
- ✅ `verifySignedPayload(body.runToken)` HMAC 验签
- ✅ `runPayload.userId && runPayload.userId !== user.id` 防 token 借用
- ✅ `db.submittedRunIds.includes(runPayload.runId)` 防 runId 重放
- ✅ `validateScore(summary, runPayload)` 服务端校验分数合理性
- ⚠️ 但：`validateScore` 的具体规则需要单独审（这次没展开），它决定了"伪造高分"的最后防线

### 2.3 静态文件服务路径穿越
`server.mjs:62-67`：
- ✅ `normalize(urlPath).replace(/^(\.\.[/\\])+/, '')` 剥离开头 `..`
- ✅ `!filePath.startsWith(distDir)` 二次校验，防止 `..` 绕过
- ✅ fallback 到 index.html（SPA 路由）
- 结论：path traversal 防护到位

---

## 3. 引擎层（GameCanvas）——出乎意料地扎实

这部分必须给 fork 维护者正名：2400 行不是堆出来的垃圾，是精心写的引擎。

### ✅ 游戏循环健康度
- **单 useEffect 闭包**（1301-2398），deps 含 gameState → 状态切换时整体重挂，避免跨状态闭包污染
- **防重入**：`scheduleLoop` 守卫 `animationId !== null`（1438），不会双重 RAF
- **可见性全覆盖**：`visibilitychange` + `blur` + `focus` + `pagehide` + `focusin`，切 tab 自动暂停（1276-1290）
- **恢复链路**：`resumeLoop`（1442）在 focus/pageshow 时重置 `lastFrameTime` 避免 delta 大跳
- **unmount 清理**：`disposed` flag + `cancelAnimationFrame`（2390-2396）

### ✅ 性能自适应
- `targetFpsRef` 按 `navigator.hardwareConcurrency`/`deviceMemory`/屏幕短边分低/中/高三档（422-450）
- 低端机：45fps + 粒子上限 150 + 场景质量 0.5x
- 高端机：60fps + 默认上限 + 全质量
- `particleLimitRef` / `projectileLimitRef` 用上限封顶，`emitParticles` 每次检查不溢出（1319）

### ✅ 资源安全
- `drawImageSafe`（1310）检查 `asset.complete && naturalWidth > 0` 才绘制
- `ctx.save()` / `ctx.restore()` 配对（如 2372/2382）

### ⚠️ 唯一遗憾：单文件巨石
引擎拆分见 H1。拆的时候**务必保留 scheduleLoop/resumeLoop/disposed 这套契约**，别拆成多个 useEffect 否则会重新引入双重调度风险。

---

## 4. DeepSeek 集成 —— 成本控制做得好

### ✅ token 经济
- `max_tokens` 默认 180，knowledge reply 220（`callDeepSeek` 175-187）
- `writeKnowledgeReply`（454）：**0 结果时不调 LLM**，直接返回固定话术 → 省 token
- `temperature: 0.85` 保留角色感

### ✅ 防幻觉双层
- 系统提示词（3-35）硬约束"资料里不存在的歌曲就当记不清，绝对不编造"
- `polishMikuReply` 后处理剥可疑内容
- `thinking: { type: 'disabled' }` 关 DeepSeek 推理链路，省钱省延迟

### ✅ 降级路径
- `handleMikuChatRequest:705`：无 API key → 503 `DEEPSEEK_API_KEY_MISSING`
- `callDeepSeek:191`：upstream 非 2xx → 抛带 status 的 error
- ⚠️ 见 H4：缺超时

---

## 5. 数据资产

| 文件 | 大小 | 内容 | 风险 |
|---|---|---|---|
| `public/data/biliboard-hot-songs.json` | 1.4MB | bilibili VOCALOID 热门榜（版本 2，含 boards/issues/songs） | 爬虫产物，需定期重建 |
| `public/data/vocaloid-producer-aliases-cn.json` | 27KB | 中文 P 主别名库 | 同上 |
| `data/game-auth-db.json` | 运行时生成 | users/sessions/scores/runIds/mikuMemories | 见 H3 并发风险 |

`loadBiliboardHotDb`（App.tsx:500）有 Promise 缓存，不会每请求 parse 1.4MB。✅

---

## 6. 修复优先级建议

| 优先级 | 项 | 工作量 |
|---|---|---|
| P0 上线前 | C1 SECRET 必设 + fail-loud | 0.5h |
| P0 上线前 | C3 重写 README | 1h |
| P0 上线前 | C4 删 GEMINI 死代码 | 0.2h |
| P0 上线前 | C2 确认反代 strip X-Forwarded-For | 0.5h（部署侧） |
| P1 一周内 | H4 DeepSeek 超时控制 | 0.5h |
| P1 一周内 | H3 DB 写加进程内互斥 | 1h |
| P2 两周内 | H2 抽 CURATED 数据到 JSON | 1h |
| P2 两周内 | M3 给 auth-leaderboard 补单测 | 4h |
| P3 长期 | H1 拆 App.tsx / GameCanvas.tsx | 2-3 天 |
| P3 长期 | M4 .mjs 迁移到 .ts | 1-2 天 |
| P3 长期 | M1 加 guest-run 设计注释 | 0.2h |

---

## 7. 总评

**这是个值得救的项目，不是玩具。** 创意扎实（潜行+VOCALOID 知识问答的混搭极少见），后端防作弊链完整，引擎循环健康度甚至超过很多商业项目，零技术债标记说明维护者有洁癖。主要问题是"刚从 AI Studio 拉下来还没本地化整理"的状态：文档不一致 + 两个巨石文件。把 P0 的四个文档/配置问题修掉就能干净上线，H1 拆分是长期工程但不阻塞当下。
