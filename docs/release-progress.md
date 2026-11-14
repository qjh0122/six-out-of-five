# 上线进度表（每次发布都更新这里）

> 用途只有一个：**让「现在到几成了」有一致的口径**，不要凭感觉报数。
> 每次发布（= 一次提交 + 一轮全绿验收）在下面加一行，并把顶部百分比改掉。

## 口径：100% 怎么分

权重按「出事概率 × 出事代价」定的，不是按代码行数：

| 阶段 | 内容 | 权重 | 累计 | 状态 |
|---|---|---:|---:|---|
| P0 | 设计稿：原型 + 规则直连引擎 + 分数级 e2e + 单文件交付 | — | 0% | ✅ |
| R1 | 常量收敛（`MAX_PLAYERS` 只留一处）+ 人数 2–5（含老 8 人房兼容） | 15% | **15%** | ✅ |
| R2 | 准备态长在牌桌上（`CONFIG.TABLE_READY`）+ 回滚开关 | 30% | **45%** | ✅ |
| R3 | 战绩页扩容（6 项指标，缺数据的显示「—」） | 10% | **55%** | ✅ |
| R4 | 表情 / 短语（唯一碰 WS 协议的一项） | 20% | **75%** | ✅ |
| R5 | v83：组级写分 + 见底当场出局 + 牌型特效 | 20% | **95%** | ✅ |
| R6 | 灰度就绪 + 回滚演练 + 文档收口 | 5% | **100%** | ✅ |
| R7 | 圆桌第一期：竖屏座位环 + 中央公共区（**新需求**，不计入上面那 100%） | — | — | ✅ |
| R8 | 圆桌第二期：横屏「左桌右盘」+ 两档闸门 + 就位态口径 | — | — | ✅ |
| R9 | 圆桌第三期：iPhone 横屏（两列两行组槽）+ 矮屏紧凑档 + 桌面宽横屏 | — | — | ✅ v89 / v90 / v91 |
| R10 | 牌型反馈：组槽实时牌型 + 真跑审计 + 特写幕 | — | — | ✅ v92–v98 |
| R11 | 局数成为唯一终局：建房选局数 → 结算统一 → **删掉爆分终止** | — | — | ✅ v99–v103 |
| R12 | 文档与实现对齐：冠军口径 + 注释清理 + CSS 降级 | — | — | ✅ v104 |
| R13 | 三族支持：iPhone / 安卓横屏 / 电脑（闸门纯函数化 + 字号热区反算） | — | — | ✅ v105 |
| R14 | 电脑窄高窗口（左右分屏）改走横版 + `--assert` 拆硬门/软门（**范围裁定：平板·折叠屏可不支持**） | — | — | ✅ v105 |
| R15 | 全流程 UI 巡检（`probe-ui-flow.js`，12 视口 × 12 屏）+ 修 9 处既有 UI 缺陷 | — | — | ✅ v105 |
| R16 | 三个用户实测反馈：①起始分归 0 ②「改一下」不再被别人的提交抢先结算 ③满组拖拽交换 | — | — | ✅ v106 |
| R17 | 座位面板的信息档不再重复一遍战绩卡（点一次头像 = 看到全部） | — | — | ✅ v107 |
| R18 | **让清单自己可信**：上报链路补最后一跳 + 37 个探针建台账 + 首次全量实跑 + 三份文档状态校准 | — | — | ✅ v129 |

## 当前状态（唯一权威 · 2026-11-11 核对）

> **本文件按版本正序追加**：下面从 v108 一路写到 v140，每一段写的都是**当时**的线上事实。
> 判断「现在是什么」只看**本卡片**与**文件最后一段**；中间任何一段里的「线上」「当前」
> 都是那一版发布时写的，不是现状。

| 项 | 现在的值 | 怎么复算 |
|---|---|---|
| 线上版本 | `20261112e` / sw `v149` | `grep -o '2026111[0-9a-z]*' pwa/index.html`；`grep 'CACHE_NAME' pwa/sw.js` |
| 线上核对 | **15/15 通过**（2026-11-11 指定头像版 `20261111c` 发布后实跑；版本号回读 = `20261111c`，无 JS 异常 / 无 console.error / 无 HTTP≥400 / SW 已接管 / installability 0 错） | `node scripts/probe-online-smoke.js <url>` |
| 指定头像 | **5 人**（playerId → 文件名见 `pwa/js/avatar.js` 的 CUSTOM 表；仓库里不写昵称）。`pwa/assets/avatar-custom/` 下 5 张 128×128 webp，线上逐个 200 `image/webp`、体积与本地一致；映射键是 playerId 不是昵称。其余玩家仍走 48 款预设 | `curl -o /dev/null -w '%{http_code} %{size_download}' "<url>/assets/avatar-custom/will.webp?sharecode=<sc>"` |
| 牌堆 | **54 张**（52 真牌 + 大王 + 小王）。小王 2026-11-12 加入，rank 14.5；两张王功能完全一样（都万能），只有「该比王的地方」大王才压小王 | `node -e "console.log(require('./pwa/js/card.js').createDeck().length)"` |
| 成就目录 | **39 条**（牌型 8 / 对撞 8 / 通吃通赔 8 / 战绩 15）。稀有度按线上实测标定，不是拍的：legend 12 · epic 3 · rare 8 · normal 18 | `npm run ach:unlock-stats` |
| 成就事件日志 | **已启用**：`/api/backup/events` 回 `ok:true`；18 份档案全部冻上基线，时刻**同一个** `2026-11-11T13:20:03Z`，`20261111b` 重启后**未移动**（第一版漏了排队落盘，见十二） | `curl -H 'x-backup-key: <key>' "<url>/api/backup/events?since=0&sharecode=<sc>"` |
| r9/r10/r12 历史错数 | **已清零且仍是 0**（9 份档案 / 27 格 + 基线 27 格；`20261111b` 发布后预演回读 `cells: 0`、`baseCells: 0`）。原值：全操 235 场却 `r12=777`、`r10=234`、`r9=271`；最大一档 `r12=801` | `npm run ach:reset -- --keys r9,r10,r12`（预演，应回 0 格） |
| 管理后台 | 线上 `/admin.html` 可用（三页签：用户管理 / 模拟对战 / 排行榜）；真浏览器登录 **12/12**，错误密钥反向 **8 条全红**。密钥取自 `server/backup-key.txt`（gitignore，未入库），旧值备份在本机 `.workbuddy/` | `curl -H 'x-backup-key: <key>' "<url>/api/admin/users?sharecode=<sc>"` |
| 全量回归 | **169 文件 / 7041 断言 / 0 失败**（含 `doc-consistency.test.js` 39 项、`bot-runner.test.js` 28 项、`bot-split.test.js` 11 项、`bot-hand-delta.test.js` 12 项、`admin.test.js` 59 项、`achievements-catalog.test.js` 17 项、`achievements-room-level.test.js` 19 项） | `npm test` |
| 探针台账 | **42 条**（`ci` 5 / `manual` 18 / `oneshot` 19） | `npm run probes:check`；真源 `scripts/probes.json` |
| 几何判定工具自验 | **10/10**（6 组已知答案样本 + 2 个采集器合规），M8 变异下退出码 1 | `npm run qa:geom` |
| CSS 规模 | 6888 行（style 5645 / records 1243） | `wc -l pwa/css/style.css pwa/css/records.css` |
| B3 进度 | v136 撤销 · v137 四态/错误分级 · v138 数字阶梯 · v139 离开撤销三屏锚点 / 320 策略行 / 工具自验；**仍欠真人试玩**（`BACKLOG.md` N-4） | [`PLAN.md`](./PLAN.md) §P8 |
| 代码同步 | **代码提交** HEAD `7191a8f`（5 位玩家指定头像；前一个 `edb2b7d` 是成就门槛 / 稀有度标定 / 目录扩到 39 条） | `git status -sb`；`git log --oneline -1 -- server pwa scripts` |

### 历史记录：v129 / v133 段落（当时，保留原文数值）

**当时线上：`20261102v` / sw `v133`（v133）** —— 这一轮**没有新功能**，只有工具与文档；
唯一进入 `pwa/` 的改动是 `index.html` 里一段注释（首屏降级口径，原来是错的）。
线上冒烟 **15/15**（浏览器实测版本号 `20261102r`、直抓 `sw.js` 确认 `CACHE_NAME = 'weile-liuxuanwu-v129'`）。
全量 `npm test` **145 文件 / 5630 条断言**；`journey` **158 项**；`probe-ui-flow` 竖/横各 1 视口 × 13 屏 ALL PASS。
探针全量实跑（37 条串行 931 秒）：**绿 28 / 红 7 / 超时 1**，红的那 7 条逐条归因见 [`PROBES.md`](./PROBES.md)。

> **为什么"没功能的版本"也要发**：`index.html` 变了（哪怕只是注释），
> 不 bump 缓存的话线上跑的和仓库里的就是两份不同的文件 —— 那正是这一轮在治的病
> （「文档说 A、实际是 B」）。发一次，是为了让「线上 == 仓库」这句话继续成立。

> 上一版（v121）：`20261102j` / sw `v121` —— 修三人局两个人点就把第三个判成旁听（开局门槛改「等所有真人表态」）+ 就位态与旁听态叠穿。
> **注意：v122–v128 的线上记录没有逐版回填到这里**（只写进了提交信息与 REVIEW）。
> 这本身就是这一轮要治的问题之一 —— 版本现状的"唯一权威"缺了 7 版。
> 后面补历史不划算，从 v129 起回到一版一行。

> 上一版记录（历史，保留）：`20261101a` / sw `v108`（v108）—— `game.js` 跨文件拆分（提交 `b064af6`），
线上冒烟 15/15：浏览器实测版本号 `20261101a`、直接抓线上 `sw.js` 确认
`CACHE_NAME = 'weile-liuxuanwu-v108'`、8 个新脚本全部出现在线上 `index.html`、
无任何 HTTP ≥ 400。
上一版 v107（`20261031w` / sw `v107`，提交 `e5d89e7`）—— 信息档合进整张战绩卡，
线上冒烟 15/15：版本号 `20261031w`、`CACHE_NAME = 'weile-liuxuanwu-v107'`。
全量 `npm test` **109 文件 / 4502 项**；`probe-devices --assert` **三族硬门 23 档全绿**
（iPhone 5 / 安卓 5 / 电脑 13，四条硬指标 + 三族必须有档位进桌），
平板与折叠屏 24 项记录单列、不阻塞发布。
`probe-ui-flow` **12 视口 × 13 屏 = 156 屏，五类硬问题 0 项、拖拽交换 12/12 通过**
（软问题：热区 30~44 共 226 条、滚动容器底边半行硬切 1 条 —— 均为已知登记项，不阻塞发布）。

R7–R13 都是这 100% 之后的新需求，所以不计权重 —— 加它们不是为了让百分比好看，
是为了「哪些需求已经关了」有地方可查。

P0 不计权重：它是「设计稿」，不改变线上行为，但**是后面每一档的前提**——没有它，
R2~R5 都会变成「照着手抄一份规则」的老路。

## 为什么 R2 占 30%（最大一块）

它同时满足三件事：改的是玩家第一眼看到的界面、动的是**已有事件绑定**（搬节点）、
且要在三种版式（竖屏 / 横屏 / 矮屏）下都不压字不出屏。任何一条没做到，
玩家看到的就是「按钮点不动」或「画面挤成一团」——单测抓不到，只有真浏览器能抓。

## 每次发布的记录

### R1 · 15%（提交 `a3c9c96`，版本 `20261030x` / sw `v82`）

- `config.MAX_PLAYERS` 8 → 5；删掉 `server/hub.js` 里自己抄的 `const MAX_PLAYERS = 8`
- 建房时把上限抄进 `room.cap`，之后一律读 `StateMachine.capOf(room)` —— 上线当天在打的 8 人房不会被踢
- 新增 `pwa/test/player-cap.test.js`（23 条）：新房间第 6 人被拒 / 老 8 人房仍坐满 / cap 缺失时退回配置
- 验收：`npm test` 84 文件 3031 断言；`journey` 114 项

### R2 · 45%（版本 `20261030y` / sw `v83`）

**改了什么**

| 文件 | 改动 |
|---|---|
| `pwa/js/config.js` | 新增 `TABLE_READY: true`（唯一回滚开关） |
| `pwa/index.html` | `#screen-game` 里加 `#table-ready`（`#tr-head` / `#tr-card`）与 `#ready-acts` |
| `pwa/js/game.js` | `mountTableReady()` 用 `appendChild` **搬**房间页那几块节点（id 不改）；`showReadyTable()` / `exitReadyTable()` / `renderReadyCard()`；`render()` 在 `WAITING` 与就位态先走牌桌 |
| `pwa/css/style.css` | `.table-ready` / `.tr-card` / `.ready-acts`；`.ls #screen-game.is-ready` 两栏栅格 |
| `pwa/js/game.js` | 顶栏座位在就位态显示「已准备 / 还在结算」而不是「已提交」 |
| `pwa/css/style.css` | 顺带修旧账：安装提示条 `20→27 / 19→28` 设计 px（横屏只有 0.52 缩放，原来落到 9.9 CSS px） |

**关键取舍：座位只画一套。** 对局页顶栏本来就把每个人的「已准备 / 未准备」画在头像角标上，
所以准备态直接复用它，不另写座位环 —— 否则两套座位样式一定会慢慢跑偏（原型里那张
椭圆座位环是设计稿的表达，线上对局页是「桌沿 + 组槽」的纵向结构，硬搬会变成第三种布局）。

**验收（全绿）**

```bash
npm test                                 # 85 文件 / 3060 断言
node scripts/journey.js                  # 117 项（含「准备态长在牌桌上」「就位态也在牌桌上」两条新断言）
node scripts/probe-table-ready.js        # 33 项：竖屏 / 横屏 / 回滚路径，含「按钮搬过去还能点」
node scripts/probe-safearea.js           # 31 项（新增：准备卡的横屏最小字号）
node scripts/probe-landscape-screens.js  # 22 项
node scripts/probe-room-actions.js       # 20 项
node scripts/probe-viewport-fit.js       # 27 项
node scripts/probe-ready-button.js       # 8 项
node scripts/probe-leave.js              # 19 项
node scripts/probe-prev-result.js        # 布局
```

**回滚**：`CONFIG.TABLE_READY = false`，或灰度期直接让人开 `?tableready=0`。
关掉后节点不会被搬，行为与 R1 完全一致（`probe-table-ready.js` 的第二段专门验这条）。

### R3 · 55%（版本 `20261030z` / sw `v84`）

**先说结论：6 项 KPI 本来就是全的。** 计入分析文档 §13.4 的六项
（总局数 / 总胜局 / 总胜率 / 最高连胜 / 单局最高 / 总得分），线上战绩页早就都有，
只是分在汇总卡和纪录条两块里。所以这一档真正的新增只有**牌风雷达**，
以及「算不出的维度必须显示「—」」这条规矩。

**改了什么**

| 文件 | 改动 |
|---|---|
| `pwa/js/styleStats.js` | 新增。五维口径的纯函数：`compute(rows)` → 五维 `[{label, value\|null, n, note}]` |
| `pwa/js/game.js` | `renderRadar()`：手写 SVG 五轴 + 虚线轴 + 「—」前缀 + `aria-label` 逐维播报 |
| `pwa/index.html` | `#rp-mid` / `#rp-kpi` / `#rp-style`（`#rp-radar`、`#rp-style-n`、`#rp-style-note`） |
| `pwa/css/records.css` | 雷达卡；中段排版（竖屏上下排） |
| `pwa/css/style.css` | 横屏并排 280 列宽；**汇总卡改横排**让出 86 设计像素 |
| `pwa/sw.js` | `PRECACHE` 加 `/js/styleStats.js`；缓存名 `v84` |
| `pwa/test/style-stats.test.js` | 新增 38 条 |
| `scripts/probe-records-radar.js` | 新增 23 项 × 2 朝向 |

**五维里四维已经算得出，「策略」仍是空的**

| 维度 | 公式 | 能不能算 |
|---|---|---|
| 防守 | 1 − 我见底局数 / 因见底结束的局数 | ✅ 判据 `endReason==='scoreZero'` 且 `净胜 ≤ −初始分` |
| 获胜 | 近 20 局胜率 | ✅ |
| 速度 | 场均每把用时（30 秒满格 / 150 秒零分） | ✅ R5 起发牌写 `handStartedAt`，封账在 `closeHand()` |
| 互动 | 场均表情条数 | ❌ 表情还没上线（R4）→ **R4 已点亮**，见下文 |
| 策略 | 主动收手比例 | ❌ 需要新埋点（唯一还空着的一维） |

三条规矩写死在 `style-stats.test.js` 里，将来谁想「顺手补个默认值」都会红：

1. 算不出 → `value: null`，界面显示「—」，并说明为什么；
2. 样本 < 3 局 → 整块不画（1 局没见底就是 100% 防守，是在骗人）；
3. 分母只取 `scoreZero` 局 —— 因缺人/解散结束的局里「见底」根本没被判定过。

**速度维的坑（R3 时判断过一次，R5 才补上）**：`createdAt → settledAt` 含等人和暂停，
拿它除以把数等于把等待算成思考时间，那就是造数。所以 R5 记的是
`dealAll()` 那一刻（`handStartedAt`）到这一把封账（`closeHand()`）之间的时间：
一把 = 发牌 → 本轮结束，中途挂机有两轮各 60 秒的分牌超时兜底，不会无限长。
「第一轮结束」**不封账**——那只是一把的一半，算进去会让场均偏小。

**图形上的两条硬规则**

- **不足三维不连成面**，只画「中心 → 这个值」的辐条。两维连成面一定是三角形，
  那个三角形的两条边是凭空补出来的 —— 视觉上等于给没有数据的维度填了 0。
- **网格照画**。空图要能看出「这里本来是五维」，而不是消失一整块。

**排版：两个朝向两种排法**

竖屏缺宽度不缺高度 → 雷达单独占整行（图高 300 设计像素）。
横屏缺高度不缺宽度 → 与「三卡 + 纪录条」并排（280 宽），中段高度取两者较大值。

第一版竖屏也写成并排，实测雷达只有 116×73 CSS px（一个 3cm 见方的图），
五维标签各 10px —— 等于「有雷达但读不出来」。探针现在有一条断言专门守这个尺寸。

**横屏为它让出的 86 设计像素从哪来**

加雷达之前左栏余量 18 设计像素；带安全区（刘海 + home indicator）实测 slack = −32，
现象是「最近 10 局」被裁掉一截。先试收留白、收字号，收到数字只剩 44 号也只让出 22。
最后发现浪费在汇总卡自己身上：竖排三行里一半是行距。横屏本来就是宽度富余，
所以把「累计净胜 / 大数字 / 场次·胜率」排成一行，高度 157 → 71，
三卡、纪录、趋势的档位全部保持原样。现在 slack = 42~47。

**验收（全绿）**

```bash
npm test                                  # 86 文件 / 3098 断言
node scripts/journey.js                   # 117 项
node scripts/probe-records-radar.js 390 844   # 23 项（竖屏）
node scripts/probe-records-radar.js 844 390   # 23 项（横屏）
node scripts/probe-safearea.js            # 31 项（含「横屏最小字号 ≥ 11 CSS px」）
node scripts/probe-records.js             # 20 项
node scripts/probe-records-cloud.js       # 52 项
node scripts/probe-landscape-screens.js   # 22 项
node scripts/probe-viewport-fit.js        # 27 项
node scripts/probe-room-actions.js        # 20 项
node scripts/probe-table-ready.js         # 33 项
node scripts/e2e-score.js                 # 1929 项 / 0 失败
node scripts/review-rule-parity.js        # 0 不一致
node scripts/build-proto.js --check       # 产物与源同步
```

**回滚**：纯展示层，不写任何数据、不进回放、不影响分数与排行榜。
`git revert` 这个提交即可；灰度期若只想先关掉，把 `#records-data .rp-mid` 里的
`.rp-style` 加 `display:none` 就退回 R2 的样子（`.rp-kpi` 会自然铺满整行）。

---

## R4 · 75%（版本 `20261031a` / sw `v85`）

表情 / 短语 —— 唯一一档碰 WS 协议的改动，也是唯一一档「素材质量决定成败」的改动。

**改了什么**

| 文件 | 改动 |
|---|---|
| `scripts/crop-emoji.py` | **重写**。13 张表达式从原图重抠（见下面「素材」） |
| `pwa/assets/emoji/*.png` | 13 张 96×96 重出（原型目录同步一份） |
| `pwa/js/emoji.js` | **新增**：13 表情 + 8 短语的唯一清单，前后端同源 |
| `pwa/css/emoji.css` | **新增**：顶栏入口、面板、飞行动画层、横屏 7 列 |
| `pwa/index.html` | `#btn-emoji` 由 `renderTopBar` 生成；`#emoji-modal`；`#emoji-layer`（**在 `#stage` 外面**） |
| `pwa/js/game.js` | 面板渲染 / 发送 / 接收 / 飞行动画；`syncEmojiHand` 按把清零；战绩写 `myEmoji` |
| `pwa/js/roomStore.js` | `sendEmoji` / `onEmoji`，local 与 ws 两个 mode 都实现 |
| `server/hub.js` | `case 'emoji'`：白名单 + 2 秒限流 + **旁路广播**，不写 room、不回 reqId |
| `pwa/js/styleStats.js` | 「互动」维接上真数据（场均表情条数 / 6） |
| `pwa/js/records.js` | 字段白名单收 `myEmoji`（缺失 ≠ 0） |
| `pwa/sw.js` | 预缓存 13 张图 + `emoji.js/.css`；缓存名 `v85` |
| `pwa/test/emoji.test.js` | 新增 63 条 |
| `server/test/emoji.test.js` | 新增 21 条 |
| `pwa/test/style-stats.test.js` | 38 → 62 条（互动维 24 条） |
| `scripts/probe-emoji.js` | 新增 35 项 × 2 朝向 |
| `scripts/probe-records-radar.js` | 23 → 32 项（互动维点亮 / 不够 3 局仍「—」） |

**协议：只转发，不落库**

```
客户端 → 服务端   { type:'emoji', payload:{ to:'*'|playerId, id } }
服务端 → 同房间   { type:'emoji', payload:{ from, to, id, at } }
```

- 表情**不进 `room` 对象**（测试直接断言 `JSON.stringify(room)` 里没有 `"emoji"`），
  于是天然不落库、不进回放、不进云同步 —— 这三件事一次都不用单独做。
- **旁路广播**：不走 `_broadcast`，而是直接遍历 `conns` 推同房间的连接。
  走 `_broadcast` 的代价是每次表情都要整桌重绘，而且会被 `_persistSettlement` 顺手落库。
- **不做乐观渲染**：自己发的那条也从回程路径回来。链路断了自己先看不见，
  比「我能看见、别人看不见」好在当场暴露。
- 未知请求类型：`default: return this._fail(...)`，连接不断、ping 仍有回应
  （`server/test/emoji.test.js` 第 5 组专门验这条，老客户端不会被打断）。
- 限流两层：服务端 2 秒一条**静默丢弃**（不回声，避免连点的人以为是网络问题），
  客户端同一档只给提示。键是 `playerId` 不是连接 —— 否则开两个标签页就能翻倍。
- 清单**双端同源**：`pwa/js/emoji.js` 一份，前端 `<script src>` 用 `global.Emoji`，
  服务端 `require()` 做白名单。这个仓库被「两处配置」咬过两次
  （`hub.js` 私抄 `MAX_PLAYERS`、原型手抄 `engine.js`），这次一开始就只放一份。

**素材：旧图的「坏边」是四个毛病叠出来的**

重抠之前先定位，四条各自都会留下坏边：

1. **二值 alpha**（只有 0/255）→ 抗锯齿过渡带被硬切，缩到 40~60 CSS px 就是毛刺；
2. **没去底色污染** → 过渡带像素是 `前景×覆盖率 + 浅紫背景×(1−覆盖率)`，
   深色毡面上一圈淡紫光晕；
3. **逐格拉满 96×96** → 相对大小全乱（带披风的恶魔被缩小、圆脸被放大），
   还会把伸出去的部件切掉；
4. **把源图自带的软投影当球体抠进来** → 灰雾。

对应的解法（`scripts/crop-emoji.py`）：

| 毛病 | 解法 |
|---|---|
| 二值 alpha | α 由**投影解算**得出：`a = ⟨P−B, F−B⟩ / |F−B|²`，B 取最近背景像素、F 取向内缩 2px 的纯色；再 ×4 超采样 |
| 底色污染 | `F = (P − (1−a)·B) / a` 反解，边缘不再带浅紫 |
| 逐格拉满 | **共同画框**：13 张同一缩放系数（`BOX=80`，内容占 48~53%），相对大小保持原样 |
| 自带投影 | 投影 = 背景色的等比压暗（饱和度不变、亮度 ≥ 0.45×背景）；从画布四边 `binary_propagation` 泛洪，只吃与外界连通的部分，白牙/眼高光被球面包住进不来 |
| 缩小发灰 | 在**预乘 alpha 空间**缩放，透明像素的黑不渗进边缘 |

部件不被切的关键：行列中心用一维聚类算（`[68.0, 209.4, 350.4]` / `[60.5, 156.4, 248.8, 345.2, 439.4]`），
再按「质心落在哪一格」把连通块分给表情 —— 泪滴、帽子、披风因此跟着本体走，不会被分给邻格。

自检输出：13/13；包围盒 64~68 × 58~65；**无一贴边**（0 像素）；边缘半透明占 2.8~5.7%。

**飞行动画：两个坑都是「看起来只是位置不对」**

- **CSS animation 会整个覆盖 transform**。回弹动画 `emojiPop` 本来写在外层，
  一跑就把 `translate3d` 清成 identity —— 表情跳回屏幕左上角。
  拆成 `.emoji-fly`（外层管位置，`transition`）+ `.emoji-pop`（内层管回弹，`animation`）。
- **过渡起点必须先提交**。插入节点时写 transform 会被合成一次属性变化，
  过渡起点变成 identity，于是每一条都从左上角飞过来。顺序必须是：
  `transition:'none'` → 写起点 → `void offsetWidth` → `transition:''` → rAF 写终点。
- 动画层放在 **`#stage` 外面**：`#stage` 有 `transform: scale()`，
  里面 `getBoundingClientRect` 是缩放后坐标，横屏必错。

**触摸目标按手指定，不按观感定**

设计 px × 0.52 = CSS px。入口按钮第一版 56 设计 px → 29 CSS px，比 iOS 的 44pt 小一截；
改成 88 → **45.7 CSS px**，横屏也不缩（那个预算该从汇总卡横排里让，不该从手指上省）。
探针有一条断言专门守 ≥44。

**顺手修掉的两个「做了等于没做」**

1. `emojiSentThisGame` 声明后**从未清零** —— 写进战绩的会是「今天一共发了多少条」，
   而雷达问的是「场均」。加 `syncEmojiHand(room)`，按 `roomId#handId` 判边沿，在 `render` 每帧幂等调用。
2. `cloudRows()` **重建对象**，`myEmoji` 会被静默丢掉 ——
   现象是「离线时雷达有互动维、登录后没了」。从本机同一条记录对过来。

**互动维的口径**

- 数据源只有**本机战绩的 `myEmoji`**（服务端不记表情，云端流水里没有这个字段）；
- 分母只取**带这个字段的局**：换设备前那几局是「不知道」，当成 0 条会把场均无故拉低；
- 明确记了 0 条的局 → 值 0（0 也是答案），不是 `null`；
- 满格刻度 `SOCIAL_FULL = 6` 条/局是**尺子不是统计值**，改它不改变任何真实数据；
- 少一维时右移一格：现在三维点亮 → **连成面**（不足三维只画辐条那条规矩没变）。

**验收（全绿）**

```bash
npm test                                   # 88 文件 / 3219 断言
node scripts/journey.js                    # 117 项
node scripts/probe-emoji.js 390 844        # 35 项（竖屏 4 列）
node scripts/probe-emoji.js 844 390        # 35 项（横屏 7 列）
node scripts/probe-records-radar.js 390 844  # 32 项
node scripts/probe-records-radar.js 844 390  # 32 项
node scripts/probe-modals-landscape.js     # 42 项（15 个弹窗）
node scripts/probe-safearea.js             # 31 项
node scripts/probe-landscape-screens.js    # 22 项
node scripts/probe-type-scale.js           # 0 / 11 超基线
node scripts/e2e-score.js                  # 1929 项 / 0 失败
node scripts/review-rule-parity.js         # 0 不一致
node scripts/build-proto.js --check        # 产物与源同步（388 KB）
```

**回滚**：`pwa/js/config.js` 里 `EMOJI: false`，改完刷新生效（不放灰度期在线翻的开关 ——
这个开关是「发版级」的，和 `TABLE_READY` 同一档）。它一处管三件事：顶栏不出入口、
`openEmojiSheet` 直接返回、`onEmojiEvent` 不画别人的表情。只关一半会留下
「自己发不出去、却能看见别人发」的诡异状态，用户只会以为手机坏了。

协议层是**纯新增**（新请求类型 + 新推送类型），老客户端收到 `emoji` 推送会走 `else` 分支忽略，
不会断连 —— 这也是为什么这一档敢先上。

**已知取舍**

- 表情条数只在本机：换设备后「互动」维要重新攒 3 局。要跨设备就得让服务端落一个计数，
  那会把「只转发不落库」这条设计破掉，留到真有需求时再单独评估。
- 面板空壳（没入座时被强制显示）会塌成一条 72 CSS px 的横条。真实路径进不去
  （`openEmojiSheet` 在 `emojiReady()` 为假或桌上没人时直接返回），
  但 `probe-modals-landscape.js` 是「强制显示」审计，看到的就是这个空壳 —— 已在探针注释里写明。

## R5 · 95%（版本 `20261031b` / sw `v86`）

v82 计划里写着「组级写分的门槛见 §7」，这一档就是去过那道门。
**唯一一档改计分本身**，所以验收的重心不是界面，是**对账**。

**改了什么**

| 文件 | 改动 |
|---|---|
| `pwa/js/stateMachine.js` | `settleRound` 由 `forEach` 改 `for` + 组级见底即 `break`；新增 `closeHand()` / `handStartedAt` / `handMsTotal` / `handsDone` / `bustedIds` / `groupsDone`；玩家新增 `out` |
| `pwa/js/game.js` | 结算明细：牌型特写（`BIG_FX` + 12 粒子）、「剩下 N 组没有进行」、结账页区分「弃局 / 见底」；战绩写 `handMs`；`cloudRows` 对过来 |
| `pwa/css/style.css` | `.result-group.is-big` + `fxHalo` / `fxBurst` / `fxBurstTight`；`.result-abort-note`；`#result-groups` 加 `min-width: 0` |
| `pwa/js/styleStats.js` | 速度维接真数据：`(150 − 场均秒) / (150 − 30)`，夹 0..1 |
| `pwa/js/records.js` | 字段白名单收 `handMs`（只写正数） |

**组级见底：到底改了什么**

旧实现是「整轮所有组算完，再判有没有人 ≤ 0」。问题在于**分数会多扣**：
第一组就输穿的人，第二三组照样被扣，最终分数比「见底那一刻」还低，
而那个差额不显示在任何地方。

现在每结算一组就判一次，有人 ≤ 0 立刻 `break`：本轮剩下的组**不结算、不应用分数**，
`results` 里也就没有它们；`groupsDone` 记住算到第几组，结算明细上写明
「有人见底，本轮剩下 N 组没有进行」。与原型 `policy='end'` 完全一致。

判的是 `pool`（参与这一组的人）而不是全部 `activePlayers`：已经 `left` 的人
分数冻结，不该被这一组的结算连带判出局。

**牌型特写：为什么不是照搬原型**

原型那套铺在深绿毡面上，浅金很跳；结算弹窗是暖白底（`#FFF7E8`），
第一版照抄 `#FFD978`，截图里 12 颗粒子**一颗都看不见**（等于没做）。
改成深一档的同色系（豹子 `#E0572B` / 牛牛 `#B8862B` / 五花牛 `#8B5CC7` /
10.5 `#1F8A66`），粒子从 6 设计 px 放到 10（390 宽下才 5 CSS px）。

判定只读 `g.winnerTypeName`（引擎 `typeName()` 的输出），映射表 `BIG_FX`
只负责「这个名字用什么颜色」—— 名字写错最坏是少一段动画，不会算错输赢。
原型里那条 `r.t === 9` 的裸数字曾让牛 9 赢了放牛牛特写（随机 800 组里 18.5%），
所以 `big-fx.test.js` 里专门有一条反例断言守这个。

**验收（全绿）**

```bash
npm test                                   # 91 文件 / 3373 断言
node scripts/journey.js                    # 117 项
node scripts/probe-big-fx.js 390 844       # 21 项（竖屏 74px 爆发半径）
node scripts/probe-big-fx.js 844 390       # 21 项（横屏切 38px 版本）
node scripts/e2e-score.js                  # 1929 项 / 0 失败（原型侧全量回归）
node scripts/review-rule-parity.js         # 0 不一致
node scripts/build-proto.js --check        # 产物与源同步
```

新增两道对账闸门：

- `pwa/test/group-settle.test.js`（60 项）：第 1 组见底 / 第 3 组见底 /
  第 2 轮见底 三种时点，加上「净得 == Σ每组 deltas」「每组零和」「left 的人不连带出局」
- `server/test/e2e.test.js` 新增 9 项：**写到 `player.score` 上的分数 == 引擎算的分**
  （原型侧那条证明的是「画出来的分 == 引擎算的分」，两件事不能互相替代）

**顺手修掉的一个既有隐患（落盘）**

验收时 `ai-records` / `me-records` / `reset` / `reset-stats` / `delete-seed` 五个用例
**同时**红了，原因和这一档的改动无关，是 `server/profile.js` 里两个老问题：

1. `flush()` 开头 `if (!this.dirty) return;`。dirty 表示「还没排队」，不表示「磁盘已最新」——
   500ms 定时路径会先清 dirty 再异步写，这个窗口里调 flush 等于没写。
   并发跑测试时窗口被挤出来，于是**偶发**读回旧内容（单跑复现不了，这就是它一直没被发现的原因）。
2. 原子写用 `fs.renameSync(tmp, target)`。Windows 上目标被占一下就 EBUSY，
   而 catch 只把 dirty 置回 true —— 下次还是同一条 rename，于是**永远写不进去且不报错**。

修法：flush 不再在 dirty 上短路；rename 分三层退让（rename → copyFile → writeFile），
并用 `_writeGen` 让「排队中的旧快照」在同步 flush 之后作废，不许反过来覆盖。
新增 `server/test/profile-flush.test.js`（6 项）锁这两条。

**已知取舍 / 坑**

- 见底即整局结束（`endReason='scoreZero'`），没有做「出局者退出、其余继续」
  （原型的 `policy='keep'`）。线上一直是前一种语义，这一档只把判定粒度从「轮」改到「组」，
  没有顺手换语义 —— 换语义要连带改结算页、战绩口径、AI 补位，属于另一档的事。
- `handMs` 只在本机：云端流水不记用时。换设备后速度维要重新攒 3 局，与 `myEmoji` 同一条取舍。
- 探针量布局必须**等入场动画结束**（`groupIn` 起始帧是 `translateX(40px)`）。
  在 120ms 时量，「组超出容器」会在完全正常的布局上红掉 —— 这个坑踩过一次，注释写在探针里。
- Windows headless 的滚动条占 13px 宽，真机是 overlay 不占。探针里把滚动条宽度清零之后再量，
  否则「组比容器宽 13px」这条永远红。

---

## R6 · 100%（版本 `20261031c` / sw `v87`）

R6 的权重只有 5%，但它是唯一一档**出事那天才会被用上**的交付物：
前面五档都在证明「功能是对的」，这一档要证明的是**「功能错了的时候退得回去」**。

这一档几乎没加功能，加的是三种东西：**一张交叉矩阵、两个探针、一份收口文档**。

### 补上的一个缺口：回滚能力原本是不对称的

`CONFIG.TABLE_READY` 一直有 `?tableready=0` 的运行时覆盖，值班的人改个 URL
就能在单台设备上看到退回去的样子。`CONFIG.EMOJI` **没有** —— 要验它只能改
`config.js` 再部署一次。

这不是「少个开关」的小事：灰度期最不该做的事，就是**为了验证回滚再发一次版**。
所以这一档给表情补了 `?emoji=0/1`，并且把三处判断（顶栏入口 / 打开面板 / 收别人的）
全部收敛到 `emojiFlag()` 一个函数 —— 之前是三次 `CONFIG.EMOJI === false`。

收敛的意义不只是好读：**三处各写一遍，加第四处时最容易只写前三处**。
现在有一条反例断言专门守这个：`game.js` 的代码里（剥掉注释后）不许出现
`CONFIG.EMOJI`，除了 `emojiFlag()` 自己那行兜底。

### 回滚演练结果（真跑，不是推演）

`scripts/probe-rollback.js` 用 URL 覆盖跑六组交叉，**不动任何源文件** ——
一个「验证回滚」的脚本如果自己需要回滚，它本身就是风险。

| 组合 | 期望 | 实测 |
|---|---|---|
| 默认（都开） | 牌桌准备态 + 顶栏有表情钮 + 发出去会飞 | ✅ 22/22 |
| `?tableready=0` | 回到独立房间页，准备按钮没被搬走且**真的能点** | ✅ |
| `?tableready=0` 进桌 | 顶栏**仍有**表情钮（两个开关正交） | ✅ |
| `?emoji=0` | 无入口；别人发的**也不画** | ✅ |
| 两个都关 | 房间页 + 进桌后无入口 = 「两个功能都没上线」 | ✅ |
| `?emoji=abc` | 按 CONFIG 走（笔误不许关掉功能） | ✅ |

四条容易漏的，都单独验了：

- **「收」那一路**。只验「按钮没了」不够 —— 最糟的坏状态是「自己发不出去，
  却能看见别人发的飞过来」，那看起来像「我这台手机坏了」。所以关掉之后
  **从另一头注入一条**（`RoomStore.sendEmoji`，线上别人发过来最终落到同一个回调），
  确认动画层里零节点。
- **搬回来的按钮是活的**。搬 DOM 节点最容易出的错是「搬过去能点、搬回来变死节点」，
  所以关掉之后还要点一次，看文案是否变成「取消准备」。
- **准备态要在开局之前量**。一旦开局 `#table-ready` 本来就会收起来，
  在开局之后量会得到 `false` —— 那不是「被连带关掉」，只是这一屏过去了。
- **非法值不许关功能**。`?emoji=abc` 必须按 CONFIG 走，否则分享链接被手抖改错，
  功能就悄悄消失了。

### 灰度怎么盯（命令可直接粘）

错误日志里每条都带 `[版本号]`（`pwa/index.html` 的 `meta[name=app-version]`，
与 `/api/health` 的 `pwa` 字段同源）。这是灰度期能区分「新错 / 老错」的唯一依据 ——
所以 `scripts/probe-error-report.js` 专门把它当真实验了一遍（**起真服务、抓 stdout**，不 mock）：

```bash
# 线上现在跑的是哪个前端版本
curl -s <域名>/api/health | grep pwa

# 只有这次改出来的错误
grep "\[client-error\]" <日志> | grep "\[20261031c\]"

# 回滚演练：两个开关各关一次
node scripts/probe-rollback.js 390 844
node scripts/probe-rollback.js 844 390
```

那个探针顺手验掉了三件「盯着的时候会踩到」的事：

- **老客户端不发 `version`**（PWA 缓存了旧 JS）→ 必须照收，不许因为字段缺失 400。
- **`message` 里有换行** → 必须压平。不压的话一条 message 就能往日志里伪造几行假记录，
  事后排查会被带偏。
- **限流真的挡得住**（按 IP 40 条/分钟）→ 挡不住的话，一次前端死循环就能把日志刷满，
  真正的新错误被埋在噪声里。

### 文档收口

`docs/v82-implementation-plan.md` §8 那三条挂着的问题，逐条给了结论：

| # | 问题 | 结论 |
|---|---|---|
| 8.1 | 「两轮打完」算不算一局结束？ | **不算。以线上为准**（无人见底就续下一把、分数延续）。原型的「两轮清零」是早期没做分数持久化时的占位逻辑，已在原型里标「勿参照」 |
| 8.2 | 老 8 人房怎么处理？ | R1 已落地（`room.cap` + `capOf`） |
| 8.3 | 「见底当场出局」v82 做不到 | **R5 已做到**，从这一刻起验收标准可以和原型对齐 |

### 「策略」维为什么还是空的

雷达五维现在四维有数（防守 / 获胜 / 互动 / 速度），只剩「策略」。
它要的是**「见底前一手主动收手」的比例** —— 需要一个新的埋点，
而不是把现有字段换个公式。硬凑一个数出来，比留空更糟：雷达上那根轴会变成假的。

这条写进了下一版计划，见文末。

### 验收（全绿）

```bash
npm test                              # 92 文件 / 3403 断言
node scripts/probe-rollback.js 390 844   # 22 项
node scripts/probe-rollback.js 844 390   # 22 项
node scripts/probe-error-report.js       # 23 项
node scripts/journey.js                  # 117 项
node scripts/probe-big-fx.js ×2          # 21 项 / 21 项
node scripts/probe-emoji.js ×2           # 35 项 / 35 项
node scripts/probe-records-radar.js ×2   # 32 项 / 32 项
node scripts/probe-modals-landscape.js   # 42 项
node scripts/probe-safearea.js           # 31 项
node scripts/probe-landscape-screens.js  # 22 项
node scripts/probe-type-scale.js         # 0 失败 / 11 项
node scripts/e2e-score.js                # 1929 项 / 0 失败
node scripts/review-rule-parity.js       # 0 不一致
node scripts/build-proto.js --check      # 产物与源同步
node scripts/audit-comments.js           # 硬性问题 0（扫描 161 个文件）
```

新增的静态闸门：`pwa/test/rollback-contract.test.js`（25 项）。
它不是逐个写死两个开关，而是**扫描 `config.js` 的「功能开关」区块**：
区块里每出现一个 `KEY: true`，就必须能找到 `xxxFlag()` 与 `?xxx=0/1`，
且代码里不许绕过它直接读 `CONFIG.KEY`。以后加开关忘了加覆盖，这条会直接红。

### 这一档没做的事（诚实清单）

- **真的等 24 小时**。这一步需要线上流量 —— 能在这里交付的是「可观察性就绪」：
  版本号可过滤、错误可区分、开关可回滚、演练脚本可复跑。24 小时本身是运营动作，
  不是代码动作，所以它没有被写成「已完成」。
- **`policy='keep'`**（出局者退出、其余继续）。线上一直是 `'end'`，
  R5 只把判定粒度从「轮」改到「组」，没有换语义。换语义要连带改结算页、
  战绩口径、AI 补位 —— 属于另一版。

---

## v85：撤掉「牌风」雷达与「主动收手」（版本 `20261031e` / sw `v89`）

> 这一版**减功能**，不加功能。上一版（v84）为点亮雷达最后一维做的「主动收手」，
> 以及整张五维雷达，都被判定为「没人会看、看了也不信」的装饰，整块拆掉。

### 为什么撤

雷达的五个维度里，只有「防守 / 获胜」是从真实对局直接读出来的；「速度」和「互动」
需要为此专门埋字段；「策略」压根没有对应的玩家动作，于是上一版**新造了一个功能**
（放弃本回合）去喂它。为了让一张图有第五根轴而新增一条玩法路径，这个交换不成立：

- 它回答不了任何一个玩家真正会问的问题。「我最近赢得多吗」看胜率，
  「我输在哪儿」看流水，雷达给的是五个百分比，没有一个能指向下一步动作；
- 数据永远凑不齐。打得好的人几乎不见底，策略维会长期显示「—」——
  一张五个角里有角是空的图，比没有这张图更让人怀疑数据；
- 为它付出的代价是真实的：本机记录多了三个只为它存在的字段、结算流程多了一次
  「封账」、表情路径多了一套按把清零的计数、中段布局为它让出 280 设计像素，
  横屏汇总卡甚至被压成了一行。**这些代码每天都在跑，而那张图一个月可能被点开一次。**

「主动收手」的问题更直接：它不是为了玩家，是为了雷达。六选五的分牌阶段本来只有
「分好提交」一个决定，加了「放弃本回合」等于在唯一确定的动作旁边放一个诱饵，
而它的收益（一局里少付一点）几乎总小于继续打完的期望 —— 一个设计出来就基本不该被按的按钮。

**判断标准**：一个功能如果删掉之后没有任何一条玩家路径变长，那它当初就不该加。

### 删掉的东西（可逐项核对）

| 层 | 删除内容 |
|---|---|
| 模块 | `pwa/js/styleStats.js`（整个口径模块，含 5 维公式与阈值） |
| 渲染 | `game.js` 的 `renderRadar` / `RP_RADAR` / `radarPoint` / `radarPoly` / `pctText`（约 5.7 KB） |
| DOM | `index.html` 的 `#rp-style`（`#rp-radar`、`#rp-style-n`、`#rp-style-note`）与 `.rp-mid` 包裹层 |
| 样式 | `records.css` 的雷达卡 6 条规则；`style.css` 横屏并排 5 条规则 |
| 预缓存 | `sw.js` 的 `/js/styleStats.js`，缓存名 v87 → **v89** |
| 玩法 | 「放弃本回合」按钮态、确认弹窗、`RoomStore.forfeit`、服务端 `forfeit` 消息分支、`player.folds` / `forfeitReason` / `FORFEIT_SOURCES` |
| 数据 | 战绩字段 `myEmoji` / `handMs` / `myFold` 的写入与白名单；房间上的 `handStartedAt` / `handMsTotal` / `handsDone` / `closeHand()`；`emojiSentThisGame` 那套按把清零的计数 |
| 测试 | `style-stats.test.js`（105 项）、`forfeit-fold.test.js`（24 项）、`probe-fold.js`（39×2）、`probe-records-radar.js`（42×2） |
| 服务端 | `_view` 里「别人的 folds 不下发」那段 —— 字段本身没了，这段也没意义了 |

**保留**的是超时弃权：挂机的人仍然会被判本回合弃权、照付赢家，也仍然**不计入任何统计**
（它本来就不该被记成「策略」）。这条路径从 R1 起就在，与雷达无关。

### 顺手留下的两个 bug 修复（不是雷达的一部分）

上一版真正有价值的产出只有这两条，它们与雷达无关，留下：

1. **`.hand-status` 被全局 `nowrap + ellipsis` 规则套住**，而它是 flex 容器 ——
   `text-overflow` 在 flex 容器上不生效，长文案两端被直接裁掉
   （等待态那句带「对方掉线」的版本会显示成「…对方掉线，重连中或本局将结」）。
   已从那一组选择器里摘出来、改成可换行。
2. **`pressBusy()` 的 `restore()` 覆盖 render 的 `disabled`** —— 屏幕上会留下一个
   写着「已提交」却还能按的按钮。改成 `finally { restore(); render(); }`，
   先还按钮、再渲染。

两条都是踩到才发现的，与雷达存废无关，所以撤雷达时不一起撤。

### 页面改了什么

- **竖屏**：中段从「KPI ＋ 雷达」两列回到单列，三卡与纪录条各占整行
  （390 宽下每张卡 207 设计像素，与雷达之前一致）。
- **横屏**：雷达原来占 280 设计像素的那一列没有了，三卡在 612 栏宽下各 193 ——
  与竖屏几乎同宽，**不再需要为横屏另配一套列宽**。
  汇总卡从「压成一行」恢复竖排（雷达当年就是它让出的 86 设计像素），
  数字 88 → 56 号、内边距收一档，左栏余量 **15 设计像素**（844×390）、
  **22**（932×430），仍然一屏装下不用滑。
- 战绩页因此比之前**短了一屏**：雷达那 231 设计像素的高度不再存在。

### 验收（全绿）

```bash
npm test                              # 91 文件 / 3313 断言（删了 2 个文件、-164 项）
node scripts/journey.js               # 117 项
node scripts/probe-safearea.js        # 31 项（含横屏左栏 slack ≥ 8）
node scripts/probe-records.js         # 20 项
node scripts/probe-records-cloud.js   # 52 项
node scripts/probe-landscape-screens.js  # 22 项
node scripts/probe-viewport-fit.js    # 27 项
node scripts/probe-prev-result.js     # 布局全部通过
node scripts/probe-type-scale.js      # 0 失败 / 11 项
node scripts/probe-emoji.js ×2        # 35 / 35
node scripts/probe-big-fx.js ×2       # 21 / 21
node scripts/probe-rollback.js ×2     # 22 / 22
node scripts/probe-error-report.js    # 23 项
node scripts/probe-modals-landscape.js # 42 项
node scripts/probe-tenhalf.js         # 39 项
node scripts/probe-table-ready.js     # 33 项
node scripts/probe-leave.js           # 19 项
node scripts/probe-room-actions.js    # 20 项
node scripts/probe-ready-button.js    # 8 项
node scripts/e2e-score.js             # 1929 / 0
node scripts/review-rule-parity.js    # 0 不一致
node scripts/build-proto.js --check   # 产物与源同步
node scripts/audit-comments.js        # 硬性 0（158 个文件）
```

删除功能的验收比新增更难自证，所以补了三条**反向断言**（防的是它以后被谁顺手加回来）：

| 位置 | 断言 |
|---|---|
| `pwa/test/records.test.js` | 硬塞 `myEmoji` / `handMs` / `myFold` 进写入函数，磁盘上一条都不许出现 |
| `pwa/test/group-settle.test.js` | 新房间没有 `handStartedAt` / `handMsTotal` / `handsDone` |
| `pwa/test/records.test.js` | 白名单本身仍然工作（`myNet` 正常落盘） |

---

## v86 · 发布前准备（版本 `20261031f` / sw `v90`）

> 这一版**不加功能、不改版式**。它回答一个问题：v82–v85 这一串 UI 大改，
> 现在能不能发。
>
> 结论：**代码侧可以发**。有一个前提问题必须在部署前处理 —— 线上还停在
> `20261030w`（v81），中间这五版一次都没上线。详见文末「发布前必须确认的两件事」。

### 一、先把「发布就绪」拆成可以逐条打勾的东西

「做完了」和「能发了」不是同一件事。前者看功能，后者只看四类问题：

| 类别 | 判据 | 怎么验 |
|---|---|---|
| 一致性 | 版本号 / 缓存名 / 预缓存清单 / 引用路径四处对齐 | 脚本比对（PRECACHE 43 条逐条查磁盘） |
| 回归 | 老功能没被这轮改动碰坏 | `npm test` + 22 个探针 |
| 真实环境 | 本地绿 ≠ 线上绿 | 真浏览器打开线上地址 |
| 可回滚 | 出问题能退回上一版 | 功能开关 + SW network-first |

第三类是最容易漏的。v79 就吃过一次亏：`manifest.webmanifest` 在线上一直 403，
而本地所有探针全绿——因为本地静态服务没有部署网关那一层。

### 二、这次真正修掉的东西：`manifest` 403（BACKLOG N2）

#### 为什么这次修，而上次记成了「平台限制」

N2 当时的结论是二选一：「修（约 1 小时）」或「记录为平台限制」。
选了后者，理由是「托管网关强加的先决条件」。这个判断是错的：

部署网关只要求**每个请求**带 `?sharecode=`，它并没有说「manifest 不许带」。
应用侧完全有能力让这些 URL 自己带上 —— 不修不是不能修，是当时没做。

代价是具体的：**v76 做的那整套图标（含两张 maskable、安全圆实测 0 越界）在线上
从来没被用上。** 安卓装出来是带地址栏的标签页，iOS 加到桌面后图标是页面截图。

#### 为什么这个 bug 特别难发现

因为不同请求走的补丁不一样：

| 请求 | 谁发起 | 走 SW 吗 | 旧状态 |
|---|---|---|---|
| `js/*.js`、`css/*.css` | 页面 `<script>` / `<link>` | ✅ `withShare()` 补码 | 200 |
| `sw.js` | `register()` | ❌ 注册时手工拼 | 200 |
| `manifest.webmanifest` | **浏览器内部** | ❌ 不经过 SW | **403** |
| `apple-touch-icon` | 同上 | ❌ | **403** |
| manifest 里的 `icons[]` | 同上 | ❌ | **403** |

Key point：**Service Worker 只拦截页面发起的 fetch**，manifest 与图标是浏览器
自己抓的。所以「把 withShare 写对」这条路对它们完全无效 —— 必须让 URL 本体带码。

#### 修法分两半，缺一半等于没修

**第一半 · 页面**（`pwa/index.html`）

`<link rel="manifest">` 与 `<link rel="apple-touch-icon">` 不再写死在 HTML 里，
改由 head 脚本 `createElement` 注入，href 直接带当前的码。

- 为什么不是「先写死再改 href」：浏览器解析到那个 `<link>` 的**那一刻**就发起抓取，
  等脚本跑起来再改，第一发已经 403 了。动态创建能保证它第一次出现在 DOM 里时就是对的。
- 顺手补了 `<link rel="icon">`：以前完全没声明，浏览器就去请求 `/favicon.ico`，
  而那个文件不存在（线上 404）。用 192 那张当 favicon，不用再生成一份 32×32。
- 拿不到码时（本地开发）退回裸路径：本地没有网关，裸路径是 200，开发时也能测安装。

**第二半 · 服务端**（`server/index.js` 的 `sendManifest`）

manifest 内部的 `icons[].src` / `screenshots[].src` 是**浏览器按字面 src 逐条抓**的。
manifest 自己 200 了没用，图还是 403。

> ### ⚠ 部署后实测：第一版的修法无效
>
> 第一版是「服务端按当前请求的 `sharecode` 给每个 src 接上 query」。本地 30 项探针全绿，
> 部署上线后逐条点过去 —— manifest 200 了，**六张图仍然全部 403**。
>
> 原因：**网关会校验 `sharecode`，但转发给应用时把 query 剥掉了。**
> 证据两条：带错码请求返回 403（说明它在校验）、`icons[].src` 没被改写
> （说明 `queryParam(req.url,'sharecode')` 是空）。于是改写逻辑一次都没执行过。
>
> 这个陷阱的可怕之处在于：**本地 server 收到的是完整 URL，所以本地怎么测都绿。**
> 上一版还专门为「无码环境」写了降级路径 —— 看起来考虑周全，实际是给自己一个
> 「两种环境都想到了」的错觉。

改后的做法：**把图标内联成 `data:image/png;base64,...`**。浏览器不需要抓任何 URL，
天然绕开网关。先单独做了实验再改代码（Edge + CDP）：

```
Page.getAppManifest().errors      → []          ← 解析没问题
Page.getInstallabilityErrors()    → []          ← 真能装
```

**只验前者不够。**「解析通过」只说明 manifest 没写错；`installabilityErrors` 为空
才说明安卓能装出独立窗口。这条判据现在同时进了探针和线上核对。

几个具体决定：

- **只内联 `icons`，`screenshots` 从响应里删掉。** 两张 webp 内联后约 150KB，
  而浏览器**每次加载页面**都会抓一次 manifest —— 这个代价换一张安装弹窗里的装饰图不划算。
  留着更糟：它们的 URL 同样拼不上码，只会稳定 403。
- 单张超过 256KB 就不内联（退回拼 query 的旧路径，本地/别的网关有效），
  免得将来有人放一张 2MB 的图进来，把每次页面加载拖成几百 KB。
- gzip 分支单独写（`sendFile` 那套 `gzipFor` 是给文件路径用的），
  `Content-Length` 必须用**压缩后**的长度。
- 体积：manifest 从 2KB 变约 44KB（4 张图标 33KB → base64 43KB）。只在页面加载时抓一次。

**故意没改 `start_url`。** 它会被固化进安装包，而码是会轮换的：

```
安装包里 start_url=/?sharecode=旧码
  → 桌面启动带着旧码进来
  → index.html 那段「有 cur 就存进 localStorage」
  → 把 localStorage 里的新码覆盖回旧的
  → 自愈链断了
```

保持 `"/"`，让页面从 localStorage 补最新的码，这条链才是通的。单测里有一条专门钉这个。

### 三、新增的验收

| 文件 | 项数 | 守什么 |
|---|---:|---|
| `server/test/manifest.test.js` | 27 | 图标是合法 PNG 的 data URI / screenshots 已移除 / start_url 与 id 不带码 / 带不带码响应一致 / no-store / gzip 长度 / HEAD / 不误伤别的文件 |
| `scripts/probe-manifest.js` | 28 | 真 server + 真 Edge：link 注入 / 图标 data URI / 零待抓 URL / `getAppManifest` 无 error / **`getInstallabilityErrors` 为空** |
| `scripts/probe-online-smoke.js` | 12（改造） | **从「只打印」变成「能判红绿」**，见下 |

两处刻意成对的断言，防的是「函数写了但没被调用」：

- 无码时**不许**改写 ↔ 带码时**必须**改写；
- 服务端单测（逻辑）↔ 探针端到端（浏览器真的认不认）。

#### `probe-online-smoke` 为什么必须改

它以前只打印诊断，退出码只看 JS 异常，注释写着「403/404 只打印不算失败 —— 
让它们把每条命令都判红，红久了就没人看了」。

这个理由本身是对的，但结论错了：**manifest 403 正是最该判红的那一条。**
它就这样在输出里挂了五版没人管。

现在它是一份「发布后核对清单」，5 条硬断言：线上版本 = 本地版本 / manifest 200 /
link 带码 / 有带码的 favicon / 没有 HTTP≥400。跑一次就能回答「这次发版算不算完」。

改造后在**未部署的线上**跑了一次，5 红 6 绿 —— 说明它确实能分辨：

```
FAIL  线上版本 = 本地版本（20261031f）  -> 线上 20261030w
FAIL  manifest 抓取 200                 -> 403 ×2
FAIL  manifest 的 href 带 sharecode     -> /manifest.webmanifest
FAIL  声明了带码的 favicon              -> （空）
FAIL  没有任何 HTTP >= 400              -> 403 403 404
```

### 四、全量验收（绿）

```bash
npm test                                   # 92 文件 / 3340 断言（+27）
node scripts/probe-manifest.js             # 30 项（新增）
node scripts/journey.js                    # 117 项
node scripts/probe-install.js              # 23 项
node scripts/probe-first-paint.js 390 844  # 12 项
node scripts/probe-first-paint.js 844 390  # 9 通过 / 3 失败（B-L1 已知限制，见下）
node scripts/probe-safearea.js             # 31 项
node scripts/probe-landscape-screens.js    # 22 项
node scripts/probe-viewport-fit.js         # 27 项
node scripts/probe-type-scale.js           # 0 失败 / 11 项
node scripts/probe-records.js              # 20 项
node scripts/probe-records-cloud.js        # 52 项
node scripts/probe-prev-result.js          # 布局全部通过
node scripts/probe-emoji.js ×2             # 35 / 35
node scripts/probe-big-fx.js ×2            # 21 / 21
node scripts/probe-rollback.js ×2          # 22 / 22
node scripts/probe-error-report.js         # 23 项
node scripts/probe-modals-landscape.js     # 42 项
node scripts/probe-tenhalf.js              # 39 项
node scripts/probe-table-ready.js          # 33 项
node scripts/probe-leave.js                # 19 项
node scripts/probe-room-actions.js         # 20 项
node scripts/probe-ready-button.js         # 8 项
node scripts/probe-guide.js                # 39 项
node scripts/probe-flex-gap.js             # 20 项
node scripts/probe-delete-purge.js         # 31 项
node scripts/probe-multi-tab.js            # 10 项（诊断）
node scripts/e2e-score.js                  # 1929 / 0
node scripts/review-rule-parity.js         # 0 不一致
node scripts/build-proto.js --check        # 产物与源同步
node scripts/audit-comments.js             # 硬性 0（160 个文件）
```

**一致性核对**（这次写成脚本跑过一遍）：

- `app-version` = `20261031f`，`CACHE_NAME` = `weiliuxuanwu-v90`，19 处 `?v=` 全是 `20261031f`；
- `PRECACHE` 43 条**逐条在磁盘上存在**，没有指向已删文件的残项；
- `index.html` 引用的每一个本地资源都在 `PRECACHE` 里；
- 全仓库搜 `styleStats` / `renderRadar` / `myFold` / `handMs` / `放弃本回合` —— 只剩测试里的**反向断言**；
- `ai.js` 不在 `PRECACHE` 也不被页面引用，这是**有意**的（只在服务端 `require`）。

### 五、两个已知限制（不是这次引入的）

#### 1. 横屏首帧缩放跳变（B-L1，5 版以来一直如此）

`probe-first-paint.js 844 390` 固定 3 项红：首帧舞台 750px 1:1 铺在 844 视口上，
boot 跑完才切 `.ls` 并缩放。

**为什么现在不修**：`.ls` 是加在 `#stage` 上的 class，而 head 脚本执行时 `#stage`
还没被解析出来 —— 要修得把整套版式判定搬进 CSS 媒体查询（`#stage.ls` → `html.ls-mode #stage`，
涉及 100+ 处选择器）。这个改动面在发布前不值得，而且横屏进入的概率本身很低。

**判定**：发布可接受。但**必须在发布说明里承认它**，不能假装探针全绿。

#### 2. 同一浏览器多标签会「串台」（localStorage 同源共享）

两个标签登录不同账号，后写的会覆盖前一个；标签重载后会变成另一个人的身份。
`probe-multi-tab.js` 10 项就是在**描述**这个行为，不是断言它不存在。

同源 localStorage 只有一个键，这是浏览器模型决定的，不是能"修"的 bug。
产品上也不打算支持「同一浏览器同时登两个号」。

### 六、发布后要做的三件（不是发布前）

1. **`[client-error]` 按版本分组看首现时间分布** —— 发版后 10 分钟内集中出现 =
   这版引入；24 小时后零星出现 = 偶发环境问题。
2. **`resource` 类错误占比**。这次尤其要盯：`styleStats.js` 从 `PRECACHE` 删了，
   若哪台设备的旧页面还在引用它，正好落成这一类。
3. **`NAV_TIMEOUT_MS = 4200` 从单样本变分布**。这个值是照「冷启动 3.18s」一次实测定的，
   样本量是 1 —— 现在它是「有依据的猜」，不是「量出来的」。

---

## 发布结果（2026-10-31 已上线）

### 1. 跨五版大跳完成

```
上线前  20261030w（v81）
第一次  20261031f（v86）  —— 核对时发现图标仍 403
上线    20261031g（v86b） —— 图标改成 data URI，核对全绿
```

中间跨了 v82 成员上限 5 · v83 组级见底 + 牌型特写 · v84 主动收手（后撤）·
v85 撤雷达 · v86 发布准备。

**这次上线本身验证了一件事**：发布前那套「本地全绿」的验收不足以决定能不能发。
第一次部署 15 项核对里有 4 项是绿的（版本对、无异常、无 400），但把 manifest 内容
点开才发现图标一个都没内联 —— 如果只跑本地探针就宣布完成，这个错会一直挂着。

原先预估的风险（真发生了吗）：

| 风险 | 兜底 | 实际 |
|---|---|---|
| 老客户端 + 新服务端 | 消息类型是增量，旧页面不认识会忽略；SW network-first，刷新即新版 | **没出事**。页面刷新即新版，没有玩家反馈异常 |
| SW 换版本（`v89 → v91`） | activate 清旧缓存，首次打开重新预缓存 43 条 | **正常**。核对时 SW 已接管；首次预缓存比之后慢，符合预期 |
| 战绩档案 | v85 删的字段从未上线，云端没写过 | **无需迁移**，老档案字段都没动 |
| manifest 图标 | 内联 data URI | **第一次没做对**：拼 query 的方案被网关剥掉，第二次改 data URI 才成 |

**最没用上的兜底**：本来准备了「回滚到 v81」的路径，实际没用 ——
因为出问题的不是业务代码，是 manifest 那一层，改它比回滚安全得多。

### 2. 线上核对结果（15/15 × 两朝向）

```bash
node scripts/probe-online-smoke.js
```

15 项，含 8 条硬断言（版本一致 / manifest 200 / link 带码 / favicon 带码 /
图标 data URI / 无 screenshots 死链 / 可安装 / 无 HTTP≥400）。
**全绿才算这次发布完成**；任何一条红，按输出逐条处理。
特别是 `manifest 抓取 200` 与 `没有任何 HTTP >= 400` —— 这两条正是 v79 漏掉的那个坑。

实际结果：

```
390×844   15 / 15   通过
844×390   15 / 15   通过
```

外加两条脚本外的验证：

- `GET /icons/apple-touch-icon.png?sharecode=…` → **200 image/png**（iOS 加桌面的图标来源）；
- `GET /manifest.webmanifest` → **44KB**，4 张图标全是 `data:image/png;base64,`，
  `screenshots` 已不在响应里。

**iOS 那条仍然只能靠逻辑推**：Safari 的 apple-touch-icon 是用户点「添加到主屏幕」
时才抓的，headless 里没有这个动作。能验的只有「那个 URL 带码且 200」，验不了
「Safari 真的用它」。这条留在待真机复验里（和 N5 一起）。

---

## R7 · 圆桌第一期（版本 `20261031h` / sw `v92`）

**背景一句话**：圆桌从来不是「没生效」，是从来没做。原型 10-30 就在
（`docs/prototypes/circle-table.html` + 两轮 review 文档），但本表把 P0 记成了
「设计稿」，`docs/circle-table-analysis.md` §7 里那个真正的 P0（座位环落地，2.5–3 天）
在进度表里**没有对应行** —— 编号被改指之后，这件事就从待办变成了 ✅。
R1–R6 六档全在功能层，骨架一直没人认领，也没进 `BACKLOG.md`。

**改了什么**

| 文件 | 改动 |
|---|---|
| `pwa/js/seatRing.js` | **新增**。纯函数几何：弧长均分（512 点累积 + 二分反解）、椭圆定位、块高/毡面/表情位 |
| `pwa/js/game.js` | `renderTopBar` 分两路：`seatRingFlag()` 开则画桌子（`.gt-felt` / 座位绝对定位 / `.gt-plaque` / 环下沿的「我」），否则走 v86 原路；`finishTopBar()` 抽出来给两路共用 |
| `pwa/js/game.js` | `oppSeatState()` / `oppAvatarHtml()` / `emojiBtnHtml()`：状态判定与头像 html 收成一处，两套版式不再各写一份 |
| `pwa/js/slotLayout.js` | 新增 `isDenseAt(可用高)` 与 `RING_EXTRA_H`；`cardSize` 支持 `widthRatio` |
| `pwa/css/style.css` | `#game-top.gt-ring` 一整套（全部挂在 `.gt-ring` 下，回滚才干净） |
| `pwa/js/config.js` | `SEAT_RING: true` |
| `index.html` / `sw.js` | 引用 + 预缓存 `seatRing.js`；`CACHE_NAME` v91 → **v92** |
| `scripts/probe-table.js` | 新增 `[4] 圆桌环几何` 14 条断言；`BOTS=` / `STOP_BEFORE_READY=` 两个环境变量 |
| `pwa/test/seat-ring.test.js` | **新增** 74 条（弧长偏差、镜像对称、不重叠、预算、接线、矮屏闸门） |

**三个不显然的取舍**

1. **环和组槽争的是同一块纵向空间**，所以「先上环、组槽下一版再压」不成立 ——
   环要 466，旧顶栏只有 182+12。第一期必须一起压组槽：816 → 537，牌面 139×195 → 114×160（−18%）。
   这是圆桌的入场费。
2. **矮屏不上圆桌**（舞台 < 1500）。16:9 手机扣掉 280 后组槽只剩 262，
   三组按最小牌高也要 308 → 第三组会被裁进不可见滚动区，正是 `slotLayout.js` 头部记的老 bug。
   `RING_MIN_STAGE_H` 挡在 `lastStageH` 上，与 `.compact-v` 同一条线。
3. **横屏仍走 v86**：方案里横屏要「左桌右盘」（桌子占左栏、组槽搬到右栏手牌上方），
   是网格重排，不是同一件事。放在 v88。

**验收（全绿）**

```bash
npm test                          # 93 文件 / 3423 断言
node scripts/journey.js           # 117
node scripts/probe-table.js 390 844            # 圆桌环 14/14（5 人局：牌 114×160、组槽 537、零溢出）
BOTS=1 node scripts/probe-table.js 390 844     # 14/14（2 人局：对手在正上方）
BOTS=2 node scripts/probe-table.js 390 844     # 14/14（3 人局：状态牌与两侧座位不碰）
node scripts/probe-table.js 375 667            # 分流：矮屏不上圆桌，组槽 631
node scripts/probe-safearea.js    # 31
node scripts/probe-emoji.js       # 35（入口底色/触控 46×46，含圆桌右下角那一版）
node scripts/probe-table-ready.js # 33（就位态也是这张桌子）
node scripts/probe-rollback.js    # 22
node scripts/probe-viewport-fit.js # 27
node scripts/probe-landscape-screens.js # 22（横屏未动）
node scripts/probe-first-paint.js # 12
node scripts/probe-big-fx.js      # 21
node scripts/e2e-score.js         # 1929 / 0
```

**探针抓到的两个真问题**（纯函数测试全绿，画面上是错的）

| 问题 | 起因 | 修法 |
|---|---|---|
| 2 人局：顶部对手头像上沿被裁 13 设计px | `topPad` 46 < 座位块半高 60。5 人局那个座位在 y≈83 看不出来，只有 2 人局在 y=62 才露 | `topPad` 46 → 62（块高 450 → 466） |
| 3 人局：中间状态牌压住两侧对手头像 12×47 设计px | 牌宽 400 固定，而 ±66° 的座位内沿到 x=147 | 牌宽 400 → 340（仍够放「第一轮分牌 剩 58 秒」） |

**回滚**：`CONFIG.SEAT_RING = false` 或 `?seatring=0`。关掉后走 `renderTopBar` 的
v86 分支、`slotDense` 回到 `isDense(stageH)`、牌面回到 139×195 —— 一个像素都不差
（`seat-ring.test.js` 有一条「关掉时两条 dense 判据结论一致」守着）。

**留给 v88**

- 横屏「左桌右盘」重排（座位环占左栏，组槽搬到右栏手牌上方）；
- 矮屏圆桌（要按比例缩环与牌，而不是单独砍一个数字）；
- 房间卡口径：`.tr-card-sub` 写的是「4/5 人」（在场/上限），就位态中央牌写的是
  「已准备 3/4」，两个分数并排容易被读成同一件事。

---

## R8 · 圆桌第二期（版本 `20261031i` / sw `v93`）

**背景**：R7 只上了竖屏。这一期做横屏，并给两边补上「屏幕够不够」的统一判据。

**改了什么**

| 文件 | 改动 |
|---|---|
| `pwa/js/seatRing.js` | 新增 `landscape` 版式（左栏 800 宽 → rx 340 / ry 209 / h 550）；`layout()` 支持 `maxH`，按 `rx` 等比缩回（不是只砍 `ry`，那会压成扁椭圆） |
| `pwa/js/game.js` | `ringGeom()` 按朝向选版式并把左栏可用高当 `maxH`；`renderTopBar` 在父级切 `.rt-ring`；新增横屏闸门 `RING_MIN_LS_STAGE_H = 1000`；`resize()` 的 `ringExtra` 只对竖屏扣（横屏桌子不占组槽高度） |
| `pwa/css/style.css` | `.ls #screen-game.rt-ring` 网格：`"top slots" / "top bottom"`，桌子跨两行 + `align-self:center`；`.is-ready` 用同一套网格；`.game-bottom` 改成按内容取高 |
| `pwa/css/style.css` | `.gt-prog` 用 `max(17px, 11px/scale)` 顶住 11 CSS px 下限（探针在 667×375 上量到过 7） |
| `pwa/js/game.js` | 房间卡文案「4/5 人」→「4 人 · 上限 5」（与中央牌「已准备 3/4」不再同形） |
| `pwa/test/seat-ring.test.js` | 新增 12 条：横屏几何、`maxH` 缩回、网格与闸门接线 |
| `pwa/test/rollback-contract.test.js` | 函数体匹配窗口 700 → 1600（`seatRingFlag` 多了两道闸门） |
| `pwa/index.html` / `sw.js` | 版本 `20261031i`、`CACHE_NAME` v92 → **v93** |

**为什么横屏其实是「平板横屏」**

横屏的设计宽恒为 1624，设计高 = 1624 × 高宽比。三条实测：

| 视口 | 设计高 | scale | 结论 |
|---|---|---|---|
| 844×390（iPhone 14/15） | 750 | 0.52 | 差 250，右栏塞不下 |
| 932×430（Pro Max） | 749 | 0.57 | 同上 —— 越宽的机器设计高反而越小 |
| 667×375（SE） | 913 | 0.41 | 高度差 87，且表情按钮只有 36 CSS px（< 44 触摸下限） |
| 1024×768（iPad） | 1218 | 0.63 | 组槽 692，牌 144，全绿 |

硬塞 844×390 的实测结果：右栏 692 要装 chips 88 + 三组 305 + 手牌与操作 368 = 761，
差 69。先试过把 chips 挪去左栏（组槽换到 314），牌从 105×147 掉到 84×118（−20%）；
再试过让 `bottom` 用 `auto` 行，`#hand` 被 flex 压成 91 高。两条都不接受。

所以闸门取 1000：它同时覆盖「放得下」与「点得着」两个条件，把 iPhone 横屏整体挡在外面。

**验收（全绿）**

```bash
npm test                                   # 93 文件 / 3442 断言
node scripts/journey.js                    # 117
node scripts/probe-table.js 390 844        # 竖屏圆桌 14/14（组槽 537、牌 114×160）
node scripts/probe-table.js 1024 768       # 平板横屏圆桌 14/14（组槽 700、牌 144）
node scripts/probe-table.js 844 390        # 分流：v86 版式，牌 105×147 一个像素没变
node scripts/probe-table.js 667 375        # 分流同上（原先会开圆桌并把按钮缩到 36px）
node scripts/probe-table.js 375 667        # 分流：竖屏矮屏
node scripts/probe-safearea.js             # 31（.gt-prog 11 CSS px 不再是短板）
node scripts/probe-viewport-fit.js         # 27
node scripts/probe-landscape-screens.js    # 22
node scripts/probe-emoji.js                # 35
node scripts/probe-table-ready.js          # 33
node scripts/probe-rollback.js             # 22
node scripts/probe-first-paint.js          # 12
node scripts/probe-big-fx.js               # 21
node scripts/e2e-score.js                  # 1929 / 0
```

**探针抓到的两个真问题**

| 问题 | 起因 | 修法 |
|---|---|---|
| 横屏 `#hand` 被压成 91 高 | 组槽与手牌从「并排共享行高」改成「上下两行」，`bottom` 用 `auto` 行 + 原 `height:100%` 互相拽 | `.rt-ring .game-bottom { height:auto; flex:none }` |
| 667×375 表情按钮 36 CSS px | 88 设计 px × scale 0.41 | 横屏闸门提到 1000（该档不再上圆桌）；顺带 `?seatring=1` 可强制预览 |

**回滚**：`CONFIG.SEAT_RING = false` 或 `?seatring=0`。关掉后横屏回到 v86 网格
（`slots` 左下 / `hand` 右下），牌 105×147；竖屏回到满尺寸 139×195。

**留给 v89**

- iPhone 横屏若一定要上圆桌，得先重排组槽（三组改两列 / chips 挪位），那是另一套网格；
- 竖屏矮屏（舞台 < 1500）同理，要按比例同时缩环与牌。

---

## 圆桌上线状态盘点（2026-10-31）

按「部署到线上」为口径，逐条对照 `circle-table-analysis.md` / `circle-table-upgrade-review.md` /
`docs/prototypes/circle-table.html` 与线上 `20261031i`：

**完整清单见 `docs/circle-table-rollout-status.md`**。结论三句：

1. **骨架全上了**：座位环（弧长均分）、中央公共区、竖屏与平板横屏两套版式、表情真广播、
   牌型特写、逐组算分 + 组级见底、战绩页、准备态同桌 —— 共 22 项。
2. **血肉基本没上**：统一浮层面板、头像预设库/上传、逐组结算场景 + 轮次交替卡、
   2 人局对战条、P2 回放对齐 —— 共 6 项设计已定未做；另有 3 项因几何放不下主动分流
   （iPhone 横屏 / 竖屏矮屏 / 桌面档）。
3. **有 1 项上线但不达标**：斗牛 5 张组 69×97（v86 是 119×167，−42%），
   低于 `analysis §11` 自定的 ≥82×115。已记入 `BACKLOG.md` N8 —— 根因是
   `widthRatio` 用了全局 0.6，与「探针只发第一轮 + 测试没有下限断言」两条覆盖盲区共同导致。

review 文档里的 **P0-2（人数 2–5）已落地**（`CONFIG.MAX_PLAYERS = 5`），该条可关闭。

---

## v89 一批 · 上线（版本 `20261031j` / sw `v94`，2026-10-31）

> 一次发出去 7 件事，全部是 `docs/circle-table-rollout-status.md` §3 里
> 「已做未发布」堆着的那一批。**没有新增玩法**，都是把圆桌/结算/头像这三块
> 做到文档自己的验收线。

| # | 内容 | 关键改动 | 守它的东西 |
|---|---|---|---|
| 1 | 斗牛 5 张牌宽（BACKLOG N8） | `RING_RATIO` 按张数给（n≥4 → 0.78）+ `cardSize` 的 `minW` 兜底 | `table-layout.test.js` 下限断言、`probe-table` 第二轮实测 |
| 2 | iPhone 横屏两列两行 | `#slots[data-twocol]` + 迷你牌 88×124→74×98 | `probe-table` 844×390、`probe-result-seq` |
| 3 | 2 人局对战条 | `.gt-vs`：分差 + 双方净得；中央牌与「我」让位 | `probe-table`（BOTS=1） |
| 4 | 统一浮层面板 | 点座位贴着弹「表情 / 短语 / 信息」三档 | `probe-modals-landscape`、`modal-a11y` |
| 5 | 头像预设 P1a | 48 款 = 8 形状 × 6 调色板全内联 SVG | `probe-avatar` 3 档尺寸 |
| 6 | 头像上传 P1b（默认关） | `?v=` 即凭据、只认文件头、300KB | `server/test/avatar-photo.test.js` 39 条 |
| 7 | 逐组结算 + 交替卡 | `playResult` 序列器 + `#round-break-modal` | `result-seq.test.js` 76 条、`probe-result-seq` 四档 |
| 8 | P2 结算/回放对齐 | 点行看**这一把**、点头像看人 | `settle-replay.test.js` 54 条、`probe-result-seq` §8 |

**验收**：`npm test` 97 文件 / 3803 项、`journey` 126 项、
`probe-result-seq` 390×844 与 844×390 × 4/5 人局（57~58 项 ×4）、
`probe-table`、`probe-prev-result`、`probe-avatar`、`probe-emoji`、`probe-modals-landscape` 全绿。

**线上核对**（`probe-online-smoke.js`）：15/15 —— 版本号 `20261031j` 与本地一致、
manifest 200 且图标是 data URI、无 HTTP≥400、SW 已接管、无 JS 异常。

**仍然没做**（下一批）：矮屏 375×667 圆桌（环与牌要按比例一起缩）、
桌面 1280×800 专门版式、开局 3 秒倒计时、`?dev=1` 调试侧栏。

---

## v95 一批 · 上线（版本 `20261031k` / sw `v95`，2026-10-31）

> §3「已做未发布」与 §3.2/§3.3 里剩下的四项，一次做完。仍然**没有新增玩法**，
> 全是对局页在别的屏幕上「能不能看清牌」这一件事。

| # | 内容 | 关键改动 | 守它的东西 |
|---|---|---|---|
| 1 | 竖屏矮屏 375×667 紧凑圆桌 | `seatRing.MODES.portraitCompact`（头像 56 / ratio 0.52 / 环 404）+ 闸门拆两条常量（1200 / 1500）+ 竖屏尺度闸门 0.47 | `seat-ring.test.js [6c]` 48 条、`probe-table` 375×667 / 360×640、`probe-ready-button 375 667` |
| 2 | 开局 3 秒倒计时（默认关） | `?startcountdown=1`，纯遮罩不改时序；`CONFIG.START_COUNTDOWN = false` | `start-countdown.test.js` 40 条、`probe-table` §2b（默认档 2 / 打开档 8） |
| 3 | 桌面 1280×800 宽横屏 | `seatRing.MODES.desktop`（头像 80 / ratio 0.66 / 环 608）+ 复用 v89 四区网格（chips 与操作条落到左栏桌下） | `seat-ring.test.js [6d]` 38 条、`probe-table` 1280×800 / 1024×768 |
| 4 | `?dev=1` 调试侧栏 | 四行版式读数 + 三个开关一键翻转；不带参数连 DOM 都不建；造局入口一律不做 | `dev-panel.test.js` 35 条、`probe-dev-panel` 21 条 |

**牌面账（设计 px，§11 的下限是 1–3 张 ≥110×154、5 张 ≥82×115）：**

| 视口 | 档位 | 1–3 张 | 斗牛 5 张 | 组槽 |
|---|---|---|---|---|
| 390×844 | portrait | 114×160 | 91×127 | 537 |
| 375×667 | portraitCompact | 82×115 | 82×115 | 406 |
| 844×390 | landscape + 两列 | 104×146 | 99×139 | 326 |
| 1024×768 | desktop | **144×202** | 99×139 | 794 |
| 1280×800 | desktop | **127×178**（改前 105×147） | 99×139 | 591 |

**验收**：`npm test` 99 文件 / 3984 项、`journey` 126 项；探针 `probe-table` 五档
（390/375/844/1024/1280 各 15+5+2 全绿）、`probe-ready-button` 12×3、`probe-result-seq`
390/375 各 57、`probe-rollback` 22、`probe-emoji` 44、`probe-big-fx` 21、`probe-guide` 39、
`probe-landscape-screens` 22、`probe-modals-landscape` 39、`probe-avatar` 30、
`probe-viewport-fit` 27、`probe-dev-panel` 21 全绿。

**线上核对**：`probe-online-smoke` 15/15（版本号 `20261031k` 与本地一致、sw `v95`）；
另外用线上地址复测了 `probe-table` 三档：1280×800 三张牌 **127×178**、375×667 **82×115**、
390×844 **114×160**，圆桌环各 15/15。

**仍然没做**：4:3 平板竖屏（768×1024，设计高只有 1000 —— 要圆桌就得先改「竖屏设计宽 750」
这条前提）；原型侧栏里的场景 A·B / 播放整局 / `__proto` 钩子（有意不做，见 BACKLOG N14）。

---

## v96 · 牌型特效落地审计 + 组槽实时牌型（版本 `20261031l` / sw `v96`，2026-10-31）

> 触发问题：「几种牌型的特效动画和相关前后场景的交互都真正落地了吗？」
> 审计报告：`docs/pattern-fx-audit.md`。

**审计结论：结算那一幕真落地了，组牌那一幕几乎没有。**

把一局拆成五段（S1 组牌 / S2 提交确认 / S3 等他人 / S4 结算 / S5 回桌）逐格核对：

| | S1 组牌 | S2 确认 | S4 结算幕 |
|---|---|---|---|
| 改前 | 8 个牌型里 **7 个是空的**（只有十点半有点数） | 只有牌名 | ✅ 5 种特写 |
| 改后 | 全部有牌型胶囊 | ✅ 带牌型 | ✅ 不变 |

一局里 S1 约 60 秒、S4 合计约 15 秒。**最该有反馈的那一段最空。**
硬证据：v95 之前 `game.js` 里 `Engine` 出现次数是 **0** —— 前端从来没做过一次牌型判定。

**这一版做了三处：**

| # | 内容 | 守它的东西 |
|---|---|---|
| 1 | `slotTypeOf()`：飘三叶满 3 张 / 斗牛满 5 张即报牌型，胶囊**顶掉** `n/n` | `slot-type.test.js` 50 条 + `probe-slot-type` 29 条 |
| 2 | 大牌型（`BIG_FX` 5 个）上牌型色 + 一次 `slotTypePop` 脉冲 + `.slot.is-fresh` 组光晕 | 同上（`is-new` 只放一次，不循环） |
| 3 | 提交确认弹窗每行追加 ` · 牌型名`（单张组除外） | 同上（探针读 `#confirm-desc`） |

**明确不做的三项**（每次都容易被重新提出来，所以写清楚）：

| 项 | 理由 |
|---|---|
| 大牌型震屏 / 手机振动 | 结算弹窗是滚动容器（`probe-modals-landscape` 6 条守滚动）；组槽脉冲已在表达同一件事；`navigator.vibrate` 在 iOS 不存在 |
| 「揭晓」独立成一幕 | 原型 `①揭晓 1.4s → ①结算 3.2s`，线上合并。一局已要按 5 次「下一组」，拆一倍是 10 次 |
| 单张组牌型胶囊 | 一张牌，牌面就是答案；大王有 `joker-glow`；四组里三组有胶囊会像漏了一组 |

**验收**：`npm test` 100 文件 / 4034 项、`journey` 126 项；`probe-table` 五档 0 失败、
`probe-slot-type` 29（连跑 4 次稳定）、`probe-big-fx` 21、`probe-result-seq` 57、
`probe-ready-button` 12、`probe-rollback` 22。

**线上核对**：`probe-online-smoke` 15/15（版本号 `20261031l` 与本地一致、sw `v96`）；
`probe-slot-type` 直接打线上地址 **29/29**（`LIVE=... node scripts/probe-slot-type.js`）。

---

## v97 · 四种牌型的「真跑」审计 + 10.5 成手信号（版本 `20261031m` / sw `v97`，2026-10-31）

> 触发问题：「**十点半、豹子、牛牛、五花牛，这四种牌型的特效动画和相关前后场景的交互
> 都真正落地了吗**」。上一版的答案是「按静态读代码看是做了」，这一版给的是逐帧实测。

### 新的证据链：只注入牌堆顺序，其余全真

新增 `scripts/audit-pattern-fx.js` + `scripts/rig-deck.js`。
后者用 `NODE_OPTIONS=--require` 预加载进服务端进程，**只包 `Card.shuffle` 一个函数**，
把牌堆顺序指定成设计好的三把；之后全部是真链路：

| 环节 | 真不真 |
|---|---|
| 发牌 / 提交校验 / 结算 / 广播 | 真（`submitGroups` 仍然校验「用满 6 张、不能有手牌以外的牌」） |
| `winnerTypeName` | 真（`engine.typeName()` 算的） |
| 渲染 / 动画 / 音效调用 | 真 Edge + 真 `computedStyle` |

三把牌覆盖四个牌型（一把两轮、第二轮沿用第一轮手牌）：

| 手牌 | 第一轮 | 第二轮 |
|---|---|---|
| A♠A♥A♦10♠J♥5♣ | 5♣ / **10.5 点** / **豹子**（一场结算两个大牌型） | 没牛（对照） |
| J♠Q♥K♦J♥Q♠K♣ | 顺子 / 1 点 / 顺子（对照） | **五花牛** |
| 5♣5♦10♠10♥J♥9♣ | 9♣ / 10 点 / 对子（对照） | **牛牛** |

AI 的牌固定成 rank 2/3/4/6/7/8（凑不出 10.5 / 五花牛 / 牛牛 / 豹子，见 `docs/pattern-fx-audit.md` §7.1），
所以「特写挂在谁身上」没有歧义。

### 结论：四种牌型都真落地了，除了 10.5 的组牌阶段

| | S1 组牌 | S2 提交确认 | S4 结算幕 | S5 回桌 |
|---|---|---|---|---|
| 10.5 点 | 满分绿徽标 + **成手脉冲（本版补）** + 组光晕 | 「· 10.5点」 | 横幅 + 12 粒子 + `fxHalo` + `win@1.12` | 交替卡 / 回桌 |
| 豹子 | 胶囊 `is-big` + `slotTypePop` + 组光晕 | 「· 豹子」 | 同上，橙色 | 同 |
| 牛牛 | 同上，金色 | 「· 牛牛」 | 同上 | 同 |
| 五花牛 | 同上，紫色 | 「· 五花牛」 | 同上 | 同 |

实测到的硬指标：`data-hold=3000` 与 `--hold=3000ms` 一致、相邻两幕间隔 2.4~4.2 秒、
12 颗粒子 `--a` 角度互不相同、粒子延迟 ≥0.18s、`::after` 的 `fxHalo` 在跑、
`win-row` 恰好 1 行、组卡底边不溢出滚动容器。

**唯一补的一处产品代码**：10.5 在组牌阶段原先只有一颗绿色「10.5」徽标，凑到满分那一刻
界面毫无反应（豹子/牛牛/五花牛都会弹一下）。原因很具体 ——
`is-fresh` / `--fx-color` / 脉冲全挂在 `typeName && typeFx` 上，而 `slotTypeOf('tenhalf', …)`
按设计返回 `''`。修法是给 `typeFresh` 一个合成名 `'10.5点'`，胶囊仍然不出，
组光晕与徽标脉冲复用同一套判定、同一支 `slotTypePop`。

### 验收

| 项 | 结果 |
|---|---|
| `audit-pattern-fx` | **208 项 × 4 档**（390×844 / 375×667 / 844×390 / 1280×800）**全绿** |
| `npm test` | 100 文件 / **4042 项** |
| `npm run journey` | 126 项 |
| `probe-table` | 390 / 375 / 844 / 1280 四档 0 失败 |
| `probe-slot-type` / `probe-big-fx` / `probe-result-seq` / `probe-rollback` | 29 / 21 / 57 / 22 |
| `slot-type.test.js` | 50 → **58** 条（新增 [9] 节守 10.5 的成手信号） |

### 线上核对

- `app-version` = `20261031m`、`CACHE_NAME` = `weile-liuxuanwu-v97`；
- **资源逐个比对 sha256**：线上 `js/game.js`、`css/style.css`、`js/engine.js` 与本地
  **完全一致**（`e0c04ce5…` / `202e95f7…` / `366a72fc…`）—— 本地真跑的结论就是线上这一份的行为；
- `probe-online-smoke` 15/15（含 SW 接管、无请求失败）。

**玩法级线上复测**：`probe-slot-type` 直接打线上地址 **29/29**（两轮都过）。

顺带修掉了它的两个「假故障」——两次让我以为线上坏了，其实都是探针自己的问题：

| 现象 | 真因 |
|---|---|
| 「注册未成功（多半是限流 429）」 | **昵称全局唯一**，探针写死 `'探针'`，第二次之后的注册全被「这个昵称已经被别人用了」挡掉。改随机后缀 |
| `Inspected target navigated or closed` | 刚发版时 `index.html` 的版本自检会自己 reload 一次，evaluate 撞在导航中间。加「`performance.now()` 连续两次 >3 秒」的稳定等待 |

10.5 的成手脉冲在线上**没有撞到**（那两手都没凑出 10.5，探针会打印「本小节跳过」）——
这一条的线上证据是「线上 game.js / style.css 与本地 sha256 完全一致 +
`audit-pattern-fx` 在本地四档视口都验过」。

---

## v98 · 牌型特写幕：把原型 `.fx` 层真的搬过来（2026-10-31）

版本：`app-version 20261031n` / `CACHE_NAME weile-liuxuanwu-v98`

### 起因：上一轮的「落地」结论是错的

v97 的结论写着「S1–S5 × 四种牌型全部 ✅」，依据是 `audit-pattern-fx` 208 项 × 4 档全绿。
玩家一句话就否掉了它 —— **「我在游戏里看不到十点半 / 豹子 / 牛牛 / 五花牛的特效动画。」**

真因不是动画没跑，是**跑的从来不是设计里那支动画**：
v83 落的只是原型 `.fx` 层的「组内版」（结算卡里一条 20px 金胶囊 + 12 颗飞 74px 的粒子 + 一圈描边），
而原型是一整幕 —— 920 旋转金环、三道冲击波、14 颗粒子飞 170~305、赢家牌 104/94/84 宽砸下来、
108px 大字从 2.3 倍砸进来、豹子/五花牛震桌。这八项里**线上有六项是 0**。

断言绿的真正原因：断言问的是 `bannerIn` / `fxBurst` / `fxHalo` 有没有跑 ——
那三个名字是**实现者自己写的**小动画，不是设计的名字。验收基准与设计之间没有一条线连着。

### 改了什么

- `#pattern-fx`（`#stage` 直接子节点，`z-index:52`）+ `.pat-*` 全套样式：
  `patSpin 7s infinite`（920 conic + 双层 mask）、`patWave` ×3（0/0.14/0.28s）、
  `patBurst` ×14（四档半径、两色交错）、`patCardDrop`（−110px / −7deg / 1.24，牌宽 104/94/84）、
  `patLblIn`（2.3 倍 / −7deg，108px / 900 / 10px 字距 / 3px 描边）、`patShake`（豹子·五花牛）。
- `game.js`：`buildPatternFx` / `playPatternFx` / `endPatternFx` / `stopPatternFx`，
  牛牛凑十高亮走 `Engine.douNiuPoint`（只挑高亮，不判牌型）。
- 时序：有特写这一幕的停留 = `hold + 1600`，`data-hold` / `--hold` / 脚注 / 定时器**同源**。
- 结算卡在特写期间 `opacity: 0`（`#result-modal.is-hero`），**不关弹窗** ——
  关了再开一张白卡会闪，探针也会看到「结算弹窗反复开关」。
- 开关：`CONFIG.PATTERN_FX`（默认开）/ `?patternfx=0` / `?fx=0` / 系统「减少动态效果」；
  点幕任意位置可跳过。

### 验收

| 项 | 结果 |
|---|---|
| `audit-pattern-fx`（新增 S4 特写幕一节） | **300 项 × 4 档**全绿（390×844 / 375×667 / 844×390 / 1280×800） |
| `pattern-fx.test.js` | 新建 **82 项**：第一节直接读原型文件当基准 |
| `npm test` | 101 文件 / **4132 项**（v97 是 4042） |
| `probe-result-seq` | 57/57（加 `patternfx=0`：它验节奏，不验特写） |
| `probe-big-fx` | 21/21 |

### 顺带修掉的

- `result-seq.test.js` 三条断言原来锁 `--hold = hold`，改成 `total`；
  同时新增一条「四处必须全部读 total」——否则会出现「文案说 3 秒、条子跑 4.6 秒」。
- `probe-result-seq` 加 `patternfx=0`：它验的是自动推进节奏，
  随机发到一次牛牛就会把 600ms 间隔断言变成 2200ms 而误报。

---

## v99 · 本局局数上限 + 结算统一（版本 `20261031p` / sw `v100`，2026-10-31）

### 为什么

用户两条需求：

1. 建房时要能选本局局数（3 / 5 / 10 / 15 / 30，默认 10），结束条件 = **打满选定局数 或 任一玩家分数 ≤0**；
   同一房间继续下一局时沿用建房时选的值。
2. 「打满局数结束的情况应该像有人到达底分结束一样，**统一的逻辑结算**，
   保持一样的界面选择退出或者下一局」。
3. 顺带把三条快捷短语换成新文案（p2 / p3 / p4）。

### 改了什么

- `pwa/js/config.js`：新增 `HAND_LIMITS = [3,5,10,15,30]`、`DEFAULT_HAND_LIMIT = 10`（前后端同源白名单）。
- `pwa/js/stateMachine.js`：`newRoom(id, owner, opts)` 收 `handLimit`；新增
  `normalizeHandLimit` / `handLimitOf` / `handLimitOptions`；`settleRound` 第二轮分支
  **在 `handCount += 1` 之前**判上限（`>=` 即结账，`endReason='handLimit'`，与爆分同一相位与同一收口 `markSettled`）。
- `server/hub.js`：建房参数白名单收敛（脏值回落 10、不做上限校验不报错）；落库 `endReason` 白名单补 `handLimit`。
- `pwa/js/roomStore.js`：local / ws / 门面三层 `createRoom(player, opts)` 透传。
- `pwa/index.html` / `pwa/css/style.css`：`#create-modal`（radiogroup + 五个档位，默认 10）+ 选中态样式。
- `pwa/js/game.js`：建房改「开弹窗 → 确认」；顶栏 `第 N/M 把`；结算文案三处补 `handLimit`；`MODAL_ORDER` / Esc / popstate 登记。
- `pwa/js/emoji.js`：p2 `你咋能这幸的。`、p3 `包开挂了先。`、p4 `一哈乏了。`
- 资源版本 `20261031o → 20261031p`，`sw.js` `v99 → v100`。

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **104 文件 / 4250 项全绿** |
| `pwa/test/hand-limit.test.js`（新增） | 47 项：3 局打满、少打/多打都不行、爆分优先、续局沿用、脏参数收敛 |
| `server/test/hand-limit-room.test.js`（新增） | 17 项：建房白名单、进房只读 |
| `pwa/test/handlimit-settle-parity.test.js`（新增） | 49 项：状态机 / 交互 / 界面分支 / 文案四层一致性 |
| `scripts/probe-create-modal.js`（新增） | 19 项（390 / 320 两个宽度） |
| `scripts/probe-handlimit-settle.js`（新增） | 26 项：3 局房打满 → 结算屏，五颗按钮在视口内；续局仍是 `1/3 把` |
| `scripts/probe-online-smoke.js` | 线上 15 项全绿（版本号 = `20261031p`） |

### ⚠ 数值备注（本轮实测，未改动数值）

一把最坏 −17 分（单张 1 + 十点半 2 + 飘三叶 4 + 斗牛 9（五花牛 4 + 无牛罚 5）），
典型波动 ±5~8 分/把，所以 **20 分初始分只够扛 2~3 把**：

- 3 局档：约一半能真的打满（探针两次跑，一次 3 次尝试都没撞上）
- 5 / 10 / 15 / 30 档：基本都由爆分收尾 → 高档位实际是「上限保险丝」，不是「时长选择」

这不违反用户给的规则（爆分优先），但意味着 10 以上档位对玩家是**无效选择**。
三个解法（A 爆分改出局 / B 初始分随档位缩放 / C 承认现状只改文案）写在
`docs/hand-limit-plan.md` §8.3，**本轮按 C 处理，没有动数值**。

### 已知限制

1. 结算页**没有宣布冠军**（固定局数后「谁赢」需要一个显式答案，建议下一轮补高亮）。
2. 档位不记忆：每次打开弹窗都回到 10（严格按产品口径）。
3. 一批旧的 `scripts/probe-*.js` 里 `click('btn-create')` 现在要多点一次确认按钮才会进房（它们不进 CI）。

---

## v103 · 删掉「爆分即结束」，局数成为唯一终局（版本 `20261031q` / sw `v101`，2026-10-31）

### 为什么

v102 实测出一个数值事实：20 分本金只够扛 2~3 把（每把最坏 −17、典型波动 ±5~8）。于是
**5 / 10 / 15 / 30 四个档位全都会被「有人分数 ≤0」抢先截断**，玩家选了 10 局其实 3 把就结束，
等于没选。用户据此决定：去掉「分数到 0 就结束」，指定多少局就打满多少局。

> 原话：「所以我建议去掉有人分数到达底分就结束的逻辑，创建房间的时候指定多少局，
> 就达到完为止，结算逻辑和退出继续逻辑保持和以前一致。」

### 改了什么

- `pwa/js/stateMachine.js`
  - `settleRound` 组级循环：**删掉**见底判定（`score <= 0` → `break` + 打 `out` 标记）。
    本轮所有组一定算完，`results.length` 恒等于组总数。
  - `settleRound` 收口：**删掉** `if (busted.length) → SETTLED / endReason='scoreZero'`。
  - `handLimitOf`：**删掉** `if (v === 0) return Infinity`。删了爆分终止之后，
    Infinity 不再等于「回到老行为」，而是**永不结束** —— `0` / 负数 / NaN 一律回落默认 10。
  - 注释全面更新（文件头状态机图、`endReason` 与 `bustedIds` 字段说明）。
- `pwa/js/game.js`
  - 房间信息卡：「见底：分数 ≤ 0 出局，最后一人胜出」→「本局：N 局 · 打满为止」。
  - 逐组结算幕末文案：「有人见底 · X 秒后结账」→「本轮提前结束 · X 秒后结账」（老数据兜底）。
  - 「本轮剩下 N 组没有进行」保留结构，文案去掉「有人见底」。
  - `settleReasonText` 的 `scoreZero` 分支**保留**（老战绩要能念成人话），加注释说明。
- `pwa/index.html`：建房说明「打满选定局数或有人分数见底即结束」→「打满选定局数收手，中途不提前结束」。
- 资源版本 `20261031p → 20261031q`，`sw.js` `v100 → v101`。

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **104 文件 / 4255 项全绿** |
| `pwa/test/group-settle.test.js`（整份重写） | 53 项：三组全算 / 负分合法 / 0 分继续被扣 / 续局重置 / 第二轮跌破 0 仍算完 |
| `pwa/test/hand-limit.test.js` | 52 项：−100 分照常进第二轮、仍由 `handLimit` 收尾、`0` 回落 10 |
| `pwa/test/handlimit-settle-parity.test.js` | 49 项：对照组从「爆分」换成 `someoneLeft` |
| `pwa/test/big-fx.test.js` | 58 项：新增「文案不再出现『有人见底』」 |
| `scripts/probe-ten-hands.js`（新增） | **23 项全绿**：默认 10 局、20 轮真打完、第 5 把出现 −1 分仍在牌桌、结算写「打满 10 局」、显示 −40 分、续局仍 10 |
| `scripts/probe-handlimit-settle.js` | 26 项全绿，**第一次就撞上「打满」**（以前要重试 3 次） |

真机截图：`tmp-shots/ten-hands/negative-onscreen.png`（−1 分仍在分牌）、
`tmp-shots/ten-hands/settle-ten-hands.png`（80 分 / −40 分，说明「打满 10 局」）。

### 顺带修掉的老不公平

以前第 1 组就跌破 0 的人会被 `break`，**后面两组的输赢直接蒸发** —— 同一手牌换个座位顺序，
最终分不一样。新规则三组全算，测试里钉了：甲第 1 轮崩到 −4，靠第二轮斗牛 +6 翻回正分
（旧实现在 −1 那一刻就判出局，那 +6 永远拿不到）。

### 各档位的真实时长（改完）

| 档位 | 以前 | 现在 |
|---|---|---|
| 3 局 | 约一半能打满 | 一定打满（6 轮） |
| 5 局 | 多数被截断 | 一定打满（10 轮） |
| 10 局（默认） | 2~4 把就结束 | **一定打满（20 轮）** |
| 15 / 30 局 | 走不到 | 一定打满 |

### 已知限制

1. ~~结算页仍然没有宣布冠军~~ —— **这条当时写错了，结算页一直有冠军**（金底 + 🏆 + 名次角标）。
   真问题在**口径**：按「当前分数取首行」，弃局者可能戴冠、同分由入座顺序决定。v104 已定口径（见下）。
2. 基于 `endReason === 'scoreZero'` 的历史指标分母将永久为 0（老数据仍可查）。
3. `scripts/probe-handlimit-settle.js` 里还留着「被爆分抢先就重试」的死逻辑，下次顺手清掉。

---

## v104 · 冠军口径 + 注释清理 + CSS 降级（版本 `20261031r` / sw `v102`，2026-10-31）

本轮不是需求，是把「文档说的」和「代码做的」对齐。方式是**拿文档的说法去 grep 代码**，
查出 7 处矛盾 + 2 个从没量过的问题，然后逐条判断「该改文档还是该改代码」——
只有两处真动了行为。

### 为什么

三轮迭代（v99 / v102 / v103）改得很快，文档跟不上：规则说反了 2 处、同一份文档自相矛盾 1 处、
结论已被推翻还挂着 1 处、线上版本号差 22 个版本。这些不会让程序崩，但会让下一个人
**按文档改代码**——那才是真正的事故来源。

### 改了什么

**代码（行为，2 处）**

- `game.js` 新增纯函数 `settleRank(players)`，`settleListEl()` 不再自己 `sort`：
  - 中途弃局者（`p.left`）**不计名次**，按分数降序沉底，`rank = 0`；
  - 其余人竞赛式排名（1,1,3），**同分并列同名次**，并列角标前加「=」；
  - 冠军 = 所有 `rank === 1` 的人，可以不止一个；全员弃局则没有冠军。
  - 渲染：弃局行 `.is-abandoned` 压暗、头像圈换中性色、角标「—」、aria「已离开，不计名次」；
    并列冠军额外挂「并列」胶囊，aria 念「并列第 1 名」。
- `style.css`：`inset` 13 处补 `top/right/bottom/left` 长手写；`.av-cell` 加
  `@supports not (aspect-ratio: 1/1)` 兜底；`conic-gradient` 三处前面加纯色底。

**代码（注释，7 处）**：`stateMachine.js` 4 处、`server/hub.js` 1 处、`game.js` 2 处、
`style.css` 2 处，全部从「爆分优先 / 无人见底 / 见底出局」改成 v103 口径。
**刻意不动**：`END_REASON_TEXT.scoreZero`、`p.out`、`bustedIds`、`.result-abort-note`
—— 老战绩里真有这些值，删了会让旧记录念成「正常打完」。

**文档（7 处矛盾）**：README 规则 2 处、`hand-limit-plan` 自相矛盾 1 处、
`pattern-fx-audit` 结论 1 处、`compat` `:has()` 1 处、`BACKLOG` 版本号 1 处、
`rollout-status` iPad 竖屏 1 处。

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **105 文件 / 4305 项全绿** |
| `pwa/test/settle-champion.test.js`（新增） | **48 项**：把 `settleRank` 从源码里取出来**真跑** —— 弃局者 40 分不夺冠、同分两人都是冠军且第三名是 3、全员弃局无冠军、0 分并列、负分排名次、不改入参 |
| `pwa/test/settle-replay.test.js` | 56 项。**两条旧断言守的正是 `i + 1`**，改成守 `r.rank`，并新增一条「不许再用 `i+1`」 |
| `node scripts/gen-flex-gap-fallback.js --check` | 「最新（99 条规则）」—— 新样式没把兼容层带过期 |
| `probe-online-smoke` | 15/15（发布后） |

### 已知限制

1. **CSS 降级没有老内核真机样本**（Chrome 84–86 / iOS 14），保证的是「声明不被整条丢弃 +
   有可读的降级外观」，不保证像素级一致。文档因此写「能玩」，不写「完整支持」。
2. `:has()` 那 1 处**保持原样**（本来就有退回两列的降级），只在文档里更正了说法。
3. 弃局者的**净胜是否该从战绩胜负统计里剔除** —— 那是战绩页口径，本轮没碰。

---

## v105 · 三族设备支持（版本 `20261031u` / sw `v105`，2026-11-01）

### 为什么

两条，一条来自用户裁定，一条来自"自己量一遍才发现"：

1. **范围裁定**：用户明确「必须支持 iPhone / 安卓 / 电脑三族，**平板与折叠屏可以不支持**」。
   这让 N17 / N19 / N20 三项待办一起标"不做"，也让 `--assert` 可以拆成硬门（三族）与
   记录（平板·折叠屏）两层 —— 以前不敢拆，是因为拆了就像在给自己找台阶。
2. **旧闸门撑不住了**：版式判定原来是一个两百行的巨型 `if`，输入散落在
   `#app` 的 computed style、`visualViewport`、`matchMedia` 三处。缩到电脑左右分屏
   （728×348 这类窄高窗口）时判成竖屏，组槽溢出 195px；
   而 `scale 0.5` 那道阈值是圆桌早期为了凑一个特定机型的产物，早就没有理由（C8）。

### 改了什么

- **闸门纯函数化**：抽出 `pwa/js/ringGate.js`，输入只有 `{宽, 高, 字号, 安全区, 人数}`，
  输出唯一一个版式档。没有 DOM、没有全局、没有时间 —— 所以可以在 Node 里直接跑。
  电脑窄高窗口改走横版；`scale 0.5` 阈值删除。
- **字号 → 热区的反算**：热区不再写死 44，而是从设计字号反算，
  改一档字号不会再让一排按钮掉到 44 以下。`.auth-link` / `.guide-skip` /
  `.rp-replay` / `.audio-toggle--sm` 统一「`padding` 撑热区 + 等量负 `margin` 抵消位移」
  （inline 元素 `min-height` 无效，这是唯一不挪版面的写法）。
- **全流程巡检上线**：新增 `scripts/probe-ui-flow.js`，12 视口 × 12 屏起，
  一次量出 9 处既有 UI 缺陷（横屏尾注出界、就位态在矮横屏上重叠、弹窗层叠遮挡…）。
  这些的共同点是**单测永远看不见**：要的是真浏览器里的一行 `getBoundingClientRect()`。
- **真机协议**：新增 `scripts/probe-devices.js`，三族硬门 23 档 + 平板·折叠屏 24 项记录单列。

### 验收

| 项 | 结果 |
|---|---|
| `pwa/test/ring-gate.test.js`（新增） | 33 项 —— 所有档位的边界值逐一钉死，反例是"按宽高独立判断"的旧写法 |
| `probe-devices --assert` | 三族硬门 **23 档全绿** |
| `probe-ui-flow` | 12 视口 × 12 屏 = 144 屏，修完 9 处后五类硬问题 0 |
| `npm test` | 107 文件 / 4405 项 |

### 已知限制

1. **平板与折叠屏不做**（范围裁定），`--assert` 只记录不判定；记录见 `docs/device-support.md`。
2. 软问题（热区 30~44）不修：桌面无关、触屏偏小，但**够用**；
   大规模改热区会连带挪版面，收益不抵风险，登记在册。

---

## v106 · 三个用户实测反馈（版本 `20261031v` / sw `v106`，2026-11-01）

### 为什么

自动化全绿之后，用户上手玩了几局，提了三件事 —— **三件都对**。

其中第 ② 条是这一轮真正的价值所在：它要求**两个真人在几十秒内卡进同一个窗口期**，
任何脚本化探针都不会自发走到那个状态。这类 bug 只能靠人玩出来。

### 改了什么

**① 起始分 20 → 0。** 它没有功能：v103 删掉「见底出局」之后，它既不是筹码池、也不是保底、
更不参与胜负判定，只剩给「净胜 = 最终分 − 初始分」当减数。它还会**说错话** ——
房间卡「起始 20 分」读起来像兜里有筹码、输完出局。

顺带挖出一条更严重的：**规则页一直在教一条已经不存在的规则**。
v103 删「见底出局」时漏改了 `guide-tip` / `rules-lead` / `rules-end` 三句，
起始分归 0 之后它们变成自相矛盾（开局即结束）。**没有任何测试会去读文案，它活了三个版本。**

**② 「改一下」被别人的提交抢先结算。** 根因不是判断写错，是**服务端根本不知道有人在改**：
前端只设了纯 UI 变量 `state.reviseRound`，状态机里 `p.submitted` 一旦 true 永不回落。
于是最后一人提交时立刻 `settleRound`，用他还没改完的旧分组把他结算掉，全程零提示。

修法是新增 `p.revising` + `StateMachine.isRoundLocked(p, round)`，作为「定稿」的**唯一口径**。
原来「到齐」这件事在 `submitGroups` / `forfeitRound` / `settleIfAllIn` 三处各写一遍，
注释里还写着「口径要与另外两处保持一致」—— 那说明它已经在靠人记着了。

四个容易漏的边角，每一个都能单独让功能变成坑：
- **正在改的人必须挂分牌倒计时**（旧逻辑「已提交就不挂」→ 他掉线会吊死全桌）
- **超时语义要分叉**：有旧分组的人超时 = **放弃修改**，不按弃权罚 ——
  否则「点过一次改一下」比「什么都不做」更亏，以后没人敢用这个按钮
- **取消修改不消耗额度**（否则等于给了一个只能用一次的假功能）
- `#btn-revise` **一按钮两语义**（改一下 / 不改了），文案必须跟着状态走

**③ 满组拖拽交换。** `moveSlotCard` 里「目标组满了就拒绝」，六张全入组后**任何**目标都是满的 ——
交换这条路根本不存在；`removeCard + placeCard` 也走不通（`placeCard` 同样拒绝满组）。

新增 `StateMachine.swapCards()`：交换**不需要容量校验**，两组张数一进一出前后完全相等。
界面侧有两个细节，错一个就静默失效：
1. **落点先判牌、再判组** —— 槽牌就住在组里，组的矩形把它整个包住；判反了
   「落到某张牌上」永远会被解析成「落到这个组」，交换永远触发不了
2. **交换分支必须排在 `if (!d.slotKey) return` 之前** —— 落到牌上时 `slotKey` 是显式置 null 的

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **108 文件 / 4463 项全绿** |
| `pwa/test/revise.test.js`（新增） | 52 项。含**对照组**（不走 `beginRevise` 就会结算 → 证明 bug 路径真实存在）+ **证红**（把 `isRoundLocked` 里的 `revising` 条件换成 `return true`，当场挂 11 项） |
| `pwa/test/swap.test.js`（新增） | 35 项。张数守恒、往返复原、三种拒绝不动草稿、5 条源码守卫（含顺序那条） |
| `probe-ui-flow` | 扩到 **13 屏**（新增「对局·交换」：真派发 `pointerdown/move/up` 拖一次）。全矩阵 **12 视口 × 13 屏 = 156 屏 ALL PASS**，五类硬问题 0，`[交换]` **12/12** |
| `probe-online-smoke` | **15/15**（发布后）：版本号 `20261031v`、sw `weile-liuxuanwu-v106`、manifest 200、无 HTTP ≥ 400 |

**为什么交换必须单独做端到端验证**：单测能证明 `swapCards` 这个纯函数对，
证明不了「手指拖过去真的会换」—— 中间隔着 `elementFromPoint` 的落点判定和一串接线。

顺带记一个探针坑：验完交换必须**再拖一次换回来**，
否则十点半那组构成变了、点数可能爆，下一步撞上 `#bust-modal`，白等 180 步（实测 72 秒/档）。

### 顺带发现：两条断言在起始分归零后变成**恒真门**

改完 ① 顺手 grep 残留的「20」，本意只是清注释，撞上两个测试。
它们不是「注释过时」，是**守卫不再守任何东西**：

| 位置 | 原写法 | 为什么失效 |
|---|---|---|
| `server/test/forfeit-timeout.test.js` | `ok(score < 20, '弃权后被扣分')` | 归 0 后，一分不扣停在 0 分时 `0 < 20` 照样通过 —— 它只在证明「0 比 20 小」 |
| `pwa/test/voided-criterion.test.js` | 夹具 `{A:20, B:20}` + 断言「不作废」 | 本意验「打完正好回到基准分、只有 `anyScoreChange` 能救这局」，但 `20 !== 0` 让**兜底判据**先判成「动过分」→ 通过得毫无判别力 |

**这是最难自查的一类错**：测试绿、覆盖率没掉、断言条数没变，
唯一症状是「它通过的理由和你以为的不一样」。

修法：两处都改成读 `CONFIG.INITIAL_SCORE`；`voided-criterion` 补一条**结论相反的对照组**
（同样的分数、不打标记 → 必须作废），全量断言从 4462 涨到 **4463**（就是这一条）。

**留一条规则给下一次：改基准值 / 阈值时，grep 的不只是生产代码，还有断言里的字面量。**
断言写死阈值 = 阈值一改，断言就变成同义反复。

### 已知限制

1. v105 与 v106 的改动在 `index.html` / `style.css` / `game.js` 上交织，**无法干净拆成两个提交**，
   所以两版合成一次提交（`57423c7`）一起发。
2. 软问题 226 条（热区 30~44）、半行硬切 1 条
   （安卓竖 360×640 / 结算组槽只露 95%，滚一下可见）—— 均为已知登记项，不阻塞发布。
3. 「改一下」的额度仍是**每轮 1 次**。取消不消耗，但用过一次就没了；
   要不要按局给额度是产品口径问题，本轮不动。

---

## v107 · 座位面板的信息档不再重复一遍战绩卡（版本 `20261031w` / sw `v107`，2026-11-01）

### 为什么

用户上手点了一下自己的头像，问了三句话：

> 「这里的展示逻辑是不是重复了 脱裤子放屁为什么这么设计 有必要吗 只保留第二个可以吗」

**三句话都对。** 点自己头像 → 弹出信息档（三个数字 + 胜平负 + 「看完整战绩」）→
点进去 → 战绩卡的头两行**和刚才一模一样**。中间隔着的是一次点击、一次请求、
一次面板关闭、一次弹窗打开和两次动画。

第一层连"更快"这个借口都不成立：它走的也是 `RoomStore.getProfile(pid)`，也显示「加载中…」。

这不是"概览 → 详情"，是同一个东西讲了两遍。

### 改了什么

- **抽 `profileBodyHtml(profile)`**：三个数字 + 胜平负 + 最近 5 局 + 尾部说明合成一份标记，
  整张战绩卡（`#profile-body`）和座位面板的信息档（`#ss-info`）共用。
  删掉「看完整战绩」按钮和它对应的 `data-ss-full` 处理分支（留着就是死代码）。
- **只有一个分档时隐藏分档条**：点自己、或关掉表情开关时，面板里只剩「信息」一档。
  一个只有一个选项的切换条不是导航，是装饰。分档逻辑本身不动，只是不再显示。
- **异步填充后必须重新定位**：`setSeatTab()` 末尾和 `renderSeatInfo()` 每个分支出口
  都补 `placeSeatSheet()`。实测差 405 设计px（192 → 597），矮横屏不重排直接出屏。
- **样式作用域补齐**：`.pf-record` / `.pf-note` / `.pf-recent-empty` / `.pf-loading` /
  `.profile-box p` 这些规则原来只挂在 `.profile-box` 下，信息档不在那个作用域里。
  选择器改成同时点名 `.profile-box` 和 `.ss-info`。
  （旧版信息档只用过三个数字框，那是全局样式，所以这个坑一直没暴露。）
- 删掉 `.ss-more`（按钮没了，样式也没用了）。

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **108 文件 / 4463 项全绿** |
| `scripts/probe-seat-info.js`（新增，`npm run probe:seatinfo`） | 11 项 × 4 视口。390×844 / 360×640 / 728×348 / 844×390 全部「面板完整落在舞台内并留出 16px 边距」 |
| 最紧的一档 | 728×348：`top 158 + 高 602 = 760 = 舞台高 776 − 16`，**正好夹在极限上**；不重排的话底边 821，直接出屏 |
| `probe-ui-flow` 单档 | `ONLY="390×844"` → 1 视口 × 13 屏 ALL PASS，`[交换] OK` |
| `probe-online-smoke` | **15/15**（发布后）：版本号 `20261031w`、manifest 200、无 HTTP ≥ 400 |
| 线上 `sw.js` 直抓 | `CACHE_NAME = 'weile-liuxuanwu-v107'` —— 老客户端这次真的会换缓存 |

### 探针里踩到的两个坑（都写进脚本注释了）

1. **「落点变了」是自证，不能用**：盒子变高，底边当然会变，恒真。
   有判别力的是**夹取不变量**：`top ∈ [pad, 舞台高 − 面板高 − pad]`。
2. **设计像素 vs CSS 像素**：`offsetHeight` / `offsetTop` / `stage.offsetHeight` 在
   `#stage` 的 `transform: scale()` 里，三者单位一致可以直接比；
   混用 `getBoundingClientRect()`（CSS 像素）就会得出「面板 606 高、矩形只有 315」这种鬼话。

### 顺带修掉一条站错层级的守卫

`pwa/test/ring-gate.test.js` 里守「`.gt-emo` 热区接了 `--tap-min`」的正则写的是
`/\n\.gt-emo \{\n  flex: .../` —— **只认 LF**。而这条链路上任何一次 `git stash` /
`git checkout` 都会按 `core.autocrlf` 把文件写成 CRLF，于是 `{` 后面变成 `\r\n`，
一条与设计毫无关系的守卫突然变红（本轮真的踩到了）。

改成 `\r?\n`。已经用三种样本验过：
LF → 新旧都通过；CRLF → 旧挂新过；把 `max()` 换回写死 `88px` → **新旧都挂**（不是空转门）。

**教训**：守源码的断言不该依赖行尾 —— 那是环境属性，不是设计属性。

### 已知限制

1. **短横屏上这面板几乎占满整屏**（728×348 时是舞台高的 98%）。这是"贴着座位弹"在
   矮屏上的必然结果，不是回归 —— 之前那张居中弹窗更占屏。想更好只能改版式，另开一轮。
2. `probe-emoji.js` **在本轮之前就已经是红的**（开局那步就进不了牌桌），已在未改动的
   HEAD 上复现确认不是本次引入。一个长期没人看的探针等于没有。

---

## v108 · `game.js` 跨文件拆分（版本 `20261101a` / sw `v108`，2026-11-01，提交 `b064af6`）

### 为什么

`docs/BACKLOG.md` 的 **C1** 挂了很久：`pwa/js/game.js` 8168 行，
一个文件同时承担 7 个屏的渲染 + 事件 + 状态。

v79 做过一半 —— 把 `bindEvents` 按屏拆成 11 个具名嵌套函数，**定位成本降了，文件一点没小**。
C1 原文写清了为什么当时停手：

> 「26 个测试文件用 `readFileSync('js/game.js')` 做源码级断言（46 处引用）……
>  跨文件拆分必须**单独一轮**。纯重构、零行为变化，但"零行为变化"这件事
>  需要单独一轮验收才敢说 —— 混在功能提交里等于赌。」

这一轮就是那一轮。用户口径明确：**「制作 game.js 的拆分，不要动游戏的数值也不要加复盘」**。

### 改了什么

`pwa/js/game.js` 8168 → **4710** 行，拆出 8 个模块（全部通过 `node --check`）：

| 文件 | 行数 | 形态 |
|---|---|---|
| `js/gameUtils.js` | 118 | 立即执行（纯函数） |
| `js/cardView.js` | 269 | 工厂 `create(deps)` |
| `js/modalKit.js` | 208 | 立即执行 |
| `js/historyKit.js` | 234 | 工厂 |
| `js/accountView.js` | 588 | 工厂 |
| `js/settleView.js` | 846 | 工厂 |
| `js/seatSheetView.js` | 628 | 工厂 |
| `js/recordsView.js` | 1355 | 工厂 |

**总手法：只搬定义，不动调用点。** 模块把注入项解构成与 `game.js` 完全同名的局部变量，
主文件里几千处调用点一个字没改。反向做法（调用点全改成 `LXW.state.xxx`）要改几千处，
漏一处是运行时炸，不是编译期报错。

配套改动：

- `index.html`：`game.js` 之前插 8 个 `<script>`（`gameUtils` 必须第一）
- `sw.js`：`PRECACHE` 加 8 个路径（任何一个 404，整页是白屏而不是降级）+ `CACHE_NAME` → `v108`
- `pwa/test/helpers/gameSource.js`（新增）：28 个测试统一从「多份源码拼接」读取
- `pwa/test/module-contract.test.js`（新增，39 项）：模块与主文件的接口契约守卫

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **109 文件 / 4502 断言 / 0 失败** |
| 断言数不减（C1 硬要求） | `pwa/test` 下**逐文件**断言数与 HEAD **完全相等**；用 `git worktree` 拉 HEAD 实跑基线确认（4461 → 4463，多出的 2 项是 server 侧 `gzip.test.js` 的数据依赖分支，不是删改） |
| 函数搬迁是否忠实 | HEAD 版 334 个函数体逐一比对：**丢失 0 个**，差异全是机械改写 |
| `npm run journey` | **126 项全绿** |
| `probe-ui-flow` 全矩阵 | **12 视口 × 13 屏 ALL PASS**，0 处「未进结算」告警 |
| `probe-ui-flow` 单档 A/B | 与 HEAD 基线逐屏一致（含 `[交换] OK`、`上一步 confirmed`） |
| `probe-seat-info` | 11 项 × 4 视口全过 |
| 其余 12 个探针 | `modals-landscape` 39/39、`avatar` 30/30、`records` 20/20、`handlimit-settle` 26/26、`big-fx` 21/21、`room-actions` 20/20 全绿；`emoji` / `result-seq` / `slot-type` / `create-modal` / `leave` 的红在**未改动的 HEAD 上逐项复现相同结果**，属既有问题 |
| **发布后**：`probe-online-smoke` | **15/15**——浏览器实测版本号 `20261101a`、manifest 200 且图标为 data URI、`installabilityErrors` 为空、无任何 HTTP ≥ 400、Service Worker 已接管 |
| **发布后**：直抓线上文件 | `sw.js` → `CACHE_NAME = 'weile-liuxuanwu-v108'`；`index.html` → 版本号只有 `20261101a`（无旧版残留）；8 个新脚本全部出现在线上 `index.html`（少一个就是白屏） |

### 拆分过程中挖出的 5 处静默失效

全都不报错、不动 UI、**当时 4463 条断言全绿**，现象统一是「点了没反应」：

1. **`modalKit.js` 导出块整块丢失** → `api` 是空对象 → 建房/账号/规则/战绩**所有弹窗全哑**。
   探针报 `TypeError: showModalEl is not a function`。
2. **`cardView.js` 8 个尺寸常量没导出** → 牌面视觉正常（模块内部值），
   但主文件的布局计算全变 `NaN`（扇形排布、飞牌落点、组槽上界）。
3. **9 个依赖按值传引用，而 `var` 赋值在创建点之后** → `settleView` 的弹窗/滚动渐隐/`roomHasBot`、
   `accountView` 的弹窗与 `recordsPid` 永久是 `undefined`。
4. **`settleView` 用了裸 `BIG_TYPES`**（住在 `cardView` 里，没注入）→ 结算页 `render()` 抛异常。
5. **`settleView` / `seatSheetView` / `recordsView` 都用了裸 `state`，三个都没注入** → 同上。

第 4、5 条的实际表现是：**房间到第 2 轮起界面不再重绘**，
`J.finish()` 空转 180 步仍在 `screen-game`，看起来像「提交按钮点了没反应」。

**为什么特别难查**：`js/roomStore.js:537` 把订阅回调包在 `try { cb(room) } catch (e) {}` 里，
异常被静默吞掉 —— 连控制台都不进。最后是靠临时给回调套一层 `try/catch` 抓栈才看见
`ReferenceError: state is not defined at settleView.js:273`。

### 新增守卫为什么站对了层级

旧断言查的是「源码里有没有这段文本」；这次的 bug 全在「两边接得上吗」。新守卫只问接口：

| 组 | 守什么 |
|---|---|
| 1 | 8 个模块能在严格模式下加载（裸赋值 `X = 1` 会炸，`node --check` 查不出） |
| 2 | 每个工厂能创建，导出不是空对象 |
| 3 | `game.js` 里每个 `NS.key` 读到的名字，模块里真的有 |
| 4 | 传进工厂的依赖，在创建那一刻**真的已经有值**（认 `async function` 提升、认逗号链声明、认透传包装） |
| 5 | 模块里读的常量与 `state` 必须有来源（本文件 / `deps` / 全局） |

四组都用**已知坏样本证过会红**（删一行导出、退回直接传引用、删 `BIG_TYPES` 注入），
不是空转门。第 5 组的白名单从沙箱全局动态取，以后 `index.html` 加库不用改守卫。

### 关键取舍

- **`recordsView` 的创建点挪到 modalKit 解构之后**：它要 `showModalEl` / `isShown`，
  那些是 `var`（不提升值），在原位置创建拿到 `undefined` → 弹窗开关静默失效。
- **`historyKit ↔ recordsView` 的循环依赖用 getter 打破**：直接传值会固化 `undefined`。
- **9 个函数依赖包一层透传**而不是重排 250 行装配代码：局部改动风险更小，第 4 组会盯着。
- **`api.x = function` 全改回 `function x()` 声明**：几十条源码守卫用 `/function (\w+)\(/`，
  改模块写法比改断言安全 —— 断言代表设计意图。

### 明确没做

- **不动数值**：上一轮 review 建议 `DOUNIU_NONE_PENALTY` 5→2，本轮不采纳。
- **不加复盘**：上一轮 review 把「结算页加一句复盘」列为性价比最高改动，本轮明确排除。
- **不修 5 个既有红探针**：在未改动的 HEAD 上复现相同结果，混进来会让「零行为变化」不可证。

### 已知限制

1. **全仓行数反而 +788**（8168 → 8956）。多出来的是文件头注释、注入解构、导出清单。
   C1 原文就写了「想通过这次改动减少行数、减少加载体积的，**没有拿到**」——
   拿到的只有定位成本。要减体积得另开一轮做真正的裁剪（例如把 proto 页与开发面板分出去）。
2. **`roomStore.js:537` 的 `catch (e) {}` 仍然吞异常。** 它是本轮最大的排查障碍。
   改成「只在开发态上报」是独立的一小步，但会改变线上错误上报量，不适合混在纯重构里。

---

## v110 · 复盘可见性 + 探针接入 CI + 记住把数（版本 `20261101c` / sw `v110`，2026-11-01）

### 为什么是这三件

按项目所有者 2026-11-01 的逐项裁定排的 P0/P1。三件事的共同点是：
**都不是加玩法，而是把已经存在的能力接到玩家或流程上。**

| 做了什么 | 原来卡在哪 |
|---|---|
| 结算页显示「理论最高 X · 你拿了 Y」 | `ai.js` 早就能在 1ms 内枚举 60 种分法打分，但只用来决定机器人出牌，从没让玩家看过 |
| 探针接进 CI | 45 个脚本一个都不在 CI，全靠人记；而 v108 已实证「4463 条断言全绿 + CI 全绿，真浏览器里所有弹窗全哑」 |
| 记住上次选的把数 | 每次开房都要重选，产品口径原本是「不选就是 10，不记」 |

### 1. 复盘：理论最高 vs 实际（P1-1）

新增 `pwa/js/bestLine.js`（纯逻辑，双端可 require）。核心约束是
**只用 `Engine.settleGroup` 算分，不自己写比较器** —— 否则某天引擎改规则，
复盘会说「你能拿 6 分」而结算给 5 分，那比没有这个功能更糟。

- 第一轮 60 种分法（6 × C(5,2)）× 3 组 + 第二轮 6 种 × 2 组 = **192 次 `settleGroup`，实测 6ms**
- 十点半爆点的分法不参与最优（玩家根本提交不了）；整手都爆时才退回全体最优，与 `ai.js` 的 `bestSafe || best` 同口径
- 只在「我」那张卡里显示，别人没有 —— 给别人算最优是公开处刑
- 文案是「理论最高 / 你拿了」，不用「亏了」：亏不亏取决于运气，这个数字衡量的是决策

**实施中抓到一个不会报错的 bug**：第一版按 `room.handId` 过滤 history 取「这一把」，
而结算页读到 `handId=2`、history 里两条的 `hid` 全是 1 → 过滤出 0 条 → 复盘行整块消失。
页面其余部分完全正常，**4589 条单测全绿**，是探针新加的 4 条断言当场报红才发现的。
现在过滤逻辑抽成 `bestLine.lastHandRounds`，并单独立了回归测试。

### 2. 探针接入 CI（P0-1 / P0-2）

**8 个红探针全部修好，没有一个是功能坏。** 根因高度集中：v103 把「创建房间」
改成两步（先弹「本局打几把」，确认才开房），探针还按一步点 → 房间根本没建。

| 探针 | 修前 | 修后 |
|---|---|---|
| probe-emoji | 0/2 | 44 |
| probe-tenhalf | 0/2 | 39 |
| probe-leave | 5/14 | 19 |
| probe-ready-button | 8/4 | 12 |
| probe-table-ready | 16/17 | 34 |
| probe-result-seq | 崩 | 62 |
| probe-slot-type | 崩 | 29 |
| probe-rollback | 8/14 | 22 |

最能说明问题的是 `probe-tenhalf`：它报「**找不到一对会爆的牌**」，
听起来像发牌坏了，实际是它连牌桌都没进去 —— **测试把「自己坏了」说成「产品坏了」，还说得很具体。**

`#btn-create` 之后补确认那一步时踩了三个坑，都记在脚本注释里了：
① 页面内字符串里不能写 Node 侧的 `await sleep()` ② 单参数 `evaluate(expr)` 的文件不能照抄双参数写法
③ 模板字符串会吃掉 `\d` 的反斜杠，正则必须写成 `[0-9]`。

CI 那侧的阻塞是 **41 个脚本硬编码了 Windows 的 Edge 路径**。解法不是改 41 个文件，
而是新增 `scripts/lib/browser.js`（跨平台探测）+ `scripts/probe-ci.js`（进程级重定向 `spawn`），
**41 个脚本一行没改**。`.github/workflows/test.yml` 新增 `ui-probe` job：
竖屏巡检 68s + 横屏巡检 68s + `journey.js` 18s，与单测并行跑。

### 3. 记住上次的把数（P1-2）

`localStorage` 键 `lxw_hand_limit_v1`。三条约束：值必须在 `CONFIG.HAND_LIMITS` 里
（档位列表改了，老记忆自动失效）；读写都包 try（隐私模式会抛）；
记的是**这次真的提交出去的**档位，不是「点过的最后一个」。

推翻的旧口径：原注释写「每次打开都重置成 10，不记上一次」，理由是
「第二个来开房的人拿到的是上一局留下的档位」。那个顾虑只在「分不清系统选的和我选的」时成立。

### 4. 顺带：术语统一 + BACKLOG 状态行

- 界面 40 处「局数」→「把数」、「最近 10 局」→「最近 10 场」、AI 说明行「5 局」→「5 场」
  （同一行里前半写「局」后半写「场」，读的人会以为是两回事）
- `BACKLOG.md` 40 条全部加 `<!-- STATUS: … -->`：open 7 / closed 27 / record 2 / watch 4。
  新增 `scripts/backlog-status.js`（`--check` 可在 CI 里守）

### 已知没做的

- **`ai.js` 的分法枚举没有和 `bestLine` 合并**。两处各自遍历 60 种分法，
  形状一样但目的不同（一个是选给 AI，一个是打分给玩家）。合并要动 AI 的选牌逻辑，风险不对等
- **复盘不落库**。它是提示，不参与战绩、不进排行榜。落库就要考虑口径变更时怎么迁移
- 内容：`docs/best-line-spec.md` 里「加一个开关控制」那条没做 —— 多一条渲染路径不划算，
  真要退回删 `recheckEl` 一处即可

### 验证

```
npm test                    118 文件 / 4607 断言 / 0 失败
probe-result-seq            62 项（含复盘行 4 条新断言）
probe-records-cloud         52 项
journey.js                  126 项
probe-ui-flow 390×844       68s，EXIT=0
```

---

## v111 · 五项结构债中的四项（版本 `20261102a` 的一部分，2026-11-02）

> 这一版**不改任何行为**：没有新功能、没有数值调整。目标是「下次改动更便宜」。

| # | 债 | 做法 | 验收 |
|---|---|---|---|
| C1 | 平台存储收口 | 新增 `pwa/js/storage.js`：`read/write/remove/list/migrate`，**永不抛**；16 个物理键 + 3 套命名统一进 `KEYS`，旧键单向迁移 | `pwa/js` 里除 storage.js 外**零直连**（`storage.test.js` 43 项） |
| C2 | `bindEvents` 拆容器 | 17 个嵌套函数抬到模块作用域，`bindEvents` **786 → 20 行** | `binder-split.test.js` 27 项 + `journey` 126 项 |
| C4 | 双份统计收口 | 新增 `pwa/js/stats.js`，服务端 apply / 前端 fold 同一段代码 | `stats.test.js` 26 项，含 200 条随机序列对拍 |
| C5 | `state` 字段归位 | 18 个字段全进字面量 + `STATE_DEFAULT` + 三个具名重置函数 | `state-reset.test.js` 16 项 |
| — | 转义表去重 | `achievementsView` / `avatar` 的 `esc` 改为复用 `gameUtils` | 转义表只剩一份（`stats.test.js` [4]） |

**没做的那一项（如实记账）**：`C3 房间态持久化` 未开始 —— 它要「快照 + 启动恢复 + 令牌持久化 +
计时器重建」四件事一起做，验收是「打一半 kill -9 再起，分数不丢」，不是加个写文件调用。

**这一轮抓到的三个真问题**（都不是靠读代码发现的，是靠新写的守卫）：

1. **UMD 工厂拿不到外层形参**：`storage.js` 第一版把 `global` 当闭包变量用，
   而工厂是在实参位置求值的 —— 宿主解析恒为 `null`，所有写入静默返回 `false`。
2. **连胜口径分岔**：本机算「连胜计数」（输了返回 0）、云端算带符号值，
   而战绩卡有「N 连败」的渲染分支 → **本地路径从来没显示过连败**。
3. **两条既有测试在描述旧口径**：`records.test.js` 与 `records-ai.test.js` 都把
   「当前连胜 0」写成了期望值，收口后必须改成 `-2 / -1`，并注明这是口径统一而非放宽。

---

## v112 · 成就系统改版（版本 `20261102a` / sw `v112`，2026-11-02）

### 为什么

用户对着线上成就页提了四条：牌桌屠夫那种「0 / 20」的进度条表达不了「我玩得久」；
牌型区只有大牌、没有小牌；对撞只有「大牌撞大牌」；战绩缺连败、缺「全场唯一正负分」。
一句话：**这套成就只记高光，不记倒霉，而牌桌上后者才是常态。**

### 改了什么

| 系列 | 变化 |
|---|---|
| 展示口径 | 只有 6 条画进度条（常客 / 老油条 / 势不可挡 / 十连胜 / 背到极点 / 衰神附体）；其余 28 条写「N 次」 |
| 牌型（10 → 13） | 新增爆点 / 散牌 / 没牛三条小牌型，与大牌型共用同一条分母，卡片给「次数 · 出现率」 |
| 对撞（4 → 6） | 新增矮子里拔将军 / 一窝比惨，条件是**全场都是小牌**；分母 `smn` 与大牌对撞 `vsn` 分开 |
| 战绩（8 → 11） | 新增连败 5 / 10 两条；一夜暴富改「净胜 ≥ 输家负分总和一半」；新增你咋这幸 / 我咋这霉；翻身农奴改「连败 ≥5 后赢一把」；删除人间清醒 |

### 实现要点

- `achievements.js`：`accumulate` 用两套键集合区分大/小牌型（用错一个集合，一群爆点会被算成硬碰硬）；
  新增 `accumulateHand`，在**第二轮结算之后**算三条整把成就。
- `stateMachine.js`：`round === 2` 时调用 `accumulateHand`；`profile.js` 改 R7 规则、停记 R8。
- 老档案兼容：新字段进 `blankCounts` + `COUNT_KEYS` 白名单（漏一个就永远停在 0）；
  `r8` 字段保留但不再计数。

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **123 文件 / 4775 条断言 / 0 失败** |
| `pwa/test/achievements-v112.test.js`（新增） | 53 项：小牌型计数、小牌对撞（含「混了大牌就不算」）、三条整把成就（含 `net*2 >= sumNeg` 边界）、六条进度条清单、字段白名单 |
| `journey` | 126 项全绿 |
| 未做的验证 | **没有在真机/浏览器里截图核对成就页排版**（只做了 DOM 级检查：34 张卡、6 条进度条、次数与概率文案）。下一轮发布前补一次真机点开 |

---

## v113 · 结算期体验修补（方案 A，版本 `20261102b` / sw `v113`，2026-11-02）

对应 [`review/next-hand-summary-2026-11-02.md`](./review/next-hand-summary-2026-11-02.md) 的**方案 A**。
只改「说错话」和「判错人」，不碰报名流程、不加超时、不踢人。

| # | 改了什么 | 为什么 |
|---|---|---|
| A-1 | **结算期掉线不判弃局**（只标离线） | 打完这一把后切出去 3 分钟会被判弃 → 行沉底、角标「—」、**冠军换人**。玩家什么都没做，一场已结束的比赛被改写 |
| A-1b | **结算期允许回座**，并把「已判弃」清掉 | 旧版 `reconnect` 对 SETTLED 一律拒绝 → 客户端回首页，回不来；老数据（已判弃）也一并放开 |
| A-2 | 术语统一：「打满 N 局」→「打满 N 把」、等待提示「进入下一把」 | 同一句里「局」出现两次，而顶栏一直说「第 N/M 把」 |
| A-3 | 结算页加一行「下一把分数从 0 分重新开始」 | 玩家看到「开始下一把」默认分数延续，开局后以为分丢了 |
| A-4 | 庆祝音改用 `settleRank`（与名次同一份） | 旧写法自己排序取首位：不过滤弃局者、不认并列第一 |

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | 124 文件 / 4798 条断言 / 0 失败 |
| `pwa/test/settle-period.test.js`（新增 23 项） | 结算期掉线不判弃；**对照组**：对局中掉线照旧判弃；结算期回座；翻轮后回来仍被挡；`settleRank` 在掉线后冠军不变、并列都算；四处文案与庆祝音接线 |
| 为什么必须带对照组 | 只测「结算期不判弃」的话，把 `finalizeLeave` 整个改成空函数也会绿 |

### 还没做的（B / C）

- **B**：就位态「已报名未准备」的出口（需要新协议动作 + 就位态按钮条新控件，横屏容易挤，要 ui-flow 验）、开新局前人数确认、被移出的人提示补房号。
- **C**：本局冠军收尾块、「再来一局」= 报名即准备、候场（座位保留 + 把数可改）。

---

## v114 · 成就去重 + 通赔 + 结算期方案 B（版本 `20261102c` / sw `v114`，2026-11-02）

### 成就（用户对着线上页面提的三条）

| 改了什么 | 为什么 |
|---|---|
| 删掉 5 条「首次拿到」（刚好十点半 / 豹纹加身 / 一气呵成 / 牛气冲天 / 五朵金花），34 → **33** | 每种牌型原来有两条，而卡片展示的是累计次数 —— 「第一次」那条亮过一次就再没信息量 |
| 保留的 5 条描述去掉门槛数字 | 数字区写的是「N 次」，描述再写「十次 / 五次 / 三十次」会被读成「到十次就停」 |
| 「强者运强」描述去掉「十次以上」 | 同上 |
| 「一手散珠」：飘三叶**五张 → 三张** | 文案错，飘三叶就是三张牌 |
| 新增**通赔** 4 条（一巡散场 / 双赔 / 五子皆输 / 常败将军） | 通吃只记喜，通赔才是常态；与通吃四条一一对应 |

通赔的判定比通吃多一道校验：**每组都参与了、且每组都没赢**。只看「没赢」会把中途弃权的人也算成通赔。

### 结算期方案 B（P4-B）

| # | 改了什么 |
|---|---|
| B-1 | 就位态信息卡里加「不等他，就我们开」：已准备的人可以把**已报名却没准备**的人退回结算页。**不踢人、不判弃**，名次与分数都保留 |
| B-2 | 点「准备」前先确认一次：「还有 N 人停在结算页，全部准备好就会立刻开局，他们会被挤出去」 —— 只拦「结算后的就位态」，首次开局的准备不问 |
| B-3 | 被挤出去的人提示补房号：「这局打完用房号 XXXX 还能进」 |
| B-4 | 解开「剩 1 人死锁」：**结算期也允许补 AI**。这一把已经算完，补人不改变任何口径；补进来的 AI 直接进下一把名单 |

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **126 文件 / 4866 条断言 / 0 失败** |
| 新增 `pwa/test/achievements-v114.test.js`（34 项） | 通赔四种口径 + 弃权不算通赔 + 通吃/通赔互斥 + 去重后目录 + 描述不许写门槛 |
| 新增 `pwa/test/next-round-drop.test.js`（30 项） | 「不等他」正路与四条负路（没准备的人不能催、不能跳过自己、不能撤下已准备的人、对局中不许）+ 接线守卫 |
| `journey` | 126 项（B-2 第一次上线时**把 journey 拦红了 26 项** —— 确认框挡住了准备，因为我把条件写成了「任何时候」；已改成只在结算后问） |
| `probe-ui-flow` 竖屏 390×844 | 1 视口 × 13 屏 **ALL PASS** |
| `probe-ui-flow` 横屏 844×390 | 1 视口 × 13 屏 **ALL PASS** |

### 没验证到的

「不等他」那颗按钮**只在「另一个真人报了名却没准备」时出现**，而巡检里没有第二个真人，
所以两档巡检证明的是「信息卡没被挤坏」，**不是「按钮自身的排版」**。这条要在真机一次双人房里点一下才算验完。

---

## v115 · 对撞对称八条 + 牛魔王文案（版本 `20261102d` / sw `v115`，2026-11-02）

### 为什么

用户对着线上成就页提了两条：

1. **「牛魔王」的描述写错了**：原写成「五张凑整十」的读法，实际斗牛是**三张凑十、剩下两张凑牛**。
2. **对撞那八条不对称**：`牌桌屠夫`（赢 20 次）和 `虎口夺食`（赢 1 次）是同一个计数器的两条门槛，
   `强者运强` 只有「赢多」没有「输多」的对偶，小牌那边只有「赢 / 输」没有胜率。
   用户直接给了目标形状：**赢次数 / 输次数 / 胜率≥50% / 胜率<50%**，大牌一套、小牌一套。

### 改了什么

| 改了什么 | 为什么 |
|---|---|
| 「牛魔王」描述 → **「三张凑十，剩下两张凑牛」** | 文案错；五张一起凑整十是另一种读法，会把「牛几」讲丢 |
| 对撞 7 → **8 条**，全目录 34 → **35** | 补齐成 4 种口径 × 2 档 |
| 「虎口夺食」+「牌桌屠夫」→ 合并为 **`硬茬子`**（`vs`，门槛 1，展示次数） | 同一个计数器的两条门槛，按 v114 的去重规则只留一条 |
| 「豹落平阳」→ **`软脚虾`** | 语义没变（`vsl`），只是名字与八条对齐 |
| 「强者运强」（≥60%）→ **`遇强则强`（≥50%）** | 60% 那条没有对偶，「赢多输少」的自然切点在五五开 |
| 新增 **`外强中干`**（`vsn` ≥10 且胜率 <50%） | 「赢多」的反面不能缺，否则输多的人永远没有对应成就 |
| 「矮子里拔将军」（赢次数）→ **改成小牌胜率 ≥50%**；新增 **`宁为鸡头`** 记赢次数、**`鸡飞蛋打`** 记输次数、**`矬子里垫底`** 记胜率 <50% | 小牌那边原来只有「赢 / 输」，没有胜率 |
| 四条一组内部两两成对：硬茬子/软脚虾、遇强则强/外强中干、宁为鸡头/鸡飞蛋打、矮子里拔将军/矬子里垫底 | 用户要求「按现有命名风格重新设计，各有特色」 |

**两条互斥规则**（写进 `extra`，缺一个就会出错）：

- **≥50% 与 <50% 永不并亮**，正好 50% 归「≥50%」那一侧 —— 五五开不算「输多」，
  这样也不会出现「两条都不亮」的空档。
- **分母不够时两条都不亮**（大牌 10 次 / 小牌 5 次）。不设门槛的话「撞一次赢一次」就是 100%，
  一局点亮，那不叫运强，叫运气好一次。

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **128 文件 / 4936 条断言 / 0 失败**（v114 是 126 / 4866） |
| `pwa/test/achievements.test.js` | 93 → **117 项**：新增 50% 边界、互斥地毯检查（10 组大牌 + 6 组小牌组合，断言永不并亮）、八条不重名 |
| `pwa/test/achievements-v114.test.js` | 34 → **52 项**：八条顺序钉死 + 两条互斥 + 描述不写门槛。**顺手修了一个结构问题**：这一段原先排在「通过 N 项」之后，断言跑得到但报不进汇总 |
| `pwa/test/achievements-v112.test.js` | 53 项；「门槛 20 但展示次数」的例子换成 `遇强则强`（原例合并后门槛降到 1，说明不了这件事了） |
| `npm run journey` | 126 项 / 0 失败 |
| `probe-ui-flow` 竖屏 390×844 | 1 视口 × 13 屏 **ALL PASS** |
| `probe-ui-flow` 横屏 844×390 | 1 视口 × 13 屏 **ALL PASS** |

### 同一版里补上的两处（本来算「剩下的部分」）

| 项 | 说明 |
|---|---|
| **C-1 结算页冠军块** | 顶部一块回答「谁赢的 / 赢多少 / 领先多少」。并列冠军时不写分差，只剩一人时也不写（差多少分是跟谁差？）。新增 `pwa/test/settle-crown.test.js`（27 项）—— 这块原先**一行测试都没有**，靠假 `el` 桩真跑真数据 |
| **P2-3 房间态持久化** | 房间 / 分数 / 令牌落盘（原子写 + 400ms 去抖 + 版本校验），重启不再丢进行中的对局。`server/test/rooms-state.test.js`（23 项） |

### 没验证到的

八条新名字在**真机窄屏**下的折行：`遇强则强`「外强中干」是四字，`矮子里拔将军`「矬子里垫底」是六字，
同一行里四字与六字混排，理论上会出现卡片高度不齐。巡检只比对了热区与溢出，没有逐卡量高度。

### 发布结果

| 项 | 结果 |
|---|---|
| 部署 | `https://your-app.app.workbuddy.host/?sharecode=REDACTED`（同一个应用，链接不变） |
| 线上冒烟 `probe-online-smoke` | **15 / 15 通过**（版本号 `20261102d`，`sw.js` 直抓 `CACHE_NAME = weile-liuxuanwu-v115`） |
| 公库 | `657a591 chore: 同步自私有仓库（6ff056c）` |
| 私库 | `6ff056c`（`git ls-remote` 比对一致） |

---

## v116 · C-2「报名即准备」（版本 `20261102e` / sw `v116`，2026-11-02）

### 为什么

结算后开下一把要两次点击：先点「开始下一局」报名，回到房间页再点一次「准备」。
两次问的是同一件事 ——「你要不要打下一局」，拆成两步只制造了一个
**「报了名却不准备」** 的中间态：这个人能卡住整桌，而 v114 的「不等他」按钮
就是为了给这个中间态打补丁。

### 改了什么

| 改了什么 | 为什么 |
|---|---|
| `wantNext` 里报名即置 `ready` | 一次点击。C-2 的全部内容就在这一行（守卫用源码断言钉住，删掉就红） |
| 就位态的「准备 / 取消准备」→ 禁用的「已就位 ✓」 | 已经就位了，那颗按钮留着只会变成「点了就害人」的开关 |
| 等待文案「等待其他人准备…」→「等其他人点「开始下一局」…」 | 就位态里已经没有「准备」这个动作了 |
| B-2 的人数确认框从「点准备」搬到「点开始下一局」 | 会开局的那一下变了；警告留在原地等于挂在一颗永远不会被点的按钮上 |
| 「不等他」的候选人不变（已报名却没就位的人） | C-2 之后这种人只剩一种：从房号摸进结算期、还没点准备的人 |
| 从房号进入结算期的人**仍要自己点一次准备** | 他还没看到这间房长什么样，直接发牌等于跳过「确认我进的是这一间」 |

**一个原本以为会有、实际不存在的问题**：改之前我担心「1 真人 + N AI」的房点完开不了
（AI 不报名 → 名单里只有自己 → 人数不够）。查下来 `markSettled` 早就替 AI 报名了，
所以 AI 房里点一下就开，`startNextRound` 也不会再把 AI 清出房间。
反过来这也说明一件事：**就位态在含 AI 的房里再也不会出现** ——
它是「3 人以上纯真人房、只有一人报名」时才会看到的屏。

### 抓到的两个真 bug

| # | 问题 | 怎么抓到的 |
|---|---|---|
| 1 | 确认框统计「会被挤出去的人数」时**把自己算进去了** —— 那一刻我自己的 `wantNext` 还是 false，于是每点一次都弹「还有 1 人停在结算页」，而那个人就是我 | journey `[7b]` 第一次跑就红了：点击后没有发出任何请求，`confirmOpen=true` |
| 2 | `renderRoom` 的自愈分支 `if (!readyBtn.dataset.busy) readyBtn.disabled = false;` 会把就位态的「已就位」按钮**重新点亮** | 改的时候就发现：把禁用写在同一层，下一次广播就解开了。已放进 `else` 分支并写明理由 |

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **129 文件 / 4981 条断言 / 0 失败**（v115 是 128 / 4936） |
| 新增 `pwa/test/next-round-prep.test.js`（40 项） | 报名即就位 / AI 房不开死局 / 阈值没被顺手改（5 人房仍 2 人报名即开）/ 侧门仍要自己点准备 / 撤回把就位一起撤 / 源码钉住 `p.ready = true` |
| `pwa/test/next-round-drop.test.js` | 30 → **34 项**：确认框搬到 `onNextRound` 的两条守卫 + 「人数里排除自己、排除 AI」 |
| `pwa/test/next-round.test.js` | 88 → **94 项**：旧口径「报名≠准备」的四条断言按新规则改写 |
| `handlimit-settle-parity` / `join-settle` / `e2e` | 三处旧断言按新流程改写（它们原先都要「再点一次准备」） |
| `npm run journey` | 117 项 / 0 失败（**126 → 117**：就位态那 10 条断言随这一屏一起退场，见下） |
| `probe-ui-flow` 竖屏 390×844 / 横屏 844×390 | 各 1 视口 × 13 屏 **ALL PASS** |

### 没验证到的（重要）

**就位态的 UI 失去了自动化覆盖。** 它原来是 journey `[7b]` 的专属对象
（按钮在不在视口里、会不会被 `.screen{overflow:hidden}` 静默裁掉）。
C-2 之后 journey 的「1 真人 + 1 AI」房点一下就开，这一屏不再出现，
所以那 10 条断言连同「两种等待页座位表指纹对照」一起退场。

现在这一屏只能靠「首次准备态」那一套渲染（`renderRoom` + `renderReadyCard`）间接兜着 ——
两者共用同一份代码，区别只在文案与按钮状态。**但「3 人以上纯真人房、只有一人报名」那个
真实场景没人用眼睛看过**，尤其是新加的「已就位 ✓」按钮（`.is-done` 那条 CSS 覆盖
`.btn[disabled]` 的灰底）。建议下一次双人/三人真机房时补一眼。

---

## v117 · C-3（上半）：候场期改把数（版本 `20261102f` / sw `v117`，2026-11-02）

### 为什么先做这一半

C-3 原计划是两件事：**座位全保留（不续局的人变旁听）** + **候场期可改把数**。
两件的风险不是一个量级：

- 改把数：一个纯规则函数 + 一条协议 + 一块 UI，边界清楚、可测；
- 座位保留：要改 `room.players` 的语义（谁能留在里面但不参与），
  牵动 `activePlayers` / `dealAll` / 断线宽限 / 结算落库 / 房间回收 / 全部座位渲染。
  这是原设计里标「4~6 人日、回归面最大」的那一半。

所以这一版先交付前者，后者拆成 **C-3b** 单独一轮（见 `docs/PLAN.md`）。

### 改了什么

| 改了什么 | 为什么 |
|---|---|
| 新增 `SM.setHandLimit(room, actorId, n)` | 只允许 **结算期（SETTLED）** + **房主** + **白名单档位** |
| hub 加 `setHandLimit` 协议；roomStore 三条路（对外 / 联机 / 本地演示）都接上 | 本地漏一条不会报错，只会在 `?mode=local` 里点不动那颗按钮 |
| 结算页底部加一块「下一局打几把」：一行五个档位 | 结算是所有人都会停下来的那一刻，也是唯一「这一场已收尾、下一场未发牌」的窗口 |
| 非房主的按钮禁用，但当前档位不跟着变淡 | 他点不动，但仍然要知道下一局打多久 |

**两个刻意的选择**：

- **不用 `normalizeHandLimit` 校验**。它会把脏值悄悄收敛成默认档 —— 建房时可以容忍
  （不能因为一个下拉框把人挡在门外），**改契约时收敛就等于骗人**：玩家选了 7，结果按 10 打，
  而且没有任何提示。这里必须明说拒绝，并把合法档位列出来。
- **改把数不调 `_maybeAutoStart`**。它不会让任何人更接近开局，顺手触发一次自动开局
  就是「改个设置把我送进了牌局」。

### 抓到的两个问题

| # | 问题 | 怎么抓到的 |
|---|---|---|
| 1 | 协议漏了 `payload` 包裹 —— 服务端读 `payload.handLimit` 得到 undefined，直接拒 | journey `[7c]`：点档位后那块没重画。**单测当时是绿的**，因为它只断言源码里有 `type: 'setHandLimit'` 这个字面量 —— 又一个「守卫站错层级」的例子。断言已收紧到 `payload: { handLimit }` |
| 2 | 按钮热区只有 37×24，离 44 的触控底线差一大截 | `probe-ui-flow` 的 tap 判据当场拦下。根因是整页在 750 设计空间里缩放（390 宽 scale≈0.52），按「视觉合适」写的 22px 字号 + 8px 内边距换算成实际只有 24 高。改成 88 设计 px ≈ 44 实际 |

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **130 文件 / 5058 条断言 / 0 失败**（v116 是 129 / 4981） |
| 新增 `pwa/test/handlimit-change.test.js`（77 项） | 五个档位逐个可选 / 五个非结算阶段全拒 / 非房主与不在房间的人被拒 / 10 种脏值全拒且不改值 / 两端接线 / 那块画得出来且只有房主可点 / 源码不出现 `normalizeHandLimit` |
| `npm run journey` | **119 项 / 0 失败**（新增 `[7c]`：点档位 15 → 服务端广播回来 → 那块重画成 15） |
| `probe-ui-flow` 竖屏 390×844 / 横屏 844×390 | 各 1 视口 × 13 屏 **ALL PASS**（热区修好后） |

### 没做 / 没验证到的

- **C-3b 座位全保留没做**：不续局的人现在仍会被移出房间（`room.players = joiners`
  + `_evictFromRoom`），提示是「本局打完后用房号 XXXX 还能进来」。
- **改把数只在结算页这一处入口**。已经点过「开始下一局」停在就位态的人看不到这块 ——
  他得先「回结算页」再改。就位态那一屏本来也进了留白（见 v116）。
- `journey` 有一条偶发红：`第 1 轮十点半没爆`。它依赖抽到的牌，重跑即绿，
  与本版无关，已记进 BACKLOG 的 watch。

### 发布结果（v117）

| 项 | 结果 |
|---|---|
| 部署 | `https://your-app.app.workbuddy.host/?sharecode=REDACTED`（同一个应用，链接不变） |
| 线上冒烟 `probe-online-smoke` | **15 / 15 通过**（版本号 `20261102f`，`sw.js` 直抓 `CACHE_NAME = weile-liuxuanwu-v117`） |
| 公库 | `1e6e24f chore: 同步自私有仓库（cb04ddf）` |
| 私库 | `cb04ddf`（`git ls-remote` 比对一致） |

---

## v118 · C-3b：座位全保留 / 不续局的人变旁听（版本 `20261102g` / sw `v118`，2026-11-02）

### 为什么

C-3 拆成两半时（v117）说清楚了：改把数是封闭的一块，**座位保留要改
`room.players` 的语义**，牵动发牌 / 提交 / 结算 / 投票 / 人数 / 断线 / 渲染六处。
这一版做的是后者。

改之前的行为：没报名下一局的人会在开局那一刻被 `room.players = joiners` 删掉，
服务端再给他推一条 `roomDeleted`，文案是「本局打完后用房号 XXXX 还能进来」。
三个后果叠在一起：

1. **座位凭空消失** —— 他明明还在房间里，牌桌上却没有他的位置；
2. **结算页的名次表少人** —— 那一局他不在，下一局的名次也就没有他；
3. **回来要重新输房号** —— 房号是六位数字，念错一位就进不去。

### 改了什么

核心是把一个名单拆成两个：

| | 含义 | 用在哪 |
|---|---|---|
| `activePlayers` | **房间里的人** | 座位表、人数上限、房间是否空了、房主转移 |
| `playingPlayers` | **参与本局的人** | 发牌、全员提交、分组结算、解散投票、人数不足、成就累计、AI 快照 |

新字段 `p.benched`（旁听）就是两者的差集。`startNextRound` 不再删人，
只把没报名的标上 `benched = true`；`removed` 从此恒为空。

**六处判定逐个换**（每一处换成 `activePlayers` 都会整桌卡死，只是症状不同）：

| 位置 | 用错会怎样 |
|---|---|
| `submitGroups` 的全员提交判定 | 旁听者没有手牌、永远不提交 → 这一轮永远不结算 |
| `settleRound` 的计分名单 | 旁听者 `groups` 是空的，会被当成「三张散牌」参与输赢 |
| `maybeEndGame` 的人数判定 | 两个旁听的人就能让「剩一个人」的局继续耗着 |
| `dissolveVoters` / `proposeDissolve` | 他能发起解散，却永远不在投票人里 → 票永远凑不齐 |
| `voided` 判定 | 旁听者分数恒为基准分 → 一局什么都没打，账上却记了一场 |
| `Ach.accumulateHand` 的成就累计 | 空手牌会把「小牌局」拉成「全场散牌」→ 给所有人白送一次小牌对撞 |

**刻意保留的四处 `activePlayers`**（换成 `playingPlayers` 会掉座位）：
座位表 `roomSeats`、容量检查、房间空了没有、`ensureLiveOwner`。

前端：

- 对局页新增一张「这一局你在旁观」卡（`#spectator`），手牌 / 组槽 / 提交整块隐藏；
- 结算页名次表把旁听者排在名次之后，角标「—」、分数列「—」、名字后标「（旁听）」；
- 顶栏提交进度的分母改成 `playingPlayers`；
- 对手条上旁听者显示「👀 旁听」，不再像「一直不提交的队友」。

### 抓到的三个真 bug（都是这一版才可能出现的）

| # | 问题 | 怎么抓到的 |
|---|---|---|
| 1 | **结算期补 AI 之后没人触发自动开局** —— `addBot` 结尾只有 `_broadcast`，漏了 `_maybeAutoStart`。以前看不见：正常路径上补完 AI 房主接着会点「开始下一局」，那一下会触发。C-3b 让「房主自己不报名、只补 AI」成为合法路径，两张 AI 各自报名、人数够了却永远不开，而房主正在旁听 —— **什么都做不了**（旁听者不能解散、不能准备），房间就此僵住 | journey `[7d]`：补完 AI 停在结算页，服务端日志却打了 `auto next round` |
| 2 | **旁听的人没有任何办法离开房间** —— 底部整条动作条（含「离开房间」）被整块藏起来，于是旁听卡必须自带一个出口。而 `onLeave` 开头要用 `firstShown([...])` 找一颗可见的离开按钮挂忙碌态，找不到就直接 return —— 新那颗没登记进去，**点了等于没点** | journey `[7d]`：点了「离开房间」12 秒没反应。顺带发现 `pressBusy(null)` 的静默短路 |
| 3 | **旁听者会收到「这一把的结算」弹窗** —— 他只判断了 `joinedLate`（结算期才进来的人），没判断 `benched`。逐组动效 + 庆祝音播的是别人的牌，很容易被读成「这 3 组是我打的」 | journey 后面的焦点断言红了：关闭回放后焦点落在一个还开着的结算弹窗上 |

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **131 文件 / 5124 条断言 / 0 失败**（v117 是 130 / 5058） |
| 新增 `pwa/test/bench-spectator.test.js`（59 项） | 开局只标不删 / 旁听者不被等提交 / 不计分 / 不算人数 / 不能解散 / 不能准备 / 掉线=退房不判弃局（含「上场的人掉线要判弃局」的对照）/ 结算页不进名次不进冠军 / 报名即摘身份 / 房主旁听仍是房主 / **11 条源码结构断言**（上面那六处 + 四处该保留的）/ 手牌不外泄 |
| `pwa/test/next-round.test.js` | 88 → **97 项**：四条旧口径（「没点的人被移出」）按新规则改写 |
| `pwa/test/dissolve.test.js` / `next-round-prep.test.js` | 各改三条同类断言 |
| `pwa/test/ui.test.js` | `onLeave` 的候选列表从三个入口改成四个（多了旁听卡那颗） |
| `npm run journey` | **128 项 / 0 失败**（126 → 128） |
| — 新增 `[7d]` 旁听 | 补第二个 AI → 我没报名 → 服务端开局 → 旁听卡画出来 → 组槽/手牌藏起来 → 离开房间回首页，共 9 条断言 |
| `probe-ui-flow` 竖屏 390×844 / 横屏 844×390 | 各 1 视口 × 13 屏 **ALL PASS** |

`journey` 里那两条「回放是整场 2 把」的断言改成了**不写死数字**（断言「整场 N 把」与实际
pack 数一致、且 ≥ 2）。旁听那一段会让两个 AI 往下多打几把，把数从 2 变成 4 ——
原来那种写法只会在场景一变时假红，然后被人把数字改大，守的东西一点没变。

### 没验证到的

- **横屏的旁听态没截图**。竖屏截了三版（第一版徽标对比度只有 1.3:1，几乎看不见；
  第二版撑满成一块空面板；第三版 `margin:auto` 居中才可看）。横屏只有 `.ls` 那几条
  字号覆盖，靠 ui-flow 的溢出检查兜着，没有用眼睛看过。
- **纯真人 3 人房的旁听没测**。journey 那个场景是「我 + 两个 AI」——
  AI 会自动报名，所以旁听只出现在「我明确没点」这一种情况下。
  真实的三人群里，可能是两个人报了名、第三个人还在看回放，交互上更常见。
- **旁听时的「我的分 0」**。顶栏那一格仍写「我的分 0」，因为分数确实被重置成了基准分。
  语义上不算错（这一局他就是 0 分），但和「旁听中」并排有点矛盾。没改，记在这儿。
- **C-3b 之后 `_evictFromRoom` 实际上永远收到空名单**。保留了调用与那段注释
  （它还要处理旧数据里残留的 `left`），但「把人请出房间并告诉他原因」这条路
  现在只对「已经自己退房的人」生效 —— 等于死代码。下一轮要么删掉，要么并进退房流程。

### 发布结果（v118）

| 项 | 结果 |
|---|---|
| 部署 | `https://your-app.app.workbuddy.host/?sharecode=REDACTED`（同一个应用，链接不变） |
| 线上冒烟 `probe-online-smoke` | **15 / 15 通过**（版本号 `20261102g`，`sw.js` 直抓 `CACHE_NAME = weile-liuxuanwu-v118`） |
| 公库 | `81aa743 chore: 同步自私有仓库（9330424）` |
| 私库 | `9330424`（`git ls-remote` 比对一致） |

### 发布结果（v118）

| 项 | 结果 |
|---|---|
| 部署 | `https://your-app.app.workbuddy.host/?sharecode=REDACTED`（同一个应用，链接不变） |
| 线上冒烟 `probe-online-smoke` | **15 / 15 通过**（版本号 `20261102g`，`sw.js` 直抓 `CACHE_NAME = weile-liuxuanwu-v118`） |
| 公库 | `81aa743 chore: 同步自私有仓库（9330424）` |
| 私库 | `9330424`（`git ls-remote` 比对一致） |

---

## v119 · 修：从档案卡点「成就」，卡片还盖在成就页上（版本 `20261102h` / sw `v119`，2026-11-02）

### 现象（用户报的）

> 查询别人战绩 没有直接显示战绩 被别人个人信息弹框挡住

截图：成就页已经打开了（标题「成就」、右上「示例丙 已解锁」、下面是牌型卡与未达成卡），
但一张「示例丙」的个人档案卡正压在上面 —— 场次 / 胜率 / 累计净胜 / 最近 5 局 / 成就 3/35 ›。
玩家点了那张卡上的「成就 3/35 ›」，以为能看成就，结果**看到的是一张挡住成就页的卡**。

### 为什么

成就页是整屏替换（`showScreen('screen-achievements')`），档案卡是浮层（`#profile-modal`）。
那个「点成就入口」的点击委托里写了关浮层，但**只关了一个宿主**：

```js
try { closeSeatSheet(); } catch (err) { /* 面板本来就没开 */ }
openAchievements(pid, currentScreenId());
```

`data-ach-open` 这颗按钮（`pf-ach`，「成就 N/35 ›」）是由 `achievementsView.js` 的
`profileBodyHtml` 生成的，而那一段 HTML **有两个宿主**：

| 宿主 | 什么时候出现 | 原来关了吗 |
|---|---|---|
| `.ss-info`（座位信息档） | 牌桌上点对手头像 | ✅ 关了 |
| `.profile-box`（`#profile-modal`） | 排行榜 / 结算页 / 座位卡点进档案 | ❌ **漏了** |

所以「从排行榜或结算页的档案卡点成就」这条路上，卡不会关。
座位档那条路一直是好的 —— 这也是它为什么能活到今天：唯一的自动化路径走的不是这条路。

### 改了什么

```js
try { closeSeatSheet(); } catch (err) { /* 面板本来就没开 */ }
var pfOpen = document.getElementById('profile-modal');
if (pfOpen && !pfOpen.classList.contains('hidden')) {
  try { closeProfile(); } catch (err2) { /* 档案卡本来就没开 */ }
}
openAchievements(pid, currentScreenId());
```

**为什么判一下再关，而不是直接调 `closeProfile()`**：它会 `profileSeq++`（让在途的
档案请求失效）并弹一层 modal 栈。本来没开的时候调它，等于白白消耗一层，
后面按返回/ESC 时栈就对不上了。

**顺序不能反**：先关浮层再切屏。反过来的话，关档案卡那一下的焦点归还会落到一个
已经不可见的元素上，中间还会闪出一帧「成就页 + 卡片」。

### 验收

| 项 | 结果 |
|---|---|
| 新增 journey `[9a]`（6 项） | 榜单点一行 → 弹档案卡 → 有「成就」入口 → 点它 → 成就页打开 **且档案卡关掉** → 返回回排行榜 |
| 红过没有 | **红过**。把修复临时改成 `if (false && pfOpen)` 重跑，`★★ 档案卡同时被关掉` 当场变红，诊断打出 `{"cls":"modal","shown":true}` —— 与用户截图完全一致（`screen-achievements:SHOW` + 档案卡开着） |
| `pwa/test/achievements-view.test.js` | 加 4 条源码守卫：委托里必须同时出现 `closeSeatSheet()` 与 `closeProfile()`，且 `closeProfile()` 在 `openAchievements()` **之前** |
| `npm test` | **131 文件 / 5163 条断言 / 0 失败** |
| `npm run journey` | **134 项 / 0 失败**（128 → 134） |

### 顺手修掉的一个数字问题

`pwa/test/achievements-view.test.js` 的汇总行写的是「39 项通过，0 项失败」——
和运行器取数的正则（`通过 N 项，失败 M 项`）顺序对不上，退回数 `PASS` 行也没得数
（它的 `ok()` 不打 PASS 行）。于是这个文件长期在 `npm test` 汇总里显示 **0 项**。

也就是说：v118 发布记录里那句「131 文件 / 5124 条断言」**少算了一整个文件的 39 条**。
改成标准格式后总数是 **5163**。这不是新加的断言，是一直没被数进去的那批。

### 没验证到的

- **只在单人榜的档案卡上验过**。`journey` 里榜单只有我自己一行，走的是「看我自己的档案 →
  点成就」。看**别人**的档案时 `openProfile` 会先发一次 `getProfile`，卡片渲染要多等一个
  往返 —— 但点「成就」那条委托与看谁无关，所以风险低。
- **座位信息档（`.ss-info`）那条路没有回归断言**。它原来就是好的，这次没动它；
  但也没有任何测试盯着「从座位档点成就不留浮层」这件事。

---

## v120 · 同轮补修：首次打开不该因为 SW 接管而刷新（版本 `20261102i` / sw `v120`，2026-11-02）

### 怎么发现的

v119 部署后跑线上冒烟，**连续三次**都是 14 项通过、1 项失败：

```
FAIL  Service Worker 已接管（离线能力在这条路上）  -> none（等待 14 秒仍未接管）
```

但直抓 `/sw.js` 拿到的 `CACHE_NAME` 已经是 `v119`，其余 14 项（含「没有任何 HTTP >= 400」
「没有请求失败」）全绿。所以**不是资源缺失，也不是部署没生效**。

### 根因：SW 装好了，是页面把自己刷没了

写了个临时探针直接读注册状态，结果是：

```
{"controller":true,"supported":true,
 "regs":[{"scope":"...","active":"activated","waiting":null,"installing":null}]}
```

SW 明明已经 `activated` 并且接管了。但同一份日志里还有一行：

```
[sw] reload for controllerchange
```

**页面在 SW 接管后把自己 reload 了。**

`index.html` 里那段逻辑本来是为了「新版本接管后别让用户停在旧代码上」，但它没有区分
「换版本」和「首次安装」：

- `sw.js` 的 activate 里有 `clients.claim()`；
- `claim()` 会让**当前页面立刻被新 SW 接管**；
- 首次访问同样会触发 `controllerchange` —— 于是首次打开也刷一次。

三个后果，从轻到重：

1. 首次打开白闪一下（页面已经是最新代码，这一刷没有任何收益）；
2. 输入到一半的昵称会被冲掉（`controllerchange` 里那句 `setNickname` 只是兜底）；
3. **「首次加载」变成两次加载** —— 任何盯着这个页面的自动化都会被中途打断。
   冒烟那个「等 controller」是一个长轮询 Promise，页面一 reload，Promise 就死在了
   旧上下文里，`Runtime.evaluate` 拿到 undefined，于是报「14 秒仍未接管」。

也就是说：**这条 FAIL 是假红**，而它假红的原因正好是一个真实的体验问题。

### 改了什么

```js
var hadController = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
var refreshing = false;
navigator.serviceWorker.addEventListener('controllerchange', function () {
  if (!hadController) { hadController = true; return; }   // 首次接管：页面已是最新，不刷
  if (refreshing) return;
  refreshing = true;
  reloadWhenIdle('controllerchange');
});
```

首次接管只把 `hadController` 置真（**下次**再变就是真换版本了），不刷新。

### 验收（两条都实测过）

| 场景 | 怎么验的 | 结果 |
|---|---|---|
| **首次打开不刷新** | 起本地服务 + CDP 读 `performance.timeOrigin` 与 console 日志 | `controller=true`、`active=activated`，且日志里**没有** `[sw] reload for controllerchange` |
| **换版本仍然刷新** | 同一浏览器里先把 SW 装好，改 `sw.js` 的 `CACHE_NAME` 造一个「新版本」，再 `registration.update()` | `timeOrigin` 前进了 9 秒 —— 页面确实 reload 了 |

两个临时探针用完已删（`scripts/_sw-diag.js` / `_sw-reload-check.js`）。
第二条之所以要专门验：这段逻辑存在的唯一理由就是「别让用户停在旧代码上」，
把它改坏了的后果（永远不刷新）比原来那个 bug 更隐蔽。

| 项 | 结果 |
|---|---|
| `npm test` | **131 文件 / 5163 条断言 / 0 失败** |
| `npm run journey` | **134 项 / 0 失败** |
| 线上冒烟 | 见下方「发布结果」 |

### 为什么单独占一版

`index.html` 改了就必须换 `CACHE_NAME`：已经缓存过 v119 的客户端不会重新拉 `index.html`，
只有「SW 发现 sw.js 变了 → 装新的 → 接管」这条路能把新页面送过去。不升版本号，
老用户会永远停在会白闪的那一版上。

### 发布结果（v119 / v120）

| 项 | v119（档案卡遮挡） | v120（SW 首次刷新） |
|---|---|---|
| 部署 | 同一个应用，链接不变 | 同左 |
| 线上冒烟 | 14 / 15（SW 那条假红，见 v120 一节） | **15 / 15** |
| 版本号 / sw | `20261102h` / `v119` | `20261102i` / `v120` |
| 私库 / 公库 | `dc3da4a` / `671325d` | `2a441b1` / `d69e323` |

### 发布结果（v119 / v120）

| 项 | v119（档案卡遮挡） | v120（SW 首次刷新） |
|---|---|---|
| 部署 | 同一个应用，链接不变 | 同左 |
| 线上冒烟 | 14 / 15（SW 那条假红，见 v120 一节） | **15 / 15** |
| 版本号 / sw | `20261102h` / `v119` | `20261102i` / `v120` |
| 私库 / 公库 | `dc3da4a` / `671325d` | `2a441b1` / `d69e323` |

---

## v121 · 修：三个人打完，前两个点了就把第三个判成旁听（版本 `20261102j` / sw `v121`，2026-11-02）

### 现象（用户报的）

> 三人真人游戏结束后结算界面，如果前两个人已经点击继续下一把，第三个人只能观战，
> 游戏直接两人开始。
>
> 第三个人退出房间再进，会出现第二张图的 UI 乱码，而且我不知道只是停留在房间中的
> 观战有什么意义。

两张截图：第一张是「旁听中 / 这一局你在旁观 / 离开房间」；第二张是**叠穿**——
上面「准备中 已准备 3/3」，中间压着旁听卡，下面并排两颗「离开房间」。

### 三个独立的缺陷，一起爆

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | `canStartNext` 的分母是「**已经报名的人**」 | 三人房里两个人点了，门槛按 2 算就够 → 直接发牌，第三个被判旁听。他什么都没做，只是慢了几秒 |
| 2 | 结算期从房号进来的人 `wantNext=true` 但 `ready=false` | 就位态那颗按钮被无条件画成「已就位 ✓」（禁用），服务端却认 `ready=false` → **整桌永远开不了**，界面还写着 3/3 |
| 3 | `showReadyTable` 不收旁听卡 | 就位态和旁听态共用 `#screen-game`，两层 UI 叠在一起（第二张截图） |

第 1 条的错不在阈值（`MIN_PLAYERS=2` 没动），**在分母**：门槛随着报名人数一起下降，
房间里剩下的人自动变成「不参与」。那不是中性默认值，那是替别人做决定。

### 改了什么

| 改了什么 | 为什么 |
|---|---|
| `canStartNext` 新增第三条：**房间里没有「还没表态」的真人** | 默认等。人数够不再等于可以开 |
| 新增 `pendingNextPlayers(room)` | 「在等谁」变成一个公开名单：门槛、文案、按钮都用它，不再是三处各算一遍 |
| `dropFromNext` 支持 **target 指向自己**（这一把先不打） | 门槛收紧后，「想歇一把」不能靠「什么都不做」表达 —— 那会让整桌等着。自己说，比让两个人替他按按钮更省事 |
| 结算页加「这把不打」 | 同上。放在「查看战绩 / 离开房间」那一排：结算页在 390×844 上已经到顶，独立一行 88px 会把主按钮顶到统计区上（ui-flow 报过 cover 重叠 1324px²） |
| 就位态：`hideSpectator()`、等待文案点名「在等谁」、顶栏分母 = 报名 + 没表态 | 见缺陷 2 与 3 |
| 结算页等待文案：「已经有 N 人进入下一把 · **还在等你**」 | 以前只说有人进了，不说在等谁 —— 最后那个人不知道自己卡住了整桌 |
| 删掉「开始下一局」的确认框（B-2） | 它警告的「他们会被挤出去」已经不可能发生。一个描述不会发生之事的警告，只剩「让人多点一次」这一个作用 |
| `joinRoom` 结算期：`ready` 跟着 `wantNext` 一起为真 | 缺陷 2 的修法。语义上也对：从房号进来 = 朋友喊你来打牌 |

### 顺手挖出两个从 v114 就存在的接口 bug

「不等他」这颗按钮**从上线起就是坏的**，一直没人点到：

| # | bug | 怎么被发现的 |
|---|---|---|
| 1 | `RoomStore.dropNext` **在对外接口里根本不存在**。ws 对象里有个同名私有实现，`local` 那边连实现都没有。点下去是 `TypeError`，被 `catch` 吞成一句「网络不太稳，再试一次」 | journey 新加的 `[7d2]` 真的点了那颗按钮，诊断显示 `dataset.busy` 是空的 —— 说明处理函数压根没跑 |
| 2 | 协议把 `targetId` 放在消息顶层，服务端读的是 `msg.payload.targetId` → 永远「缺少要跳过的人」 | 修完第 1 条之后立刻暴露。v117 的 `setHandLimit` 踩过一模一样的坑 |

两个都属于同一类：**单测只看源码里有没有那个名字**。第 1 条的断言匹配到了 ws 对象里那份
私有实现，于是绿的；第 2 条当时连断言都没有。现在 `next-round-gate.test.js` 断言的是
「对外接口里有 `dropNext`」「local 有实现」「协议带 `payload`」，并有一条 journey 真的点它。

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **132 文件 / 5226 条断言 / 0 失败**（v120 是 131 / 5163） |
| 新增 `pwa/test/next-round-gate.test.js`（43 项） | 三人房两人点→不开 / 三条出路（他点、不等他、自己请假）/ AI 不算待表态 / 掉线未离开的人算 / 旁听不是永久免检 / `wantNext` 与 `ready` 必须同步（含源码钉住）/ 三条判据一条都不能少 / `dropNext` 接口与协议层 |
| `pwa/test/next-round.test.js` | 104 项：`[4]` 改成「两人点了不开」，`[5]` 改成「房主也要表态」 |
| `pwa/test/next-round-prep.test.js` | 45 项：`[3]` 从「5 人房 2 人即开」改成「要等所有真人」；`[4]` 从「侧门仍要自己点准备」改成「报名与就位同步」 |
| `pwa/test/next-round-drop.test.js` | 39 项：确认框退场（改成断言它不存在）、自己请假 |
| `pwa/test/bench-spectator.test.js` | 63 项：新增「就位态进入时收起旁听卡」两条源码守卫 |
| `pwa/test/dissolve.test.js` / `leave-settle.test.js` / `table-ready.test.js` / `server/test/join-settle.test.js` | 按新规则改写（它们原先都依赖「不够人也能开」） |
| `npm run journey` | **138 项 / 0 失败**（v120 是 134） |
| — 新增 `[7d]` 门槛 | 两个 AI 都报名了、我不点 → 结算页停住不发牌，且文案点名「还在等你」（4 项） |
| — 新增 `[7d2]` 自己请假 | 点「这把不打」→ 两个 AI 立刻开打 → 我进旁听（9 项，含旁听卡四条） |
| `probe-ui-flow` 竖屏 390×844 / 横屏 844×390 | 各 1 视口 × 13 屏 **ALL PASS** |

### 没验证到的

- **纯真人三人房仍然没有自动化覆盖**。journey 是「我 + 两个 AI」——AI 不参与表态门槛
  （`markSettled` 替它们报名），所以「三个人都在结算页、谁先点」这种真实节奏
  只有单测（`next-round-gate.test.js`）覆盖，没有一次完整的浏览器实跑。
- **就位态那一屏仍未截图**。v118 起它在含 AI 的房里不会出现，journey 造不出来；
  这次修的是「它上面叠着旁听卡」，修法有源码守卫，但没有一张图确认叠层真的没了。
- **横屏旁听态仍未截图**（v118 起就在这条留白里）。
- 「这把不打」点完之后**没有二次确认**。它是可逆的（再点「开始下一局」就回来），
  所以没加 —— 但真机上误触的代价是「这一把只能看着」。

### 发布结果（v121）

| 项 | 结果 |
|---|---|
| 部署 | `https://your-app.app.workbuddy.host/?sharecode=REDACTED`（同一个应用，链接不变） |
| 线上冒烟 `probe-online-smoke` | **15 / 15 通过**（含 Service Worker 已接管；`sw.js` 直抓 `CACHE_NAME = weile-liuxuanwu-v121`） |
| 公库 | `50d1e2c chore: 同步自私有仓库（b5bce3c）` |
| 私库 | `b5bce3c`（`git ls-remote` 比对一致） |

---

## v122 · 修：三个人都点了「下一把」，第四个人就进不来了（版本 `20261102k` / sw `v122`，2026-11-02）

### 现象（用户报的）

> 三个人打完到结算页面，都点下一把会直接开始，但是如果有第四个人要加入，就会冲突。

### 这不是并发竞态，是窗口关闭

服务端是单线程、消息串行处理，所以「同时」在这里不存在 —— 只有先后。用探针跑了三种先后：

| 时序 | 发生了什么 | 结论 |
|---|---|---|
| 三人全点完，第四人才输房号 | 第三次 `wantNext` 让 `canStartNext` 成立 → **立刻发牌**；第四人的 `joinRoom` 被拒 `ROOM_PLAYING`（「这局正在打，等这局结束再进来」） | 他要等**整整一局**（可能 10 把），只看到一句错误提示 |
| 第四人在结算期先进来，三人再点 | 他在 `joinRoom` 里被置 `wantNext=true`，四人一起开局，且 `benched=false` | 这条路径本来就是对的（v121 已验证） |
| 结算期两人房、一人走了一个、新人补位 | 新人进来那一刻正好凑够 2 人 → **但 `hub.joinRoom` 不调 `_maybeAutoStart`** → 停在就位态，谁都不缺，谁也不会再点 | 真 bug，一直存在（v121 只修了 `ready` 同步，没修触发） |

一句话：**结算期是唯一能「加入并参与」的窗口，它在最后一个人点下的瞬间关闭**。
而门外有没有人，服务端不可能知道 —— 没连接、没房间、没有意图记录。

### 改了什么

| 改了什么 | 为什么 |
|---|---|
| `joinRoom` 放行**打牌中**加入，但只以旁听身份（`benched=true`） | 「进不来房间」和「这一把不打」是两件事。牌已经发了不能补人（那等于凭空造一手分），但没有理由把人关在门外一整局。前端那张「你不在这一局」的卡（v118）直接复用 |
| `hub._armOneSplitTimer` 跳过 `benched` | 不跳的话，60 秒后这个从没参与过这一把的人会被判「本轮弃权」，还要按弃权结算 |
| 新增 `room.holdNext` + `setHoldNext`：房主「等个人」 | 门外有人这件事只有房主能表达。挂起期间**谁点都不开牌**，报名照常 |
| 挂起最长 3 分钟，到期由 `hub._armHoldTimer` 自动放行并广播 | 不给出口就是把「等个人」变成「全桌锁死」。为什么必须真挂 timer：挂起后所有人都已就位、谁也不动，没有任何请求会再去问「能不能开」 |
| 房主离开 / 房主转移 → 等待立刻失效 | `holdNextOf` 按 `ownerId` 比对；`leaveRoom` 里也清一次字段 |
| `hub.joinRoom` 末尾补 `_maybeAutoStart` | 时序表第三行那个「补位凑齐但不开」的真 bug |
| 结算页「等人」并进把数那一行（不新增块） | 390×844 上结算页已经到顶：单独一块会把内容推到底部动作条下面，ui-flow 当场报 `cover 重叠 4177px²（占小者 75%）` |
| 就位态加「人齐了，开牌」（`#btn-hold-off`） | 房主设完挂起后通常会顺手点「开始下一局」进入就位态。若只有结算页能解除，他就得先撤回报名（`unWantNext`）再回去点 —— 撤回会把自己从下一局摘掉，解除后反而变成「还差一个人（他自己）」 |

### 一处顺带加固

`security.test.js` 里那条「`joinRoom` 不能冒领已有座位」原先靠「对局中一律拒绝」通过。
放行之后它必然失败 —— 但**冒领本身没有发生**：服务端只认令牌身份（`_pid(client)`），
payload 里写别人的 `playerId` 完全无效，攻击者进来拿的是自己的座位、而且只能是旁听。
断言改成了真正要守的东西：`eve` 的座位 `benched=true`、`乙` 的昵称和座位一个字段都没变。

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **134 文件 / 5304 条断言 / 0 失败**（v121 是 132 / 5226） |
| 新增 `pwa/test/hold-next.test.js`（51 项） | 挂起挡住开局 / 解除立刻开 / 只有房主与结算期 / 三条失效出口（离开·换房主·到点）/ 连点不续期 / 开局清掉 / 局中加入=旁听 / 六条接线守卫 |
| 新增 `server/test/hold-next.test.js`（14 项） | **真 WebSocket**：`payload.on` 被正确解读（读成 false 会立刻放行，`leftMs` 会是 0）、挂起状态广播给全房、非房主被拒 |
| `server/test/join-settle.test.js` `[4]` 改写 | 从「对局中进不来」改成「进得来但旁听」：`benched=true`、`wantNext=false`、无手牌、`playingPlayers` 仍是 3、**看不到任何人的手牌** |
| `pwa/test/next-round.test.js` `[8]` 改写 | 同上（两条旧断言） |
| `pwa/test/prev-result.test.js` | `.ghost-row` 4 → 5 颗按钮，并钉住「人齐了，开牌」默认 hidden |
| `npm run journey` | **145 项 / 0 失败**（v121 是 138） |
| — 新增 `[7e]` 等个人 | 结算页有按钮 → 挂起 → **报名之后停在就位态、没有发牌** → 就位态能看到开牌 → 解除立刻发牌（7 项，全是真按钮 + 真协议） |
| `probe-ui-flow` iOS 竖 390×844 | 1 视口 × 13 屏 **ALL PASS**（首次跑报 `cover 4177px²`，改布局后清零） |
| `probe-ui-flow` iOS 横 844×390 | 1 视口 × 13 屏 **ALL PASS** |

### 没验证到的

- **纯真人三人 + 第四人仍然没有多浏览器实跑**。服务器侧有真 WebSocket 用例（`join-settle` / `hold-next`），
  但「三个人在结算页、手一起点下去，第四个人同时输房号」这个节奏只有单测 + 两/三客户端模拟。
- **挂起 3 分钟到点的自动开牌没有做真实计时测试**。单测是把 `holdNext.at` 改到过去来模拟过期；
  hub 的 `_armHoldTimer` 只被源码守卫钉住（真的等 3 分钟会让测试套变成 3 分钟）。
- **结算页的把数行在竖屏仍需滚动才能完整看到**（v117 起就如此，本轮没有恶化）。
  记入 `BACKLOG.md` B-L7 —— 「等个人」并进这一行之后，它也跟着要滚动才能点。

### 发布结果（v122）

| 项 | 结果 |
|---|---|
| 部署 | `https://your-app.app.workbuddy.host/?sharecode=REDACTED`（同一个应用，链接不变） |
| 线上冒烟 `probe-online-smoke` | **15 / 15 通过**（含 Service Worker 已接管；版本核对 = 本地 `20261102k`） |
| 公库 | `fca7b67 chore: 同步自私有仓库（7a10556）` |
| 私库 | `7a10556`（`git ls-remote` 比对一致） |


---

## v123 · 完善：把「等人」和「局中旁听」做成能用的（版本 `20261102l` / sw `v123`，2026-11-02）

v122 把两条机制都接上了，但「接上」和「能用」之间还差三件事：入口找不找得到、
信息看不看得懂、以及那个最危险的「旁听者会不会把整桌卡住」到底验没验过。

### 一、先验死局：旁听的人会不会把整桌卡在「等一个人交牌」

`settleIfAllIn` 用的是 `playingPlayers`，所以理论上不会。但这属于**猜对了也不能算数**的一类：
改错一个字就是「牌局永远打不完、没有任何出口」，而且只有真人牌局才会出现。

新增 `server/test/spectate-full-hand.test.js`（16 项，真 WebSocket）：两个真人 + 一个局中加入的旁听者，
把一整把牌真的打完：

| 步 | 断言 |
|---|---|
| 一个人交牌 | 停在分牌阶段（该等另一个人，**不是**等旁听者） |
| 另一个真人也交 | **当场结算** —— 这就是死锁探针 |
| 旁听者提交分组 | 被拒，且文案是「这一把你在旁听，没有牌可提交」 |
| 这一把结束 | 他的分数、`forfeitRound`、手牌一个都没被动过 |
| 他点「开始下一局」 | 下一把真的拿到 6 张牌，三个人都在打 |

### 二、旁听者点「提交」会收到一句看不懂的话

`submitGroups` 没有拒绝 `benched`，他会一路掉进张数校验，收到「每组必须填满 2 张」——
而他手上根本没有牌。加一条前置判断，给一句人能读懂的话。

### 三、入口：三次布局尝试，最后只能和主按钮挤一排

「等人」这颗按钮的位置比它本身难做。结算页在 390×844 上的垂直预算**早就用完了**：

| 试法 | 结果 |
|---|---|
| 滚动区里单独一块 | 内容被推到底部动作条下面，`cover 重叠 4177px²（占小者 75%）` |
| 并进「打几把」那一行 | 不撞了，但竖屏要往下滑才看得见 —— 功能存在却点不到 |
| 塞进 `#settle-wait` 那一行 | 行高 +44，滚动区再压 5%，反过来压住把数块（`cover 1807px²`） |
| **和「开始下一局」同排** | 通过。主按钮从 462 缩到 430 设计 px，不新增任何高度 |

同排之后还修了一次：按 88 设计 px 宽放两个字，字号只能压到 22 设计（≈11 实际），
截图上几乎读不出来 —— **热区够不等于能用**。加宽到 120 设计、字号 34 设计才看清。
journey 现在直接量它的矩形：`top >= 0 && bottom <= innerHeight`（首屏）+ `≥44×44`（热区）。

### 四、两处「信息缺一口」

| 缺什么 | 补什么 |
|---|---|
| 房主挂起后只知道「N 人已进入下一把」，要自己数数、还要回忆刚才有几个人 | 直接点名：`张三 已进来，可以开牌了`；一个人都没到时说清「最多 3 分钟」 |
| 旁听者那一局只有一句「你不在这一局」，最多要等 10 把、没有任何进度 | 卡片上补 `已交 1/2`（只给聚合数：不泄露任何人的牌，也不猜谁在改） |

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **135 文件 / 5324 条断言 / 0 失败**（v122 是 134 / 5304） |
| 新增 `server/test/spectate-full-hand.test.js` | 16 项（见上表） |
| `pwa/test/hold-next.test.js` | 51 → 55 项：入口位置、委托覆盖 `#settle-wait`、点名「谁进来了」、旁听进度 |
| `npm run journey` | **147 项 / 0 失败**（v122 是 145） |
| — `[7e]` 新增两条 | **「等人」在首屏可见**（不用滚动）+ 热区 ≥44×44 |
| `probe-ui-flow` iOS 竖 390×844 | 1 视口 × 13 屏 **ALL PASS**（第三次布局改完才过） |
| `probe-ui-flow` iOS 横 844×390 | 1 视口 × 13 屏 **ALL PASS** |

### 没验证到的

- **「房主挂起 → 朋友进来 → 点名可以开牌」只有源码守卫，没有一次实跑**。
  journey 只有一个真人身份，AI 的 `joinedLate` 恒 false，造不出「刚进来的真人」。
  要覆盖得先解决 journey 的多身份问题（与 B-L6 第四条同一个前置）。
- **journey 出现过一次 111 通过 / 25 失败 / 71 秒**（正常是 147/0/26 秒），
  随后连跑 4 次（含 `npm test` 之后立刻跑）全部 147/0，**未复现**。
  现象像「CDP 端口被上一次运行的 Chrome 残留占住」，暂记为观察项，不当作已修。
- 结算页的把数那一行**仍需滚动**才能看全（B-L7，v117 起就如此，本轮没有恶化）。

### 发布结果（v123）

| 项 | 结果 |
|---|---|
| 部署 | `https://your-app.app.workbuddy.host/?sharecode=REDACTED`（同一个应用，链接不变） |
| 线上冒烟 `probe-online-smoke` | **15 / 15 通过**（版本核对 = 本地 `20261102l`，SW 已接管） |
| 公库 | `281a3c2 chore: 同步自私有仓库（6a57eb5）` |
| 私库 | `6a57eb5`（`git ls-remote` 比对一致） |

---

## v124 · 回放的「第几把」不再跨局累加（版本 `20261102m` / sw `v124`，2026-11-06）

### 用户报的现象

> 打完一把再继续一把，战绩页里边后续的对局详情里会把之前的局数叠加，
> 造成越到后边对局里，局数越高，而不是实际局数。

### 根因：一个字段同时当"身份"和"序号"

`packHistory` 里每个 pack 只有 `hands` 一个数字，而它承担了两件互相冲突的事：

| 用途 | 需要什么 | 实际用的 |
|---|---|---|
| 回放定位 / 存档去重 | **跨局唯一** → `handId`（`dealAll` 里递增，永不重置） | `handId` ✔ |
| 卡片标题「第 N 把」 | **每局从 1 开始** → `handCount`（每局归 1） | 还是 `handId` ✘ |

复现（真状态机，3 把房打两局）：

```
第一局   hand/hid = 2/2 2/2 3/3 3/3      ← 窗口只留 4 条
第二局   hand/hid = 1/4 1/4 2/5 2/5      ← 第 1、2 把
回放标题 「第 4 把」「第 5 把」           ← 用户看到的
```

`hid` 是身份，`hand` 才是序号。两者在第一局恰好相等（1/1、2/2…），
所以第一局看起来完全正常 —— 这也是这个 bug 到第二局才显形的原因。

### 改法：把两个概念拆成三个字段

| 字段 | 含义 | 来源 | 谁在用 |
|---|---|---|---|
| `hands` | 把次**身份** | `handId` | 回放定位、SessionLog 去重、排序 |
| `no` | **显示序号**（本局第几把） | `handCount` | 卡片标题 |
| `g` | **局号** | `handSeq`（新增到 history 条目） | 局分隔标题、副标题 |

- `stateMachine`：history 条目多记一个 `seq`（结算前 push，同一把两轮共用一个值）。
- `historyKit.packHistory`：产出 `{hands, no, g}`。
- `sessionLog.sanePack` 与 `records.saneReplay`：**两个裁剪函数都必须保留 `no`/`g`**
  —— 漏一个就是「内存里修好、刷新一次复发」。
- `recordsView`：标题读 `v.no`，`data-hand` 与定位仍读 `v.hands`；跨局时插入
  「第 N 局」分隔；副标题跨局写 `N 局 · M 把`，不冒充「整场」。

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **136 文件 / 5368 条断言 / 0 失败**（v123 是 135 / 5324） |
| 新增 `pwa/test/replay-handno.test.js` | **44 项**：真打两局 → 数据层 / 存档层 / 渲染层三层都断言 |
| 变异自证（把 `no` 改回 `hn`） | **5 条立刻变红**（4、5 而不是 1、2），已还原 |
| `npm run journey` | **149 项 / 0 失败**（v123 是 147；新增「第 N 把 ≤ 总把数」「局分隔不成单」） |
| 变异自证（把标题改回 `v.hands`） | journey 立刻红：`第 7 把 / 第 8 把`（总把数 4），已还原 |
| `probe-ui-flow` iOS 竖 390×844 | 1 视口 × 13 屏 **ALL PASS** |
| 回放截图人眼复核 | 「第 4 局」灰字分隔，层级低于「第 N 把」；无重叠、无裁切 |

### 没做 / 没验证到

- **老存档修不回来**：v124 之前写进 localStorage 的 packs 没有 `no`/`g`，
  信息已丢。回退规则是 `no ← hands`、`g ← 0`，显示与修之前一致（不会更差），
  但那些记录仍会显示「第 4 把」。新打的局正常。
- **journey 的档案会缺把**：AI 快进时 `history` 只留 2 把，吸收跟不上就会漏掉
  前面的把（本次实测：4 把分布在「第 1 局」和「第 4 局」，中间两局没收到）。
  这是既有的采集节奏问题，不是本次引入；因此 journey 只断言「序号 ≤ 总把数」
  （不受缺口影响），连续性由 `replay-handno.test.js` 在可控真对局里守。
- **局号会跳号**：`handSeq` 每次「结束本局」都 +1，所以看到「第 1 局 → 第 4 局」
  时中间确实结算过三局（哪怕那些把没被收进档案）。这是真话，不是算错。

### 发布结果（v124）

| 项 | 结果 |
|---|---|
| 部署 | `https://your-app.app.workbuddy.host/?sharecode=REDACTED`（同一个应用，链接不变） |
| 线上冒烟 `probe-online-smoke` | **15 / 15 通过**（版本核对 = 本地 `20261102m`，SW 已接管） |
| 公库 | `1c285ac chore: 同步自私有仓库（e50a4c1）` |
| 私库 | `e50a4c1`（`git ls-remote` 比对一致） |

---

## v125 · 让「时间」只有一个真相（版本 `20261102n` / sw `v125`，2026-11-06）

三份评审（`docs/review/`）收敛出的第一条：**唯一「一次重启就会静默改变对局规则」的地方，
是定时器不随房间快照恢复**。这一版只做时间线，不碰文案与布局。

### 一、重启后全桌永不结算（最严重，P0）

`_restoreRooms` 原本只重挂 `_armRoomRecycle`，再靠一次广播把分牌计时器装回去。
`graceTimers`（断线宽限）与 `dissolveTimers`（解散投票）**一条都没恢复**。
而恢复时所有人又被置成 `connected = false`，分牌超时回调里明确写着「断线的人跳过」：

> 一桌人打到一半、有人断线 → 进程重启 →
> 断线者永远等不到 `finalizeLeave`（不会被判离开），
> 别人的分牌超时又全部跳过断线者 → **全桌永远不结算**。
> 唯一出路是有人重连后自己交牌，或凑齐解散票。

每次发布都撞一次概率，只在恰好有进行中对局时真的发生 —— 所以从来没被报回来过。

**修法**：新增 `_restoreTimersOf(room)`，按 `disconnectedAt` 的**剩余**时间补挂：

| 情况 | 处理 |
|---|---|
| 宽限还没到（断了 10 秒 / 共 90 秒） | 按剩余 80 秒挂，**不重新给满**（重启不该让人多赚时间） |
| 宽限已经过了（断了 2 分钟） | **立刻** `finalizeLeave`，不再白等一轮 |
| 老快照没有 `disconnectedAt` | 按「刚断」处理，给满额 —— 不能凭 `undefined` 判人离开 |
| 进行中的解散投票 | `_syncDissolveTimer` 按 `startedAt` 补挂 |
| 进行中的「等人」挂起 | `_armHoldTimer` 按 `holdNextLeftMs` 补挂 |

注意顺序：**先补时间线，再广播**。广播会把分牌计时器装回去，而那套回调会跳过断线者；
先广播后判宽限，就会留一段「没人会超时、也没人会被判离开」的窗口。

### 二、等人定时器与数据是两套时间（QA 的 C1）

数据侧按 `holdNext.at + HOLD_TTL_MS` 过期，定时器侧写死 `setTimeout(..., HOLD_TTL_MS)`。
`setHoldNext` 是幂等的（重复点不重置 `at`，有测试保证），而 handler 每次都重挂：

```
第 0 秒   挂起          数据 180s，定时器 180s   ✔
第 100 秒 再点一次「等人」 数据 180s，定时器 280s   ✘
```

中间那 100 秒：挂起已不挡开局，但没有任何广播 —— 所有人看到「都就位了，就是不开」。
两条各自的测试都是绿的，问题夹在中间。

**修法**：只认一个真相 —— `wait = holdNextLeftMs(room)`，
定时器与返回值用**同一个变量**（分开写的话，「同基准」那条断言会永远绿，因为它算的被测不是真正决定触发时长的那个）。

### 三、三个到期回调体第一次被真跑到（QA 的 C2）

`GRACE_MS`(90s) / `HOLD_TTL_MS`(3min) / `ROOM_IDLE_MS`(30min) 原本是硬编码，
在 CI 里等于永不发生 —— 也就是说这三段代码**从来没被执行过**，
而它们恰好是「唯一会判人离开」「唯一会回收房间」的路径。

改成 `Number(process.env.X) || 默认`（照 `SPLIT_TIMEOUT_MS` 的现成范式），
用 250~600ms 真等：
- 宽限到期 → 真的判了离开；宽限内回来 → 不许判；
- 挂起到期 → `holdNextOf` 放行 + **真的自动发牌**；
- 空房到期 → 房间真的被删；有活连接 → 不许回收。

**不引入假时钟**：零依赖原则下不值得加 sinon，而且假时钟会把「setTimeout 到底挂没挂上」也一并假装掉。

### 四、`holdNextEndsAt`：从死数据到有消费点（架构第 10 条）

原来只下发 `leftMs`（相对秒数），而且只在**协议响应**里 —— 广播的房间快照中没有它。
于是房主挂起后，所有人只看到「房间已挂起」，没人知道它什么时候会自己放开；
到点牌突然开了，反而像 bug。

- 服务端：`_view` 下发 `holdNextEndsAt`（绝对时刻）+ `now`，与 `splitEndsAt` 同一口径；
  放在 `viewerId` 分支**之外** —— 等不等是整桌的事，且它不含任何手牌信息。
- 前端：`settleView.holdLeftText(room)` 扣掉时钟偏差算剩余；
  结算页与就位态共用 `.hold-left`，由 `syncHoldTick` 每秒只改这一个 span
  （整块重绘会打断正在点的按钮和手牌动画）。切走屏时按 `offsetParent` 停表。

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **140 文件 / 5434 条断言 / 0 失败**（v124 是 136 / 5368） |
| 新增 `server/test/hold-timer-clock.test.js` | 18 项：同基准、重复点不续命、到点真自动开局、下发字段 |
| 新增 `server/test/timers-restore.test.js` | 21 项：剩余补挂 / 已超时立刻判 / 投票与挂起补挂 / 老快照兜底 |
| 新增 `server/test/timers-expire.test.js` | 16 项：三个到期回调体**第一次被执行**（真等 250ms） |
| 新增 `pwa/test/hold-left-text.test.js` | 11 项：绝对时刻换算、时钟偏差扣除、过期文案 |
| 变异自证（`wait` 改回 `SM.HOLD_TTL_MS`） | **2 条立刻变红**（差 121ms），已还原 |
| `npm run journey` | **151 项 / 0 失败**（v124 是 149；新增「挂起时显示还剩多久」） |
| `probe-ui-flow` iOS 竖 390×844 / 横 844×390 | 各 13 屏 **ALL PASS** |

### 没验证到 / 已知残留

- **分牌计时器不按剩余恢复**：`splitStartedAt` 不落盘，重启后只能按满额 60 秒重挂。
  方向是宽松（给人更多时间回来），不会造成「永不结算」，本轮有意不动。
- **测试里两个 Hub 同进程**：h1 的 timer 仍在（`unref`）。真实 `kill -9` 的「断电那一刻」
  在单测里没有稳定复现姿势，这里覆盖的是重启后的读取分支。
- **倒计时没有被真人多设备验证过**：journey 是单浏览器，只能证明「有这一句、数字来自服务端」；
  两台手机时钟差 5 分钟时的实际观感未实测。

### 发布结果（v125）

| 项 | 结果 |
|---|---|
| 部署 | `https://your-app.app.workbuddy.host/?sharecode=REDACTED`（同一个应用，链接不变） |
| 线上冒烟 `probe-online-smoke` | **15 / 15 通过**（版本核对 = 本地 `20261102n`，SW 已接管） |
| 公库 | `b774399 chore: 同步自私有仓库（edcfb2a）` |
| 私库 | `edcfb2a`（`git ls-remote` 比对一致） |

---

## v126 · 出口语义：让「开不了」说得出真正的原因（版本 `20261102o` / sw `v126`，2026-11-06）

评审收敛出的第二条（`docs/review/` 三份都指向它）：
**结算期状态机「有否决条件、没有出口语义」**。
四条独立成因、同一症状：界面显示正常、所有人都「准备好了」、牌就是不发，
而且没有任何东西告诉你会一直不开。

### 一、一个布尔 → 五个原因码

`canStartNext` 原本返回 true/false，而门槛有**四条**判据，视图只渲染了其中三条的原因。
于是 2 人房里对手一掉线，玩家同时看到三句都对的话：

| 玩家看到的 | 实际情况 |
|---|---|
| 「等 X 点开始下一局」 | X 已掉线，永远不会点 |
| 「不等他」按钮亮着，点了回「已跳过」 | 跳过之后仍然只有 1 人，开不了 |
| 房间没有动静 | 确实开不了 —— 但没人知道为什么 |

新增 `SM.nextRoundGate(room)` 返回 `{ ok, code, joined, need, pending, offline }`：

| code | 含义 |
|---|---|
| `HOLD` | 房主明说「先别开牌」（最优先、最便宜） |
| `WAITING_OTHERS` | 还有在场真人没表态 |
| `WAITING_OFFLINE` | 没表态的人里有人掉线（他没连接，点了也收不到） |
| `NEED_PLAYERS` | 没人可等了，人数还是不够 |
| `OK` | 可以开 |

`canStartNext` 保留为 `nextRoundGate(room).ok` 的**布尔转发** —— 4 个生产调用点、
40 多处测试断言一条都不用改，而它们要问的确实只是「能不能」。

**顺序是改过一版的**：最初把「人数够不够」放在「在等谁」前面，2 人房里我报了名、
对方还没点，会被判成「人不够 · 去补 AI」——可对方只是还没来得及点。
正确语义是：**只要房间里还有能表态的人就等人**，等所有人都表完态还不够，才叫「人不够」。

### 二、文案独立成表，枚举必须与状态机等值

新增 `pwa/js/nextRoundHints.js`：一个 code 一条文案，**没有第二个分支**。

为什么不留在 `renderRoom` 里：那样「为什么开不了」就有两份实现（就位态一份、
结算页一份），2 人房掉线时两屏说法不一致、而且都说错方向。
收成一张表之后，测试能直接 `require` 它并断言：

> `Hints.codes()` 的集合 **===** `SM.GATE_CODES` 的集合

以后加第 6 个否决条件却忘了加文案，这条会立刻红 —— 而这正是 v121 那个 bug 的形态。

几条写进文案的判断：

| 场景 | 说什么 | 为什么 |
|---|---|---|
| 等的是我自己 | 「还在等你点…」 | 念自己的昵称会让玩家慢半拍，而这一秒需要他立刻按下去 |
| 一个人都没上场 | 「点开始下一局就开」，**不提补 AI** | 2 人房要补 2 只，会造出「0 真人 + 2 AI 自己打」的空转局 |
| 掉线的人 | 点名 + 「等他重连，或者补 AI」 | 只说「等他」= 全桌盯着一个黑头像 |
| 非房主 | 「房主可以补 AI」 | 他那边没有那颗按钮，不能让他去找 |

### 三、`dropFromNext`：跳过一个人之后必须还开得起来（#11 止血）

2 人房对手结算期掉线（v113 的正当设计：只标 `connected=false`，不判 `left`）：

```
我报名 → 能上场 1 人 < 2
      → pending 里还挂着他（不过滤 connected）
      → 「不等他」亮着，点下去**返回成功**
      → 房间依旧开不了
```

现在 `target ≠ self` 时先算 `nextRoundPlayers` 长度：不够 2 人就直接拒绝，
并说「现在只有你一个人能上场，跳过他也开不了 —— 补个 AI 队友，或者等他回来」。

**`target === self` 必须继续允许**（「这一把先不打」是 v121 留下的唯一出口，
拦掉等于把人锁在房间里），3 人房里跳过掉线者照常可用 —— 两条都有断言钉着。

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **141 文件 / 5494 条断言 / 0 失败**（v125 是 140 / 5434） |
| 新增 `pwa/test/next-round-gate-codes.test.js` | **54 项**：五态各就位、canStartNext 一致性、枚举等值、文案真话、#11 守卫、出口不变量 |
| 变异自证：去掉人数下限守卫 | **3 条立刻变红**（返回成功却开不了），已还原 |
| 变异自证：跳过「在等谁」判断 | WAITING_OTHERS → NEED_PLAYERS，2 条红 |
| `npm run journey` | **151 项 / 0 失败**（文案与按钮显隐都跟着改了，逐条对齐） |
| `probe-ui-flow` iOS 竖 / 横 | 各 13 屏 **ALL PASS** |

### 顺手修掉的一处工程问题

用 python 改写文件时，Windows 下默认会把 `\n` 写成 `\r\n`，导致工作区行尾从 LF 变 CRLF。
而 `binder-split.test.js` 的正则是 `/  function bindEvents\(\) \{([\s\S]*?)\n  \}\n/` ——
`}\r\n` 不匹配 `}\n`，于是它报「找得到 bindEvents」失败，看起来像改坏了 game.js。
已把工作区统一回 LF（仓库本来就是 LF），并记进 `BACKLOG.md`。

### 没做到 / 没验证到

- **「补 AI」仍在就位态那颗按钮上**，结算页不给新入口。
  `joined === 0` 时补 AI 要补 2 只（空转局），`joined >= 1` 时房主通常已经报名进了就位态，
  那里本来就有补 AI。所以这一版只补文案指向，不加按钮、不加高度。
- **#11 的实跑只有单测**：journey 是「单真人 + AI」，AI 不会掉线，造不出 2 人房对手掉线。
- `dropFromNext` 的守卫用的是「已报名人数」，不是「房间里还有几个人」——
  两者在「有人没表态」时不同。选前者是因为它才是「跳过之后能开吗」的直接答案。

### 发布结果（v126）

| 项 | 结果 |
|---|---|
| 部署 | `https://your-app.app.workbuddy.host/?sharecode=REDACTED`（同一个应用，链接不变） |
| 线上冒烟 `probe-online-smoke` | **15 / 15 通过**（版本核对 = 本地 `20261102o`，SW 已接管） |
| 公库 | `0eff8ac chore: 同步自私有仓库（08cfb6b）` |
| 私库 | `08cfb6b`（`git ls-remote` 比对一致） |

---

## v127 · 别再把 bug 吞掉（版本 `20261102p` / sw `v127`，2026-11-06）

评审收敛出的第三条。前两条修的是「会不会卡住」，这一条修的是**「卡住了你知不知道」**。

### 一、一句话说清问题

`RoomStore` 的协议方法**已经**把 reject 转成了 `{ok:false, error}`
（`roomStore.js` 里 31 个 `ws.xxx` 全带 `.catch`，唯一例外是 `createRoom`）。
所以能落进 `game.js` 那些 `catch` 的，**不可能是「请求失败」**，只可能是本端把自己绊倒了：
方法不存在、解引用 `undefined`、`render()` 抛异常。

而它们统一说了一句 `网络不太稳，再试一次`。两个害处：

| 害处 | 具体 |
|---|---|
| 诱导重复提交 | 交牌时异常出在 `render()`，牌**已经交上去了**；玩家再交一次撞「本轮已提交」，然后继续怀疑网络 |
| 线上零信号 | `errorReport` 只收未捕获异常，被 `catch` 住的上报不了 —— v121 的 `dropNext is not a function` 就是这么消失的 |

### 二、改法：一个出口，承认是本端的问题

`game.js` 新增 `reportBug(where, e, userMsg, kind)`：

| 参数 | 作用 |
|---|---|
| `where` | 动作名（`submitGroups` / `wantNext` …），线上能直接看出是哪一步 |
| `userMsg` | 覆盖文案；**传 `null` = 只上报不提示**（回座 / 快照核对这种本来就该安静的） |
| `kind` | 默认 `catch`；建房用 `net`（它是唯一真会把网络失败抛上来的） |

默认文案是 `出了点问题，已经记下了` —— 不提网络，并且是**实话**（真的上报了）。

改到的 13 处：`setHandLimit` / `beginRevise` / `cancelRevise` / `submitGroups` /
`wantNext` / `setReady` / `addBot` / `dropNext` / `holdNext` / `unWantNext` /
`proposeDissolve` / `createRoom` / `joinRoom`，外加两处原来**连提示都没有**的：

- `tryResumeRoom`：`catch (e) { return; }` —— 刷新后自动回座失败，一条记录都不留。
  这条路悄悄坏掉时，一次发版能让所有人的座位都回不去，而服务端看不出异常。
- `fetchRoomSnapshot`：`catch (e) { p = null; }` —— 用户侧有「没核对上」的兜底文案，
  缺的只是"我们这边知道"。

### 三、订阅者：吞掉可以，但不能不留痕

`roomStore.js` 里 8 处 `try { cb(...) } catch (e) {}` 全部改成 `reportSubscriber(where, e)`。
**不重抛** —— 重抛会把一次局部渲染失败升级成整条广播失败，别的订阅者就都收不到了。

v108 的 `ReferenceError: state is not defined` 就是死在这里：界面从此不再更新，
控制台没声音，服务端零记录，最后靠人肉复现才找到。

### 四、守卫：守「说谎的那一类」，不是「所有空 catch」

`pwa/test/no-silent-catch.test.js`（47 项）+ journey `[9e]`（5 项）。

**为什么不一刀切要求"空 catch 必须写日志"**：`pwa/js` 下有 150 多处 catch 围着
`focus()` / `history.replaceState` / `AudioContext` / `socket.close`，
它们抛出来没有任何补救动作，全加日志只会把真问题淹掉。
一刀切的规矩没人守得住，守得住的是这一条：

> **catch 里只要给了用户提示（flash），就必须同时上报。**

三条具体判据：

| 判据 | 拦的是什么 |
|---|---|
| 全 UI 层 31 个模块、156 处 catch：给提示必须上报 | v121 那种「说网络不太稳」 |
| 协议调用的 catch 不许只有 `return` | 回座那条静默路径 |
| 订阅者的 catch 不许空着 | v108 那种「界面再也不更新」 |
| 代码里 `网络不太稳` 必须为 0 | 同一句话不许再出现 |

**守卫自己踩了两次坑，都记在文件注释里**：

1. 第一版把「订阅者」的判据写在 catch 体里找 `list[i](room)` —— 那句话在 `try` 里，
   结果匹配到 **0 处**，断言却"通过"了。守错误报比没守卫更糟。
2. 第一版按 `\{([^{}]*)\}` 取 catch 块体，被一条**注释里的 `{ok:false}`**
   提前收尾，于是 `reportBug` 那行被判成"块外"。改成把注释抹成等长空格再解析。

两次都是「守卫因为自己的实现而失明」，所以两条修正都写成了注释留在代码里。

### 五、journey 补一件真事：上报通道在浏览器里是活的

单测是在 Node 里把 `reportBug` / `reportSubscriber` 抠出来跑的 ——
它证明不了**浏览器里 `game.js` 到底看不看得见 `ErrorReport`**。
如果看不见，`typeof ErrorReport !== 'undefined'` 恒为 false，上报全部静默失效，
而那 47 项守卫会全绿。`[9e]` 在真页面上量：全局可达、`capture` 可调、
`_stats` 是活的、端点指向 `/api/client-error`、sharecode 与页面 URL 一致。

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **142 文件 / 5540 条断言 / 0 失败**（v126 是 141 / 5494） |
| 新增 `pwa/test/no-silent-catch.test.js` | **47 项**：全 UI 层扫描 + 协议调用 + 订阅者 + 行为断言（capture 被调用 / 不重抛 / null 不提示） |
| 变异自证：`addBot` 改回 `flash('网络不太稳')` | **4 条立刻红**，已还原 |
| 变异自证：`emit` 的 catch 改回空 | **3 条立刻红**，已还原 |
| 变异自证：`resume` 改回裸 `return` | **2 条立刻红**，已还原 |
| `npm run journey` | **156 项 / 0 失败**（v126 是 151） |
| `probe-ui-flow` iOS 竖 / 横 | 各 13 屏 **ALL PASS** |

### 没做到 / 没验证到

- **没有端到端证明"一次真实异常真的写进了服务端日志"**。`[9e]` 证明的是通道可达，
  服务端收不收由 `server/test/client-error.test.js` 覆盖；中间那一跳（浏览器 → 本机 server）
  只在本轮手工观察过，没有断言。
- **上报是尽力而为**：`errorReport` 每会话最多 10 条、同 message 只报一次、不做重试。
  一个渲染循环里的异常刷屏不会打满服务端，但也意味着"第一条最重要"。
- **journey 出现了一次已知偶发红**（`第 1 轮十点半没爆` → 后续 8 条连锁红，耗时 25.8 秒），
  重跑即 156/0。这是 `BACKLOG` B-L5 记了两轮的老问题，本轮**没有修**，
  但第二次撞上说明它不是"一次性抖动"。

### 发布结果（v127）

| 项 | 结果 |
|---|---|
| 部署 | `https://your-app.app.workbuddy.host/?sharecode=REDACTED`（同一个应用，链接不变） |
| 线上冒烟 `probe-online-smoke` | **15 / 15 通过**（版本核对 = 本地 `20261102p`，SW 已接管） |
| 公库 | `baedd46 chore: 同步自私有仓库（304953e）` |
| 私库 | `304953e`（`git ls-remote` 比对一致） |

---

## v128 · 回归面：12 档全跑，协议缝钉住（版本 `20261102q` / sw `v128`，2026-11-06）

评审收敛出的第四条。前三条修的是"会不会坏 / 坏了知不知道"，
这一条修的是**"我们凭什么相信它没坏"**。

### 一、12 档第一次全跑，第一天就撞出东西

`probe-ui-flow` 一直支持 12 个视口，CI 从 v110 起只跑 2 个
（390×844 / 844×390），其余 10 档"一直都在那儿，只是没人跑"。

补跑 360×640 的第一天就报了 **6 条 `cover` 遮挡**，
其中一条还是 v123 刚加的「等人」按钮 —— 看起来像"上一版又压到底部按钮上了"。

**查下来是探针自己的假红**：

| | |
|---|---|
| 现象 | `button.shl-opt × button#btn-next — 重叠 662px²（占小者 37%）` |
| 截图 | 那块区域**什么都没画** |
| 原因 | `.settle-body` 是 `overflow-y:auto`，把数那一行滚到折线以下 |
| 关键 | `getBoundingClientRect()` 给的是**布局位置**，被裁掉的内容仍然有布局位置 |

于是新增 `paintedRect(el)`：把元素矩形与所有"会裁切"的祖先（`auto/scroll/hidden/clip`）
求交，得到**真正会被画出来**的那块；完全被裁掉就返回 null，直接不参与遮挡判定。

**变异自证**：把 `.settle-body` 的 `overflow-y` 改成 `visible`（真的压上去）→
**6 条 cover 原样回来**。所以不是"改松了所以全绿"。

### 二、CI 怎么装下 12 档：分 3 片并行，按族切

12 档跑一遍约 13 分钟，一个档位红了会把其余 11 档结果一起埋掉。

| 分片 | 档位 |
|---|---|
| iOS 四档 | 390×844 / 844×390 / 430×932 / 932×430 |
| 安卓四档 | 360×640 / 360×800 / 800×360 / 915×412 |
| 电脑四档 | 1280×720 / 1920×947 / 分屏 960×1040 / 728×348 |

按族切而不是按数量平均：三族的失效方式不一样（安全区 / 窄屏断行 / 大留白），
混着切，一片里三族各坏一条反而看不出规律。

`ONLY` 因此支持逗号分隔（`ONLY='390x844,844x390'`），同一片共用一个进程 ——
每次启动都要开浏览器、起静态服务、等字体就绪，那个固定开销比跑一档还大。

`journey` 从 `ui-probe` 里拆成独立 job：巡检分片后，它挂在某一片上会变成
"只有那一族挂了才跑"；挂三份又是白跑两遍。

**每片自带自检**：解析日志里的 `本轮视口 N 个`，`N !== 4` 就 `::error::` 退出。
用 node 解析而不是 grep —— runner 的 C locale 下 grep 匹配不到多字节字符
（上一轮就因此只看到一句「exit code 2」）。

### 三、第一次跑就抓到一个真缺陷：`leaveRoom` 一个方法两种形状

新的 `server/test/protocol-seam.test.js` 用真服务端 + 真 `roomStore` 打穿 22 个请求时，
`leaveRoom` 返回了 `{}`。

查下去是 `ws.leaveRoom` 的最后一行 `.then(function (r) { ...; return r; })` ——
`r` 是服务端回的**空 payload**：

| 场景 | 返回 |
|---|---|
| 成功 | `{}`（没有 `ok`） |
| 失败 | `{ok:true}`（catch 里造的那个） |

一直没出事，只因为唯一的调用方（退出房间）不看返回值。下一个人照其他请求的惯例
写一句 `if (!res.ok) flash('离开失败')`，就会在**成功退出之后**弹错误。

统一成 `{ok:true}`，并且保留"失败也报成功"的原意（退房是尽力而为，
连接断了也算退出，房间有宽限和回收兜底）。

### 四、seam 测试：22 个请求 + 一条结构对账

`roomStore.js` 有三层同名的东西：对外 API / `ws` 实现 / `local` 实现。
历史两次真 bug 都出在"这三层对不上"：

| 版本 | 症状 |
|---|---|
| v117 | 前端把 `playerId` 放 payload 顶层，服务端读 `payload.playerId` |
| v121 | `RoomStore.dropNext` 在 `ws` 里有、**对外 API 里根本没有** → `is not a function` |

测试分四段：

| 段 | 判据 | 能拦什么 |
|---|---|---|
| 结构对账 | 页面里出现的每个 `RoomStore.xxx` 都必须在对外 API 表里 | **v121 那条，当场红** |
| 真链路 | 22 个请求全部回 `{ok:boolean}` | 方法不存在 / payload 形状错 / 返回裸值 |
| 主流程 | 16 个动作必须 `ok:true` | 只是"有形状"但业务上被拒 |
| 参数形状 | 错参数必须**明确拒绝**（不是 500、不是假成功） | v127 那条"假成功比报错更糟" |

三处变异自证：外层 `dropNext` 改名 → 结构对账红；`handLimit` 改成 `limit` → 2 条红；
`leaveRoom` 改回 `return r` → 3 条红。

### 五、CI 覆盖守卫：别让"支持"和"在跑"再次分家

`pwa/test/ci-matrix.test.js`（14 项）把两边的清单对起来：

> 探针 `VIEWPORTS` 里的每一档，CI matrix 里必须**恰好出现一次**。

加了第 13 档却忘了加进 CI —— 这条会红。分片大小不均匀（差 >1）也会红，
因为一个 8 档的分片会让整轮 CI 的墙钟时间等于它自己。
变异自证：从 matrix 删一档 → 红；往 `VIEWPORTS` 加一档 → 红。

### 验收

| 项 | 结果 |
|---|---|
| `npm test` | **144 文件 / 5600 条断言 / 0 失败**（v127 是 142 / 5540） |
| 新增 `server/test/protocol-seam.test.js` | **46 项**：结构对账 + 22 个请求 + 参数形状 |
| 新增 `pwa/test/ci-matrix.test.js` | **14 项**：12 档覆盖 + 分片均匀 + 自检存在 |
| `probe-ui-flow` **全 12 档** | **12 个视口 × 13 屏 ALL PASS**（历史首次） |
| 变异自证 | 探针裁切、seam 三处、CI matrix 两处，共 6 组全部变红 |
| 软登记 | 38 条热区 30~44（触屏偏小，桌面无关）+ 1 条半行硬切（B-L7） |
| `npm run journey` | 156 项 / 0 失败 |

### 没做到 / 没验证到

- **CI 的 matrix 只在本地做了结构校验，还没在 GitHub 上真跑过一轮**。
  YAML 没有可用的本地解析器（仓库零依赖），所以用「缩进/结构自检 + 把 run 段提取出来
  在本地真跑三种分支」代替；真正跑通要看下一次 push 的 Actions 结果。
- **`paintedRect` 只处理了"祖先裁切"**：`position:fixed` 的后代不受祖先裁剪影响，
  本项目弹窗都在 `#stage` 里没有这种结构；真要出现会**多报**（保守方向）。
- **12 档里仍有 1 条半行硬切**（结算页 `result-group` 露出 95%），
  这是 B-L7 那笔老账，本轮没有改布局。
- 探针只覆盖"一条主路径 × 13 屏"。另外 40 多个探针仍然不在 CI 里 —— 不在本轮范围。

### 六、顺手把「CI 红了但没人知道红在哪」修掉，并因此定位了一个真问题

推上去之后翻公库 Actions，发现 v125/v126/v127 的三次「回填文档」提交
`test` job 全是红的 —— **而且红得毫无信息**：check-run 上只有一句
「Process completed with exit code 1」，job 日志要 admin 权限才下得下来。

先把这件事本身修掉：`全量测试` 步骤改成失败时用 node 解析日志，
把每个失败的测试文件 `::error::` 输出成 annotation。下一次 push 之后，
annotation 直接写着：

```
✗ [107/144] server/test/dissolve-timeout.test.js  (exit 1)
```

**第一次修错了地方。** 我把解散超时从 300ms 放大到 1200ms，CI 仍然红同一个文件。
说明窗口不是主因，**固定等待才是**：这个测试里有 6 处「`await wait(60~80)`
然后断言某个状态已经变成 X」。赌的是「两次 ready + 自动开局广播」在 80ms 内走完 ——
本机空载成立，CI 上同机跑 5 个 job 不成立。

正确的修法是**等状态变化，不赌固定时长**：两处关键等待改成
`waitForRoom(client, cond, timeout)` 轮询（这个 helper 本来就在文件里）。
三个定时器测试的窗口也一并放大（那是另一个真隐患，只是不是这次的主因）。
**没变松**：把 `GRACE_MS` 设成 99999（回调永不触发）→ 2 条断言立刻红。

**最终验证**：公库 Actions 第 42 次运行（`7672ac6`）四个 check **全绿** ——
`test (22)` + iOS / 安卓 / 电脑 三个巡检分片。这个仓库此前 `test` 一直是红的。

### 发布结果（v128）

| 项 | 结果 |
|---|---|
| 部署 | `https://your-app.app.workbuddy.host/?sharecode=REDACTED`（同一个应用，链接不变） |
| 线上冒烟 `probe-online-smoke` | **15 / 15 通过**（版本核对 = 本地 `20261102q`，SW 已接管） |
| 公库 Actions | **四个 check 全绿**：`test (22)` + `浏览器巡检 · iOS/安卓/电脑 四档`（run #42, `7672ac6`）。12 档真的在 CI 里跑过了 |
| 公库 | `7672ac6`（同步 `ae25ae4`） |
| 私库 | `ae25ae4`（`git ls-remote` 比对一致） |

---

## v129 · 让清单自己可信（版本 `20261102r` / sw `v129`，2026-11-06）

> 这一轮**没有新功能**。它修的不是代码，是「看代码的人会被文档骗」这件事。

### 一、开工时的现场：四份文档，四处说错

| 文档说 | 实际 |
|---|---|
| `BACKLOG.md` 开头：「线上版本 v108 / `npm test` 109 文件 4502 项」 | v128 / 145 文件 5630 项 —— **过期 21 个版本** |
| `PLAN.md`：「P2-3 房间态持久化 ⏳ 未做」 | v113 就落地了（`server/roomsState.js` + 23 项守卫） |
| `REVIEW.md`：「静默 catch 仍在约 50 处（C3 未做）」 | v127 已改完（21 处上报 + 47 项守卫） |
| `REVIEW.md` §4 的表格 | 第 5 行是 §1.2「社交粘性」那一行的残片 |

`release-progress.md` 里写着「版本现状的唯一权威」，而它自己停在 v121 —— **缺了 7 版**。

单看每一条都不严重。但它们的效果是叠加的：一份开头就说错话的清单，读的人会把后面
40 条一起打折。上一轮（v128）我在 N18 上就吃过这个亏 —— 按 BACKLOG 的描述判断
「探针已经修好了」，实际只修好了 8 个里的 2 个。

### 二、补上上报链路缺的那一跳（BACKLOG C11）

v127 让所有「catch 里只有安慰」的地方改成 `ErrorReport.capture`。两端都有断言：
前端证明「catch 会调 capture」，服务端证明「POST 进来会写日志」。
**中间那一跳没人守** —— 没有一条断言证明「页面 capture 一次 → 服务端日志里多一行」。

这正是 v121 那个 bug 的形状：每段单看都对，拼起来不工作，而且安静。

做法：journey `[9e]` 在真页面里 `capture('probe', 'journey-c11-<时间戳>')`，
然后轮询服务端 stdout 找那一行。两个细节是关键：

- **标记带时间戳**，所以捞到了只可能来自这一次，不用清日志、不怕轮转；
- **先断言 `capture` 返回 true**。它在会话上限（10 条）或去重命中时返回 `false`；
  只断言"日志里没有"的话，会把"这条被自己的节流丢了"误判成"通道断了"，修错地方。

**变异自证**（这是这条能算完成的唯一理由）：把服务端路由从 `/api/client-error` 改成
`/api/client-errorXX` 后重跑 ——

```
PASS  ★ ErrorReport 在页面里是全局可达的
PASS  ★ capture 可调用
PASS  ★ 计数表是活的
PASS  ★ 上报端点指向 /api/client-error      ← 客户端仍然是对的
PASS  ★ 端点带不带 sharecode，与页面 URL 一致
FAIL  ★ 页面 capture 一次 → 服务端日志里多出「[client-error] probe journey-c11-xxxx」
```

前 5 条照旧全绿，只有新那条红。**这道缝过去 8 个版本确实没有任何东西守着。**

### 三、37 个探针从「没人管」变成「有归属」

CI 里只跑 1 个探针（`probe-ui-flow`），其余 36 个的处境没人说得清：
谁还绿、谁已过期、谁只是一次性脚本。这就是 N18 那条挂了三年的债。

**先回答一个问题：要不要把它们全塞进 CI？答案是不要。**

| 理由 | 数字 |
|---|---|
| 大量重叠 | `probe-ui-flow` 已覆盖 12 视口 × 13 屏，`journey` 走完整条路径（158 项）；`probe-devices` / `probe-table` / `probe-room-actions` / `probe-landscape*` / `probe-type-scale` 量的是同一批东西 |
| 一次性脚本 | 19 条的文件头自己写着「一次性诊断脚本」 |
| 反馈时间 | 全量串行 **931 秒**。ui-probe 现在每片约 5 分钟；推到 20 分钟以上的后果不是更安全，是**没人看** |
| 测不准 | `probe-safearea`（`env(safe-area-inset)` 桌面恒为 0）、`probe-flex-gap`（旧内核）、`probe-viewport-fit`（PWA 全屏）在 CI 的 Linux + 桌面 Chrome 上恒为同一结果 |

所以真正的判据不是「进没进 CI」，而是**「有没有人知道它还绿不绿」**。
落地成三件东西：

1. **`scripts/probes.json`** —— 真源。每条：守什么 / 档位（`ci` `manual` `oneshot`）/ 为什么留 / 最近一次确认绿。
2. **`scripts/probes.js`** —— 校验 + 生成。六条规则，每条对着一个真实失效模式：
   新增探针没登记 / 幽灵条目 / 登记 `ci` 但 workflow 没真的执行它 / CI 在跑但台账没认 /
   `manual`·`oneshot` 没写 why / `run` 拼错一个词绕过前五条。
3. **`docs/PROBES.md`** —— 生成式。手改或改了台账忘重生成，`npm test` 都会红。

**这个守卫自己做了变异自证**：随手 `echo > scripts/probe-zzz-temp.js` 造一个未登记探针，
`[1]` 段立刻两条红（「真台账零错误 got 1 want 0」、「条数 got 37 want 38」）。

命名上还踩了一脚：第一版工具叫 `probe-ledger.js`，**被自己的扫描规则判成「未登记的新探针」**。
改成 `scripts/probes.js` 之后它天然不在 `probe-*` 命名空间里 —— 比给它开白名单干净。

### 四、第一次跑完全量探针：绿 28 / 红 7 / 超时 1

上次全量是 v108（36 个探针 25 绿 / 10 红），相隔 **21 个版本**。这次 37 条串行 931 秒：

| 探针 | 结果 | 根因 |
|---|---|---|
| `probe-emoji` | 0 / 2 | 进不了牌桌（建房还是按一步点） |
| `probe-rollback` | 16 / 6 | 同上，`建出房间 → null`，后面 5 条连带 |
| `probe-ten-hands` | 20 / 3 | 顶栏「已打 N/10 把」→「第 1/10 把」，结算说明也换了措辞 |
| `probe-handlimit-settle` | 19 / 4 | 同上 |
| `probe-records` | 19 / 1 | 数据没准备好：回放组 0/0 |
| `probe-records-cloud` | 51 / 1 | **假红**：读到 loading 态就断言空态文案 |
| `probe-first-paint` | 11 / 1 | **当场修好**，见下 |
| `probe-ui-flow` | 超时 | 本次参数 300s 不够（默认跑满 12 档约 13 分钟）；CI 分 3 片全绿 |

**根因只有两个**：v103 建房两步、结算/顶栏文案改口径。而 v110 修好的那 8 个里，
有 6 个又以同样的原因红了回去 —— **「修一次」不是解，进执行链才是。**

### 五、`probe-first-paint`：唯一一条需要改注释的

它有一条断言写着「读存储抛异常时**不挂** `.no-session`（按已登录兜底）」。
那是 v111 之前的事实。v111 把 16 个物理键收口进 `Store` 之后，`Store.read` **永不抛**
（读不出来返回 `null`），于是「读失败」与「没有会话」在 head 里不可区分 ——
两者都挂 `.no-session`、显示登录页。

新行为不比原来差：读不出 session 的人本来也进不去，直接给登录页好过「闪一下首页再被切走」。
真正要守的从来不是「按已登录处理」，而是**不白屏**（另一条断言一直在守）。

但 `index.html` 里那段注释没跟着改 —— **于是这条探针成了全仓库唯一还记得旧口径的地方，
而它已经两年没人跑了**。改的是探针与注释，不是产品行为。改完 12 项全绿。

### 六、顺手清掉一条早就不红的（N4）

N4 从 v81 之前一直开着：「首页安装引导在横屏最小一档只有 9.9 CSS px」。
实跑发现 `probe-safearea` **31 项全绿**，第 369 行那条 `≥ 11 CSS px` 在三个横屏档全过 ——
元素还在、规则还在（`.install-go { font-size: 28px }`）、断言也还在。
它被后来的字号下限顺手治好了，**只是没人回来关**。

一条没人复核的 open 条目，和一条没人跑的探针，是同一种病。

### 七、这一轮明确不做的四件事

| 不做 | 为什么 |
|---|---|
| 不把 36 个探针塞进 CI | 见 §3 的表格。判据是「有人知道它绿不绿」，台账回答这个 |
| 不批量修那 6 个红探针 | 5 条要改同一个前置。改完没有执行链证明它能跑，等于把 6 个红换成 6 个「不知道」 |
| 不给所有空 catch 加日志 | v127 已论证：一刀切的规矩没人守得住，守的是「只安慰不给证据」那一类 |
| 不在这一轮加功能 | 台账本身需要一轮稳定期；下一轮修红探针时才有基线判断「修完是不是真好了」 |

### 发布结果（v129）

| 项 | 结果 |
|---|---|
| 部署 | `https://your-app.app.workbuddy.host/?sharecode=REDACTED`（同一个应用，链接不变） |
| 线上冒烟 `probe-online-smoke` | **15 / 15**（版本核对 = 本地 `20261102r`，SW 已接管；直抓线上 `sw.js` 确认 `CACHE_NAME = v129`） |
| 全量 `npm test` | **145 文件 / 5630 条断言 / 0 失败**（新增 `probe-ledger.test.js` 30 项） |
| `journey` | **158 项 / 0 失败**（v128 是 156；新增 [9e] 两条） |
| `probe-ui-flow` | 竖 390×844 + 横 844×390，**2 视口 × 13 屏 ALL PASS** |
| 探针全量 | 37 条串行 931 秒：绿 28 / 红 7 / 超时 1（归因见上） |
| 玩家可感知的变化 | **没有**。唯一进入 `pwa/` 的是 `index.html` 里一段注释 |

> 为什么「没功能的版本」也要发：`index.html` 变了（哪怕只是注释），不 bump 缓存的话
> 线上跑的和仓库里的就是两份不同的文件 —— 那正是这一轮在治的病。发一次，
> 是为了让「线上 == 仓库」这句话继续成立。

---

## v131 · 复盘：整场合并，只在对局结束后给一次（版本 `20261102s` / sw `v130`，2026-11-07）

> 这一轮是 v130 的续：v130 修了「算错」，v131 修「什么时候算、算多久」。

### 一、先修的是错的，再改的是口径

v130 发现 `bestLine.netOf` 把对手**整手 6 张**塞进每一个组（单张组变成「我 1 张 vs 他 6 张」），
原因是 `best-line.test.js` 那条「交叉验证」**把被测函数抄了一遍**当期望值 —— 同一行表达式、
同一份整手夹具，两边用同一个错前提，恒绿。

修完之后的判据换成了真独立的：取 history 里「我实际用的分法」喂给 `netOf`，
净分必须等于**状态机结算时写下的 deltas**。变异自证：把 `.concat(theirs)` 改成 `.concat([])`，
这条立刻红（got 0 want 5），而旧的那条照样绿。

### 二、口径：整场合并 + 只在对局结束后

| 旧行为 | 新行为 |
|---|---|
| 每把结算都弹「这一把的理论最高」 | **只在对局结束时给一次**，判据是 `room.endReason`（只在整局收尾时被赋值） |
| 只算「最后一把」 | **整场合并**：逐把求最优与实得分，再各自求和 |

一局 10 把就播报 10 次同一性质的话，说到第 9 次只剩噪音；而且那行数字挂在「我」的名次旁边，
很容易被当成整局成绩。

### 三、为此动了数据留存（这是本轮真正的技术改动）

`room.history` 原来写死 `slice(-4)`（4 轮 = **2 把**）。整场复盘要覆盖全部把次，
所以改成按 `handLimit` 保留：一把两轮 + 两轮余量，最大档 30 把 → 62 条。

- 单条 2~4KB，一个房最大 200KB 左右；房间快照有 400ms 去抖与原子写，这个量级可以接受。
- 两条老测试钉的正是「只留 4 条」，按新契约更新（不是删掉，是改成断言「按 handLimit 算」）。

### 四、验证

| 项 | 结果 |
|---|---|
| `npm test` | **147 文件 / 5669 断言 / 0 失败**（best-line +8、接线 +4） |
| `probe-ten-hands`（真浏览器，打满 10 把） | **26 / 0** —— 新增两条：对局结束后 `.settle-recheck` 必须出现，且文案里是「整场」不是「这一把」 |
| `probe-ui-flow` | 竖 390×844 + 横 844×390，**2 视口 × 13 屏 ALL PASS** |
| 线上冒烟 | **15 / 15**；直抓 `sw.js` 确认 `CACHE_NAME = 'weile-liuxuanwu-v130'` |
| 玩家可感知的变化 | **有**：每把结算不再出现复盘行；对局结束出现一次「整场理论最高 X · 你拿了 Y」 |

### 五、顺带说清一件事

`ofMatch` 不是「拿整场历史重新枚举」，而是**逐把算再相加**。每一把的对手分法只在那把有效
（牌不同、人也可能换），跨把比较没有意义。有把没打完（中途解散 / 有人离开）时，
页面会补一句「有 N 把没打完，按已打的轮次算」—— 否则「整场」这个词在骗人。

---

## v131 修 · 两个跨局串味的 bug（版本 `20261102t` / sw `v131`，2026-11-07）

> 用户实测报的两个 bug，**同一个根因**：上一版我把 `history` 上限从「最近 2 把」提到「整场」，
> 但读它的两处代码还是「遍历整个 history」—— 于是它们从「最近 2 把」变成了「这个房间的所有局」。

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 连开 4 局后，战绩里点开第 3 局的回放，看到 **4 局 12 把** | `packHistory` / `renderReplay` 把整场档案里所有局都渲染出来 | 新增 `sameGameOnly(packs, target)`：按「你点的那一把属于哪一局」收窄；没给目标取最后一局。`openReplay` **先收窄再算标题**（否则标题仍写 4 局），`renderReplay` 再收窄一次当安全网 |
| 2 | 结算页显示「整场理论最高 +13 · 你拿了 **-3**」，同屏净胜是 **+10** | `ofMatch` 把前面几局的 deltas 一起加进来了（差的那 13 分正是它们） | 按 `seq`（本房间第几场）收窄，只算**刚结束的这一局**。seq 比 hid 稳：同一局的条目共用一个值 |

**为什么这两条直到现在才被发现**：它们是**上一版改动的副作用**，而上一版的验收只覆盖了
「一局之内」（`probe-ten-hands` 打满 10 把 = 一局；`npm test` 的 history 夹具是单局的）。
**「连开多局」这条路径没有任何自动化**——这一点记在 BACKLOG N18 的后续里。

### 验证

| 项 | 结果 |
|---|---|
| `npm test` | 147 文件 / **5669** 断言 / 0 失败（best-line +3：seq 不同的一律不参与） |
| 变异自证 | 去掉 `ofMatch` 的 seq 过滤 → 「只算最后那一局」立刻红（hands 2） |
| `probe-records` / `probe-ui-flow` | 20/0；竖横 2 视口 × 13 屏 ALL PASS |
| 线上冒烟 | **15/15**；直抓 `sw.js` 确认 `CACHE_NAME = 'weile-liuxuanwu-v131'` |

---

## v132 · 补上「连开多局」这条线（版本 `20261102u` / sw `v132`，2026-11-07）

> 上一版两个跨局串味的 bug 能一起漏到线上，根因不是"写错了"，是**这条路径没有自动化**：
> `probe-ten-hands` 只打一局，`npm test` 的 history 夹具也是单局。
> 这一轮不修功能，补的是**让那个错误下次能被自动抓住**。

### 一、把「按局收窄」从视图抽成纯函数

`sameGameOnly(packs, target)` 原来写在 `recordsView`（DOM 模块）里，只能靠肉眼验。
现在上移到 `historyKit` 并导出，`recordsView` 走 deps 注入 —— 于是它可以被单测钉住。

### 二、三层判据

| 层 | 判据 |
|---|---|
| **纯函数**（`replay-handno` +7） | 点第 2 局的把 → 只剩第 2 局；点第 1 局的 → 只剩第 1 局；没给目标 → 最后一局；单局原样；空数组不抛。**不写死把数**（history 有上限，第 1 把可能已被裁掉） |
| **数据层**（`best-line` +3） | `ofMatch` 按 `seq` 收窄：seq 不同的一律不参与，实得/最优都等于最后一局 |
| **真浏览器**（`probe-ten-hands` +2） | ① 对局结束后 `.settle-recheck` 出现且文案含「整场」；② ★ 复盘里的「你拿了」必须等于**我这一行**的净胜 |

第 ② 条就是用户报的那个数字（净胜 +10、复盘 −3）。它逼出一个坑：
取净胜时 `document.querySelector('.settle-net')` 拿到的是**第一名**那行，
第一次写就错成了「复盘=−21 净胜=21」，看着像符号反了，其实是拿错了行 —— 必须从复盘行的父节点往下找。

### 三、验证

`npm test` 147 文件 / **5676** 断言 / 0 失败；`probe-ten-hands` **28/0**；`probe-records` 20/0；
线上冒烟 **15/15**，直抓 `sw.js` = `v132`，页面版本 `20261102u`。

---

## v133 · 回放副标题与正文同源（版本 `20261102v` / sw `v133`，2026-11-07）

用户截图：正文只剩 3 把，右上角仍写「2 局 · 6 把」。

**原因**：上一版只在 `openReplay` 里「先收窄再算标题」，但**战绩页那条入口不经过 `openReplay`** ——
它自己 `setReplaySub(replaySubText(packs))` 之后才调 `renderReplay`，而安全网只收窄了正文。
标题与正文来自两个不同的数组，必然分叉。

**修法**：在 `renderReplay` 里按收窄后的 `packs` 重算副标题，且**只在真的收窄了才重算** ——
没缩窄时保留调用方写的那句（战绩页在老记录上写「只留下最后一把」，那是信息，不能被覆盖）。

**守卫**：`replay-handno` +2，断言「先 `lenBefore`、后重算」的顺序。
写这条时踩了一个坑：注释里也写着那行代码，`indexOf` 会命中注释里那次（更靠前），
断言恒红 —— 改用 `lastIndexOf`。

验收：`npm test` 147/147、**5678** 断言 0 失败；线上冒烟 15/15，`sw.js = v133`，页面 `20261102v`。

---

## v134 · 一条光规则：71 种阴影 → 3 档高度（版本 `20261102w` / sw `v134`，2026-11-07）

起点是 UI 审计量出来的一个数字：全站 **113 条 box-shadow 声明、83 种不同写法**。
每屏单独看都还行，串起来不像一个应用——本质不是审美问题，而是**没有语法**：
83 种阴影等于 83 个光源，玩家读不出"谁在谁上面"。

**做了什么**

| 层 | 之前 | 现在 |
|---|---|---|
| 内容卡 | 16 种手写投影 | `--elev-1` |
| 弹窗 | 3 种手写投影 | `--elev-2` / `--elev-3` |
| 纸的厚度 | 靠阴影假装 | `--edge-paper`（1px 极淡墨描边 + 顶部高光） |

- `:root` 新增 `--elev-1/2/3`、`--edge-hairline`、`--edge-top`、`--edge-paper`、`--elev-paper`；
  三档按"离桌面多高"分，不按"哪个屏"分，模糊半径 6 / 22 / 56 严格递增。
- 把 20 处外投影字面量映射到令牌（style 16 + records 3 + emoji 1），**现在手写外投影 == 0**。
- `.modal-box` 从"只有 --elev-3"改成 `var(--elev-3), var(--edge-paper)`：只靠投影是贴图，有边才有厚度。
- `#stage` 加一层极淡径向中心光（`radial-gradient(120% 90% at 50% 16%, …)`），零资源、零请求。
- `#stage` 加 `font-variant-numeric: tabular-nums`：一列分数不再随数字宽度左右跳。

**踩到的坑（写进守卫了）**：`--elev-1` 第一版写成了
`0 2px 6px rgba(0,0,0,.18), var(--elev-1)` —— **自引用**。
浏览器会把整条声明判为无效，元素等于完全没有阴影，但源码里看着"有写"。
这种错只有跑起来才看得见，源码评审 100% 漏掉，所以直接在测试里钉死。

**判据修正**：审计原写的"distinct box-shadow ≤ 4"是错的——它把内描边、状态环、
实体按钮下沿一起算了，而这些本来就是造型，必须按场景不同。改成两条：
1. **外投影字面量 == 0**（全部来自 `--elev-*`）；
2. distinct **只准减**，基线 83（想加新写法先找找能不能复用）。

**守卫**：新建 `pwa/test/design-tokens.test.js`，5 段 27 项，含分类器自测。
分类器第一版有 bug：`v.split(',')[0]` 被 `rgba(0,0,0,.34)` 里的逗号切碎，
把真投影判成"非投影"漏放；改成按括号深度切层，并补了一条回归断言。

**变异自证**（三条，全红后还原全绿）：
- 令牌改成自引用 → "不引用自己"红；
- 塞一条 `0 10px 30px rgba(0,0,0,.35)` → "外投影零字面量"红 + 种类 84 红；
- 精确去掉 `.modal-box` 的 `--edge-paper` → "弹窗带纸边"红。

验收：`npm test` 148/148、**5705** 断言 0 失败；`probe-ui-flow` 竖横两档 × 13 屏全绿
（软问题 40 条与上一版同源，全在 `.auth-tab` / `.btn-mini` 这类小按钮，未新增）；
线上冒烟 **15/15**，`sw.js = v134`，页面 `20261102w`。

---

## v135 · 交互节律：九个节拍器 → 三档（版本 `20261102x` / sw `v135`，2026-11-07）

B1 把"光"收成三档之后，量了同一件事的另一半：**动**。

起点数字：22 条 `transition` 用了 **9 种时长**（0.1 / 0.12 / 0.15 / 0.16 / 0.22 / 0.25 / 0.3 / 0.4 / 0.42s）、
**5 种缓动**。这不是节律，是九个节拍器——同一件事"点了有反应"，在五个按钮上要用五种速度。
玩家读不出快慢的差别，只读得出"说不上来哪里不对"。

**做了什么**

| 层 | 之前 | 现在 |
|---|---|---|
| 微反馈（按压 / 高亮） | 0.1 / 0.12s 混用 | `--dur-1` = 120ms |
| 状态切换（开关 / 展开 / 行变色） | 0.15 / 0.16 / 0.22 / 0.25s | `--dur-2` = 200ms |
| 入场（弹窗 / 卡片浮起 / 行滑入） | 0.3 / 0.32 / 0.34 / 0.4 / 0.42s | `--dur-3` = 320ms |
| 缓动 | 5 条（ease / ease-out / 3 条 bezier） | `--ease-std` / `--ease-emph` |
| 焦点环 | 11 条手写白名单 | 反向兜底：所有 `button` / `a[href]` / `[role=button]` / `[tabindex]` |

22 条 transition 全部改走令牌，**手写时长 0 条**。

**三处判断被实测推翻（先记账）**

1. **审计说"`prefers-reduced-motion` 只有 5 处，覆盖不全"——错的。**
   实测是 4 块，其中一块是 `* , *::before, *::after` 的全局兜底，带 `!important`，
   覆盖**本来就是 100%**。数块数不等于数覆盖：5 个块里 4 个是单点关闭，那 4 个之所以存在，
   是因为它们要保留语义（比如关掉抖动但保留静态偏移），不是因为兜底没写。
   这一条已写进审计文档的更正里。
2. **`emoji.css` 的 `focus-visible` 确实是 0，但根因不是"漏了几个"。**
   全站焦点环是一份**手写白名单**：11 条规则点了名的元素有环，没点名的
   （`.audio-toggle` / `.player-edit` / `.tr-skip` / `.modal-x` / `.install-x` / `.install-main` /
   `.guide-skip` / 整个 emoji.css）一个都没有。白名单的问题不是漏了几个，是**以后新加的按钮默认没有**。
   改成反向兜底后，新元素不用记得加。
3. **不能用 `:where()` 包兜底。** `:where()` 权重为 0，会被 `input { outline: none }`
   这类单元素/单类规则反盖回来——环被悄悄关掉，而且源码里"看着写了"。
   用「元素 + 伪类」= 权重 (0,1,1)：压得住单类规则，又低于 `.modal-box .btn:focus-visible`
   那种两段选择器，特殊样式仍然优先。

**顺手修的一处"断言钉住了实现细节"**

改时长时 `pattern-fx` 红了，它断言结算卡是 `transition: opacity 0.22s`，理由是
"和幕布淡出同一时长，交叉过渡"。这条断言把**具体数值**当成了不变量。
正确做法是两边都走 `var(--dur-2)`，断言改成"两边是同一个令牌"——
这样以后调整档位不会再红，而"两边不同步"仍然会被抓住。

**没做的，以及为什么**

| 审计里写了 | 结论 |
|---|---|
| 「>200ms 的入场要支持点击直达终态」 | **不做**。入场全部压到 ≤320ms 后，"来不及等"这个问题本身消失了。为 320ms 的动画加中断逻辑，复杂度换不到可感知的收益。表演类（特写 0.9~1.15s）本来就不能中断——那段的产物是"看"，不是"用" |
| 「按压态统一成 scale(0.97)」 | **不做**。实测 43 条 `:active` 是三种手势：实体按钮 `translateY`（因为它有下沿投影，按下就该塌）、卡片/图标 `scale`、行/列表换底色。这不是三种回执，是三种**物体**各自该有的反应；全改成一个手势反而会让"按钮"和"卡片"变成同一种东西 |
| 「焦点环补到按钮类 100%」 | **改为反向兜底**，见上 |

**守卫**

- `pwa/test/motion-tokens.test.js`（32 项）：三档递增、两条缓动不相等、分类器自测、
  真文件零裸时长、令牌引用完整性（写错名字 = 整条声明作废 = 所有按压没回执）、
  降级兜底与焦点兜底的形状。
- `scripts/probe-motion.js`（16 项，真浏览器 1280×720）：令牌解析成毫秒数、
  `.btn` 的实际 `transition-duration` 就是 120ms、Tab 走到的元素真的画出 3px + offset 的环、
  **按下 60ms 内 computed style 有变化且松开复原**、`prefers-reduced-motion` 下过渡与动画都塌到 1e-05s。
- 已登记进 `probes.json`（`ci` 档）并挂到 CI 的 journey job。

**变异自证（5 条，全红后还原全绿）**

1. `.btn` 改回手写 `0.2s` → 静态守卫红（裸时长）+ 探针红（200ms ≠ 120ms）；
2. `--dur-2` 改 999ms → 递增断言红；
3. 兜底块的 `*` 换成 `html` → 降级兜底 4 条一起红；
4. `button:focus-visible` 外层包 `:where()` → 焦点兜底红；
5. `records.css` 里写 `var(--dur-9)` → 引用完整性红 + 档位数变成 4。

验收：`npm test` **149/149** 文件、**5738** 断言 0 失败；`probe-ui-flow` 竖屏 + 桌面两档 × 13 屏 ALL PASS；
`probe-motion` 16/16；线上冒烟 **15/15**，`sw.js = v135`，页面 `20261102x`。

---

## v136 · 后悔权：清除战绩的前 5 秒（版本 `20261102y` / sw `v136`，2026-11-07）

B3 的第一块。选它先做，理由是**清除战绩是全站唯一不可恢复的玩家动作**：
点错一次，几十场记录没了。它原来的保护只有一层确认框 ——
而确认框防的是"手滑点错按钮"，防不了"我以为清的是这台设备、其实连云端一起清了"。

**实现与设计稿的差异（重要）**

设计稿写「执行 + 5 秒撤销」，做成了「5 秒后执行，期间可撤销」。
原因是**云端那一步没有逆操作**：`resetMyStats` 把服务器上的战绩清零，
没有任何接口能把它们写回去。所谓"撤销"只可能是本机假装恢复，排行榜上已经空了 ——
那种"撤销成功"比不提供撤销更坏。

延迟执行给的是同一个用户收益（我按错了，能收回），而且：
不需要快照与回滚、窗口期内数据**真的还在**、5 秒后不可恢复是天然的。

**三条规矩（每条都对应一次事故的形状，全部有断言）**

| 规矩 | 不这么做会怎样 |
|---|---|
| 同一时刻只允许一个待撤销动作，新的进来时旧的**立刻结账** | 用户点了清除，被下一件事顶掉，于是什么也没发生，而界面没有任何东西告诉他 |
| 页面转后台 / 关闭时**立即提交** | 他以为删了、关掉 App，回来发现还在（或者更糟：以为删了，其实一直没删） |
| 条子渲染不出来时**动作照做** | 旧缓存里的 HTML 没有 `#undo-bar`，清除就永远不执行，且零报错 |

**实现时踩到的真 bug（单测抓的）**

`undo()` 的第一句是 `pend = null`，紧接着调 `clearTimer()`，而 `clearTimer` 里读的正是 `pend` ——
读到 null，**计时器从来没被清掉**。表面看撤销是成功的（commit 拿不到 pend 就 return false），
但那个野计时器还在跑；等它到点，`commit()` 拿到的是**下一件事**的 pend，
于是 B 在它自己的 5 秒远没走完时就被执行了。玩家看到的是"我撤销了 A，结果 B 突然生效了"。
修法是把待办对象**传进去**（`stopTimer(p)`），而不是在函数里读全局。

**没有硬编码进 UI 的两个数值**

- 撤销窗口 5 秒：不是随手定的。低于 3 秒人在读文案时就已经过期；高于 8 秒会让人以为"它大概忘了"。
- 按钮 88 设计 px ≈ 46 CSS px：撤销是要在 5 秒内点中的按钮，比普通按钮更该够大 —— 点不中等于没有这个功能。

**守卫**

- `pwa/test/undo-bar.test.js`（43 项）：假 DOM + 假计时器，把三条规矩逐一打出来；
  含"撤销后旧计时器不能把下一件事提前结账"这条真 bug 的回归。
- `pwa/test/undo-wiring.test.js`（30 项）：证明**它真的被接上了**。因为组件有一条
  "拿不到就退回立刻清除"的兜底，接线断了不会报错，功能会静悄悄地没了 —— 所以必须单独守。
- `scripts/probe-undo.js`（19 项，真浏览器 390×844）：确认后**第 3 秒记录仍在**、
  点撤销后行数与存储都还原、不点则 5 秒后真的清空并切空态、条子与「返回」零重叠、隐藏时 `display:none`。
- 已登记进 `probes.json`（`ci` 档）并挂到 CI。

**变异自证**：把 `stopTimer(p)` 改回 `stopTimer(pend)` → 单测 4 条红，
其中一条正是"旧计时器到点把 B 提前结账"。

验收：`npm test` **151/151** 文件、**5814** 断言 0 失败；`probe-undo` 19/19；
线上冒烟 **15/15**，`sw.js = v136`，页面 `20261102y`（另确认 `/js/undoBar.js` 线上可取，200）。

**这一版还没做的（B3 剩余）**：四态（空/加载/失败/离线）可识别视觉、错误分三类、
离开房间的撤销（要走一遍"导航中被结账"的安全性复核）、数字三档层级、
「等人」对非房主可见、首局后的策略引导。

---

## v137 · 四态 + 错误三级：把"看着像坏了"分开（版本 `20261102z` / sw `v137`，2026-11-08）

B3 的第二块。这一批第一次走完整的分工：设计出规格（`design-states-v1.md`）、
QA 独立出判据（`qa-states-v1.md`）、制作人裁定后出施工单（`build-states-v1.md`）、
主程序施工、制作人逐张看图复核，**三轮才收**。

**起点**：全站只有一套骨架（空态那套）在兼职当"所有状态"，靠换一句标题区分"在等"和"没有"。
加载时玩家看到的是「正在读取战绩…」+ 一张写着 **0** 的卡片 + 一个**可点的「创建房间」**；
失败时看到的是空态标题 + 页脚一句没有下文的说明。

**做了什么**

| 项 | 之前 | 现在 |
|---|---|---|
| 加载 | 空态换文案（插画/CTA 全留着） | 独立 `#records-loading`：零按钮、44px 金环、250ms 门槛、>1s 换"比平时慢一点" |
| 失败 | 只有页脚一句，无出路 | 独立 `#records-fail`：两个按钮（再读一次 / 先开一局）；本机有数据时降级为页脚一行 + 行内出口 |
| 离线 | 寄生在 1.8 秒后自隐的 toast 上 | `#records-offline` 一快两形态：有内容→左对齐横条（内容照常看），无内容→独占；`online` 后 500ms 内自收 |
| 错误 | 同一类错四种说法，无分级 | `ERR` 11 个 key → 三级（可重试 / 不可恢复 / 静默）；不可恢复类**禁用「再试一次」**（负向正则） |
| 静默 | 说不清 | 定义成可执行的：**上报 ≥1 且页面文本逐字不变** |
| 状态真源 | 四个 `classList.toggle` 散在渲染里 | `recordsStateOf()` 纯函数 + `setRecordsState()` 唯一写者 + `data-rstate` |

**制作人复核抓到的 6 处（施工者自测全绿，但图上不对）**

| # | 问题 | 为什么守卫没抓到 |
|---|---|---|
| M1 | 离线时页脚还挂着「再读一次」 | 断言只查"失败态有重试"，没查"离线时不该邀请注定失败的动作" |
| M2 | 离线时页脚写"账号数据暂时读不到" | 结果是误报：离线是**没发**，不是读不到 |
| M3 | 加载/离线时右上角写 `0/35` | 用未知冒充零 —— 设计规格明令禁止，但没人断言这个数字 |
| M4 | "离线不藏内容"没有专门断言 | 靠 `offlineForm()` 自觉，退化成本极低 |
| F1 | panel 形态副文案是空承诺（"先把本机记录给你看"，而这一支恰恰本机 0 局） | 文案断言只比对了 strip 那一句 |
| F2 | 顶部横幅压住页标题「我的战绩」 | S17 只量"主控件 vs 页脚"，横幅是全站 fixed 层，不在统计里 |

**M4 逼出一个真 bug**：`base`（"假如有网是哪一态"）传的是 `loading`，而离线时 `loading` 恒 false
→ 得出结论"有网也是空" → **「本机 0 局 + 登录中 + 离线」本来会露出空态那张 0 分插画**。
真相是"没问过账号"。修法是独立 `wouldLoad`。

**两处我改判了上游文档**（都记进施工单，下一批要设计回改）
- R8：panel 形态允许有自己的副文案 —— 不能因为"一个块两形态共用一句"这条美学规则**说假话**。
- F2：战绩页可见时 `#net-banner` 让位（该屏已有 `#records-offline`，两句话不许重复）。
  这条**覆盖了 design ⑥-12 的前半句**，已标注；下一批必须让设计改口径，否则将来按 ⑥-12 复核会判不合格。

**守卫**：`states.test.js`（125 项，含 32 组手写真值表、11 key 唯一级别、禁用词分类器自测）、
`states-wiring.test.js`（109 项，守接线与载体签名）、`probe-states.js`（**85 项 × 2 档**真浏览器：
rAF 采样互斥、加载零按钮、重试网络层 +1 且只 +1、离线不寄生 toast、静默双断言、极值视口布局）。

**变异自证 10 条**（6 条主 + 2 条 fix1 + 2 条 fix2），全部「改坏→红→改回→绿」，其中两条是**恰好只红一条**的。
这些数字是主程序自报、我抽验了"只红一条"的两条并复核为真红。

验收：`npm test` **153/153** 文件、**6050** 断言 0 失败；`probe-states` 两档各 **85/85**；
`probe-ui-flow` 390×844 与 800×360 两档 × 13 屏 ALL PASS。

**线上**：冒烟 **15/15**，`sw.js = v137`，页面 `20261102z`，`/js/recordsState.js` 返回 200（新模块单独核过——
页面 200 不代表新模块 200，缺了它四态会静默退回旧行为）。

**这一版还没做的**（**v137 当时**）：数字三档层级（设计 §③ 已定稿，下一批单独发）、离开房间的撤销、
「等人」对非房主可见、首局后的策略引导。
> **回指（v138）**：本行的「数字三档层级」已由下一版 v138 完成，且**判据被改判**
> （阶梯封闭取代「一屏 ≤3 档」）。其余三项仍未做，进度以 `PLAN.md` §P8 为准。
> 保留这行原文是因为它是 v137 当时的真实欠账，不改成"已完成"以免伪造历史。

---

## v138 · 数：把六个字号收成一把梯子（版本 `20261108a` / sw `v138`，2026-11-08）

> 状态：**已发布**，`https://your-app.app.workbuddy.host/?sharecode=REDACTED`。
> 本段是「当前状态」卡片的详细版；工程裁定见 `build-numbers-v1.md`，现行设计规格见 `design-states-v2.md`。

**起点**：`design-states-v1.md` §③ 说「战绩页出现了 88/48/40/32/28/24 六个数字字号，
这不是三档，是六个节拍器」。我去真浏览器里量了三个屏，结论比那句话更具体：

| 屏 | 实测（390×844） | 问题 |
|---|---|---|
| 战绩 | 88 / 48 / **40** / 32 | 40 用在两处（纪录条 + 列表行净值），是同一个没进规范的"第四档" |
| 排行 | **40** / **28** | 两个都不在梯子上 |
| 成就 | **68** / **34** / **30** / 24 | 68 是「小屏反而更小」：`.ach-count b` 基础 84，`max-width:420` 压到 68、横屏压到 62 —— 而舞台已经按屏宽 `scale` 过一遍，再缩一次就是双重缩小。**390（主力机型）比 430 的字还小** |

**判据换了**：设计写「一屏 ≤3 档」，但它自己的映射表算出来就是四档（净胜 88 + 三卡 48 +
纪录条 32 + 场次 24）—— 规范和规范打架。改成**阶梯封闭**：数值元素只能 ∈ {88,48,32,24}，
单位 ∈ {28,20}。理由：`40 / 34 / 30 / 68` 的共同点不是"多了"，是**不在梯子上**，
判"在不在"挡得住将来新增的第五个，判"几个"挡不住。

**做**：六个 token（`--num-1..4` / `--num-u1` / `--num-u2`），数值字号全部改走令牌
（全站现存 **31** 处 `var(--num-*)`；提交信息里写的是 38，那是改动条数，
含后来被删掉的 4 条覆盖 —— 两个数都对，但别混着用）；
删掉 4 条「同类元素不该有」的覆盖（top3 净值、top3 名次、compact 榜单净值、compact 列表净值）；
删掉成就总数的两条媒体覆盖；横屏冠军净胜从 40 改回 48（同一屏冠军不该在更宽的屏幕上变小）。

**判据**：新建 `number-scale.test.js`（30 项，含分类器自测）+ `probe-numbers.js`
（真浏览器，39 项 × 390/320/360/430/375/800 六档）。

**变异自证 4 条**：
- 纪录条改回 40px → 探针红（阶梯外值）
- 媒体里恢复 `68px` → 静态守红 3 条 + 探针红（成就页 68）
- `.rp-unit` 改 24 → 探针红（单位不在 {28,20}）
- **给 top3 名次单独加 32px → 第一版探针没红**。因为 top3 的名次是奖牌 emoji（🥇🥈🥉），
  没有数字文本，按"文字像数字"采集的探针完全看不见它。补了「逐行量 `.rank-no` 格子」
  之后才红。**这条是这一轮最值钱的发现**：不是断言写错了，是断言看不见那一类元素。

验收：`npm test` **154/154** 文件、**6080** 断言 0 失败；`probe-numbers` 六档全绿
（390×844 / 320×568 / 360×640 / 375×667 / 430×932 / 800×360）；
`probe-ui-flow` 六档 × 13 屏 ALL PASS（390×844、800×360、360×640、430×932、844×390、1280×720）。

> 12 档全跑要 20 分钟以上，这一轮跑了 6 档：竖屏最小、竖屏主力、竖屏大、横屏手机、横屏小、桌面。
> 剩下的档位在发布后由 CI 补跑 —— **没跑过的档位不写进验收数字**。

**线上**：冒烟 **15/15**，`sw.js = v138`，页面 `20261108a`。
另外单独核了新 CSS 真的上去了：线上 `records.css` 里 18 处、`style.css` 里 13 处
`var(--num-*)`，合计 31，与本地一致；`--num-1: 88px` 在 `:root` 里。
（页面 200 不代表样式表 200 —— 少了它，数字会静默退回旧字号，而那看起来"只是有点不对"。）

---

## 下一批（待发布）· 后悔权收口 / 策略引导 / 320 验证债（2026-11-09）

**状态**：本地全绿，**未发版、未 bump**；线上仍是 `20261108a` / sw `v138`。
发布时统一升版本号，并按固定五步链路走（文档检查 → 验收 → 推私库 → 推公库 → 发布 → 回填）。

**做了什么**（裁定口径见 `build-next-batch-v1.md` R1–R18）：
- **① 离开房间撤销**：`leaveRoom` / `cleanupRoom` / `showScreen` 三步整体搬进 `undoBar.show().onCommit`
  （延迟 5 秒、导航一并延后）；`attachRoom` 订阅回调的单一守卫 P1–P4 命中即 `flush('room-changed')`
  立即提交，闭合「导航中被结账」。**不改服务端、不加协议字段**（R1 / R2）。
- **②「等人」判 A 销项**：两份独立复核都证实两屏对非房主本就可见「房主在等人 + 还剩多久」，
  加控件属重复设计；只做结算页 HOLD 文案口径对齐一行字（R3）。
- **③ 策略引导**：首次进结算页、按设备一次、独立存储键；参数终值唯一出处 `design-next-batch-v1.md §4.2`。
  短竖屏放不下整句 → **不显示、也不会烧掉「已看过」额度**（R11，短路在写键之前，不采用省略号）。
- **④ 320×568 验证债闭环**：`probe-numbers.js` 独立 `collectGeometry()`；`probe-ui-flow` VIEWPORTS 加 320 档；
  `test.yml` 四步同改（独立分片 / 半角 `320x568` / 自检按分片期望数 / 新增 `probe-numbers 320 568` step）；
  `number-scale.test.js` + `ci-matrix.test.js` 补静态守（R5）。

**两条只有看实际渲染帧才发现的问题**：
- **R17**：`#undo-bar` 是 `#stage` 的直接子元素，三条 `#screen-*/.undo-bar` 分屏 CSS 规则**从未匹配过**，
  改 176→300 当然没效果；删死规则、统一锚点后 390 / 320 两帧都不再压主按钮。
  与 v136「接线断了不报错」、v138「emoji 名次格子看不见」同族：**不是数值错，是规则没命中那一类元素**。
- **R18**：320 全流程巡检 `FAILED 2 项`（`auth-link` 热区 29.4 < 30，临界 0.6px，非本批引入），
  而 R5 新挂的 CI 分片跑的正是它 → 不修就恒红。padding 20→22px、负 margin 同步，视觉零变化、不改判据。

**验收**：`npm test` **156 文件 / 6261 断言 / 0 失败**；`npm run docs:check` 39/39；
`npm run probes:check` 41 条；`probe-undo` 390 / 320 两档各 **38/38**；
`probe-numbers` 320 / 390 / 800 三档**全绿**；`ONLY='320x568' probe-ui-flow` **ALL PASS 1 视口 × 13 屏 / EXIT 0**；
变异自证 M1 / M5 / M6 / M7 实跑（M8 列为验证债）。
**未做**：真人试玩、线上冒烟（本批未发版）；自动化帧与断言不能替代。

**四条验证债**（逐条在 `BACKLOG.md`）：三屏几何断言 / 320 策略行完整可读 / M8 / 真人试玩。

---

## v139（2026-11-09）· 三条验证债清零 + 两处真缺陷

**状态**：已发布。线上 `20261109a` / sw `v139`。

**做了什么**（裁定口径见 `build-next-batch-v1.md` R19–R21）：
- **N-1 三屏几何断言**：`probe-undo.js` 新增 `[8]` 房间 / `[9]` 对局 / `[10]` 结算，各量一条
  「撤销条 ∩ 主控件」rect 交集面积（期望 0），并先断言「量的确实是那一屏」。
- **N-2 320 策略行**：R11「短竖屏不显示」改判为「允许换行、整句照给」（R20）；
  静态守卫从 `white-space: nowrap` 改为 `normal` + `text-overflow: clip`，并加负向断言「不再出现 ellipsis」。
- **N-3 工具自验**：新建 `tools/qa/geometry-selftest.js`（`npm run qa:geom`），6 组已知答案样本 +
  两个几何采集器的合规自验；M8 变异（改成 `ownText()/NUM.test()` 按文本采集）实跑 → 拒绝下结论、退出码 1。
- **CI**：新增「几何判定工具自验」step 与「撤销条 · 320×568」step（N-1 / N-2 两处缺陷都是窄屏专有的）。

**两处真缺陷（都是机检抓到的，不是看帧看出来的）**：
- **结算屏锚点**：`bottom:300` 让条子压住 `#btn-next` **8031px²**；改写成固定 `481px` 后又压住
  `#settle-wait` **2332px²**（390）、「改把数」那排（320）。根因是等待行高度随文案与宽度变 →
  改为 `game.js` 的 `anchorLeaveBarOnSettle()` 按真实矩形现算（R19）。
- **对局屏无空档**：该屏从上到下没有 62px 空档，条子必然遮住手牌上沿（390 **21029px²** / 320 **12667px²**）。
  不静默放过：硬判据只压「动作条按钮 + 牌位的牌」，被遮面积**逐档量出来打印**，理由与数值记入设计 §10.3。

**两处假绿（差点被当成通过）**：
- `probe-undo` 原来跑 `?mode=local`，而「补 AI」只在 ws 模式出现 → 凑不够 `MIN_PLAYERS=2`，
  **对局屏根本进不去**，上一步量到的其实是就绪态那一排（R21）。
- 切到真实服务后，页内 spy 钩子不存在，`window.__leaveSpy.calls = 0` 当场抛 `TypeError`，
  整段 IIFE 挂掉、点击一次都没发生 —— 而「没有条子」被算成 0×0 交集，三条断言全绿。

**验收**：`npm test` **156 文件 / 6263 断言 / 0 失败**；`npm run docs:check` 39/39；
`npm run probes:check` 41 条；`npm run qa:geom` 10/10；
`node scripts/probe-undo.js` 390×844 **65/65**、320×568 **65/65**；
线上冒烟：`node scripts/probe-online-smoke.js "https://your-app.app.workbuddy.host/?sharecode=…"` **15/15 通过**
（版本回读 `20261109a`、JS 异常 0、console.error 0、HTTP≥400 0、manifest 带码 200、SW 已接管）。

**未做**：真人试玩（`BACKLOG.md` N-4，只能人在真机上走，脚本已写好）。

---

### 后台功能增量 · 模拟对战与排行榜（v139 期间，**没有 bump 客户端版本**）

**为什么单独记一段、为什么不发新版**：这次只动了服务端（`server/*.js`）与管理页（`pwa/admin.html`），
没有改任何进 Service Worker 预缓存的客户端文件。`admin.html` 本身走 `no-store`，部署完就是新的。
所以**刻意不 bump** `20261109a` / sw `v139` —— bump 只会让每个已安装的用户白下载一遍全部资源，
而他们拿到的字节和现在完全一样。「线上 == 仓库」这句话这次靠服务端补丁成立，不靠缓存失效。

**做了什么**

后台从「只有用户管理」扩成三个页签：

| 页签 | 能力 |
|---|---|
| 用户管理 | 原有（改昵称 / 重置密码 / 停用 / 删除），行为未变 |
| 模拟对战 | 勾选 2～5 个真实账号 → 定「对战场数」「每场局数（3/5/10/15/30）」「节奏」→ 开始/停止；实时进度条（场 x/y、把 x/y、当前阶段、房间号）+ 逐场明细 + 逐把流水 + **榜单增量** |
| 排行榜 | 全量名次（不止 top50），按净胜倒序，带场次 / 胜 / 胜率 |

**四个设计决定，都有具体理由**

1. **任务跑在服务端进程内，连环回地址。** 不绕部署网关（省一次 sharecode 校验），
   但**协议完全一样**：`/ws` + `auth` 帧 + `createRoom` / `submitGroups`。
   所以后台跑出来的数据和真人、和命令行脚本同源 —— 这一点有硬证据：每场零和、`aiGames: 0`。
2. **密码只在内存里，绝不落盘。** `job` 对象只存账号名；密码在 `_run()` 的局部变量里用完即弃。
   `bot-jobs.json` 是长期保留的历史文件，密码写进去就等于明文库存。
   页面上密码也只放内存变量 `pwMap`，**不进 sessionStorage** —— 后台密钥都只存 session，
   账号密码更不该在设备上多留一份（刷新要重填是刻意的取舍）。
3. **同一时刻只允许一个任务。** 两个并行会互相污染排行榜基线（A 算「场次涨了几」时 B 也在涨）。
   第二个请求返回 **409 并带回正在跑的 id**，页面据此高亮，而不是让人去猜哪里填错了。
4. **协议客户端抽成一份**（`server/botClient.js`）。命令行脚本改成薄封装。
   如果复制一份进服务端，协议一改就会「命令行还绿、后台已经坏」，那是这个仓库反复踩过的双实现漂移。

**做的时候踩到的三个坑（都是自查抓出来的）**

- **账号字段名不一致**：任务描述里叫 `account`，协议客户端要 `name` → 登录时账号是空串。
  错误被任务状态接住了（进程没崩），但属于必须修的一类。
- **摘要里把 `playerId` 剥掉了**：`baseline`/`after` 按 `playerId` 索引，剥掉后页面所有增量都显示 `0→0`，
  而榜单其实在涨 —— 看着像「没落库」，实际是接口少给了一个字段。
- **增量在任务进行中就渲染**：`after` 快照是收尾才取的，跑的过程中会显示「场次 3→0」，看着像掉分。
  改为「结束才算增量」。

**验收**

- `npm test` **157 文件 / 6309 断言 / 0 失败**（新增 `server/test/bot-runner.test.js` 28 项、`admin.test.js` 45 项）
- `npm run probes:check` **42 条**；`npm run docs:check` 39/39
- 新增探针 `scripts/probe-admin.js`（`manual` 档）：真起服务端 + 真开无头浏览器，点完整个流程
  **19/19 通过**，含「控制台零异常」「榜单增量 0→2」「逐把流水 6 条」
- 本地实例手工核对：并发 409、停止 2 秒内生效并落成 `cancelled`、重启后 running → `interrupted`、
  `bot-jobs.json` 里搜不到密码、每场三人净胜相加 = 0

**未做**：真人试玩（`BACKLOG.md` N-4）仍然只欠人；这轮是「谁能重复地造数据」，不是「打得好不好玩」。

---

### 后台功能上线 · 管理密钥更换（2026-11-09 发布，**未 bump 客户端版本**）

**发布了什么**：只发服务端（`server/*.js`）与 `pwa/admin.html`，没有碰任何进 SW 预缓存的资源。
所以 `20261109a` / sw `v139` 保持不变 —— 发布后 `health` 回读仍是 `20261109a`，
而 `uptime` 归零证明进程确实换过了（不是打到旧实例上）。

**管理密钥按需求换成 8 位口令**。读取优先级没变：`BACKUP_KEY` 环境变量 → `server/backup-key.txt`。
线上没有设环境变量（旧 64 字符密钥能过、错密钥 403，对照成立），所以改文件即生效。

- 旧密钥备份在本机 `.workbuddy/admin-key-backup-2026-11-09.txt`（该目录已 gitignore，不入库）
- **新口令本身不写进本文件**：这里是公开仓库。真实值只在密钥文件与本机备份里
- ⚠️ 这是**安全强度上的降级**：64 字符随机串 → 8 位可猜口令。目前唯一的额外缓冲是网关那道
  sharecode（实测：不带码访问 `/api/admin/*` 与 `/admin.html` 都是 403）。要恢复强密钥，
  把备份覆盖回 `server/backup-key.txt` 再发一次即可，不需要改代码

**发布后核对**

| 项 | 结果 |
|---|---|
| `health.version` | `20261109a`，`uptime` 15 秒（进程已重启） |
| 新密钥 → `/api/admin/users`、`/admin/leaderboard`、`/admin/bot/jobs` | 全部 200 |
| 旧 64 字符密钥 → `/api/admin/users` | 403（确实换掉了，不是并存两把） |
| 不带 sharecode → `/api/admin/users`、`/admin.html` | 403（网关仍在最前面挡着） |
| 线上冒烟 `probe-online-smoke` | **15/15** |
| 真浏览器登录线上后台 | **12/12**（用户表 16 个账号、玩家池载入、排行榜 8 人、控制台零异常） |

**反向自证**：同一套浏览器断言把密钥换成错误值再跑一次 → **8 条全红**
（报「无权访问：缺少或错误的 x-backup-key」）。少做这一步，「状态栏没报错」很可能是个
永远为真的空断言 —— 这是这个仓库反复踩过的假绿。

**一个已知副作用**：密钥换了之后，浏览器 `sessionStorage` 里存的旧密钥会失效，
打开后台会看到「无权访问」，重填一次即可（页面本来就设计了「清掉本页密钥」）。

---

### 后台模拟对战 · 四条反馈的修复 + 机器人学会挑牌（2026-11-09 已发布 · 未 bump 客户端版本）

四条反馈里，前三条是后台页面的真 bug，第四条是**打法问题而不是发牌问题**。
第四条先用数据定性，再动代码，顺序不能反 —— 否则很容易把「我的机器人不会打牌」
误判成「服务端发牌有偏」，然后去改一个本来没错的东西。

#### 一、密码要能记住（原来是每次都要重输）

`pwa/admin.html` 改成：管理密钥存 `localStorage`（`lxw_admin_key_v2`），
账号密码也存本机（`lxw_admin_pw_v1`），并在玩家池加了一行 **「在本机记住密码」** 开关
与 **「清除已存」** 按钮。

- 只存**载入成功之后**的密钥：密码输错时不落盘，否则下次打开还是错的
- 关掉开关 / 点「清除已存」会立刻删掉本机那一份，同时清空输入框
- 兼容旧版：旧键存在 `sessionStorage` 的 `lxw_admin_key`，读一次做迁移，升级不丢登录态
- 代价写在页面上：明文存在这台设备的浏览器里。换设备或公用电脑请点「清除已存」

> 顺带说明为什么这不是「顺手加的」：`pwa/test/admin.test.js` 里原本有一条
> 「整页不用 localStorage」的硬契约，是**上一轮刻意立的**。这次按需求反向调整了契约，
> 但保留四条底线：必须有开关、必须有清除出口、不写 sessionStorage、不进控制台。

#### 二、跑完一次必须刷新才能再跑（真 bug）

根因：`#btn-bot-start` 的启用只发生在 `updatePoolCount()` 里，而那个函数只在
「渲染玩家池 / 勾选变化」时被调用。任务一结束，按钮就永久停在 `disabled`，
用户只能按 F5 —— 而 F5 会重走 `renderPool → updatePoolCount`，所以「刷新就好了」。

修法：`renderJob()` 里判定 `!running` 时调一次 `updatePoolCount()`。
跑的过程中**不碰**它，否则等于允许并发起第二个任务（服务端会 409，但体验更差）。

#### 三、逐把流水条数对不上 + 下拉自己合上（两个 bug 叠在一起）

1. **条数落后**：详情接口只在「切任务」和「任务结束」时拉过一次，跑到第 8 把时
   流水还停在第 6 把的快照。修法：轮询期间隔一次（约 3 秒）拉一次详情；
   标题同时写「N 条 / 已完成 M 把」，条数与进度不一致时**直接把原因写在标题里**
   （上限 800 条裁剪、或刚结算还没进下一条），不留悬念。
2. **下拉自己合上**：流水原先渲染在 `#job-view` 内部，而摘要每 1.5 秒整块
   `innerHTML` 重绘 `<details>` 就没了，展开状态随之丢失。
   修法：流水挪到独立容器 `#job-hands`；重绘时**复用同一个 `<details>`**，
   把 `open` 状态在重绘前后搬回去。

#### 四、「大牌少、小牌多」——是机器人不会打牌，不是发牌有偏

拿仓库里真实的 `engine.js` / `ai.js` / `card.js` 做了一个对照实验
（`node scripts/analyze-bot-split.js 60000`）：

**发牌公平**：6 万把 × 3 人 × 6 张 = 108 万张，53 个牌种的频次卡方 37.03。
判据不能按 df=52 看（那是错的，见下面「判法错误」），而是用**同一统计量测标准随机洗牌**
量出零分布：34.17 ± 6.88 → 偏离 **0.41σ**，不可区分。
三个座位的平均牌力 7.16 / 7.16 / 7.15，「大牌（单张 ≥Q）」占比 16.99% / 16.98% / 16.99%。
座位偏置用 8 次重复实验判：|t|max = 1.06 → 在噪声内。

**差距全在拆牌**（同一批牌，各 6 万手）：

| 指标 | 按位置拆（原实现） | 穷举最优（AI） |
|---|---|---|
| 十点半爆点率 | **31.1%** | **0.5%** |
| 十点半正好 10.5 | 4.6% | 34.7% |
| 第二轮「有牛」 | 70.0% | 89.9% |
| 第二轮「牛牛」 | **13.3%** | **39.7%** |
| 单张对随机牌的胜率 | 49.9% | 71.2% |

三人桌实测（6000 把）：全机器人桌三座位净胜在噪声内互有胜负（零和成立）；
**1 个 AI + 2 个机器人**时，AI 座位净胜 **+45878**，两个机器人 **−22689 / −23189**。

**结论**：机器人的 6 张牌和真人一样是随机发的，但它是把牌「按位置」塞进三组：
第 1 张去单张、第 2–3 张去十点半、第 4–6 张去飘三叶、第二轮用第 2–6 张打斗牛。
于是三组里有两组在系统性自废 —— 十点半随机会拿到爆点、斗牛没有把「最该丢的那张」丢给单张。
真人（和单机的 AI）会在这 60 种分法里挑最优，所以**牌型分布、赢率全面高于机器人**。

**改造**：`server/botClient.js` 的 `submitRound` 改为调用 `pwa/js/ai.js` 的
`decideRound1/decideRound2`（默认 `strategy: 'smart'`）。原来的按位置拆保留为
`strategy: 'naive'`，在后台「打法」下拉里可选，作为对照组复现这个差距。
**不另写一套选牌逻辑**：另写就是又造一份「什么算好牌」的定义，改规则时必然漂移。

> 判法错误（自查发现并修掉）：第一版按 `df = 52` 判，把卡方 27.7 读成「偏离 2σ，有偏置」。
> 但这个统计量不是多项分布：每把从 53 张里取 18 张是**无放回**的，单张牌频次方差只有
> 泊松假设的 `1 − 18/53 ≈ 0.66`，零假设下的期望 χ² 只有约 34，不是 52。
> 正确的做法是用同一个统计量去量一把已知均匀的洗牌，先得到零分布再比 —— 改完后结论是 0.41σ。
> 差一点就发出一句「发牌有偏」的错误结论。

#### 验证

- `npm test` **158 文件 / 6328 断言 / 0 失败**（新增 `server/test/bot-split.test.js` 11 项；
  `admin.test.js` 45 → 53 项）
- `probe-admin.js` **29/29**（原 19 项），新增的断言直接对应四条反馈：
  「流水条数 == 已完成把数」「刷新后展开状态还在」「任务结束后开始按钮恢复可用」
  「不刷新就能起第二个任务并正常停下」「刷新后密钥与密码自动回填」「取消勾选后本机密码被清掉」
- `docs:check` 39/39；`probes:check` 42 条
- **没有 bump 客户端版本**：只动了 `server/*` 与 `pwa/admin.html`，后者不在 SW 预缓存里且走 `no-store`

**未做**：真人试玩（`BACKLOG.md` N-4）仍然只欠人。这轮修的是「模拟数据像不像真人」，
不是「真人对局手感如何」。

#### 发布后核对（2026-11-09）

- 私库提交 `552c4e2`，公库同步 `848d621`（敏感检查通过）
- 线上 `probe-online-smoke` **15/15**：版本回读 `20261109a`、无 JS 异常、
  无 HTTP≥400、SW 已接管
- 后台页面直取线上 200 / 51248 字节，五个新标记全部命中
  （`pw-remember`、`bot-strategy`、`job-hands`、`lxw_admin_pw_v1`、`updatePoolCount`）——
  证明线上跑的就是这轮代码，不是缓存里的旧页
- 服务端随部署重启一次，当时进行中的房间作废；档案与榜单未受影响

> 榜单口径提醒：`strategy: 'smart'` 上线后，机器人战绩与此前 14 场（按位置拆牌）
> **不可直接相比**。要看「机器人是否还吃亏」，请以这轮之后新产生的场次为准。

### 后台逐把流水第二轮：按场分组 / 不跳回顶部 / 累计净胜单起一条（2026-11-10 已发布 · 未 bump 客户端版本）

三条反馈都不是「功能缺失」，是「有了但不好用」：数据齐全，摆法不对。
但第三条查下去发现**数据本身也是错的**，不只是列名问题。

#### 一、流水按场分组

原来是一张平表：`场 | 把 | ...`，15 场 × 15 把全摊在一起，跑完就是 225 行，
既看不出哪一把属于哪一场，也看不出某一场打到第几把。

现在每场一个 `<details>`，标题写「第 3 场 · [进行中] · 7/15 把 · 打满把数结束」，
里面只装自己那几把。默认只展开「正在打的那一场」和「最后一场」——十几场全展开
会让页面拉成一列长条，用户还得自己一个个点掉。另加「全部展开 / 全部收起」。

#### 二、每完成一局都被顶回第一条

根因不是「顺序反了」，是**整块重建**：`det.innerHTML = ...` 把表格换掉，
滚动容器的 `scrollTop` 跟着归零。数据越跑越多，这个动作每 3 秒发生一次。

修法（两条一起做才有用）：

- **节点复用**：每场的面板建一次，之后只改内容，`<details>` 和滚动容器都是同一个；
- **搬回位置**：重绘前记下 `scrollTop`，重绘后写回去；用户本来就贴着底部时
  直接跟到新的底部（跟着最新一把走）。

还加了一个开关：**用户自己往上滚就停跟随，滚回底部自动恢复**。
没有这个开关，任何「保持位置」的做法都会在用户翻到第 3 把时把他拽到第 15 把 ——
那是另一种骚扰。停跟随时右下角出现「↓ 最新」按钮。

#### 三、「累计净胜」这列：不只是列名错了

查下去发现 `botClient.js` 的 `snapshot()` 上报的是 `player.score`，而那是
**打完这一把之后的累计值**。所以原来那一列虽然叫「累计净胜」，装的是累计快照；
用户要求「应该展示每局的详情」是对的 —— 但这个数据**根本拿不出来**，
除非相邻两行相减，而历史上限（800 条）一裁掉中间某行就会静默偏掉一个常数。

改法分两层：

- **服务端补 `delta`**：在 `botRunner` 里算出「这一把本身赢输多少」并随流水存下。
  算的位置很关键 —— 此刻「上一把的累计」是确定已知的，不依赖任何裁剪。
  **每场必须重置 `prevSnap`**：每场分数都从 0 重发，跨场沿用会把上一场终局分
  当成本场起点（`bot-hand-delta.test.js` 里有一条专门复现这个坑）。
- **页面**：表头改「本把盈亏」用 `delta`；累计净胜单起一条钉在表格上方，不随滚动跑掉。
  累计值直接用权威数（打完的场次用 `rooms[i].scores`，进行中的用**最后一把的 score**），
  不做逐行累加。

> 顺带把结束原因从 `handLimit` 翻成人话（「打满把数结束」），文案照抄战绩页
> `recordsView.js` 的 `END_REASON_TEXT`。后台是独立页面不加载那个模块，所以这是一份
> 有意为之的副本，改文案时两边一起改。

#### 验证

- `npm test` **159 文件 / 6346 断言 / 0 失败**（新增 `bot-hand-delta.test.js` 12 项；
  `admin.test.js` 53 → 59 项）
- `probe-admin.js` **51/51**（原 41 项）。新增断言里值得点名的几条：
  - 两场各自一个面板、面板按场次顺序、每面板只装自己那 3 把
  - **累计净胜 == 该场逐把之和**（打完的场次走服务端合计，这条一红就说明两套口径打架）
  - 跑到一半时「进行中」那一场就已经有逐把明细和累计值（不等打完）
  - 把可视高度压到 40px 制造滚动条（复现 15 把撑满的处境），然后：
    翻到中间 → 重绘后位置不变；贴到底部 → 重绘后仍在底部（旧版这里会变成 0）
  - 正数红、负数绿（读 `getComputedStyle`，验的是「涨红跌绿」这个约定，不是某个色值）
- `docs:check` 39/39；`probes:check` 42 条
- **没有 bump 客户端版本**：只动 `server/*` 与 `pwa/admin.html`，后者不在 SW 预缓存里且走 `no-store`

**未做**：真人试玩（`BACKLOG.md` N-4）。

#### 发布后核对（2026-11-10）

- 私库 `1c64445`，公库 `762b913`（敏感检查通过）
- 线上 `probe-online-smoke` **15/15**；版本回读 `20261109a`；`/admin.html` **200 / 62346 B**
  （上一版 51248 B），`Cache-Control: no-store`，四个新标记全部命中
  （`room-hands`、`hands-sum`、`本把盈亏`、`ui.stick`）—— 线上跑的就是这一版
- **档案未被回退**：发布前后各取一次榜单，8 人上榜、前四名场次与净胜完全一致
  （will 83/453、示例丙 80/159、示例玩家甲 100/112、holin 50/−2）
- 服务端随部署重启一次，进行中的房间与模拟任务作废；档案、榜单、账号未受影响

> **发布前补做的一件事**：`server/data/profiles.json` 是容器重建时的**种子**，
> 而它当时还停在 10-30 的 8 人快照，线上已经是 16 人。按 `profile.js` 的说明
> （「发布前跑 backup-leaderboard.js 把线上榜单写进种子」）先刷新了种子再发布：
> 16 位玩家、16 位带登录凭据。不补这一步，容器一旦重建，11-09 之后的战绩会静默回退。
> 主数据文件在 `~/.lxw-appdata/profiles.json`（项目外）且「存在即权威」，所以这次发布
> 本身不会动线上数据——种子只在重建时用得上。

> 发布期间把 `.workbuddy/admin-key-backup-2026-11-09.txt`（旧管理密钥备份）临时移出了
> 项目目录，避免它被打进上传包；发布完已还原。现役密钥 `server/backup-key.txt` 必须随包
> 上传（服务端靠它鉴权），它本来就在包里，不是本轮新增暴露。

### 成就系统口径纠错：三条「把级」改「场级」+ 目录守卫（2026-11-11，**未发布**）

这轮不是加功能，是**修一个存在很久的口径错误**。起点是用户的一句质疑：
「全操总场次都没 271 和 234 次，为什么这两个成就是 271 和 234」。

#### 一、根因：成就统计混了三个层级

系统里同时存在三种粒度，但文案全程用「把」指代「场」：

| 层级 | 含义 | 统计位置 |
|---|---|---|
| 轮 | 一把里的第一轮（3 组）或第二轮（2 组） | `achievements.accumulate()` |
| 把 | 一次发牌 → 选牌 → 结算 | `achievements.accumulateHand()` |
| 场 | 一个房间从进房打到结算 | `profile.record()` |

「你咋这幸 / 我咋这霉 / 一夜暴富」三条写在 `accumulateHand` 里，是**每把**判一次。
全操打了 235 场、4031 把，r9 记了 277 次 —— 数字本身没错（277/4031 = 6.9%），
错的是玩家按「场」去读，而 277 > 235，怎么算都对不上。

#### 二、改法：三条全部移到场级

`accumulateHand` 已废弃为空操作（保留导出，因为状态机仍在每把调用）。

三条判定移到 `profile.record()`，由 `hub` 在结算时算好全场正/负分人数传进来：

- `r9` 你咋这幸：这一场只有我一个人正分
- `r10` 我咋这霉：这一场只有我一个人负分
- `r12` 一夜暴富：这一场净胜 **> 100**（严格大于；旧判据 `net*2 >= sumNeg` 在零和计分下独赢时恒成立，等于免费成就）

**关键实现细节**：场级判定必须放在 `if (run)` **外面**。`run` 是这一局的把级桶，
一局里没人拿牌型时它是 `null`；写在里面会让那一场静默漏记，且毫无痕迹。
`server/test/achievements-room-level.test.js` 里有一条断言专门钉住这件事。

#### 三、顺带修正的 9 条文案

`第一次 / 势不可挡 / 十连胜 / 背到极点 / 衰神附体 / 一夜暴富 / 翻身农奴 / 你咋这幸 / 我咋这霉`
的说明里「把」全部改成「场」。其中「翻身农奴」的逻辑**本来就是场级**
（`loseBefore` 取的是场级连败，`n` 是这一场的净胜），只是注释和文案写错了，无需改代码。

#### 四、新增目录守卫（改版前提）

`pwa/test/achievements-catalog.test.js` 断言：

- CATALOG 里 `cur` 读的每个键，`evaluate` 的 `ctx` 必须提供
- 牌型成就读的短键必须在 `TYPE_KEY_KNOWN` 里
- 从 ach 桶读的计数器必须登记在 `COUNT_KEYS` 里

**为什么必须**：`mergeInto` 是白名单合并，认不到的键**静默丢弃**。
新增成就时漏登记一处，那条成就永远是 0、测试全绿、线上无异常。
原先只有一份「v112 点名的七个字段」的人肉清单，覆盖面不随 CATALOG 长大。

守卫的键集合**从源码正则提取**，不引用运行时导出——用导出值当期望，
等于拿被测对象证明自己没错。

#### 五、验证

- `npm test` **161 文件 / 6337 断言 / 0 失败**
- 新增 `achievements-room-level.test.js` 19 项、`achievements-catalog.test.js` 9 项
- `achievements-v112.test.js` 的「整把三条」一节改写为口径迁移断言（53 → 44 项）
- **红→绿反向验证**（均实测）：
  - 把 `n > 100` 改成 `n >= 100` → 边界断言变红
  - 把场级判定移进 `if (run)` → 「无把级桶也要记」变红
  - 从 `ctx` 删掉 `smv` → 守卫变红（报了 3 次，因为三条成就读它）
  - 从 `COUNT_KEYS` 删掉 `smv` → 守卫变红

#### 六、未做

- **线上 r9 / r10 / r12 尚未清零**。口径换了，旧值留在整场口径下会自相矛盾
  （全操 r9=277 > 场次 235），必须归零重记，等发布时一并执行。
- 分层档位、`need=1` 门槛、稀有度重标定、扩展新成就 —— 均未开始。

### 2026-11-11 · 成就系统第 3 批：比率型成就重做（已发布 `20261111a` / sw `v140`）

> 承接上一段（第 1–2 批口径纠错）。这一段只改「对撞胜率」这一类判定的口径与展示，
> 不动数据、不改存储。

#### 一、分层方案被否决，换成「比率 + 样本量」

原计划给 17 条「参与即得」的成就加 ★/★★/★★★ 三档。项目所有者否决：

> 分层我有问题……那后续如果大家都玩了几百场甚至上千场，上万场，那这个问题不还是存在吗

判断成立。**次数是有限量，加档位只是把天花板抬高三档，不是拆掉天花板。**

新结论一句话：**区分度不能来自「次数」，只能来自「比率」。**
次数是绝对量，愿意打就一定涨；比率是相对量，样本越多越贴近真实水平。
这是全目录里**唯一「越玩越难」**的机制。

#### 二、阈值

| 项 | 原来 | 现在 |
|---|---|---|
| 正向（遇强则强 / 矮子里拔将军） | 胜率 ≥ 50% | 胜率 ≥ **46%** |
| 反向（外强中干 / 矬子里垫底） | 胜率 < 50% | 胜率 < **34%** |
| 大牌样本门槛 | 10 次 | **100 次**（`VS_MIN`） |
| 小牌样本门槛 | 5 次 | **30 次**（`SM_MIN`） |

**为什么 50% 必须换掉**：对撞是 N 人对赌，必然 1 赢 N−1 输，个人胜率上限 = 1/N。
线上实测 9599 次对撞、平均 2.38 人 → 上限 42.1%，全局胜率 42.06%。
50% 不是「难」，是**数学上不可达** —— 旧口径下正向 0/9、反向 9/9，等于没判。

**为什么留真空区**：34%~46% 两条都不亮。略高于均值不是本事，略低于均值也不算倒霉；
硬要给徽章，就是又发了一枚「参与即得」。上一版「≥50% / <50% 互补」会让中间那批人
必然归到某一边，等于人人有份。

**为什么小牌门槛只有 30**：线上小牌对撞总量只有 783 次（9 人合计），
头部 236~252，一半玩家不到 20 次。同样用 100 会把 6/9 的人直接挡在门外。
统计上 30 次样本下 46% 门槛对应约 6.5% 达成率，已经足够筛掉运气。

#### 三、卡片显示分四类

| 类 | 写法 |
|---|---|
| 进度条（6 条） | `7 / 10` |
| 牌型 | `3 次 · 出现率 50.0%` |
| 对撞胜率（样本够） | `胜率 46.0% · 对撞 100 次` |
| 对撞胜率（样本不够） | `对撞 37 / 100 次 · 胜率 70.3%` |
| 次数型 | `已达成 · 累计 277 次` / `还差 6 次` / `未达成` |

核心改动是最后一行：**「已达成」必须写在数字前面**。
以前只写「277 次」，玩家会把它读成**进度**，于是问「我打了两百多场，这个成就怎么是 277」。
次数本身没错，错在它长得像进度条上的数字。

对撞卡在样本不够时仍然写出胜率，是为了让人看见「我撞得挺准，只是还没撞够」——
藏起来只会让人以为系统不判。

#### 四、实测效果（线上 9 份有效档案重算）

平均解锁 **27.22 / 35 = 77.8%**（原 81.6%），区间 24~30，极差 **6**（原 5）。
四条比率成就从「正向 0/9 + 反向 9/9」的死判，变成 **2 / 0 / 0 / 2**。

**如实说明**：77.8% 说明区分度问题主要**不在**这一批。剩下 31 条次数型成就
仍然人人都有 —— 那是第 4 批（抬门槛）和第 5 批（扩新）的活，
而且抬门槛本身也只是推迟饱和，不是解决。

#### 五、验证

- `npm test` **164 文件 / 6857 断言 / 0 失败**（第 2 批时 6337。跳得多有两层原因：
  一是五个测试文件的汇总格式写错、一直没被计入的 458 条断言重新计上了，见下节；
  二是本批新增 `event-log` / `ach-replay` 两个测试文件与两段扩展）
- `docs:check` 39/39
- **红→绿反向验证**（均实测）：
  - `RATE_FWD` 0.46 → 0.50 ⇒ 边界断言变红
  - `VS_MIN` 100 → 10 ⇒ 样本门槛断言变红
- 新增断言：真空区两条都不亮、边界 46% 归正向、边界 34% 归真空区、
  `已达成 · 累计 N 次` / `还差 N 次` / `对撞 N / M 次 · 胜率 x%` 三种卡片文案

#### 六、未做

- 线上 r9 / r10 / r12 仍未清零（承接上一段，等发布时一并执行）
- 第 4 批：抬 `need=1` 门槛、稀有度重标定、清理 id 交叉与 `r8`
- 第 5 批：扩新（只做稀缺组合型）
- **成就原始观测仍未落盘** —— 这是「改口径无法重算历史」的根因，
  方案见 `achievements-review-2026-11-11.md` 第十节，等基线处理方式拍板
  → **已在下一节处理完毕**（P1=A 冻结基线 + 增量 / P2 永久 / P3 全做）

---

### 2026-11-11 · 事件日志 + 重放器：让「改口径」不再受历史数据限制（已发布 `20261111a` / sw `v140`）

> 承接上一节末尾那条「成就原始观测仍未落盘」。这一段是**基础设施**，
> 不改任何一条成就的判定，也不改任何玩家看得见的数字。

#### 一、问题是什么

第 3 批改胜率阈值时暴露出来的不是一个 bug，是一堵墙：

> 每次需要去优化成就时，因为历史成就没有保存在云上，导致每次优化后如果涉及重新计算，
> 都会因为找不到数据导致历史数据无法翻转。

档案里的 `ach` 是**聚合计数器**：`t.lp = 242`。它回答「拿了 242 次豹子」，
但永远回答不了「哪一把、第几轮、同桌还有谁」。
聚合是**不可逆**的 —— 这不是实现偷懒，是当初用「计数器」建模的必然结果。

后果有两个层次：

- 浅层：第 3 批那种「只改阈值」的重算还能靠旧计数器勉强做（`vs / vsn` 比值不变）；
  一旦改成「每组计一次」→「每把计一次」，旧数据直接作废。
- 深层：**口径永远只能往「能靠现有计数器算出来」的方向改**。数据反过来绑住了设计。

顺带挖出一个藏了两年的实例：`全操 235 场，却有 277 次「你咋这幸」（全场唯一正分）` ——
一条要求「全场只有我一个人正分」的成就，次数比场次还多。

#### 二、拍板

| 点 | 选项 | 结论 |
|---|---|---|
| P1 起点怎么办 | A. 冻结基线 + 增量 / B. 从零重记 | **A**。老数据不清零，冻一份快照当起点 |
| P2 事件留多久 | 永久 / 滚动窗口 | **永久**。277 B/把，一年量级 10 MB，没有删的理由 |
| P3 做多少 | 只存 / 存 + 重放器 + 备份 | **都做** |

公式：`当前值 = 基线(冻结快照) + fold(基线之后的所有事件)`。
fold 用的是**当前这版** `pwa/js/achievements.js`，所以改口径 = 改 fold + 重放一遍。

#### 三、两种事件（存原始观测，不存判定结果）

| 类型 | 时机 | 内容 |
|---|---|---|
| `k:'g'` 轮级 | 每轮结算 | 该轮所有组、赢家、**每人牌型原文**（`"10.5"` / `"爆点"`，不是映射后的短键） |
| `k:'s'` 场级 | 每场结算 | 全场每人净胜，**含 AI**（`bot:1`） |

```json
{"k":"g","v":1,"r":"529580","h":42,"rd":1,"t":1794383790856,
 "g":[["tenhalf","p1",[["p1","10.5"],["p2","爆点"]]]]}
{"k":"s","v":1,"r":"529580","h":42,"t":1794383790856,
 "p":[["p1",24,0],["bot_x",-13,1]]}
```

**为什么存原文不存判定结果**：一旦存了「谁是唯一正分」，这套日志就只对**当前版本**的口径
有效，改一次口径要再改一次日志格式，等于没解决。存净胜和牌型原文，判定逻辑全在 fold 里。

**为什么场级必须带 AI**：`posCount` / `negCount` 是拿**全场所有人**算的，AI 也占一个名额。
少存一个 bot，「你咋这幸」的重放结果就和线上对不上 —— 而重放器的第一职责就是**和线上对得上**。

**为什么两种都要**：轮级能重算所有计数型（牌型 / 对撞 / 通吃），但算不出「这一场全场几正几负」；
场级反过来。只存一种都会漏。

#### 四、四个坑（都是实测撞出来的）

**1. 不能拿 `ach` 自己当基线。** 它既被 `record()` 持续写入，又被当成起点，会双重计数。
所以另存一份 `p.achBase`（`counts` 深拷贝 + `currentStreak`）。
`currentStreak` 必须存 —— r7「连败后赢一把」是**有状态**判定，光看事件算不出来。

**2. 桶边界 = 结算事件。** 线上 `room.achRun` 的生命周期就是一场（`_persistSettlement` 之后置 null）。
重放时必须照抄：遇场级事件就把这一场的 `_r1` 冲掉。
否则 `_r1`（「三组全赢」）会跨场泄漏，多算「五子登科」。

**3. 同一毫秒的排序。** 最后一轮和结算的 `t` 经常一模一样。按 `Number(e.rd || 0)` 排，
场级事件没有 `rd` 就是 0，会排到**所有轮之前** —— 结算先于最后一轮，那一轮被算进下一场。
修法是给场级固定 99：

```js
function roundRank(e) { return (e && e.k === 'g') ? (Number(e.rd) || 1) : 99; }
```

**4. 写日志绝不能影响结算。** append 全程 try/catch，失败返回 false 就算了。
日志是「以后能不能重算」的问题，结算是「这一局分对不对」的问题，后者永远优先。

#### 五、顺带发现：断言总账少算了 458 条

做这一批时新加了 `event-log` / `ach-replay` 两个测试文件，加起来 87 条断言，
但总账只涨了 17。

查下去发现五个文件的汇总行写成了「**N 项通过**」，而 `parseCounts` 的正则是
「通过 N 项，失败 M 项」—— 这五个文件各自的几十条断言在总账里一直是 **0**：

`achievements-wiring` / `achievements` / `best-line` / `tiebreak` / `achievements-record`

改格式后总账 6337 → 6795（+458）。这一批收尾时是 **164 文件 / 6857 断言**。
同时给 `scripts/run-tests.js` 加了一道**零断言守卫**：

```js
const noCount = r.status === 0 && c.pass === 0 && c.fail === 0;
const bad = timedOut || r.status !== 0 || c.fail > 0 || noCount;
```

退出码 0、零通过、零失败 —— 这不是「全绿」，这是「一条都没数到」。
红→绿验证：故意把 `tiebreak.test.js` 的汇总行改回去，立刻报「一条断言都没数到」。

#### 六、新增的东西

| 文件 | 是什么 |
|---|---|
| `server/eventLog.js`（约 330 行） | append-only JSONL，按月分片 `events/YYYY-MM.jsonl`，`readAll({after,dedupe})` |
| `server/achReplay.js`（约 210 行） | 纯函数、无 IO：`replay(events,{baseByPid})` → `{byPid,rounds,settles,cutoff,warns}` |
| `scripts/ach-baseline.js` | 冻基线，默认预演，`--apply` 才写；幂等 |
| `scripts/replay-achievements.js` | 重放，默认只打 diff，`--apply` 写回；`--player` / `--json` |
| `/api/backup/events?since=N` | 增量导出，鉴权同 `full=1`；未启用时回 `{ok:false}` 而不是空数组 |
| `scripts/backup-leaderboard.js` | 种子白名单补 `ach` / `achBase`；新增 `syncEvents()` 按 `maxT-1` 增量拉（回退一格防同毫秒丢事件） |
| `SM.setRoundSettledHook(fn)` | 模块级钩子。`stateMachine.js` 浏览器也跑，不能 `require('fs')` |

`backup-leaderboard` 里那个「未启用回 `ok:false`」特意没做成空数组：

> 脚本拿到空数组会以为「线上就这么多」，然后照常把备份标记成成功。

#### 七、顺序（写进脚本注释了）

```
先发布（打开事件日志） → 基线在服务启动那一刻自动冻
```

**顺序的理由和直觉相反：基线越晚越安全。** 重放器会把 `t <= 基线时刻` 的事件全部跳过
（那些已经算进基线 counts 里了），所以「基线晚于第一条事件」只是重复一段、不会双计；
真正危险的只有反过来 —— 基线早于日志，那段时间打的牌既不在基线、也没有事件，重放会抹掉一段。

这条不只写在文档里，是**在 `server/index.js` 里自动做的**：

```js
if (on) {
  const frozen = profiles.stampAchBase(Date.now());
  if (frozen) log('[eventLog] 成就基线冻结 ' + frozen + ' 份（已有基线的跳过）');
}
```

为什么必须自动：线上是容器部署，**没有远程 shell**，`scripts/ach-baseline.js` 要在真实档案上
跑才有意义。而基线缺失时重放器会跳过这些人（宁可不动，也不是从 0 算起），
于是整套基础设施对真实玩家等于**不存在**，还没有任何症状。
「做好了但没接上」比做错更难发现 —— 这类东西不能靠运维记得去跑一个脚本。

#### 八、验证

- `npm test` **164 文件 / 6857 断言 / 0 失败**
- 新增 `server/test/event-log.test.js`（39 项）：默认关闭 / 落盘 / 去重 / 空轮不记 /
  同毫秒排序 / AI 进场级事件 / 写失败不抛 / **接线守卫**（生产入口真的调了 `stampAchBase`、
  且发生在打开日志之后 —— 这一行被删掉，功能会安静地死，线上没有任何症状）
- 新增 `server/test/ach-replay.test.js`（53 项）：牌型归属 / 对撞 / 场级三条 / AI 占名额 /
  严格大于 100 / r7 看更新前 streak / 基线之前不算 / `_r1` 不跨场 / 空基线不重放 / 坏数据不崩
- `achievements-e2e.test.js` 补 `[7]` 段（+14）：真跑一局 → 读事件 → 重放 → 断言
  `rrA.t.th === liveA.t.th`；反向验证「只留场级事件时计数塌成 0」
- `backup-roundtrip.test.js` 补 6 项：`ach` / `achBase` 过备份；反向验证「种子不带 ach → 恢复后归零」
- 体积实测：约 6 把/场、**277 B/把**，当前全量 1.6 MB，一年约 9.5 MB

#### 九、没做的事（诚实记账）

- **历史事件追不回来**。基线之前的那些场次永远只有聚合值，改口径时这部分不会翻转。
  「从今天起可重算」是这次能做到的全部。
- 线上 r9 / r10 / r12 仍需在发布时清零重记（承接前面几节）→ **工具见下一小节，已随本批上线**
- 重放器不做「自动修复」。diff 只打给人看，写回必须显式 `--apply`。

#### 十、把 r9 / r10 / r12 的死数字清掉

这三条是**判据写错**留下的死数字（实例：全操 235 场、801 次「你咋这幸」，
而那条要求「全场只有我一个人正分」）。项目所有者拍板：**清零重记**。

工具链三件，缺一不可：

| 件 | 作用 |
|---|---|
| `profiles.resetAchKeys(keys, {dryRun})` | 数据层：同时清 `ach` 与 `achBase.counts` |
| `POST /api/admin/ach-reset` | 接口层：`x-backup-key` 鉴权，**默认 dryRun**，必须显式 `"dryRun": false` |
| `npm run ach:reset -- --keys r9,r10,r12` | 运维脚本：先预演打原值，`--apply` 才真清 |

**为什么必须清基线那一份**：重放是「基线 + fold(基线后的事件)」。
只清 `ach`，下次重放会把基线里的 801 再叠回来 —— 现象是「修了没用」，且没有任何报错。
所以数据层里两处一起动，回执里 `cells` 与 `baseCells` **分开记账**。

**为什么只清白名单**：`vs` / `vsn` / `t.*` 是比率的**分母**。清掉分母，
出现率和胜率一起变成 0/0，那条成就不再是「错」，而是「没了」——
那是删数据，不是修正。白名单 `r7 / r8 / r9 / r10 / r12` 写在 `profile.js` 顶部。

**为什么是定点清而不是「拉备份 → 改 → restore 推回」**：`restore` 是整份覆盖，
拉取到推送之间任何人打的牌都会被冲掉。这条只动指定计数器，别的一个字节不碰。

新增 `server/test/ach-reset.test.js`（31 项）：鉴权 / 空 keys / 全在白名单外 / 默认预演
一格不动 / `ach` 与基线一起归零 / 分母原样 / 幂等 / 没有基线的老档案也要清掉 `ach`。
**红→绿实测**：把「清基线」那几行去掉 → 立刻 2 红（`基线里的 r9 也 → 0`）。

> 界限仍然要说清：清的只是**基线里那一份错数**。基线之前的历史只有聚合值，
> 那些数字修不了 —— 所以这次清完，三条成就从 0 重新开始长，且从此可重算。

#### 十一、发布后核对（2026-11-11 实跑）

| 项 | 结果 |
|---|---|
| 版本 | 线上 `20261111a` / sw `v140`（浏览器回读，与本地一致） |
| 线上冒烟 | **15/15**：无 JS 异常 / 无 console.error / 无 HTTP≥400 / SW 已接管 / installability 0 错 / manifest 与图标都带码 |
| 事件日志 | `/api/backup/events?since=0` 回 `{ok:true, count:0}` —— 已启用，还没有人打牌 |
| 基线 | **18/18 份档案都冻上了**，时刻**同一个** `2026-11-11T13:06:11Z`（服务启动那一刻，不是人工跑的） |
| 备份 | 18 位玩家 → `~/.lxw-appdata/seed/profiles.json`；事件镜像 0 条（同上，还没人打牌） |
| r9/r10/r12 | 清零 **9 份档案 / 27 格 + 基线 27 格**；复核预演回「0 份 / 0 格」 |

预演打出来的原值（这是那条 bug 的真身）：

| 玩家 | r9 | r10 | r12 |
|---|---:|---:|---:|
| 全操（235 场） | 271 | 234 | **777** |
| 另一位 | 277 | 148 | **801** |
| …共 9 人 | 32~190 | 14~173 | 236~623 |

一个只打了 235 场的人，「全场只有我一个人正分」记了 777 次 ——
**次数比场次还多**，这就是「聚合计数器 + 判据写错」叠在一起的样子。

> 顺手记一笔运维坑：`backup-leaderboard.js` 在本机找不到密钥时会**新生成一把**，
> 然后拿它去调线上，得到 403，提示语却在猜「线上是不是没带密钥发布」。
> 真实原因是「本机生成了一把线上不认的钥匙」。这次已把线上那把（`server/backup-key.txt`）
> 复制到 `~/.lxw-appdata/backup-key.txt`，两条脚本从此读同一处。

#### 十二、发布过程中抓到的真 bug：基线只活在内存里

第一次发布后核对时发现一件事：**两次发布间隔 9 分钟，18 份档案的基线时刻整体后移了 9 分钟**
（`13:06:11Z` → `13:15:21Z`）。

原因：`stampAchBase()` 只写了 `this.dirty = true`，**没有排队落盘**。
服务刚启动、还没人开局时，除了这次冻结之外没有任何写操作会顺带把 dirty 刷下去 ——
于是基线只活在内存里。一重启，磁盘上没有 `achBase`，启动逻辑再冻一次，时刻变成新的。

**为什么这比「数字算错」更阴**：

- 数据不算错 —— 重放器会跳过 `t <= cutoff` 的事件，所以不会双计；
- 但 `cutoff` 跟着往后跑，于是「重启之前的历史」永远落在 cutoff 之前，**永远重算不了**。
- 功能看着在跑，实际每次都只剩最后一小段可算。没有任何报错，也没有任何症状。

修法：`stampAchBase` 与 `resetAchKeys` 都改成 `{ dirty = true; _scheduleFlush(); }` ——
和这个文件里其他每一个写操作一样。

新增断言 `ach-reset.test.js [7]`（9 项）：写一份**字段给全**的档案（少了 `aiRecent` 之类，
加载时 `_ensureDerived` 会顺带排一次 flush，就验不到基线自己那一下）→ `stampAchBase` →
**不调 `flush()`** 直接等 700ms 去读磁盘 → 基线必须在；再开一个 `ProfileStore` 读回同一份文件
→ 时刻不变、`stampAchBase` 返回 0（幂等）。红→绿实测：去掉 `_scheduleFlush()` → 立刻红。

线上验证（第 3、4 次重启）：基线时刻 `2026-11-11T13:20:03Z` **不再变化**。

---

### 2026-11-11 · 成就第 4 + 5 批：抬门槛 / 重标稀有度 / 清 id 交叉 / 扩新

> 承接第 3 批（比率型）与事件日志。这一段第一次**用实测数据**改标签与门槛，
> 不再靠感觉。目录 35 → 39 条。

#### 一、先修一个自己埋的雷：清零其实没落盘

上一段写「r9/r10/r12 已清零」，复核时发现**数字又回来了**（`r12` 仍是 777）。

原因和第 12 小节那个 bug 同宗：`resetAchKeys` 只置 `dirty`、没排队落盘。
清零那一刻改的是内存，而当时线上跑的还是没有 `_scheduleFlush()` 的版本 ——
响应返回了「已清零」，磁盘上什么都没变，重启一次就原样回来。

**这次的教训不是「又漏了一个 flush」，而是「回执不能当证据」**：
`--apply` 打印了「已清零 9 份 / 27 格」并不代表落盘成功。
现在改成：清完**重启一次**，再用预演回读 —— 回 0 才算数。
重做后 18 份档案的 `r9/r10/r12` 与基线全部为 0，且基线时刻未变（`13:20:03Z`）。

#### 二、第 4 批：抬门槛（对称成对抬）

| 成就 | 原 | 现 | 为什么 |
|---|---:|---:|---|
| 硬茬子 / 软脚虾 | 1 | **3** | 实测 9/10 的人第一把就有 |
| 宁为鸡头 / 鸡飞蛋打 | 1 | **3** | 同上 |
| 一巡清场 / 一巡散场 | 1 | **3** | 同上 |
| 双杀 / 双赔 | 1 | **3** | 同上 |
| 五子登科 / 五子皆输 | 1 | **3** | 打着 legend 却 8/10 都有 |
| 炸得干脆 / 一手散珠 / 无牛可牵 | 1 | **5** | 小牌型是最常见的那一档 |

**为什么成对抬**：只抬赢的一侧，等于用门槛表达「赢比输金贵」——
而这套成就的前提就是输赢对称。抬完之后两侧仍然是同一把尺子。

代价（要如实说）：**打完第一把从「亮 5~6 条」变成「只亮 1 条」**（只有「第一次」）。
这是有意的 —— 以前那 5 条不是成就，是注册礼包。e2e 里把这一条钉死了：
`解锁数 === 1，而且是 first`。

#### 三、第 4 批：稀有度按实测定，不再拍脑袋

新增 `scripts/ach-unlock-stats.js`：把线上档案喂给 `evaluate()`，逐条统计**解锁人数**
（只看打过牌的人，空账号会让分母虚胖），并对照期望区间报「标签与实测不符」。

分档（写死在脚本顶部，改它等于改刻度）：

| 标签 | 实测解锁率 |
|---|---|
| legend | ≤ 20% |
| epic | 21 ~ 50% |
| rare | 51 ~ 80% |
| normal | ≥ 81% |

标定前后（10 位打过牌的人）：平均解锁 **77.8% → 56.7%**，解锁数区间 20~29（极差 9，
上一批是 5~6）；含「只打了 3 场」的那位则是 1~29（极差 28）。

★ 一次标定就暴露出真问题：**18 条落到 normal**（≥81% 的人都有）。
标签现在没撒谎，但它说明的是「门槛本身还不够」，不是「标签不灵」。
真正的解法只有继续加可遇性低的条件 —— 也就是第 5 批的方向。

#### 四、第 4 批：id 不再冒充计数键，r8 删掉

旧目录最坑的一处：id 长成 `rN`，看着就是计数键，实际**四处交叉**：

| 旧 id | 名字 | 实际读的键 |
|---|---|---|
| `r9` | 一夜暴富 | `r12` |
| `r10` | 翻身农奴 | `r7` |
| `r11` | 你咋这幸 | `r9` |
| `r12` | 我咋这霉 | `r10` |

现在 id 全部改成语义名（`windfall` / `comeback` / `luckyonly` / `unluckyonly` /
`first` / `regular` / `veteran` / `streak5` … `clearr1` / `loseall` …），
并且每条成就**必须声明** `countKey`（读桶里的计数器）或 `statKey`（读档案实时值）。

守卫（`achievements-catalog.test.js`，9 → 17 项）：
- 每条必须声明其中一个，且不能两个都声明；
- **声明的键必须与 `cur` 实际读的键一致**（`id / 声明 / 实现` 三者走偏就红）；
- id 不许与计数键 / 实时字段同名；
- `r8`（人间清醒，v112 就删了）不许再出现在任何非注释位置。

红→绿实测：把 `windfall` 的 `countKey` 改成 `r9` → 立刻红；把 `r8` 塞回 `COUNT_KEYS` → 立刻红。

#### 五、第 5 批：扩新（只做稀缺的），并顺手修掉一个「两人局白送」

| 新增 | 判定 | 现状 |
|---|---|---|
| 熟面孔 | games ≥ 50 | 9/10（填掉 10→100 的 90 场空窗） |
| 铁人 | games ≥ 200 | 1/10 |
| 十五连胜 | streak ≥ 15 | 0/10（连现有的十连胜也 0/10） |
| 单场之王 | bestNet ≥ 150 | 0/10（线上最高 142） |

`bestNet` 这个字段从有成就系统那天起就没人用过，现在用上了。
为什么不设 100：`一夜暴富` 已经是「一场净胜 >100 的**次数**」，100 再用一次是同一件事换个名字。

**顺手修的**：`你咋这幸`（全场只有我一个人正分）在**两人局**里等于「我赢了」——
零和计分下赢的那方天然是唯一正分，所以线上 235 场记了 777 次。
现在要求 `playerCount ≥ 3`（含 AI，与 posCount 同口径），`我咋这霉` 同理。
`record()` 与 `achReplay` 两处同时改，`hub` 把 `playerCount` 传进 meta；
漏传时 `Number(undefined)=0` → 不记（宁少不错），这条也有断言钉住。

> 为什么现在改而不是以后：这两条刚清零、还没有历史包袱。
> 晚一天改，就多一天「按旧口径记下来、以后要重放」的数据。

#### 六、验证

- `npm test`：**164 文件 / 6874 断言 / 0 失败**（新增：catalog 守卫 +8、record 人数门槛 +5、replay 三人局 +3）
- `docs:check` 39/39
- 红→绿：`countKey` 写错 / `r8` 复活 / 去掉 `_scheduleFlush` / 去掉「清基线」全部实测变红
- 实测：平均解锁 77.8% → 56.7%；第一把只亮 1 条（e2e 钉死）

#### 七、没做的事

- **18 条 normal 仍然是「人人都有」**。抬门槛只是推迟饱和，不是解决 ——
  这条从第 3 批就写在这里，第 5 批扩新也只是加了 4 个高位台阶。
- 成就页没有按稀有度排序 / 分组，39 条平铺；玩家看不出「哪条难」。

#### 八、发布后核对（20261111b / sw v141）

| 项 | 结果 | 怎么复算 |
|---|---|---|
| 线上版本 | `20261111b`，冒烟回读一致 | `node scripts/probe-online-smoke.js <url>` |
| 线上冒烟 | **15/15** | 同上 |
| 档案数 | **18 人未变**（全操 235 场 / holin 130 / sam 129 …），未被种子回退 | `node scripts/backup-leaderboard.js <url>` |
| 基线时刻 | **18/18 仍是 `2026-11-11T13:20:03.772Z`** —— 这次重启**没有**移动它 | 同上，读 `achBase.at` |
| r9/r10/r12 | `ach` 与 `achBase.counts` 两侧都是 **0** | `npm run ach:reset -- --keys r9,r10,r12`（预演 `cells: 0`） |
| 事件日志 | `ok:true`、`count: 0` —— 开着，只是这 20 分钟没人开局 | `curl .../api/backup/events?since=0` |
| `r8` 老字段 | 仍在桶里（`r8: 0`），没有主动清 —— 清了没收益，留着不占地方 | 备份里的 `ach` |

**`count: 0` 差点被误读成「日志没开」**。判据在代码里：未启用时 `EventLog.isEnabled()`
为假，接口回的是 `ok: false` + 明确错误文案（故意不回空数组，否则脚本会以为
「线上就这么多」）。所以看到 `ok: true` 就代表日志确实开着，`count: 0` 只代表没有新事件。

**这次最该确认的就是「基线时刻没动」**：上一版漏了 `_scheduleFlush()`，
两次发布间隔 9 分钟，18 份基线整体后移（`13:06:11Z` → `13:15:21Z`）。
`cutoff` 跟着跑，意味着重启前的历史永远重算不了，而且**不报任何错**。
这次同为「重启发布」，时刻一动不动，才说明排队落盘真的生效了。

#### 九、昵称截断修复（20261111d / sw v143）发布后核对

| 项 | 结果 | 怎么复算 |
|---|---|---|
| 线上版本 | `20261111d`，冒烟回读一致 | `node scripts/probe-online-smoke.js <url>` |
| 线上冒烟 | **15/15** | 同上 |
| 线上脚本是新逻辑 | `gameUtils.js` 含 `SHORT_W`；`name.length > 4` 只剩注释里那一处引用 | `curl <url>/js/gameUtils.js?sharecode=<sc> \| grep -c SHORT_W` |
| 线上页面实测 | 在**线上页面**里跑 `LXW.utils.short()`：`PlayerAA` / `示例玩家甲` / `DemoUser` / `示例丙` / `will` 全部 `[full]`；「这是一个非常非常长的昵称」`[cut]` → 「这是一个非常…」 | CDP 打开线上 URL，evaluate `LXW.utils.short()` |
| sw 缓存号 | `weile-liuxuanwu-v143` | `curl <url>/sw.js \| grep CACHE_NAME` |

**为什么要在线上页面里直接调函数**：冒烟只证明「版本号对了、页面没报错」。这次改的是一个
纯函数的行为，而页面报错、版本号、HTML 全部与改动无关 —— 只有真的把那 5 个名字喂进
线上加载后的 `short()`，才能排除「代码推上去了但浏览器还在跑 SW 旧缓存」这种情形。
`[full]` / `[cut]` 两条同时成立才算对：全 `[full]` 说明没截，但若超长名也 `[full]`
就说明变成「完全不截」，窄屏会压到隔壁座位 —— 这两条是互相制衡的。

#### 十、小王（20261112a / sw v145）

**需求原话**：「除了大王，再增加小王，大王和小王一样都是赖子，一模一样的功能，小王打不过大王」。
追问后补了两条口径，直接决定了实现：

1. 「**只有需要用王比大小的时候才由王决胜**，反例就是对于斗牛，如果都是牛牛，不用王比大小，是用 10JQK 比」
2. 「飘三叶也需要看王大小，比如大王加俩 7 的豹子比小王加俩 7 的豹子大」

于是四种玩法里「王在哪一层说话」并不统一 —— 这是本次最容易改错的地方：

| 玩法 | 王的作用 | 王和王怎么分 |
|---|---|---|
| 单张 | 王本身就是一张牌 | 大王 15 > 小王 14.5 > K |
| 十点半 | 万能，能当 10，王压真 10 | 王的花色档位：大王 6 > 小王 5 > ♠4>♥3>♣2>♦1 |
| 飘三叶 | 万能，替身凑牌型 | **替完身还平**才比：大王 > 小王 > 没王 |
| 斗牛 | 万能，**不参与比大小** | 不比。同样牛型老老实实比 10/J/Q/K |

**小王用 `rank: 14.5`，不新开花色。** 引擎里「这是不是王」的判断有二十多处，全部写成
`suit === 'joker'`。给小王另起一个花色意味着每一处都要拆成两个判断，漏一处就是
「小王当不了赖子」——而那种 bug 只在摸到小王时出现，线上极难复现。共用一个花色、
只让 rank 差半个点，「是不是王」一个字都不用改，**两张王的功能自动完全一致**。
14.5 也不能随手换成 14：14 是 A，撞上之后比花色时 joker 不在 `SUIT_ORDER` 里（算 0），
小王反而比任何真牌都小。

**最容易漏的一处：双王必须分别解析。** `replaceJoker()` 把手上所有王换成**同一张**牌，
这在飘三叶里恰好是对的（凑豹子要的就是三张同点），但在十点半里是错的 ——
它算的是点数相加：「9 + 大王 + 小王」统一换成 A 得 9+1+1 = 11 爆，正确解是一张当 A(1)、
一张当 K(0.5) = 10.5。所以 `resolveTenHalf` 为双王单开一条组合枚举（按点数去重后 13×13，
不是 52×52 —— 王的花色由 jk 决定，替成哪个花色与结果无关）。

**斗牛双王恒为牛牛**，不需要逐张试：5 张里 2 王 + 3 真牌，取「2 王 + 1 张真牌 p」凑十，
两王之和可覆盖 1~20 的任意 0.5 倍数，总能凑成 10 的倍数；剩下两张是「1 真 + 1 王」，
王补成任意点数即牛牛。也就是说双王下真牌是什么都不影响结果。

**牌面**：大王彩色（红蓝 + 金铃铛）、小王黑白（墨黑 + 中灰），共用一套画法只换调色板。
牌面只有 96~140px，塞「大王/小王」四个字会糊，所以身份靠配色 + 结算面板的牌名两处交代。

| 项 | 结果 | 怎么复算 |
|---|---|---|
| 牌堆 | **54 张**（52 + 大王 + 小王），id 不重复 | `node -e "const C=require('./pwa/js/card.js');console.log(C.createDeck().length)"` |
| 新增测试 | `pwa/test/small-joker.test.js` **39 项**（牌堆 / 单张 / 十点半双王 / 飘三叶王决胜 / 斗牛不比王 / 牌名 / 源码守卫） | `node pwa/test/small-joker.test.js` |
| 红→绿 | 把牌堆里的小王那行删掉 → 6 项立刻红；还原后全绿 | 同上 |
| 全量 | **168 文件 / 7002 断言 / 0 失败** | `npm test` |
| 既有断言迁移 | `engine.test.js` 里 53 → 54；「含王组合能凑 10.5」从 **16 → 33**（大王 16 + 小王 16 + 双王 1） | 同上 |


#### 发布后核对（20261112a / sw v145）

| 项 | 结果 | 怎么复算 |
|---|---|---|
| 线上版本 | `20261112a`，冒烟回读一致 | `node scripts/probe-online-smoke.js <url>` |
| 线上冒烟 | **15/15** | 同上 |
| 牌堆 | 页面里 `Card.createDeck().length === 54`，两张王 rank `15 / 14.5` | CDP 打开线上 URL evaluate |
| 牌名 | `Engine.cardLabel` → 大王 / 小王 | 同上 |
| 十点半 | `9 + 双王 = 10.5点`（双王分别解析生效，不是 11 爆） | 同上 |
| 单张 | 大王赢小王；小王赢 K | 同上 |
| 飘三叶 | 大王 + 77 的豹子赢小王 + 77 的豹子 | 同上 |
| 斗牛 | 「共用同一批真牌、只差大小王」的**构造局** `compareDouNiu = 0`（王被剔出比较材料）。这种局真实发牌不可达，见下一节复核 | 同上 |
| 昵称缩字号 | 线上 `LXW.utils.fitFont` 是函数，`(20,120,160,14) → 15` | 同上 |
| sw | `weile-liuxuanwu-v145` | `curl <url>/sw.js | grep CACHE_NAME` |

**为什么要在线上页面里调引擎**：冒烟只能证明「版本号对了、页面没报错」。
小王改的是纯函数行为，版本号、HTML、请求全部与它无关 —— 只有把 54 张牌和四种玩法
喂进**线上加载后的** Engine，才能排除「代码推上去了但浏览器还在跑 SW 旧缓存」。
`compareDouNiu = 0` 这一条证明的是「王被剔出了比较材料」：若王参与，大王手会凭 rank 15 赢。
**但要读准它的前提** —— 那对牌两家共用 Q 10 3 2 这四张真牌，是构造数据，真实发牌写不出来。

**这一条是最值钱的老测试改造**：那个 16 是穷举 53 张的 1378 种两张组合数出来的，
加小王之后少了任何一项都会给出不同的数 —— 少算双王得 32、漏掉小王退回 16。
三个数必须同时对，比新写十个用例更能说明「王真的多了一张」。

#### 复核：斗牛平局到底可达吗（2026-11-12）

上一轮我给斗牛留了一个待定项：「只差大小王的两手牛牛，要不要让大王赢」。用户当场否掉了
这个提法，理由是「不可能出现两手牌各拿一个王、同时都是牛牛、其他四张牌完全一样 ——
最大的牌一定不一样，能区别出大小」。

用代码验了一遍：用户是对的，而且是**逻辑上不可能**，不是「概率极低」。

① `compareDouNiuCards` 逐张比「点数 → 点数相同比花色」，所以判平 ⟺ 两边 compareCards
是**同一批牌**（rank + suit 全等 ⟺ 同一张牌）；
② 有王的一手剔王后只剩 4 张真牌、无王一手 5 张，逐张只比 min(4, 5) = 4 张 ——
要平仍然需要这 4 张是同一批牌；
③ 结论：判平 ⟹ 至少 4 张牌被两家各拿一份 ⟹ 单副 54 张里发不出来。

实测（新增 `pwa/test/douniu-tie-unreachable.test.js`，22 项）：

| 项 | 结果 | 怎么复算 |
|---|---|---|
| 含大王能成牛牛的真牌组合 | **188,093** | 穷举 C(52,4)，逐个判 `douNiuType().type === 9` |
| 含小王的组合数 | **188,093**，与大王一一对应 | 同上（王的身份不影响牛型判定） |
| 签名相同却「不共享任何真牌」的对 | **0** | 签名 → 4 张真牌，逐个比 id 交集 |
| 20 万局真实发牌 | 斗牛平局 **0** 次 | 随机洗牌，两家各 5 张，`compareDouNiu === 0` 计数 |
| 其中「两家各含王且都牛牛」 | **1,645** 次，全部分出胜负 | 同上（样本数 > 1000，防断言空转） |
| 对照：最大牌只差花色（♠Q vs ♥Q） | 分得出，大王手赢 | 构造局，证明比较器到得了花色这一层 |

**所以不给斗牛加王决胜。** 那是给一条走不到的路写分支，还会给飘三叶 / 十点半那句
「该比王的地方才比王」制造第二套解释。源码守卫已钉住：`compareDouNiuHands` 里
不许出现任何王判定（`jokerLevelOf | isJoker | isBigJoker | isSmallJoker`），
同时对照断言飘三叶比较器里**必须**还有王决胜 —— 防止下次「统一口径」时把两边改成一样。

红→绿验证：给 `compareDouNiuHands` 临时注入 `jokerLevelOf` 决胜后，测试立刻报红 2 项
（构造局不再判平 + 源码守卫），还原后 22 项全绿。

同一处还修了一句会误导的表述：`small-joker.test.js` 里「只差大小王的两手牛牛必须平局」
改成「共用同一批真牌的构造局判平 → 证明王不参与（真实发牌不可达）」，
免得下次有人照着它去实现一个「真实平局」的处理。



### 2026-11-12 半夜：两张王「看起来一样」的真因是客户端混版本（20261112b / sw v146）

用户截图：结算面板里两张 JOKER 都是彩色，问「规则上区分大小王了吗」。
第一反应会去查绘制代码 —— 但代码是对的。以下是实际排查顺序与结论，留给下次。

**① 先证明线上代码是对的**（全新浏览器 / 无旧缓存）：

| 项 | 结果 |
|---|---|
| 牌堆 | `Card.createDeck().length === 54`，两张王 rank `[15, 14.5]` |
| 两张王的 dataURL | 不相同（21730 vs 21122 字节） |
| 大王牌的彩色像素占比 | **17.9%** |
| 小王牌的彩色像素占比 | **0%**（纯灰） |

**② 再证明「旧代码画出来必然一样」**：取 v144 的 `card.js` 做绘制桩测试（记录
`fillStyle/strokeStyle` 调用序列），`rank 15` 与 `rank 14.5` 的**序列完全相同**。
原因：v144 的 `drawJoker(ctx, w, h)` 只有 3 个参数，`isSmallJoker` 也还不存在。

**③ 于是链条闭合**：服务端（磁盘上的新代码）发 54 张牌、含 `rank 14.5`；
客户端跑着 v144 的 JS，两张王都走彩色分支。**服务端是对的，客户端是旧的。**

**为什么客户端会一直停在旧代码** —— 两条机制，各自独立成立：

| 机制 | 问题 | 后果 |
|---|---|---|
| 版本自检只在 `load` 后 500ms 跑一次 | PWA 挂后台一晚上不关 = 永远不再检查 | 服务端换了代码它不知道；对局中 `LXWBusy()` 为真时本来就不刷 |
| SW 脚本/样式兜底 `caches.match(req, { ignoreSearch: true })` | `ignoreSearch` 把 `?v=`（app-version）一起忽略 —— 而那是「这份 JS 属于哪一版」的唯一标记 | 网络慢过一次（3 秒超时兜底）就拿到上一版 JS：HTML 新、JS 旧、版本号看着也一致 |

这类 bug 的共同特征是**没有报错**：请求全 200、界面正常、只有行为是旧的。
所以它不是「小王没实现」，而是「改了代码、用户拿不到」。

**修复**：

- `index.html`：版本自检改成 `setInterval(..., 90000)` + `visibilitychange` 变可见时查一次
  （后台定时器会被浏览器节流到分钟级，而玩家切回前台正是该对齐版本的时刻）。
  保留 `LXWBusy()` 与 `sessionStorage` 防死循环：分牌阶段不刷、同一版本只刷一次。
- `sw.js`：js/css 兜底改走 `matchSameVersion(req)` —— 先精确匹配，再 `ignoreSearch` 兜底，
  但**缓存条目的 `v` 与请求的 `v` 不一致就丢弃**。
  两个取舍写进注释：缓存条目**没有 v** 视为可用（PRECACHE 写的是裸路径，不放行会废掉离线）；
  有 v 但不一致宁可让这次请求失败，也不静默跑旧代码。

**测试** `pwa/test/version-refresh.test.js` 22 项：周期调用、`visibilitychange`、
忙时重试、js/css 分支内部不许出现 `ignoreSearch`；并把 `matchSameVersion` 从 sw.js
抽出来注入假 `caches` 跑 6 种情形（精确命中 / 同版本不同 sharecode / **旧版本必须丢弃** /
无 v 放行 / 无缓存 / 请求无 v）。红→绿：把两处修复分别改回旧写法，各自报红 2~4 项。

**一个必须说清的限制**：已经开着旧页面的客户端，任何前端修复都追不回去 ——
它跑的那份 JS 里没有这些逻辑。所以这次发布后，手上开着旧页面的玩家**需要刷新一次**；
之后 90 秒心跳与「切回前台检查」会接管，不会再出现「改了代码、用户拿不到」。

#### 发布后核对（20261112b / sw v146）

| 项 | 结果 | 怎么复算 |
|---|---|---|
| 线上版本 | `20261112b`，sw `v146` | `curl <url>/index.html` / `curl <url>/sw.js` |
| 线上冒烟 | **15/15** | `node scripts/probe-online-smoke.js <url>` |
| 版本心跳 | 线上 `index.html` 里 `setInterval(checkVersionConsistency, 90000)` 存在 | `curl <url>/index.html | grep -c setInterval` |
| SW 兜底 | 线上 `sw.js` 里 `matchSameVersion` 两处（定义 + 调用），`CACHE_NAME` 含 `v146` | `curl <url>/sw.js | grep -o matchSameVersion` |
| 大小王渲染 | 牌堆 54、rank `[15, 14.5]`、两张 dataURL 不同（21730 / 21122）、**彩色像素 17.9% vs 0%** | CDP 打开线上 `Card.drawCardDataURL` + 取像素 |

**这条修复只对「下次打开」生效**：已经开着旧页面的客户端，跑的那份 JS 里没有心跳、
也没有 `matchSameVersion` —— 任何前端补丁都追不回去。所以发布同时告知玩家刷新一次。

### 2026-11-14：打开卡顿 + 首页闪一下（20261112c / sw v147）

用户报两个现象：「每次打开加载首页卡一会儿」和「有时候加载出首页，会闪一下再进入首页」。
两个都复现到了，原因完全独立。

**复现方法**（比读代码可靠，两次都用它做前后对比）：

- 闪：本地静态服务 + 真 SW，模拟一次发布（改 `app-version` 与 `sw.js` 的 `CACHE_NAME`），
  数**一次打开里发生了几次顶层导航**。改前 **2 次**（第 2 次在 2906ms，`nav.type=reload`），
  改后 **1 次**。
- 卡：同一份 profile 连开两次，第二次关掉 HTTP 缓存（模拟 `max-age=3600` 过期、隔夜打开），
  数**服务端收到的 `/js/` `/css/` 请求数**。改前 **32 + 3 条**，改后 **0 条**。

**① 卡：脚本/样式是 network-first，缓存里有也要先过一次网络**

`?v=` 就是 app-version，是内容指纹 —— 版本一变 URL 就变，缓存必然 miss。
既然如此，network-first 没有任何收益，只有代价：每次打开 32 个脚本 + 3 个样式
全部先走网络。HTTP 缓存一小时内还快，隔夜就是 1.4MB 全量重下（gzip 后约 380KB，
35 个请求），首屏卡在下载上，而 SW 缓存里明明有。

改成 **cache-first，且只认 URL 全等**（`caches.match(req)`，不带 `ignoreSearch`）。
这一条同时满足两个目标，不冲突：

- 快：同版本第二次打开，脚本样式一条请求都不发；
- 不混版本：URL 差一个字符就当没有。旧实现用 `ignoreSearch` 兜底才会把上一版 JS
  交给新版 HTML（2026-11-12 那个「两张王长得一样」就是它）。

**② 闪：`controllerchange` 无条件 reload，且版本自检排在首屏之后**

| 触发器 | 改前 | 改后 |
|---|---|---|
| 新 SW 接管（`controllerchange`） | 无条件 `reload` | **不再刷新**，只记状态 |
| 版本自检（`checkVersionConsistency`） | `load` + 500ms 之后 | 脚本一执行就查、挪出 `load` 回调 |

`controllerchange` 那一刷是**纯多余**的：新 SW 接管发生在 install（预缓存 40 多条）
→ activate → claim 之后，实测 2.9 秒 —— 那时首屏早就画完了，用户看到的就是那一下闪。
而页面此时跑的**已经是最新代码**：导航是 network-first，HTML 从网络拿，里面的 `?v=`
必然是新版（新 URL → 缓存 miss → 走网络）。真正需要刷的只剩一种情形：HTML 本身是从
缓存翻出来的旧版（网络超时兜底），那件事由版本自检负责，语义明确。

**③ 首帧不再是白屏**

`style.css` 是 render-blocking，在它到达之前浏览器画白屏。加了一条内联
`<style>html,body{background:#0F2B22}</style>`（写在所有外链样式之前），
实测量到 t=150ms 时 `<html>` 的背景已经是 `rgb(15,43,34)`，而那时 body 都还没解析出来。
白屏的感知是「卡住了」，品牌绿的感知是「正在启动」—— 同一段等待，两种感受。

**测试**：`sw-timeout.test.js` 的 [1][2][3] 语义整体反转（假 cache 的键改成**含查询串**，
否则「精确匹配」根本测不出来），新增「缓存里只有旧版本 → 新版本必须 miss」；
`version-refresh.test.js` 新增 [E][F] 两节 13 项。红→绿各验过：把三处修复分别改回旧写法，
分别报红 4 项 / 4 项 / 6 项。

**一个必须说清的限制**：这次改的是 SW 与页面启动逻辑，跑在**旧**页面里的那份代码没有它们。
所以已经开着的客户端要刷新一次才吃到本次修复；之后每次打开都走新策略。

**还没做的**（记在这里，别当成已完成）：

- 首次安装、以及每次发布后的第一次打开，仍然要全量下载一次脚本样式 —— 这是
  `?v=` 换代的必然代价，除非做内容指纹+增量，收益不值这个复杂度。
- `index.html` 仍是 network-first（每次打开等一次网关 TTFB，本机实测 ~180ms）。
  想做到「连 HTML 都秒开」得改成 stale-while-revalidate，代价是发布后要多开一次才见新版，
  与「改了代码用户要能拿到」冲突，暂不做。
- `<script src="./js/storage.js">` 在 head 里是**阻塞解析**的：它没到之前 body 都不存在。
  内联它可省一个 RTT，但要动「分享码自愈 + 首帧会话判断」这两段承重代码，单独排期。

#### 发布后核对（20261112c / sw v147）

| 项 | 结果 | 怎么复算 |
|---|---|---|
| 线上版本 | `20261112c`，sw `weile-liuxuanwu-v147` | `curl <url>/index.html`、`curl <url>/sw.js` |
| 线上冒烟 | **15/15** | `node scripts/probe-online-smoke.js <url>` |
| 脚本样式策略 | 线上 sw.js 里 `caches.match(req).then(function (hit)` 存在（cache-first）；`index.html` 的 controllerchange 段已无 `reloadWhenIdle` | `curl` + grep |
| 首帧底色 | 内联 `html,body{background:#0F2B22}` 在线上；两次打开实测 `getComputedStyle(html).backgroundColor = rgb(15, 43, 34)` | CDP |
| **隔夜打开**（关掉 HTTP 缓存） | 顶层导航 **1 次**，FCP **276ms**，JS 32 个 / **0KB**，CSS 3 个 / **0KB** | 同一 profile 连开两次，第二次 `Network.setCacheDisabled(true)` |
| 首次访问 | 顶层导航 1 次，FCP 908ms，JS 408KB（该下载的还是要下载） | 同上第一次 |

"JS 0KB" 这一条是本轮的核心证据：它同时证明「缓存在用」和「没有走网络」。
只报 FCP 不够 —— HTTP 缓存也能把 FCP 做低，而关掉 HTTP 缓存后仍为 0KB，
才说明命中的是 **SW 缓存**。

### 2026-11-14：表情面板去掉「发给谁」，13 张表情按源图重做（20261112d / sw v148）

用户报三件事：① 桌面表情钮进来是**全场**，不该再弹「发给谁」；② 点头像进来
是**这个人**，同样不该再让人选；③ 表情包相对原图**丢部件**。

#### 一、两处交互是同一个问题

不是「默认选中不对」，而是**那一行本身不该存在**。目标在入口就定了，面板标题已经写着
「发给全场 / 所有人都看得到」或那个人的名字，下面再给一排可切换的收件人：
同一件事问两遍，而且让人怀疑「我刚点的到底发给了谁」。

改动是把整行删掉，不是把 DOM 藏起来：

- `#emoji-to` 容器、`.emoji-who` 的 CSS（含横屏两条）、`renderEmojiTargets()`
  实现与全部调用点、`game.js` 里那两处解构，一并删
- `emojiTarget` 只剩一条赋值路径 `ssPid || Emoji.BROADCAST`
  —— 结构上不存在「标题一个人、实发另一个人」
- 委托监听里 `.emoji-who` 的分支同步删（留着就是死代码）

#### 二、表情丢部件是三个独立 bug 叠在一起

| 根因 | 后果 |
|---|---|
| 用「连通块质心落在哪一格」把部件分给表情 | 脱离球体的部件（问号、泪滴、紫帽、Zzz）归错格，两头都不渲染 |
| 13 格共用画框只有 80px，内容却有 74px | 球体几乎贴边，羽化+缩放再削一圈：龇牙头顶、咬牙上下、蝙蝠尖角 |
| 反解颜色时 `F` 取「最近的实心像素」 | 脱离部件最近的像素是绿球，解出 alpha≈0 → **蓝色问号变成一层白雾** |

v3 的做法：

- 列 / 行用**投影分带**定位网格（不依赖连通块），13 格共用 87px 窗口（内容 75 + 6px 边）
- alpha 直接按「与底色的距离」映射，不再反解
- 去投影改用**「底色的等比压暗」**判据：三通道比值极差 < 0.06。实测投影
  `RGB(123,129,148) / 底色(217,228,250) = 0.567 / 0.566 / 0.592`（极差 0.026），
  而球体是 0.27 的极差。**亮度阈值无论取哪个值都会切在投影中间**，留一圈深灰月牙
  —— v3 前两版都栽在这，先后试过 0.97、0.80、0.55 三个下限

几何校验（不靠眼睛）：13 张的球体包围盒与原图偏差全部 **≤1.7 输出像素**，
方向是略微内缩，即抗锯齿边缘取半像素的正常表现，没有削。

#### 三、7 号生气 / 8 号得意的「眼睛位置」：素材没错，是对照图骗人

用户指出这两张眼睛不对。量化结果（96 画框、以球心为基准）：

| | 原图 | 素材 | 偏差 |
|---|---|---|---|
| 生气 眼白重心 | (−18.5,−14.2) / (+10.0,−16.9) | (−17.9,−13.7) / (+9.9,−17.1) | 0.6 / 0.2 px |
| 得意 虹膜重心 | (−9.5,−11.0) / (+5.0,−10.8) | (−8.2,−10.8) / (+5.2,−10.7) | 1.3 / 0.2 px |

**祸首是我上一轮那张 `emoji-confirm.png`**：原图侧把 71~77px 的**非正方形**网格块
直接 `resize(118,118)` 强行拉方（倍率 1.6×），素材侧是 96px 图等比缩放（1.23×），
球直径画成 **121px vs 93px，差 28%**。左右差三成大小，眼睛自然像走位。

**顺带挖出一个真 bug 并修掉**：距离 alpha 只对外轮廓有效。物体**内部**的浅色像素
（眼白、眼眶高光、花痴红心外沿）被算成 0.6~0.9 的半透明，反解又推成纯白 ——
浅色底上看不出，贴到深绿牌桌上就是「眼白发白、边缘一圈雾」。
修法：离轮廓 1.5 源像素以外的内部强制 `alpha=1`（`depth/(INNER_PX*SS)` 取 max 保单调）。
13 张平均改变 <2/255（生气 0.6、得意 1.5），不影响其余 11 张。

**教训（下次做对照图别再踩）**：生成「原图 vs 产出」对比时，两边必须**同一画框、同一缩放**。
固定网格裁块再拉方 = 隐式改了缩放倍率，做出来的对比图会骗人，也会骗到自己。
公平做法：原图按脚本同款 87px 窗口取景 → 96，只把背景抠成透明再合成到牌桌色。

#### 发布后核对（20261112d / sw v148）

| 项 | 结果 | 怎么复算 |
|---|---|---|
| 线上版本 | `20261112d`，sw `weile-liuxuanwu-v148` | `curl <url>` 取 `meta[name=app-version]`；`curl <url>/sw.js \| grep CACHE_NAME` |
| 线上冒烟 | **15/15** | `node scripts/probe-online-smoke.js <url>` |
| 目标行已消失 | 真实浏览器里 `document.getElementById('emoji-to')` = **false**，`.emoji-who` = **0 个** | CDP 线上打开后 evaluate |
| 13 张素材上线 | 逐个 `naturalWidth/Height` 全 **96×96**，无 onerror；e7/e8/e3 字节数与本地**逐一相等** | 同上 + `curl -w '%{size_download}'` |
| 全量回归 | 169/169 文件、**7042** 断言 | `node scripts/run-tests.js` |
| 表情探针 | **45/45**（含「桌面上无目标行」「点进来就是他」两条反转后的断言） | `node scripts/probe-emoji.js` |

源图入库 `docs/prototypes/assets/emoji/_source-sheet.png`，
重跑 `python scripts/crop-emoji.py <源图>` 可完整复现 13 张。

### 2026-11-14：表情 / 短语按舞台缩放适配桌面端，落点改到座位外侧（20261112e / sw v149）

用户报：「电脑上玩的话，表情和短语是不是相比手机上太小了」，
并且要求同时考虑不同设备（含 PWA）上的**展示位置**。

#### 一、小不是「尺寸定小了」，是**根本没跟着缩放**

`#stage` 在手机上用 `transform: scale(0.52)` 收缩整张牌桌，桌面上放大到
0.84 左右（1366×768）。`#game-top` 里的头像、座位名都是 `#stage` 的后代，
**一起被缩放了**；而 `#emoji-layer` 是 `position: fixed`，挂在 `#stage` 之外 ——
它拿不到那个 `transform`。

于是同一段 CSS 像素，在手机上被 0.52 缩过、在桌面上没有被放大：
头像跟着缩放，气泡不跟，**相对比例就反了**。这就是「表情比头像还小」的全部原因。

修法不是给桌面写一套断点，而是**把舞台的缩放倍数读回来**：

```js
var k = Math.max(1, stageScale() / 0.52);   // 0.52 = 手机竖屏基准
k = Math.round(k * 100) / 100;
wrap.style.setProperty('--emo-k', k);
```

`--emo-k` 写在**每条气泡自己的外层节点**上（不是 `:root`），
所有尺寸一律 `calc(基准px * var(--emo-k, 1))`：图标 64、气泡 padding 10/18、
圆角 18、字号 24、间距 6。**基准值一个都没改**，手机上的观感与 v148 逐像素一致。

`max(1, ·)` 是「只放大不缩小」：0.52 以下（320 那档）不陪着小屏继续缩字，
否则小屏可读性反而倒退 —— 这一档改为允许折行（`white-space: normal`）。

| 视口 | `--emo-k` | 短语字号 | 气泡 |
|---|---|---|---|
| 390×844 手机 | 1 | 24.0 CSS px | 325×51 |
| 1366×768 桌面 | 1.62 | 38.9 CSS px | 526×83 |
| 1920×1080 | 2.27 | 54.5 CSS px | 739×117 |

宽度上限取两者的小：设计上限 `calc(460px * k)` 与「视口留 24px」
（`calc(100vw - 24px)`）。后者专治 320 宽：k 有下限 1 而屏只有 320，
不给上限就会被 `#emoji-layer` 的 `overflow: hidden` 切掉。

#### 二、展示位置：从「盖住座位中心」改成「贴在座位外侧」

原来的落点是气泡中心 = 座位中心，等于**先把人要看的头像糊住再说话**。
现在的规则是一条链，每一步都在处理上一步的边界：

1. 底边贴在座位**上方**，留 `6 × k` 的 gap
2. 上方放不下（上排座位贴屏幕边）就翻到座位**下方**
3. 水平居中后夹进视口 `[4, vw - w - 4]`
4. **再和每个 `#game-top .opp-avatar` 的矩形比一次，挡着谁就推到谁下面**

第 4 步不是保险，是必需的：320 那一档气泡折两行后高 83，顶部放不下 → 翻到下方；
同时被横向夹到屏幕左边 → 正好压在左上邻居头像上（实测重叠 **263 px²**）。
夹取和翻转是两个独立动作，组合起来会撞车，**算不出来、只能拿最终矩形去量**。

顺带删掉了旧的 `-8px` 上浮：那是「居中覆盖」时代的贴边补偿，
在新的外侧落点里会把 6px 的 gap 抵成 2px 重叠。

#### 三、跨设备一致性用**相对比例**验，不用绝对像素

绝对像素本来就该随设备变，验它没有意义。验的是「气泡与头像的相对大小」：

| 指标 | 手机（390） | 桌面（1366 / 1920） | 结论 |
|---|---|---|---|
| 短语字号 ÷ 头像宽 | 0.679 | 0.678 ~ 0.680 | 一致 |
| 表情直径 ÷ 头像宽 | 1.81 | 1.81 | 一致 |

6 档视口（320 / 390 / 844 横 / 800 / 1366 / 1920）各跑一遍，
其中还跑了 `SEATS=5` 的**满员局**（座位上绕圆环、上下左右都有邻居，
最容易撞车的一档）：5 个头像**零遮挡**，气泡全部完整落在屏内。

#### 发布后核对（20261112e / sw v149）

| 项 | 结果 | 怎么复算 |
|---|---|---|
| 线上版本 | `20261112e`，sw `weile-liuxuanwu-v149` | `curl <url>` 取 `meta[name=app-version]`；`curl <url>/sw.js \| grep CACHE_NAME` |
| 线上冒烟 | **15/15** | `node scripts/probe-online-smoke.js <url>` |
| 缩放逻辑已上线 | 线上 `seatSheetView.js` 有 `setProperty('--emo-k', k)`；`emoji.css` 6 处 `var(--emo-k` | `curl <url>/js/seatSheetView.js`、`/css/emoji.css` |
| 13 张素材 | 逐张 HTTP 200 且字节数与本地**逐一相等** | `curl -w '%{size_download}'` |
| 全量回归 | 170/170 文件、**7067** 断言 | `node scripts/run-tests.js` |
| 新增守门 | `pwa/test/emoji-scale.test.js` 25 条（红测还原旧写法报红 8 项） | 同上 |
| 表情探针 | 45/45 | `node scripts/probe-emoji.js [宽 高]`、`SEATS=5` |

探针这一轮扩了三件事：支持视口位置参数、`SEATS` 环境变量做满员局、
新增 `[5b]` 几何断言（`coverAvatars === 0`、比例区间 `[0.60,0.78]` 与 `[1.65,2.00]`、
完整在屏内）。另外修了两条**过期断言**：格子列数（横屏本来就是 7 列）、
落点判据（从「离座位中心 60px」改成「不叠座位且紧邻」）——
判据不跟着改，改对了也会报红。

#### 还没做（留给下一轮）

- **表情面板本身**在电脑上仍偏小：面板固定 520 宽，1366 屏上只占 38%，
  格子约 74 CSS px。这次只放大了「飞出去的气泡」，面板没动 —— 要不要一并按 k
  放大，等用户定。
- 气泡的定位口径是「相对头像对齐」。若改成「占屏比例对齐」（大屏上气泡更靠中间、
  更少贴边），需要另算一套参数，两种口径观感差别明显。
- 公库同步被 GitHub 的 TLS 握手失败挡住（直连与代理都是 000，`schannel` 与
  `openssl` 两个后端同样失败）。提交已在公库本地备好（`b0d2be8`），网络恢复后
  补推即可 —— 线上部署不受影响。
