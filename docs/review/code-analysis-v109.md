# 六选五 · 代码全量分析（v109 基线）

- 基线提交：`69ddb66`（v108 已发布，线上 `20261101a` / sw v108）
- 分析口径：只读。所有行数为 `wc -l` 实测；所有引用/计数为 `grep` 实测；函数长度为脚本估算（方法见 §6.2 说明与局限）
- 分析人：寇豆码（主程序）
- 规模实测总表

| 区域 | 文件数 | 行数 | 备注 |
|---|---:|---:|---|
| `pwa/js/` | 25 | 15589 | 客户端全部逻辑 |
| `pwa/css/` | 4 | 6649 | `style.css` 单文件 5138 |
| `pwa/index.html` | 1 | 1277 | 其中内联 `<script>` 约 176 行 |
| `pwa/sw.js` | 1 | 304 | Service Worker |
| `server/`（非测试） | 7 | 4883 | `profile` 1403 / `index` 1370 / `hub` 1366 |
| `server/test/` | 42 | 7696 | |
| `pwa/test/` | 67 | 14194 | |
| `scripts/` | 57 | 20941 | 探针 / 模拟 / 构建 / 审计 |
| **生产 JS 合计** | 33 | **20472** | |
| **测试合计（109 个文件）** | 109 | **21890** | 测试 : 生产 = 1.07 : 1 |

---

## 一、实现范围与依赖

### 1.1 文字分层图

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 入口层  pwa/index.html (1277 行, 内联 JS ≈176)                            │
│   · sharecode 记忆与自愈 / manifest 注入        (19-90)                   │
│   · beforeinstallprompt 捕获 → window.__lxwInstallPrompt (91-105)        │
│   · --pt-scale 首屏预缩放 (106-149)                                       │
│   · .no-session 首屏防闪 (150-173)                                        │
│   · flex-gap 探测 + 兼容 CSS 按需加载 (177-225)                           │
│   · SW 注册 + 版本一致性自检 + 空闲刷新 (1213-1275)                        │
└───────────────────────────┬──────────────────────────────────────────────┘
                            │ 25 个 <script defer>，加载顺序即依赖图
┌───────────────────────────▼──────────────────────────────────────────────┐
│ 渲染层（DOM / Canvas / 事件）                                    ≈9.4k 行  │
│   game.js 4710 ── 主控 + 牌桌 + 顶栏 + 拖拽 + bindEvents(708)             │
│   recordsView 1355 · settleView 846 · seatSheetView 628 · accountView 588 │
│   cardView 269 · seatRing 359 · slotLayout 184 · ringGate 114             │
│   modalKit 208 · gameUtils 118 · sfx 191 · avatar 195 · emoji 107         │
├──────────────────────────────────────────────────────────────────────────┤
│ 状态层（前后端共用纯逻辑，无 DOM 无 IO）                          ≈2.9k 行  │
│   stateMachine 1516（房间状态机，唯一权威）                                │
│   engine 795（四玩法判定） · card 385（牌堆/洗牌） · ai 219 · config 179   │
├──────────────────────────────────────────────────────────────────────────┤
│ 传输层                                                          ≈1.3k 行  │
│   roomStore 987（ws 传输 + local 演示传输 + 重连状态机）                   │
│   authStore 281（会话 / 令牌 / 账号接口）                                  │
│   errorReport 165（前端异常上报）                                          │
├──────────────────────────────────────────────────────────────────────────┤
│ 本机持久层（localStorage）                                      ≈1.2k 行  │
│   records 575（本机战绩兜底） · sessionLog 381（对局流水）                 │
│   historyKit 234（历史口径换算）                                          │
└──────────────────────────────────────────────────────────────────────────┘
        ║ WebSocket（JSON 帧，21 个 type）
┌───────▼──────────────────────────────────────────────────────────────────┐
│ 服务端                                                                   │
│   接入层  index.js 1370（HTTP 路由 if 链 / 静态 / gzip / 账号 / 管理台）    │
│   房间层  hub.js 1366（房间 Map、广播、计时器、限流、心跳、落库编排）       │
│   协议层  ws.js 303（手写 RFC6455 子集）                                   │
│   业务层  auth.js 284（scrypt / 令牌） · avatars.js 122 · text.js 35       │
│   持久层  profile.js 1403（profiles.json 单文件 + 500ms 去抖 + 原子 rename）│
└──────────────────────────────────────────────────────────────────────────┘
```

### 1.2 依赖方向（实测）

服务端 `require`：`index → {ws, profile, avatars, hub, auth, text}`，`hub → pwa/js/{stateMachine, ai, config, emoji}`，`profile → auth, text`。
**没有环形 require**（服务端单向）。`server/text.js` 的注释明确记载了「原本三份昵称清洗、口径不一致」已收口为一份——这是本项目做对的一个范式。

客户端没有 `import`：25 个文件全部是 IIFE + 全局挂载，`pwa/index.html:1173-1211` 的 `<script>` 顺序就是唯一的依赖声明。实测两类挂载约定并存：

| 约定 | 模块 | 数量 |
|---|---|---:|
| `global.X = object`（UMD） | config / card / engine / stateMachine / roomStore / records / sessionLog / sfx / emoji / authStore / seatRing / slotLayout / ringGate / avatar / ai / errorReport | 16 |
| `global.LXW.x = create(deps)` 工厂 | accountView / cardView / historyKit / recordsView / seatSheetView / settleView | 6 |
| `global.LXW.x = api` 立即执行 | gameUtils / modalKit | 2 |

### 1.3 跨层越界（事实 + 位置）

| # | 越界 | 证据 | 影响 |
|---|---|---|---|
| 1 | **渲染层直连平台存储**，无收口 | `pwa/js/` 内 26 处 `localStorage/sessionStorage`，分布在 game.js(11) / roomStore.js(7) / authStore.js(3) / sfx.js(3) / accountView.js(2)；`pwa/index.html` 另 6 处 | 换平台（小程序/App）时要动 9 个文件；键名与清理逻辑无法集中审计 |
| 2 | **入口层承载 boot 关键逻辑** | `index.html:19-225` + `1213-1275`，≈176 行：sharecode 自愈、预缩放、防闪、flex-gap 探测、版本自检 | 不走模块、不能被 `require` 测试；只能靠源码正则守（`flex-gap-fallback.test.js`、`sw-precache.test.js` 即此路） |
| 3 | **渲染层是业务层的直接调用者**，跨度 152 个外部符号 | `game.js` 实测引用 152 个不同的外部符号：`Sfx.play`×48、`StateMachine.PHASE`×16、`RoomStore.*` 19 处、`Engine.*`、`Records.*`… | 无法静态检查层级倒置；任何模块改动都可能经 game.js 传导 |
| 4 | **服务端反向依赖前端目录** | `hub.js:20-25` `require('../pwa/js/stateMachine.js')` 等 4 个 | 本身是「单份共享内核」的正确取舍，但目录归属上应显式标为 `shared/`，否则新人会以为 pwa 可以随意改签名 |
| 5 | **服务端房间态无持久层** | `hub.js:409` `this.rooms.set(...)`，全库无房间落盘；重启即空 | 见 §4.3 |

---

## 二、模块职责表

### 2.1 `pwa/js/`（25 个模块，15589 行）

| 模块 | 行数 | 职责 | 对外出口 | 风险点 |
|---|---:|---|---|---|
| `game.js` | 4710 | 主控：屏切换、牌桌/顶栏渲染、拖拽落牌、事件绑定、引导、视口缩放、boot | 仅 `window.LXWBusy`（119） | 占客户端 30.2%；`bindEvents` 708 行、`resize` 377 行；引 152 个外部符号 |
| `stateMachine.js` | 1516 | 房间状态机与四玩法结算编排（唯一权威，前后端共用） | `StateMachine.{newRoom,joinRoom,…,settleGroup,reconnect,finalizeLeave}` | `settleRound` 145 行；`endReason` 口径与 3 处调用方重复 |
| `recordsView.js` | 1355 | 战绩页 / 排行榜 / 玩家档案卡 / 回放 / 分享图 / 数据清理 | `LXW.recordsView=deps=>api` | 四层页面挤一文件；`apiQuery` 121 行；云端 TTL 缓存 + 序号丢弃靠人守 |
| `roomStore.js` | 987 | 双传输数据层：ws 联机（权威）+ local 演示；重连状态机 | `RoomStore.*`（19 个动作） | 双实现常驻；`createLocalStore` 243 行 |
| `settleView.js` | 846 | 牌型特写幕 → 结果轮播 → 结算页 | `LXW.settleView` | 文件头注释称「755 行」，实 846；`settleReasonText`(711) 的 `scoreZero` 分支是**为老战绩显式保留**（注释 713-715 写明「别顺手删」），不算债；真风险是 `endReason` 口径在 3 处各写一份 |
| `engine.js` | 795 | 四玩法牌型判定与比大小（纯逻辑） | `Engine.{settleGroup,typeName,setConfig}` | 规则注释极详尽，但 `resolveTenHalf` 每次枚举 48 张候选（每次比牌 O(48n)） |
| `seatSheetView.js` | 628 | 点头像弹面板：表情/短语/信息三档 | `LXW.seatSheetView` | 文件头注释称「554 行」，实 628 |
| `accountView.js` | 588 | 账号页：登录/注册/改名/改密/注销/管理入口 | `LXW.accountView` | 直连 storage 清理会话（2 处） |
| `records.js` | 575 | 本机战绩兜底（localStorage） | `Records.{owners,scrubReplays,…}` | 与服务端 `_persistSettlement` 是两套统计实现，口径需人工同步 |
| `card.js` | 385 | 53 张牌模型、洗牌、Canvas 牌面/牌背绘制 | `Card.*` | 无 |
| `sessionLog.js` | 381 | 本机对局流水与回放 scrub | `SessionLog.{load,keyOf,owners,scrub}` | 与 `historyKit` 职责相邻，边界靠约定 |
| `seatRing.js` | 359 | 圆桌座位环几何（纯函数） | `SeatRing.{layout,minArcSpacing}` | 无（纯函数、可测） |
| `authStore.js` | 281 | 会话令牌读写、`refresh()`、`logout()` | `AuthStore` | 直连 storage 3 处；是会话键的唯一持有者（好事） |
| `cardView.js` | 269 | 牌面尺寸常量、飞牌动画、手牌/迷你牌 DOM | `LXW.cardView=deps=>api` | 尺寸常量与 `slotLayout` 数值耦合 |
| `historyKit.js` | 234 | 历史记录口径换算（`endedAtOf` / `endReasonOf`） | `LXW.historyKit` | `endReason` 白名单硬编码第 2 处（43） |
| `ai.js` | 219 | AI 出牌强度（前后端共用） | `Ai.*` | 无 |
| `modalKit.js` | 208 | 弹窗/确认框/焦点与 a11y | `LXW.modalKit`（立即执行） | 与 `game.js:2617 askConfirm` 职责重叠 |
| `avatar.js` | 195 | 头像预设 + 48 款 SVG data URI + cover 裁剪 | `Avatar.{img,list,coverRect}` | **`esc()` 与 gameUtils 重复实现**（149 vs 48） |
| `sfx.js` | 191 | 音效/BGM 开关与解锁 | `Sfx.*` | 直连 storage 3 处（音量/开关） |
| `slotLayout.js` | 184 | 组槽高度/总高的排版计算 | `SlotLayout.{groupHeight,totalHeight}` | 纯函数可测 |
| `config.js` | 179 | 数值与功能开关（策划可改）；向 Engine 同步 | `CONFIG` | 同步依赖加载顺序；`setConfig` 分支曾有 Node 侧失效历史（注释 155-160） |
| `errorReport.js` | 165 | window.onerror / unhandledrejection 上报 | `ErrorReport` | 上报端点未鉴权，靠服务端 IP 限流（40/min） |
| `gameUtils.js` | 118 | `$` / `el` / `esc` / 文本格式化（必须最先加载） | `LXW.utils`（立即执行） | 全模块第一依赖，无兜底 |
| `ringGate.js` | 114 | 「这台机器上不上圆桌」闸门判定（纯函数） | `RingGate.{flag,explain}` | 阈值 1200/700/0.44 写在此处，注释与 CSS 断点需人眼同步 |
| `emoji.js` | 107 | 表情/短语清单（**前后端共用白名单**） | `Emoji` | 无 |

### 2.2 `server/`（7 个文件，4883 行）

| 文件 | 行数 | 职责 | 对外出口 | 风险点 |
|---|---:|---|---|---|
| `profile.js` | 1403 | 档案/战绩/统计/排行榜/账号索引；`profiles.json` 读写 | `ProfileStore` | 单文件全量 `JSON.stringify`（262）每次写 O(全部档案)；flush 失败只置 dirty 不记日志 |
| `index.js` | 1370 | HTTP 总入口：约 20 个 `/api/*` 的 **if 链路由**、静态资源 + gzip 缓存、账号接口、管理台 | `http.createServer` | 路由无表、无匹配器，纯线性 if（685→1340 ≈ 655 行）；每加一个接口改一处 chain |
| `hub.js` | 1366 | 房间 Map、协议分发（21 type）、广播、6 类计时器、限流、心跳、结算落库编排 | `Hub` | 6 个并行 `Map` 存计时器；广播为全量快照 |
| `ws.js` | 303 | 手写 RFC6455 子集（握手/文本/分片/ping/pong/掩码） | `WebSocketServer, WSClient` | 注释称「手写 200 行」已过期（303）；不支持 permessage-deflate |
| `auth.js` | 284 | scrypt 口令哈希、HMAC 令牌签发/校验/续期、密钥加载、口令规则 | 10 个函数 + `module.exports` | 无（边界清楚） |
| `avatars.js` | 122 | 头像文件存储、魔数嗅探、大小上限 | `AvatarStore, sniff, MAX_BYTES` | 无 |
| `text.js` | 35 | 昵称清洗（**服务端唯一实现**，按码点截断） | `cleanNickname, NICK_MAX` | 无（正面例子） |

---

## 三、依赖关系与耦合

### 3.1 引用统计（实测：去重的外部符号个数）

`game 152` · `accountView 28` · `recordsView 20` · `roomStore 17` · `seatSheetView 13` · `stateMachine 12` · `settleView 11` · `records 9` · `sessionLog 1` · `historyKit 8` · `ai 7` · `cardView 7` · `engine 7` · `config 11` · `modalKit 2` · `authStore 2` · `gameUtils 2` · `emoji 1` · `sfx 1`
**零外部依赖**：`avatar / card / errorReport / ringGate / seatRing / slotLayout`（6 个，全是纯函数或自洽模块）——这是可测性的基本盘。

### 3.2 环形依赖

**不存在**。客户端是全局命名空间，环形调用（如 `game ↔ settleView`）通过 `create(deps)` 注入回调实现，是显式反向依赖，不是隐式环。服务端 require 图单向。

风险不在环，而在**隐式顺序**：`gameUtils.js` 必须最先（`index.html:1202` 注释明写「其余七个都从 LXW.utils 取 $ / el / esc」），漏改顺序 = 运行期 `Cannot read property '$' of undefined`，构建期无任何提示。

### 3.3 隐式全局状态

| 全局 | 位置 | 说明 |
|---|---|---|
| `window.LXW.{utils,cardView,modalKit,historyKit,accountView,settleView,seatSheetView,recordsView}` | 8 个模块 | 拆分后的唯一命名空间，但只覆盖 8/25 个模块，与其余 16 个 `window.X` 双轨 |
| `window.CONFIG / Engine / Card / StateMachine / RoomStore / Records / Sfx / AuthStore / SessionLog / Emoji / Avatar / Ai / SeatRing / SlotLayout / RingGate / ErrorReport` | 16 个模块 | 无命名空间前缀 |
| `window.LXWBusy` | 定义 `game.js:119`，消费 `index.html:1241` | **内联脚本与主控之间唯一的跨层契约**，只有这一处，但没有任何测试守它 |
| `window.__lxwInstallPrompt` | 写 `index.html:99/102`，读 `game.js:4177`、`game.js:4226`，清空 `game.js:4192` | 同上，跨层隐式契约 |
| `game.js` 内 `state` 对象 | `game.js:124` | 17 个字段；`justDealt`(193/1676)、`absorbSig`(393)、`dissolveWasActive`(398/2591/2599) **未在字面量声明**，靠首次赋值动态挂上 |

### 3.4 `game.js` 还剩什么没拆、为什么难拆

v108 已从 8168 行拆到 4710 行（占客户端 30.2%）。剩下的按行段实测：

| 段 | 行数 | 内容 | 为什么不拆 |
|---|---:|---|---|
| `bindEvents` 3911-4618 | **708** | 12 个嵌套 binder（`bindTableControls` 3983 / `bindGuide` 4066 / `bindProfileCards` 4236 / `bindSettleRowTap` 4259 / `bindRename` 4298 / `bindRecordsNav` 4311 / `bindAuthScreen` 4325 / `bindAccountScreen` 4351 / `bindSettleActions` 4399 / `bindKeyboard` 4450 / `bindViewportAndLifecycle` 4526） | 注释（3915）自己写明「它们全是 bindEvents 内部的嵌套函数，闭包与作用域一点没动」——**只做了视觉分块，没做单元切分**。搬出去就要把 12 个 binder 依赖的几十个局部变量显式注入，等于重写 `state` |
| `resize` 3534-3910 | **377** | 视口/安全区/版式档位/组槽预算/CSS 变量写入 | 同时读 `window` 尺寸、写 6 个 CSS 变量、调 `recomputeSlotBudget`、影响 `seatRing` 几何；是「一个函数横跨三档版式」 |
| `firstShown` 3152-3345 | **194** | 首帧可见性判定（含注释与守卫） | 依赖渲染时序，拆开就要把「首帧」概念外提 |
| `renderRoom` 451-640 | **190** | 房间页整体渲染 | 与 `renderReadyCard`/`tableReady` 状态机互锁 |
| `blockBustSubmit` 2400-2543 | **144** | 爆牌/十点半拦截与提示 | 纯业务规则却长在渲染层（**放错了层**，本该在 stateMachine/engine） |
| `askConfirm` 2617-2726 | **110** | 确认弹窗 | 与 `modalKit`(208 行) 功能重叠 |
| `renderTopBar` 839-950 | **112** | 顶栏（含圆桌/玻璃条两套） | 两套版式同函数分支 |
| `groupsSummary` 1756-1865 | **110** | 分组摘要文案 | 纯文案，可外移 |

**难拆的根因（三条）**：
1. **闭包即状态**：`state`、`$`、`esc`、`Sfx` 等全部是 IIFE 局部变量，任何外移都要重新设计注入面（v108 的 `create(deps)` 已经付过一次成本）。
2. **"只搬定义、不动调用点"是唯一敢用的手法**（`gameUtils.js:19` 明写）。搬函数体就要改调用点，几千处里漏一处是运行期炸。
3. **没有模块系统**：25 个全局脚本 + 顺序依赖，拆分没有编译期保障，只能靠 `pwa/test/helpers/gameSource.js` 事后补（该文件的注释记载「v108 拆分导致 35 个测试文件里 31 处 `readFileSync('js/game.js')` 全部假失败」）。

---

## 四、服务端结构

### 4.1 房间生命周期（事实）

```
createRoom(hub:383) ─ rooms.set(409) ─┬─ joinRoom(436) ─ ready(498)
                                      ├─ _maybeAutoStart(543)
                                      └─ startGame → ROUND1_SPLIT
   SPLIT:  _armSplitTimers(1096) → _armOneSplitTimer(1109) 每人一 timer
           key = roomId#round#playerId，幂等；超时 → SM.forfeitRound(1136)
           splitStartedAt 反推起点(1147)，重连按 MIN_RECONNECT_SPLIT_MS=15s 补时限(1159)
   SETTLE: settleRound(stateMachine:885 145 行) → 广播
   SETTLED: _persistSettlement(1042) 每人写档案（AI 不写、已删号不写、voided 不写）
           → wantNext/unWantNext(511/523) 报名制 → startNextRound
   handLimit 到顶 → endReason='handLimit' + markSettled(1335)
   异常收口: someoneLeft(1379) / dissolve(1248)
   回收:    90s 断线宽限 _startGrace(1209) → ROOM_IDLE_MS 30min _armRoomRecycle(1232) → _deleteRoom(1246)
```

### 4.2 WebSocket 协议面（事实）

- 21 个业务 `type`（`hub.js:279-299`）：`auth / createRoom / joinRoom / leaveRoom / ready / rename / start / submitGroups / beginRevise / cancelRevise / restart / wantNext / unWantNext / proposeDissolve / voteDissolve / cancelDissolve / addBot / getProfile / reconnect / peekRoom / emoji`
- 1 个应用层保活：`ping` → `pong`（`hub.js:247`）；另有协议层 WS ping/pong 心跳（`hub.js:186`）
- 统一信封：`{type, reqId, payload}`；回 `_ok(client, reqId, payload)` / `_fail(client, reqId, error)`（1276/1280）
- 身份只认连接级 `WeakMap _auth`（128），**payload 里的 playerId 一律无视**——注释记载这是修掉「排行榜/广播里 playerId 明文 → 谁都能冒充谁」的结果
- 座位恢复令牌单存 `_tokens`（123），不写进 player（避免随广播泄露）

### 4.3 持久化

| 项 | 事实 | 风险 |
|---|---|---|
| 存储载体 | `server/data/profiles.json` 单文件；`_serialize()(262)` 每次写都 `JSON.stringify` **全部档案**（仅剔除 `_seen`） | 写放大 O(N)。`MAX_PROFILES=200000`（98）意味着最坏情况一次 flush 序列化 20 万条；每次落盘都是全量重写 |
| 落盘时机 | 去抖 `FLUSH_DELAY=500`（43）→ `_flushAsync` 异步队列；同步 `flush()` 只在 reset/resetStats/remove 等「必须立刻可见」处（630/669/997/1188/1244/1279）+ 进程退出（index:1349/1362） | **崩溃丢失窗口 ≤500ms**（仅影响档案/统计，丢的是最近一把的战绩计入） |
| 原子性 | 写 `*.tmp` → `replaceFileSync` 原子替换（61） | 无半截文件风险 |
| 并发正确性 | `_writeGen` 代数 + 写入串行队列，旧快照作废（335） | 该处注释记载了「`record→flush→new ProfileStore` 偶发读到空」的真实事故，已修 |
| **房间态** | **纯内存**（`hub.rooms` Map），无任何落盘/快照 | **进程重启 = 所有进行中对局消失**；90s 宽限期救不回；玩家侧表现为 `resume` 失败回首页，且这一把的分不落库（`_persistSettlement` 未触发） |
| 失败可见性 | `flush()` 的 `catch (e) { this.dirty = true; }`（301-305）与 `_flushAsync` 的 `.catch(() => { this.dirty = true; })` **都不记日志** | 磁盘满 / 权限错 / 只读挂载 → 统计静默不落盘，线上无任何信号。同一文件里 `_quarantine`(192) 是会写日志的，说明能力已有、此处漏用 |

### 4.4 并发与限流（事实）

| 维度 | 阈值 | 位置 |
|---|---|---|
| 单连接消息 | 60 条 / 1s，固定窗口 + 连续超限 3 次踢 | `hub.js:96-98, 212` |
| 进房/建房 | 10 次 / 10s | `hub.js:82` |
| 登录失败（账号+IP） | 6 次 / 10min | `index.js:282` |
| 登录失败（纯 IP） | 30 次（`LOGIN_IP_MAX`） | `index.js:316` |
| 注册 | 12 次 / 10min | `index.js:342` |
| 前端错误上报 | 40 条 / min / IP，静默丢 | `index.js:649` |
| WS 帧 / 消息 | 1MB / 4MB（分片累积上限） | `ws.js:17,19` |
| HTTP body | 16KB（JSON） | `index.js:152` |

- **单进程单事件循环**：所有房间共享一个 loop；`ws.js:40-48` 已把收流缓冲从 O(n²) 改成摊还 O(1)（注释记实测「1 字节段灌 1MB 可钉住单核 67 秒」），这是本项目做过的最关键的性能修复。
- 未做：CPU 密集操作（`stateMachine.settleRound`、`profile._serialize` 全量）仍在主线程同步执行；无 worker、无分片、无背压（`_push` 直接写 socket）。

---

## 五、技术债清单

> 只列**有代码证据**的项。修复成本：S < 半天、M = 1~3 天、L > 3 天。

### 高

| # | 位置 | 问题 | 修复成本 | 不修的后果 |
|---|---|---|---|---|
| H1 | `pwa/js/` 26 处 + `pwa/index.html` 6 处；键名 16 个、3 套命名（`lxw_*_v1` / `weile_*` / `weile_touch`） | **平台存储未收口**：`localStorage/sessionStorage` 直连散落 9 个文件，无单一实现、无版本迁移、无统一清理 | M | 换引擎/上小程序/做加密或配额治理时要逐文件改；`weile_version_reloaded` 与 `lxw_*_v1` 混用，清理逻辑漏一个就是幽灵键。建议按 SaveStore 契约收口（`read/write/list/migrate` 四方法 + 唯一实现 `LocalStorageSaveStore` + 组合根注入），UI 与 core 只依赖类型 |
| H2 | `game.js:3911-4618` | `bindEvents` 单函数 708 行，内含 12 个嵌套 binder；注释（3913）却称「570 行的单个函数」并宣称已拆开 | M | 改任意一屏的事件绑定都要在 708 行里定位；嵌套闭包使 diff 冲突集中在同一函数，多人协作时必冲突 |
| H3 | `pwa/js/game.js` 全文件 | 4710 行、占客户端 30.2%、引 152 个外部符号；`resize` 377 行、`renderRoom` 190 行、`firstShown` 194 行 | L | 新人第一次改代码 100% 从 game.js 开始，认知负荷最高的一处正好是入口 |
| H4 | `hub.js:409`（房间仅内存） | 房间状态无任何持久化 | M~L | 进程重启/OOM/发布重启 = 所有进行中对局消失，玩家这一把的分数不落库。目前靠「发布选无人时段」这个流程约束兜着 |
| H5 | `roomStore.js:49-291`（`createLocalStore` 243 行）+ `292-867`（ws 传输） | 双传输实现常驻生产包 | M | local 演示模式只在 `?mode=local`/`file://` 用（`game.js:65-70`），但两套实现都要随每个新动作同步改（`sendEmoji`、`wantNext`、`peekRoom` 全要写两遍） |

### 中

| # | 位置 | 问题 | 修复成本 | 不修的后果 |
|---|---|---|---|---|
| M1 | `profile.js:301-305`、`338`、`_writeOnce` 的 `.catch` | **落盘失败被吞**：只 `this.dirty = true`，不写日志（同文件 `_quarantine:192` 会写） | S | 磁盘满/权限错时统计静默丢失，线上表现为「战绩莫名不涨」，服务端日志一片安静 |
| M2 | 全库 **83 处空 catch** / 262 处 catch | 空 catch 占 31.7%；其中 `game.js:81-109` 的 storage 读写吞异常尚可接受（隐私模式），但 `game.js:2842`、`hub.js:1015` 这类业务路径吞掉后无痕 | M | 排查线上问题时缺少失败分支的可观测性 |
| M3 | `settleView.js:711-737`、`hub.js:1076-1078`、`historyKit.js:43` | **`endReason` 口径三处复制**。注意：`scoreZero` 那一支**不是死代码**——`settleView.js:713-715` 明确写了「只为老战绩留着，别顺手删」，`historyKit.js:43` 的白名单同理。真正的问题不是它，而是「合法原因集合」这个事实被写了三遍，靠注释互相提醒 | S | 新增一个结束原因（比如房主退出/超时收场）要改三处，漏一处就是「结算页说解散、档案记 handLimit」。建议收口为 `stateMachine` 导出的 `END_REASONS` 常量 + 一个 `reasonText()` |
| M4 | `game.js:2446 / 2686 / 3892 / 3913`；`ws.js:6`；`settleView.js:5`；`stateMachine.js:50` | **注释与代码不符**（7 处实测）：settleView「755 行」实 846；seatSheetView「554 行」实 628；recordsView「1237 行」实 1355；bindEvents「570 行」实 708；ws.js「手写 200 行」实 303；`PHASE.SETTLED` 注释仍写「结账（有人输完）」，而 v103 后已无「输完」终局 | S | 注释是本项目**唯一**的架构文档（代码内注释密度极高、根目录 `REVIEW.md` 445KB 已不可读），注释失真 = 文档失效 |
| M5 | `pwa/js/records.js`（本机） vs `hub.js:1042 _persistSettlement`（服务端） | 两套战绩统计实现；`recordsView.js:13-17` 自己写明「两者口径必须一致 —— 服务端 `_persistSettlement` 与本机 `recordSettled` 判『作废的局不计』用的是同一个 `room.voided`」 | M | 口径一致靠注释承诺，无共享实现也无对拍测试兜底 |
| M6 | `pwa/test/` 39/67 个文件读源码文本做正则守卫 | 测试与「代码住在哪个文件」耦合；v108 拆分已致「35 个文件里 31 处 `readFileSync('js/game.js')` 全部假失败」，靠 `test/helpers/gameSource.js` 事后补 | M | 下一次拆分仍会集体假失败；且源码守卫只证明「这行代码存在」，不证明「行为正确」 |
| M7 | `pwa/index.html` 内联脚本 ≈176 行 | boot 关键逻辑（sharecode 自愈、预缩放、防闪、flex-gap、版本自检）不在模块体系内 | M | 无法被 require 测试覆盖；改内联脚本没有任何回归网。且 `window.LXWBusy`（唯一跨层契约）无测试 |
| M8 | `profile.js:262 _serialize` | 每次落盘全量序列化所有档案 | M | 档案量线性增长时 flush 抖动增大；`MAX_PROFILES=200000` 的护栏本身说明预计到这个量级 |
| M9 | `server/index.js:685-1340` | 路由是 ≈655 行线性 if 链 + 管理台嵌套 if（1168-1330 用对象做白名单） | M | 每加接口改 chain；路由无法枚举（无法自动生成接口清单/做统一鉴权中间件） |

### 低

| # | 位置 | 问题 | 修复成本 | 不修的后果 |
|---|---|---|---|---|
| L1 | `avatar.js:149` vs `gameUtils.js:48` | `esc()` 重复实现两遍 | S | 一处修 XSS、一处忘修 |
| L2 | `game.js:124` 的 `state` 字面量 | `justDealt` / `absorbSig` / `dissolveWasActive` 三个属性未声明，靠动态赋值 | S | 状态形状不可枚举；`JSON.stringify(state)` 排查时字段位置散乱 |
| L3 | `game.js:2006` `dragThreshold(){return 10}`、`game.js:268` toast `2600/1800`；`style.css` **1088 处 px 字面量** | 魔法数字（多数版式常量已命名如 `RING_COMPACT_BELOW:1021`，这两处是残留） | S | 手感调优要搜数字 |
| L4 | `game.js:2617 askConfirm`(110 行) vs `modalKit.js`(208 行) | 确认弹窗两套实现 | S | 样式与 a11y 行为不一致 |
| L5 | `game.js:2400 blockBustSubmit`(144 行) | 爆牌拦截属**规则判定**，却写在渲染层 | S | 无法被 stateMachine 单测覆盖；服务端不校验同规则 → 客户端绕过风险需核对 |
| L6 | `eslint-disable` 3 处 | 全在测试里（`no-new-func`），生产零豁免 | — | 无需处理（记录在案） |
| L7 | 全库 `TODO/FIXME/HACK/XXX` = **0**；`console.log` 生产 2 处（`index.html:1245`、`server/index.js:94` 的 `log()` 实现） | 已被清理干净 | — | 无需处理（正面结论） |
| L8 | `roomStore.js` 头注释（「restart 仅为兼容旧客户端保留，新代码不要用」）+ `stateMachine.js:1182` + `hub.js:661` | **半死代码**：`restart` 三条链路都在，但没有新调用方。全库真正的死代码只有这一类「显式保留的兼容路径」，没有任何未被引用的函数（`grep` 无孤立导出） | S | 保留成本极低；风险是新人照抄旧路径。建议在 `stateMachine` 里加一行 `// @deprecated 见 roomStore 头注释`，别删（老客户端还在线上） |

---

## 六、可维护性度量（实测）

### 6.1 最大文件 TOP10

| # | 文件 | 行数 |
|---:|---|---:|
| 1 | `pwa/css/style.css` | 5138 |
| 2 | `pwa/js/game.js` | 4710 |
| 3 | `pwa/js/stateMachine.js` | 1516 |
| 4 | `server/profile.js` | 1403 |
| 5 | `server/index.js` | 1370 |
| 6 | `server/hub.js` | 1366 |
| 7 | `pwa/js/recordsView.js` | 1355 |
| 8 | `pwa/js/roomStore.js` | 987 |
| 9 | `pwa/js/settleView.js` | 846 |
| 10 | `pwa/css/records.css` | 815 |

> 口径：`wc -l` 实测（含注释与空行）。本项目注释密度极高（`config.js` 179 行里约 100 行是注释），因此「行数」不完全等于「代码量」——这是它 4710 行的 game.js 仍能读的原因，也是它最难交接的原因。

### 6.2 最长函数 TOP10（估算）

**估算方法**：取各文件「顶格两空格缩进的顶层 `function` 声明」为函数起点，相邻两个顶层声明之间的行数即上界（含函数内注释、空行、以及**4 空格缩进的嵌套函数体**）。已对下表每一项手工核对起点与下一声明行号，因此数值可复现。
**局限**：4 空格嵌套函数不切分区段——这正是 `bindEvents` 统计出 708 行的原因（它内部有 12 个嵌套 binder），也是本条度量要暴露的事实；纯行数不等于逻辑复杂度。

| # | 函数 | 文件:行 | 行数 |
|---:|---|---|---:|
| 1 | `bindEvents` | `game.js:3911-4618` | 708 |
| 2 | `resize` | `game.js:3534-3910` | 377 |
| 3 | `createLocalStore` | `roomStore.js:49-291` | 243 |
| 4 | `firstShown` | `game.js:3152-3345` | 194 |
| 5 | `renderRoom` | `game.js:451-640` | 190 |
| 6 | `settleRound` | `stateMachine.js:885-1029` | 145 |
| 7 | `blockBustSubmit` | `game.js:2400-2543` | 144 |
| 8 | `apiQuery` | `recordsView.js` | 121 |
| 9 | `resultGroupCard` | `settleView.js:219-332` | 114 |
| 10 | `renderTopBar` / `askConfirm` / `groupsSummary` | `game.js:839-950 / 2617-2726 / 1756-1865` | 112 / 110 / 110 |

> 附：`stateMachine.submitGroups`(743-833) 91 行、`settleView.renderResultStep`(389-492) 104 行、`hub._persistSettlement`(1042-1089) 48 行。

### 6.3 计数类指标

| 指标 | 数值 | 口径 |
|---|---:|---|
| `TODO / FIXME / HACK / XXX` | **0** | `grep -rn` 扫 `pwa/js` + `server`（含中文「待办」为 0） |
| `console.log` 生产残留 | **2** | `pwa/index.html:1245`（SW 重载日志）、`server/index.js:94`（`log()` 实现本身） |
| `console.warn / error` 生产 | **1** | — |
| `eslint-disable` | **3** | 全在 `pwa/test/`（`no-new-func`），生产代码 **0** |
| 空 `catch` | **83** / 262 处 catch（31.7%） | `grep -c "catch *(.*) *{ *}"` |
| 直连平台存储 | **32 处 / 9 个文件 / 16 个物理键 / 3 套命名** | 见 H1 |
| `!important`（style.css） | 16 | 其中含 `index.html:158` 注释提到的 2 条「压住首页」规则 |
| `@media`（style.css） | 9 | 断点散落，与 `ringGate.js` 的 1200/700 需人眼同步 |
| CSS px 字面量 | **1088** | `style.css` |
| 测试文件 | **109**（pwa 67 + server 42） | `*.test.js` 实测 |
| 测试行数 : 生产行数 | **1.07 : 1** | 21890 : 20472 |
| 源码正则守卫测试 | **39 / 67**（pwa） | 读 `readFileSync/gameSource/readOne` 的文件数 |
| 引用真实模块的测试 | **41 / 67**（pwa） | `require('../js/...')` |
| 近 30 次提交热点 | `game.js` 12 次、`index.html` 11 次、`sw.js` 10 次、`style.css` 10 次 | `git log --name-only` 统计 |

---

## 七、工程维度评分

| 维度 | 分数 | 依据 |
|---|---:|---|
| **架构清晰度** | **8 / 10** | 扣分：分层图清楚、纯逻辑（stateMachine/engine/card/config/ai/emoji）单份前后端共用、`text.js` 收口三份昵称清洗、`_persistSettlement` 单一收口——这些都是好架构的证据；但 `game.js` 4710 行仍是「渲染 + 交互 + 拖拽 + 引导 + 视口」五合一，25 个全局脚本靠 HTML 顺序表达依赖，两套模块挂载约定（16 个 `window.X` vs 8 个 `window.LXW.x`）并存。 |
| **代码质量** | **7.5 / 10** | 加分：`TODO` 0、生产 `eslint-disable` 0、`console.log` 2、命名常量而非裸数字（`RING_COMPACT_BELOW/RING_MIN_LS_STAGE_H`）、原子写 + 写入代数 + 幂等键、6 类限流齐备、逐条记录「踩过的坑」的注释密度罕见。扣分：83 处空 catch（关键落盘路径失败无日志）、7 处注释与代码不符（含 4 处过期行数）、`endReason` 「合法原因集合」在三处各写一遍、`esc()` 双份、`state` 三字段未声明。**未发现真正的死代码**——仅有的遗留路径（`scoreZero` 文案、`restart` 动作）都在注释里写明了保留理由。 |
| **可测试性** | **8 / 10** | 加分：测试:生产 = 1.07:1，109 个文件，跑批器会扫目录（`scripts/run-tests.js` 的注释记载了「手写长链导致 7 套测试从未被跑过」的教训并已根治），纯逻辑模块零外部依赖（engine/card/seatRing/slotLayout/ringGate/avatar）天然可单测。扣分：39/67 pwa 测试是源码正则守卫而非行为断言（v108 拆分时集体假失败已发生一次），176 行 boot 内联脚本 + `window.LXWBusy` 跨层契约无测试，`?mode=local` 双传输只有一条通路被覆盖。 |
| **性能余量** | **6.5 / 10** | 加分：零运行时依赖、手写 WS 已把收流改为摊还 O(1)（实测 1830 倍差异的修复）、gzip 缓存上限 96、帧/消息/消息速率三重上限、心跳区分「后台挂起」与「连接真死」、计时器全部 `unref`。扣分项是结构性的：单进程单核，`profile._serialize` 每次落盘全量序列化（`MAX_PROFILES=200000` 时写放大 O(N)）、`settleRound` 在主线程同步跑、广播是全量房间快照（每帧 O(玩家数×手牌)）、`engine.resolveTenHalf/resolvePiaoSanYe` 每次比牌枚举 48/52 张候选。好友房量级（≤5 人/房、数十房）绰绰有余，量级上一台阶就要动这几处。 |
| **新人上手容易度**（分高=容易） | **6 / 10** | 加分：根目录 `README.md` 31KB、`docs/` 14 份专题、`overview.md`、代码内注释能解释「为什么这么写」而不只是「写了什么」，`COMMITS.md` 有迭代史。扣分：上手必须先接受 4 个反直觉前提——① 25 个 `<script>` 顺序即依赖图；② 两套挂载约定；③ 15.6k 行中文注释密度（对非中文协作者是门槛）；④ `scripts/` 57 个脚本 / 20941 行无索引，探针、模拟、审计混在一层，不知道哪个还能跑。改一行代码前要读 300 行注释，这既是它的护城河也是它的门槛。 |

**加权印象**：这是一个「注释与测试投入远超同类一人项目」的代码库，工程质量的实际水位高于代码形态给人的第一印象。真正的结构性欠账只有三笔：**平台存储未收口**（H1）、**game.js 的 708 行事件容器**（H2）、**房间态无持久化**（H4）。这三笔都不是「写坏了」，而是「迭代到 v108 后规模超过了当初的形态」。

---

## 附：三条建议的动手顺序（供 v109 排期参考）

1. **先做 H1（存储收口）**：改动面小、无行为变化、收益最大。契约按 `SaveStore`：`read<T>(key): T|null`（不抛，解析失败返回 null）/ `write<T>(key, v): void`（失败抛错）/ `list(): string[]` / `migrate(from, to): void`（不丢数据、幂等）。唯一实现 `LocalStorageSaveStore` 承载全部 16 个物理键与序列化；组合根注入；core/UI 只依赖类型。验收：`pwa/js` grep 无 `localStorage.` 字面调用（`index.html` 内联那 6 处改为读写 `window.LXW.save`）；实跑 v1→v2 迁移不丢数据；换成内存桩可验证上层只依赖接口。
2. **再做 M1（落盘失败可观测）+ M3（endReason 收口）**：都是 S 级成本，直接降低线上排查成本。
3. **H2（bindEvents 拆容器）单独排期**，且**只搬定义不动调用点**（沿用 v108 已被验证的手法），拆之前先给 12 个 binder 补「handler 真被调用」的计数断言——目前事件绑定层几乎没有行为断言，这是拆分前必须先补的网。
