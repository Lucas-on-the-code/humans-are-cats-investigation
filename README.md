# Humans are Cats: Investigation(人类是猫调查)

VOCALOID 主题横版潜行调查游戏。玩家扮演代号"鼠"(MOUSE),从树冠潜入一个全员猫化的霓虹小镇,扫描居民、收集证据、躲避恐慌条,向右探索越远分数越高。途中会遇到初音未来 NPC,和她聊天可以查 VOCALOID 歌曲、P 主、热曲榜单,聊出来的成绩可以提交到排行榜。

> 这是从 Google AI Studio 上的原型 fork 下来做的本地化版本。原项目用 Gemini,本副本已经切到 DeepSeek + bilibili VOCALOID 热曲库 + 中文 P 主别名库。原 AI Studio 模板残留(包括老 README 里的 `GEMINI_API_KEY` 指引)已废弃,以本文件为准。

## 技术栈

- **前端**:React 19 + TypeScript 5.8 + Vite 6 + Tailwind 3,纯原生 Canvas 2D 渲染(无 Phaser / Pixi)
- **后端**:纯 Node `http`(零框架),HMAC session + PoW 防作弊,JSON 文件存储
- **AI 对话**:初音未来 NPC 由 DeepSeek 驱动(`server/deepseek-miku.mjs`)
- **数据**:bilibili VOCALOID 热门榜 + 中文 P 主别名库,离线 JSON,运行时不外联

## 环境变量

新建 `.env.local`(开发)或在系统环境注入(生产)。`.env.example` 给了最小参考。

### 必设(生产)

| 变量 | 说明 |
|------|------|
| `GAME_SERVER_SECRET` | HMAC 签名密钥,用于 session 和 runToken。**生产必须设为 ≥32 字符的随机串**,未设时 `server.mjs` 会拒绝启动。生成命令:`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DEEPSEEK_API_KEY` | 初音未来聊天的 LLM key。不设时聊天接口返回 503 `DEEPSEEK_API_KEY_MISSING`,但游戏本体可玩 |

### 可选

| 变量 | 默认 | 说明 |
|------|------|------|
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | 初音未来对话用的模型 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek API 网关 |
| `TRUSTED_PROXY_HOPS` | `0` | 部署在 nginx / Caddy 反代后时设为反代跳数。`0` = 直连,忽略 `X-Forwarded-For`,用 `remoteAddress` 做限流 |
| `PORT` | `3000` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 服务监听地址 |

## 本地开发

```bash
npm install
# 配 .env.local,至少写 DEEPSEEK_API_KEY
npm run dev
```

`npm run dev` 启动 Vite dev server,前端和 `/api` 中间件一体。默认 http://localhost:3000,端口被占会自动跳到下一个可用端口。

## 生产部署

```bash
npm run build
# 设环境变量(GAME_SERVER_SECRET、DEEPSEEK_API_KEY 等)
npm run serve
```

`npm run serve` 跑 `server.mjs`,纯 Node `http` 提供静态文件 + API,无外部框架依赖。部署在反代(nginx / Caddy)后面时,记得按上面表格设 `TRUSTED_PROXY_HOPS`,并让反代正确 strip / 重设 `X-Forwarded-For`。

## 重建 VOCALOID 数据库

游戏内置的曲库和 P 主别名是从 bilibili / voca.wiki 抓的。已生成的 `public/data/*.json` 已提交进仓库,脱机可直接用。上游改版后想刷新数据:

```bash
npm run build:vocaloid-db
```

这会重新跑 `scripts/build-biliboard-hot-db.mjs`(抓 bilibili VOCALOID 热门榜)和 `scripts/collect-producer-aliases-cn.mjs`(中文 P 主别名库),需联网。脚本失效不影响已生成的 JSON。

## 项目结构

```
.
├── App.tsx                 # 前端主组件:VOCALOID 知识查询、模糊匹配、API 客户端、聊天 UI
├── components/
│   ├── GameCanvas.tsx      # 游戏引擎(渲染 / 物理 / 输入 / 游戏循环)
│   └── DialogBox.tsx       # 对话框
├── server/                 # 后端逻辑(纯 node:http)
│   ├── auth-leaderboard.mjs    # 注册 / 登录 / PoW / session / 排行榜
│   ├── deepseek-miku.mjs       # 初音未来对话 + DeepSeek 调用
│   └── vocaloid-knowledge.mjs  # VOCALOID 曲库知识检索
├── server.mjs              # 生产入口,静态服务 + API 路由
├── scripts/                # 数据采集爬虫
├── utils/                  # audioSystem / mikuMemory
├── public/data/            # 提交进仓的离线 JSON(热曲库 / P 主别名)
├── public/{audio,scene,sprites}/  # 音频 / 场景图 / 精灵帧
└── constants.ts / types.ts # 游戏常量、类型定义
```

## 致谢

- VOCALOID 文化和所有 P 主、Vocalist
- Crypton Future Media 与初音未来(Hatsune Miku)
- DeepSeek — 提供初音未来对话能力
- VocaDB / biliboard / voca.wiki — 曲库与榜单数据来源
