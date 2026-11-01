# v82 落地清单（准备态进牌桌 + 人数 2–5 + 战绩扩容 + 表情短语）

> **📌 已全部执行并上线（v82 / `20261030x` ~ `20261031c`）。** 保留为执行清单原件，
> 不要再当待办读。实际验收数字与后续变更见 `docs/release-progress.md` 的 R1–R6 章节。
>
> 前置已定：**逐组结算只改展示层**（不动计分主流程）、**拆两批发布**。
> 本文只讲 v82；v83（组级写分）的门槛见 §7。
>
> ⚠️ 一处需要留意：§7 的 v83「组级见底写分」方案在 **v103 被整条撤销**
> （见 `docs/hand-limit-plan.md` §9.4 —— 它会让后两组的输赢蒸发）。
> 读 §7 时不要把「见底当场出局」当成现行规则。
>
> 原型基准：`docs/prototypes/circle-table.html`（规则已改为直接引用 `pwa/js/engine.js`）
> 单文件交付物：`dist/circle-table-single.html`（`node scripts/build-proto.js` 生成）

---

## 0. 为什么 v82 可以「不碰钱」

v82 的四件事，全部不写分数：

| 项 | 是否写 `player.score` | 是否改 phase |
|---|---|---|
| 人数 2–5 | 否（只改上限常量） | 否 |
| 准备态搬进牌桌 | 否（只换渲染层） | 否（`WAITING` / `SETTLED` 原样） |
| 战绩页扩容 | 否（只读聚合） | 否 |
| 表情 / 短语 | 否（不落库） | 否 |

所以 v82 的验收标准是「老功能没丢 + 放得下」，不是「分数算对了」。分数对账是 v83 的门槛（§7）。

---

## 1. 前置：把常量收回一处 ✅ 已完成

**这是本次唯一的「第二份实现」隐患，先修它。**

| 文件 | 锚点 | 改法 |
|---|---|---|
| `pwa/js/config.js` | `:20` `MAX_PLAYERS: 8` | → `5` ✅ |
| `server/hub.js` | `:37` `const MAX_PLAYERS = 8;` | 删掉本地常量，两处校验改读 `SM.capOf(room)` ✅ |
| `pwa/test/player-cap.test.js` | 新增 | 23 条断言：上限只有一份、新房间 5 人、老房间按 8 走完 ✅ |

为什么排第一：`config.js` 里 `MIN_PLAYERS/MAX_PLAYERS` 已经存在，但 `hub.js` 自己又抄了一份 `8`。
两边同时存在时，前端拦住第 6 个人、服务端还放行 —— 这类「前端说不许、后端说可以」的分叉，
和上一轮「原型手抄 engine.js」是同一类错误，只是这次抄的是一个数字。数字也会漂。

**「老房间怎么办」选了兼容方案**：建房时把当时的上限抄进 `room.cap`，之后一律读
`StateMachine.capOf(room)`。老 8 人房继续按 8 走完，新房间用 5。
不这么做的话，上线当天正在打的 8 人房会当场少画 3 个座位（`slotCount` 变小、人还在 `players` 里）。

验收：`npm test` → 84 文件 / 3031 断言全绿；`node scripts/journey.js` → 114 项通过。

---

## 2. 人数 2–5 ✅ 已完成

| 文件 | 锚点 | 改法 / 注意 |
|---|---|---|
| `pwa/js/game.js` | `:494` `slotCount` | 改成 `StateMachine.capOf(room)` ✅ —— 座位格子跟房间自己的上限走 |
| `pwa/js/game.js` | `:594` 补 AI 上限 | 改成 `StateMachine.capOf(room)` ✅ |
| `pwa/js/stateMachine.js` | `:212` 入房校验 | 改用 `capOf(room)`，文案带出真实上限 ✅ |
| `pwa/js/stateMachine.js` | `newRoom` | 新增 `cap: CONFIG.MAX_PLAYERS` ✅ |
| `pwa/js/stateMachine.js` | 导出 | 新增 `capOf(room)` ✅ |
| `pwa/js/stateMachine.js` | `:575` 「还差 N 人」 | 读 `MIN_PLAYERS`，不受影响 |

**老房间的兼容**：`room.cap` 缺失时（老数据、反序列化后）`capOf` 退回当前配置，
不会变成 `undefined` 让比较恒为假。

**测试口径**：三个既有测试（`engine` / `next-round` / `offline`）里有 6 人、8 人局的场景，
它们测的是发牌、座位表、掉线回来，不是上限本身 —— 这些场景在线上仍然合法（老房间）。
所以给这些 fixture 显式 `room.cap = 8`，让它们继续测原来的东西；
新的 5 人语义由 `pwa/test/player-cap.test.js` 负责。**不要把它们改成 5 人**，
那等于把「老房间还能不能正常跑」这条覆盖直接删掉。

`.room-grid` 在 5 格时的列数：8 格原是 4×2，5 格变 4+1 —— 已用截图确认不塌（`journey.js` 走真实建房）。

---

## 3. 准备态长在牌桌上 ✅ 已完成（版本 20261030y / sw v83）

### 3.0 实施结果（与下面这份计划的两处偏差，都已验证）

| 计划里写的 | 实际做法 | 为什么改 |
|---|---|---|
| 「座位环照原型的 `oppAngles` 弧长均分」 | **不画座位环**，复用对局页顶栏 `#game-top` 的对手头像条 | 线上对局页是「桌沿 + 三组纵向组槽」，没有椭圆座位环。为准备态单独造一个环，等于在同一个产品里放两套座位布局，开局那一刻必然跳一次。顶栏本来就把「已准备 / 未准备」画在头像角标上，复用它反而少一套样式 |
| 「底部按钮搬 `#btn-ready` + `#btn-leave` 等单颗」 | 搬整个 `.room-actions` 与 `.room-prev-row` | `.ghost-row` 的换行/等分规则挂在 `.room-actions .ghost-row` 上，拆开搬会让那条 CSS 留在原地、按钮散架 |
| 「新写一条 PWA 侧断言」 | `scripts/probe-table-ready.js`（33 条）+ `pwa/test/table-ready.test.js`（29 条） | 行为靠探针（按钮搬过去还能真的点），结构靠静态测试（开关/路由/单点显隐没被删） |

座位表（`#room-players`）仍照旧渲染，只是不显示 —— 这是有意的：`renderRoom` 里那一整套
「谁准备 / 还差几人 / 哪个按钮该露」的判断是同一个函数在跑，两条路径不可能跑偏；
反过来把网格渲染也分叉，才是真正会长出两个版本的地方。

### 3.1 做法：搬节点，不复制节点

`#screen-room` 里现有的元素**原样移进**牌桌层，id 一个都不改：

```
#room-code  #room-players  #room-hint
#btn-ready  #btn-add-bot  #btn-dissolve  #btn-next-back  #btn-leave
#btn-prev-replay  #btn-prev-result
```

理由：事件是绑在**元素**上的，`cloneNode` 出来的是两个没有任何 handler 的假按钮；
`scripts/journey.js` 也是按 id 点的（`document.getElementById('btn-ready').click()`）。
搬节点，这两条都不用动。

### 3.2 加一个开关

```js
// config.js
TABLE_READY: true,   // false = 完全回到 #screen-room，一行配置回滚
```

路由处（`game.js` 的 screen 切换逻辑）：`phase ∈ {WAITING}` 或 `phase === SETTLED && 就位态`
且 `CONFIG.TABLE_READY` → 显示 `#screen-game` + `#table-ready` 层，`#screen-room` 保持 `hidden` 但 DOM 完整。

### 3.3 几何直接照原型

| 项 | 原型实现 | 说明 |
|---|---|---|
| 竖屏 | 750 × 1623 | `geo()` 里 `portrait` 分支 |
| 横屏 | 1624 × 750 | 同上 `landscape` |
| 座位环 | `oppAngles(n, ring)` 弧长均分 | `span`：2 人 132°、3 人 176°、4/5 人 214° |
| 中央房间牌 | `roomHTML(g)` | 房间号 + 人数 + 起始分 |
| 托盘区规则卡 | `roomInfoHTML(g)` | 第一轮 / 第二轮 / 见底 / 起始分 / 我的战绩 |
| 底部 | `readyActs(g)` | 左「准备 / 取消准备 / 开始游戏 · n」，右「退出房间」 |

**关键约束：开局零跳变。** 准备态和对局态必须共用同一个 `geo()`，否则点了准备、
牌桌会「跳一下」再发牌 —— 这是原型里已经踩过并修掉的坑，落地时不要重新实现布局。

### 3.4 不要顺手改对局态

v82 只把 **WAITING/SETTLED 就位态** 画到牌桌上，**对局中的座位布局一行不改**。
`slotLayout.js` 的绝对定位 + safe-area 有一整套既有测试（`probe-safearea.js`、
`probe-viewport-fit.js`、`room-actions-fit.test.js`），动它等于把 v82 变成高风险批。

### 3.5 回滚

`CONFIG.TABLE_READY = false` → 节点仍留在 `#screen-room` 里（因为我们只是移动，不改结构），
切回去即可。灰度期间发现座位环在真机上压到刘海，就翻这个开关，不用回滚版本。

验收：`proto-flow.js` 的 25 条（原型侧）+ 新写一条 PWA 侧断言：
`WAITING` 时 `#screen-game` 可见、`#room-code` 可见、`#btn-ready` 可点、点完 phase 变 `ROUND1_SPLIT`。

---

## 4. 战绩页扩容

`#screen-records`（`index.html:518+`）加 6 项指标。

> **这一节原计划还有一张「五维牌风雷达」，v85 已整块撤除**（连同为了点亮最后一维
> 而新造的「主动收手」）。保留这段是为了记住当时的判断错在哪，不是待办。

当时的五维口径（`pwa/js/styleStats.js`，文件已删除）：

| 维度 | 公式 | 数据来源 | 结局 |
|---|---|---|---|
| 速度 | 场均每把用时 | 发牌时 `handStartedAt` | 撤（埋点只服务这张图） |
| 防守 | 1 − 我见底局数 / 因见底结束的局数 | `endReason==='scoreZero'` | 撤（数据本身可信，但没人看） |
| 互动 | 场均表情条数 | 战绩字段 `myEmoji` | 撤（同上） |
| 策略 | 「我见底的局」里收过手的局占比 | 为此新造了「主动收手」 | 撤（先有图才有功能，方向反了） |
| 获胜 | 近 20 局胜率 | 已有 | 撤（胜率还在汇总卡里） |

**教训**：给一张图找数据，会一路找到「造一个玩法」这一步。判断顺序应该是
「玩家要不要做这件事」→「做了要不要看」→「看了要不要图」，
而不是反过来。详细复盘见 `docs/release-progress.md` 的 v85 一节。

**6 项 KPI 其实早已齐全**（总局数 / 总胜局 / 总胜率 / 最高连胜 / 单局最高 / 总得分），
分在汇总卡与纪录条两块里，雷达撤掉之后这一页就是这两块 + 最近 10 局 + 流水。

验收：`node scripts/probe-records.js`、`node scripts/probe-records-cloud.js`、
`node scripts/probe-safearea.js`（横屏左栏一屏装下）。

---

## 5. 表情 / 短语（唯一碰 WS 协议的一项）

| 步骤 | 内容 |
|---|---|
| 资产 | `docs/prototypes/assets/emoji/e0…e12.png`（13 张 96×96 带 alpha）→ `pwa/assets/emoji/` |
| 新文件 | `pwa/js/emoji.js`：面板（`panelPos` 右→左→下→上 + `fitPanel` 量真实高度）、气泡（`bubBox`）、飞行（自己发不飞，给别人发走直线） |
| 协议 | `{ t:'emoji', to, id }`，服务端**只转发不落库**（不进 `records`、不进云同步、不进回放） |
| 限流 | 1 条 / 2s / 人，超限静默丢弃 |
| 静音 | 跟随现有 `data-audio-toggle`，不新增开关 |

**风险点**：这是 v82 唯一会让**老客户端**收到未知消息类型的地方。
上线前必须确认 `server/hub.js` 对未知 `t` 是静默忽略而不是抛错 —— 否则一个没更新的客户端
会把整条连接搞断。这条要单独写一个 `server/test` 用例。

回滚：`CONFIG.EMOJI = false`，入口按钮不渲染，协议保留（服务端转发逻辑留着无害）。

---

## 6. 合入顺序与验收

顺序：**1 常量 → 2 人数 → 3 准备态 → 4 战绩 → 5 表情**

为什么这个顺序：
1 是纯数值，最先合、最快验证；
2 依赖 1；
3 是最大的一块 UI，但它不碰协议，放在 5 之前可以先单独灰度；
5 唯一碰协议，放最后，出问题时能精准定位到「就是它」。

### 验收命令（全部必须绿）

```bash
npm test                                   # 全量单测（含 config-sync / room-actions-fit / render-guards）
node scripts/journey.js                    # 真浏览器走完注册→建房→补AI→两轮→结算→战绩→排行榜
node scripts/probe-room-actions.js         # 房间页按钮（搬进牌桌后这条最容易漏）
node scripts/probe-safearea.js             # 刘海 / 安全区（准备态换了布局，必须重跑）
node scripts/probe-viewport-fit.js         # 视口适配

# 原型侧（设计稿与规则）
node scripts/proto-flow.js                 # 25 条流程
node scripts/e2e-score.js                  # 1929 条分数断言 / 39 组结算
node scripts/review-rule-parity.js 800     # 四种牌型 × 含王 × 2/5 人 × 800 组
node scripts/shot-prototype.js             # 55 组截图，越界 0 / 溢出 0
node scripts/build-proto.js --check        # 单文件产物与源同步
```

### 灰度

- 11/2（周日）灰度：内部账号 + 白名单房间
- 11/3（周一）全量：灰度 24h 无「白屏 / 按钮点不动 / 座位压字」即全量
- 出问题：先翻 `TABLE_READY`，再翻 `EMOJI`，都不需要回滚版本号

---

## 7. v83 的门槛：组级写分

### 7.1 改造面比预想的小

`stateMachine.js:664 settleRound(room, round)` **已经是逐组调用引擎**：

```js
groupKeys.forEach(function (key) {
  var r = Engine.settleGroup(key, entries);
  for (var pid in r.deltas) { pp.score += r.deltas[pid]; }
  results.push(r);
});
room.results['round' + round] = results;   // ← 每组 delta 已经在 room 里
```

所以「逐组结算」不是重写，是把三件事从 `forEach` 外面搬进 `forEach` 里面：

1. **应用分数**：已经是逐组，不用搬；
2. **见底判定**：现在在整轮 forEach 之后（`:736` `room.phase = PHASE.SETTLED`），要提前到每组之后；
3. **阶段切换 / 广播**：现在一轮广播一次，要改成一组一次（`resultSeq` 递增）。

### 7.2 必须先补的那条断言

**现在 0 条断言验分数。** 上线门槛是房间级分数对账：

```
每人结算页净得  ==  Σ(room.results 里每一组的 deltas[pid])
每组的 Σdeltas  ==  0（零和）
见底者的净得    <=  0
```

`room.results` 已经带着每组的 `deltas`，所以这条断言不难写 ——
难的是现在没有地方挂它。建议放 `server/test/e2e.test.js`（它已经能跑完整局），
读结算页 DOM 的数字，和服务端 `room.results` 复算值比。

原型侧的等价断言已经写好并做过变异自测（`scripts/e2e-score.js`，1929 条），
它证明的是「渲染出来的分数 == 引擎算的分数」；PWA 侧要证明的是
「写到 `player.score` 上的分数 == 引擎算的分数」，这是两件事，不能互相替代。

### 7.3 连带影响（任何一处没跟上就是线上事故）

- `records.js` 的云同步幂等键：现在按「一把」写，组级之后一把会有多条
- 断线重连的重放：重连时服务端要把「已经结算到第几组」告诉客户端
- AI 补位：见底后 AI 提前出局，补位逻辑要认得出
- `anyScoreChange` 的判据（`:683`）：它靠「有没有一组真的动过分」判断这一局算不算数，组级之后仍然成立，但要重跑一遍

---

## 8. 未决项 · 已全部收口（R6）

> 三条都给了结论，不再挂着。**结论以线上代码为准，原型是设计稿，不是标准。**

### 8.1 「两轮打完」算不算一局结束？

**结论：不算。以线上为准，原型那段改掉。**

| | 行为 |
|---|---|
| 原型 | 两轮打完 → 结束、回准备、分数清零 |
| 线上 | 无人见底 → 续打下一把，分数延续；只有见底才 `SETTLED` |

为什么线上是对的：

- 这个玩法的「局」由**多把**组成，一局结束的条件写在规则卡上：
  「见底：分数 ≤ 0 出局，最后一人胜出」。两轮 = 一把，一把打完当然不是一局打完。
  改成两轮清零等于取消「局」这个概念，规则卡那一行就得删掉。
- 原型里那段「两轮结束清零」是早期还没做分数持久化时的占位逻辑，
  不是产品决策 —— 它甚至没有对应的界面文案去解释「为什么打完两轮就结束了」。
- R2 之后「等下一把」这一屏已经理顺了（顶栏显示「准备中 / 等人报名」，
  报名人数 `2/5`），玩家看到的是「这把结束了，再来一把」，而不是「卡住了」。

**唯一必须做的事已经做了**：文案要能自解释。规则卡上那三行
（`第一轮 比大小 → 十点半 → 飘三叶` / `第二轮 比大小 → 斗牛` / `见底 分数 ≤ 0 出局，最后一人胜出`）
就是回答「为什么打完两轮还能打」的唯一依据 —— 所以它不许被删、不许被折叠。

原型侧已在 R6 标注：`docs/prototypes/circle-table.html` 里 `reason:'end'` 那段
加了「与线上不一致，勿参照」的注释 —— 不标的话，下一个读原型的人会以为两轮就该结束。

### 8.2 老 8 人房怎么处理？

~~未决~~ → **R1 已落地**：`room.cap` + `capOf()`。新房间按 `CONFIG.MAX_PLAYERS`（5）开，
老房间按自己建时的 `cap`（8）继续跑完，不踢人、不缩容。见 §1、§2。

### 8.3 「见底当场出局」v82 里做不到

~~做不到~~ → **R5 已做到**（版本 `20261031b`）。

- 判定粒度从「整轮」改成「每组」：每组结算完立刻判 `score <= 0`，命中即 `break`。
- 判的是 `pool`（参与了这一组的人），不是 `activePlayers` ——
  已经 `left` 的人分数冻结，不该被这一组的结算连带判出局。
- 语义仍保持 `policy='end'`（见底即整局结束），没有换成原型的 `policy='keep'`。
  换语义要连带改结算页、战绩口径、AI 补位，属于另一版的事。

所以 **验收标准从这一刻起可以和原型对齐了**：原型里是当场出局，线上也是。
唯一还不同的是 8.1 那条（两轮 vs 一局），而那条已经明确「以线上为准」。

---

## 附：本轮已完成的发布前置

| 项 | 状态 | 证据 |
|---|---|---|
| 原型不再有第二份规则实现 | 完成 | `<script src="../../pwa/js/engine.js">`，删掉 ~170 行手抄判定 |
| 分数级断言（含变异自测） | 完成 | `scripts/e2e-score.js`：1929 断言 / 39 组 / 0 失败；故意改错分能被抓红 |
| 单文件交付物 | 完成 | `scripts/build-proto.js` → `dist/circle-table-single.html`（453 KB，引擎 + 13 张表情全内联） |
| 规则差分 | 完成 | `review-rule-parity.js 800`：四牌型 × 含王 × 2/5 人，0 不一致 |
| 流程 / 截图回归 | 完成 | 25 条流程 + 55 组截图，越界 0 / 溢出 0 |
| 入库 | 见提交记录 | `docs/prototypes/`、`scripts/*.js`、`docs/*.md` |
