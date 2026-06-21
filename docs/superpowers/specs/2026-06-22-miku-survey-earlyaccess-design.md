# Miku 问卷 + 内测邮箱征集 设计

- 日期：2026-06-22
- 状态：设计已确认，待实现

## 1. 目标

在玩家死亡后的结算页，向"试过 Miku AI 聊天"的玩家弹出一份多步问卷（Miku 口吻），收集用户画像、行业痛点、新作意愿、流失归因；问卷末尾征集邮箱（可选），用于未来 AI 视觉小说新作的内测通知。

**隐藏逻辑（不向玩家披露）**：邮箱登记时快照玩家 Miku 使用量（会话数）作为内测资格排序依据。玩家可见文案仅"有机会获得内测资格"，绝不提及使用量与资格的关联。

## 2. 背景与约束（现状摸底结论）

- **miku-chat 不要求登录**：`handleMikuChatRequest` / `handleMikuChatEndRequest`（`server/deepseek-miku.mjs`）全程不读 userId，guest 也能聊。仅 `/api/miku-memory`（`handleMikuMemoryRequest`）持久化绑登录用户。
- **服务端对 miku 使用量零落库**：历史使用量无法回算，只能从本功能上线起开始记录。
- **客户端已在算 `sessionCount`**：`utils/mikuMemory.ts` 的 `MikuMemoryState.sessionCount`（localStorage，per scope）。`/api/miku-chat/end` 的 body 已含 `sessionCount`，目前仅喂 LLM 抽记忆，未落库。
- **guestId 机制已存在**：`getOrCreateGuestMemoryScope()`（`utils/mikuMemory.ts`，当前未 export）返回 `guest:<uuid>`，uuid 存于 `localStorage[MIKU_GUEST_ID_STORAGE_KEY]`。
- **死亡流程**：`GameCanvas` 死亡动画结束 → `endRun()` → `onGameOver(summary)` → App.tsx `setGameState('MENU')` + `setIsGameOver(true)`。GameCanvas 随即卸载（无"定格画面"），切到全屏 MENU 结算 overlay。
- **结算 overlay 现有布局**（App.tsx ~1916）：`max-w-4xl` 居中，两栏 grid（`grid-cols-[0.85fr_1.15fr]`，左=本局分数/上传，右=排行榜），底部"再玩一次"。
- **路由双入口**：dev 用 `vite.config.ts` 中间件，prod 用 `server.mjs`，加端点必须两边同步。
- **i18n**：扁平点分 key，`i18n/locales/{en,zh}.ts`，`Record<string,string>`。
- **无测试框架 / 无 CI**：手动验证。
- **GameCanvas.tsx 是引擎巨石**：本功能不触碰它。

## 3. 触发与展示

- **触发时机**：`onGameOver` 回调内（App.tsx ~1895），死亡后判定。
- **触发条件**（同时满足）：
  1. 本设备 `localStorage['hac_survey_dismissed']` 未设
  2. 客户端 `sessionCount >= 1`（试过 miku，至少一次完整会话）
- **展示形态**：浮动卡片，绝对定位在 `isGameOver` overlay 内。桌面 `absolute right-6 top-6 z-50 max-w-sm`；移动端底部抽屉 `bottom-0 inset-x-0`。**不挤占、不遮挡结算主体**（分数 / 排行榜 / 再玩按钮保持可见）。
- **频率**：满足条件首次死亡弹一次；玩家 ✕ 关闭或提交完成 → 写 `hac_survey_dismissed`，本设备不再自动弹。
- 提交网络失败时**不写** dismiss，允许重试。

## 4. 数据模型

新增两表，加入 `server/auth-leaderboard.mjs` 的 `db.exec`（与现有 users/sessions/scores 等同处）。

### 4.1 miku_usage（会话计数，方案 2「信任客户端 max」语义）

```sql
CREATE TABLE IF NOT EXISTS miku_usage (
  scopeKey TEXT PRIMARY KEY,          -- 'u:<userId>' / 'g:<guestId>'
  sessionCount INTEGER NOT NULL DEFAULT 0,
  firstSessionAt INTEGER NOT NULL,
  lastSessionAt INTEGER NOT NULL
);
```

`/api/miku-chat/end` 收到客户端 `body.sessionCount` 后 UPSERT：
`ON CONFLICT(scopeKey) DO UPDATE SET sessionCount = MAX(sessionCount, excluded.sessionCount), lastSessionAt = excluded.lastSessionAt`。

### 4.2 survey_responses（问卷答案 + 邮箱）

```sql
CREATE TABLE IF NOT EXISTS survey_responses (
  id TEXT PRIMARY KEY,
  scopeKey TEXT,
  userId TEXT,
  guestId TEXT,
  q1 TEXT,                  -- 单选值
  q2 TEXT,                  -- 多选 JSON array 字符串
  q3 TEXT,                  -- 'yes' | 'maybe' | 'nah'
  q4 TEXT,                  -- 多选 JSON array 字符串
  q2_other TEXT,
  q4_other TEXT,
  email TEXT,               -- 可空
  reached_email INTEGER DEFAULT 0,
  usageSnapshot INTEGER DEFAULT 0,
  completedAt INTEGER,      -- NULL = 中途退出
  createdAt INTEGER,
  updatedAt INTEGER,
  createdIpHash TEXT
);
CREATE INDEX IF NOT EXISTS idx_survey_scope ON survey_responses(scopeKey);
CREATE INDEX IF NOT EXISTS idx_survey_email ON survey_responses(email) WHERE email IS NOT NULL;
```

- 单选题分列存储便于直接 SQL 分析；多选题存 JSON array，分析用 SQLite `json_each`。
- `email` 可空（玩家可只答问卷不留邮箱）。
- `completedAt` 为 NULL 表示中途退出（部分答案已落库）。
- **内测资格名单**：`SELECT email, usageSnapshot FROM survey_responses WHERE email IS NOT NULL ORDER BY usageSnapshot DESC, createdAt ASC`。

## 5. 问卷流程（状态机）

```
q1 ─→ q2 ─→ q3 ─┬─ yes / maybe ─→ emailWilling (Q5) ─→ done
                └─ nah          ─→ q4 ─→ emailPass (Q6) ─→ done
任意步 ✕ ─→ 中途退出（提交部分答案 + dismiss）
```

- Q1 / Q3 单选；Q2 / Q4 多选，含"其他"展开文本框。
- Q1 不设"其他"选项（封闭四项）。
- 题项与选项文案见第 6 节。

## 6. 文案（中英，落地 i18n `survey.*` 命名空间）

> Miku 口吻：清爽、元气、友好，第一人称；可用"嗯！""唔"等轻口吻词；禁 AI/客服味词（系统/资料/检索等）；不讨论身份外技术。公开英文文案无 em dash。

### 6.1 开场（Miku）
- zh：「谢谢你陪我聊这么久！真的很开心～」+「我有几个小问题想问下你：」
- en：「Thanks for chatting with me this long! I'm really happy~」+「I have a few little questions for you:」

### 6.2 Q1 熟悉度（单选）
- label：你熟悉AI角色扮演吗？ / How familiar are you with AI roleplay?
- opt1：玩过AI角色扮演的电子游戏 / I've played AI roleplay games
- opt2：我是酒馆（SillyTavern）/星野/猫箱/Glow用户 / I use SillyTavern / Xingye / Maoxiang / Glow
- opt3：我直接用DeepSeek等AI玩角色扮演 / I roleplay directly with AI like DeepSeek
- opt4：我没接触过AI角色扮演 / I've never tried AI roleplay

### 6.3 Q2 痛点（多选 + 其他填写）
- label：你觉得AI角色扮演最大的问题是？ / What's the biggest problem with AI roleplay? (pick all that apply)
- 角色记不住人设 / Characters forget who they are
- 没有动力/目标感 / No drive or sense of goal
- 纯文字沉浸感不足 / Pure text isn't immersive enough
- 剧情节奏不稳定 / Pacing is unstable
- 剧情前后逻辑矛盾 / Plot contradicts itself
- 埋一堆伏笔不回收 / Sets up threads it never pays off
- AI幻觉胡编乱造 / AI hallucinates and makes things up
- 过度迎合用户 / Too eager to please the user
- 情节老套，太好猜 / Plots feel generic and predictable
- AI味太浓，容易出戏 / Too obviously AI, breaks immersion
- 其他（填写框）/ Other (text)

### 6.4 Q3 新作预告（Miku + 单选分支）
- body zh：「偷偷说，我背后那群人在策划新的游戏～ 想做一款AI 边写边演的视觉小说，有精美的演出，会随着情节变CG和音乐氛围。剧情虽然是 AI 现场生成的，但我们人工分析了海量视觉小说的剧情节奏，教会AI顺着上下文决定情绪起伏。要不要来当第一批玩的人？」
- body en：「Between us, the team behind me is cooking up a new game~ A visual novel written and performed by AI in real time, with gorgeous presentation that shifts the CG and music to match each scene. The story is generated live, but we hand-analyzed a massive pile of visual novels to teach the AI how to shape the emotional flow moment to moment. Want in on the first wave?」
- yes：要！想多了解 / Yes! Tell me more → Q5
- maybe：看看吧 / Maybe, show me → Q5
- nah：算了 / Nah, pass → Q4

### 6.5 Q4 不感兴趣原因（多选 + 其他填写，nah 分支）
- label：不感兴趣的原因： / What's turning you off? (pick all that apply)
- 我不玩AI角色扮演 / I don't play AI roleplay
- 我不玩视觉小说/galgame/乙游 / I don't play visual novels / galgame / otome games
- 这不就是酒馆吗 / Isn't this just SillyTavern?
- 我自己用AI就能玩，不需要游戏 / I can roleplay with AI myself, don't need a game
- 我不相信你画的饼 / I don't buy the pitch
- 担心很烧钱，游戏会很贵 / Worried it'll burn cash and the game will be pricey
- 我讨厌AI / I hate AI
- 其他（填写）/ Other (tell us)

### 6.6 Q5 意愿分支结尾
- zh：「感谢你的反馈！如果未来想要听到更多关于新作的消息，可以在这里留下邮箱，有机会获得内测资格！」
- en：「Thanks for the feedback! If you want to hear more about the new game later, leave your email here for a shot at the beta!」

### 6.7 Q6 流失分支结尾
- zh：「感谢你的反馈！你的回答对我们的帮助很大。要是哪天改观了，也欢迎留个邮箱看看成品」
- en：「Thanks for the feedback, it really helps us. If you ever change your mind, feel free to leave an email and see how it turns out.」

### 6.8 隐私声明（Q5/Q6 邮箱框下方小字）
- zh：邮箱收集仅为通知内测目的，我们会保障您的隐私
- en：Email is collected only to notify you about the beta. Your privacy is safe with us.

### 6.9 按钮 / 状态文案
- cta：拿到内测资格 / Get beta access
- next：下一题 / Next
- back：上一题 / Back
- skip：跳过邮箱 / Skip email
- status.success：嗯！记下了，新故事好了我去找你。 / Mm! Got it. I'll find you when it's ready.
- status.registered：这个邮箱你留过啦，内测见。 / You've already left this one. See you in the beta.
- status.invalidEmail：邮箱好像不太对哦。 / That email doesn't look right.
- status.networkError：唔，网络开了点小差，再试一次？ / Hmm, the connection tripped. Try again?
- aria.progress：第 {n}/{total} 题 / Question {n} of {total}

## 7. 后端 API

### 7.1 `/api/miku-chat/end` 计数钩子（改 `server/deepseek-miku.mjs` 的 `handleMikuChatEndRequest`）
- 现有逻辑（喂 LLM 抽记忆）保留。
- 末尾追加：读 `body.guestId`；尝试从 token 解析 userId（复用 `auth-leaderboard.mjs` export 的只读 `getSessionUser`，不强制登录）；拼 `scopeKey`；调用新增的 `upsertMikuUsage(scopeKey, sessionCount)`（`auth-leaderboard.mjs` 提供，封装 UPSERT max）。
- 客户端需在 `/end` body 新增 `guestId` 字段（见 8.3）。
- 计数失败静默处理，不影响 miku 聊天主流程。

### 7.2 `POST /api/survey`（新端点，handler 放 `auth-leaderboard.mjs`）
- body：`{ guestId?, userId?, q1?, q2?, q3?, q4?, q2Other?, q4Other?, email?, reachedEmail, locale }`
- 服务端处理：
  1. 拼 `scopeKey`（userId 优先，否则 guestId）；二者皆无 → 400 `BAD_REQUEST`。
  2. email 归一小写 + 正则校验；不合法 → `EMAIL_INVALID`，不写库。
  3. email 跨 scopeKey 去重：若已被别的 scopeKey 登记 → 仍保存问卷答案，但 email 字段不覆盖，返回 `EMAIL_ALREADY_REGISTERED`。
  4. UPSERT by scopeKey（同设备多次提交合并到同一行，部分/完整都归一）。
  5. `usageSnapshot = SELECT sessionCount FROM miku_usage WHERE scopeKey=?`（无记录则 0）。
  6. 写 `createdIpHash`（复用现有 IP hash 逻辑）。
- 响应：`{ ok: true }` 或 `{ ok: false, error: 'EMAIL_INVALID' | 'EMAIL_ALREADY_REGISTERED' | 'RATE_LIMITED' | 'BAD_REQUEST' }`

### 7.3 路由双入口（两边必须同步）
- `server.mjs`：`if (req.url?.startsWith('/api/survey')) { await handleSurveyRequest(req, res); return; }`，置于 `/api/miku-chat` 之后、静态文件分发之前。
- `vite.config.ts` 的 `configureServer` 中间件：挂同样路由到 dev。

### 7.4 防刷 / 限流
- 复用 `auth-leaderboard.mjs` 的 `rateBuckets`，`/api/survey` 限流：每 IP 每分钟 10 次。
- guestId 服务端做长度/字符校验（防注入），不防伪（玩家无作弊动机）。
- 不发验证邮件（YAGNI）。

## 8. 前端组件

### 8.1 SurveyPopup（新文件 `components/SurveyPopup.tsx`）
- 自带状态机 `useState<SurveyStep>`，步骤集合：`q1 | q2 | q3 | q4 | emailWilling | emailPass | done`。
- props：`{ locale, userId?, guestId, onComplete, onDismiss }`。
- 绝对定位：桌面 `absolute right-6 top-6 z-50 max-w-sm`；移动端 `bottom-0 inset-x-0`（抽屉式）。
- 每步：题干 + 选项（radio / checkbox，"其他"选中展开文本框）+ Back / Next + ✕ 关闭。
- 顶部进度点 `●○○○`（按当前 step 推进）。

### 8.2 挂载点与触发（App.tsx）
- `onGameOver` 回调（~1895）内：判定 `localStorage['hac_survey_dismissed']` 未设 且 `loadMikuMemory(scope).sessionCount >= 1` → `setShowSurvey(true)`。
- `isGameOver` overlay 容器（~1916）内渲染：`{showSurvey && <SurveyPopup ... />}`。
- 关闭 / 完成回调：`localStorage.setItem('hac_survey_dismissed','1')` + `setShowSurvey(false)`。

### 8.3 guestId / userId 上报
- 新增 `utils/mikuMemory.ts` export：`const getMikuGuestId = () => getOrCreateGuestMemoryScope().replace(/^guest:/, '')`（返回纯 uuid）。
- 改 `finalizeMikuChatMemory`（App.tsx ~1488）：`/end` body 增加 `guestId: getMikuGuestId()`。
- `/api/survey` 提交：登录带 `userId = authUser.id`，否则 `guestId = getMikuGuestId()`。

### 8.4 提交时机（统一 `POST /api/survey`，服务端 UPSERT by scopeKey）

| 时机 | email | completedAt | reachedEmail | 写 dismiss |
|---|---|---|---|---|
| Q5 / Q6 提交邮箱 | 有 | now | 1 | 是 |
| 走完但跳过邮箱 | null | now | 1 | 是 |
| 中途 ✕ 关闭 | null | null | 0 | 是 |

### 8.5 i18n
- `i18n/locales/{en,zh}.ts` 新增 `survey.*` 命名空间（约 50 key），文案见第 6 节，两边同步。

## 9. 隐藏逻辑：内测资格排序（不向玩家披露）

- `usageSnapshot`（Miku 会话数）= 内测资格排序隐藏依据。
- 玩家可见文案仅"有机会获得内测资格"，绝不提及使用量 / 会话数与资格的关联。
- 后台拉排序名单：`SELECT email, usageSnapshot FROM survey_responses WHERE email IS NOT NULL ORDER BY usageSnapshot DESC`。

## 10. 错误处理与边界
- 邮箱：前端预校验 + 服务端兜底正则。
- 提交网络失败：显示 `networkError` + 重试按钮，**不写 dismiss**（允许重试）。
- `EMAIL_ALREADY_REGISTERED`：显示"已登记"文案 + 写 dismiss。
- localStorage 不可用（隐私模式）：触发判定直接 false，不弹、不报错、不崩溃。
- `/end` 计数钩子失败：静默，不影响 miku 聊天主流程。

## 11. 不在范围内（YAGNI）
- 邮箱验证邮件（MVP 不做）。
- Q1 增加"其他"选项（保持封闭四项）。
- 后台管理 UI（直接 SQL 查询 / 导出 CSV）。
- 问卷答案的二次编辑。
- 服务端 sessionCount 自增（明确采用方案 2 信任客户端 max，不做反作弊）。

## 12. 测试策略（手动验证清单，项目无测试框架）
1. guest 试聊 miku 一次 → 死亡 → 问卷弹出。
2. Q3 选 yes → Q5 填邮箱提交 → DB `survey_responses` 有完整行 + email + `usageSnapshot >= 1`。
3. Q3 选 nah → Q4 多选 → Q6 不填邮箱完成 → DB 有行 `email=NULL, reachedEmail=1`。
4. 中途 ✕ 关闭 → DB 有部分答案 `completedAt=NULL, reachedEmail=0` + `hac_survey_dismissed` 已写。
5. 同设备再死亡 → 不弹。
6. 未试过 miku（`sessionCount=0`）→ 死亡 → 不弹。
7. 换设备用已登记邮箱 → 返回 `EMAIL_ALREADY_REGISTERED`，答案存、email 不覆盖。
8. 邮箱格式错 → `EMAIL_INVALID`。
9. `/end` 计数：聊一次后 `miku_usage.scopeKey` 行 `sessionCount >= 1`，再聊取 max 不回退。
10. 中英文切换文案正确。
11. 移动端布局（底部抽屉不挡结算主体）。
12. 隐私模式（localStorage 不可用）→ 不崩、不弹。
13. dev（vite 中间件）与 prod（server.mjs）`/api/survey` 都通。
