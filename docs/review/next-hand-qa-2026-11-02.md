# 「整局结束 → 再来一把」状态流 · 边界场景审计（QA 过程审）

- **审阅对象（只读快照）**：`D:/tmp/lxw-review-head`，提交 `f16f677` 的 worktree
- **审阅方式**：纯静态路径走查（Read/Grep）。**按指令未修改任何文件、未运行任何测试/探针**
- **本轮未做的取证（如实留白）**
  - 「采信矩阵」：上游给的是审阅清单（9 个问题 + 文件指针），**不是带数字的结论**，没有需要我复算的上游数值。该表 **N/A**。
  - 「判定工具自验」：本轮没有写任何脚本/正则/枚举清单用于给他人定性，只有人工走查。该表 **N/A**。
  - 手感三判据（操作响应 / 消除时机 / 穿模）与真机试玩：**本轮完全未覆盖**（禁止跑探针）。本报告全部结论来自代码路径推导，不是实测。
- **口径校正**：任务里提到的 `handNo` 在代码中**不存在**。实际字段是 `handCount`（每局内的把序号，`startNextRound` 归 1）、`handId`（每把唯一号，永不归 1，`dealAll` 递增）、`handSeq`（场次号，只在结算时 +1）。下文按真实字段名写。

---

## 一、一句话结论

**不能。** 状态机本身的报名/准备/把数三条计数是干净的（这一层没有自相矛盾），但**终局之后的人员生命周期是断的**：结算页掉线超过约 3 分钟的人会被判成「弃局」并当场改写别人屏幕上的名次与冠军；他一走，2 人房剩 1 人就从「开不了下一局」滑进死锁（补 AI 被 phase 挡住、解散被 SETTLED 挡住、UI 却提示他「等其他人点开始下一局」）。也就是说：**这套流程能撑住「大家都稳稳坐着」的牌桌，撑不住真实牌桌的「有人走开一下」。**

---

## 二、风险矩阵

> 「静默失败」= 不报错、不闪红、控制台也可能看不到，玩家只能感到「不对」或什么都不知道。这类优先级最高。

| # | 场景 | 当前行为 | 依据（文件:行） | 严重度 | 静默 | 现有测试 |
|---|---|---|---|---|---|---|
| R1 | **结算页掉线 > 宽限 → 被判弃** | `finalizeLeave` 只有 WAITING 分支特殊处理，SETTLED 下直接 `p.left=true`。结算排名把 left 玩家剔出排名、沉底、角标写「—」，**冠军顺位让给下一个人**；同时 `reconnect` 在 SETTLED 一律拒绝回座，客户端收到「本局已结束，请等下一把」后 `cleanupRoom` 回首页 | `hub.js:270-272`（close→markDisconnected+grace）、`hub.js:1243-1258`（grace→finalizeLeave）、`stateMachine.js:1433-1459`（无 SETTLED 分支）、`stateMachine.js:1421`（SETTLED 拒绝回座）、`settleView.js:600-622`（left 不计名次）、`settleView.js:653-670`（皇冠/「—」）、`game.js:4757-4763`（回首页） | **P0** | **是** | **未覆盖**（`finalizeLeave` 在全部测试里从未在 SETTLED 下调用） |
| R2 | **剩 1 人 → 永远开不了下一局（死锁）** | `canStartNext` 分母是「已报名的人」，`< MIN_PLAYERS(2)` 返回 false；`addBot` 硬性要求 `phase === WAITING`，而 phase 自建房后再也不回 WAITING；`proposeDissolve` 在 SETTLED 直接拒。房间变成只能退出重建的僵尸房，UI 仍在提示「还差 1 人才能开下一局，等其他人点开始下一局」 | `stateMachine.js:1099-1103`、`config.js:19`、`hub.js:745`、`stateMachine.js:1312`、`game.js:567-570`、`game.js:581-586` | **P0** | 否（有提示，但提示指向一件永远不会发生的事） | 部分：`next-round.test.js` [10] 只断言 `canStartNext===false`，没断言「有出路」 |
| R3 | **最后一把的云端战绩落在 500ms 异步窗口里** | `record()` 只 `_scheduleFlush()`（500ms 后异步写盘）。SIGTERM/SIGINT 会同步 flush，但 `kill -9` / OOM / 容器重建 / 断电不会 → 这一场只有本机 Records 有，云端没有 | `hub.js:985`（落库挂在广播里，同 tick）、`profile.js:463-516`（record→scheduleFlush）、`profile.js:270-277`（500ms）、`index.js:1349`（SIGTERM 才 flush） | **P1** | **是**（玩家看到「打满 10 局」，战绩页却没有这局） | 未覆盖（`persist.test.js` 只测「正常退出后还在」） |
| R4 | **逐人写库无 try/catch，且幂等标记先置** | `_profiledSeq = room.handSeq` 在写库**之前**置；随后 `players.forEach` 里直接调 `profiles.record`。第 2 个人抛异常 → 第 3 个人永远不写，且下一次广播因 `_profiledSeq===handSeq` 直接早退，**永不重试**；`room.achRun = null` 在循环之后，被跳过 → 成就桶留到下一局 | `hub.js:1060-1061`、`hub.js:1106-1119`、`hub.js:1122` | **P1** | **是** | 未覆盖 |
| R5 | **作废局的 `achRun` 不清，下一局重复累加成就** | `_persistSettlement` 见 `room.voided` 直接 return（早于 `achRun=null`）；`startNextRound` 的重置清单里**没有** `achRun` → 上一局（作废）攒的牌型桶会被并进下一局的档案 | `hub.js:1078`、`stateMachine.js:948-950`、`stateMachine.js:1155-1193` | **P1** | **是** | 未覆盖 |
| R6 | **多标签页 / 残留连接：被 evict 只通知一条连接** | `_evictFromRoom` 只 `this.byPlayer.get(pid)`（每玩家仅保留最近一条连接）。另一条标签页 `ctx.roomId` 仍指向该房间，继续收到「自己不在名单里」的 room 视图 → 客户端 `renderGame` 里 `if(!me){render();return;}` 与 `render()` 互递归 → 栈溢出被 `roomStore` 订阅回调的 `try/catch{}` 吞掉 → **该标签页静默冻结在旧屏** | `hub.js:562-574`、`hub.js:1318-1321`、`game.js:758-760` + `game.js:437-441`、`roomStore.js:532-538` | **P1** | **是** | 未覆盖（`render-guards.test.js` 只管 myId 拼接，无 me===null 守卫） |
| R7 | **`beginRevise` 用非幂等分支重挂分牌计时器** | `SM.beginRevise` 第二次调用幂等返回 ok（`revising===round`），但 hub 随后仍无条件 `_armOneSplitTimer(..., idempotent=false)` → 清掉旧 timer 重挂满 60 秒，`splitStartedAt` 也重置。刷新页面（`state.reviseRound` 归 -1）后再点一次「改一下」即可复现，反复刷新可无限续 → 全桌卡在分牌 | `hub.js:636-648`（644 行非幂等）、`stateMachine.js:719`（幂等 ok）、`hub.js:1152-1156`、`hub.js:1181` | **P1** | 部分（倒计时可见回跳，但无报错无告警） | 未覆盖 |
| R8 | 中途结束本局把 endReason 二次覆盖，但不再落库 | 解散投票进行中若有人离开导致人数不足 → `maybeEndGame` 先落 SETTLED（`someoneLeft`）；随后一次投票触发 `finishDissolve` → endReason 改写成 `dissolve`，`settledAt` 已有 → `handSeq` 不变 → `_persistSettlement` 幂等早退。结算页说「本局提前结束」，云端档案记「有玩家离开」 | `stateMachine.js:1391-1399`（不清 dissolve）、`stateMachine.js:1259-1271`、`hub.js:1060` | P2 | 是 | 未覆盖 |
| R9 | `leaveRoom` 在 SETTLED 不清 `wantNext` | 只清 `ready`。本身不构成矛盾（`nextRoundPlayers` 过滤 left），但若同一个人之后用房间号重新加入，`joinRoom` 会把 `wantNext` 置 true → 他成了「必须点准备否则挡住别人」的阻塞项，而他只是想回来看结算页 | `stateMachine.js:360-370`、`stateMachine.js:310`、`stateMachine.js:1091-1094` | P2 | 否 | 未覆盖（`next-round.test.js` [8b] 测的是 left 被清，不是 wantNext 语义） |
| R10 | `records.rounds` 存的是场次号，不是把数 | `rounds: room.handSeq`（场次），而顶栏「第 N/M 把」用 `handCount`/`handLimitOf`。两个口径都合理，但字段名会诱导下一个人拿它当「打了几把」直接展示 | `historyKit.js:184`、`game.js:1213-1217` | P2 | 是（未来误用） | 未覆盖 |
| R11 | 房间回收计时器触发一次后不再续挂 | `_armRoomRecycle` 只在 createRoom/joinRoom 布防；触发时若有活连接则只 `delete` 计时器、不续挂 → 之后这个房间只剩 `_broadcast` 里「全员 left 且无活连接」这一条回收路径 | `hub.js:1266-1278`、`hub.js:997-999` | P2 | 是 | 未覆盖 |
| R12 | `_view` 未剔除内部字段 | `Object.assign({}, room)` 会把 `_profiledSeq` 等内部标记原样广播（`achRun` 已 `delete`，其它没管） | `hub.js:934-969` | P2 | 是 | 未覆盖 |
| R13 | 报名态 / 准备态是否互相矛盾 | **不矛盾**：没报名不能准备（`setReady` 明确拒绝并给「先点开始下一局」文案）；报名时 `ready=false`；撤回报名时 `ready` 一起清；left 时 `ready` 清、且被 `nextRoundPlayers` 过滤 | `stateMachine.js:397-403`、`1116`、`1139-1143`、`1091-1094` | — | — | **已覆盖**（`next-round.test.js` [1][2][12][12b]） |
| R14 | 连点「开始下一局」/ 并发触发开局 | 幂等：`wantNext` 重复置 true；`autoStartIfReady` 在 phase 一变立即为 false；开局后 `wantNext/unWantNext` 回 `NEXT_STARTED` 友好文案 | `stateMachine.js:1107-1119`、`1218-1229`、`hub.js:543-554` | — | — | **已覆盖**（[7][12]） |
| R15 | 分牌超时 vs 手动提交（同一 tick 竞态） | timer 回调内先 `isRoundLocked` 复检、再 `forfeitRound`；单线程无交错 | `hub.js:1157-1172` | — | — | **已覆盖**（`forfeit.test.js` / `forfeit-timeout.test.js`） |

---

## 三、P0 / P1 逐条复现步骤（手动可复现，写成「几号位 / 做什么 / 看到什么」）

### R1（P0）结算页切走 3 分钟 → 被标「弃局」，冠军换人，且回不来

1. 两台手机（或两个浏览器窗口）A、B 登录两个账号，A 建 2 人房，选 3 把，打完第 3 把进入结算页。
2. 结算页上 A 是第 1 名（🏆），B 第 2 名。
3. **A 把手机锁屏 / 切到微信，持续 3 分钟以上**（服务端心跳 30s×2 判死后还叠加 90s 宽限，合计约 3 分）。
4. 看 B 的屏幕（B 什么也没做）：约 3 分钟后，同一张结算页上 **A 的行掉到列表末尾、角标从「1」变成「—」、名字后面出现「（弃局）」、🏆 换到 B 头上**；「已经有 N 人进入下一局」的计数也跟着变。
5. A 亮屏：屏幕闪一句「本局已结束，请等下一把」，然后**直接回到首页**；再点「创建房间」才知道自己已经不在那桌了。刷新、返回都回不到结算页。

根因链：`onClose` → `markDisconnected` → 90s → `finalizeLeave` 没有 SETTLED 分支（`stateMachine.js:1453`）→ `left=true`；`settleRank` 把 left 剔出排名（`settleView.js:602-615`）；`reconnect` 对 left+SETTLED 一律拒绝（`stateMachine.js:1421`）。

**这条最要紧，因为它不是「某人操作错了」，而是「某人什么都没做」。**

### R2（P0）2 人房有一个人走了 → 另一个人再也开不了下一局

前置用 R1 之后的状态最快复现（一个人被判弃即为 left）：

1. A、B 打完一局进入结算页，B 走了（退出或如 R1 被判弃）。房间只剩 A 在场。
2. A 点「开始下一局」→ 回到房间页（就位态）。A 点「准备」。
3. 看到：一直停在「还差 1 人才能开下一局，等其他人点开始下一局」，永远不动。
4. A 想补 AI：**没有「补 AI 队友」按钮**（`game.js:581-586` 要求 `phase===WAITING`，此刻是 SETTLED）。
5. A 想「结束本局」：按钮在就位态被隐藏（`game.js:616-617`），即便调到也会被「对局已结账」拒（`stateMachine.js:1312`）。
6. A 唯一出路：退出房间重建 —— 房号变了，得重新拉人。

（如果 B 恰好还记得房号并手动「加入房间」，B 会以 `wantNext=true / ready=false` 回来，点一次准备就能开。但 R1 里客户端已经把 resume 令牌清掉了，房号也随结算页一起丢了。）

### R3（P1）杀进程 / 容器重建丢掉最后一把的云端战绩

1. 打完最后一局，结算页显示「打满 3 局，本局结束」。
2. 服务端在 500ms 内被 `kill -9`（或 OOM、或 docker 重建）。
3. 重启后查该玩家档案：**这一场不在 `recent` 里**，排行榜、场次、连胜都没算这一场；而客户端本机「战绩」列表里有（`historyKit.js:151-198` 已写 localStorage）。
4. 玩家看到的是「战绩页少了一场，但它明明结算了」——两套数据源各说一套。

（正常 `SIGTERM`/`Ctrl+C` 不会丢，`index.js:1349` 会同步 flush；只有非优雅终止会丢。）

### R4（P1）3 人局里第 2 个人写库抛异常 → 第 3 个人静默丢战绩、成就被带进下一局

1. 3 人局打满把数进入 SETTLED，`_broadcast` 触发 `_persistSettlement`。
2. `players.forEach` 第 2 个人（按 `room.players` 顺序）在 `profiles.record` 内抛异常（成就桶结构异常 / `mergeInto` 异常 / 序列化异常等）时，异常会冒到 `onMessage` 的 catch，回一条「服务异常」给**触发这次广播的那个人**。
3. 结果：第 1 人已写、第 2/3 人没写；`_profiledSeq` 已等于 `handSeq`，**之后所有广播都早退，不再重试**；`room.achRun` 未清。
4. 下一局结算时，上一局那份 `achRun` 被一起并进档案 → 成就重复累加。

无需真的注入异常也能验：把 `room.achRun.byPid[某 id]` 塞成非法结构跑一次结算即可（当前无任何测试触碰这条路径）。

### R5（P1）作废局的成就桶漏到下一局

1. 3 人局，第 1 轮结算后全员 deltas 恰为 0（有牌型但总分对消），`anyScoreChange` 仍为 false。
2. 有人发起「结束本局」并全员同意 → `voided=true` → `_persistSettlement` 早退，`achRun` 未清 → `startNextRound` 也不清。
3. 下一局正常打完 → 这一局的成就里多出上一局（已作废）的牌型。
（比 R4 更窄，但只要 R5 的桶存在，`voided` 语义就有一半是漏的：「作废」应当什么都不发生。）

### R6（P1）同一账号开两个标签页 → 没被通知的那个标签页静默冻结

1. 同一账号在手机和电脑各开一个页面，都进入同一房间（`_hasLiveConn` 让两条连接都算在线）。
2. 两人都没有点「开始下一局」；这时其他人凑齐并开了下一局。
3. 服务端只给**最近绑定的那条连接**发 `roomDeleted{reason:'nextRoundStarted'}`，另一条标签页继续收到「自己不在名单里」的房间视图。
4. 那个标签页：`renderGame(room)` 里 `me` 为 null → `render()` → 又走回 `renderGame` → 栈溢出 → 被订阅回调的 `try/catch{}` 吞掉 → **屏幕停在被踢之前那一帧，点任何按钮都没有反应，也没有任何提示**（连控制台都不一定有）。

### R7（P1）刷新后点一次「改一下」= 把全桌分牌倒计时重置 60 秒

1. 3 人局第一轮，A 已提交并点过「改一下」（服务端 `p.revising=1`，计时器在跑，剩 20 秒）。
2. A **刷新页面**（内存里的 `state.reviseRound` 归 -1，界面重新给「改一下」按钮）。
3. A 再点「改一下」：服务端 `SM.beginRevise` 幂等返回 ok，但 hub 仍调 `_armOneSplitTimer(..., false)` → 清掉旧 timer 重挂 60 秒。
4. B、C 屏幕上的分牌倒计时**从 20 秒跳回 60 秒**；A 每刷新一次 + 点一次，就再续 60 秒。B、C 已提交，只能一直等（`isRoundLocked` 判 A 未定稿，不会结算）。

---

## 四、测试缺口清单（断言意图 + 独立复算的期望值）

> 期望值一律来自需求/手算，不引用被测常量。下面每条都注明「改完应当从 FAIL 变 PASS」的判据强度。

| # | 该补的断言 | 期望值（独立来源） | 守的是 |
|---|---|---|---|
| T1 | 给定 A=7 分、B=3 分、C=1 分（我自己摆的分数，不是读别人算出来的），房间进 SETTLED 后对 A 调 `finalizeLeave`；断言 `settleRank(room)` 里 **A 仍是 rank=1、champion=true、abandoned=false**，且三行的 rank 序列仍是 `[1,2,3]` | 7>3>1，第一必是 A —— 出自手算排序，不读 `settleRank` 的中间值 | R1（结算后判弃不得改写名次） |
| T2 | SETTLED 下被判弃的人，`reconnect` 应**成功**或至少返回一个「只能看结算、不能报名」的可用态；断言 `reconnect(...).ok === true` 或等价 | 「他已经打完这一局了，掉线不该改变他的成绩」——出自「结算后不可变」这条不变量 | R1（回座） |
| T3 | 2 人房、1 人 left、phase=SETTLED、房主执行**一个**合法动作后，≤1 步内 `phase === ROUND1_SPLIT` | 「再来一把必须可达」，出自需求；不看 `canStartNext` 的实现 | R2（死锁必须有出口） |
| T4 | 结算时从磁盘把档案文件读回（先 `flush()`），断言该玩家 `recent.length` **恰好 +1**；再连发 5 次广播，断言仍是 +1 | +1 出自「一局记一场」的定义 | R3/R4（一局恰好一次，且一定写一次） |
| T5 | **不调 `flush()`**，直接读盘：断言 `recent.length` 已 +1（当前会 FAIL） | 同上；这条 FAIL 就是 R3 的证据 | R3（不许把战绩留在 500ms 内存里） |
| T6 | 让第 2 个玩家的 `profiles.record` 抛异常；断言第 3 个玩家**也被记上**，且该场次可重试（`_profiledSeq` 不得先置） | 3 个真实玩家 3 条记录 | R4 |
| T7 | `voided=true` 的局结算后断言 `room.achRun === null`；再开下一局、打完，断言成就增量**只含这一局**的牌型 | 「作废 = 什么都不发生」 | R5 |
| T8 | 一个 pid 有两条连接，触发 `_evictFromRoom`：断言**两条**都收到 `roomDeleted`（或断言 `_hasLiveConn(pid, roomId) === false`） | 「同一账号的每个窗口都必须知道自己被请出去了」 | R6 |
| T9 | 用计数桩：`render()` 在 `myId` 不在 `room.players` 且 phase 为 SPLIT 时，单次调用内 `renderGame` 调用次数 = **0**，并落到一个明确的屏 | 递归一次就是无穷次；0 次是唯一可接受值 | R6（不许靠栈溢出当兜底） |
| T10 | 连续两次 `beginRevise` 之间断言 **`splitStartedAt` 不变**（第二次调用后等于第一次的值） | 「一个回合只有一条 60 秒，不因操作次数延长」 | R7 |
| T11 | 结算页断言：顶栏「第 N/M 把」里的 N 等于 `history` 里**最后一条记录的 `hid` 对应的把序号**（按 hid 分组后取组内最大把序） | 两个数字描述同一个事实，必须相等 —— 由「第几把」这句话本身的语义给出 | R10 |
| T12 | SETTLED 期间 `leaveRoom` 之后断言 `wantNext === false`（或明确断言「重新加入后不自动报名」） | 「没点开始下一局 ≠ 我要打下一局」 | R9 |

**覆盖良好、无需补的**（避免重复投入）：报名/准备互斥与撤回（`next-round.test.js` [1][2][12][12b]）、分母是报名者（[3][10]）、没报名的人被 evict 且拿到原因（[4][5]）、AI 自动报名（[6]）、结算期入房（[8b]）、离开触发结算（`leave-settle.test.js`）、弃权（`forfeit.test.js`）、把数上限与续局沿用（`handlimit-settle-parity.test.js`、`hand-limit.test.js`）、落库幂等键（`idempotency-key.test.js`）、作废不落库（`dissolve-archive.test.js`）。

---

## 五、不建议现在动的项（低收益 / 高风险）

1. **不要把 `phase` 在结算期改成 WAITING 来解决 R2。** `wantNext` 的存在前提就是「phase 故意停在 SETTLED，否则没点的人被广播顶出结算页」（`stateMachine.js:1084-1088`）。要解 R2，正确方向是**给 addBot 开一个「仅 SETTLED + 仅房主 + 只在房间已无望凑人时」的第二个窗口**，而不是动 phase。
2. **不要为了 R3 改成每写一条就 `writeFileSync`。** `profile.js:292-298` 已写明同步写在大档案下会阻塞事件循环几十毫秒。低成本做法是：结算路径显式调一次 `flush()`（调用点极少，一局一次），而不是全局改成同步。
3. **不要动 `handCount` 的归 1 语义。** 它同时被 `handKey()`（草稿判重）、`handProgressText()`（顶栏）、`settleRound` 的把数上限判定三处依赖，`stateMachine.js:1013-1015` 的注释已经写明「判定必须在 +1 之前」。想统一口径就只用 `handSeq/handId`，别碰 `handCount`。
4. **不要给 `settleRank` 加「left 但保留名次」的开关。** R1 的正确修法是在**源头**不让 SETTLED 期间判弃（`finalizeLeave` 加 SETTLED 分支 → 只 markDisconnected，不 left），结算排名逻辑本身是对的。
5. **不要顺手重写 `_armOneSplitTimer` 的幂等语义**（R7 只需让 `beginRevise` 复用已存在的 key，不要给 `idempotent` 再加第三态），这一块已经因为「翻轮必须先跑 _autoBots 再挂 timer」吃过一次亏（`hub.js:977-983`）。
6. **`_profiledSeq` 广播出去（R12）、房间回收计时器不续挂（R11）**：都不值得单独发版，跟着别的改动顺手处理即可。

---

## 六、给主理人的退回建议（按步骤归属）

| 步骤 | 结论 | 缺口 | 退回给谁 |
|---|---|---|---|
| 「终局 → 再来一把」状态流 | **不达标** | R1 R2（P0）+ R3~R7（P1） | 状态机/服务端 = R1 R2 R5 R8 R9；服务端落库 = R3 R4；连接与多端 = R6；分牌计时 = R7 |
| 报名制本身（wantNext/ready/canStartNext） | **达标** | 仅 R9/R10 口径提示 | 无需退回，记入备注 |
| 真机手感 / 视觉 | **未验收**（按指令禁止跑探针与试玩） | 需要另开一轮带真人试玩 | — |

**结论：不通过（阻断项 R1、R2）。** R1 的杀伤力在于它由「玩家什么都没做」触发，而且改动的是**已经结束的比赛结果**；R2 是它的必然下游。两条修好之前，「整局结束 → 再来一把」这条主路径不适合交付给真实牌桌。
