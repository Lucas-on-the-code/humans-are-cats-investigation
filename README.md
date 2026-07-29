# Humans are Cats: Investigation（人类是猫调查）

横版潜行调查游戏。玩家扮演代号"鼠"(MOUSE)，从树冠潜入一个全员猫化的霓虹小镇，扫描居民、收集证据、躲避恐慌条，向右探索越远分数越高。

## 技术栈

- **前端**：React 19 + TypeScript 5.8 + Vite 6 + Tailwind 3，纯 Canvas 2D 渲染
- **后端**：纯 Node `http`（零框架），HMAC session + PoW 防作弊，JSON 文件存储
- **反作弊**：四层防护（反调试 → 代码完整性 → WASM 状态机 → 服务端校验）
- **桌面端**：Electron 43，内嵌 HTTP 代理，NSIS 安装包

## 快速开始

```bash
git clone https://github.com/ruufly/humans-are-cats-investigation.git
cd humans-are-cats-investigation
git checkout feature/steam
npm install
npm run dev          # 开发模式
```

## 生产部署

### 服务端

```bash
npm run build:server          # 生成 server-dist/
cd server-dist
# 编辑 .env：GAME_SERVER_SECRET=<32位随机密钥>
node server.mjs               # 监听 http://localhost:3000
```

服务端零外部依赖，纯 Node.js 内置 API。`server-dist/` 可直接复制到目标机器运行。

### 客户端 (Electron)

```bash
npm run electron:dist         # 生成 NSIS 安装包
# → release/Humans are Cats Investigation Setup 1.0.0.exe
```

客户端 `resources/config.json` 配置服务器地址：

```json
{ "apiServer": "https://cats.renchengzhang.com/steam-api/" }
```

## 项目结构

```
├── components/
│   ├── GameCanvas.tsx      # 游戏引擎
│   └── DialogBox.tsx       # 对话框
├── electron/
│   ├── main.cjs            # Electron 主进程（内嵌 HTTP 代理）
│   ├── config.json         # 服务器地址配置
│   └── logger.cjs          # 本地日志
├── server/
│   └── auth-leaderboard.mjs # 认证/排行榜/反作弊
├── server.mjs              # 服务端入口
├── utils/
│   ├── antiDebug.ts        # 反调试（第 1 层）
│   ├── codeIntegrity.ts    # 代码完整性（第 2 层）
│   └── apiBase.ts          # API 基础 URL
├── wasm-core/              # Rust WASM 反作弊（第 3 层）
├── public/                 # 精灵/音频/场景/WASM
├── scripts/
│   ├── build-server.mjs    # 服务端打包
│   └── build-integrity.mjs # 构建时哈希
├── App.tsx                 # 主组件
├── constants.ts / types.ts # 常量与类型
└── i18n/index.ts           # 多语言（中/英/日）
```

## 反作弊体系

| 层级 | 模块 | 功能 |
|------|------|------|
| L1 | `utils/antiDebug.ts` | 调试器检测、DevTools 窗口、控制台篡改、帧率异常 |
| L2 | `utils/codeIntegrity.ts` + `scripts/build-integrity.mjs` | 构建时 SHA-256 → 运行时自校验 → 服务端比对 |
| L3 | `wasm-core/` (Rust → WASM) | HP/panic/shield 受控 API，integrity 令牌 |
| L4 | `server/auth-leaderboard.mjs` | PoW 防注册机器人、HMAC runToken、分数合理性、WASM 令牌验证 |

## 环境变量

### 服务端（必设）

| 变量 | 说明 |
|------|------|
| `GAME_SERVER_SECRET` | HMAC 签名密钥，≥32 字符 |
| `PORT` | 监听端口，默认 3000 |

### 客户端

| 变量 | 说明 |
|------|------|
| `VITE_API_BASE` | API 服务器地址（Electron 模式留空） |

## 构建命令

```bash
npm run dev              # Vite 开发服务器
npm run build            # Web 生产构建
npm run electron:dist    # Electron NSIS 安装包
npm run build:server     # 服务端打包
npm run serve            # 启动服务端
```

## 许可

PolyForm Noncommercial License 1.0.0 — 仅限非商业用途。
