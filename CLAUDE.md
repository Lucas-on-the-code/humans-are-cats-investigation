# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概要

VOCALOID 主题横版潜行调查游戏。从 Google AI Studio 原型（用 Gemini）fork 后本地化为 DeepSeek + bilibili VOCALOID 热曲库 + 中文 P 主别名库。前端 React 19 + TS 5.8 + Vite 6 + Tailwind 3，纯原生 Canvas 2D 渲染（无 Phaser/Pixi）。后端纯 Node `http`（零框架），better-sqlite3 存储。

环境变量、部署反代设置、数据采集脚本说明见 `README.md`，不在此重复。

## 常用命令

```bash
npm run dev              # Vite dev server（前端 + /api 中间件一体），默认 http://localhost:3000
npm run build            # 生产构建到 dist/
npm run serve            # 跑 server.mjs 生产入口（需先 build，且 GAME_SERVER_SECRET 已设）
npm run build:vocaloid-db # 重建曲库爬虫（联网；脚本失效不影响已提交的 JSON）
```

**没有 lint / test / typecheck 命令，也没有任何测试文件或 CI。** `.mjs` 服务端代码不受 tsconfig 约束，改 `.mjs` 时 `tsc` 不会替你兜底。

## 架构要点

### 双入口：dev 用 Vite 中间件，prod 用 server.mjs

API 路由在两个地方注册，**加新端点必须两边同步**，否则只在 dev 或只在 prod 生效：

- `vite.config.ts` — dev 时通过 `configureServer` 中间件挂载 `/api/*`
- `server.mjs` — prod 时 `createServer` 里手写 `req.url.startsWith('/api/...')` 路由分发

`server.mjs` 同时负责 `dist/` 静态文件服务（含 Range 请求）和 SPA fallback。`GAME_SERVER_SECRET` 未设或 < 32 字符时 `server.mjs` **fail-loud 拒绝启动**——这是有意的，不要改成静默回退（历史上静默回退导致重启即全量 session/runToken 失效）。

### 双层防作弊链（`server/auth-leaderboard.mjs`）

排行榜提交 `POST /api/leaderboard submit` 的校验顺序很重要，改动前先读懂整条链：

1. **必须登录**（`getSessionUser`，401 if guest）
2. **runToken HMAC 验签** + `userId` 一致性 + runId 防重放
3. **`validateScore`** — 分数天花板合理性校验（基于真实数据收紧过的 `survivalTime*1200 + distance*20 + 12000`）
4. **`replayScore`** — 服务端用客户端上报的事件流重放计分，与 `summary.score` 偏差超过 `max(score*0.20, 800)` 即 `SCORE_MISMATCH`。这是最强的反作弊层，事件类型的 base 值表在 `KNOWN_EVENT_BASES`
5. 单个 SQLite 事务内完成 replay check + 写分 + 记 runId

事件上限、距离估算等参数近期多次调整（见 git log），改前端事件上报和后端 `replayScore` 必须**一起改**，否则合法分数会被误杀。

### guest-run 是设计而非 bug

`handleRunStartRequest` 未登录仍签发 runToken（`userId = undefined`），允许"先玩后登录再提交"。提交时会被登录态拦截。改这行前先确认不是在修"bug"。

### 存储

better-sqlite3，DB 路径由 `GAME_DB_PATH` 控制，默认落在 app 目录外的 `data/game-auth-db.sqlite`，**rsync/部署不会覆盖**。早期是 JSON 文件 read-modify-write（`ARCHITECTURE_AUDIT.md` 的 H3 已过时），现已解决。

## 代码地形与陷阱

- **两个巨石文件**：`App.tsx`（~2100 行）塞了 VOCALOID 知识查询、模糊匹配（`getEditDistance`/`getFuzzySimilarity`/`scoreBiliboardSong`）、所有 fetch 客户端、聊天 UI；`components/GameCanvas.tsx`（~2500 行）是整个游戏引擎。改这两个文件先用 codegraph 定位符号，别线性翻。
- **GameCanvas 引擎循环契约不要破坏**：单 `useEffect` 闭包 + `scheduleLoop` 防重入守卫 + `resumeLoop` 重置 `lastFrameTime` + `disposed` flag。拆分成多个 `useEffect` 会重新引入双重 RAF 风险。
- **性能自适应**：`targetFpsRef` 按 `hardwareConcurrency`/`deviceMemory`/屏幕短边分低/中/高三档；`particleLimitRef`/`projectileLimitRef` 在 `emitParticles` 每次检查封顶。改粒子/投射物逻辑要尊重这些上限。
- **i18n**：`i18n/locales/{en,zh}.ts`，新增文案两边都要加。
- **数据资产**：`public/data/*.json` 是爬虫产物，已提交进仓、脱机可用。`biliboard-hot-songs.json`（热曲库）源是 **voca.wiki** 的 `Biliboard术力口周榜` wikitext（不是 bilibili API）；`vocaloid-producer-aliases-cn.json`（P 主别名）由 `collect-producer-aliases-cn.mjs` 抓 voca.wiki。`App.tsx` 的 `loadBiliboardHotDb` 有 Promise 缓存，不会每请求 parse 1.4MB；它只校验 `Array.isArray(songs)`，不校验 `version`。
- **生产爬虫（voca.wiki 周更）**：biliboard.uk 公开 API 对生产服务器 IP 被 Cloudflare 拦死（403），所以热曲库改用 voca.wiki。`scripts/build-biliboard-hot-db.mjs` 的 `main()` 走 voca.wiki（`fetchCategoryPages` + `parseRankingEntries`），`apiGet` 带 4 次重试 + 20s 超时。生产 cron `17 19 * * 3`（北京周四 03:17）跑 wrapper 覆盖 `dist/data/`（游戏每请求读盘，无需重启）。兜底：写 `.tmp` + 校验（MIN_ISSUES/MIN_SONGS + re-parse）+ rename，失败不碰正式库 + exitCode≠0；cron `|| hac-mail-alert.sh` 发邮件告警。**改这个脚本后必须手动 scp 到服务器**（`/opt/humans-are-cats/app` 不是 git 仓库，git pull 走不通）。
- **DeepSeek 集成**（`server/deepseek-miku.mjs`）：`max_tokens` 默认 180，无结果时不调 LLM 直接返回固定话术（省 token）。系统提示词约束不编造歌词/P 主，`polishMikuReply` 后处理兜底。`callDeepSeek` 的 fetch 带 `AbortSignal.timeout(15000)` 超时保护（审计 H4 已修）。

## 参考

`ARCHITECTURE_AUDIT.md` / `GSTACK_AUDIT.md` 是早期体检报告，**部分结论已过时**（SECRET fail-loud、JSON→SQLite 迁移、文档不一致等 P0/P1 多数已修）。读它们时以 git log 和当前代码为准。
