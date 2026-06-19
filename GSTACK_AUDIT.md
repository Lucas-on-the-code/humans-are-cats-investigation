# G Stack 三连审计整合报告 — Humans are Cats: Investigation

> 生成时间:2026-06-19
> 工具:gstack /cso + /review + /qa(基于 CodeGraph 585 节点 + ast 审查 + 浏览器运行时)
> 与你已有的 `ARCHITECTURE_AUDIT.md` 互补,不重叠

---

## 0. 三连总览

| 维度 | 工具 | 结论 | 关键数字 |
|---|---|---|---|
| 安全 | /cso (daily, 8/10 gate) | 后端加密健康,4 个配置/设计层问题 | 2 HIGH + 2 MEDIUM, 0 CRITICAL |
| 代码逻辑 | /review (全量静态) | 引擎框架健康,帧内状态有洞 | 7 CRITICAL + 8 INFORMATIONAL |
| 运行时 | /qa (report-only) | 游戏真能跑能玩 | health 91/100, 零 console error |

**三份互补,不重叠**:你的 ARCHITECTURE_AUDIT 偏架构/安全/集成/数据资产;G Stack 补的是安全深度验证、逐函数 correctness bug、运行实证。

---

## 1. 与 ARCHITECTURE_AUDIT.md 的交叉对比

### 重复确认(你的发现,我独立验证属实)
- **C1 SECRET 随机回退** → cso F3(9/10)
- **C2 XFF 信任** → cso F2(8/10),补了 PoW difficulty=4 使绕过高影响的 exploit 链
- **§3 引擎循环健康** → review 派 subagent 独立复核:scheduleLoop 防重入、unmount cancelAnimationFrame、7 个监听全 cleanup,**全部属实,无 RAF/内存泄漏**
- **H4 DeepSeek 无超时** → cso 归 DoS 默认排除,但已记
- **M1 guest-run 设计** → cso 确认链路自洽(正确设计)

### G Stack 新增(你的审计没覆盖)
- **cso F1 排行榜防作弊绕过**(9/10 HIGH)— 你 §2.2 说"validateScore 没展开",这次展开了:runToken 只签 {runId,startAt,userId},游戏状态全是客户端 body.summary,构造满足阈值的 summary 就能霸榜
- **cso F4 错误信息泄露**(8/10 MEDIUM)— error.message 直接回客户端,你完全没提
- **review R1-R7**(7 个 CRITICAL correctness bug)— 全是新的,集中在引擎帧内状态管理(App 你偏架构没逐函数查):
  - R1 登车帧状态不一致(出租车安全舱那一帧可被秒杀)
  - R2 dtScale=2.5 单步穿透 AABB 碰撞(切 tab 回来穿墙)
  - R3 App sendMikuMessage 会话覆盖竞态(旧对话灌进新会话)
  - R4 弹幕命中未跳出 + R5 updater 副作用反模式 + R6 粒子色字面量耦合 + R7 击退方向边界
- **review I1 MALL 死枚举** — types.ts 定义了 'MALL' 但全仓零引用,误导性死代码
- **qa 运行实证** — 静态审计说不了"能跑":加载 75ms / canvas 1280×720 / 右移 AREA 切换 + 分数 0→15→55 / 移动端自适应 / 全程零错误

### 你有、我没深查
- **H3 DB 并发写** — cso 归类为数据完整性非安全突破,没单列(影响是丢一条记录)
- **H1 巨石拆分 / M4 .mjs 迁 .ts** — 长期工程,review 没重复报

---

## 2. 统一修复优先级(三份去重合并)

### 🔴 P0 — 上线阻塞 + 玩法破坏(建议先修)

| ID | 来源 | 问题 | 工作量 |
|---|---|---|---|
| F1 | cso | 排行榜防作弊:runToken 签游戏状态 / 收紧 validateScore 阈值 / top-N 审核 | 渐进 4h,完全修复需服务端权威(大工程) |
| R1 | review | 登车帧状态:登车后用本地 activeRide 重检所有守卫 | 0.5h |
| R2 | review | 碰撞 sub-step:clampedDelta≤33ms 或位移拆步 | 2h |
| R3 | review | sendMikuMessage sessionId 守卫 | 1h |
| F2 | cso | XFF 可信代理:TRUSTED_PROXY_HOPS 或 getIp 默认 remoteAddress | 0.5h(代码) + 部署侧 |
| F3 | cso | SECRET fail-loud:启动检测未设则 throw | 0.2h |

### 🟠 P1 — 一周内

| ID | 来源 | 问题 | 工作量 |
|---|---|---|---|
| F4 | cso | 错误信息:catch 返回固定 INTERNAL_ERROR | 0.5h |
| R4 | review | 弹幕命中后 return + 跳过 life=0 位移 | 0.3h |
| R5 | review | declineNpcChatInvite 副作用移出 updater | 0.3h |
| R6 | review | Particle 加 shape 字段替色字面量 | 0.5h |
| R7 | review | damagePlayer 击退方向 sourceX≈p.x 用 n.vx | 0.3h |
| H4 | 已知 | DeepSeek AbortSignal.timeout(15000) | 0.5h |
| H3 | 已知 | DB 写进程内互斥(Promise 链串行化) | 1h |

### 🟡 P2 — 两周内

| ID | 来源 | 问题 | 工作量 |
|---|---|---|---|
| I1 | review | 删 ZoneType 'MALL' 死枚举 | 0.1h |
| I2 | review | biliboard JSON 逐字段校验 normalizeBiliboardHotSong | 1h |
| I3 | review | onGameOver/onWin useCallback 或 GameCanvas memo | 0.5h |
| I4 | review | startRun runStartSeqRef 序号守卫 | 0.3h |
| I5-I8 | review | slide 碰撞框/projectiles 环形缓冲/Set 重建/addPickupArc 死参数 | 2h |
| C4 | 已知 | 删 vite.config GEMINI define 死代码 | 0.2h |
| C3 | 已知 | 重写 README(去 Gemini/AI Studio 痕迹) | 1h |
| H2 | 已知 | CURATED_VOCALOID_CLASSICS 抽 JSON | 1h |
| M3 | 已知 | 补 auth-leaderboard 单测(PoW/session/密码/validateScore) | 4h |

### 🟢 P3 — 长期
- H1 拆 App.tsx/GameCanvas.tsx 巨石(2-3 天)
- M4 .mjs 迁 .ts + checkJs(1-2 天)

---

## 3. 需要你决策的运维项

- **`.gstack/` 不在 .gitignore** — 安全/QA 报告含 finding 细节,建议加 `.gstack/` 到 .gitignore(本地保留)
- **gstack 有升级** 1.58.0.0 → 1.58.3.0(非阻塞,完事可 `/gstack-upgrade`)
- **DEEPSEEK_API_KEY 未设** — miku-chat/vocaloid-search 链路运行未验证(非代码问题,部署时配 .env)

---

## 4. 整体评价

**你的 ARCHITECTURE_AUDIT.md 在架构/安全链路/引擎框架赞美/集成/数据资产维度做得相当扎实**,G Stack 三连的价值在于补齐三个你没深入的层:

1. **安全深度**:cso 主动验证排除了 execFile/SSRF/prompt-injection 三个误报(grep 看到 child_process 容易误报,读代码才确认安全),并挖出 F1 防作弊 + F4 错误泄露两个你没提的
2. **逐函数 correctness**:review 派 subagent 把 GameCanvas 2412 行 + App 2016 行两个巨石逐函数查,找出 7 个引擎/状态 bug——这层你偏架构视角没覆盖,且独立验证了你 §3 的引擎赞美站得住(框架好≠帧内逻辑对)
3. **运行实证**:qa 证明了"能跑",这是静态审计的结构性盲区

合并三份 + 你的 ARCHITECTURE_AUDIT,这个项目的完整画像:**代码卫生极佳(零 TODO/eval/dangerouslySetInnerHTML)、引擎框架扎实、真能跑能玩,主要债是两个巨石 + P0 的 6 个上线阻塞项(防作弊/登车帧/碰撞/聊天竞态/XFF/SECRET)**。把 P0 修掉就能干净上线。
