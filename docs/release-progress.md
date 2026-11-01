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

**当前线上：`20261102d` / sw `v115`（v115）**—— 对撞对称八条 + 牛魔王文案 + 结算页冠军块 + 房间态持久化。
线上冒烟 **15/15**（浏览器实测版本号 `20261102d`、直抓 `sw.js` 确认 `CACHE_NAME = 'weile-liuxuanwu-v115'`）。
全量 `npm test` **128 文件 / 4936 条断言**；`journey` **126 项**；`probe-ui-flow` 竖/横各 1 视口 × 13 屏 ALL PASS。

> 注意：冒烟脚本**第一次跑**报了 5 条 FAIL（标题/版本/白屏/manifest 带码/favicon 全是 undefined）——
> 那是新沙箱刚起、页面还没起来，脚本固定 sleep 6 秒取的是一张空文档。**隔一会儿重跑即 15/15**。
> 这条记在这儿，免得下次又当成真回滚。

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
| 部署 | `https://liuxuanwu.app.workbuddy.host/?sharecode=Q2JYFWXOP3`（同一个应用，链接不变） |
| 线上冒烟 `probe-online-smoke` | **15 / 15 通过**（版本号 `20261102d`，`sw.js` 直抓 `CACHE_NAME = weile-liuxuanwu-v115`） |
| 公库 | `657a591 chore: 同步自私有仓库（6ff056c）` |
| 私库 | `6ff056c`（`git ls-remote` 比对一致） |
