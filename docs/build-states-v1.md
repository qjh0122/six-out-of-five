# 四态施工单（制作人裁定 · 唯一施工依据）

| 项 | 值 |
|---|---|
| 版本 | **v1** |
| 日期 | 2026-11-08 |
| 作者 | 制作人 范可控（汇总 `design-states-v1.md` + `qa-states-v1.md`） |
| 状态 | **已施工并发布（v137，含 fix1 / fix2 两轮复核）** |
| 上游 | 设计：`docs/design-states-v1.md`（游有方，**已作废**）｜判据：`docs/qa-states-v1.md`（严过关） |

> **2026-11-08 状态注**：本单已施工完毕。制作人逐张看图复核后追加的 6 处（M1–M4 / F1 / F2）
> 与两处改判（R8 离线副文案、F2 横幅让位）记在 §7 修订记录；
> **现行设计规格是 `design-states-v2.md`**，复核时不要拿已作废的 v1 来判。
> §1「下一批单独发」的数字层级已由 v138 完成，见 `build-numbers-v1.md`。

> **冲突以本文件为准。** 两份上游文档里有 1 处互相矛盾、1 处本单改判、1 处推迟，全部记在 §1。施工者遇到三份文档说法不一致时，**不要自己选**，回制作人。

---

## 1. 裁定（施工前必读，三条）

### R1 载体清单：离线用页面级新块，`#net-banner` 不进统计

QA 把 `C_offline` 定为 `#net-banner`；设计新建 `#records-offline`。**采用设计，改 QA 的载体**。

理由：`#net-banner` 是 `position: fixed` 的全站层（`index.html:242`、`style.css:291`），首页/房间/对局都挂着它。把它算进"战绩页五个态"里，会导致「玩家在别的屏看到横幅」把战绩页的互斥断言顶红——那是统计口径错，不是实现错。

| 状态值 | 载体（一一映射） |
|---|---|
| `data` | `#records-scroll` + `#records-data` —— **视为同一载体，只数一次**（现状两者同时可见是对的） |
| `empty` | `#records-empty` |
| `loading` | `#records-loading`（新建） |
| `fail` | `#records-fail`（新建） |
| `offline` | `#records-offline`（新建，`is-strip` / `is-panel` 两形态） |

`#net-banner` 保留原位、保留文案，**不参与五态互斥统计**，也不许把它当离线态的唯一载体（QA S8 的"不许寄生 toast"同样适用于它：横幅是补充，不是状态）。

### R2 互斥断言是 **≤1**，不是 ==1

设计有 250ms 门槛（`STATE_DELAY_MS = 250`）：进入战绩页后 0–250ms 内**什么都不显示**（只有屏背景），避免"先闪空态再切有数据"。这段时间里五态载体**一个都不出现**，QA S1 的「恰有一个」必然红。

- 恒成立断言：`{loading, fail, empty, data} 中可见数 ≤ 1`；
- 稳定后断言（进入屏幕 ≥600ms 或状态已确定）：`可见数 = 1`；
- `offline` 不在此组（见 R3）。

### R3 离线是非互斥项，只有一种叠加形态

- 有内容（`data` / `empty`）时：`#records-offline.is-strip` 贴在 `#records-foot` 上方，**内容照常显示**。这是全局**唯一**的双显豁免，别处不得再开口子。
- 无内容（本机 0 局且登录中）或正在 `loading` / `fail` 时：离线**抢占**，判 `data-rstate = 'offline'`，用 `is-panel` 独占。
- 离线时**不发** `/me/records` 与 `/api/leaderboard` 请求（QA S9 裁定"不发"，本单采纳）。理由写在 `game.js:3171` 已有注释里：8 秒空等是纯损失。
- `online` 事件回来后 500ms 内收条并重取数据。

### R4 推迟：数字三档（设计 ③）不在本批

设计给了完整的 88/48/32/24 三档方案，**本批不做**。理由：它要改结算页与排行榜的字号，属于"真机体感"活；和状态机重写绑在一批，两个都难验。下一批单独发，届时按 `design-states-v1.md §③` 施工。
> **回指（2026-11-08）**：这一项已由 **v138** 完成，但落地口径与 v1 §③ 不同 ——
> 「同屏 ≤3 档」被「阶梯封闭」取代（v1 自己的映射表算出来就是四档，规范内部打架）。
> 逐选择器映射与六条裁定见 `build-numbers-v1.md`，现行规格见 `design-states-v2.md`。

### R5 数字相关的唯一例外

本批**不动任何字号**。若施工中发现某态文案在 800×360 下放不下，**优先缩短文案**（设计允许 ≤14/≤26 字内自选），不许改字号、不许改布局系数。

---

## 2. 目标（做完是什么样）

1. 战绩页有五个可分辨、可断言的状态：正常 / 空 / 加载 / 失败 / 离线；
2. `#screen-records` 上有 `data-rstate`，值域 `{data, empty, loading, fail, offline}`，**唯一真源**；
3. 加载态零按钮，失败态两个按钮（可重试类）或一条出路（不可恢复类），空态一个按钮，离线一条横条 + 一个按钮；
4. 错误三级（可重试 / 不可恢复 / 静默）各有一份文案与动作，静默类**页面一个像素都不动**；
5. 上述每一条都有可机检断言，且断言经过变异自证。

---

## 3. 文件级改动清单

### 3.1 新建 `pwa/js/recordsState.js`（纯函数 + 文案表）

```js
// 导出：recordsStateOf(input) → 'offline'|'fail'|'loading'|'empty'|'data'
//       errClassOf(key)     → 'retry'|'fatal'|'silent'
//       ERR                 → { [key]: { level, title, sub, actions[], report } }
//       STATE_TEXT          → 四态标题/副文案（逐字来自 design-states-v1.md §②-b）
//       STATE_DELAY_MS = 250 / STATE_SLOW_MS = 1000
```

判定顺序**唯一**：`offline > fail > loading > empty > data`。

入参用显式字段，不走全局（便于单测）：
`{ online, cloudErr, cloudLoading, hasData, avail }`。

`errClassOf` 的映射必须覆盖设计 §②-a 表中的 11 个 key，**每个 key 只能属于一个级别**（QA S11 的"同一错误码映射到两个级别 = 0"）。

### 3.2 `pwa/index.html`

新增（只许这 6 个）：

| id | 说明 |
|---|---|
| `#records-loading` | `class="rp-state rp-state--loading hidden"`，`role="status" aria-live="polite"`；内：44px 金环（`aria-hidden="true"`）+ 标题 + 副文案（慢时替换） |
| `#records-fail` | `class="rp-state rp-state--fail hidden"`，`role="status" aria-live="assertive"`；内：标题 + 副文案 + 主按钮 `#btn-records-retry` + 次按钮 `#btn-records-fail-create` |
| `#records-offline` | `class="rp-state rp-state--offline hidden"`；内：标题 + 副文案 + `#btn-records-reload`（ghost）；靠 `.is-strip` / `.is-panel` 切形态，**只此一块** |
| `#records-source-retry` | 塞进 `#records-source` 同一行右侧的 ghost 小按钮（失败降级用） |
| `#rank-fail` | 榜单失败，**独立于 `#rank-empty`** |
| （属性）`data-rstate` | 加在 `#screen-records` 上，初值 `loading` |

四态块的位置：`#records-empty` 之后、`#records-foot` 之前，作为兄弟块。

### 3.3 `pwa/css/records.css`

**只新增一个段落** `/* ===== 四态（build-states v1）===== */`，插在空状态段之后。内容只允许：`.rp-state` 的几何（复用 `.rp-empty` 的 `flex:1; justify-content:center`）、`@keyframes rpSpin`、三个修饰类、`.is-strip` / `.is-panel` 的差异。

硬约束（会被守卫挡）：
- 过渡只准 `var(--dur-1/2/3)` + `var(--ease-std/emph)`；
- 阴影只准 `var(--elev-*)` / `var(--edge-*)`；
- **不引入新色相**，金色透明分档用 `rgba(245,193,92, α)`；
- 切态用 opacity，**不用位移**；
- 离线块 `text-align: left`（其余三态 center）——这是结构差异，不是口味，不许改。

### 3.4 `pwa/js/recordsView.js`

1. `renderRecords()` 里散着的四处 `classList.toggle('hidden', …)` **全部收进** `setRecordsState(name)`；后者同时写 `data-rstate` 与 `#records-offline` 的形态。
2. 删掉「`loading` 只换文案」那条分支（`recordsView.js:336-351` 一带）——它是本批要消灭的东西。
3. 空态的变体 B-2（`!avail`）**搬进失败态**，按 `err.data.no_storage` 的文案与单按钮（design §①-d）。
4. 250ms 门槛与 1s 慢文案：进门时起 timer，`STATE_DELAY_MS` 内不落态；超 `STATE_SLOW_MS` 换副文案。离开该屏/状态转移要清 timer。
5. 失败降级（本机还有数据时）：不占满屏，改在 `#records-source` 那一行右侧出 `#records-source-retry`。
6. 所有上报走 `ERR[key].report` → `ErrorReport.capture(...)`，**不新建节流**（`errorReport.js` 已有去重与上限）。
7. `renderRank()` 的失败分支改写到 `#rank-fail`，**不得**再写 `#rank-empty` 的文案。

### 3.5 `pwa/js/game.js`

1. 离线时**不调用** `loadCloudRecords` / 榜单请求；`blockedOffline()` 行为保留（玩家主动点时仍 flash + 音效）。
2. `online` / `offline` 事件除了 `setNetBanner`，还要通知战绩页刷新 `data-rstate`（500ms 内收条）。
3. 注入 `recordsState` 模块（见 3.6）。

### 3.6 新模块必须做的四件事（漏一件 `npm test` 就红）

1. `index.html` 里加 `<script src="./js/recordsState.js?v=…" defer>`，位置在 `recordsView.js` **之前**；
2. `pwa/sw.js` 的 `PRECACHE` 加 `'/js/recordsState.js'`；
3. `pwa/test/module-contract.test.js` 的 `MODULES` 加文件名、`NAMESPACES` 加一行（形如 `RS: 'recordsState'`）；
4. 若新增 CSS 用了 `gap`：跑 `node scripts/gen-flex-gap-fallback.js`。

---

## 4. 断言清单（施工者自己先写，再交 QA 复核）

按 `qa-states-v1.md` 的判据编号落，**不得删减、不得放宽**，允许拆细。本批必须落地的：

| 判据 | 落点 | 一句话 |
|---|---|---|
| S1（改口径为 ≤1） | 探针 | 四态载体同时可见 ≤1；稳定后 =1 |
| S2 | 单测 | `data-rstate` 值域 = 5 值，缺一或越界即红 |
| S3 | 探针 | 加载时 `#records-empty` / 其插画 / 其 CTA 三者全不可见；页面不出现数字 `0` |
| S4 | 探针 | `aria-busy` 或 `#records-loading` 有尺寸且文本非空；加载结束后不许残留 |
| S5 | 探针 | 失败态有可点重试控件，命中区 ≥44×44 CSS px |
| S6 | 探针 | 点重试：网络层 `/me/records` 计数 **+1 且只 +1**（CDP `Network.requestWillBeSent`，不数被测计数器） |
| S7 | 探针 | 失败原因出现在**可见**文本里（`checkVisibility()` 过滤后拼接） |
| S8 | 探针 | 离线态不寄生 toast：等 `#toast` 自己进 `.hidden` 后，`#records-offline` 仍可见 |
| S9 | 探针 | 离线时 `data-rstate ≠ loading`，且 `/me/records`、`/api/leaderboard` 请求增量 = 0 |
| S11 | 单测 | 11 个 key 各属唯一级别，三级各有 ≥1 例 |
| S12 | 单测（分类器自测）+ 探针 | L2 可见文案不含禁用词；分类器先自测 N/N 报数 |
| S15 | 探针（主） | 静默类：上报 ≥1 且可见 toast = 0、页面文本逐字不变 |
| S17 | 探针 | 四态 × 极值视口（320×568、800×360）主控件不溢出、不被页脚盖住 |
| S19 | 单测 | 新守卫被 `npm test` 真调用；新探针登记 `probes.json` 且 CI 里有一行执行 |
| S20 | 单测 | 分类器自测报数（N/N，样本 ≥3，含 ≥1 命中 ≥1 不命中） |

**变异自证（必交，至少这 6 条，交「改坏→红→改回→绿」的记录）**：
1. 加载态恢复成"只换文案" → S3 红；
2. 重试按钮 `onclick` 改空函数 → S6 红；
3. 失败文案挪进 `.hidden` 元素 → S7 红；
4. 删 `#records-offline`，只留 toast → S8 红；
5. L2 文案改成「账号不存在，请再试一次」 → S12 红；
6. 静默类顺手 `flash('上报失败')` → S15 红。

---

## 5. 明确不做（本批）

| 不做 | 为什么 |
|---|---|
| 数字三档层级（设计 §③） | 见 R4，下一批单独发 |
| 离开房间的撤销 | 要单独过"导航中被结账"的安全性复核 |
| 骨架屏 / 自动重试 / 进度百分比 / 错误码上屏 / 全屏红 / 四态音效 / 新增插画 | 设计 §④ 的 8 条，逐条有理由，原样采纳 |
| 改任何字号或布局系数 | 见 R5 |
| 动 `#net-banner` 的结构与文案 | 它是全站层，本批只"接上"不"改造" |

---

## 6. 交付要求

1. `npm test` 全绿（当前基线 151 文件 / 5814 断言，只准增）；
2. 新探针 `scripts/probe-states.js` 自己跑通，并登记 `scripts/probes.json`（`run: 'ci'`）+ `.github/workflows/test.yml` 里加一行真的执行它（`npm run probes:check` 只校验登记，校验不了 CI 是否真跑）；
3. 变异自证 6 条的执行记录（贴命令与红/绿结果）；
4. 提交**不要 push**，提交信息末尾带 `[states-v1]`；
5. 回传：「改动的文件清单 + npm test 数字 + 探针项数 + 6 条变异的红/绿 + 你想推翻我的地方」。

---

## 7. 修订记录 · fix1（v1 施工后的四处必修 + 一条建议）

> 依据：制作人复核 `f96a3d3` 的五张截图，判四处必修（M1–M4）、一条建议（S1）。
> 本节是那五条的施工口径，**不改 §1 的五条裁定**，只补两个细则（R6 / R7）。

### R6 离线时页脚那个出口必须消失（不是"点了没反应"，是"不该出现"）

`#records-source-retry` 的条件 `degraded` 追加离线判定：

```js
var onlineNow = !isOfflineNow();
var degraded = onlineNow && !!cloudRecordsErr && hasData && recordsAvailable();
```

理由：`loadCloudRecords()` 第一行就 `if (isOfflineNow()) return;` —— 离线时那个按钮点下去
**什么都不会发生**。QA S9 的原话是"不该发注定失败的请求、也不该邀请玩家点它"。
离线时真正的出路是横条里那个「重新载入」（恢复网络后才动作）。

### R7 离线时算"离线该长什么样"，用的是「假如有网」，不是 `loading`

`applyRecordsState()` 里 `base`（"假设有网时是哪一态"）的 `cloudLoading` 必须传 `wouldLoad`：

```js
var wouldLoad = !useCloud && !cloudRecordsErr && cloudRecordsReady();   // 假如有网，会不会在加载
var loading   = online && wouldLoad;                                    // 离线时不算加载
```

传 `loading` 会得出"有网也是空"，于是「本机 0 局 + 登录中 + 离线」被当成"账号确实 0 局"
→ 露出空态那张 0 分插画。真相是**没问过**账号。

### 五条的落法

| # | 问题 | 落法 | 断言 |
|---|---|---|---|
| **M1** | 离线时页脚还挂着「再读一次」 | R6（`degraded` 加离线判定） | 探针 [6]：离线时 `#records-source-retry` 不可见 + **反向**（网络回来、云端仍失败 → 出口回来）；守卫 [5b] 静态查 `degraded` 定义含离线判定 |
| **M2** | 离线时页脚口径是结果误报，且与横条同义 | `renderSourceLine()` 的文案分支改成「离线 > 格式不符 > 用云端 > 降级 > 本机」，离线走「只在这台设备上，换设备会丢」 | 探针 [6]：文案逐字相等 + `#records-source` 可见 + **不等于横条副文案**；守卫 [5b] 查分支顺序 |
| **M3** | 加载/离线/失败时把成就数写成 0/N（用未知冒充零） | 新增纯函数 `recordsState.achLabel(value, total)`：`null/undefined/''/NaN` → `—/N`，确定值（含 0）→ `n/N`；`recordsView` 只在 `useCloud && cloudRecords` 时把值喂进去；HTML 初值改 `—` | 单测 `states.test.js [8]`（10 条，含负向"未知写成 0/N 的用例数 = 0"）；探针 5 条（loading / fail / offline / panel → `—/N`，拿到确定值 3 → `3/N`） |
| **M4** | "离线 + 有内容 = 内容可见"没有专门断言 | 加断言（含正向与反向），反向由 R7 保证 | 探针 [6]：`#records-scroll` 与 `#records-data` 都可见 + 只有 `.is-strip` 且空/失败/加载都不露；探针 [8]：本机 0 局 + 登录中 + 离线 → `.is-panel` 独占且 `#records-empty` 不可见 |
| **S1** | 离线瞬间横幅 + 横条 + toast 三处同义 | 删掉 `game.js` offline 事件里的 `flash('网络已断开')`；`online` 那一条保留（横幅消失这件事需要一句话解释） | 沿用 S8（toast 消失后横条仍在）+ S15；不新增断言（删掉一条重复提示，红绿不变） |

### 已知遗留（交设计，不在本轮改）

- `#records-offline` 的副文案在 **panel** 形态下是空承诺：本机 0 局时说「先把这台设备上的记录给你看」，
  而这台设备上并没有记录。一个块两种形态共用同一句文案是设计 §⑤-b 的硬要求，**不许就地改字**。
  建议设计给 panel 形态补一条 ≤26 字的副文案（例如"连上网再看账号里的"），下一版给。

### fix1 的验收数字

- `npm test`：153 文件 / **6041** 断言全绿（fix1 前 6020；+21 = `states.test.js` 111→121、`states-wiring.test.js` 93→104。
  注：`f96a3d3` 的提交说明把后者写成 95，实测该提交里是 93 —— 那个数是估的，总数 6020 不受影响）；
- `probe-states`：**80 项 × 2 档**全绿（fix1 前 63 项，+17）；
- 变异自证 2 条：① 去掉 `degraded` 的离线判定 → 探针恰好 1 条红（M1）+ 守卫 1 条红；
  ② `offlineForm()` 强行 `return 'panel'` → 5 条红（含 2 条 M4、连带 M2 的可见性）。

---

## 8. fix2（F1 假话 / F2 横幅压标题）

### R8 离线副文案允许按形态分档（临时裁定，下一批请设计确认）

**改的是 §⑤-b「一个块两种形态共用一套文案」的字面执行。** 理由：**不能因为一条美学规则说假话。**

那条规则的目的是"不许建两个块，两块必然两套文案、迟早不一致"；本轮仍然是**一个块、一张文案表**，
只是取值多了一档，坏处没有，假话没有了：

| 形态 | 触发 | 副文案 | 为什么 |
|---|---|---|---|
| `is-strip` | 本机有记录 | 先把这台设备上的记录给你看 | 底下**真有**那几行，这句话是真的 |
| `is-panel` | 本机 0 局 + 登录中（没问过账号） | **连上网就能看到账号里的记录** | 底下什么都没有，沿用 strip 那句是假承诺 |

落法：`STATE_TEXT.offline` 增加 `subPanel` 字段，`setRecordsState('offline')` 按 `form` 取值 ——
**不新建块**。文案逐字照裁定，施工方不得自选改字。

### F2 `#net-banner` 在战绩页让位

现象：`#net-banner` 是 `position: fixed`（`top: safe + 8px`，`z-index: 320`）的全站层，
压在这屏的 `.rp-nav` 上，正好盖住「我的战绩」四个字（截图里字从横幅两侧露出来）。

修法是**让位**，不是加 padding：800×360 的横屏最小档本来就挤，加 padding 会挤掉内容（S17 会红）。落法：

```js
function setNetBanner(online) {
  var b = $('#net-banner');
  if (!b) return;
  b.classList.toggle('hidden', online !== false || recordsScreenVisible());
}
```

- 判据是「`#screen-records` 真的露着」（判 `state.screen` 不成立：冷启动那一段它有值而屏还 hidden）；
- `showScreen()` 末尾重算一次 `setNetBanner(!isOffline())` —— 不重算的话，从战绩页退到首页时
  横幅会一直藏着，那就把"让位"写成了"删掉"；
- 与 R1「横幅不参与五态统计」一致：它在这一屏不是第五条状态，是被页面自己取代掉的重复声音。

**这条覆盖 design `⑥-12` 的前半句**（"离线时 `#records-offline` 与 `#net-banner` 都不带 hidden"）：
战绩页离线时横幅带 `hidden`。S8 不受影响 —— 它要的是"离线原因不寄生在 toast 上"，
`#records-offline` 本身就在白名单里。

### fix2 的验收数字

- `npm test`：153 文件 / **6050** 断言全绿（fix2 前 6041；`states.test.js` 125、`states-wiring.test.js` 109）；
- `probe-states`：**85 项 × 2 档**全绿（fix2 前 80，净 +5：F1 三条、F2 三条，替换掉一条"横幅也在"的旧断言）；
- 变异自证 2 条：① 去掉 `recordsScreenVisible()` → 探针 2 红（F2 两条）+ 守卫 2 红；
  ② panel 改回共用 `sub` → 探针 2 红（F1 两条）+ 守卫 2 红。
