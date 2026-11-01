# 六选五 · 全量 Review

> **覆盖范围：v44–v81（2026-10-29 ~ 10-30）。** 这是一份**持续追加的 review 日志**，
> 不是一个会自动更新的现状文档 —— 它的价值在于「怎么发现的」，不在于「现在是什么样」。
>
> **v82 之后的每一轮改了什么，看 `docs/release-progress.md`**（那里按轮次编号成章，
> 每章都有版本号、改动清单、验收数字、已知限制）。**已知问题看 `docs/BACKLOG.md`。**
> 本文档里那些「未修」的结论，有一部分在 v82–v103 之间已经修掉了，
> 判断某条是否还开着，以 BACKLOG 为准。
>
> v82–v103 的 8 件事（不在这里重复展开）：
> 准备态进牌桌 / 表情短语 / 战绩扩容（v82）→ 圆桌竖屏与平板横屏（v87/v88）→
> 五屏幕档位 + 头像系统（v89–v91）→ 牌型反馈与特写幕（v92–v98）→
> 局数成为唯一终局（v99–v103）。
>
> 审查日期：2026-10-29
> 范围：`server/` 全部 5 个模块、`pwa/js` 全部 10 个模块、`pwa/index.html`、`pwa/admin.html`、`pwa/css`、`sw.js`、`manifest.webmanifest`、`scripts/`、`README.md`
> 规模：源码 15701 行 / 测试 10176 行（v49 时点；测试代码已近源码的 2/3）—— **v103 时点已远超此数，见 `release-progress.md`**
> 方式：**读码 + 实际运行验证**。凡标「实测」的都有可复现的输出；标「读码」的是静态分析结论。

## 结论

功能完整度和工程纪律都在中上水平——双端同源、广播按视角裁剪、令牌替代裸 playerId、异步 scrypt、幂等落库、损坏留档，这些都不是随手写能出来的。

但有三类问题绕不过去：

1. **一条数据恢复链路是断的**：发布前的备份脚本把账号字段丢了。线上主文件还在，所以现在没事；一旦容器重建，全员无法登录。
2. **两个「卡住」场景没有出口**：最后未提交的人点离开、或解散投票发出后没人响应，房间会永久停在原地。
3. **离线能力从未生效过**：Service Worker 的预缓存清单全是裸路径，网关一律 403，`cache.add()` 全失败并被静默吞掉。

下面按严重度列。**P0 两条建议今天就处理。**

---

> **状态：v45 ~ v49 已把本文档全部条目修完，唯 P3-6（观战）有意推迟。**
>
> | 批次 | 范围 | 内容 |
> |---|---|---|
> | v45 | P0-1、P0-2 | 备份丢 `account`、最后未提交者离开导致房间永久卡住 |
> | v46 | P1-1 ~ P1-4、P1-11、P2-2 | SW 预缓存、迟到错误回包强制登出、解散投票无超时、弃权后能反悔、牌桌第三组被裁 |
> | v47 | P1-5 ~ P1-8、P2-1、P2-3 ~ P2-12 | 令牌吊销、删号验密码、进房限流、密钥轮换、WS 缓冲、昵称、写盘、榜单缓存、IP 总闸、重连补时限 |
> | v48 | P2-13 ~ P2-18、D-1 ~ D-3 | 弃局确认粒度 + 只读 `peekRoom`、消息级限流、health 版本号、UI 里的「0 分」、**「清空排行榜」保留账号**、探针自清理、三份文档 |
> | v49 | P3-1 ~ P3-5、P3-7 ~ P3-11 | gzip、删 1MB 死图、SW 超时兜底、CI + 扫描式测试入口、前端错误上报、房间内回放、4 步新手引导、Web Share、`start_url` 去硬编码、请求体超限回 400 |
>
> 过程中**新发现 6 条**（P2-14 ~ P2-18、P3-11），都已建档并同批修完。
> **P3-6（观战）本轮未做**，理由见该条正文（37 处 `state.myId` 的 null 分支 + 观战 UI 无测试覆盖）。
>
> **v50（2026-10-29 09:5x）另做了一次「是不是优秀产品」的全量复评，见文末第七章。**
> 那一轮新增 7 条 **P4-1 ~ P4-7**，**全部未修**（按你的指令只做评估）。
> 其中 P4-1（切后台回来最长 60s 桌面冻住）建议优先处理，成本 3 行。
> 值得记住的是它们的来路，没有一条是靠"通读代码"想出来的：
>
> - P2-9 的缓存失效漏了 `remove`/`reset` —— 测试红了才看见；
> - P2-14 消息级限流缺失 —— 写测试时循环狂发打出来的；
> - P2-15 health 版本号永远不变 —— 写发布核对步骤时发现照实写就是错的；
> - P2-16 界面也在说「计 0 分」 —— 改 README 时顺手 grep 前端；
> - P2-17「清空排行榜」做不到 —— 真正要清的时候才发现只有「连账号一起清」；
> - P2-18 探针自清理失效 —— 复验时发现线上多了一个删不掉的 `probe` 账号。
>
> 换句话说：**写测试、写文档、真跑一次操作**，这三件事各自都长出了新问题。
> 只读代码的 review 会漏掉全部六条（含 P2-9 那条真 bug）。

---

## 一、P0 · 数据灾难隐患

### P0-1 备份脚本丢失 `account` 字段，灾备恢复后全员登不进来 ✅ 已修复（v45）

**位置**：`scripts/backup-leaderboard.js:93-107`

**证据（实测）**：

```
线上主文件（/api/leaderboard?full=1）:
  字段: playerId,nickname,games,...,recent,account
  account: {"name":"player_a","有salt":true,"有hash":true}

本地种子（server/data/profiles.json，本次部署已上传）:
  字段: playerId,nickname,games,...,recent,updatedAt
  account: **缺失**
```

脚本把 `dump()` 返回的数组转成 `{playerId: profile}` 时，只逐个复制了 `nickname / games / wins / ...`，**独独漏了 `account`**。

而 `server/profile.js:516-521` 的注释把这件事说得很清楚：

> **必须带上 account**（含 salt/哈希）：否则发布前备份一次，所有账号的密码就被洗掉了，玩家第二天全部登不进来。

注释写了，实现没照做，也没有任何测试覆盖「dump → 写种子 → 新实例加载 → 能登录」这条往返。这是典型的**注释与实现脱节**。

**影响链**：容器重建（换实例、沙箱回收、`~/.lxw-appdata` 不可写）→ 主文件不存在 → 从种子恢复 → 恢复出 1 条没有 `account` 的档案 → `accountOf()` 返回 null → 账号 `player_a` 登录直接失败（"账号不存在"），那条战绩变成永久的孤儿档案。

**修法**：

```js
// scripts/backup-leaderboard.js，map[p.playerId] 里补一行
if (p.account) map[p.playerId].account = p.account;
```

然后补一个往返测试：构造带账号的 ProfileStore → `dump()` → 按脚本规则写种子 → 新建实例指向只读种子 → 断言 `accountOf(pid)` 非空且 `login()` 成功。

**这条修完要重新跑一次备份、重新发布**，否则线上那份种子依然是残废的。

---

### P0-2 最后未提交的人「离开」→ 房间永久卡在分牌阶段 ✅ 已修复（v45）

**位置**：`pwa/js/stateMachine.js:182-199`（`leaveRoom` 对局中分支）

**证据（实测）**：

```
开局: true | phase = ROUND1_SPLIT
甲提交: true | phase = ROUND1_SPLIT
乙提交: true | phase = ROUND1_SPLIT
--- 丙不提交，直接离开 ---
离开后 phase = ROUND1_SPLIT     ← 没有推进到结算
在场人数 = 2 | 都已提交 = true
结算结果 = 无
```

`leaveRoom` 里只调用了 `maybeEndGame()`（人数不足才结算）。3 人局走掉一个还剩 2 人，人数够，于是不结算。但此刻**剩下的人其实都已经提交完了**——`submitGroups` 里那个「全员提交即结算」的判断不会再被触发，因为触发它的人正是走掉的那个。

**也没有定时器能救**：`hub.js:597-623` 的分牌超时只给「未提交、未 left」的人挂计时器；甲乙已提交、丙已 left，三个条件都不满足，一个 timer 都没有。房间会一直停在这里，直到 `ROOM_IDLE_MS`（30 分钟）回收。

**玩家看到的现象**：分牌页上所有人都显示"已提交"，但永远等不到结算，只能退出重进（重进也还是那个状态）。

**修法**：`leaveRoom` 在 `maybeEndGame(room)` 之后补一次结算推进：

```js
// 走的人可能正是最后一个未提交者：剩余在场者若都已提交/弃权，立即结算
if (room.phase === PHASE.ROUND1_SPLIT || room.phase === PHASE.ROUND2_SPLIT) {
  var round = room.round;
  var act = activePlayers(room);
  var allIn = act.length > 0 && act.every(function (q) {
    return q.forfeitRound === round || q.submitted['round' + round];
  });
  if (allIn) settleRound(room, round);
}
```

同时建议加一条兜底：`hub._armSplitTimers` 在分牌阶段广播时，若「未提交人数为 0」就直接推一次 `settleRound`——把「该结算了」这件事从"谁触发"变成"状态本身决定"。

---

## 二、P1 · 高危

### P1-1 Service Worker 预缓存从未生效（离线能力是空的） ✅ 已修复（v46）

**位置**：`pwa/sw.js:30-58`（PRECACHE）、`pwa/sw.js:65-67`（`cache.add` 失败被 `catch` 吞）

**证据（实测，线上逐个请求）**：

```
/index.html            -> 403
/css/style.css         -> 403
/js/game.js            -> 403
/sw.js                 -> 403
/manifest.webmanifest  -> 403
/(根路径)               -> 403
```

部署网关要求所有请求带 `?sharecode=`，裸路径一律 403。而 PRECACHE 里 25 个条目**全是裸路径**，`cache.add()` 全部失败，`.catch(() => null)` 把它们静默吞掉，`install` 照样成功。

**结果**：所谓"离线兜底"依赖的是运行时缓存（network-first 成功后 `cache.put`）——也就是说**必须先在联网状态下成功打开过一次，离线才可能可用**；首次安装后立刻断网，白屏。而且因为失败没有日志，这个问题从上线到现在一直没人发现。

**修法**（两条一起）：
1. PRECACHE 里的路径带上当前 sharecode（从 `location.search` 读，写进缓存键）；
2. `cache.add` 的失败**至少 `console.warn` 一次**，并在 `install` 后统计成功数，为 0 时明确记一条「预缓存全部失败，离线不可用」。静默失败是最难查的那种 bug。

### P1-2 迟到的错误回包被当成「连接级致命错误」→ 强制登出 ✅ 已修复（v46）

**位置**：`pwa/js/roomStore.js:400-417`

`error` 分支先查 `pending[data.reqId]`；查不到就走 `else`，而 `else` 分支的语义是「没有 reqId 的连接级错误」——直接触发 `fatalCbs`，`game.js` 收到后 `AuthStore.logout()` + 回登录页。

但请求超时（`request()` 里 8 秒）会 `delete pending[reqId]`。于是：**网络慢 → 请求 8 秒超时 → 服务端第 9 秒才回错误 → 前端把这条迟到回包当成"你被踢了"→ 直接登出**。

服务端所有 `_fail()` 都带 `reqId`，所以这类回包必然命中 `else`。

**修法**：

```js
} else if (data.type === 'error') {
  var q = pending[data.reqId];
  if (q) { delete pending[data.reqId]; q.reject(...); }
  else if (data.reqId != null) { /* 迟到响应，丢弃 */ }
  else { /* 真正的连接级错误，才走 fatal */ }
}
```

### P1-3 解散投票没有超时也没有撤回 → 发起人被锁死 ✅ 已修复（v46）

**位置**：`pwa/js/stateMachine.js:539-556`（`proposeDissolve`）、`pwa/js/game.js:2263-2272`（发起人看不到任何按钮）

发起后 `dissolve.active = true`，同时 `startGame` 与开局按钮都被它挡住（`stateMachine.js:236`、`game.js:492`）。而：

- 没有 `cancelDissolve`；
- 前端对发起人把同意/拒绝两个按钮都 `addClass('hidden')`；
- `hub.js` 里只有 split / grace / room 三种定时器，**没有 dissolve 超时**。

只要有一个人既不点同意也不点拒绝（挂机、锁屏、离开），房间就永远停在「等待其他玩家同意」，开不了下一把。唯一出路是等那个挂机的人回来点拒绝，或者 30 分钟房间回收。

**修法**：① 服务端给 `dissolve` 加 30 秒超时，到期作废并广播；② 发起人界面补一个「取消解散」按钮，走新的 `cancelDissolve` 请求。

### P1-4 弃权之后还能反悔出牌 ✅ 已修复（v46）

**位置**：`pwa/js/stateMachine.js:333`（`revising` 判定）、`394-410`（`forfeitRound`）

**证据（实测）**：

```
弃权: true
弃权后再提交: ★ 被接受（可以反悔出牌）
甲的最终分组张数 = 6 | forfeitRound = 1
```

`forfeitRound` 把 `submitted[round]` 置为 true 但**没动 `resubmits[round]`**，而 `submitGroups` 用 `revising = !!p.submitted[rkey]` 判断"这是修改"，额度还是 0，于是放行。

结果是一个自相矛盾的状态：`forfeitRound === round`（按弃权算）同时 `groups` 里有满 6 张真牌。结算按哪个走取决于 `settleGroup` 的实现，无论哪种都是错的——要么"提交了却不计分"（玩家觉得被吞），要么"弃权了却计分"（躺赢漏洞回来了）。

**修法**：`submitGroups` 开头加一道：

```js
if (p.forfeitRound === round) return { ok: false, error: '本回合已弃权，下一回合再来' };
```

### P1-5 改密码 / 停用账号不吊销旧令牌（90 天有效） ✅ 已修复（v47）

**位置**：`server/auth.js:109-144`（令牌无版本号）、`server/index.js:489-493`（注释已自认）

令牌是无状态签名，`verifyToken` 只看签名和 `exp`。**账号的密码被改之后，旧令牌在 90 天有效期内照样能用**。改密码这个动作最典型的动机就是"怀疑密码泄漏"，而它对已经在线的攻击者零作用。

`index.js:491-492` 的注释写了这一点（"真要改密码踢下线得引入令牌版本号，这里按需再说"），现在到了"按需"的时候。

**修法**：档案里存 `tokenVersion`，令牌 payload 带 `ver`；`verifyToken` 之后比对账号当前版本，不符即失效。改密码、管理员重置密码、停用账号时 `tokenVersion += 1`。改动很小，收益是把"改密码"从心理安慰变成真实生效。

### P1-6 删号接口不验密码 ✅ 已修复（v47）

**位置**：`server/index.js:496-504`

改密码要求 `body.oldPassword` 复核（`index.js:484`），但**删号只凭令牌**。设备丢失、令牌被窃（localStorage 可被任何 XSS 读走）时，攻击者一键就能把账号和全部战绩永久删掉，而改密码反而拦得住。

不一致，且方向反了——越不可逆的操作，验证越严。

**修法**：`/api/auth/delete` 加 `requireJson` + 要求 `body.password` 复核一次。前端已有二次确认弹窗，再加一个密码输入不算负担。

### P1-7 `joinRoom` 无限流，6 位房号可枚举 ✅ 已修复（v47）

**位置**：`server/hub.js:232-271`（`joinRoom`）、`hub.js:760-771`（`_genRoomId` 用 `Math.random()`）

房间号是 6 位数字（90 万空间），`joinRoom` 没有任何失败限流。脚本可以按顺序/随机遍历房号，进到别人的房间里：坐一个座位、占满房间、看谁在玩、发改名请求。座位令牌能挡住"接管别人座位看牌"，但挡不住"进房间捣乱"。

**修法**：① 按 IP 对 `joinRoom` 失败计数（如 20 次/分钟），超限短暂拒绝；② 房间号加一位校验位，或改成 8 位，把枚举成本抬上去。①的收益更大。

### P1-8 `server/backup-key.txt` 在 git 历史里，且等于当前线上密钥 ✅ 已修复（v47）

**证据**：

```
git ls-files | grep backup-key   -> server/backup-key.txt     （被追踪）
git show 0c03e26:server/backup-key.txt  -> 1e515dfa...（48 字符）
与当前文件比较   -> 相同（当前线上密钥已泄漏进版本历史）
git remote -v   -> https://github.com/player_a/five-out-of-six.git
匿名访问 GitHub API -> 404（仓库私有，未公开）
```

**严重度取决于仓库可见性**：仓库是私有的，所以**没有公开泄漏**。但这把钥匙能读全部档案、改任何人的密码、停用/删除任何账号、清空整个库——一旦仓库改成 public、加了外部协作者、或 CI 日志外泄，就是全盘失守。

**修法**（按顺序）：
1. 加 `.gitignore`：`server/backup-key.txt`、`server/data/profiles.json`、`node_modules/`、`*.corrupt-*`；
2. `git rm --cached server/backup-key.txt server/data/profiles.json`；
3. **轮换密钥**——历史已经泄了，删文件不等于没发生过。改 `backup-key.txt` 后重新发布，并同步更新自己本地的备份脚本调用。

### P1-9 十点半「双爆」按单张比大小，与自身注释矛盾 ✅ 已修复（v47）

**位置**：`pwa/js/engine.js:280`

```js
if (ba && bb) return compareTenHalfSide(a, b);   // 双爆（2 张牌下不可达）
```

注释说"2 张牌下不可达"——**这个前提是错的**。十点半组正好 2 张牌，任意两张点数和 >10.5 就爆：9+9=18、10+K=20 都爆。

**证据（实测）**：

```
a 总点数 = 180 爆? true      (9♠ + 9♥)
b 总点数 = 160 爆? true      (8♣ + 8♦)
compareTenHalf(9+9, 8+8) = 1  => 9+9 赢（比单张大小）
反向 = -1（可交换，逻辑本身一致）
```

而同一文件 `tenHalfResolvedBetter()`（`engine.js:252-258`）里写的是"**双爆时爆得少者优**"。两处口径相反：按前者 18 点赢，按后者 16 点赢——**直接改变输赢和分数**。

**修法**：确定一个口径（建议按 `tenHalfResolvedBetter` 的"爆得少者优"，更符合玩家直觉），改 `if (ba && bb) return tb > ta ? 1 : (tb < ta ? -1 : compareTenHalfSide(a,b));`，并把注释里的"不可达"删掉。补一条双爆测试。

**修复**：采用「爆得少者优」——双爆时先比总点数，点数小者赢；同点数再走单张比大小，逻辑仍是可交换的。
`compareTenHalf` 的双爆分支改为：

```js
if (ba && bb) {
  var ta = tenHalfTotalResolved(ra), tb = tenHalfTotalResolved(rb);
  if (ta !== tb) return ta < tb ? 1 : -1;
  return compareTenHalfSide(a, b);
}
```

同时把 `tenHalfResolvedBetter` 导出（`Engine.tenHalfResolvedBetter`），让「哪种组合更好」只有一个判定入口。
新增 `pwa/test/double-bust.test.js`（17 项）：四类双爆组合的胜负、同点数退化到花色、可交换性、以及与 `tenHalfResolvedBetter` 的口径一致性。

### P1-10 服务端从不调用 `setConfig`，改 `config.js` 会导致两端结算不一致 ✅ 已修复（v47）

**位置**：`pwa/js/config.js:56-68`

```js
var eng = global.Engine || (typeof Engine !== 'undefined' ? Engine : null);
if (eng && eng.setConfig) { eng.setConfig({ ... }); }
```

**证据（实测）**：

```
global.Engine = undefined            ← Node 环境下拿不到
Engine.setConfig = function
config.DOUNIU_WIN_POINTS = {"WUHUA":4,...}
Engine.DOUNIU_WIN_POINTS = {"WUHUA":4,...}
两者是同一对象? false                ← 两个独立对象，从未同步过
```

`engine.js` 用 IIFE + `module.exports`，没有挂到 `global`。所以服务端 `require('./config.js')` 只拿到一个 CONFIG 对象，`setConfig` 分支永远不执行。当前两边数值恰好相同，所以没暴露。

**但 README 第 15 行承诺的是**：「改数值只改 `pwa/js/config.js`（服务端通过同一份文件读取，双端同源）」。按现在的代码，一旦策划改了 `DOUNIU_WIN_POINTS`，浏览器端生效、**服务端仍用 engine.js 的内置默认值**——同一局牌，前端算出赢 3 分、服务端记 1 分。

**修法**：`config.js` 增加 CommonJS 分支——`module.exports` 时直接 `require('./engine.js').setConfig(...)`。这是最稳的"双端同源"，比依赖 `global` 可靠。补一条断言：`require('./config.js')` 之后 `Engine.CONFIG.DOUNIU_WIN_POINTS` 与 config 的引用相同。

**修复**：`config.js` 在 `global.Engine` 取不到时回落到 `require('./engine.js')`：

```js
var eng = global.Engine || (typeof Engine !== 'undefined' ? Engine : null);
if (!eng && typeof module !== 'undefined' && module.exports) {
  try { eng = require('./engine.js'); } catch (e) { eng = null; }
}
```

新增 `pwa/test/config-sync.test.js`（12 项）：逐项比对 `config.js` 与 `Engine.CONFIG` 的每个数值字段，
包括 `DOUNIU_WIN_POINTS` / `PIAOSANYE_*` / `TENHALF_*` / `INITIAL_SCORE`。
以后策划只改 `config.js`，服务端 `require` 到的是同一份数值；改漏一处测试会直接红。

---

### P1-11 第一轮三组在 16:9 手机上被整组裁掉（「飘三叶」看不见） ✅ 已修复（v46）

**位置**：`pwa/js/game.js:689`（`slotCardSize`）、`pwa/css/style.css:798-824`（`.slots` / `.slot`）、`style.css:1660`（横屏 `!important` 死尺寸）

**现象**：375×667、360×640、320×568 这类 16:9 手机上，第一轮第三组「飘三叶 · 3张」整组看不见。`.slots` 虽然写了 `overflow-y: auto`，但滚动条在这套皮肤里不可见，玩家只会认为「这组不存在」。

**证据（真 Edge + CDP，进程内起真实服务端、建房补 AI 开局后量）**：

| 视口 | 舞台高(设计px) | 组槽可用高 | 溢出 | 飘三叶 |
|---|---|---|---|---|
| 390×844 | 1623 | 846 | 0 | 完整可见 |
| 375×667 | 1334 | 557 | 281 | **`visibleRatio: 0`、`clippedPx: 136`（整组不可见）** |
| 812×375（横屏） | 1440 | 611 | 229 | 完整可见（但牌被 CSS 钉死在 96×134） |

**根因**：三组是**刚性**尺寸 —— 牌高 202 + 组信息 55 + 上下内边距 14 = 单组 271，三组加两道间距合计 **840**。而组槽可用高 = 舞台高 − 777，390×844 时正好 **846**：全站只剩 **6 设计px** 余量。设计建立在「刚好放得下」上，任何更矮的屏幕必然溢出。

横屏另有一条 `.wide-stage #screen-game .card-box { width:96px !important; height:134px !important }`，把组槽牌钉死，和 JS 算出来的值各说各话（实测 JS 算 109×153、CSS 覆盖成 96×134）。

**修法**：
1. 把几何计算抽成纯函数模块 `pwa/js/slotLayout.js`（`slotsHeight / isDense / maxCardHeight / cardSize / totalHeight`），运行时不猜：直接读 `#slots.clientHeight`，反推每组能有多高，再定牌尺寸；**上限仍是 144×202**，所以 390×844 这类大屏一像素不变。
2. 矮屏（`stageH < 1500` 设计像素：16:9 手机 / 横屏）进 dense 排法：组信息从「牌下方」搬到「牌右侧」，纵向不再为文字留 55px，牌从 78 宽涨到 115 宽；规则提示在矮屏隐藏（规则页有全文）。
3. 删掉横屏那条 `!important` 死尺寸，尺寸只剩一个来源。
4. `ResizeObserver` 盯 `#slots`：标签条折行、字体加载、转屏都会改变可用高，变了就重画一次。
5. 入槽飞牌与拖拽幽灵牌改用实际尺寸（否则矮屏上会「先大后小跳一下」）。

**复验**：三档视口 `overflow` 全为 0、三组 `visibleRatio` 全为 1；390×844 仍是 144×202。

---

## 三、P2 · 质量、性能与体验

### P2-1 WebSocket 缓冲累积是 O(n²)，小包攻击可打满 CPU ✅ 已修复（v47）

**位置**：`server/ws.js:79` — `this.buffer = Buffer.concat([this.buffer, chunk])`

**证据（实测，累积到 1MB 的耗时）**：

| chunk 大小 | 耗时 | 倍率 |
|---|---|---|
| 1 字节 | **67719 ms** | 1830× |
| 1 KB | 79 ms | 2.1× |
| 1448 B（典型 MTU） | 37 ms | 1× |

TCP 段大小是发送方可控的。一个连接故意用 1 字节段灌 1MB，就能把单核钉在 100% 上约 67 秒；开几个连接就够拖垮整个对局服务（所有房间共用一个事件循环）。

**修法**：改成 chunk 数组累积（`this.chunks.push(chunk)`，凑够一帧再 `Buffer.concat` 一次），或用读偏移量 `this.offset` 在不复制的前提下切片。后者最彻底。

**修复**：取「读偏移 + 倍增扩容 + 原地前移」三者结合，`this.buffer` → `this.buf` + 写指针 `this.wlen`：

- `_append(chunk)`：剩余空间不够就 `Buffer.allocUnsafe(cap * 2)` 拷过去（容量倍增），再写入；
- `_consume(n)`：消费掉 n 字节后用 `buf.copy(buf, 0, n, wlen)` **重叠复制**（底层走 memmove），把剩余的挪到头部，`wlen -= n`；
- `_readFrame` 用 `this.wlen` 判断可用长度，不再每次 `Buffer.concat`。

摊还下来每字节最多被拷 O(1) 次。实测「1 字节灌到 256KB」从平方级降到 **37ms**。
新增 `server/test/ws-buffer.test.js`（19 项）：分片到达、粘包、跨扩容边界的帧、1 字节极碎片、以及容量不会无限增长。

### P2-2 `_deleteRoom` 漏清 grace 计时器 ✅ 已修复（v46，顺带清了新的解散计时器）

`server/hub.js:683-697` 清了 `_tokens`、分牌计时器、房间回收计时器，**没清 `graceTimers`**。房间删除后，该房间的断线宽限 timer 会继续挂到 90 秒后才在回调首行自行删除。不是大问题，但属于"删除时该收的都收干净"的一致性缺口。

### P2-3 `uncaughtException` 只记日志不退出 ✅ 已修复（v47）

`server/index.js:618-621`。Node 官方明确说 `uncaughtException` 之后进程状态不可信，继续服务可能出现更隐蔽的数据错误（比如一半写了一半没写的状态）。建议 log 之后 `profiles.flush()` + 优雅退出，交给进程管理器重启——本项目房间都在内存里，重启的代价只是当前几局作废，比带着不一致状态跑下去安全。

**修复**：`uncaughtException` 改为三拍：log → `profiles.flush()` → `server.close()` → `process.exit(1)`。
顺序不能反：先 flush 才不丢盘，先 close 才能把在途响应发完。

### P2-4 `/api/health` 的 version 恒为 `dev` ✅ 已修复（v47，v48 又修了兜底，见 P2-15）

`server/index.js:326` 读 `process.env.APP_VERSION`，部署从未设置，线上实际返回 `{"version":"dev"}`（已完成实测）。后果是**运维无法确认线上跑的是哪个版本**——而前端有 `meta[name=app-version]`，两者没有任何关联。

建议：启动时注入（部署脚本读 `package.json` 或 index.html 的 `app-version` 传环境变量），并让 health 一并返回 `pwa` 的版本号，这样一次请求就能确认"代码是哪版、静态资源是哪版"。

**修复**：health 返回 `version` + `pwa`。`version` 走「环境变量 → 静态包 meta → dev」三层兜底，
`pwa` 启动时从 `pwa/index.html` 的 `meta[name=app-version]` 读一次（部署必然重启，无需热更新）。
v48 又发现当时的兜底本身有问题，见 P2-15。

### P2-5 昵称按码元截断，emoji 会切一半 ✅ 已修复（v47）

三处口径不一致：
- `hub.js:38-40` 的 `cleanNickname` 用 `Array.from` 正确处理；
- `index.js:416` 注册昵称用 `.slice(0, 8)`；
- `profile.js:439` 管理员改昵称用 `.slice(0, 8)`。

后两处会把一个 emoji（2 个 UTF-16 码元）切成孤立代理项，存进 JSON 后前端渲染出 `�`。

建议：把 `cleanNickname` 提到公共模块，三处都调它。

**修复**：新建 `server/text.js`，`hub.js` 删掉本地副本，`index.js` 与 `profile.js` 改为调用它。
实现用 `Array.from(s).slice(0, limit).join('')` 按**码点**截断。同时剥掉控制字符
（`\u0000-\u001f` / `\u007f`），空串回落到默认名。
新增 `server/test/nickname.test.js`（19 项）：emoji、ZWJ 组合、代理对、控制字符、超长、空白名、以及三处入口口径一致。

### P2-6 管理后台用 `prompt()` 输入新密码 ✅ 已修复（v47）

`pwa/admin.html:269`。`prompt()` 的输入框是**明文显示**，没有遮挡、没有二次确认、没有强度提示。管理员在咖啡馆帮朋友重置密码，旁边人一眼看完。

建议：改成页面内的 masked input + 二次输入确认。

**修复**：新增 `#pw-modal` 弹窗（两个 `type=password` 输入 + 确定/取消），
`askPassword()` / `closeAskPassword()` / `onSubmitPassword()` 取代两处 `prompt()`（重置密码、改昵称的密码确认）。
两次输入不一致或短于 6 位就地拦下，不发请求。

### P2-7 管理后台 `call()` 没有 try/catch ✅ 已修复（v47）

`pwa/admin.html:192-205`。断网时 `await fetch` 直接抛异常 → unhandled rejection → 界面毫无反应，用户只会觉得"点了没用"。`game.js` 那边有统一的错误提示，admin 这边没有。

建议：包一层 try/catch，失败时 `setStatus('网络异常，请检查连接', true)`。

**修复**：`call()` 包 try/catch，失败返回 `{ ok:false, error:'网络异常，请检查连接后重试', network:true }`，
调用方统一走既有的失败分支（弹提示 + 恢复按钮）。

### P2-8 `flush()` 全量同步写盘 ✅ 已修复（v47）

`server/profile.js:178-199`。每 500ms 合并一次，但每次都是 `writeFileSync` 整个文件。档案到几万条时（每条约 600B），单次写盘会让事件循环卡住几十毫秒——和之前 `scryptSync` 是同一类问题，只是阈值更高。

建议：改用 `fs.promises.writeFile` + 写队列（同一时刻只允许一个写盘任务在飞），或按玩家分片存储。

**修复**：`flush()` 拆成三个方法：

- `_serialize()`：主文件与种子共用同一份序列化口径（剥掉运行时的 `_seen`）；
- `flush()`：同步版，只留给「进程退出前 / 单测刷完立刻读」；
- `_flushAsync()` → `_writeOnce()`：定时路径改走异步 `fsp.writeFile` + `fsp.rename`，
  用 `this._writeQueue = this._writeQueue.then(...)` 串行化，避免两次写抢同一个 `.tmp`。

`_writeQueue` 串行是关键：异步写盘一旦并发，两个 `rename` 会互相覆盖，反而比同步版更容易丢数据。

### P2-9 排行榜每次请求全表排序 ✅ 已修复（v47）

`server/profile.js:534-555`。`top()` 和 `rankOf()` 每次都遍历全部档案 + `sort`。`/api/leaderboard` 是每次打开榜单页都会打的接口，档案上万后单次请求 O(n log n)。

建议：维护一份按 `totalNet` 有序的缓存，在 `record()` 里标记 dirty、读取时惰性重建。

**修复**：`_standingsCache` + `_invalidateStandings()`。**每个写入点都要调**：
`record` / `ensure`（改昵称时）/ `setNickname` / `remove` / `reset` / `prune`。

这里有个活教材：`leaderboard-cache.test.js` 一开始就有 2 条 FAIL（`remove` / `reset` 后榜单没变），
测试抓到的是**真 bug**——这两个写入点漏了失效。补上后 22 项全绿。
「加缓存就要把失效点列全」这件事，只靠读代码是会漏的。

### P2-10 登录限流只按「账号名 + IP」，换 IP 即绕过 ✅ 已修复（v47）

`server/index.js:163-185`。`loginKey = name + '@' + ip`，攻击者换 IP 后同一账号的失败次数清零；反过来，同一 IP 攻击多个账号时每个账号独立计数，总量不受限。

建议：加一条纯 IP 维度的总闸（如 30 次失败/10 分钟/IP），两层同时生效。

**修复**：新增 IP 层 `LOGIN_IP_MAX`(30) / `loginIpFails` / `loginIpBlocked` / `noteLoginIpFail` / `clearLoginIpFails`，
与原有的 `name+ip` 层**同时**生效。登录与删号两个入口都接上。
新增 `server/test/login-ip-limit.test.js`（5 项）：换账号名撞库触发 IP 闸、单账号触发明细闸、成功登录清计数、以及两层互不干扰。

### P2-11 分牌计时器从「首次广播」起算，重连者只剩残余时间 ✅ 已修复（v47）

`server/hub.js:597-623` 是幂等的（`if (this.splitTimers.has(key)) return`），所以中途重连进来的人不会重置计时。极端情况：第 59 秒重连成功，只剩 1 秒就判弃权。

建议：重连成功后，若该玩家仍在分牌阶段且未提交，给他补一个最短时限（如 `max(剩余时间, 15s)`）。

**修复**：`splitTimers`（timer）+ `splitStartedAt`（起始时刻）两个 Map 配对，
`_armSplitTimers` 抽出 `_armOneSplitTimer(room, p, round, delayMs, idempotent)`。
`_refreshSplitDeadline(roomId, playerId)` 只在「剩余 < `MIN_RECONNECT_SPLIT_MS`(15s)」时**只给自己**那个 key 重新挂表，
别人的倒计时不受影响。`reconnect` 与 `joinRoom` 的「认回座位」分支都调它。
新增 `server/test/split-reconnect.test.js`（6 项）：在第 0.9 秒断线、第 1.1 秒重连，
验证原定超时点不判弃权、补足的 15 秒用尽后正常判弃权。

### P2-12 没有 `.gitignore` ✅ 已修复（v47）

`node_modules/`、`server/data/profiles.json`、`server/backup-key.txt`、`*.corrupt-*` 全都没有排除（已在 P1-8 说明后果）。这是最小成本最高收益的一处修补。

**修复**：新建 `.gitignore`，排除 `node_modules/`、`.wbapp_*.genie`、`*.log`、`.DS_Store`、`server/backup-key.txt`。
`server/data/profiles.json` **没有**排除——它是容器重建时的种子，必须进版本库（P0-1 的灾备链路依赖它）。

### P2-13 解散/删号等不可逆操作在前端的确认粒度 ✅ 已修复（v48）

- 删账号：有二次确认弹窗（好）；
- 解散房间：投票制（好）；
- 但**「离开对局」的文案区分**依赖 phase 判断，若服务端与前端 phase 短暂不一致，可能把「弃局」说成「离开房间」——建议以服务端返回的 phase 为准，并在确认框里带上"当前第几轮、分数多少"。

**修复**（`pwa/js/game.js` 的 `onLeave` / `fetchRoomSnapshot`）：

- 点「离开」时先发 `peekRoom` 向服务端要一次最新快照，**以服务端 phase 为准**判定是否弃局。
  超时 2.5 秒；拿不到就退回本地快照，但文案明确追加「没连上服务端核对最新进度」。
- 确认框文案从「按你现在的分数」升级成「第 N 轮正在进行，按你现在 X 分记入战绩」。
- **没有**复用现成的 `reconnect` 来读这一下：`reconnect` 会 `_refreshSplitDeadline`
  （补分牌时限）、重新 `_bind`、下发新座位令牌。用它当只读接口 = 反复点
  「离开 / 取消」就能一直续命。为此新增了真·只读的 `peekRoom`（见 P2-14）。

---

## 三之二、补充发现（改 P2-11 ~ P2-13 过程中新增）

### P2-14 整条 WS 协议没有任何消息级限流 ✅ 已修复（v48）

**怎么发现的**：写 P2-13 的测试时，为了证明「`peekRoom` 不会补分牌时限」，
在循环里一路狂发请求——结果 1.4 秒内服务端照做了 **13190 条**。也就是说
`hub.onMessage` 对请求速率完全没有概念：进房限流（P1-7）只管 `joinRoom` / `createRoom`，
其余请求想发多少发多少。

**为什么这不是"无所谓的小事"**：

- `ready` / `submitGroups` / `proposeDissolve` 每收到一条就 `_broadcast` 一次。
  一条连接刷 N 次，房间里 m 个人就吃 N×m 条推送——**放大倍数就是房间人数**；
- `JSON.parse` 在限流之前跑，构造超大 payload 单条就能吃满一个核；
- `peekRoom` 这类会 `_view` 组装快照的请求还有额外分配成本。

**修复**（`server/hub.js`）：`MSG_MAX = 60 条/秒/连接`（`process.env.MSG_MAX` 可覆盖），
固定窗口 + 连续超限计数；超出丢包（客户端表现为超时），连续 3 个窗口超限直接断开
（`kicked` 原因写明「请求过于频繁」）。检查放在 `JSON.parse` **之前**。

60/秒对真人的余量：一次点击才发一条，最密的分牌操作根本不发请求，心跳 30 秒一条。

### P2-15 `/api/health` 的 `version` 兜底是「`pkg-` + package.json.version」，而它从 0.2.0 起就没动过 ✅ 已修复（v48）

P2-4 已经修过「`version` 恒为 `dev`」，但当时的兜底是
`'pkg-' + require('../package.json').version`，而 `package.json` 的 version
**从 0.2.0 起就没有跟着发版走过**。结果是线上永远返回 `pkg-0.2.0`。

这比返回 `dev` 更糟：`dev` 一眼就知道「没配好」，`pkg-0.2.0` **长得就像一个真正的版本号**，
没人会怀疑，于是「这次发布生效了吗」这个本该由 health 回答的问题彻底失效。
更直接的影响：写 D-2 的发布核对步骤时，按原实现「`version` 与 `pwa` 不一致就是只发布了一半」
去核对，会发现**永远不一致**——文档照实写就是在教人做错的判断。

**修复**（`server/index.js`）：

- `readAppVersion()` 兜底改为「静态包的 `app-version` → `dev`」，不再依赖 package.json；
- 新增 `readServerStamp()`：`server/*.js` 里最新的 mtime，ISO 时间戳。
  **不需要任何纪律**——服务端代码一变，mtime 必然变；
- health 增字段 `server`，与已有的 `pwa`、`uptime` 三者配合：
  `pwa` 旧 = 静态没传上去；`server` 旧 = 服务端代码没传上去；`uptime` 大 = 进程没重启。

### P2-16 前端也在说「超时弃权，本回合计 0 分」✅ 已修复（v48）

D-1 记的是 README 写错，但同样的错误在**游戏界面上**也有一份：
`pwa/js/game.js` 的手牌状态条原来显示

> 你已超时弃权，本回合计 0 分，等待结算…

而实际规则是「各组都当放弃，自己不收分、**照常向赢家付分**」（`stateMachine.forfeitRound`）。
「计 0 分」会让人以为挂机无损，正好把后果说反了——玩家照着这句话做决策，是要输分的。

**修复**：改为「你已超时弃权：本回合不收分，仍要照付各组赢家，等待结算…」。

**教训**：同一句规则文案散落在 README / 界面 / 注释三处时，改一处不算改完。
D-1 与 P2-16 是同一个错误的两个落点。

### P2-17 「清空排行榜」这个需求根本做不到——只有「连账号一起清」 ✅ 已修复（v48）

**发现过程**：发布后用户要求「清空排行榜」。查代码发现唯一的手段是
`POST /api/admin/reset`，而它调的是 `profiles.reset()`：

```js
reset() {
  this.data.clear();      // 全清，account 也在里面
  this._byName.clear();   // 账号名索引一起清
  ...
}
```

也就是说，想让榜单数字归零，**必须先把所有人的账号删掉**——
清完之后谁都登不进来，得重新注册。管理后台的脚注当年就写着
「清空全部数据（含账号）」，等于把这个缺口当成既定事实记下来了。

这不是「实现有 bug」，是**产品能力缺了一块**：赛季重置是最常见的运营动作，
而唯一能用的手段带着数据灾难级的副作用。谁哪天顺手调了那个接口，
全服玩家的账号就没了。

**修复**（`server/profile.js` + `server/index.js`）：

- 新增 `resetStats()`：复用 `_blank()` 的字段集合把战绩归零，
  `playerId` / `nickname` / `account` 全部保留，`_seen`（幂等键）一起清；
- 新增 `POST /api/admin/reset-stats`，与 `reset` 共用同一把备份密钥、
  同样只接受 POST、同样**立刻落盘**；
- 两个入口的响应都带 `mode`（`stats` / `all`），**让调用方当场确认自己调对了哪个**
  ——这两个接口挨得太近，名字也像，没有回执就是等着出错；
- 管理后台的脚注把两条命令分开写清。

**一个容易漏的连带点**：清成 0 场之后，档案看上去和「只 ensure 过、从没打过」的
僵尸档案一模一样。`prune()` 里那条 `if (p.account) return;` 是唯一的护栏——
去掉它，清空排行榜就会在几次记录之后把所有人的账号一起扫掉。
测试里专门有一条断言锁住它（`pruned.length === 0` 且登录仍成功）。

**另一个连带点**：清完必须**重新备份一次**。种子文件里如果还是旧战绩，
容器重建时会照着种子把旧榜单恢复回来，等于清了个寂寞。
这次清完立刻 `npm run backup` 并重新发布了一次，就是为了让新种子真正上传。

### P2-18 发布复验探针的自清理从 v47 起就失效了 ✅ 已修复（v48）

`scripts/probe-table.js` 每次跑都会在线上注册一个 `probeXXXXX` 账号，
结束时调 `/api/auth/delete` 删掉。但 v47 给删号接口加了「必须带密码」之后，
探针**没有跟着改**——于是每次发布复验都留下一个删不掉的垃圾账号。

症状极隐蔽：探针照样打印「清理探针账号」，只是返回值没人看。
而 `probe` 账号 `games === 0`，不进榜单，普通视角完全看不见，
只有 `?full=1` 导出才会露出来。

**修复**：补上 `password` 与 `Content-Type: application/json`
（写接口有 `requireJson`），并且**校验返回值**——不是 `ok === true` 就当失败打出来。
以前那句 `return j` 把失败也当中性结果返回，等于没有断言。

**教训**：改了接口的鉴权要求，要把所有调用方搜一遍。
`grep -rn "api/auth/delete"` 一条命令的事，漏掉的代价是往线上塞垃圾数据。

---

## 三之三、工程与产品层面的不足（v49 新增，10 条）

前面 P0/P1/P2 解决的是「会不会出事」。这一节换一个问法：**这算不算一个优秀的扑克类 PWA？**
结论是工程侧扎实、产品侧偏薄。下面 10 条都是在代码、产物、实测里**实际验证**过的，
不是"还可以更好"的泛泛之谈。

### P3-1 服务端完全没有 gzip，首屏裸传 330KB

`server/index.js` 的静态服务直出 `fs.readFile` 的字节，响应头里没有 `Content-Encoding`。
实测线上 `GET /js/game.js`：

```
Content-Length: 144701
（无 Content-Encoding）
```

首屏要拉 11 个 JS + 2 个 CSS：

| 文件 | 原始 | gzip 后（估） |
|---|---|---|
| `js/game.js` | 142K | ~36K |
| `css/style.css` | 64K | ~12K |
| `js/engine.js` | 33K | ~9K |
| `index.html` | 32K | ~7K |
| 其余 9 个 JS 合计 | ~60K | ~16K |
| **合计** | **~330K** | **~80K** |

3G 下这是 2 秒和 0.6 秒的差别。而这个项目的用户场景恰恰是「朋友在饭桌上扫个链接进来」，
网络大概率是弱网。这是本轮性价比最高的一处修补：Node 内置 `zlib`，不需要任何依赖。

**修法**：静态响应对 `Accept-Encoding` 协商，`text/*`、`js`、`css`、`json`、`svg` 走
`gzipSync`，结果按「路径 + mtime + size」做内存缓存（同一个文件只压一次）。
`/api` 的 JSON 响应同样压缩。**不要**压图片和音频（webp/mp3 本身已压过，再 gzip
是纯浪费 CPU，还可能变大）。

**修复（v49）**：`server/index.js` 的 `sendFile` 加压缩协商，`/api` 走 `sendJson` 同一套逻辑。

- 只压 `html/css/js/json/webmanifest/svg/txt/map`；**图片和音频明确不压**（webp/mp3 已经压过，再 gzip 是白烧 CPU，有时还会变大）。
- 小于 1KB 不压：gzip 头和尾部校验会让它反而更大。
- 压完比原文件大就放弃 —— 不为了"有 compression"硬塞。
- 结果按「路径 + mtime + size」缓存，同一版本只压一次，文件一改自动失效。
- level 6 而不是 9：9 级只多省 2-3%，但首屏 11 个文件同时压会明显占用事件循环。
- `Content-Length` 写**压缩后**的长度。写原始长度会让浏览器按原长等数据，直接卡住 —— 这是压缩实现里最容易踩的一处。
- `Vary: Accept-Encoding` 必须有，否则中间任何一层缓存串了，就会把 gzip 流塞给不支持的客户端。

**实测**：`/js/game.js` **144701 → 48906 字节**（-66%）。
新增 `server/test/gzip.test.js`（24 项）：解压后与磁盘文件**逐字节相等**、`Content-Length` 正确、`q=0` 视为拒绝、图片不压、小 JSON 不压、缓存命中的两次请求字节一致、HEAD 只回头不回体。

顺带修掉一处：`/api/health` 原本自己 `writeHead`，是全站唯一不带 `Vary` 的 JSON 接口，改成走 `sendJson` 统一。

### P3-2 部署包里约 1MB 是没人引用的 PNG

`pwa/assets/` 同时存在两套图：

| 文件 | PNG | WebP | 代码引用 |
|---|---|---|---|
| `home_bg` | 500K | 84K | `.webp` |
| `table_bg` | 416K | 32K | `.webp` |
| `card_back` | 96K | 36K | `.webp` |

`css/style.css` 三处全部引用 `.webp`，PNG 是转码前的源文件残留。每次部署都把
1MB 死重量塞进容器，`PRECACHE` 里也没有它们——纯粹是包袱。

**修法**：删掉三张 PNG。若要保留原图，挪到 `design/` 之类不进部署的目录。

**修复（v49）**：删掉 `home_bg.png` / `table_bg.png` / `card_back.png`。

删之前先确认了两件事：全项目（js/css/html/json/webmanifest）**零引用**；三张 PNG 都已在 git 里，随时 `git checkout` 能取回，不是不可恢复的删除。

`pwa/assets/` 从 **1.4MB → 364KB**。

### P3-3 Service Worker 的 network-first 没有超时兜底

`pwa/sw.js` 现在的写法：

```js
fetch(req).then(...).catch(function () { return caches.match(req, ...); })
```

`catch` 只在**网络失败**时触发。弱网下「慢但最终成功」的请求会一直等，页面就白屏。
地铁、电梯、饭馆人多信号差——恰好是这个游戏的典型使用场景。

这不是理论问题：一个 4G 但拥塞的环境里，`fetch` 可能挂 10-20 秒才返回，
期间 Service Worker 什么都不做，玩家看到的就是「点开一片白」。

**修法**：`Promise.race` 一个超时（导航 3s、js/css 2s），超时先返回缓存副本，
**同时让原请求继续跑**（不 abort），返回后照常写缓存——这样既保证首屏可交互，
下一次打开又是最新的。

**修复（v49）**：抽出 `networkFirst(req, timeoutMs)`，`Promise.race([fetch, 计时器])`，导航 3s、js/css 2s。

两个关键细节：

1. **超时后不 abort**。原请求继续跑，回来后照常写缓存 —— 这正是「首屏快」和「下次打开是新的」能同时成立的原因。如果 abort 掉，下次打开还是旧缓存，改完代码不生效的锅又回来了。
2. `clone()` 必须在 `then` 里立刻做，且在把响应交给页面**之前**。Response 的 body 只能读一次，等页面消费过再 clone 会直接抛。

顺带修掉一处：403 转「访问链接已失效」的友好页**只对导航生效**。以前脚本/样式拿到 403 也会被替换成 HTML，浏览器会把 HTML 当 JS 执行，报一堆语法错 —— 比原来的 403 更难查。

新增 `pwa/test/sw-timeout.test.js`（16 项），用 vm 沙箱加载真的 `sw.js`、注入假 `caches`/`fetch`/定时器：网络卡住时 2s 拿缓存、迟到的响应写回缓存、无缓存时返回 `Response.error()` 而不是 `undefined`、图片走 cache-first 不发请求。

### P3-4 没有 CI，1400+ 项断言全靠手动跑

47 套测试（24 前端 + 23 服务端）、1378 项断言，`npm test` 一条链跑完。
问题是**没人保证它一直在跑**。这一轮 review 里两个真 bug 都是测试抓出来的：
`leaderboard-cache` 首跑红了 2 条（`remove` / `reset` 漏了缓存失效）、
`msg-limit` 是写测试时打出来的（协议没有消息级限流）。

测试的价值完全取决于它是否持续运行。现在只要有一次改动忘了跑，红不红只有天知道。

**修法**：`.github/workflows/test.yml`，`push` 与 `pull_request` 都触发，
Node 22，`npm test`。项目零依赖，不需要 `npm ci` 缓存，跑得很快。

**修复（v49）**：`.github/workflows/test.yml`（push / PR / 手动触发，Node 22，语法检查 + 全量测试），
并把测试入口从「手写长链」换成 `scripts/run-tests.js`（扫描目录自动纳入）。

**这条在修的过程中就抓到了它自己的证据**：检查新测试有没有挂进 `npm test` 时发现，
v47/v48 写的 7 套测试（`config-sync` / `double-bust` / `ws-buffer` / `leaderboard-cache` /
`login-ip-limit` / `nickname` / `split-reconnect`）**从来没被跑过**。原因是当时用
`String.replace` 往 package.json 的长链里插命令，锚点没匹配上时它静默什么都不做。

所以当时报告的「1378 项通过」里根本没算这 7 套。改成扫描目录后，这类失败模式从根上消失。
真实数字是 **1815 项 / 54 个文件**（含本轮新增的 8 套）。

### P3-5 线上前端报错完全不可见

`grep -rn "window.onerror\|unhandledrejection"` 在 `pwa/` 下没有任何命中。
玩家手机上 JS 抛异常，服务端日志里什么都没有——你连"有人在用"都不知道。

PWA 让这件事更糟：Service Worker 缓存了旧版 JS 时，错误只发生在用户端，
而且**每次打开都复现**，你还以为线上是好的。

**修法**：前端 `window.onerror` + `unhandledrejection` 采集 → `POST /api/client-error`
（带节流：同一会话最多 10 条、同一 message 只报一次；字段截断到 500 字），
服务端写进日志。不需要第三方服务，一张 `grep` 就能查。

**修复（v49）**：新增 `pwa/js/errorReport.js`（最早期加载）+ `POST /api/client-error`。

前端侧：
- `window.onerror` 用**捕获阶段**监听 —— 资源加载失败不冒泡，冒泡阶段收不到；这类错误没有 `ev.message`，`ev.target` 是那个元素。
- 每会话最多 10 条、同一 message 只报一次。一个渲染循环里的异常一秒能抛几百次，不节流的话上报本身就能把服务端打满。
- 优先 `sendBeacon`（页面被直接杀掉时 fetch 会被取消，beacon 不会），返回 false 再退回 `fetch + keepalive`。
- **`capture()` 整体包在 try 里**：它跑在错误处理路径上，自己一抛就把原始错误吞了。

服务端侧：
- **不要求登录** —— 最需要看见的报错恰恰发生在登录之前（启动阶段、SW 缓存了坏掉的旧脚本）。代价是必须限流：按 IP 40 条/分钟，超了 429。
- 所有字段截断 + 剥控制字符。不剥的话，一条精心构造的 message 能在日志里**伪造出整行记录**（换行注入）。

新增 `pwa/test/error-report.test.js`（27 项）+ `server/test/client-error.test.js`（12 项）。

### P3-6 没有观战（本轮**未做**，有意推迟）

8 个座位满了，第 9 个人只能干看着——而且他其实**已经到了这个页面**，
只是没有入口。扑克里「看别人打」是天然的社交行为，也是留存入口。

现在点「进房」会得到「房间已满」，然后就断了。

> **状态：本轮未做。** 评估后发现改动面比预想大得多，不适合塞进这一批。
>
> 服务端其实很容易：满员时不返错，把连接 `_bind` 进房间但**不入座**，标记 `spectating`。
> 因为观战者不在 `room.players` 里，现有的 `_view(room, viewerId)` 会自动把所有手牌清空
> —— **公开视图是免费的，不存在额外泄漏面**。
>
> 真正的成本在前端：`game.js` 里有 **37 处** `state.myId`，其中多处直接写 `me.score`
> （渲染座位卡、分数动画、手牌区）。观战者 `me` 是 `null`，这些地方会直接抛。
> 要把房间页 / 对局页 / 结算页三处的「我不在座位上」分支全部补齐，还要保证
> 正常玩家的路径一点不变。
>
> 这个改动**做得不彻底就会让已经修好的 9 项出回归**，而现有测试覆盖不到观战 UI。
> 所以选择不做，而不是交一个半成品。下一版单独做，配套一个真浏览器观战探针。

**修法**：房间满员时允许以观战身份进入。服务端 `room.spectators`，
广播也发给观战者，但**只给公开视图**（不含任何人手牌——给了就是作弊通道）。
观战者不入座、不能 `ready`/`submitGroups`、断线不影响对局、退出即离开。
前端在观战态显示「观战中」+「加入牌桌」置灰 + 当前轮次与分数。

### P3-7 没有回放 ✅ 已修复（v49 房间内 / v50 结算后仍可回看）

四种玩法规则差异大（尤其飘三叶的飘、斗牛的凑十），打完一局
「刚才那把怎么输的」无法复现。结算页只有分数变化，没有过程。

**修法**：每轮结算时把 `{round, mode, seeds, groups, results}` 记进 `room.history`
（只记公开信息：谁分了几张牌、比的是什么、谁赢谁付多少），结算页可展开逐轮回看。

**v50 补齐离房留存**：v49 只做到「在房间里能看」，一退房就没了 ——
而「刚才那把怎么输的」恰恰是退房之后才想复盘的事。

存**本机**（`Records`）而不是云端档案，三个理由：

1. **语义一致** —— 这是「我的复盘」。换设备看不到旧战绩，也就看不到旧回放；
2. **不碰档案体积** —— `profiles.json` 是单文件存储（见 P4-6），每份档案多 3KB
   会直接拉低那个天花板；
3. **零隐私面** —— 数据在结算那一刻就已经公开过，只写到自己的浏览器里。

体积控制是硬要求（`LIMIT` 是 200 局，一局 3KB 全留就是 600KB）：

- `saneReplay()` 逐层裁剪——最多 4 轮 × 6 组 × 12 人 × 每人 6 张牌，字符串按字段截断。
  **必须裁**：replay 是外部传进来的二维结构，一个字段漏检查就能把配额撑满，
  而配额满了是**整页战绩都读不出来**，不只是回放丢；
- `trimReplays()` 只给最近 **8 局**留回放，更早的**删字段但留记录**；
- 实测 200 局塞满时 localStorage 占用 **31KB**，磁盘上恰好 8 份 `"replay"`。

战绩页每条记录多了「看过程 ›」，点开复用同一个回放弹窗（标题改成日期）。
渲染层加了一次 `esc()` —— 存档数据进过 localStorage，理论上可以被改脏，
不能像实时数据那样直接拼。

配套：`pwa/test/records-replay.test.js`（30 项：脏数据 11 种、超量裁剪、
字符串截断、8 局窗口、200 局体积）与 `scripts/probe-records.js`（15 项，真浏览器）。
同时把精简版写进参与者档案的 `lastReplay`，离房后在战绩页仍能回看最近一局。

**修复（v49，只做了房间内回看）**：`stateMachine.settleRound` 里把每轮结果归档进 `room.history`。

- 只存 `id / nickname / hand` 三样，不存 `entries` 里的中间判定过程 —— 这些数据每次广播都随 `_view` 下发，留全量会把推送撑大一倍。
- 保留最近 **4 条 ≈ 两把**，超出 `slice(-4)`。
- 前端结算页加「本局过程」：逐轮列出每组玩法、赢家与牌型、每人手上什么牌、加减多少分。红涨绿跌与牌桌口径一致。

新增 `pwa/test/replay.test.js`（29 项）：两轮各归档一条、字段完整、牌面真的被记下来、**单组 deltas 之和为 0**（零和校验）、entries 是精简副本、上限存在。

**没做的部分**：原计划还要把精简回放写进档案 `lastReplay`，让玩家离房后在战绩页仍能回看。这需要改 `profile.js` 的字段 + 新接口 + 战绩页展示，跨三层；本轮先保证房间内可用，离房留存留到下一版。

### P3-8 新手引导只有一屏长文

`#rules-modal` 的文案写得不错（尤其王的三种不同用法那段），但它是**一整屏文字**。
「十点半怎么算到 10.5」「飘三叶为什么叫飘」——新玩家第一次上手大概率是懵的，
而这一屏文字读不下去。

**修法**：把规则弹窗升级成 4 步分步引导（六张牌两轮 → 第一轮三种玩法 →
第二轮斗牛 → 王与结束条件），每步一屏、一句主文案 + 一张示意图 + 进度点。
首次进首页可触发，也可从「玩法规则」再次打开。

**修复（v49）**：新增 `#guide-modal`，4 屏分步：六张牌两轮分 → 第一轮三种玩法 → 第二轮斗牛 → 王与结束条件。

- 示意图全部用**纯 CSS 画**（牌面、玩法胶囊），不依赖任何图片 —— 少一张图就少一个 404 的机会。
- 首次进首页自动弹一次，延迟 1.2 秒（先让首屏和首页动画走完，上来就盖一层弹窗很凶）；`localStorage` 记「看过」。
- 最后一屏按钮变成「看完整规则」，跳到原来的 `rules-modal`。**引导负责让人看懂，完整规则负责查细节，两者不互相替代。**
- Esc 与移动端返回键都能关；关掉即视为看过。
- 第一步没有「上一步」但按钮保留占位 —— 去掉它会让「下一步」横向跳位，手指正好按在下面。

原 `rules-modal` 完整保留（十点半比花色、斗牛的没牛罚分这些细节只有它写得清）。

### P3-9 分享缺 Web Share API

现在只有「复制链接」和「生成战绩图 → 长按保存」。iOS 上发一局战绩给朋友要：
生成图 → 长按 → 存储图像 → 打开微信 → 选人 → 发图，**六步**。

**修法**：有 `navigator.share` 时直接调（带 `url` + 文案），不支持再回退复制。
一行 API 省掉前三步。注意 `share()` 在非用户手势里调用会被拒，要放在 click 回调里。

**修复（v49）**，但要先更正一条前提：**战绩图分享原本就支持 Web Share**（`onShareSave` 里有 `canShare({files})`），
真正的缺口是两处：

1. **邀请链接没有**。`onCopy` 只有剪贴板。现在加上 `navigator.share`，必须在点击回调的**同步段**里调用（第一个 `await` 之前），否则 Safari 判定非用户手势直接 reject；`AbortError` 是用户主动取消，不能弹「已复制」。
2. **战绩图分享被 `isIOS()` 卡死**。Android Chrome 早就支持 `canShare({files})`，却掉进了「请长按保存」。改成只排除微信内置浏览器，其余交给 `canShare` 自己判断 —— 它是唯一有资格回答这个问题的 API。

`pwa/test/ui.test.js` 加了 8 条断言，其中一条专门检查 **`share` 出现在第一个 `await` 之前**（写这条断言时踩了个坑：代码注释里就写着「第一个 await 之前」，不剥注释会命中注释里的词，把自己判成失败）。

### P3-10 `manifest.start_url` 硬编码了 sharecode（定时炸弹）

```json
"start_url": "/"
```

这个访问凭据被固化进了安装包。哪天 sharecode 轮换，
**所有已安装到桌面的图标会立刻失效**，而失败页写的是
「请让房主重新发一次邀请链接」——已经装到桌面的人根本没有入口去拿新链接。
他们只会觉得「这应用坏了」，然后删掉。

**修法**：`start_url` 改 `/`；前端把最近一次成功的 sharecode 存
`localStorage`，首页在 URL 缺失时自动补上（`replaceState`，不产生历史记录）；
SW 取 sharecode 时同样回退到这个持久化值。这样轮换后只要玩家用新链接打开过一次，
桌面图标就自愈。

**修复（v49）**：`start_url` 改 `/`；首页 head 里加一段同步脚本，把最后用过的 sharecode 存 `localStorage`，缺失时用 `replaceState` 补上。

- 必须放在 `defer` 脚本**之前** —— 它们都读 `location.search`。
- 用 `replaceState` 而不是 `pushState`：不能在用户的历史里塞一条无关记录。
- 失效页补了一句「已添加到桌面的话，用新链接打开一次，图标会自动恢复」。已安装的用户看不到任何入口，必须明说怎么办，否则他们的唯一判断是「这应用坏了」。

**残留风险（已确认接受）**：全新安装时浏览器若预取 `start_url` 拿到 403，安装可能失败。实际路径是「从带 sharecode 的链接进入 → 安装」，此时 `localStorage` 已有值，不受影响。

---

### P3-11 请求体超限时直接断连，客户端拿不到任何状态码 ✅ 已修复（v49）

写 `client-error` 的测试时，往接口发了一个 250KB 的包，结果 `status` 是 **0**——
不是 400、不是 413，是连接被掐了。查 `readJsonBody`：

```js
if (size > BODY_MAX) { finish(null); try { req.destroy(); } catch (e) {} return; }
```

`BODY_MAX` 是 16KB。超限时 `req.destroy()` 让客户端只看到 ECONNRESET。

**代价**：客户端拿不到任何可读的错误码。更糟的是**上游若有重试逻辑，会拿同一个大包反复重发**
（永远失败、永远重试），而且服务端日志里什么都看不到 —— 因为根本没走到处理函数。

**修复**：不掐连接，停止收集后返回 `null` 由调用方回 400；保留 `data` 监听器把剩余字节读走
（否则它们会堆在 socket 里）。客户端至少能看到一句人话。

`server/test/client-error.test.js` 里锁住了这条：超限必须回 **400 而不是 0**。

---

## 四、文档问题

### D-1 README 对「分牌超时」的描述与代码不符 ✅ 已修复（v48）

README 第 51 行：

> 分牌超时 **60 秒**：自动本回合弃权（仍在房间、下一把照常玩，本回合 **0 分**）

但 `stateMachine.js:387-392` 的实现注释写的是：

> 只是本回合按「空分组」处理——结算时各组都当「弃权」，**向赢家正常付分**、自己不得分。

**"0 分"和"照常付分"是两回事**。按后者，超时的人是要输分的。README 这句话会让人以为超时无害——正好反了，超时就是白送分给赢家。

**修复**：改成「自动**本回合弃权**（仍在房间、下一把照常玩）。弃权**不是 0 分**——本回合按「各组都放弃」处理：自己不收分，**但要照常向各组赢家付分**」。同时补上「重连补 15 秒」的说明。界面上的同一句话见 P2-16。

### D-2 README 缺少可操作的部分 ✅ 已修复（v48）

现在七章讲清了"是什么"，缺"怎么做"：

- **没有环境变量清单**：`PORT` / `HOST` / `DATA_DIR` / `PROFILE_FILE` / `SEED_FILE` / `BACKUP_KEY` / `REG_MAX` / `WS_AUTH_TIMEOUT_MS` / `SPLIT_TIMEOUT_MS` / `APP_VERSION` —— 散落在 5 个文件里，运维要翻代码才知道。
- **没有发布流程命令**：备份 → 改三处版本号 → 部署 → 验证，现在只在对话里说过，没落到文档。
- **没有故障排查**：主文件损坏了怎么读留档、密钥丢了怎么办、种子被覆盖了怎么恢复。
- **没有灾备演练步骤**：P0-1 这类问题正是"从没演练过恢复"才活到现在。建议文档里写一段「每季度做一次：备份 → 换空数据目录启动 → 确认能登录」。

**修复**：README 新增第八、九章：

- **八、环境变量**：14 个变量一张表，含默认值与「调大前想清楚」的提醒。逐条与代码核对过（`grep process.env` 全量比对）。
- **七、发布注意**里补了完整命令序列 + 发布后必须核对的四件事（health 三字段、md5 逐字节、SW 换缓存、布局探针）。
- **九、故障排查**：现象 → 先看哪里的对照表，覆盖 8 类线上真实会遇到的情况。
- **九、灾备演练**：四步，关键是第 3 步「用空目录 + 种子起一份新进程，确认能登录」——
  只验证「备份文件存在」等于没验证。
  顺带纠正了一处：`profiles.json` 是 `playerId → 档案` 的扁平映射，
  不是 `{players: [...]}`，`jq '.players'` 只会得到 null。

### D-3 规则表没写「弃权」与「弃局」的区别 ✅ 已修复（v48）

玩家最容易混淆的两件事：中途离开（弃局，按当时分数记战绩）vs 本回合超时（弃权，付分但不退出）。建议在规则章节单独列一小节，用一句话各自说清"我会损失什么"。

**修复**：README 流程章节后加了一张五行对照表（触发条件 / 人还在不在房间 / 本回合算分 / 对别人的影响 / 战绩），
并附上「离开前会先向服务端核对最新进度」的说明。

---

## 五、经核实为误报的条目

审查过程中有两条初判，复核后不成立，一并记录，避免以后重复怀疑：

1. **「飘三叶同型同点不比花色，胜负由座位顺序决定」** —— 不成立。实测 `comparePiaoSanYe(散牌A♠, 散牌A♥)` 返回 1、反向 -1，且把同一手牌的数组顺序打乱后结果一致，说明它**确实比了花色且与排列无关**。

2. **「`renderGame` 存在深层递归」** —— 不成立。`grep` 全文件，`renderGame(` 只有一处调用（`game.js:403`，在分阶段渲染里），函数体内无自调用。

---

## 六、建议的动手顺序

先修「会丢数据 / 会卡住」的，再修「会算错」的，最后做体验和文档：

| 批次 | 内容 | 预估 | 为什么排这个位置 |
|---|---|---|---|
| **第 1 批（今天）** | P0-1 备份脚本 + 往返测试、P0-2 离开即结算 | 1~2h | 一个丢账号、一个卡死整桌，都是线上会真实发生的 |
| **第 2 批（本周）** | P1-1 SW 预缓存、P1-2 迟到回包、P1-3 解散超时、P1-4 弃权反悔 | 3~4h | 都是玩家能直接撞上的体验断裂 |
| **第 3 批（本周）** | P1-5 令牌版本、P1-6 删号验密、P1-7 join 限流、P1-8 密钥轮换 + .gitignore | 2~3h | 安全债务，越早还越便宜 |
| **第 4 批** | P1-9 双爆口径、P1-10 配置同源 | 1~2h | 影响结算正确性，但需要先跟你确认口径 |
| **第 5 批** | P2 全量 + 文档补全 | 半天 | 不阻塞上线，可分批 |

第 4 批的十点半双爆，需要你定一个口径再动手：

- **A. 爆得少者优**（16 点赢 18 点）—— 符合直觉，也是代码里另一处的注释；
- **B. 比单张大小**（现状，9+9 赢 8+8）—— 与斗牛"比最大牌"的风格一致。

我倾向 A，但这是产品规则，得你拍。

**已决定：A（爆得少者优）**，v47 落地。

**修订**：实际推进时第 4、5 批并成一轮做完，且过程中又长出 3 条（P2-14 ~ P2-16）。
新条目不是从读码推出来的，而是「写测试 / 写文档时被现实顶出来的」——
这两件事本身就值得排进计划，不能算作「不产生价值的开销」。

**第 6 批（v49，已完成）**：P3-1 ~ P3-5、P3-7 ~ P3-11。
这一批的排序理由和前五批不同：前五批都是「会丢数据 / 会卡住 / 会算错」，
这一批全是「不影响正确性，但决定它算不算一个完成品」——

- 快（P3-1 gzip 让首屏从 328KB 降到 116KB、P3-2 删掉 1MB 没人用的图、P3-3 不让网络差的人干等）；
- 看得见（P3-5 线上报错能查、P3-7 打完能回看、P3-8 新人能看懂、P3-9 分享少三步）；
- 不会再烂掉（P3-4 CI 把「测试静默不跑」这条路堵死、P3-10 拔掉 `start_url` 那颗雷）。

**P3-6 观战单独拎出来不做**，理由见该条：它不是「多做一点」，而是「要么做完整、要么别做」。

---

## 附：修复记录

### v45（2026-10-29 02:2x）· 第 1 批两条 P0

| 项 | 改动 | 验证 |
|---|---|---|
| P0-1 | `scripts/backup-leaderboard.js` 抽出 `buildSeedMap()` 并补 `if (p.account) row.account = p.account`；`main()` 改为 `require.main === module` 才执行，避免测试 require 时触发真实拉取 | 新增 `server/test/backup-roundtrip.test.js`（25 项）：dump → 转换 → 写种子 → 新实例加载 → **能登录**；另有反向用例：去掉 account 后必须复现"账号不存在" |
| P0-2 | `stateMachine.js` 新增 `settleIfAllIn(room)`，`leaveRoom` 与 `finalizeLeave` 共用 | 新增 `pwa/test/leave-settle.test.js`（21 项）：6 个场景含"还有人没提交时不许提前结算""2 人局走 1 人走结账路径不重复结算" |

**反向验证**：把 `leaveRoom` 里的 `settleIfAllIn(room)` 注掉后，测试**恰好 4 条 FAIL**（第一轮结算、离开分牌、推进第二轮、第二轮结算），恢复后 21 项全过 —— 证明断言真的咬在这处修复上。

**灾备演练**：用真实种子（`server/data/profiles.json`）在"主文件不存在"的条件下加载 →
`restoredFromSeed: true`、`accountOf` 返回 `{"name":"player_a",...}`、`findByAccountName('player_a')` 命中、战绩在。

**测试总数**：30 套件 / 1292 断言 → **32 套件 / 1338 断言**（+46）全部通过。

**线上复验**：`app-version=20261029a`、`sw=v45`、`stateMachine.js` 里 `settleIfAllIn` 出现 3 次、
账号 `player_a` 完好、档案 `account` 含 salt/hash、非 JSON 登录 415。

**还没做**：第 3 批（P1-5 令牌吊销、P1-6 删号验密码、P1-7 joinRoom 限流、P1-8 密钥轮换）、
第 4 批（需你先定口径）、第 5 批（P2 余项）。十点半双爆口径仍待你决定。

### v46（2026-10-29 19:xx）· 第 2 批四条 P1 + 牌桌遮挡

| 项 | 改动 | 验证 |
|---|---|---|
| P1-1 | `sw.js` 新增 `withShare()`，`PRECACHE` 逐条拼上 SW 自身 URL 的查询串；install 收集失败清单写进 `self.__precacheReport` 并 `console.warn`；导航兜底改 `ignoreSearch: true`。`index.html` 改成 `register('/sw.js' + location.search)` | 新增 `pwa/test/sw-precache.test.js`（25 项）：真的把源码里的 `withShare` 抠出来跑，覆盖「原 URL 已带 ?」用 `&` 的边界 |
| P1-2 | `roomStore.js` 的 `error` 分支按「有没有 reqId」分流：有 reqId 但本地无对应请求 = 迟到回包，直接丢弃 | 新增 `pwa/test/ws-late-reply.test.js`（18 项）：假 WebSocket 直接喂消息，不起服务端。**顺带发现并修掉一个真 bug**：被踢时 `reconnecting=false` 不够，`close` 监听器会无条件重连，必须置 `disconnected=true` |
| P1-3 | `stateMachine.js` 新增 `cancelDissolve` / `expireDissolve` / `DISSOLVE_TIMEOUT_MS` / `dropDissolve(reason)`；`hub.js` 新增 `dissolveTimers` 与 `_syncDissolveTimer`（按 `startedAt` 算剩余时间，不因广播续期）；前端补「取消解散」按钮，三种结束原因分开提示 | `dissolve.test.js` +30 项（纯函数、假时间驱动）；新增 `server/test/dissolve-timeout.test.js`（22 项，真实 WS + 300ms 超时） |
| P1-4 | `submitGroups` 在「已提交 → 允许修改一次」之前先拦 `forfeitRound === round` | `forfeit.test.js` +12 项：弃权后再提交被拒、分组没被真牌替换、下一轮仍可正常提交 |
| P1-11 | 见上文 | `table-layout.test.js`（38 项）锁 CSS 与 JS 常量对账、各档机型「三组放得下」、大屏不缩水；`scripts/probe-table.js` 真机三档复验 |

**测试总数**：32 套件 / 1338 断言 → **37 套件 / 1232 项**（`grep PASS` 口径；部分服务端套件自报格式不同，`npm test` 退出码 0、零 FAIL）。

**已上线**：v46 于 2026-10-29 03:1x 发布，线上 7 个前端文件与本地 md5 逐字节一致；
真机复验 375×667 / 390×844 / 812×375 三档，`#slots` 的 `overflow` 全为 0、三组 `visibleRatio` 全为 1。

---

### v47（2026-10-29 03:2x）· 第 3 批四条 P1

| 项 | 改动 | 验证 |
|---|---|---|
| P1-5 | 账号新增 `tv`（令牌版本号），令牌 payload 带 `tv`；`index.js` 抽出 `tokenAlive()`，**HTTP 与 WebSocket 两条链路都过它**；`setPassword` / `setDisabled(true)` 各 +1；老令牌（无 `tv`）与老账号（无 `tv`）都按 0 处理，**升级当刻不会踢任何人** | 新增 `server/test/token-revoke.test.js`（27 项）：改密码 → 旧令牌 HTTP 401 / ws auth 被拒、新令牌继续可用、旧密码登不进；停用 → 403；恢复后旧令牌**仍然**无效 |
| P1-6 | `/api/auth/delete` 加 `requireJson` + 必须带 `password`，并复用登录失败计数（否则是条无视限流的爆破通道）；前端确认框内嵌密码框，`askConfirm({ secret: true })` | 同一套件第 5、6 组：不带密码 403 且账号还在、错密码 403、非 JSON 415、反复错密码被限流 |
| P1-7 | `hub.js` 新增 `JOIN_MAX=10 / 10s`（按**连接**计，`_joinLimits` 用 WeakMap），`createRoom` 与 `joinRoom` 共用额度 | 新增 `server/test/join-limit.test.js`（11 项）：额度内正常、第 11 次被拒、建房同样受限、**不影响别人的连接** |
| P1-8 | 新增 `.gitignore`（`server/backup-key.txt`、`node_modules/`、`.wbapp_*.genie`）；`git rm --cached` 掉密钥与 3 个误跟踪的 `node_modules/.bin` 残留；**轮换备份密钥**（旧 48 字符 → 新 64 字符）；README 补「轮换后要发布一次才生效」与抢救命令 | `git ls-files` 从 93 → 88 且不再含密钥；线上用新密钥访问 `?full=1` 目前 403（**符合预期**：线上还是旧密钥，下次发布后切换） |

**测试总数**：1232 项 PASS → **1270 项 PASS / 0 FAIL**（`npm test` 退出码 0）。

**未上线**：本批未发布。**注意**：新备份密钥要随下一次发布才生效。发布前若需抢救线上数据，
用 `BACKUP_KEY=<旧密钥> npm run backup`（旧密钥见 `git show HEAD:server/backup-key.txt`）——
不过当前线上数据（1 位玩家 2 场 -24）与种子完全一致，没有待抢救的内容。

---

### v48（2026-10-29 19:5x）· 第 4/5 批余项 + 文档全量 + 3 条新发现

| 项 | 改动 | 验证 |
|---|---|---|
| P1-9 | `engine.js` 的 `compareTenHalf` 双爆分支改为「爆得少者优」（先比总点数，同点再比单张）；导出 `tenHalfResolvedBetter` 作为唯一判定入口；删掉注释里那句错的「2 张牌下不可达」 | 新增 `pwa/test/double-bust.test.js`（17 项）：四类双爆组合、同点数退化到花色、可交换性、与 `tenHalfResolvedBetter` 口径一致 |
| P1-10 | `config.js` 在取不到 `global.Engine` 时 `require('./engine.js')` 兜底，服务端 `require` 也能真正把数值同步过去 | 新增 `pwa/test/config-sync.test.js`（12 项）：逐字段比对 `config.js` 与 `Engine.CONFIG` |
| P2-1 | `ws.js` 收流改为 `this.buf` + 写指针 `this.wlen`：`_append` 倍增扩容、`_consume` 用 `buf.copy` 重叠复制原地前移 | 新增 `server/test/ws-buffer.test.js`（19 项）；1 字节灌 256KB 从平方级降到 37ms |
| P2-3 | `uncaughtException`：log → `profiles.flush()` → `server.close()` → `exit(1)` | 顺序反了就会丢盘或断在途响应，已按此顺序实现 |
| P2-4 / P2-15 | health 返回 `version` + `pwa` + `server`；`version` 兜底改成静态包 meta 而非 `pkg-<package.json>`；新增 `readServerStamp()`（`server/*.js` 最新 mtime） | 实测 `{"version":"20261029c","pwa":"20261029c","server":"2026-10-28T19:37:48.143Z"}` |
| P2-5 | 新建 `server/text.js`，三处入口（hub / 注册 / 管理员改名）统一按**码点**截断并剥控制字符 | 新增 `server/test/nickname.test.js`（19 项）：emoji、ZWJ、代理对、超长、空白名、三处口径一致 |
| P2-6 / P2-7 | `admin.html` 新增 `#pw-modal`（masked × 2）替代两处 `prompt()`；`call()` 包 try/catch 返回 `{ ok:false, network:true }` | `pwa/test/admin.test.js` 覆盖弹窗流程与网络异常分支 |
| P2-8 | `profile.js` 的 `flush()` 拆成 `_serialize()` / `flush()`（同步，仅退出与测试）/ `_flushAsync()` → `_writeOnce()`（异步 + `_writeQueue` 串行） | `server/test/persist.test.js` 通过；队列串行避免两个 `rename` 互相覆盖 |
| P2-9 | `_standingsCache` + `_invalidateStandings()`，6 个写入点全部挂失效 | 新增 `server/test/leaderboard-cache.test.js`（22 项）。**首跑 2 条 FAIL 抓出真 bug**：`remove` / `reset` 漏了失效 |
| P2-10 | 登录增加纯 IP 总闸 `LOGIN_IP_MAX=30/10min`，与 `name+ip` 层并行；登录与删号两个入口都接 | 新增 `server/test/login-ip-limit.test.js`（5 项） |
| P2-11 | `splitTimers` + `splitStartedAt` 配对；`_refreshSplitDeadline` 只在剩余 < 15s 时**只补自己** | 新增 `server/test/split-reconnect.test.js`（6 项） |
| P2-12 | `.gitignore` 落地（**不**排除 `server/data/profiles.json`，它是灾备种子） | `git status` 干净 |
| P2-13 | `onLeave` 先发 `peekRoom` 拿服务端最新快照再判定弃局；文案带「第 N 轮 / 当前 X 分」；核对期间按钮显示「核对中…」；拿不到快照时明确追加「没连上服务端核对」 | 新增 `server/test/peek-room.test.js`（16 项）+ `pwa/test/peek-room-client.test.js`（21 项）+ 真浏览器探针 `scripts/probe-leave.js`（19 项） |
| **P2-14（新）** | `hub.js` 新增单连接消息限流 `MSG_MAX=60/秒`，检查放在 `JSON.parse` **之前**；连续 3 个窗口超限断开 | 新增 `server/test/msg-limit.test.js`（12 项）：正常节奏不受影响、20 连发只处理 6 条、第 4 个超限窗口被踢、不牵连其他连接 |
| **P2-16（新）** | 前端手牌状态条「本回合计 0 分」→「本回合不收分，仍要照付各组赢家」 | 与 D-1 同一口径；无测试断言旧文案 |
| **P2-17（新）** | 新增 `ProfileStore.resetStats()`：复用 `_blank()` 的字段集合把战绩归零，保留 `playerId`/`nickname`/`account`，清掉 `_seen`；新增 `POST /api/admin/reset-stats`，与 `reset` 共用密钥与 POST 限制，响应带 `mode` 区分 | 新增 `server/test/reset-stats.test.js`（49 项）：清空后**原密码仍能登录**、`prune()` 不扫账号、文件与重启后仍是 0 战绩、`mode` 能区分两个入口 |
| **P2-18（新）** | `scripts/probe-table.js` 的自清理补上 `password` + `Content-Type`，并校验返回 `ok === true`（以前 `return j` 等于没断言） | 三次线上复验后 `?full=1` 只返回 1 份真实档案，无残留 `probe` 账号 |
| D-1 / D-3 | README 重写「流程与超时」，补「弃权 vs 弃局」对照表 | — |
| D-2 | README 新增八（环境变量 14 项）、九（故障排查 8 类 + 灾备演练 4 步）；第七章补完整发布命令与四项核对 | 环境变量逐条 `grep process.env` 核对 |

**测试总数**：1270 项 PASS → **1378 项 PASS / 0 FAIL**（`npm test` 退出码 0）。
增量来自：`ui.test.js` 的离开确认框断言从 1 条扩成 11 条（+10）、
`peek-room`（+16）、`peek-room-client`（+21）、`msg-limit`（+12）、`reset-stats`（+49）。
其余 8 套新测试在 v47 阶段已计入 1270。

**这一轮最值得记的四件事**：

1. **`peekRoom` 不能复用 `reconnect`**。第一版图省事直接调 `reconnect` 读状态，但 `reconnect` 会
   `_refreshSplitDeadline`——反复点「离开 / 取消」就能无限续分牌时间。只好新开一个纯读通道，
   并写测试专门证明「截止前反复 peek，到点照样判弃权」。
2. **P2-14 是写测试时打出来的**。那条测试为了证明「peek 不续命」在循环里狂发请求，
   结果 1.4 秒内服务端照做了 13190 条——顺带暴露出整条协议没有消息级限流。
3. **P2-15 是写文档时打出来的**。按原实现去写「`version` 与 `pwa` 不一致就是只发布了一半」，
   发现线上永远返回 `pkg-0.2.0`，这句话永远成立——文档照实写就是在教人做错的判断。
4. **`peekRoom` 的「成功当失败」只有真浏览器抓得出**。
   服务端回包是 `{ room }`，**没有 `ok` 字段**（其它接口也一样，都由客户端各自补 `{ ok: true }`）。
   第一版漏了这一步，`res.ok === undefined`，`onLeave` 的 `(res && res.ok && res.room)` 恒为假。
   而它的**症状是「多出一行『没连上服务端核对』」**——看起来完全像网络问题，
   单元测试（只测服务端）和静态读码都发现不了。
   跑 `node scripts/probe-leave.js`（真 Edge + CDP，注册→建房→开局→点离开）才暴露：
   标题、轮次、分数全对，只有那一行降级提示不该出现。
   修完补了 `pwa/test/peek-room-client.test.js`（21 项）锁住回包形状——
   这类「功能和降级路径长得一模一样」的 bug，只能靠断言回包形状挡住。

**已上线**：v48 于 2026-10-29 08:5x 发布。复验结果：

| 项 | 结果 |
|---|---|
| health | `version=20261029d`、`pwa=20261029d`、`server=2026-10-29T00:55:19Z`（新构建戳）、`uptime=15`（确认重启） |
| 前端 16 个文件 | md5 与本地**逐字节一致** |
| 新接口 | `POST /api/admin/reset-stats` 错误密钥→403、GET→405（路由确实上线） |
| 牌桌布局 | 375×667 与 390×844 两档 `overflow=0`、三组 `visibleRatio=1`、大屏牌仍 144×202 |
| 探针清理 | `?full=1` 只剩 1 份真实档案，无残留 `probe` 账号 |

**随后清空排行榜**（用户要求「只清战绩、保留账号」）：

```
POST /api/admin/reset-stats → {"ok":true,"cleared":1,"mode":"stats"}
普通榜单  → {"list":[]}                       ← 榜单已空
full=1    → games=0 net=0 account={name:"player_a",salt,hash}   ← 账号完好
```

清完**立刻重新备份并再发布一次**，让 `server/data/profiles.json`
（容器重建时的种子）也变成「空战绩 + 账号在」，否则灾备恢复会把旧榜单带回来。

灾备演练顺手做了一遍（README 第九章第 3 步）：空目录 + 该种子起新实例 →
`restoredFromSeed: true`、1 份档案、战绩 0、`findByAccountName('player_a')` 命中、
口令校验可用。

---

### v49（2026-10-29 21:xx）· 第 6 批：工程与产品 10 条 + 1 条新发现

| 项 | 改动 | 验证 |
|---|---|---|
| P3-1 | `server/index.js` 引入 `zlib`：`gzipFor(filePath, stat)` 按「路径 + mtime + size」缓存，`acceptsGzip(req)` 认 `gzip` 且认 `q=0` 拒绝，`sendFile` 与 `sendJson` 各加一条压缩分支。阈值 1KB、级别 6、缓存上限 96 条、压完不比原文件小就放弃。`/api/health` 也改走 `sendJson`（原来自行 `writeHead`，是全站唯一不带 `Vary` 的 JSON 接口） | 新增 `server/test/gzip.test.js`（24 项）。真实 curl：`index.html` 37868 → **11455**（-70%）、`js/game.js` 152165 → **51680**（-66%）；首屏 5 个文本资源 328KB → **116KB**（-65%）；`health` 118 字节**不压**（低于阈值）；`Vary: Accept-Encoding` 全站都在 |
| P3-2 | 删掉 `pwa/assets/` 下三张零引用 PNG：`home_bg.png`(500K)、`table_bg.png`(416K)、`card_back.png`(96K)。同名 `.webp` 都在用，PNG 是早期残留 | `grep -r` 全站零引用；`pwa/assets` 1.4M → **364K**；三档真机复验背景与牌背显示正常 |
| P3-3 | `sw.js` 新增 `networkFirst(req, timeoutMs)`：`Promise.race([fetch, 计时器])`，导航 3s / 静态资源 2s；**超时不 abort**，原请求继续跑并照常写缓存，只是先把缓存里的旧版本给用户。403 友好页收窄到 `req.mode === 'navigate'`（以前连 JS 请求也返回 HTML） | 新增 `pwa/test/sw-timeout.test.js`（16 项）：假 `fetch` 永不 resolve，断言 `dispatch` 在超时后返回缓存、且超时后网络返回仍写入缓存 |
| P3-4 | 新增 `scripts/run-tests.js`：扫描 `pwa/test` + `server/test` 自动纳入，串行跑、单文件 120s 超时、失败详情集中在末尾；`package.json` 的 `test` 换成它。新增 `.github/workflows/test.yml`：push / PR / 手动，Node 22，`git ls-files '*.js'` 逐个 `node --check` + `npm test`，另有 `if: always()` 的残留告警（只 warning 不 fail） | 见下方「最值得记的第一件事」——这个改动直接暴露出 11 套测试从没跑过 |
| P3-5 | 新增 `pwa/js/errorReport.js`（UMD，浏览器加载即 install）：`error` 用捕获阶段监听以拿到资源加载失败，`unhandledrejection` 一并收；`sendBeacon` 优先、`fetch keepalive` 回退；每会话 10 条、同 message 去重、`capture()` 整体包 try。服务端新增 `POST /api/client-error`（不要求登录、按 IP 40 条/分钟、字段按码点截断并剥控制字符） | 新增 `pwa/test/error-report.test.js`（27 项）+ `server/test/client-error.test.js`（12 项）。查线上：`docker logs … | grep '[client-error]'` |
| P3-7 | `stateMachine.js` 的 `newRoom` 加 `history: []`，`settleRound` 归档精简副本（`id/nickname/hand`），保留最近 4 轮；前端结算页加「本局过程」按钮与 `#replay-modal`，`renderReplay()` 纯 DOM 渲染。**观战者在 `_view()` 里本来就被裁掉手牌，所以这份数据不需要额外脱敏** | 新增 `pwa/test/replay.test.js`（29 项）：归档只留 4 条、不含 `account`/`token`、跨局不串台 |
| P3-8 | 新手引导从「一屏长文」改成 4 步：`#guide-modal` 带 `data-step="0..3"`、圆点、上一步/下一步/跳过；首次访问延迟 1.2s 自动弹（`localStorage['lxw_guide_seen_v1']`）；`#btn-rules` 也指向它，Esc 与 `popstate` 都能关。示意图全用 CSS 画（`.gcard`/`.gchip`），不引图片 | `pwa/test/ui.test.js` 新增 12 条断言（步骤切换、跳过、只弹一次、Esc 关闭）。真机 375×667 四步均不溢出 |
| P3-9 | `onCopy()` 里加 `navigator.share`（放在**第一个 `await` 之前**，否则丢了用户手势会被浏览器拒），`AbortError` 视为取消不报错；`onShareSave()` 去掉 `isIOS()` 卡点——原逻辑让 iOS 在非微信环境下永远走「长按保存」文案，白白浪费了系统分享 | `ui.test.js` 新增 8 条：share 优先于剪贴板、取消不落到剪贴板、非微信 iOS 也走 share |
| P3-10 | `manifest.webmanifest` 的 `start_url` 从 `/` 改为 `/`；`index.html` head 加一段**同步**脚本（在 defer 之前）：带 `sharecode` 就存 localStorage，没带就补回 URL（`history.replaceState`）。这样「从桌面图标进」和「从分享链接进」走同一条路 | `ui.test.js` 新增 7 条：`start_url` 不含 `sharecode`、URL 无参时能从 localStorage 补回、显式参数优先且会覆盖旧值 |
| **P3-11（新）** | `readJsonBody` 超限不再 `req.destroy()`，改为丢弃已收 chunk 并回 400。原来客户端只看到 `ECONNRESET`，拿不到任何状态码 | 见下方「最值得记的第二件事」 |
| P3-6 | **未做**（有意推迟） | 理由见 P3-6 正文 |

**测试总数**：旧口径 1378 项 → **54 个文件 / 1815 项 / 0 FAIL / 46.8s**。

精确拆法（这次是按每个文件自报的「N 项」累加，不是 `grep PASS`）：

| | 文件 | 断言 |
|---|---|---|
| 旧 `test` 链里的 38 个文件 | 38 | **1509** |
| v47/v48 写好但**从没被执行过**的 11 个 | 11 | **198** |
| v49 新写的 5 个 | 5 | **108** |
| 合计 | 54 | **1815** |

**顺带更正两处旧账**（都在上文，不改原文，只在这里标出）：

1. v48 写的「1270 → 1378」和「增量来自 peek-room +16、peek-room-client +21、msg-limit +12、reset-stats +49」**都是错的**——
   那四个文件当时压根不在 `test` 链里，对应的断言一条也没跑过。
   1378 是 `grep PASS` 的口径，对服务端那几个自报格式不同的套件是低估的；旧链 38 个文件真实是 1509 项。
2. v46 写的「1232 项（`grep PASS` 口径）」同理，是低估值，不是真实规模。

**这一轮最值得记的三件事**：

1. **11 套测试从没跑过，而且是静默的。** 之前几次给 `package.json` 加测试命令是用 `String.replace`
   按锚点插入的，锚点没匹配上时 `replace` 不报错、原样返回——于是命令没加进去，我却以为加了。
   症状是「测试全绿」但新写的套件其实一次没执行。这不是某一次疏忽，
   **是「用文本替换改构建配置」这个手法本身的失败模式**，只要还在用就会再犯。
   所以 P3-4 的真正价值不是那个 CI 文件，而是把入口换成「扫描目录」——
   新增测试文件不需要改任何配置，这条失败路径被从根上掐掉了。
   这一改，11 个文件、198 项断言当场浮出水面（含 `leaderboard-cache` 的 22 项）。

2. **`error-report` 的 stack 断言写错会「通过」，但线上 stack 永远是空的。**
   第一版测试把 stack 放在 `ev.stack`，真实浏览器挂在 `ev.error.stack`。
   代码读 `ev.error.stack` 是对的，测试断言 `ev.stack` 被读到也是「对的」——
   两边各自自洽，只有真跑才会发现采集端永远拿不到堆栈。
   这类「测试和实现互相印证同一个错误假设」的 bug，比测试没写更危险：
   它会给你一个绿色的勾。修完 27 项断言里有 4 条专门钉在 `error.stack` 的取值路径上。

3. **观战在服务端是一天的事，在前端不是。**
   `_view(room, viewerId)` 本来就会裁掉别人的手牌，服务端只要放开「房间满了不许进」
   并把观战者标记成 `viewer` 就够了。但 `game.js` 里有 **37 处** `state.myId`，
   其中多处直接写 `me.score` / `me.nickname`，观战者的 `me` 是 `null`，
   逐处加分支要覆盖房间页、对局页、结算页三块，且现有测试对观战 UI 零覆盖。
   做一半的结果是「能进去，然后白屏或抛异常」——比现在「明确告诉你房间满了」更差，
   还会把这一批已修好的 9 项拖回去。所以这一条**明确不做**，留档待办。

**还没做（明确列出，不含糊）**：

| 项 | 为什么 | 补的时候要注意 |
|---|---|---|
| P3-6 观战 | 见上 | 37 处 `state.myId` 的 null 分支 + 观战 UI 探针，别只改服务端 |
| P3-7 的「离房留存」 | 现在回放只在结算页可看，退房就没了。要做需把精简回放写进档案 `lastReplay`，跨 `profile.js` + 新接口 + 战绩页三层 | 注意别把整局手牌写进档案，那是存储放大；只留 `id/nickname/hand` 和结算结果 |

**未发布**。本轮只改代码与文档，没有动线上。发布要等你明确说。

---

# 七、v50 全量复评（2026-10-29 09:5x）

> 触发：用户「发布，然后再全量 review 并评估是否是足够优秀的扑克类 pwa app」
> 方式：**对线上实例取证据**（`https://liuxuanwu.app.workbuddy.host`），不是读本地代码猜行为。
> 与前六批的关系：前六批是「找 bug」，这一轮是「判断它是不是一个好产品」。
> 所以下面七条新发现，**没有一条会让人丢数据或算错分**——它们是「离优秀还差什么」，
> 而不是「现在坏了什么」。严重度按对**留存/口碑**的影响排，不按技术难度排。
>
> **补充（v50 动手阶段）**：用户看完这一章的结论后，让做 P4-1 + 回放离房留存、不做观战。
> 动手过程中又挖出三条 —— **P4-8（引导/回放尺寸单位错）、P4-9（`.gchip` 撞名）、
> P4-10（`full=1` 不压缩）**。这三条和前面七条性质不同：**它们已经上线了，是实打实的线上缺陷**，
> 而且 P4-9 影响的是对局页最核心的分组按钮。所以现在这一章共 **10 条**，其中 4 条已修（P4-1、P4-8、P4-9、P4-10）。

## 7.1 十条新发现

### P4-1 从微信切回来，桌面可能冻住最长 60 秒 ✅ 已修复（v50）

**证据（读码，`pwa/js/roomStore.js:279-290`）**：

```js
heartbeatTimer = setInterval(function () {
  if (!socket || socket.readyState !== 1) return;
  socket.send(JSON.stringify({ type: 'ping' }));
  missedPongs++;
  if (missedPongs >= 2) { try { socket.close(); } catch (e) {} }
}, 30000);
```

全站**没有任何** `visibilitychange` / `pageshow` / `pagehide` 监听：

```
$ grep -rn "visibilitychange\|pageshow\|pagehide" pwa/js
（无输出）
```

**后果**：这个产品的真实使用场景是「微信群发链接 → 大家进来 → 有人切出去回消息 →
回来继续出牌」。iOS 上切出去超过 30 秒，WebSocket 有相当概率被系统掐掉，
而**浏览器的 `close` 事件依赖浏览器自己发现**：

- 好情况：切回来立刻收到 `close` → 走退避重连，1~2 秒恢复；
- 坏情况：连接半开（NAT 超时、休眠唤醒），`readyState` 仍是 1，客户端**以为还连着**。
  这时唯一的出路是心跳：下一次 `setInterval` 触发（后台被节流，回来后才跑）→
  `missedPongs` 从 1 变 2 → 主动 `close()` → 才重连。**最坏要 60 秒**，
  这期间桌面停在旧状态，玩家看得见别人的牌却无法出牌，也不知道该等。

**这一条比它看起来严重**：它不会报错、不会掉线提示，表现为「点没反应」，
而玩家已经形成了「这游戏会卡」的印象。修复成本 3 行：

```js
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  missedPongs = 0;                                  // 别拿后台期间的欠账惩罚前台
  if (socket && socket.readyState === 1) {
    try { socket.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
  } else if (!disconnected) {
    startReconnect();                               // 已经死了就立刻重连，别等下一个周期
  }
});
window.addEventListener('pageshow', function (e) {
  if (e.persisted) { missedPongs = 0; /* 同上：bfcache 复活时连接一定是死的 */ }
});
```

`pageshow` 那条对应另一个真实场景：**点了页面里的外链 → 返回**。
Safari 会把页面从 bfcache 里原样复活，DOM 还在、桌面还在、连接是死的。

**修复（v50）**：`roomStore.js` 里新增 `confirmAlive()` / `dropAndReconnect()`，
并在模块初始化时挂 `visibilitychange` 与 `pageshow`。

- 回前台先发一枪 `ping`（成本为零），**2.5 秒没收到 pong 才断**。不是见面就重连：
  频繁切前后台会变成频繁重连，而每次重连服务端都要 `_refreshSplitDeadline` 补时限，
  那会把分牌倒计时搅乱。
- 探活前先把 `missedPongs` 清零 —— 后台期间攒的欠账不能拿来判前台死刑。
- `pingProbeTimer` 在收到 `pong`、`stopHeartbeat`（连接被换掉）时都会撤销，
  否则它会对着新 socket 误判一次。
- `pageshow.persisted` 走的是 `dropAndReconnect()` 直接重建，不 ping：
  bfcache 复活时连接一定是死的，而 `readyState` 可能还停在 1，ping 也等不到回音，
  等 2.5 秒纯属白等。
- `disconnected`（被踢 / 鉴权失败）时两个入口都不动。**被踢还自动连回来比冻住更糟。**

配套测试 `pwa/test/room-visibility.test.js`（20 项）：监听注册、探活发出、
有 pong 不断线、无 pong 2.5s 后断并触发重连、欠账清零、bfcache 直接重建、
普通 pageshow 不动连接、被踢后不再折腾。

---

### P4-2 `maskable` 和 `any` 复用了同一张图，而这张图几乎贴边

**证据（`pwa/manifest.webmanifest`）**：

```json
{ "src": "/icons/icon-512.png", "sizes": "512x512", "purpose": "any" },
{ "src": "/icons/icon-512.png", "sizes": "512x512", "purpose": "maskable" }
```

同一张文件承担两个语义，而它们的约束是**冲突**的：

- `any`：希望图形尽量占满（图标越大越显眼）；
- `maskable`：必须把内容收在**中心 80% 的圆**里（四周 10% 是给系统裁切留的）。

实测这张图的外圈金边距画布边缘只有约 **4%**（512px 图上约 20px）。
结果是：Android 用圆形/水滴形遮罩时，**四个角的金边会被切掉**，
视觉上像「一个被圆规裁过的方框」，而不是设计过的自适应图标。

**修法**：单独出一张 `icon-maskable-512.png`——绿底铺满整个画布，
中间那个白色卡牌缩到 80% 安全区内，外圈金边去掉（遮罩会自己给它圆角）。

---

### P4-3 静态资源只 `max-age=3600`，而且没有 `ETag`

**证据（`curl -I`）**：

```
js/game.js        → Cache-Control: public, max-age=3600     （无 ETag / 无 Last-Modified）
css/style.css     → Cache-Control: public, max-age=3600     （同上）
assets/*.webp     → Cache-Control: public, max-age=3600     （同上）
index.html        → Cache-Control: no-store, must-revalidate
```

`server/index.js:420` 一行决定：

```js
'Cache-Control': isHtml ? 'no-store, must-revalidate' : 'public, max-age=3600',
```

**问题**：所有资源都带 `?v=<app-version>`，版本变了 URL 就变了——
这是标准的 **immutable** 场景，可以放心 `max-age=31536000, immutable`。
现在只有 1 小时，且**没有 ETag**，意味着过了 1 小时再来就是**无条件全量重新下载**：

```
首次加载 gzip 传输合计 142271 字节 ≈ 138 KB（实测逐个资源累加）
  index.html 11455 + style.css 20921 + game.js 51680 + stateMachine 11489
  + engine 10726 + roomStore 8950 + records 4841 + card 4118 + errorReport 3130
  + authStore 3070 + slotLayout 2832 + sfx 2355 + config 1672 + records.css 5032
另有 assets/home_bg.webp 84306 字节
→ 首屏 ≈ 138 KB（文本）+ 84 KB（背景图）
```

**影响面有多大要说清楚**：装了桌面的用户有 SW 缓存兜底，基本无感；
**纯浏览器打开的玩家（微信里点链接进来、还没安装的那批）**第二天再进来就要重下 138KB。
这群人恰恰是最该被留住的新玩家。

**修法**：非 HTML 一律 `public, max-age=31536000, immutable`，
并补 `ETag`（用已有 gzip 缓存的 `mtime-size` 当弱 ETag 即可，不用算内容哈希）。
HTML 保持 `no-store` 不变——它必须每次问服务器要最新的。

---

### P4-4 没有任何安全响应头（CSP / X-Frame-Options）

**证据（线上响应头全量）**：

```
X-Content-Type-Options: nosniff
（CSP：无    X-Frame-Options：无    Referrer-Policy：无    Permissions-Policy：无）
```

网关只给了 `nosniff`，服务端 `server/index.js` 一个都没设。

**为什么现在不算事故**：我把渲染层扫了一遍——

- `game.js` 的 30 处 `innerHTML`，所有用户可控字段（`nickname` / `roomId` /
  `winnerNickname` / 错误消息）**全部**过 `esc()`（`& < > " '` 五字符转义）；
- `admin.html` 的账号表格同样过 `esc()`，`account` / `nickname` / `playerId` 都在内；
- 服务端 `text.js` 按**码点**截断并剥控制字符，昵称里塞不进 `<`。

所以**目前没有已知的 XSS 入口**。缺的是第二道防线：一旦某天有人加了一处
没过 `esc()` 的插值，`localStorage` 里那枚 **90 天有效**的令牌就整个被带走。
没有 CSP 意味着浏览器连报都不会报。

**修法（一次性，五行）**：

```
Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:;
  style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:;
  frame-ancestors 'none'; base-uri 'none'; form-action 'none'
X-Frame-Options: DENY
Referrer-Policy: same-origin
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

注意 `style-src` 必须留 `'unsafe-inline'`：`index.html` 里有 13 处内联 `<script>`
和大量 `style="..."` 内联样式，收紧到 `'self'` 会当场白屏。
`script-src 'self'` 是第一优先级——它才是挡住「注入一段脚本」的那一道。

`X-Frame-Options: DENY` 顺带解决一个真实可能：**这个游戏可以被任意网站 iframe 嵌套**，
配合「点牌」这种高频点击，理论上可做点触劫持（虽然最坏后果也就是输一把分，危害有限）。

---

### P4-5 管理后台「改昵称」还在用 `prompt()`

v47 的 P2-6 只换了**密码**那一处（`#pw-modal`），昵称那处漏了：

```js
// pwa/admin.html:331
var nick = prompt('「' + u.account + '」的新昵称（最多 8 字）', u.nickname || '');
```

密码用 `prompt()` 之所以必须换，是因为**明文显示**；昵称不需要遮，所以危害小得多。
但同一张表格里两个按钮行为不一致（一个弹自定义弹窗、一个弹系统框），
在手机上 `prompt()` 会被键盘顶掉、且无法在弹窗里做「8 字上限」的即时校验。
既然 `#pw-modal` 已经是现成的，复用它改个 `maxlength` 就能收口。

---

### P4-6 单文件 JSON 存储有一个明确的天花板

**证据（`server/profile.js`）**：每次对局结束 `_flushAsync()` 会把**整个档案表**
序列化后写临时文件再 `rename`。当前 3 份档案 ≈ 4KB，完全无感。

**天花板在哪**：按每份档案 ~1.3KB 估（含 20 条 `recent`、salt/hash），

| 账号数 | 文件大小 | 单次全量写 | 判断 |
|---|---|---|---|
| 100 | ~130 KB | < 1ms | 无感 |
| 1,000 | ~1.3 MB | ~3ms | 无感 |
| 5,000 | ~6.5 MB | ~15ms | 可接受 |
| 20,000 | ~26 MB | ~60ms+ | 每次结算卡一次事件循环 |

也就是说：**这是一个「最多几千人」的架构，不是一个「能长大」的架构。**
对「朋友房」定位完全够用（真正的并发是几十人），但要在 README 里写清这条边界，
否则哪天有人拿它做公开匹配，会发现「打到第 3000 个玩家时开始偶尔卡顿」。

顺带：多实例部署**绝对不可用**（两个进程各写各的文件，后写覆盖先写）。
要扩只有一条路：把 `profile.js` 换成真正的 KV/数据库。它在架构上已经隔离得不错
（只有这一个模块碰磁盘），换起来是单文件替换，不是重写。

---

### P4-7 没有安装引导，Android 上也几乎不会有人装

`grep -rn "beforeinstallprompt\|appinstalled" pwa/` 无输出。

Chrome/Edge 的 `beforeinstallprompt` 事件会被 `preventDefault` 拦下，
存起 `deferredPrompt`，然后在合适时机（比如开局前、结算后）弹一个「添加到桌面」。
现在完全没有：Android 用户只能靠浏览器菜单里那个不起眼的入口，
iOS 用户只有 SW 403 页上那一句文案。

**为什么这条排最后**：它不是能力缺失，是**增长杠杆没拉**。
已经装了的人体验完整（standalone、图标、离线壳都在）。
要不要做取决于你想不想让它从「每次点链接」变成「桌面上有个图标」。

---

### P4-8 引导与回放的样式按「CSS 像素」写，落到屏幕上只有一半大 ✅ 已修复（v50）

**触发**：用户直接说「这个展示很丑」，并贴了 4 张引导弹窗截图。

**根因不是配色，是单位**。这个页面运行在 **750 宽的设计空间**里
（`game.js` 的 `stageW = CONFIG.DESIGN_WIDTH = 750`，`#stage` 整体
`transform: scale(视口宽 / 750)`）。也就是说 CSS 里写的每个 px 都要再乘约
**0.52** 才是屏幕像素。

P3-8 和 P3-7 那两段样式是照着「CSS 像素」的直觉写的：

| 属性 | v49 写的 | 屏上实际 | 其它弹窗的对照 |
|---|---|---|---|
| `.guide-card` max-width | 360px | 187px（占屏宽 **48%**） | `.modal-card` 是 640px |
| `.guide-step h2` | 19px | **约 10px** | `.modal-card h2` 是 40px |
| `.guide-step p` | 14px | **约 7px** | `.modal-box p` 是 28px |
| `.gcard` 牌 | 34×46 | 18×24 | 牌桌实牌是 100×140 |
| `.guide-dots i` 进度点 | 7px | **3.6px**（等于没有） | — |
| `.replay-card` max-width | 380px | 198px | 同上 |
| `.replay-row` 字号 | 12.5px | **约 6px** | — |

**为什么当时没发现**：这两段都是纯 CSS，没有断言会去量「渲染后的字号」。
`ui.test.js` 里的是静态字符串匹配，看得到 `font-size: 19px`，但看不出它在
缩放坐标系里意味着 10px。这就是必须有一支**真浏览器探针**的理由。

**修复（v50）**：整段按设计像素重写（大致 ×2），并做了版式重做：

- 卡片 620px（占屏宽 83%），4 屏高度统一（`.guide-body { min-height: 616px }`）
  —— 不锁的话点「下一步」时弹窗会上下跳一下，很像卡顿。
- 示意图区从「浅灰绿底 + 小白卡」换成**深绿牌桌底 + 白牌**，与产品主色一致；
  第一屏的三组（1/2/3 张）用**组间金色细分隔线**分开
  （试过等宽三列：第三组 3 张牌比一列还宽，直接顶出牌区）。
- 进度点改成 4 段横条 + 三态（已过 / 当前 / 未到）。
- 第一步的「上一步」改成真的 `display:none`：v49 用 `visibility:hidden` 占位，
  结果第一屏左边空出半格、一个红按钮孤零零挂在右边，比「跳一下」难看得多。
- 第 4 屏的「王的四重身份」从整段话改成**对齐的列表** —— 整段话会出现孤字吊尾
  （「三张。」单独一行）。
- 回放弹窗顺带修掉 `max-height: 56vh`：**vh 取的是视口单位，但它挂在缩放坐标系里**，
  56vh 落屏只剩 29% 的高度，内容一多就挤成一条缝。改成交给 `.modal-card` 的 82%
  兜底，flex 自己收缩滚动。

配套探针 `scripts/probe-guide.js`（39 项，量的是**渲染后的屏幕像素**）与
`scripts/probe-records.js`（15 项，顺带验「看过程」入口的可点热区 ≥ 28 屏幕px）。

**顺带发现的文案错误**：v49 的引导写「第二轮把剩下的再拆成 1/5 张」——
但 `stateMachine.js` 里 `round === 1` 只切阶段、**不重新发牌**，第二轮用的是
**同一手 6 张**。而第一轮 1+2+3 正好把 6 张全用完了，"剩下的"无从谈起。
新玩家看到的第二句话就是错的，会以为第二轮有新牌。已改成「第二轮用**同一手牌**
再拆成 1/5 张比」。

---

### P4-9 引导样式里的 `.gchip` 与对局页分组按钮撞名，把核心交互打回原形 ✅ 已修复（v50）

**这条已经上线了**，是本轮改样式时发现的。

`pwa/css/style.css` 里有两处 `.gchip`：1017 行是**对局页的分组选择器**
（1/2/3 张那三个按钮），2077 行是 P3-8 引导里的玩法标签。后定义的覆盖前面的，
于是引导上线那一刻起，分组按钮就丢了设计稿的样子：

| 属性 | 设计值 | 被引导样式覆盖后 |
|---|---|---|
| `font-size` | 24px | **13px**（落屏 6.7px） |
| `background` | `rgba(0,0,0,.3)` 半透明 | **纯深绿 `#16382F` 实心块** |
| `padding` | `0 18px` | 7px 12px |

分组选择是这游戏最核心的交互（每轮都要点三次），字号掉到 6.7px 是实打实的可用性退化。
v49 的测试全绿，因为**没有一条断言会去量分组按钮的字号**。

**修复（v50）**：删掉引导段的 `.gchip`（引导的玩法标签改用 `.gtile`，
它本来就是另一种形态，不该复用对局页的类名）。
`scripts/probe-guide.js` 里加了两条断言，直接量 `.gchip` 的计算字号与最小热区，
以后再有谁不小心覆盖它，探针会当场报。

---

### P4-10 `?full=1` 全量导出绕过了 `sendJson`，等于永远不压缩 ✅ 已修复（v50）

**这条也已经上线了**，是被 `gzip.test.js` 抓出来的。

`server/index.js` 的 `/api/leaderboard` 自己 `res.writeHead(...)` + `res.end(...)`，
没有走 `sendJson`。而 `sendJson` 里那句注释写得很清楚：

> 只对体积过阈值的响应压缩：普通的 {ok:true} 只有二十几个字节……
> **真正受益的是 ?full=1 的全量导出。**

也就是说：**注释点名要优化的那个接口，恰恰是唯一没走这条路径的**。
`full=1` 会吐出每个人的完整档案 + 近 20 场流水，是**全站最大的响应**，
而且档案越多它越大 —— 越是该压的时候越不压。这和当初 `/api/health` 自己
`writeHead` 导致全站唯一不带 `Vary` 是同一个坑。

**修复（v50）**：三个出口（两处 403 + 一处 200）全部改走 `sendJson`。

**测试本身也有问题**：原来那条断言写的是

```js
if (body.length >= 1024 || hasGzip) { 断言有 gzip }
else { ok(true, '当前档案太少，跳过') }
```

两个条件都推不出结论 —— 档案少的时候打一句「跳过」就当通过，
档案一多就 FAIL 也说不清为什么。改成反过来断言：
**只有「确实没到 1KB」才是合法的未压缩理由**，到了阈值还没压就是 bug。
顺手补一条「全量导出的 Content-Length 也必须是压缩后的长度」。

---

## 7.2 分维度评分

评分基准不是「和自己比」，是**和「一个同类里算优秀的联机扑克 PWA」比**。
10 分 = 这个维度上很难再挑出问题；7 分 = 明显合格但有可见缝隙；5 分 = 能用但经不起细看。

| 维度 | 分 | 依据（都可复验） | 差在哪 |
|---|---|---|---|
| **规则正确性** | **9.5** | 1815 项断言 / 0 FAIL；十点半双爆口径、飘三叶豹子加成、斗牛没牛罚 5 分都有独立测试；单组 deltas 之和为 0 的零和校验；`config.js` 与服务端 `Engine.CONFIG` 逐字段对账 | — |
| **服务端严谨度** | **9** | 服务端权威状态机；`_view(room, viewerId)` 按视角裁手牌；座位令牌（不是裸 `playerId`）；令牌版本 `tv` 吊销；消息级 60/s 限流；三层登录限流 | 无多实例能力（P4-6） |
| **安全** | **8** | 渲染层 `esc()` 全覆盖（我逐处扫过，无遗漏）；`text.js` 码点截断；删号验密码并走同一套失败计数；备份密钥已轮换且不进库 | 没有 CSP / XFO（P4-4）；令牌在 localStorage |
| **性能** | **8.5** | gzip 后首屏 138KB；`?v=` 版本化；SW 预缓存 + 超时兜底；榜单缓存；WS 收流 O(n) | 静态资源只 1h 且无 ETag（P4-3） |
| **PWA 完整度** | **8** | manifest 有 maskable / apple-touch-icon / standalone / theme-color / `viewport-fit=cover`；SW 有离线壳与超时；`start_url` 已去硬编码并自愈 | maskable 复用同一张图（P4-2）；无安装引导（P4-7） |
| **移动端手感** | **8.5** | 750×1624 设计分辨率 + 三档机型布局测试；三组牌不裁切；安全区适配 | 前后台死区已修（P4-1）；v50 前是 7.5 |
| **产品完成度** | **8.5** | 四种玩法一个房间、AI 可凑局、**回放（房间内 + 退房后都看得到）**、4 步新手引导（v50 重做）、Web Share、战绩页、排行榜、**战绩与排行榜同源（v51）** | **仍无观战（P3-6，用户明确不做）** |
| **增长 / 留存** | **5.5** | 分享链路完整（复制 / 系统分享 / 战绩图） | **无大厅、无匹配、无每日任务、无安装引导**——冷启动 100% 靠房主手动发链接 |
| **工程质量** | **9.5** | 零运行时依赖（WS 自己实现，含分片续帧与掩码解码）；扫描式测试入口；CI；探针（真浏览器 + CDP）；REVIEW.md 五十余条带证据 | 前端手工 bump 版本号（四处），建议脚本化 |
| **文档 / 可运维性** | **9** | README 十章：规则唯一权威处、环境变量 14 项、故障排查 8 类、灾备演练 4 步、五项发布核对 | — |

**加权结论：约 8.7 / 10**（v51 把「战绩与排行榜同源」补上后的复评；
v50 是 8.6，v50 之前是 8.3）。

三条修复直接把两个最弱项抬了起来：移动端手感 7.5 → **8.5**（P4-1），
产品完成度 7 → **8**（回放留存）→ **8.5**（战绩同源）。
剩下真正压分的只有**增长 / 留存 5.5** ——
那是产品方向问题（要不要做大厅/匹配/每日任务），不是代码质量问题。

> 补一句这次为什么值得单独给 0.1：P5-1 ~ P5-6 不是「功能缺失」，是**数据说不清楚**。
> 一个玩家的战绩在战绩页和排行榜上对不上，他不会去分辨哪个是 bug，
> 只会得出「这游戏数据不可靠」——这条比任何一条 UI 缺陷都伤信任。

---

## 7.3 所以，它「足够优秀」吗

**分两种问法，答案不一样，我不含糊：**

**① 「这是一个优秀的扑克类 PWA 工程吗？」——是，明确是。**

三条硬证据，都不是自评：

1. **规则实现有可验证的正确性**，不是「我觉得对」。1815 项断言里，
   十点半双爆、飘三叶豹子加成、斗牛没牛罚分这些**最容易写错又最难发现**的地方都有独立用例，
   连「单组输赢之和必须为 0」这种守恒律都锁了。
2. **服务端是权威的，而且视角裁剪做对了**。同类项目最常见的塌方是「把房间状态放前端、
   服务端只做转发」——那种项目一进控制台就能看穿别人的牌。这里 `_view()` 天然裁手牌，
   座位还要令牌，`playerId` 从广播里拿到也没用。这是真正想清楚了才写得出的东西。
3. **零依赖还自己实现了 WebSocket**（握手、分片续帧、掩码解码、原地缓冲前移），
   且写了 19 项缓冲测试把 O(n²) 打成 O(n)。这不是「懒得装包」，是「不想让供应链成为变量」。

**② 「这是一个优秀的扑克类 PWA 产品吗？」——还差一口气，差的不是代码。**

差的这一口气在**产品闭环**，原本是很具体的三件事。**v50 已经做掉两件**：

1. ~~**前后台切换的死区（P4-1）**~~ **已修**。这条不算功能，但它决定口碑。
   一个「切出去回个微信回来就卡住一分钟」的游戏，玩家不会说「有个 bug」，
   只会说「这游戏有点卡」，然后下次不点了。
2. ~~**回放的离房留存（P3-7 剩项）**~~ **已修**。「刚才那把我是怎么输的」
   是扑克类游戏的核心复盘动作，原来退房就没了。
3. **观战（P3-6）—— 仍然没有，且用户明确说不做**。
   朋友局扑克的社交乐趣有一半在「看别人打」，现在 8 人满了旁边的人只能凑一个手机看。
   这是**最该做、也最容易做错**的一条：服务端真的只要放开「满了不许进」
   （`_view()` 本来就按视角裁手牌），但前端 **37 处** `state.myId` 得逐处补 null 分支，
   且覆盖房间页 / 对局页 / 结算页三块，做一半就是白屏。
   明确不做，比做一个半成品强。

**一句话结论（v50 更新）**：

> 它的**工程下限**已经在这个品类的前 10%，规则、安全、数据一致性上没有硬伤；
> 原本封住产品上限的两件事——「切回来就卡」和「打完就看不了」——已经解掉。
> 现在唯一还压着它的是**增长**：冷启动 100% 靠房主手动发链接，
> 没有大厅、没有匹配、没有安装引导（P4-7）。
> 补上观战（1~2 天）和安装引导（半天），它就完整了；
> 再往上（大厅 / 匹配 / 每日任务）是换一个产品方向，不是修缺陷。
> P4-2 ~ P4-7 那几条，是「已经优秀之后才值得抠」的细节。

---

## 7.4 如果只做一件事

**做 P4-1。** ✅ v50 已做。

理由不是它最容易，而是它是**唯一一条会让人误判整个产品**的问题：
其它所有缺陷玩家都能准确描述（「进不去」「看不到回放」「没人观战」），
只有这一条会变成一句模糊的「有点卡」——而模糊的差评最伤留存，也最难被你自己发现。
代价是 30 行（含探活与 bfcache 分支），换掉一个说不出原因的口碑损耗。

**如果只做第二件**：P4-7 安装引导。它是唯一一条能把「每次点链接进来」变成
「桌面上有个图标」的增长杠杆，而现在已经装了的人体验是完整的 ——
差的就是没人告诉他们可以装。

---

# 八、v51：战绩和排行榜为什么对不上（P5，6 条）

**起因**是用户报的两个现象，各配一张截图：

> 1. 在「我的战绩」里删了数据，排行榜还在
> 2. 早上新打了一把，排行榜更新了，战绩里却没有这条，反而是昨天的数据

第一句是判断，第二句是现象。查完之后的结论比「不同步」更彻底：

> **不是漏了同步，是这两页从来就没有同步通道。**

两张截图其实是**自洽的**：排行榜三个人各 1 场，`+39 / -18 / -21` 加起来正好 0，
这是同一局；战绩里那条「10-29 09:08 · 3 人 · -18」也对得上。
真正错位的是**这一页显示的不是当前这个号的数据**。

---

## P5-1 战绩与排行榜是两套互不相干的数据 ✅ 已修复（v51）

三条证据，都指向同一个地方：

| 证据 | 位置 |
|---|---|
| 全文 **0 处**网络调用，数据只存在 localStorage 一个 key `lxw_records_v1` | `pwa/js/records.js` |
| `clear()` 只做 `removeItem` + `removeItem(迁移标记)`，一个请求都不发 | `records.js` |
| 排行榜走的是另一条路：`_persistSettlement` → `profiles.record(roomId#handSeq)` → `profiles.json` | `server/hub.js` / `server/profile.js` |

两条路互不知道对方存在。所以「删了战绩、排行榜还在」不是 bug，是**设计结果**——
但界面上完全看不出来，因为那行小字只写了「本机记录，换设备或清缓存会丢失」，
没有一句说「排行榜不受影响」，也没有任何入口能清云端。

**修法**：战绩页改为读服务器档案（`GET /api/me/records`），与排行榜同一份。
本机记录退化为两件事：**离线兜底**，以及**回放仓库**（服务端不存逐轮明细，那是几 KB 一局的东西）。

## P5-2 本机战绩不带账号，换号后数据串台 ✅ 已修复（v51）

这是两张截图真正的成因。`records.js` 里 **0 处**出现 `playerId` / `account`，
记录不知道自己属于谁；`all()` 也没有任何过滤。

于是同一台手机上：先用 A 打了 `-18`，换 B 打赢了一局 `+39`。
排行榜（按账号）显示 `+39`，战绩页（按设备）显示 `-18`。
用户看到的就是「排行榜更新了，战绩里反而是昨天的数据」。

**修法**：
- 记录写入带 `playerId`（`recordSettled` 取 `state.myId`）；
- `all(pid)` / `stats(pid)` / `clear(pid)` 都支持按账号过滤；
- 老记录（没有 `playerId`）视为「无主」，**不归属任何账号**，只在未登录视图里出现。

顺带挖出一个更隐蔽的：`sameGame` / `nearDuplicate` 的判重**不含账号**。
同一台设备两个账号先后打过同一间房的同一场次时，后写的那条会被前一个人的记录
当成重复静默吞掉。加了账号隔离之后才暴露出来——以前的记录根本不带账号，无从比较。

## P5-3 幂等键只用 `roomId#handSeq`，房间号回收会误判重复 ⚠️ 已知限制，未修

房间号是 6 位、会被回收复用，而 `handSeq` 每间新房都从 1 开始。
同一个人先后进过两间**同号**房间、又都在第 1 场打完，第二场就会被 `_seen`
当成重复挡掉——本该进榜的一局凭空消失。

试过的修法是「把 `endedAt` 拼进键」，但那样会破坏 `persist.test.js [8]` 锁住的契约
（同一场重复结算时时间戳漂移也必须判重）。**幂等键存在的意义就是挡住重记**，
为了让边界情况更准而先把它松掉，是拿主要矛盾换次要矛盾。

暂不修，写在这里备案。真要修，正确方向是给房间加一个创建期 nonce
（`roomNonce#handSeq`），而不是往键里塞时间。

## P5-4 本机记录依赖「手机当场看到结算画面」 ✅ 已修复（v51，随 P5-1）

`recordSettled` 只从 `render()` 里调到，而 `render()` 开头有一句
`if (state.screen === 'records' || 'rank' || 'auth') return;`。更关键的是：
它依赖**客户端观测到 `phase === SETTLED` 那一帧**。

断线重连后如果别人已经开了下一把，你会直接落在分牌阶段——这一把的结算画面
从来没过你手机的眼睛。服务端记了（它按房间状态算），你没记。

这不是能靠补丁修掉的时序问题，是数据源问题。P5-1 修完之后，
战绩读的是服务端档案，这类分叉自然消失。

## P5-5 全负玩家的「单场最高」显示成 0 ✅ 已修复（v51）

```js
if (n > p.bestNet) p.bestNet = n;   // bestNet 从 0 起算 → 全负时永远不更新
```

一个每局都输的人，「单场最高」应该是那个**负数**（-18 也是他真实的最好成绩），
显示 0 会让人以为某一局打平了。改成第一场直接做初值。

本机版的 `stats()` 早就用 `i === 0 ||` 兜过这一手，服务端没兜——两边口径不一致
在 P5-1 之后会直接暴露成「换数据源后数字变了」。

顺带补了 `longestLoseStreak`（服务端一直只有连胜）。存量档案没有这个字段，
靠 `_ensureDerived()` 用当前连败数补一个下限：一个正处在 3 连负的人显示
「最长连败 0」，比不显示更糟。

## P5-6 清除战绩只清本机，云端纹丝不动 ✅ 已修复（v51）

弹窗加了一个默认**勾上**的选项「同时清除云端战绩（排行榜会一起归零）」，
未登录 / local 演示模式时置灰。

为什么默认勾上：用户点「清除记录」时脑子里想的是「把我这个号的数据清掉」。
默认不勾，等于把「删不干净」做成了默认行为——那正是这次的 bug。

顺序上先清云端、成功了才动本机。反过来的话，一旦云端那步失败，
用户会既丢了本机回放、又在排行榜上看见战绩，比原状更糟。

---

## 8.1 这一轮改了什么

| 项 | 改动 | 验证 |
|---|---|---|
| P5-1 | `server/index.js` 新增 `GET /api/me/records`（令牌鉴权，返回 `getSelf()` + `serverTime`）；`pwa/js/game.js` 的 `renderRecords()` 改成云端优先，`cloudStats()` / `cloudRows()` 负责口径映射，`loadCloudRecords()` 负责拉取与降级 | `server/test/me-records.test.js`（41 项）+ `scripts/probe-records-cloud.js`（36 项） |
| P5-1 | 页脚那行字跟着数据源变：「云端战绩 · 与排行榜同一份数据」/「本机记录，换设备或清缓存会丢失」/「云端读取失败，暂用本机记录」 | 探针断言页脚文案 |
| P5-1 | 场次多于流水时把口径写明：「共 25 局 · 列表近 20 局」。服务端 `recent` 上限 20，只写「共 25 局」会让人数不清列表里的行 | 探针断言文案 |
| P5-2 | `records.js`：`normalize()` 落 `playerId`（空值不写字段）、`ownedBy()` 过滤、`all/stats/clear` 全支持传 `playerId`；`sameGame`/`nearDuplicate` 加账号比较 | `pwa/test/records-scope.test.js`（28 项） |
| P5-2 | 老记录「无主」的处理：登录状态只看本账号的，未登录才给全部——否则老数据在界面上彻底消失 | 同上 |
| P5-4 | 无需单独改动（随 P5-1 消失），但把成因写进 `records.js` 与 README，避免以后有人「修回去」 | — |
| P5-5 | `profile.js`：`bestNet` 第一场做初值；新增 `longestLoseStreak` 与 `_ensureDerived()` 存量迁移；`recent` 条目带 `playerCount` / `endReason` | `me-records.test.js` 断言「全负时 bestNet = -1」「最长连败 25」「流水带人数与结束原因」 |
| P5-5 | `_public(p, withRecent, recentLimit)`：自己看自己给 20 条，看别人仍 5 条（不把别人整份流水抄出去） | 同文件「隐私」段 |
| P5-6 | `POST /api/me/reset-stats` + `profiles.resetStatsOf(pid)`（字段表从 `_blank()` 拿，加新字段不会漏）；弹窗加勾选项，先清云端成功再清本机 | `me-records.test.js`「只清自己不动别人」+ 探针「确定→真的打 reset-stats」 |
| — | `records.css` 新增 `.rp-opt`（自绘勾选框，按 750 设计空间写）；`.rp-opt-text` 降到 22px 并允许折行——24px 时在 390 宽屏上会贴着右边框 | 探针断言「文字右缘留在框内」 |

**测试**：58 个文件 / **1935 项** / 0 FAIL（v50 是 56 / 1866）。
新增 `pwa/test/records-scope.test.js`（28）、`server/test/me-records.test.js`（41）。
新增探针 `scripts/probe-records-cloud.js`（36 项，假服务端 + 真浏览器）——服务端口径由单测锁，
前端接线由探针锁，分开验更好定位。

**这个探针第一版是「偶发全红」的，值得记一笔怎么修的**：
连续跑 5 次会有 1~2 次出现 20 项失败，看输出像是「战绩数据全变 0」，很像代码回归。
实际是两个环境问题叠在一起：

1. **固定 `sleep` 赌浏览器启动速度**。机器一忙，`sleep(1800)` 可能落在首屏 `init`
   的 `showScreen('screen-home')` 与 `bindEvents()` 之间——那一下点击没有 handler，
   等于空点，人还留在首页。改成显式 `waitFor` + 「确认战绩页真的打开了」的校验与重试。
2. **端口 / CDP 被上一个残留实例占着**。那时连的是别人的服务，nonce 都可能是对的，
   但读到的是旧页面。加了两个身份校验：服务端 `/__probe-nonce` 证明「连的是我的服务」，
   `Page.addScriptToEvaluateOnNewDocument` 写入 `window.__probeNonce` 证明「这个文档是新建的」。

结论：**探针偶发全红时先怀疑环境，别急着改被测代码**。但也不要靠「多跑几次总能过」蒙过去——
把它改成能自己证明「我测的是对的东西」，否则这个探针以后说的话没人敢信。

## 8.2 这一轮最值得记的一件事

**「数据不一致」从来不是同步问题，是权威源问题。**

修之前我差点去写一个「两边对账」的功能：定时拉排行榜、和本机记录比对、发现差异就补。
那条路是错的——它会把一个**架构问题**做成一个**永远修不完的功能**，
而且每加一个指标就要多一套对账规则。

正确的问法是：**这两份数据里，哪一份是权威的？**
答案显然是服务端（它有账号、跨设备、且排行榜本来就在用它）。
那就不要对账，把另一份降级成缓存。

降级之后，原先看起来互不相干的四个 bug 一起消失了：
删不干净（P5-6）、换号串台（P5-2）、断线丢局（P5-4）、字段口径不一致（P5-5）。
它们不是四个 bug，是**同一个错误的四个症状**。

---

## 8.3 发布与五项核对（2026-10-29 11:2x）

**已上线**，链接不变：`https://liuxuanwu.app.workbuddy.host/`

| 核对项 | 结果 |
|---|---|
| `/api/health` | `uptime 13`（进程确实刚重启）/ `version 20261029g` / `pwa 20261029g` / `server 2026-10-29T03:06:06Z` |
| 前端逐字节 | 9 个文件 md5 全一致（index.html、sw.js、两个 css、五个 js） |
| 老客户端能升级 | 线上 `sw.js` 是 `weile-liuxuanwu-v51` |
| 牌桌布局 | 本地三档全绿；线上 320 / 390 / 430 均 `overflow 0` + 三组 `visibleRatio 1` |
| gzip | `Content-Encoding: gzip`、`Vary: Accept-Encoding`、`Content-Length 11810`，解压 39910 = 原文 39910（只压一次） |

发布前 `npm run backup` 拿到线上 3 位玩家（`+39 / -18 / -21`，与用户两张截图完全一致），
全量回归 58 文件 / 1935 项 / 0 FAIL 之后才部署。

**顺带清了线上 8 个「探针」空档案。** 它们是探针在 `[1]→[2]` 之间被打断时留下的——
脚本的清理段 `[4]` 在最后，中途报错就走不到。8 个都是 `games=0`，不进排行榜，
但会跟着 `?full=1` 一起被备份进种子文件。处理方式是拿 `account.name` 逐个登录再删号
（`/api/auth/delete` 只认令牌 + 密码，管理端没有按 id 删的接口）。清完线上回到 3 个档案。

## 8.4 probe-table 这次被修了四处，每一处都是「假失败」

这个探针的用途是发布后复验牌桌布局。这一轮它连续报「牌桌塌了」，查下来**四次都是探针自己错了**，
产品一次都没坏。四处的共同点是：**它失败时给出的结论，和产品真坏时的结论长得一模一样。**

| 症状 | 真实原因 | 修法 |
|---|---|---|
| `groups: []` | 新账号第一次打开弹新手引导，盖住整个牌桌 | 导航后先写 `lxw_guide_seen_v1` 再刷新；量之前兜底关一次引导 |
| `groups: []` | SW 接管 + 版本自检触发的 reload 把页面冲回首页 | 轮询 `performance.now()` 等到文档活过 4 秒（reload 后它归零），再开始操作 |
| 重试三次全失败 | 重进判据写成 `state.room`，而建房前它天然是 `null` | 判据改成「`#screen-game` 可见且 `#slots` 存在」 |
| 停在登录屏，红字「连接未登录，已断开」 | **探针自己把注册配额打满了**（服务端 `REG_MAX` 12 次 / 10 分钟） | 注册失败时改用固定账号登录兜底，并把 429 原文打出来 |

第四条最值得记：`REG_MAX` 是我自己在 `security` 那一章写进去的防护，
结果它先把自己的复验工具拦住了。**写防护的人最容易忘记防护也会拦自己。**

结论写成一条规矩：**探针报红时，先证明它测的是对的东西，再怀疑被测代码。**
具体做法是让探针自带身份校验（服务端 nonce / 文档级 nonce / 文档存活时长），
以及把「为什么失败」的诊断信息打出来 —— 这一轮的 430 就是靠 `hasStage / hasAuth / bodyChildren`
三个字段才定位到「页面完整，只是停在登录屏」，否则会一直往布局上找。

## 8.5 评分不变

这次发布没有改变代码质量结论，**仍为 8.6 / 10**（P5 六条已在 8.1 计入）。
唯一变化是「战绩与排行榜同源」正式上线，`产品完成度 8` 这一项的描述里
「战绩页」后面应该补一句「与排行榜同一份数据」。

---

## 8.6 v52：登录后 30 秒被踢回登录页（P6，1 条，已修并发布）

**这一条是发布复验逼出来的，不是用户报的。** 修完 v51 之后我去线上跑牌桌探针，
它反复停在登录屏：注册明明成功、房间建好、局也开了，十几秒后屏幕一闪回到登录页。
诊断输出把疑点排干净了 —— `docAge 52 秒`（没有 reload）、`navType navigate`、
`verReloaded null`、`screenStates: ["screen-auth:SHOW", ...]`，也就是**页面好端端地自己退回了登录屏**。

### 根因：两条各自合理的规则撞在一起

| 侧 | 规则 | 单独看是否合理 |
|---|---|---|
| 服务端 | 连上来 30 秒还不 `auth` 的连接一律关掉（`AUTH_TIMEOUT_MS`），挡空连接占 fd | 合理 |
| 客户端 | `ensureConnected()` 看到 `readyState === 1` 就直接复用，不再补发 `auth` | 合理 |

但页面**一打开就连 WS**，那时还没登录、拿不到令牌 —— 这条连接注定是未鉴权的。
用户登录成功后复用的正是它，于是第 30 秒到点被踢，提示「连接未登录，已断开」，
客户端置 `disconnected = true` 并把界面退回登录屏。

**受害窗口**：从「打开页面」到「登录成功」之间只要建立过连接，30 秒后必被踢。
手机上新访客从打开到注册完通常正好 20～40 秒 —— 也就是说**新用户第一次打开就最容易踩到**。
这类 bug 最难受的地方是：看起来像「登录失败」，实际登录早就成功了。

### 修法

- `roomStore` 新增 `reauth()`：关掉旧的未鉴权连接，换一条带令牌的（`onopen` 里本来就会发 auth）；
- `submitAuth()` 登录/注册成功后先 `await RoomStore.reauth()` 再 `enterApp()`；
- `reauth()` **先摘掉 `socket` 再 close**。反过来的话，close 若同步派发（测试替身就是同步的），
  监听器会把 `socket` 置空、再 `scheduleReconnect()`，于是同时存在两条连接抢同一个身份。

### 顺带修掉的第二个隐患

`ensureConnected` 里那条 `close` 监听器原来无条件 `socket = null`。
一旦「新连接替换旧连接」，旧连接的 close 是**晚一步**才到的，它会把刚建好的新连接置空 ——
新连接变成没人管的孤儿，界面表现为「一连上就掉线」。
现在加了一句 `if (socket !== s) return;`，只处理当前这条连接的关闭。

### 验证

- `pwa/test/room-reauth.test.js`（18 项）：没登录时空转 / 登录后关旧连新 / 新连接 open 即带令牌 /
  旧 close 不污染新连接 / 被踢后能复位 / 退出登录后不再建连
- 全量 **59 文件 / 1953 项 / 0 FAIL**（v51 是 58 / 1935）
- 线上三档（320×568 / 390×844 / 430×932）**一次全绿**，都走到了 `[4] 清理探针账号` ——
  修之前总有 1～2 档卡在登录屏，这个对比本身就是证据

发布为 **v52**（`sw v52` / `20261029h`）：`uptime 12`、`version = pwa = 20261029h`、
4 个关键文件 md5 与本地一致、gzip 正常、线上档案回到 3 位真实玩家。

### 这一条最值得记的地方

**「探针跑不通」和「产品有 bug」这次是同一件事。**
前面 8.4 记的四次都是探针自己错；这一次不是 —— 探针反复失败，最后暴露的是一条真实用户会踩的路径。
分不清这两者的时候，唯一的办法是**把失败原因量出来**（`docAge` / `navType` / 哪个 screen 是 SHOW），
而不是靠「再跑一次看看」。前者指向根因，后者只会让人对工具失去信任。

---

# 九、v52 之后：再问一次「它够不够优秀」（2026-10-29 12:1x）

**这一章不复读第七章。** 上一轮评分（8.7）是在 v51 刚落地时给的，
中间又发了 v52、修掉一条真实用户会踩的 30 秒踢线问题。所以这次先把**能量的东西量一遍**，
再判断分数该不该动、动在哪。

## 9.1 先量，再评

| 指标 | 数值 | 怎么量的 |
|---|---|---|
| 测试规模 | **59 文件 / 1953 项 / 0 FAIL / 56.9s** | `npm test`（v51 是 58 / 1935） |
| 首屏传输量 | **148,389 B（gzip）** | `cat index.html js/*.js css/*.css \| gzip -c \| wc -c` |
| 其中 `game.js` | 56,513 B gzip，**占总量的 38%** | 单文件 gzip |
| 弹窗数量 | **12 个** | `grep -o 'id="[a-z-]*modal"'` |
| 其中带 `role="dialog"` | **0 个** | `grep -c 'role="dialog"'` |
| 其中带 `aria-modal` | **0 个** | 同上 |
| 静态资源缓存头 | `public, max-age=3600`，**无 ETag、无 Last-Modified** | `server/index.js:420` |
| `prefers-reduced-motion` | **有**，且用的是 `*, *::before, *::after` 全局覆盖 | `style.css:1952` |
| `/api/me/records` 的 `serverTime` | 服务端返回，**前端引用 0 处** | `grep -rn serverTime pwa/js/` |

顺带确认一件好事：`prefers-reduced-motion` 用的是通配选择器，
所以 `records.css` 里的动效**也一并被覆盖了**，不存在"只降级了一半"的问题。

前四条是这轮新量的，后两条在 9.2 会说。

## 9.2 三条新发现（P7）

### P7-1 12 个弹窗没有 `dialog` 语义，也没有焦点管理 ⚠️ 未修

`replay / share / records-clear / result / guide / rules / profile / dissolve / confirm / rename / account / pwd`
—— 12 个弹窗，`role="dialog"` 0 个、`aria-modal` 0 个、`inert` 0 处、焦点陷阱 0 处。

现在做到了的：`Esc` 逐个关闭（`game.js:3699`）、移动端返回键走 `popstate` 全关、
`focus-visible` 金色焦点环（`style.css:1963`）。**键盘操作是通的，缺的是语义和焦点秩序：**

- 读屏用户打开「改密码」弹窗后，不会被告诉"有个对话框出现了"；
- `Tab` 会从弹窗里走出去，一路走到底层页面的按钮；
- 关闭后焦点落到 `<body>`，不是在原来那个按钮上。

**要不要修，值得先想清楚。** 这个游戏的核心是看牌，全站读屏不现实，也没意义。
但**账号、密码、改昵称、确认框**这四个是标准表单 —— 老年用户、键盘用户、开关控制用户
在这四处会遇到真实障碍，而修法一共 30 行左右（一个 `openModal(id)` 里做三件事：
`role/aria-modal`、把焦点移进弹窗、关闭时还回去）。**这是投入产出比最高的一条无障碍项，
也是唯一值得做的一条。**

### P7-2 没有 ETag + SW 走 network-first = 闲置一小时后每次打开都要重下 148KB ⚠️ 未修

P4-3 记过「没有 ETag」，但当时没把 SW 这一层算进来，所以低估了后果。完整的链路是：

1. `sw.js` 对 `/js/*` `/css/*` 走 **network-first**（这是刻意的：改完即生效）；
2. `fetch(req)` 会先查 HTTP 缓存，`max-age=3600` 内直接命中 → 没事；
3. **超过一小时**，缓存过期 → 发条件请求 → 服务端**没有 ETag 也没有 Last-Modified**
   → 只能回 `200` 全量，**无法回 `304`**；
4. 于是每天第一次打开、或每次隔了一小时以上再打开，`index.html` 之外那 148KB 全部重下。

对饭桌上扫码进来的场景，一次多 0.2~1.5 秒。不算严重，但**这是纯白给的钱**：
服务端加 `ETag`（内容 md5，文件不大、可缓存在内存）就变成 `304` 空响应，改动约 10 行，
且和 `?v=` 版本化不冲突（`?v=` 变了 URL 就变了，本来也不会命中）。

> 顺带一个观察：`game.js` 一个文件占首屏 38%（56KB gzip / 171KB 源码 / 3844 行）。
> 它是全项目唯一一个"该拆而没拆"的文件 —— 但拆它属于重构，风险大于收益，**不建议为了好看去拆**。

### P7-3 `/api/me/records` 的 `serverTime` 是个死字段 ⚠️ 未修

`server/index.js:828` 的注释写得很明确：

```js
/* serverTime 给客户端核时钟用：本机时间不对时，「10-29 09:08」这类显示整体错位，
 * 看起来就像「数据还在昨天」。 */
return sendJson(res, 200, { ok: true, profile: prof, serverTime: Date.now() });
```

`me-records.test.js:117` 也断言了「回包带 serverTime（前端可核时钟偏差）」。

**但前端一处都没读它**（`grep -rn serverTime pwa/js/` → 0 结果）。
`fmtTime()` 用的是 `new Date(ts).getHours()` —— 直接按设备时区格式化。

这条的严重度很低（**它其实也修不了它自己声称要修的问题**：`ts` 本来就是服务端 epoch，
设备时钟错了也不影响 `new Date(epoch)` 的显示，只有时区错才影响，而 `serverTime` 同样是 epoch，
拿它做不了时区校正）。所以正确的收尾不是"把 `serverTime` 用起来"，而是
**把注释和那句测试注解改掉，或者干脆删掉这个字段** ——
留着一条"说了要做、实际没做"的注释，比没有注释更误导下一个读代码的人。

这类"自我不一致"在本项目里已经被抓过四次（P2-15 health 版本号、P1-9 双爆注释、
P1-10 服务端不调 `setConfig`、D-1 README 与代码不符）。
它不致命，但它是**文档可信度**的问题 —— 而这套 REVIEW 全部价值都建立在"这里写的能和代码对上"。

## 9.3 重估 P5-3：概率算完，它不该再占一个「未修」的位置

P5-3 记的是「幂等键 `roomId#handSeq`，房间号回收会误判重复」。这轮把概率算了一下：

- 房间号是 `100000~999999` 随机（`hub.js:977`），共 **900,000** 个；
- `_seen` 只保留最近 **40** 个键（`profile.js:320`）；
- 新房间号撞上这 40 个之一：**40 / 900,000 ≈ 4.4 × 10⁻⁵**；
- 还要 `handSeq` 也撞上 —— 对"一间房只打一局"的常见用法，这个条件近乎必然。

所以单局触发概率约 **1 / 22500**。一个 10 人朋友局一年打 5000 局，**期望发生 0.2 次**。

结论：**这条可以正式降级为「已知、量化后不予处理」**，不必再占着"未修"的位置。
保留它的唯一理由是它的失败是**静默的**（一局从榜单上凭空消失，没有任何报错），
所以文档里要留着，让将来真出现"少了一局"时能第一时间想到这个方向。

## 9.4 1953 项断言没挡住的那条 bug，比 bug 本身更值得记

P6（新用户首次打开、30 秒后必被踢回登录页）是在 **1953 项断言全绿**的状态下存在的。
这不是"测试写得不好"，是**测试的形状**问题：

- 现有 59 个文件的断言几乎都是**模块级**的：engine 的规则、profile 的落档、
  hub 的广播裁剪、SW 的缓存策略、DOM 的渲染结果；
- P6 是一个**顺序问题**：打开页面（建连，此时无令牌）→ 登录成功（复用那条连接）→ 30 秒。
  任何一个模块单独看都是对的，错的是它们的**先后关系**；
- 能测出它的只有"沿着用户路径走一遍"的东西 —— 最后是**探针**（真浏览器 + CDP）抓到的，
  而不是单元测试；`room-reauth.test.js` 是**发现问题之后**才补的。

所以这一轮最该改的不是"再加断言"，而是补 **2~3 条旅途测试**：

1. 打开 → 注册 → 建房 → 补 AI → 打完一局 → 看战绩 → 看排行（这条路径覆盖了 P5 和 P6 的全部现场）；
2. 对局中断网 10 秒 → 恢复 → 座位还在、牌还在、能继续出；
3. 清缓存重开 → 离线打开 → 看到壳而不是白屏。

这三条都不需要新工具 —— `scripts/probe-*.js` 已经有全套能力（`Page.addScriptToEvaluateOnNewDocument`、
非注入判据、`waitFor`）。**缺的不是能力，是把它们从"发布前手动跑"变成"也有一个入口能一条命令跑完"。**

## 9.5 分维度评分（v52 复评）

| 维度 | v51 | v52 | 变化理由 |
|---|---|---|---|
| 规则正确性 | 9.5 | **9.5** | 未动，1953 项仍全绿 |
| 服务端严谨度 | 9 | **9** | 未动；无多实例能力（P4-6）仍在 |
| 安全 | 8 | **8** | 仍只有 `nosniff`，无 CSP / XFO（P4-4） |
| 性能 | 8.5 | **8.5** | 首屏 148KB gzip 合格；ETag 缺失的代价这轮才量清（P7-2），但绝对值不大 |
| PWA 完整度 | 8 | **8** | maskable 复用同一张图（P4-2）、无安装引导（P4-7）仍在 |
| 移动端手感 | 8.5 | **8.5** | 未动 |
| 产品完成度 | 8.5 | **8.5** | v52 修掉"新用户必被踢"，是恢复而非新增；观战仍缺（P3-6，用户明确不做） |
| 增长 / 留存 | 5.5 | **5.5** | 未动。**这是唯一的地板** |
| 工程质量 | 9.5 | **9.3** | 扣的一点在 9.4：断言密度极高，但**用户旅程无覆盖**，靠探针兜 |
| 文档 / 可运维性 | 9 | **8.8** | 扣的一点在 P7-3：又出了一条"注释说了、代码没做" |
| *（新）无障碍* | *未测* | **4** | 首次测量。12 弹窗 0 语义、无焦点管理（P7-1）；键盘和 Esc 是通的，所以不是 0 |

**加权结论：仍为 8.7 / 10，一分不涨。**

为什么不动：v52 修的是**一条长期存在的老 bug**（`AUTH_TIMEOUT` 一直都在，只是刚被发现），
它把"新用户第一次打开就可能被踢"这个坑填了 —— 该加分；
但同一轮新增的三条（P7-1/2/3）全是小项，且工程与文档各扣了 0.2 —— 该减分。
**一加一减基本抵消，而真正压着总分的那一项（增长 5.5）一整轮没有动过。**

> 有一句话必须说清楚：**8.7 已经不是一个"还能靠修 bug 往上走"的分数了。**
> 剩下的 1.3 分里，约 1.0 分压在产品方向（大厅 / 匹配 / 安装引导 / 跨局钩子），
> 约 0.3 分压在"已经优秀之后才值得抠"的细节（CSP、ETag、maskable、无障碍语义）。

## 9.6 所以，它「足够优秀」吗

**① 作为一个扑克类 PWA 工程 —— 是，而且不用加限定词。**

三条硬证据：

1. **规则有可验证的正确性。** 十点半双爆、飘三叶豹子加成、斗牛没牛罚 5 分，
   这些最容易写错的地方各有独立用例，连「单组 deltas 之和为 0」的守恒律都锁了。
2. **服务端是权威的，视角裁剪是对的。** 同类项目最常见的塌方是"状态放前端、服务端只转发"，
   那种项目一进控制台就能看穿别人的牌。这里 `_view()` 天然裁手牌、座位还要令牌、
   `playerId` 从广播里拿到也没用。
3. **零依赖，自己实现了 WebSocket**（握手、分片续帧、掩码解码、原地缓冲前移），
   并且写了 19 项缓冲测试把 O(n²) 打成 O(n)。

**② 作为一个扑克类 PWA 产品 —— 还差一口气，但这一口气不在代码里。**

单局体验已经闭环且完整：进房 → 没人也能「补 AI 队友」自己打 → 四种玩法 → 结算 →
回放（退房后仍可看）→ 战绩（云端，与排行同源）→ 排行。这条链上没有断点，
连"一个人也能玩"都兜住了 —— 这比我上一轮估的要好。

**缺的是"为什么还要再打开一次"：**

| 缺的东西 | 影响 | 成本 |
|---|---|---|
| 安装引导（P4-7） | 每次都要从群里点链接进来，装过的人体验是完整的，只是没人告诉他可以装 | 半天 |
| 大厅 / 匹配 | 冷启动 100% 靠房主手动发链接 | 换一个产品方向，不是修缺陷 |
| 跨局钩子（每日/连胜/房间常驻） | 打完一局，没有任何东西把人留在下一局 | 1~2 天 |
| 观战（P3-6） | 8 人满了，旁边的人只能凑一个手机看 | 1~2 天，**你已明确不做** |

**一句话结论**：

> 它的**工程下限**已经在这个品类的前 10% —— 规则、安全、数据一致性、可运维性都没有硬伤，
> 而且这些结论每条都能用命令复验，不是自评。
> 它现在的短板是**产品闭环**，不是质量：单局做得比大多数同类都完整（能单人 + AI 打完一整局），
> 但没有"第二次打开的理由"，冷启动完全依赖人拉人。
> **再往上走要做的不是修 bug，是决定要不要变成一个"有大厅的产品"。**
> 在那之前，P4-4 / P7-1 / P7-2 / P7-3 这几条属于"已经优秀之后才值得抠"的细节。

## 9.7 如果只做一件事

**做 9.4 的旅途测试。** 不是 P7-1，也不是安装引导。

理由：这个项目现在的可靠性是**靠探针兜住的**，而探针是"发布前手动跑、跑的时候要靠人盯着"的。
1953 项断言给了一种"我很稳"的错觉，但 P6 证明了它测不到**顺序**。
旅途测试是唯一能把"下次还会不会有 P6"这件事从运气变成流程的东西 ——
而且不需要任何新能力，手上的探针脚本已经能干这件事。

**如果只做第二件**：P7-1 的四个表单弹窗语义（30 行）。
它是这一轮唯一一条"修了以后有一类真实用户从不能用变成能用"的项。

**如果只做第三件**：P4-7 安装引导（半天）。
它是唯一能把"每次点链接"变成"桌面上有个图标"的增长杠杆 —— 而装过的人体验本来就是完整的，
差的只是没人告诉他们可以装。

---

# 十、v53：把「旅途」变成测试，顺手挖出三条新问题（P8）

第九章给的建议是「如果只做一件事，做旅途测试」。这一轮就做了这件事，外加 P7-1（弹窗无障碍）。
**结果三条新发现里有两条不是代码问题，是「测试和文档说了假话」** —— 这正是第九章 9.4 担心的事。

## 10.1 做了什么

| 项 | 改动 | 验证（我自己跑的，不是听汇报） |
|---|---|---|
| **旅途测试** | 新增 `scripts/journey.js`（761 行）+ `package.json` 的 `journey`；真浏览器（Edge + CDP）跑完 注册 → 建房 → 补 AI → 两轮分牌 → 结算 → 战绩 → 排行 | `npm run journey` 55 项 / 0 FAIL / 12.5s；连跑多次全通 |
| **P6 回归** | `--with-wait`：登录后停 35 秒再断言 | 57 项 / 0 FAIL / 49.2s |
| **连接不变量** | journey 里包 `WebSocket.prototype.send`，按连接归属记帧 | ★ 每条连接 open 后 2 秒内必须发过 `type:"auth"` —— 换任何入口都成立 |
| **P7-1 弹窗无障碍** | 12 个 `.modal` 补 `role="dialog"` / `aria-modal` / `aria-labelledby`；收敛出 `showModalEl` / `hideModalEl`；Tab 圈定；默认焦点给「取消」 | 各 12 处；`modal-a11y.test.js` 103 项；journey `[9b]` 在真浏览器里验 Tab 回卷与焦点归还 |
| 全量 | — | **60 文件 / 2056 项 / 0 FAIL / 56.8s**（v52 是 59 / 1953）|

> 关于「默认焦点给取消」：通用确认框同时挂着**删号**和**清空战绩**。
> 焦点落在「确定」上，一个回车就能删掉全部数据。这条比语义标签本身值钱。

## 10.2 P8-1　`ui.test.js:564` 那条断言，从来没验过它声称要验的东西 ✅ 已修复

原文：

```js
ok(/closeGuide\(\);\s*\n\s*\$\('#rules-modal'\)/.test(gameJs), '返回键也能关（popstate 里）');
```

注释说它验的是「按返回键能关掉弹窗」。**实际匹配到的是「引导最后一屏跳到完整规则」那一处**——
因为 popstate 处理里根本没有 `$('#rules-modal')` 这个写法。

更要命的是它的**副作用**：为了让这条正则继续匹配，`game.js` 里被插了一行

```js
$('#rules-modal').classList.add('hidden');   // 纯 no-op，只为了喂正则
```

**测试在指挥产品代码，方向反了。** 这跟 P2-15（注释说读 `APP_VERSION`，其实恒为 `dev`）、
P7-3（注释说核时钟，前端 0 处引用）是同一族：**注释和测试跑在代码前面。**

修法：断言改成真验 popstate 里调了哪些关闭函数
（`/closeGuide\(\);[\s\S]{0,120}hideModalEl\('rules-modal'\)/`），并删掉那行 no-op。

**"改完跑绿了"不算验过**，所以还做了两件自证：
- 用脚本定位正则命中偏移：落在 `popstate` 处理函数的字符区间内（142809 ∈ 142467..142885），
  而不是又巧合匹配到别处；
- 用「如果只跑到前 3 条，计数会是 98」反推后面 5 条断言确实被执行（最终 103 ≠ 98）。

> 这一条最值得记的：**一条绿着的假测试，比没有测试更糟。**
> 它不但不提供保护，还会逼着产品代码为它让路，并且让下一个人以为这块有人守。

## 10.3 P8-2　第八章 P6 的根因描述是错的 ⚠️ 已更正（不改逻辑）

8.6 写的是：

> 页面**一打开就连 WS**，那时还没登录、拿不到令牌 —— 这条连接注定是未鉴权的。
> 用户登录成功后复用的正是它，于是第 30 秒到点被踢。

**这句话在当前代码里不成立。** 全仓 `ensureConnected()` 只有四个调用点，逐个核过：

| 调用点 | 前置条件 |
|---|---|
| `init()` | `AuthStore.session()` 为假时**直接 `showScreen('screen-auth'); return;`**，根本不建连 |
| `tryResumeRoom()`（`game.js:3823`） | 在 `AuthStore.refresh()` 之后，且**以有 session 为前提** |
| `handleInvite()`（`game.js:3819` / `1958`） | 同上；另一处调用在 `submitAuth` 内，也在登录之后 |
| 各按钮回调（建房/进房/回座） | 都在首页之后，必然已有 session |

首次打开的访客**不会建立任何连接**——旅途测试用 `addScriptToEvaluateOnNewDocument` 包了
`WebSocket` 并在整段流程里记录，全程只有 **1 条**连接，且建立于点击「注册」之后。

**真正成立的机理是另一条**：`ensureConnected` 的 `onopen` 里是 `if (tk)` 才发 `auth` ——
**任何在令牌为空时建立的连接都会变成未鉴权连接，30 秒后被服务端踢。**
所以 `reauth()` 这道防御是对的、也是必要的，但 8.6 里那个「打开页面→登录」的时序是**编出来的**。

处理：`roomStore.js` 和 `game.js` 里两处误述注释已经改写，并明确写上
「此前到底是哪个入口先建了连接，一直没有被完全证实，别按某条路径去推理」。
**逻辑一行没动**，因为它本来就没写错——错的是对它为什么存在的解释。

顺带把这条补成了**机制断言**（比注释有用得多）：journey 现在断言
「每条连接 open 后 2 秒内必须发出过 `type:"auth"`」。它不看路径、只看机制，
将来谁写出一条「令牌为空时建的连接」，当场就红，不用等 30 秒、不用等用户报。

## 10.4 P8-3　嵌套弹窗关闭时，焦点落在刚被隐藏的元素上 ✅ 已修复

`hideModalEl` 最初是：

```js
if (topModalId()) return;   // 上面还开着 → 什么都不做
```

后果：账号卡上叠着「修改密码」，关掉改密码后焦点留在刚被隐藏的按钮上，
`document.activeElement` 变成 `<body>`；用户的下一按 Tab 会突然跳到账号卡左上角。

改成：还有层开着时，把焦点移进**剩下那层**（同样 `[data-autofocus]` 优先）。
嵌套路径**不清空归还栈**——外层自己的归还目标还要留着，等它关掉时用；这一条也写成了断言。

### 这条是「改坏反证」验出来的，值得单独记

真浏览器里跑「账号卡 → 修改密码 → 关掉改密码」时，基线是绿的。但**绿可能是断言根本不区分对错**，
所以把 `hideModalEl` 临时改回旧写法 `if (topModalId()) return;` 又跑了一遍：

```
FAIL  ★ 关掉改密码 → 焦点交给还开着的账号卡（不是 body，也不是刚被隐藏的「取消」）
      -> {"inAccount":false,"focusId":"","tag":"BODY","accShown":true,"pwdShown":false}
通过 54 项，失败 1 项
```

**正是失败 1 项**：前后两条断言（打开账号卡、打开改密码）照样绿，只有这一条红 ——
说明它精确指向那 5 行 `below` 分支，没有蹭别的判断。改回后校验哈希逐字节一致。

顺带纠正了我自己的一个预判：旧写法下浏览器把焦点甩到 **`BODY`**（元素变成 `display:none` 后焦点被交还 body），
不是我原先写的「停在隐藏按钮上」。**注释按实测改了措辞** —— 这正是"想当然"和"量出来"的差别。

> 这条是整轮里我最想留下的方法：**一条绿的新测试，至少要做一次"把它改坏看它红不红"。**
> 不做这一步，你只知道它现在绿，不知道它到底守没守东西。

## 10.5 「测试能不能证明事情真的发生了」

这一轮反复出现同一个判断标准，值得单独记：

| 问题 | 只有静态断言会漏掉什么 | 这一轮怎么补 |
|---|---|---|
| Tab 真的被拦住了吗 | 代码里有 `preventDefault()` ≠ 焦点真的没跑 | journey 在真 Edge 里按 Tab，读 `document.activeElement` |
| 关闭后焦点真的回去了吗 | 调了 `focusEl()` ≠ 焦点没被后续渲染冲掉 | 同上，读真实 `activeElement` |
| 连接真的带鉴权吗 | 代码里有 `if (tk)` ≠ 每条连接都发了 | 包 `send` 逐连接记帧 |
| 这条新断言真的守东西吗 | 绿 ≠ 它能区分对错 | **改坏反证**：把被测代码临时改回错的，看是不是"只红那一条"（10.4）|

结论：**静态断言守「代码长这样」，探针守「行为真的这样」。两样都要，但别拿前者冒充后者。**
再加一条：**新写的断言还要做一次反证，否则你只知道它绿，不知道它守没守。**

## 10.6 数字与评分

- 断言：1953 → **2056**（+103：`modal-a11y` 95 起步 + 8 条嵌套分支）；文件 59 → **60**
- 旅途：0 → **55 项**（`--with-wait` 57 项）
- 首屏体积：**未变**（这一轮没动 CSS、没加图片；三个隐藏标题用内联样式，1px 不占位）

| 维度 | v52 | v53 | 理由 |
|---|---|---|---|
| 工程质量 | 9.3 | **9.5** | 9.4 那条扣分被补上了：现在有一条真浏览器跑的用户路径，且它验的是行为不是结构 |
| 文档 / 可运维性 | 8.8 | **8.9** | P6 根因更正、README 补旅途测试与退出码约定；但「注释跑在代码前面」这轮又出了一次 |
| 无障碍 | 4 | **6** | 12 弹窗语义 + 焦点进出 + Tab 圈定 + 默认焦点防误删；仍无读屏实测（NVDA / VoiceOver 没听） |
| 其余九项 | — | 不变 | 这一轮没有动业务、规则、安全、增长 |

**加权：8.7 → 8.8。**

涨得不多，因为这一轮补的是**地基里的钢筋**，不是玩家能看见的东西。
但它改变了一件事：**以后再出现 P6 那类「顺序 bug」，有东西会先红。**
第九章 9.7 说这比多修十个 bug 值，现在这句话可以被验证了——`--with-wait` 那 49 秒就是证据。

## 10.7 仍未做（下一轮候选，等点头）

| 项 | 优先级 | 成本 |
|---|---|---|
| **P4-7 安装引导**（`beforeinstallprompt` + iOS 说明） | 高（唯一增长杠杆） | 半天，需要先定形态 |
| **P7-2** 静态资源 ETag（闲置一小时重下 148KB） | 中 | 10 行 |
| **P4-4** CSP / X-Frame-Options | 中 | 需逐项核对内联脚本与内联样式，容易踩 |
| **P3-2** 线上 3 个已删但仍在部署包的 `.png` | 低 | 清理 |
| **P3-6** 观战 | 不做（用户已明确） | — |
| P5-3 幂等键 | 不修（概率 1/22500，见 9.3） | — |


---

# 十一、v54：「提交牌就卡住、整屏只剩背景色」不是性能问题（P9）

## 11.1 我先查错了方向

用户报的是：**同一部手机上，Safari / Edge / PWA 三个容器分别登录三个不同账号，
没有串台，但每次提交牌时会卡住；卡住时页面上不展示内容，只有背景色；
大部分时候只能放弃这一局。**

我先按「同浏览器多标签共享 localStorage」去查，写了个三标签探针，确实抓到了串台
（B 标签重载后变成 A 的账号）。**但那是另一件事**——用户用的是三个**独立容器**
（三个浏览器 / PWA 安装），存储天然隔离，根本不会串。

用户明确纠正之后，方向才对准：**「只有背景色」是布局事故，不是请求超时。**

> 这一条记在文档里，是因为它值得记：**先入为主的技术假设会让人跑偏一整轮**。
> 用户说「卡」时，先问清「卡住时屏幕上是什么」，比先猜机制有效得多。

## 11.2 P9-1　`resize()` 读到 0 尺寸 → `scale(0)` → 整屏只剩背景色 ✅ 已修复

### 机理

`pwa/js/game.js` 的 `resize()` 里：

```js
var vw = vp.clientWidth;
var vh = vp.clientHeight;          // ← 没有任何有效性校验
var availH = vh - saTop - saBottom;
var isLandscapePhone = availW >= availH && Math.min(availW, availH) <= 520;
...
scale = Math.min(availW / CONFIG.DESIGN_WIDTH, availH / (isLandscapePhone ? 1440 : 1624));
```

`vh` 读到 0 时（`availH` 变成 0 或负数）：

- `isPortraitPhone`（要求 `availW < availH`）落空；
- `isLandscapePhone`（要求 `Math.min(availW, availH) <= 520`）**成立**——因为 `Math.min` 是 0 或负数；
- 于是 `scale = Math.min(0.52, 0) = 0`（无安全区）或负数（有安全区，还要再减 47+34）；
- `transform: scale(0)` 把整个 750×1624 舞台缩成 **0 像素**；`stageW = vw / scale` 变成 `Infinity` 或上万的负数。

**屏幕上就只剩 `#viewport` 那层背景色。而且不会自愈**——此后没有任何 `resize` 事件，
用户只能刷新。

### 为什么恰好发生在「提交牌」的时候

提交之后这一轮就在等别人，用户**必须切到另一个容器去操作另外两个账号**。
iOS 在多开、内存吃紧时会在后台挂起期间回收页面的渲染树；恢复那一帧布局尚未完成，
`#viewport` 的 `clientHeight` 就是 0。于是：

```
提交 → 切到下一个浏览器 → 操作别人 → 切回来 → resize 跑在尺寸为 0 的那一帧 → 白屏
```

这同时解释了「为什么和好友各用各的手机从来不卡」：**那种玩法不需要切容器**。

### 修法（三道闸 + 一次重算）

1. **读尺寸后立刻校验**，无效就 `return` 保留上一次算好的舞台，并安排 80ms 重试（最多 5 次）；
2. `availW / availH` 扣完安全区后再校验一次（折叠屏过渡态、极窄窗口）；
3. 写进 DOM 之前最后一道：`if (!isFinite(scale) || scale <= 0) return;`
4. 新增 `visibilitychange`（回前台）和 `pageshow`（bfcache 复活）时重算一次——
   iOS 从后台回来**不一定发 `resize`**，而缩放是一组按当时视口算死的像素值。

第 4 条还有一个副作用是好的：**已经白屏的页面，切一次前台就能自己恢复**。

### 反证（不绿就不算修好）

把三处校验全部撤掉再跑旅途测试：

```
FAIL ★ clientHeight 读到 0 时不写 0/负缩放（保留上一次算好的舞台）
     -> {"realT":"scale(0.52)","midT":"scale(0.52)","zeroT":"scale(0)","badScale":true}
FAIL ★ 尺寸恢复后缩放自己算回来了
     -> {"t":"scale(0)","h":"1440px"} vs "scale(0.52)"
通过 57 项，失败 2 项
```

**恰好 2 条红，且只有 2 条**——同段的「探针自检」和「回前台重算」照样绿，
说明这两条断言精确指向那三处校验，没有蹭别的判断。

> 顺带纠正我自己写注释时的措辞：我一开始写的是「算出负 scale」。
> **实测在没有安全区的窗口下写进去的是 `scale(0)`**，比负数更彻底。
> 带安全区的真机才是负数。注释已按实测改过来——不然下一个人会照着错的描述去找错。

## 11.3 P9-2　分牌 60 秒超时，界面上没有倒计时 ✅ 已补

用户那句「大部分时候会因为放弃结算」，查下来不是他自己点放弃，而是
**服务端 60 秒一到自动判「本回合弃权」**：`forfeitRound` 之后本回合各组都当弃权，
**不收分，还要照付各组赢家**。

而界面上**一个字都没有**。玩家是事后才看到「你已超时弃权」。

对「一部手机切三个容器」几乎是必踩：切过去操作别人的那几十秒，这边已经悄悄到点。

修法：

- 服务端 `_view()` 给**本人**下发 `splitEndsAt`（只在自己还没提交、计时器还存在时给）
  和 `now`（服务端当前时间，让客户端扣掉本机时钟偏差——手机时间被改过时时区错时会整体偏掉）；
- 前端顶栏加一个胶囊 `#gt-timer`，每秒只改文本（**不重绘顶栏**，重绘会让正在点的按钮失焦、
  打断手牌动画），`tabular-nums` 保证数字等宽、不左右抖；
- 最后 15 秒转暖红；离开对局页 `stopSplitTick()`，不留一个每秒空跑的 interval。

## 11.4 P9-3　倒计时在后台会被节流 —— 切回来必须立刻刷新 ✅ 已补

跑 `--with-wait` 时冒出一条偶发失败：**倒计时 1.2 秒内从 60 → 60**。三次里红两次，
而普通模式（13 秒跑完）始终绿。

原因：浏览器对**不可见页面**的 `setInterval` 会节流，headless 下最狠到一分钟一次；
`--with-wait` 前面刚停了 35 秒，页面被判为不活跃，那 1.2 秒里 interval 一次都没跑。

**但这不只是测试环境的毛病，它正是玩家场景的常态**：切到另一个浏览器操作另一个账号，
这一页就在后台。切回来时若只等 interval，看到的是**过期数字**——
「还剩 50 秒」，而实际上早过了 60 秒的点，人已经被判弃权。

所以修法不是改测试，是产品补一条：`visibilitychange` 恢复时先 `tickSplitTimer()` 再 `resize()`。

测试侧也改了，并写清了为什么：主动派发一次 `visibilitychange`（临时把 `visibilityState`
盖成 `visible`）再读第二次——验的是「切回来会立刻刷新」这条真实路径，
而不是「定时器在这台机器上跑得动」。

> 方法论再记一次：**偶发失败不要靠重跑蒙过去。** 这一次它指出的是一条真需求。
> 如果当时看到绿了就收工，这行 `tickSplitTimer()` 永远不会被加上。

## 11.5 P9-4　顺手挖出：补时限时倒计时会**多算 45 秒** ✅ 已修复

`_armOneSplitTimer` 末尾原来是 `this.splitStartedAt.set(key, Date.now())`。
正常情况下 `delayMs === SPLIT_TIMEOUT_MS`，没问题。

但**重连补时限**调的是 `_armOneSplitTimer(room, p, round, MIN_RECONNECT_SPLIT_MS, false)`
——生产配置下 timer 只有 **15 秒**，而记下的起点是「现在」，于是
`startedAt + SPLIT_TIMEOUT_MS` 算出来是 **60 秒后**。差 45 秒。

这个值以前没人读，所以一直没人发现。**一旦它要拿去算倒计时，就变成了「显示还剩 45 秒，
但你已经判弃权」**——比不显示更糟。

修法：起点按实际时长反推（`Date.now() + delayMs - SPLIT_TIMEOUT_MS`），
正常情况反推结果就等于 `now`，补时限时才是真正的截止时刻。

测试 `split-reconnect.test.js` 从 6 项扩到 **13 项**，其中一条专守这个：
`★ 补时限后倒计时反映的是补的量（≤1300ms），不是原始 1500ms`。

## 11.6 声音开关：那个「关了还有声音」的 bug ✅ 已修复（上一轮）

`Sfx.setBgmEnabled` 只管背景音乐，`Sfx.play()` 完全不看开关——发牌、选牌、提交、赢、
结算五种音效照旧响，连 `aria-label` 写的都是「背景音乐」。改成总开关 `setSoundEnabled`，
`play()` 首行 `if (!soundEnabled) return;`，界面文案与 `aria-label` 一起改成「声音」。
`audio.test.js` 43 项，反证过（把 `if (!soundEnabled) return;` 删掉 → 精确 3 条红）。

## 11.7 数字

| 项 | 值 |
|---|---|
| `npm test` | **60 文件 / 2088 项 / 0 FAIL / 57.6s**（v53 是 2056） |
| `npm run journey` | **61 项 / 0 FAIL / 13.7s**（v53 是 55） |
| `npm run journey -- --with-wait` | **63 项 / 0 FAIL / 50.8s** |
| 其中新增 | `[9c]` 缩放健壮性 4 项（0 尺寸 / 自愈重试 / 回前台重算 / 探针自检）、倒计时 2 项 |
| 倒计时实测 | `剩 60 秒 → 剩 59 秒`（真浏览器，每秒真在走） |

## 11.8 评分

| 维度 | v53 | v54 | 理由 |
|---|---|---|---|
| 移动端手感 | 8.5 | **9.0** | 白屏是「整屏不可用且不自愈」，一条顶很多条；且回前台会自动重算 |
| 产品完成度 | 8.5 | **8.7** | 分牌不再是「看不见的倒计时」，玩家能自己决定节奏 |
| 工程质量 | 9.5 | **9.5** | 两处修复都带反证和真浏览器回归 |
| 其余八项 | — | 不变 | 没动规则、安全、增长 |

**加权：8.8 → 8.9。**

## 11.9 必须说清的一件事：卡顿不可能被完全消除

同一部手机同时跑三个 WebView 打同一个实时游戏，是**三份渲染 + 三份 JS + 三份 WS**
挤在一颗 CPU 上。这是物理事实，代码改不掉。这一轮修掉的是两件**代码层面确实错了**的事：

1. 切回来整屏空白（`scale(0)`，且不自愈）——这是 bug，不是性能；
2. 看不见的分牌倒计时（60 秒到点直接弃权，界面无提示）——这是 bug，不是性能。

修完之后，"切容器"这个动作仍会有**秒级的等待**（页面从冻结恢复、连接探活重连），
但不会再出现「什么都没了、只能刷新」和「不知道自己只剩几秒」。

**真正想顺畅玩三个账号，正确的做法还是三台设备（或至少三个浏览器窗口分屏）。**
一人多开这件事本身，代码只能让它「不坏」，没法让它「不慢」。


## 11.10 v54 发布核对（2026-10-29 15:5x）

版本 `20261029i` / `sw v53`（上一版是 `20261029h` / `v52`）。发布前后逐项核过：

| 项 | 结果 |
|---|---|
| `npm test`（改版本号前后各一次） | 60 文件 / **2088 项** / 0 FAIL / 56.2s、57.1s |
| `journey --with-wait` | **63 项** / 0 FAIL / 50.0s |
| `npm run backup` | 已备份 3 位玩家（+83 / -2 / -81）进种子文件 |
| `/api/health` | `version` = `pwa` = `20261029i`；`server` 时间戳 `07:25:48Z` 晚于本轮所有服务端改动；`uptime` 从 0 起算 |
| md5（6 个文件） | `index.html` / `sw.js` / `js/game.js` / `js/roomStore.js` / `js/sfx.js` / `css/style.css` **全部 OK** |
| `sw.js` | `CACHE_NAME = 'weile-liuxuanwu-v53'`（老客户端能自己换缓存） |
| gzip | `Content-Encoding: gzip` / `Content-Length: 12789` / `Vary: Accept-Encoding` |
| 牌桌三档线上 | 320×568 / 390×844 / 430×932 **全部退出码 0**，`overflow: 0`，三组 `visibleRatio: 1` |
| 探针账号 | 三档都走完 `[4] 清理探针账号` → `{"ok":true,"removed":true}` |
| 线上榜单 | 发布前后都是 3 位真实玩家，**数据未被发布覆盖** |

### 两条值得记的观察

**① 发布前 `/api/health` 的 `uptime` 是 0。** 也就是上一次 v52 的进程在我动手之前
就已经重启过一轮（不是这轮造成的）。上一轮也出现过同类情况（v51 后 uptime 归零）。
平台容器回收没有日志可查，所以这条只能作为现象记录，不能当结论——
但它解释了为什么有时候「服务端改动看起来没生效」：进程被回收重启后，
跑的一定是磁盘上那份代码，不会是内存里改过的。

**② 发布后 `rooms: 6`。** 三档探针各建了一个房、写完就退，房间对象留在内存里等超时回收。
不影响真实用户（房间号 6 位随机，撞上概率 6/900000），但说明**空房间是靠超时清、不是靠退房立即清**。
若将来要做「房间数上限告警」，得先看清这一点。


---

# 十二、v55：禁止页面缩放（2026-10-29）

## 12.1 用户报的原话

> 「在游戏内放大或者放小桌面，桌面可以被控制，放大后导致看不清牌……即时分享的是链接用浏览器打开，
> 也要禁止这种操作，因为拖拽牌的时候很容易误操作浪费时间。」

这段话里其实有三个独立诉求，我拆开看了：

1. **牌桌能被捏合缩放**——在游戏里本来就是不该有的行为；
2. **放大之后看不清牌**——不是「牌太小」，是「放大让牌出了视口」；
3. **分享链接用浏览器打开也要禁**——不能只在 PWA 独立窗口里生效。

第 3 条决定了这件事故意不能只做在 manifest / PWA 层，必须做到页面本身。

## 12.2 为什么这是「必须禁」而不是「最好禁」

这个项目的牌桌不是流式布局，是 **750 设计空间整体缩放**：`#stage` 上一句
`transform: scale(min(availW/750, availH/1440))`，手牌尺寸、组槽坐标、拖拽命中区
全部按这套固定像素算死。浏览器再叠一层页面缩放，后果是：

- 牌整体变小或部分移出视口 → **看不清牌**；
- 命中区跟着缩放比例整体偏移 → **拖牌点不中**，而分牌有 60 秒硬超时
  （超过就 `forfeitRound` 自动弃权，不收分还照付），误操作是**直接亏分**的；
- 缩放状态会留在页面上，玩家得自己捏回去——很多人不会，就这么别扭地打完一局。

所以它和「页面能不能缩放」这个通用 Web 问题不是一回事：**这里的页面缩放会直接吃掉分数。**

## 12.3 三处缺一就漏

| 层 | 改了什么 | 为什么非它不可 |
|---|---|---|
| `<meta viewport>` | `maximum-scale=1.0, user-scalable=no` | Android Chrome / 部分国产浏览器只认这条 |
| CSS 根元素 | `touch-action: manipulation` → **`pan-x pan-y`** | `manipulation` 展开等于 `pan-x pan-y **pinch-zoom**`，也就是**把捏合明确允许给浏览器**。这是最隐蔽的一处——看起来"已经禁了"，实际上是在放行 |
| JS | `lockPageZoom()`：`gesturestart/change/end` + 双指 `touchmove` 全部 `preventDefault` | **iOS Safari 从 iOS 10 起故意忽略 `user-scalable=no`**。元标签在 iPhone 上等于没写，真正生效的只有这道 |

三处是「或」的关系，缺任何一处，那一类浏览器就漏。反过来说：**只改 meta 就以为做完了，
是这件事上最常见的错。**

## 12.4 `passive: false` 是必需的，不是风格选择

监听器写 `{ passive: true }`（或者干脆不写、被浏览器默认当被动处理）时，
`preventDefault()` 会被**静默忽略**——代码一个字都不用改，效果归零，控制台也不报错。

反证做过：把三处 `{ passive: false }` 改成 `true`，`journey` 的 `[9d]` **精确红 2 条**
（`twoFinger` / `gestureStart` 从 true 变 false），恢复后重新校验文件哈希。
这条故意留在 `[9d]` 的注释里，因为它是"以后有人顺手优化掉"的高危点。

## 12.5 只拦双指，不拦单指——这是反向守

`touchmove` 的处理里写的是 `e.touches.length > 1` 才 `preventDefault`。
不能写成"无条件拦全部 touchmove"：那样上一条断言照样绿，但**单指拖牌和点击会一起坏**，
而这种坏在自动化里不一定露头（合成事件照样能派发），只有人上手才发现。

所以 `[9d]` 里专门有一条反向断言 `oneFinger === false`，
仓里对应的是 `pwa/test/zoom-lock.test.js` 里那几条「`.card-wrap` / `.card-box` 必须仍是
`touch-action: none`」——拖拽要跟手，不能被页面滚动抢走。

也**故意没拦 `touchstart`**：拦了会让 iOS 上的点击变慢、双击判定变脆，而它对禁缩放没有额外作用。

## 12.6 立场翻转：两条无障碍断言被我改了

`pwa/test/ui.test.js` 原来有两条断言，是我早先**为了无障碍特意加的**：

```
ok(!/user-scalable=no/…, 'viewport 不禁止缩放（1.0 倍浏览器里连字都看不清）')
ok(!/maximum-scale=1/…,  '也没有保留 maximum-scale=1')
```

这次它们和新需求**正面冲突**。我没有偷偷删掉，而是改成反向断言，并在代码里把来路和代价写清：

- **原来的理由没错**，错的是**前提变了**——当年牌桌是流式布局，缩放只是"字变大变小"；
  现在牌桌是整体缩放，页面缩放会破坏命中区（12.2）。
- **代价必须说出来**：这一改**牺牲了页面级缩放的无障碍能力**，视力不好的用户没法把字放大。
  这是真实损失，不是"反正没人用"。
- **正确的补偿**是做一个「牌面/字号放大」设置项（在应用内放大，而不是放开页面缩放），
  **目前没做**，记为 P10-3。把开关放回去不是补偿，是把 12.2 的问题重新引进来。

我认为在"拖牌点不中就丢分"和"少数用户没法放大页面"之间，这一版选前者是合理的；
但这条取舍该由产品决定，所以我把它留在文档最显眼的位置，而不是埋在 diff 里。

## 12.7 数字

| 项 | 结果 |
|---|---|
| `npm test` | **61 文件 / 2109 项** / 0 FAIL / 57.4s（v54 是 60 文件 / 2088 项；新增 `zoom-lock.test.js` 21 项） |
| `npm run journey` | **66 项** / 0 FAIL / 13.6s（v54 是 61 项；`[9d]` 新增 5 条） |
| `[9d]` 实测 | `bodyTouchAction: "pan-x pan-y"` / `twoFinger: true` / `oneFinger: false` / `gestureStart: true` / `gestureChange: true` / `vvScale: 1` |

`zoom-lock.test.js` 守的是「代码长这样」（三处都在、没有 `manipulation`、没有 `pinch-zoom`、
`passive` 确实是 `false`、单指分支存在）；`[9d]` 守的是「行为真的这样」
（真浏览器里派发事件，读 `defaultPrevented`）。两样都要——这个项目已经栽过一次
"注释说做了、实际没做"的坑（见 10.4 与 10.5）。

`[9d]` 的边界也得说清：桌面 Chrome/Edge 没有"页面捏合缩放"这件事，所以它验的是
**拦截层**（事件派发下去有没有被 `preventDefault`），不是"iPhone 上双指之后牌是不是真的没变大"。
最后那一步只能人上手，而它的前提正是这条拦截。

## 12.8 仍未做

- **P10-3「牌面放大」设置项**：本次立场翻转的补偿项，也是无障碍损失的唯一正解。未做。
- 第十二章之外的老候选没动：P4-7 安装引导、P7-2 ETag、P4-4 CSP、P3-2 清理线上旧 png。
- P3-6（观战）用户明确说不做。

## 12.9 v55 发布核对（2026-10-29 16:2x）

版本 `20261029j` / `sw v54`（上一版 `20261029i` / `v53`）。链接未变，`sandboxId` 未变。

| 项 | 结果 |
|---|---|
| `npm test`（改版本号前后各一次） | 61 文件 / **2109 项** / 0 FAIL / 57.4s、57.0s |
| `journey --with-wait` | **68 项** / 0 FAIL / 50.2s |
| `npm run backup` | 已备份 3 位玩家（+78 / -28 / -50）进种子文件 |
| `/api/health` | `version` = `pwa` = `20261029j`；`uptime: 11`（进程确实刚重启）；`server: 07:25:48Z` 与上一轮相同——**本轮没有服务端改动，这是对的** |
| md5（6 个文件） | `index.html` / `sw.js` / `js/game.js` / `css/style.css` / `js/roomStore.js` / `js/sfx.js` **全部 OK** |
| `sw.js` | `CACHE_NAME = 'weile-liuxuanwu-v54'` |
| gzip | `gzip` / `13042 B` / `Vary: Accept-Encoding`（比 v54 的 12789 略大，index.html 多了缩放注释） |
| 牌桌三档线上 | 320×568 / 390×844 / 430×932 **全部退出码 0** |
| 探针账号 | 三档都走完 `[4] 清理探针账号` → `{"ok":true,"removed":true}` |
| 线上榜单 | 发布前后都是 3 位真实玩家、数值一致（+78 / -28 / -50），**未被发布覆盖** |

两条与上一轮不同的观察：发布时 `rooms: 0 / conns: 0`（没人正在玩），
所以这次没有"空房间靠超时清"的残留；`uptime` 归零是本次发布造成的，不是平台回收。

## 12.10 剩余未修项的**风险**评估（决定：暂不修，等真出问题）

用户的原话是「剩下等真正出了问题再解决」，所以这一节不是待办清单，
而是**给"暂时不修"这个决定做的背书**：每项写清「现在最坏会怎样」「怎么知道它真的出问题了」
「真出了要多久能修」。判断标准是三者乘积——**概率 × 后果 × 事后补救成本**。

| 项 | 现在最坏会怎样 | 早期信号（怎么知道真出事了） | 真出了要多久 | 结论 |
|---|---|---|---|---|
| **P10-3 牌面/字号放大设置项**（本次立场翻转的补偿） | 视力不好的用户无法把字放大，只能凑近屏幕或调系统字体（系统字体对本项目无效，因为字号是写死的 px）。**不影响分数，只影响可用性** | 玩家口头反馈「太小看不清」；或分享给年长亲友后被退 | 1 天（加一个 0.85/1/1.15 三档倍率，作用在 `#stage` 的 `scale` 上并重算命中区）。**但会牵动 12.2 的全部坐标假设，属于"改起来不难、验起来很贵"那类** | 不修。它是无障碍损失，不是功能故障；**唯一会逼我动的条件是有人真的说看不清** |
| **P4-7 安装引导** | 首次访问的人不知道可以装到桌面，流失一部分留存。**纯增长问题，零功能风险** | 无法从代码侧观测（没有埋点）；只能靠用户问「怎么装」 | 半天（一个一次性引导浮层，可跳过） | 不修。它需要先定形态（是引导装 PWA、还是就用浏览器玩），**形态没定就先做等于白做** |
| **P7-2 ETag / 304** | 弱网下每次进游戏要重下 ~13 KB gzip 的 index.html + 十几份 js。**实际体感无差别**（单文件 13 KB，4G 下 100ms 级） | 用户报"流量大"或"每次打开都很慢"——目前 0 例 | 1 小时（`static.js` 里加 mtime+size 的弱 ETag，处理 `If-None-Match` 回 304） | 不修。**这是"教科书上应该有、但这里收益接近 0"的典型**，也是我上一轮把它排进去的理由不充分的地方 |
| **P4-4 CSP 响应头** | 目前没有 CSP，理论上 XSS 一旦成立就没有第二道闸。**但代码里没有可注入的 HTML 拼接点**（用户输入走 `textContent`，房间号/昵称都过白名单），风险是从"没有"来的，不是从"存在漏洞"来的 | 一旦出现 XSS 报告，或者将来引入任何 `innerHTML = 用户输入` | 半天（写 header + 把内联 `<script>` 和 `style` 的 nonce/hash 理顺，**这一步最容易把页面搞白**，必须整套跑一遍三档探针） | 不修。**CSP 是"上了就得一直维护"的东西**，在没有注入面的前提下先上，收益小于它带来的新故障类型（白屏） |
| **P3-2 清理线上旧 png** | 静态目录里留有早期版本的图片，占几 MB 空间。**无功能影响** | 无（永远不会有信号） | 10 分钟 | 不修。它连"问题"都算不上，只是仓库整洁度 |
| **P3-6 观战** | 不存在该功能 | — | — | **用户明确说不做**，不列入风险 |

### 这一节的结论

六项里，只有 **P10-3** 是"真实损失"，其余五项要么无感（P7-2 / P3-2）、
要么形态未定（P4-7）、要么"没有注入面时先上反而引入白屏风险"（P4-4）。

所以「等真出问题再解决」这个决定是**成立的**，但它有一个前提必须写下来：
**前提是这些项都有可观测的早期信号**。上表第 3 列就是这个用途——
P4-7 和 P3-2 **没有信号**，意味着它们不会被"真出问题"触发，只会被"用户主动抱怨"触发。
换句话说，**如果一直没人抱怨，它们会一直躺在那里**，这不是遗漏，是我现在就能预见的稳定状态。

唯一的例外是 P10-3：它的信号（"看不清"）只可能来自**真人反馈**，
而这类反馈通常来自**年长玩家**——也就是说，这个损失最可能落在最不会反馈的那部分用户身上。
这是这一节里唯一让我不舒服的一条，写在这里备查。

# 十三、v56：回放要看整场，结算要标出「我」（2026-10-29）

## 13.1 用户报的原话

> 查询对局详情，点进去发现只是部分，不是全量，我的战绩界面查询对局详情按钮描述不够清晰，
> 你帮我想几个按钮描述，然后让我决定选哪个，对聚聚术后，没有像排行榜一样标出哪个是我，
> 看起来很混乱，这个要改，而且风格要和排行榜一致，并考虑排行榜和我对局结束得界面 ui
> 是否可以再美化，现在还是有点丑

「聚聚术后」应该是「局结束」的输入法错位，指的是**结算页**。

## 13.2 拆成四件事，三个决定由用户做

| # | 问题 | 决定 | 谁定的 |
|---|---|---|---|
| 1 | 「看过程」文案不清晰 | **看回放** | 用户从 5 个候选里选 |
| 2 | 点进去只有部分 | **整场从头到尾** | 用户选 |
| 3 | 结算页没标出「我」 | 必修 | 用户直接要求 |
| 4 | 两个页面 UI 还能再美化 | **中等力度**（看台 + 统一语言） | 用户选 |

候选文案当时给了五个：看回放 / 整场过程 / 对局过程 / 回看这局 / 看看怎么输的。
用户选「看回放」，最短、动词明确、和「生成战绩图」不是一个语义层级。

## 13.3 「只有部分」其实是**两个**问题，不是一个

这一点必须先说清，否则修完第一个会以为第二个也顺手好了。

**问题 A：名字整列是空的。** 这不是"少了几把"，是每一行都没有名字。
根因在 `pwa/js/stateMachine.js`：

```js
entries: (g.entries || []).map(function (e) {
  return { id: e.id, nickname: e.nickname, hand: e.hand };  // ← e.nickname 永远是 undefined
})
```

`Engine.settleGroup()` 返回的 `entries` 只有 `{ id, hand, typeName, decider }`，
**它根本不带 nickname**。所以这里是拿一个不存在的字段去赋一个不存在的字段，
一路 `undefined` 飘到界面上，渲染成空白。改成从房间玩家表里查：

```js
var p = findPlayer(room, e.id);
return { id: e.id, nickname: (p && p.nickname) || e.nickname || '', hand: e.hand };
```

反证做过：把修复撤掉，`replay.test.js` 精确红 2 条（正好是"每人都有非空昵称"和"昵称来自房间玩家"）。

**问题 B：前几把根本没留下来。** 这个是设计层的，不是 bug。
`room.history` 是**服务端房间对象上的滚动窗口**，硬砍 4 条（≈2 把）。

## 13.4 为什么不把服务端窗口开大

算一下就知道了：`room.history` 每次房间广播都**整份下发**。
一场打到散大约 9 把，每把 2 轮、每轮 3~5 组、每组 12 行——整场序列化 15.7 KB（实测）。
如果窗口放开到整场，那么**每一次状态变化**（出牌、抢庄、倒计时、聊天）
都要多推 15 KB × 在线人数。这不是"性能优化"能救的，是拿带宽换功能。

所以选了另一条路：**不在服务端加窗口，让每个客户端边看边攒**。

## 13.5 场次档案（`pwa/js/sessionLog.js`，252 行，新建）

思路：每次房间更新时，把 `history` 里出现过的 `(第几把, 第几轮)` 收进本机一份档案。
房间只发最近两把，但客户端是**连续在看**的，时间一长整场就齐了；
存 localStorage，**刷新页面也不丢**——这是内存窗口做不到的。

三处关键设计：

1. **场次身份 = `roomId + '#' + createdAt`**，不是房号。
   6 位房号会被回收，同一个人过两天再建房拿到同一个号，
   只按房号会把两份不相关的过程拼成一场，看回放时时间线会倒流。
2. **稳定把次身份 `handId`**。原来有两个候选都不合格：
   `handCount` 在「开下一把」时归 1，`handSeq` 只在结算 +1 ——
   两者在不同路径上的行为不一样，都不能当"这一把"的身份。
   所以新增 `room.handId`，只在 `dealAll()` 首行递增——**三个入手路径
   （开局 / 自动连下一把 / 结算页「开下一把」）都走这里，是唯一计数点**。
3. **幂等靠 `(第几把, 第几轮)`**，同一轮重复广播只存第一次见到的那份。
   外面再套一层 `absorbSig` 签名短路（`hist.length + '|' + last.hid + ':' + last.round`），
   避免每次渲染都 `JSON.parse` 几十 KB。

**吸收时机也踩过一个坑**：`absorbHistory(r)` 必须放在 `render()` **之前**，
且不受当前屏幕形态影响——因为 `render()` 在战绩页 / 排行榜 / 登录页会直接 return，
而那恰恰是「人在看别的页、房里还在打」的时候，正是最该攒的时刻。

### 边界（写进代码注释了，别让人以为能回溯）

- 只覆盖**你在线期间**的把次。中途加入、或换了设备，之前那几把本来就没广播给你。
- 被体积削峰丢掉的老把次，回放里就看不到了，「共 N 把」也会跟着变准。

## 13.6 体积：四个结构上限**加起来不够**，必须按字节削峰

这是本轮唯一一个"我以为做完了、实际没做完"的地方，记下来。

第一版只定了结构上限：4 场 × 24 把 × 4 轮 × 6 组 × 12 行 × 6 张牌，
字段各自 `clip`。看起来层层封顶了。测试里也只有"最多留 4 场"这种**计数**断言，
没有一条量过**字节**——因为数字是我估的，没算。

后来专门写了个脚本把四个上限全部拉满、序列化一次，结果是：

```
5333 KB
```

**直接顶穿 5 MB 配额。** 而且不是"刚好超"，是超了还带零头。
这一刻的意义不是"要多写 5 行代码"，而是：**结构上限和体积上限是两件事，前者推不出后者。**
`12 行 × 6 张牌` 看起来很节制，乘上 `24 × 4 × 6 × 4` 就是四万多个字段。

修法是把兜底从"猜个数"换成"量字节"：`writeAll` 里加 `trimToBudget`，

```js
var BYTES_MAX = 400 * 1024;   // 约上限的 8%，剩下留给战绩缓存、登录态
```

超预算就**先丢最旧的场次**，还不够就**削最新那场里最旧的把次**。
丢的都是过程，不影响战绩本身。削完再写，配额真爆了 `setItem` 抛错也不往外传
（`absorb` 是在 WebSocket 消息回调里被调的，抛出会把整条消息链打断）。

改完：**581 KB**。断言从"计数"换成四条：
落预算内 / 占不到 5 MB 三分之一 / 削峰后最新那场仍读得出来 / 留下的那把还有轮次。
后两条是为了防止"一刀清空"这种"解决了溢出、但功能没了"的假修复。

## 13.7 结算页「我」：金碰金，等于没标

原来的写法是给「我」那一行加一圈金色描边。问题是**冠军行本身就是金色渐变底**，
金描边压在金底上，肉眼分不出来——用户说"看起来很混乱"就是这个。

改成和排行榜**同一套语言**（这也是用户明确要的"风格一致"）：

- `inset 6px 0 0 var(--gold)` 金色左竖条（不是描边，是从边上长出来的一条）
- 昵称变金色 + 后面挂一个「我」胶囊

验证不能只查 className——那是"代码里写了"，不是"屏幕上看得见"。
所以 `journey.js` 里用 `getComputedStyle` 取 `boxShadow` 和 `backgroundColor` 实测：

```
★ 那一行有金色左竖条（和排行榜同一套语言）  rgb(245, 193, 92) 6px 0px 0px inset
★ 名字后面有「我」胶囊                      1/我
```

另外把 5 个按钮从"竖着一长串"收成 3 行：
`开下一把` / `生成战绩图` + `本局过程` / `查看战绩` + `离开房间`。
层级是 主操作金实心 → 次操作幽灵 → 出口绿描边。

## 13.8 排行榜看台

用户说"还可以再美化"，选了中等力度，所以没有重做布局，只加了**前三名的看台**：
金/银/铜渐变底、加大行高与字号、第 3 名画一条分界线。

这里有个必须处理的冲突：**看台底色和「我」的金条会互相盖**。
所以看台样式全部带 `:not(.is-me)`——如果第一名就是我，让位给金条。
断言因此不能只判 `bg !== 'none'`，得写成分支：

```js
first.isMe ? /inset/.test(first.shadow) : first.bg !== 'none'
```

不加这个分支的话，单人房榜单（第一名永远是我）会**永远误报红**。踩过了。

## 13.9 踩坑：在动画中间量尺寸，会得到"飞进来一半"的坐标

这轮为了排查"结算页右侧是不是被裁掉"，量出来：

```
bodyClientW: 670 / row0Right: 469
```

看起来右边溢出 130px。差点去改布局。实际是 `.screen.enter` 有 0.3s `slideInRight`，
`.settle-row` 还有 200ms 起的错峰淡入——**量到的是转场中间帧**，
逻辑位置算出来 `144 + 348×1.5`，正好是"飞进来一半"。
等 700ms 再量，`row0Right: 369`，一切正常。

同一个错误这轮犯了**两次**（第二次是看截图觉得右侧被裁，其实第一行还在淡入）。
所以最后把"等动画"写成注释留在脚本里，而不是删掉：

```js
/* 先等动画落地再量。`.screen.enter` 有 0.3s 滑入，`.settle-row` 有 200ms 起的错峰淡入，
 * 在动画中间量出来的坐标是「飞进来一半」的位置，会让人误以为布局溢出了（真踩过）。 */
await sleep(700);
```

顺手把那块一次性的 `geom` 诊断（十几个字段全量打印）换成了**一条真断言**：
结算页不许横向溢出（页面 `scrollWidth - clientWidth <= 0`，滚动区同理）。
诊断代码不该留在回归脚本里，但它发现的问题应该变成断言。

另一个同源的隐患：`.settle-body` 原来用 `justify-content: center` 居中，
内容超高时**顶部会被裁掉且滚不回来**（flex 的经典坑）。改成外层 flex + 内层 `margin: auto 0`。

## 13.10 数字

| 项 | 数值 |
|---|---|
| `sessionLog.js` | 252 行（新建） |
| 结构上限 | 4 场 × 24 把 × 4 轮 × 6 组 × 12 行 × 6 张牌 |
| 字节预算 | 400 K 码元；拉满实测 581 KB（削峰前 5333 KB） |
| 真实一场（9 把 × 2 轮 × 3 组） | 15.7 KB |
| `npm test` | **62 文件 / 2156 项全通过**（+7：配额与真实 id） |
| `journey --with-wait` | **74 项全通过**（+3：胶囊 / 金条 / 溢出） |
| `probe-records` | **20 项全通过**（整场 3 把、目标把被标、15 组、32 行、15 个「我」胶囊、打开即定位 `scrollTop=1862`） |
| `session-log.test` | 45 项（含配额一节 7 项） |
| `replay.test` | 31 项（+2：昵称非空 / 昵称来自房间） |

## 13.11 发布状态：**没有发布**

用户这一轮没有说"发布"，只说了要改。所以：

- `pwa/index.html` 的 `app-version` 仍是 `20261029j`，13 处 `?v=` 未动
- `pwa/sw.js` 的 `CACHE_NAME` 仍是 `'weile-liuxuanwu-v54'`
- **下次发布时必须一起改**：新增了 `js/sessionLog.js`（已带 `?v=20261029j`），
  改过 `stateMachine.js` / `game.js` / `records.js` / 两个 css，
  如果只改文件不改版本号，老客户端会继续用缓存里的旧 JS——
  表现是"回放还是只有一把"，而且看起来像没修好。

## 13.12 仍未做

- **P10-3 牌面/字号放大**（12.10 里唯一"真实损失"那条）：加了「我」胶囊、加了大字号看台之后，
  这一项的必要性反而上升了一点，因为行内容更长了。仍按 12.10 的结论不修。
- **回放里没有"谁赢了几组"的汇总**：现在只能一场一场看过程。
  用户没要求，不加——加了会让回放页从"过程"变成"报表"。
- **看台只做到第 3 名**：第 4 名往后是普通行。这是刻意的，再多就不叫"看台"了。

# 十四、v56：十点半「王比 10 大」（2026-10-29）

## 14.1 用户报的原话

> 十点半规则更正，你先理解，盖章以前和我确认

附两张图：一张是结算截图（十点半 10.5×2，三家里「王 + K♣」显示 **9.5 点**、-2），
一张是微信群聊截图，群友吴墨豪的回复是：

> 10点半 / 是最大的 10 / 十点半不比半点，比 10 / 王比 10 大

用户自己的疑问是「王不是不能当 10 吗」——**这句话正是旧规则的原文**，
所以他质疑的不是代码写错，是**规则本身错了**。

## 14.2 先理解，不动手

用户明确要求「盖章以前和我确认」，所以这一轮先做了三件事：

1. 把截图里的 9.5 反推回代码，确认它是**旧规则的产物**而不是渲染 bug；
2. 把群聊四句话逐句映射到规则条款；
3. 用脚本实测旧行为的四条关键组合，带着数据去问，而不是带着理解去问。

实测结果（改前）：

```
10♠ + J♠  = 10.5 点
10♦ + K♦  = 10.5 点
王 + K♣   = 9.5 点        ← 截图那手
10♠ + 王 vs 10♠ + K♣  →  右边赢   ← 跟「王比 10 大」正好反着
```

第三行解释：旧规则里王「唯一不能当的是 10」，所以王只能退到 9，9 + 0.5 = 9.5。
第四行是更隐蔽的问题：比牌时把王整张摘掉，于是「10♠ + 王」只剩 1 张牌，
**牌少判负**，输给「10♠ + K♣」。

## 14.3 三个决定，用户拍板

| 问题 | 用户的选择 |
|---|---|
| 王能不能当 10 | **能，王 + K 也是十点半** |
| 同为十点半，含王 vs 含真 10 | **不看王，只比那张 10 的花色**（含王时王算花色最大） |
| 历史战绩里的 9.5 | **不重算，只影响新牌局** |

第二项有一个从选项里**推出来**的决定，我在动手前单独跟用户讲清了：
「比那张 10 的花色」+「王算花色最大」合起来 = **比牌时王永远算花色最大的一张**，
点数贡献照旧。不这样落不了地——否则「10♠ + 王」还是比不过「10♠ + K♣」。

## 14.4 改了哪三处

1. **`JOKER_TENHALF_CARDS` 放开 10。** 原来枚举候选牌时 `if (r === 10) continue`，
   现在 52 张全进。王 + J/Q/K 都能到 10.5。
2. **`tenHalfSideCards` 不再摘掉王。** 改成保留王，但把王换成「它解析后充当的那张牌」
   （点数按解析结果，花色走 `JOKER_SUIT_RANK = 5`，比四个真花色都大）。
   这样「王当的 10」压过任何真 10，「王只当半点」时的花色也最大。
3. **`tenthsOfRank()` 抽出来。** 因为比牌时入参可能是「王的替身」（`suit:'joker'`），
   不能再走 `tenHalfTenths()`——那会把王一律拍成 0.5。点数一律按 `rank` 算。

`JOKER_SUIT_RANK` 单独用常量而不是塞进 `SUIT_ORDER`：那张表被单张 / 飘三叶 / 斗牛共用，
把王塞进去会连带改掉那三种玩法。这是本轮唯一一处"看起来可以偷懒、实际会炸"的地方。

## 14.5 一处必须守住的边界：王不救更小的 10

改完第一版测试红了 4 条，全是同一个坑——**我给两边配了不同花色的 10**：

```
10♣ + 王  vs  10♠ + J♥   →  右边赢
```

这**不是** bug。规则是「先比那张 10 的花色」，10♠ > 10♣，王还没轮到出场就输了。
王只作用在第二步（同花色 10 之后，比那张半点牌）。

所以把测试改成同花色 10 才验得准，并且**专门留了一条反向断言**：

```
★ 王不救更小的 10：10♣ + 王 仍输 10♠ + J（先比 10 的花色）
```

不写这条的话，很容易被后来的人理解成"带王就无敌"，然后"修"出一个更错的东西。

## 14.6 顺带对齐的口径

| 位置 | 改动 |
|---|---|
| `engine.js` 文件头规则要点 | 「同点数比除王以外的牌，王不占便宜」→「王比 10 大」 |
| `engine.js` `TENHALF_MAX_WIN` 注释 | 「大王只当半点」→「含王撑出来的」 |
| `config.js` 同一条注释 | 同上 |
| `index.html` 引导第 3 步 | 「万能，但不能当 10」→「万能，能当 10，比真 10 大」 |
| `index.html` 规则弹窗 · 十点半 | 整条重写：王完全万能 + 王比 10 大 + 王当半点时花色也最大 |
| `index.html` 规则弹窗 · 大王段 | 「万能但不能当 10（只有配真 10 才到 10.5）」→「能当 10 且比真 10 大」 |
| `README.md` 分值表 | 「大王当半点」→「大王完全万能（能当 10，且王比真 10 大）」 |

服务端不需要单独改：`server/hub.js` 直接 `require` 前端同一份 `stateMachine.js`/`engine.js`
（双端同源），规则一改两边同时生效。

## 14.7 历史战绩为什么不用重算

`history` 里存的不是手牌，是**结算时算好的标签**（`typeName` = "9.5点"、`decider` = "K♣"）。
所以旧局打开回放还是 9.5，新局按新规则算。这正好对上用户选的「不重算」。

反过来说，如果哪天要重算，光改引擎是不够的——得把存量的 `typeName` 重新生成一遍，
那是另一件事（要迁移脚本、要处理已经被回放引用过的把次）。

## 14.8 数字

| 项 | 数值 |
|---|---|
| 改前 `王 + K` | 9.5 点，输给两门真 10 的十点半 |
| 改后 `王 + K` | **10.5 点**，且赢两门真 10 的十点半（收 4 / -2 / -2，与截图同构） |
| 能靠王凑出 10.5 的牌 | 4 张 → **16 张**（10/J/Q/K × 4 花色） |
| `npm test` | **62 文件 / 2165 项全通过** |
| `rules.test` | 50 项（原 45，新增 5 条，反转 8 条） |
| `engine.test` | 144 项 |
| `journey --with-wait` | 74 项 |
| `probe-records` | 20 项 |

## 14.9 发布状态：仍未发布

规则改完了，但和第十三章那批 UI 改动一起**都还没上线**：

- `pwa/index.html` 的 `app-version` 仍是 `20261029j`
- `pwa/sw.js` 的 `CACHE_NAME` 仍是 `'weile-liuxuanwu-v54'`

这次改动落在 `engine.js` 上，**服务端和客户端是同一份文件**，
所以发布后老客户端（缓存里的旧 engine.js）会算出 9.5、新客户端算出 10.5——
**同一局里两个人看到不同点数**。这是必须靠版本号一起推才能避免的错位，
不是"慢慢生效"的问题。所以发布时 `app-version` / `sw.js` / 13 处 `?v=`
必须一次性对齐。

# 十五、v57：斗牛的王「两处都能补」（2026-10-29）

## 15.1 用户原话

> 改成王可以不凑 10 允许满足剩下两张牌达成牛牛 但是最后比大小的时候 要拿除王外最大的牌比大小 不能拿王

附一张结算截图：玩家B `9♠ 9♦ 2♣ JOKER 3♣` 显示 **牛8 · 比 9♠ · -2**。

## 15.2 这手牌以前为什么是牛8

旧规则一句话是「王**只能**用来凑那三张」。落到代码里就是 `douNiuInfoJoker()`：
把王从手牌里摘掉，只拿剩下 4 张真牌枚举「哪两张剩下来」，牛型由那两张的和定，
其余两张 + 王自动算「凑成 10」——王被**强制**消耗在三张那一组。

于是 `9♠ 9♦ 2♣ 王 3♣`：

```
others = [9♠, 9♦, 2♣, 3♣]
枚举剩两张的六种组合，取最有利：
  9♠+9♦ = 18 → 牛8   ← 引擎选了这组
  2♣+3♣ = 5  → 牛5
  …
```

**牛8 是这么来的，不是渲染错。** 问题在于它算错了 —— 因为 `9+9+2 = 20` 本身就已经是
10 的倍数，这一组根本不需要王，王应该被留给剩下的两张。

## 15.3 什么叫「王两处都能补」

5 张牌 = 3 张成十 + 2 张定牛型。王只有一张，所以它只有两个位置：

| 王的位置 | 剩下的三张 | 牛型 |
|---|---|---|
| ① 在剩下的两张里 | **3 张真牌必须自己成十** | 王牌 + 1 张真牌，王补到 10 的倍数 → **必然牛牛** |
| ② 在三张里（旧规则唯一路径） | 2 张真牌 + 王 = 自动成十 | 剩下 2 张真牌的和的个位 |

关键是第 ① 行那个「必然牛牛」：王能取 1~10 任意点数，真牌点数是 `p`，
取 `w` 使 `(p + w) % 10 == 0` 总有解（p=10 时 w=10）。所以只要三张真牌能自己成十，
这手牌就是牛牛，没有第二种可能。

于是实现只有一句判断：**三张真牌能成十 → 牛牛；否则退回旧路径。**

```js
if (douNiuHasThreeTens(others)) {
  var niuniu = douNiuNiuOf(0);        // { niu: 0, type: 9, name: '牛牛' }
  niuniu.compareCards = others;
  return niuniu;
}
```

`douNiuHasThreeTens()` 是从 `douNiuInfoResolved()` 里原来那段三重循环抽出来的 ——
无王手牌用它判「有没有牛」，含王手牌用它判「王能不能不去凑十」，同一件事。

## 15.4 「比大小不能拿王」这条已经是现状

用户特别强调的这条，**上一版就已经是对的**：`douNiuSideCards()` 返回「去掉王的手牌」，
比牌材料（`compareCards`）就是它，`douNiuDecider()` 也从这里取最大。

所以这次没改比大小代码，但**补了一条会翻车的断言**：

```
王手（9♠ 最大）vs 无王牛牛（10♦ 最大）  →  必须输
```

如果哪天有人让王参与比大小，王的 `rank = 15` 会压过一切，这条立刻从 `< 0` 变成 `> 0`。
断言里写明了这层因果，免得后人以为可以随便简化。

## 15.5 一条必须守住的反例

改完要先证明「不是所有含王手牌都无条件变牛牛」。构造：`2, 5, 7, 9`

```
任意三张和 = 14 / 16 / 18 / 21   → 都不是 10 的倍数（① 不成立）
任意两张和 = 7 / 9 / 11 / 12 / 14 / 16 → 也都不是 10 的倍数（② 也到不了牛牛）
```

所以「王 + 2,5,7,9」必须是**牛9**。这条断言的价值：如果实现写成「含王就牛牛」，
它会红。**没有这条，一个明显错误的实现也能全绿通过。**

## 15.6 影响面：含王手牌的牛型分布

随机 3 万手（王 + 4 张真牌）统计：

| 牛型 | 改前 | 改后 |
|---|---|---|
| 牛牛 | 61.0% | **70.1%** |
| 牛9 | 21.5% | 16.3% |
| 牛8 | 9.8% | 7.4% |
| 牛7 | 4.3% | 3.2% |
| 牛6 及以下 | 3.4% | 3.0% |

只挪了 9 个百分点，比预想的小。原因是旧规则下王已经很宽（能补 1~10 任意点，
六种「剩哪两张」里挑最优），大部分含王手牌本来就摸得到牛牛。所以这不是一次平衡性地震。

## 15.7 截图那局的结算会变

按截图里三家真实牌面重算：

```
玩家B  9♠ 9♦ 2♣ 王 3♣   →  牛牛  比 9♠    ← 改前 牛8
玩家C    K♣ J♥ K♥ 6♣ 3♦   →  牛9   比 K♥
玩家D      6♦ 7♠ 7♣ 4♣ 5♠   →  牛9   比 7♠

结算：a +6 / b -3 / c -3      （截图里 a -2 / b +4 / c -2）
```

赢家从玩家C变成玩家B，因为牛牛 > 牛9。牛牛按 3 分/人算，两家就是 +6。

历史战绩不重算（沿用第十四章的决定）：`history` 里存的是结算时算好的 `typeName`，
旧局点回放还是「牛8」，新局按新规则走。

## 15.8 文案同步

| 位置 | 改动 |
|---|---|
| `index.html` 引导「大王很特别」第 4 条 | 「斗牛 → 只能去凑那三张」→「能凑十，也能凑牛牛」 |
| `index.html` 规则弹窗 · 斗牛 | 「大王只能用来凑那三张」→「两处都能补」，并写明「三张真牌自己成十时王补剩两张必成牛牛」 |
| `index.html` 规则弹窗 · 大王段 | 斗牛那句同上 |
| `README.md` | 新增「斗牛用王：两处都能补」一段 |
| `engine.js` 文件头 | 规则要点里斗牛那条重写 |

服务端不用单独改：`server/hub.js` 直接 require 前端同一份 `engine.js`（双端同源）。

## 15.9 数字

| 项 | 数值 |
|---|---|
| 截图那手 | 牛8 → **牛牛**（`compareCards` 仍是除王 4 张，决胜牌 9♠） |
| 含王手牌牛牛率 | 61.0% → **70.1%**（3 万手随机） |
| `npm test` | **62 文件 / 2174 项全通过**（+9） |
| `rules.test` | 57 项（原 50，+7：牛牛 / 牌型名 / 材料 4 张 / 决胜牌 / 反例 / 比大小 2 条） |
| `engine.test` | 146 项（+2） |
| `journey --with-wait` | 74 项 |
| `probe-records` | 20 项 |

## 15.10 发布状态：已发布（2026-10-29 17:5x）

三批改动一起上线：

1. 第十三章：整场回放 + 结算标「我」+ 排行榜看台
2. 第十四章：十点半「王比 10 大」
3. 本章：斗牛「王两处都能补」

`app-version` `20261029j` → **`k`**，`sw.js` `v54` → **`v55`**，14 处 `?v=` 同步
（比上次多一处：新增的 `sessionLog.js`）。核对结果见 15.11。

发布前的风险提示（已落实）：这两章都改的是**双端同源的 `engine.js`**，
版本号必须一次对齐 —— 否则同一局里老客户端算牛8、新客户端算牛牛，
**两个人看到不同的结算数字**。

## 15.11 发布核对（2026-10-29）

### ⚠️ 发布前抓到的一个真问题：预缓存漏了新文件

`sw.js` 的 `PRECACHE` 清单是**手写**的，加文件时必须手动补一条。
`/js/sessionLog.js` 是 v56 新建的，改了 `index.html` 的 `<script>` 却**忘了改清单**。

它不会崩 —— `game.js` 每个调用点都有 `typeof SessionLog === 'undefined'` 兜底 ——
但离线打开时 `SessionLog` 不存在，回放会**静默退化成「只能看单把」**。
而这恰恰是 v56 的核心功能。也就是说：**线上能跑、联网时也对，只有离线掉功能，
而且没有任何报错。** 这是最难自己发现的一类。

补了之后顺手把 `sw-precache.test.js` 的解析加固了：解析清单前先剥掉 `/* */` 和 `//` 注释。
起因是我在清单里加的说明注释写了一段 `typeof SessionLog === 'undefined'`，
带引号 —— 测试用 `/'[^']+'/g` 抓条目，把那段代码片段当成了第 29 条资源，
于是「每条都是绝对路径」无故变红。**这不是放松断言**：剥完注释之后，
每一条仍然必须是绝对路径。同时补了一条断言「`/js/sessionLog.js` 已收录」。

更重要的是**把「靠记性」换成了「对账」**：新增 `[6] 清单与磁盘对账`，直接读
`pwa/js/`、`pwa/css/` 目录逐个比对清单（`ai.js` 排除 —— 它只在 `server/hub.js` 里
require，前端根本不下载），再加一条反向断言，防止清单里留下已删/改名的手写路径。
反证做过：把 `/js/sessionLog.js` 从清单里删掉，精确红 2 条（`缺: sessionLog.js`），
恢复后全绿。删改后立刻比了一次 `sw.js` 的 md5，与线上完全一致 —— 确认恢复无损、无需重发。

### 五项核对

| 项 | 结果 |
|---|---|
| `/api/health` | `version` = `pwa` = **`20261029k`**；`uptime: 12`（真重启）；`server: 07:25:48Z` 与上一轮相同 —— **本轮没改 `server/*.js`，这是对的** |
| md5（10 个文件） | `index.html` / `sw.js` / `js/engine.js` / `js/game.js` / `js/sessionLog.js` / `js/records.js` / `js/stateMachine.js` / `js/config.js` / `css/style.css` / `css/records.css` **全部 OK** |
| `sw.js` | `CACHE_NAME = 'weile-liuxuanwu-v55'`，`PRECACHE` 28 条含 `/js/sessionLog.js` |
| gzip | `gzip` / **13146 B** / `Vary: Accept-Encoding`（上次 13042，多出 104 B 来自 sessionLog 的 script 标签与规则文案） |
| 牌桌三档线上 | 320×568 / 390×844 / 430×932 **退出码全 0**，`overflow` 全 0、`visibleRatio` 全 1 |

另外：

- `npm run backup` 拉了 **7 位玩家**（上次 3 位），净胜 102 / 26 / 17 / 3 / -38 / -49 / -61
- 发布后榜单数值完全一致，**未被发布覆盖**
- 发布时 `rooms: 0 / conns: 0`（没人正在玩），没有空房间靠超时清

### 回归数字

| 项 | 数值 |
|---|---|
| `npm test` | **62 文件 / 2179 项全通过**（改版本号后为 2175，加上清单对账 4 项） |
| `sw-precache.test` | 30 项（原 26，+4：js 对账 / 反向 / css 对账 / sessionLog 收录） |
| `journey --with-wait` | **74 项全通过** / 51.4s |
| `probe-table` 三档 | 全部退出码 0 |

# 十六、v58：整场回放为什么还是只有一把（2026-10-29）

## 16.1 用户报的原话

> 现在还是只能看到一把的记录 而且那局 这一把的过程 描述太蠢了 要改。

附一张回放截图：标题 `10-29 21:23 那局`，副标题 `这一把的过程`，内容只有「第 8 把」。

上一版（第十三章）刚做完「整场回放」，用户在真机上验证，结论是**没生效**。

## 16.2 先排除「没攒到」

最容易想到的解释是场次档案没攒到数据。所以第一件事是**在真浏览器里多打一把再看**。

原来的旅程脚本只打一把就解散——而**「整场」和「只攒到一把」在界面上长得一模一样**，
这正是这条 bug 能穿过 2179 项断言的原因。改法是在解散前多打一把：

```
第一把结束 → 自动开第二把 → 分牌 → 提交 → 结算
```

结果档案是好的：

```
{"hasSL":true,"inspect":[{"key":"857127#1793281225362","packs":2}],"rawLen":1433}
★ 两把都进了场次档案（服务端只有 2 把窗口，靠连续吸收攒齐）
```

**数据齐了，两把都在 localStorage 里。**

## 16.3 真因：战绩页把 sessionKey 弄丢了

继续走到「战绩页 → 点看回放」，界面仍然是：

```
{"title":"10-29 21:41 那局","sub":"这一把的过程","packs":1,"target":0}
```

档案明明有两把，`load()` 却没被调——因为 `openSavedReplay` 拿到的 `rec.sessionKey` 是空的，
于是退回单把 `rec.replay`。

问题在 `cloudRows()`。战绩页列表**不是**直接渲染本机记录，而是以云端流水为准、
再去本机记录里对本场回放：

```js
out.push({
  endedAt, myNet, playerCount, endReason,
  replay: (hit && hit.replay) || null      // ← 只搬了 replay
  // sessionKey / handId 没搬
});
```

云端只存流水（分数、局数、胜负），**回放从来不在服务端**。所以本机这条记录
是回放的唯一入口，而合并时只搬了「单把副本」`replay`、没搬「整场档案的钥匙」`sessionKey`。

结果就是：整场档案攒得好好的，永远打不开；每次都精准地退回最后一把，
连 `targetHand` 也没有（截图里 `target:0`，那把「你点的这把」也标不出来）。

**这类 bug 的特征：数据层全对，链路只差一个字段。**
单测测的是 `SessionLog.absorb/load`（都过），旅程测的是「打了多少把」
（只打一把测不出），中间那一层「云端行怎么和本机记录对齐」没人测。

## 16.4 改了什么

```js
sessionKey: (hit && hit.sessionKey) || '',
handId: (hit && hit.handId) || 0
```

两个字段。改完：

```
{"title":"10-29 21:43 这一局","sub":"整场 2 把","packs":2,"rounds":3,"target":1}
```

## 16.5 补了四条回归

| 断言 | 为什么必须有 |
|---|---|
| 两把都进了场次档案（`packs===2`） | 只打一把的旅程分辨不出「攒到了」和「没攒到」 |
| 回放里是整场两把（`packs===2`） | 真实数据走完整链路，不再靠播种 |
| 标题写「这一局」、副标题「整场 2 把」 | DOM 数量相同，靠文案区分「整场」与「单把兜底」 |
| 我点的那把被标出来（`target===1`） | `handId` 丢了不会有任何报错，只是不标 |

前两条在旅程里新加了一段「打完第一把先别散，再打一把」，旅程从 79 项涨到 86 项。

## 16.6 顺带修的：回放文案

用户说「这一把的过程 描述太蠢了」。原来看不出三层信息，只有一串名词：

| 位置 | 改前 | 改后 |
|---|---|---|
| 标题 | `10-29 21:23 那局` / `那一场` | `10-29 21:23 这一局` |
| 副标题（整场） | `共 8 把` | `整场 8 把` |
| 副标题（单把兜底） | `这一把的过程` | `只留下最后一把` |
| 每组标题 | `玩家A 赢（J♠）` | 自己赢的组直接写 **`我赢（J♠）`**，金色加粗 |
| 每把标题 | `第 8 把` | `第 8 把` + 右上角 **`我 +4`**（这把自己的进出） |

「只留下最后一把」是刻意改的：老记录确实只有一把，**要说出原因**，
否则用户会以为数据丢了——他这次就是这么以为的。

「我 +4」是把「这把赢没赢」从「要自己把四组 +2/-1 加起来」变成一眼可见。
`replayViews` 里顺手统计（`hasMe` / `myNet` 按每把累加各组的 delta）。

## 16.7 一个测试方法上的坑（不是产品问题）

加回放断言后，两条既有焦点断言变红了：

```
★ 关闭后焦点归还到「玩法规则」按钮  -> 当前焦点 #btn-replay-close
```

第一反应是「弹窗焦点归还有 bug」，其实是我用 `element.click()` 程序化打开——
**程序化 click 不会让按钮获得焦点**，而真人点会。于是 `showModalEl` 记下的归还目标是 null。
改成 `b.focus(); b.click()` 复现真实行为，两条立刻转绿。

期间还把自己的选择器写错了：按钮 id 是 `btn-replay-close`，我写成 `replay-close`，
`getElementById` 返回 null → 回放压根没关 → 焦点一直留在弹窗里。**报错信息里的
`#btn-replay-close` 就是线索**，只是先说成「焦点没归还」。

顺手把这两条加了进去（打开时焦点进弹窗 / 关闭后回到「看回放」按钮），
一共多 3 条断言。

## 16.8 README 重写

用户要求「简洁、清晰、易懂，只描述主要版本和重要功能，体现迭代，不要太技术化」。

原 README 是 482 行的运维手册（规则细则 / 账号实现 / 数据文件 / 管理后台 /
安全约束 / 目录 / 发布清单 / 环境变量 / 故障排查 / 前端速查）。这些是维护者需要的，
但不是打开这个文件的人想先看到的。

新版 **119 行**，五个部分：

1. 怎么玩（两轮表 + 分值表 + 大王在四种牌组里的身份）
2. 一场对局会怎么走（弃权 ≠ 弃局）
3. 界面上有什么（结算 / 战绩 / 回放 / 排行榜）
4. **迭代**（五个阶段，每阶段 3~5 条，只写「解决了什么」，不写怎么实现）
5. 跑起来（两条命令）

旧内容没有删掉——发布流程、数据位置、排查方法都在 `REVIEW.md` 里，
新版最后一行指过去。技术细节不该消失，只是不该挤在门面上。

## 16.9 数字

| 项 | 数值 |
|---|---|
| 根因修复 | `cloudRows()` 补 `sessionKey` + `handId` 两个字段 |
| README | 482 行 → **119 行** |
| `npm test` | **62 文件 / 2179 项全通过** |
| `journey` | **86 项全通过**（+7：多打一把 3 条、真实回放 4 条） |
| `probe-records` | 20 项全通过 |
| 档案实测 | 两把 1433 B（一场打散约 15 KB，仍在预算内） |

## 16.10 发布状态：**未发布**

改了 `pwa/js/game.js`（`cloudRows` + 回放文案）、`pwa/css/style.css`（净分与「我赢」配色）、
`pwa/js/sessionLog.js`（`describe` 文案）。`app-version` 仍是 `20261029k`，
`sw.js` 仍是 `v55`。

**这次必须发**：线上现在就是「只能看一把」的状态，不推版本号老客户端也不会自愈。

# 十七、v0.3：把数据搬进云服务（2026-10-29）

## 17.1 用户的请求与两个决定

> 请为应用「六选五」开启云服务，并完成现有代码的云服务接入。
> 请使用 cloud-service 技能和 workbuddy_cloud_service 工具，将应用现有的相关功能连接到真实云服务，并验证可用。

这个应用有一个特殊性必须先摆出来：**它已经有一整套自建后端**（`server/` 里的
HTTP + WebSocket + 账号 + 排行榜 + 管理后台，3330 行），线上有 7 位真实玩家。

所以我先问了两件事，用户答：

| 问题 | 用户的选择 |
|---|---|
| 云服务接入到哪一层 | **全部换到云服务** |
| 用哪种云登录 | **就采取已有的登录模式，不用云登录** |

这两个答案放一起是**互相冲突的**，这是本轮最关键的一次判断，见下一节。

## 17.2 冲突在哪：云数据库认的「身份」和我们的账号不是同一个

云数据库的行级安全靠 `auth.uid()`，而 `auth.uid()` 来自**云服务自己的登录态**
（`cloud.auth` 的那套 session）。这个应用的账号是「昵称 + 密码 + 服务端自签 token」，
在云数据库眼里它只是「匿名访问者」。

于是「数据全部上云」+「不用云登录」直接组合，只剩三种走法：

| 走法 | 评价 |
|---|---|
| 前端直连云数据库，表设成公开读写 | **否决**。publishableKey 在前端可见，等于谁都能读写全库，违反「用户数据必须隔离」 |
| 换掉自建账号，全员改用云登录 | **否决**。用户明确说不用云登录，而且会废掉现有 7 个账号 |
| **服务端独占访问云库** | 采用 |

第三种的具体形态：

```
浏览器 ──(自建 token)──▶ server/ ──(publishableKey)──▶ 云数据库
```

前端**完全不加载云 SDK**，`publishableKey` 只出现在 `server/` 目录；静态根是 `pwa/`，
外网取不到 `server/` 下的文件。玩家看到的还是昵称 + 密码，一步都没多。

安全边界因此变成：**服务端自己的 token 鉴权 + 每个查询都按 playerId 过滤**，
playerId 来自已验证的令牌，不来自请求参数。

### 必须先验证这条路的可行性

「服务端能不能跑云 SDK」不是想当然的事 —— 官方文档给的是浏览器 `<script>` 和
微信小程序两种形态，没有 Node。所以在写任何业务代码之前先做了一次探测：

```js
const cloud = createWorkBuddyCloud({ endpoint, publishableKey });
const r = await cloud.database.from('__probe_not_exist__').select('*').limit(1);
// → {"code":"DATABASE_PGRST205","message":"Could not find the table ... in the schema cache"}
```

**`PGRST205` 是关键信号**：请求真的到达了 PostgreSQL，只是表不存在。
如果是凭据问题会是 HTTP 401（`MISSING_CREDENTIALS`），那条路就走不通。
SDK 在 Node 22 下直接 `require` 就能用（CJS 入口自带），不需要 polyfill。

## 17.3 三张表

| 表 | 内容 | 关键约束 |
|---|---|---|
| `players` | 一人一行：账号凭据 + 累计统计 | 主键 `id`；`lower(account_name)` 唯一部分索引 |
| `match_results` | 一场一行：净胜、人数、结束原因 | `UNIQUE (player_id, room_id, hand_seq)` —— 幂等键 |
| `session_packs` | 一场一行：整场过程明细（JSONB） | 主键 `(player_id, session_key)` |

刻意分成三张而不是「一份大 JSON 塞一行」：分开才能在「重置战绩」时只清流水不动账号，
也才能让回放的同步和战绩的同步互不牵连。

`match_results` 那条唯一约束不是装饰：房间会重复广播结算，内存里靠 `_seen` 挡，
但进程重启后 `_seen` 就没了 —— 数据库这层才是真正兜底的。验证脚本专门测了这条
（同一场写两次，库里只留 1 行）。

## 17.4 首次迁移：云库为空时不能什么都不做

接进来的第一个真问题不是「怎么存」，是「**现有 7 位玩家怎么办**」。

云库刚开通是空的。如果启动逻辑写成「云有数据就用云的」，那 7 个账号会在上线那一刻
全部消失。所以 `_loadFromCloud()` 分三种情况：

| 情况 | 动作 |
|---|---|
| 云有数据 | 逐人合并（见 17.5） |
| 云为空、本地有数据 | **把本地整份推上去**（首次迁移） |
| 云不可用 | 保留本地数据继续跑，只记一条日志 |

第二行就是 7 位玩家从 `server/data/profiles.json` 迁到云库的路径。
实测结果：`持久化模式 = migrated`，云库 7 位玩家，账号名 / 密码哈希 / 盐 / 令牌版本
逐字段比对全部一致 —— 这一条如果错了，玩家第二天全部登不进来。

## 17.5 为什么是「逐人取较新」而不是「云覆盖本地」

云写是异步的。某一次写失败时，**本地文件反而比云新**。如果启动时无脑拿云覆盖，
就等于把那次没写上去的战绩悄悄回滚了 —— 玩家会觉得「我打赢的那局不见了」。

所以逐个玩家比 `updatedAt`，取较新的一份；再把本地独有（上次推送漏掉的）补进来。

补完之后如果确实取了本地版本，还要**主动推一次云**（`needPush`），
否则云端会一直落后到下一次有人打出结果为止。而「云端落后」正是这个项目
最不想再看到的状态 —— 前面几轮修的「只能看一把」「战绩回退了」都是这一类。

## 17.6 回放：从 localStorage 到云端

这一块是用户抱怨过最多次的地方（第十三、十六章都在修它）。上云的具体做法：

- 服务端加 `GET/POST /api/me/sessions`，数据落 `session_packs`。
- 前端 `absorbHistory()` 攒到**新把次**时才起一个 2 秒的合批定时器，
  到点把整场重传一次。
- 打开战绩页时 `pullCloudSessions()` 把云端的场次 `absorb` 回本地，
  **按「第几把」幂等**，所以重复拉不会出现重复行。

三个刻意的取舍：

1. **整场重传，不做增量 diff。** 一场约 15 KB，新把次才传一次，
   做 diff 的复杂度换不来什么。
2. **延迟 2 秒合批。** 房间广播很密（出牌、倒计时、聊天都在推），
   每来一次就传整场等于拿玩家的流量做全量备份。
3. **本地是主、云是备份。** 先写 localStorage 再异步推云 ——
   推失败最多丢云上那份，本机永远最新，对局也不会被网络抖动拖慢。

边界照旧：只覆盖**你在线期间**的把次。中途加入看不到之前那几把，
因为那些数据客户端本来就没收到过。

## 17.7 抓到的真 bug：建表漏了两列

第一次跑验证脚本，结果是：

```
[cloud] savePlayers: Could not find the 'account_created_at' column of 'players' in the schema cache
持久化模式 = offline
★ 云库里的玩家数 ≥ 本地种子   ✗  {"cloud":0,"seed":7}
```

建表时漏了 `account_created_at` / `account_last_login_at` 两列，
upsert 整批失败，**7 位玩家一个都没上去**，而表面上服务还能跑（降级成本地模式）。

这正是「验证脚本必须先写」的理由：如果不写，发布后服务启动、日志里一行 `[cloud]` 错误、
每个人照常能玩，**但数据一直没上云**。等到哪天容器重建才会发现，而那时已经晚了。

补列之后 16 项全绿。

## 17.8 测试隔离：本地脚本绝不能连云

云库是生产数据。本地跑旅途脚本会注册测试账号、打测试局，如果不拦住，
真实排行榜边上就会多出一堆 `测试玩家`。

四处 `spawn` 服务的脚本（`journey` / `probe-leave` / `probe-multi-tab` / `probe-table`）
全部注入 `LXW_CLOUD: 'off'`；`scripts/run-tests.js` 也统一设了一次，
因为单测里会 `createAccount` / `reset()`，连上去就是把测试账号灌进真实库。

反过来，**线上默认必须开启**（没有任何地方能保证注入环境变量），
所以开关的默认值是 on，靠显式 `off` 关闭。

## 17.9 「重置战绩」必须连云端回放一起清

原来的 `resetStatsOf()` 只清内存与本地文件。上云之后如果只清聚合值，
云端 `match_results` 和 `session_packs` 还在，下次启动重建 recent，
**战绩又回来了**——用户点「删除我的数据」，重启后又活了，等于没删。

所以三处删除都补了对应的云端删除：`resetStatsOf` / `resetStats` / `reset` / `remove`。

`clearAll` 里的「清空全表」用 `neq('id', 0)` 表达而不是无 WHERE 的 delete：
PostgREST 本来就拒绝无条件全表删除，顺带留了一道「必须显式写条件」的护栏。

## 17.10 验证（可复跑）

```bash
npm run verify:cloud
```

两组，都是真连库、真起服务：

| 脚本 | 验什么 | 项数 |
|---|---|---|
| `verify-cloud.js` | 数据层：连通性 / 首次迁移 / 重启读回 / 凭据往返 / 流水幂等 / 删除 | 16 |
| `verify-cloud-api.js` | 接口层：注册即上云 / 回放上传 / 换设备读回 / 未登录 401 / 删号清理 | 14 |

第二组会注册一个 `lcp` 前缀的临时账号，跑完立刻删掉，并回查三张表确认清干净
（`players` / `match_results` / `session_packs` 都为空）。

跑完云库的最终状态：**players 7 / match_results 0 / session_packs 0** ——
7 位真实玩家，没有测试残留。

## 17.11 数字

| 项 | 数值 |
|---|---|
| 新增服务端模块 | `server/cloudStore.js`（约 300 行） |
| 新增表 | 3 张（`players` / `match_results` / `session_packs`），RLS 全开 |
| 新增接口 | `GET/POST /api/me/sessions` |
| 改动文件 | `profile.js`（加载/落盘/四处删除）、`index.js`（启动顺序 + 路由）、`game.js`（同步）、`authStore.js`（暴露 request） |
| 迁移结果 | 7 位玩家，账号凭据逐字段一致 |
| `npm test` | **62 文件 / 2179 项全通过** |
| `journey --with-wait` | **88 项全通过** |
| `npm run verify:cloud` | **16 + 14 项全通过** |

## 17.12 安全边界：一条必须说清的让步

「玩家不用云登录」换来的代价是：服务端请求云库时是 `anon` 角色，
所以数据库的 RLS 策略对 `anon` 是放开的（`USING (true)`）。

**这意味着一旦 `publishableKey` 泄漏，拿到它的人可以读写整个库。**

当前的可控点：

- `publishableKey` 只在 `server/` 下，`pwa/` 是静态根，外网取不到 `server/` 的文件。
- 日志里不打印它。
- 数据隔离由服务端保证：每个查询都按从令牌解出的 playerId 过滤。

加固路径（本轮**没有做**，需要一次人工收验证码）：

给服务端配一个真实的云账号，用 `signInWithPassword` 拿 `authenticated` 角色，
再把 RLS 收到「只允许该账号」。那样 publishableKey 单独泄漏就不足以打开全库。
这属于后续增强，已记在下一节。

## 17.13 仍未做

- **服务端云账号加固**（见 17.12）：需要人工收一次验证码，没做。
- **回放的老数据没有回填**：上云之前攒在别人浏览器里的场次，只有那台设备再打开一次
  战绩页才会推上去。已经没有的设备上看不到，这个数据本来也只存在于那台设备。
- **多人房的过程数据没有服务端累计**：现在仍然是「每个客户端各自攒自己的」。
  服务端其实看得到完整历史，让它统一攒能解决「中途加入看不到前面几把」，
  但那会改动房间广播路径，风险不匹配本轮收益。
- **没有做「删除我的数据」时的云端二次确认**：沿用原有的确认弹窗，未额外加云端状态提示。

## 17.14 发布状态：**未发布**

云服务已激活（`billingStatus=normal` / `provisionStatus=assigned`），
但**代码还没有部署**：线上跑的还是接云之前的版本。

`app-version` 仍是 `20261029k`，`sw.js` 仍是 `v55`，13 处 `?v=` 未动。

发布时注意两点：

1. 这轮改了 `server/*.js`（服务端）和 `pwa/js/game.js`、`pwa/js/authStore.js`（前端），
   **前后端要一起发**。只发一边的表现是：前端在推 `/api/me/sessions`，服务端没有这个路由 → 404。
2. `package.json` 现在有运行时依赖（`@tencent-ai/workbuddy-cloud-sdk`），
   发布要带上 `node_modules` 或让部署环境装依赖，否则服务端起不来。

# 十八、v0.3 回退：把云服务撤下来（2026-10-29）

## 18.1 触发

第十七章交付后，用户判断「云服务不完整」，要求**先评估、不直接动手**，
评估完再决定是否回退。评估结论是「可以退、且对玩家零影响」，用户选择：

| 问题 | 选择 |
|---|---|
| 怎么退 | **先提交云代码存档，再彻底回退** |
| 云端 7 行数据 | **导出备份后清空** |

## 18.2 评估阶段查到的三件事

| 核查项 | 实测 | 意义 |
|---|---|---|
| 线上 `/api/me/sessions` | **HTTP 404** | 云代码从未部署。线上跑的一直是 v56 |
| 线上版本 | `20261029k` / `sw v55` | 与 17.14 记录一致，没有意外上线 |
| 云库行数 | `players 7 / match_results 0 / session_packs 0` | 只有账号快照，无流水 |

再逐人比对云端与 `server/data/profiles.json`：7 位玩家的 `games / wins / totalNet`
完全一致。**云端没有任何「只在云上、本地没有」的数据** —— 清空不会丢东西。

## 18.3 「不完整」具体是哪六条

1. 服务端在云库眼里是 `anon`，没有真实云账号 → RLS 无法按人隔离。
2. 因此 RLS 对 `anon` 全开：用 `publishableKey` 能**直接读出 7 个账号的
   `password_hash` + `password_salt`**（评估时实测到了）。scrypt 不易破，
   但这不该是公开可读的。
3. 回放仍是「本机为主、云做备份」：换设备只能看到已经推上去的场次，老档案不回填。
4. 多人房过程数据仍各自攒：中途加入看不到前面几把（云没解决这条）。
5. 只用了数据库一个模块，云登录与云存储完全没用。
6. 未发布，所以以上都还没生效。

## 18.4 回退能力边界：云环境关不掉

`workbuddy_cloud_service` 只有 `inspect` / `activate` 两个动作，**没有下线能力**。
所以严格说不是「回到开启云服务前」，而是「回到代码不使用云服务」：

```
云环境 wbapp_aRP2Ax752DwzlnMeUDQ04H  —— 仍然 ACTIVE（billingStatus=normal），挂着不用
代码                                 —— 完全回到 v56，零云引用
云端数据                             —— 三张表清空
```

## 18.5 执行步骤

**第一步：存档**。工作区里混着两批未提交改动，直接 `git checkout` 会毁掉已上线的 v56
（整场回放修复、README 重写、大王规则）。所以先整份提交成一个存档点 `c69f907`，
commit message 里写清哪部分是已上线的、哪部分是未发布的。

**第二步：导出**。三张表全量落 JSON（7 行 players + 0 流水），确认文件有效后清库。

**第三步：精确撤销**。按「文件是否纯云改动」分两类处理：

| 类型 | 文件 | 做法 |
|---|---|---|
| 纯云改动 | `server/index.js`、`server/profile.js`、`pwa/js/authStore.js`、`package.json`、`run-tests.js`、三个探针脚本 | `git checkout c7ffb24 --` 整文件回退 |
| 混合改动 | `pwa/js/game.js`（v56 回放 + 云同步）、`scripts/journey.js`（v56 第二把 + `LXW_CLOUD`） | 手工剥离云的 3 处 / 2 行 |
| 删除 | `server/cloudStore.js`、`verify-cloud.js`、`verify-cloud-api.js`、`package-lock.json`、`node_modules` | 直接删 |

`game.js` 里要分清两个容易混的名字：`cloudRecords` / `loadCloudRecords`
是**早就有的**服务端战绩窗口接口（保留），`pullCloudSessions` / `scheduleSessionPush`
才是这次新加的云数据库同步（删除）。

**第四步：清库**。`cloudStore.js` 已删、`node_modules` 已删，所以临时装回 SDK、
从存档 commit 取出 `cloudStore.js` 放到临时目录跑 `clearAll()`，跑完二者一起删。

## 18.6 验证

| 项 | 结果 |
|---|---|
| 六个改动文件 `node --check` | 全 OK |
| `npm test` | **62 文件 / 2179 项全通过**（与接云时同一数字） |
| `journey --with-wait` | **88 项全通过** |
| 云库回查 | `players 0 / match_results 0 / session_packs 0` |
| 本地档案 | 7 位玩家完好，未被动过 |
| 代码残留扫描 | `LXW_CLOUD` / `cloudStore` / `wbpk_` / SDK 依赖，零命中 |

那 2179 项和 88 项不是走过场：它们证明**撤掉云之后功能一项没少**，
包括 v56 的整场回放——用户最初抱怨的「只能看一把」仍然修好了。

## 18.7 怎么恢复

```bash
git revert <本回退 commit>    # 云代码、依赖、迁移逻辑一并回来
```

恢复后仍需面对 17.12 那条让步。**正确的补法是先给服务端配真实云账号、
把 RLS 收紧到只允许该账号，再发布**——而不是直接部署现在的存档版本。

## 18.8 这一轮学到的

- **「未发布」是最大的安全垫**。所有改动一行没上过线，所以回退的用户影响是零，
  评估里那句「对玩家零影响」是可以拿证据说的，不是安慰。
- **半成品最危险的地方不是不完整，是会被误带上线**。云代码散在 `pwa/`（推云）
  和 `server/`（落库）两侧，下次发 v57 时只发前端是静默 404、一起发就带着全开的 RLS 上线。
  这是决定「不留着」而不是「先放着」的主要原因。
- **存档先于回退**。这批代码从没提交过，`git checkout` 等于永久删除。
  先 commit 再撤，才谈得上「将来能恢复」。
- 评估时最该先查的不是代码，是**线上到底跑的是什么**——一条 404 就把
  「要不要回退、影响多大」这两个问题全答了。

## 18.9 云服务到底怎么「关」

这个问题迟早还会被问一次，所以把能关的和不能关的分层写清。

| 层 | 能不能关 | 结论 |
|---|---|---|
| 代码 | ✅ 已关 | `cloudStore` / `LXW_CLOUD` / `wbpk_` / SDK 依赖零命中，`node_modules` 已删 |
| 云环境 | ⚠️ **只能不用，不能关** | `workbuddy_cloud_service` 只有 `inspect` / `activate`，**没有下线动作** |
| 发布 | ✅ 无需操作 | 代码里没有云调用，发出去的应用自然不会连 |

官方文档（《网站应用开发与发布》《云服务》）给出的处置只有两条，且都不适合这个项目：

| 操作 | 后果 | 能用吗 |
|---|---|---|
| **下线应用** | 原链接打不开，应用与云数据都保留 | ❌ 等于停站 |
| **删除应用** | 关联数据、文件、注册用户一并删除，**不可恢复** | ❌ **绝对不要**——`applicationId` 与 `liuxuanwu.app.workbuddy.host` 一并作废，等于把线上站点删了，7 位玩家的链接立刻失效 |

**没有「暂停云服务」这个开关。** 所以正确姿势是「保持空库 + 零调用」：

- 三张表清空后，账号的 `password_hash` / `salt` 已不在云上，没有数据可读；
- 资源点按实际读写消耗，零调用不产生数据读写；
- `billingStatus=normal` 是「计费状态正常」，不是「正在扣费」。

一个**不要碰**的文件：项目根的 `.wbapp_aRP2Ax752DwzlnMeUDQ04H.genie`。
它只是本地标识（appId / 名称 / 目录），已被 `.gitignore` 排除、不进 git、不影响发布内容；
但发布时要靠它复用同一个 `applicationId`，删了会分到新域名，玩家手上的链接就变了。

## 18.10 发布前自检（云是否彻底脱开）

```bash
# 1. 代码层零引用（应无输出）
grep -rn "cloudStore\|LXW_CLOUD\|wbpk_\|workbuddy-cloud-sdk" \
  --include="*.js" --include="*.json" pwa/ server/ scripts/ package.json

# 2. 零运行时依赖（应无 dependencies 字段）
grep -A3 '"dependencies"' package.json

# 3. 没有 node_modules
ls node_modules 2>/dev/null || echo "无 node_modules"

# 4. 线上不存在云接口（应 404；若是 401 说明云代码被带上线了）
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://liuxuanwu.app.workbuddy.host/api/me/sessions?sharecode=<code>"
```

第 4 条是**唯一能证明线上真实状态**的检查，前三条只说明本地干净。


---

# 第 19 章 · 全量走查（v56，2026-10-29）

用户要求按六个维度逐项深度核查：代码 Review / 测试场景完整性 / UI 一致性 / 交互合理性 / 打分更新 / P0-P1-P2 规划。

**这一轮的重点不在「再加什么」，而在「同一件事有没有两种说法」。**
第 11~18 章修的都是「会不会坏」，这一轮查的是「坏了没有、但看着别扭」——
后者的特点是：不报错、不掉数据、测试全绿，只有真按玩家的手点一遍才会露出来。

## 19.1 七条发现，全部已修

### P10-1　战绩里写「解散结束」，而入口气叫「结束本局」✅ 已修复

`game.js` 的 `END_REASON_TEXT.dissolve` 是「解散结束」，这是**全仓唯一残留的用户可见「解散」二字**。

入口早在 v53 就改口了（`index.html` 那句注释写得很清楚：「它不会把房间散掉，只是这一局作废进结算，
房间号还在、大家还能开下一局。叫『解散』会让人以为点完就散伙了」），但战绩页每条结束记录都还在说「解散」。
玩家点完「结束本局」，去战绩里一看写的是「解散结束」，第一反应是「我是不是把房间搞散了」。

改成 **「提前结束」**，和「分数见底结束」「有人离开结束」并列成三条同级原因。
没写「房主结束本局」的两个理由：房主中途会移交（`next-round.test.js:103` 有断言），
事后写「房主」未必是当时那个人；而且这一行和净胜分同排，6 个字会挤。

### P10-2　就位态想看一眼上局分数，代价是撤回报名 ✅ 已修复（新增只读弹窗）

这是本轮最实质的一条。就位态（点了「开始下一局」、人在房间页等别人）座位表上的分数显示的是 `—`，
想看自己上局拿了几分，唯一的办法是点「回结算页」，而那颗按钮走的是：

```js
var restore = pressBusy($('#btn-next-back'), '撤回中…');
var res = await RoomStore.unWantNext(state.roomId, state.myId);
```

**它真的会撤回报名。** 后果：4 人局刚结束，3 个人已就位，第 4 个人瞄一眼分数 → 报名被撤回 →
那 3 个人的「全员准备」自动失效。他看完还得记得再点一次；要是看完直接锁屏，这局就开不起来。

修法不是「加一个战绩入口」（空间上塞不进 `ghost-row`，那里现在 3 个按钮各 200px，
加第 4 个要挤到 148px，「补 AI 队友」得缩字），而是加一颗**只读**胶囊「上一局结算」，
和已有的「看上一局过程」并排：

- 弹窗叠加层，不碰 `wantNext`、不发任何请求、广播回来也不会被顶掉；
- 渲染复用 `settleListEl` / `settleReasonText`，和结算页逐字一致（不各画一套）；
- 点里面的玩家行照样能开档案卡（结算页能点，这里凭什么不能点）。

配套改了 4 处：`MODAL_ORDER` 登记、Esc 关闭、`prev-result.test.js`（58 项）、`probe-prev-result.js` 真浏览器量测。

### P10-3　`recordSettled` 在 `render()` 里，而 `render()` 会早退 ✅ 已加固

`render()` 开头有一行 `if (state.screen === 'records' || 'rank' || 'auth') return;`，
而本机战绩的写入（`recordSettled`）原本在这行之后。同一个文件里 `absorbHistory` 早就被挪到了
订阅回调里，并留了注释解释为什么，`recordSettled` 没跟上。

**复核后要修正自己的判断**：`openRecords` 只有首页和结算页两个入口，`openRank` 只有首页一个，
对局中根本进不去这两页 —— 所以**当前不漏记**。这是结构性脆弱点，不是活动 bug。

仍然加固了（一行、幂等、零风险），因为它消掉一处「注释说必须无条件执行、实际执行点在早退之后」的自相矛盾：

```js
function absorbRoom(r) { absorbHistory(r); recordSettled(r); }   // 两件事都幂等
```

顺带补上了「刷新时正好停在结算页」那条路径 —— 首次 `attachRoom` 直接带房间进来，
没有订阅回包可等，现在也收一次。

### P10-4　净胜 0 在结算页是红色，在排行榜是灰色 ✅ 已统一

代码里早就有正确答案：

```js
function netCls(n) { if (n > 0) return 'up'; if (n < 0) return 'down'; return 'flat'; }
```

战绩卡、玩家档案、排行榜**全都用它**，0 是中性灰。只有结算行写的是 `net >= 0 ? 'pos' : 'neg'`，
把 0 归进了「赢」那一档。同一份数据、同一个概念，三个页面两种颜色。

改用 `netCls` / `netText`（`netText(0)` = `'0'`，不是 `'+0'`），补 `.settle-net.up/.down/.flat` 三态。

### P10-5　冠军行两个奖牌挤在一起 ✅ 已修

头像右上角一颗 🏆（`.crown`），名字前又一个 🥇。去掉名字前那个 —— 头像已经在说「冠军」了，
一排两个奖牌只会让人分不清哪个是名次、哪个是身份。

### P10-6　结算页点「离开房间」没有任何反馈 ✅ 已修

三个「离开」入口共用一个 `onLeave`，而选忙碌态按钮的逻辑是按 phase 猜的：

```js
if (state.room.phase !== StateMachine.PHASE.WAITING) btn = $('#btn-leave-game') || $('#btn-leave');
```

`#btn-leave-game` 在 DOM 里**始终存在**，只是被父容器 `display:none`。而结算页和就位态都是 `SETTLED`，
所以人在结算页时猜出来的是对局页那颗 —— 忙碌态加到一个看不见的按钮上，玩家点的那个一点反应都没有，
于是再点一次，被连点短路静默吞掉（请求没重发，人已经困惑了）。

改成按可见性选：`firstShown(['btn-leave', 'btn-leave-game', 'btn-back-room'])`，
判据是祖先链上有没有 `.hidden`（只判元素自己的 class 不够）。

### P10-7　同一个动作两个名字：对局页叫「离开」，另两处叫「离开房间」✅ 已统一

统一成「离开房间」。实测对局页底部一行放得下：`再选 6 张牌` 170px / `结束本局` 81px / `离开房间` 81px，
`rowOverflow: 0`，无文字裁切。

## 19.2 两条「看着像问题、量完不是」的，一并记下来

写进这里是因为**它们差点被我当成缺陷报上去**，而判据只能是数据、不能是截图。

**① 冠军行昵称「看着只剩半个字」。** 缩放后的截图上确实像被头像压住了。
实测：`name.textContent = "小王"`、`scrollWidth === clientWidth`（没截断）、
`rank.right=96 < name.left=101`（没重叠）、`name.color = rgb(245,240,230)` 压在金色渐变上对比度约 **5.4:1**（AA 达标）。
结论：**没问题**，是缩放看图的错觉。

**② `onLeave` / `onProposeDissolve` 的防连点被测试漏检。** `ui.test.js` 的断言写死了
`pressBusy($('#btn-xxx'))` 这个字符串形式，而这两处是**拿变量传**的（`pressBusy(btn, ...)`）。
代码是对的，断言扫不到。补了按函数体检查的两条，谁把 `pressBusy` 删掉现在会红。

## 19.3 数字

| 项 | 结果 |
|---|---|
| `npm test` | **65 文件 / 2363 项 / 0 FAIL / 58.0s**（上一轮基线 64 文件 / 2290 项） |
| 新增测试文件 | `pwa/test/prev-result.test.js`（58 项） |
| 新增断言（既有文件） | `ui.test.js` +6、`modal-a11y.test.js` +5（弹窗数 12→13） |
| 新增探针 | `scripts/probe-prev-result.js`：真 Edge + CDP，量胶囊行 / 弹窗盒模型 / 对局页按钮行 |
| `npm run audit:comments` | 硬性问题 **0**，扫描 100 个文件 |
| 版本 | `20261029n` / `sw v58` |

探针抓到两条**静态断言抓不到**的问题，都在实现过程中修掉了：

- 弹窗里重播结算页的错峰入场（每行延迟 0.15s）—— 4 个人要等 0.65s 才看全，点开先看到一片空白，像卡了。
  回看是查数据，不需要揭晓仪式，`animation: none`。
- 冠军行头像 72px 压在名字上 —— `.settle-row` 的第一列被我收到 56px，但 `.settle-rank.champion-rank`
  是定宽 72px 的圆，列比它窄就直接溢出去。这类问题**不报错、不截断、只盖住**，只能量矩形。

## 19.4 分维度评分

| 维度 | v55 | v56 | 依据 |
|---|---|---|---|
| 交互合理性 | 8.5 | **8.9** | 就位态「看一眼数据要付撤回报名的代价」和「结算页离开无反馈」都是真错，且都在高频路径上 |
| UI 一致性 | 8.3 | **8.8** | 净胜 0 两套颜色、结束原因两套叫法、同一动作两个名字 —— 三条都是「同一件事两种说法」 |
| 产品完成度 | 8.8 | **9.0** | 上一局结算从「必须撤回报名才能看」变成随手可看，且不改任何状态 |
| 代码质量 | 9.5 | **9.5** | 加固了 `recordSettled` 的位置矛盾；新增的弹窗严格复用结算页渲染，没有第二份实现 |
| 测试覆盖 | 9.2 | **9.3** | +58 项新功能断言 +6 项补漏检；两个变量传参的防连点终于有人守 |
| 其余（规则/安全/增长/性能/离线性/文档） | — | 不变 | 本轮没动这些 |

**加权：8.9 → 9.1。**

涨 0.2 而不是更多的原因：这七条里没有一条会让人丢数据或算错分，
它们全是「功能对了，但说法和反馈跟不上」。真正把分数压住的仍然是那几条老账
（一人多开的物理瓶颈、观战未做、P4-1 系列）。

## 19.5 P0 / P1 / P2 规划

本轮之后，**P0 为零**。以下按「值不值得占用你的时间」排。

### P0（阻断级）—— 无

连续三轮走查没有新增 P0。当前代码在「不丢数据、不算错分、不把房间卡死」这三件事上是干净的。

### P1（重要体验缺陷）—— 建议本周内

| # | 问题 | 现状 | 成本 |
|---|---|---|---|
| P4-1 | 切后台回来最长 60s 桌面冻住 | 未修（第 10 章留档） | **3 行**，性价比最高的一条 |
| P3-6 | 观战模式 | 有意推迟 | 大（37 处 `state.myId` 的 null 分支 + 无测试覆盖） |

### P2（体验优化）—— 按手感排

| # | 问题 | 说明 |
|---|---|---|
| P10-8 | 战绩页结束原因只有文字，看不出「这一局打了多久 / 几把」 | 数据都在 `room` 里，只是没展示 |
| P10-9 | 弹窗内玩家行点开档案后，返回时弹窗仍开着但没有焦点归还提示 | 焦点逻辑已对，缺一个视觉锚点 |
| P10-10 | 排行榜与战绩页的「我」高亮用了两种语言（描边 vs 胶囊） | 战绩页已是胶囊，排行榜仍是描边 |
| P10-11 | `animateScore` 在分数没变时也闪一次红色（`to >= from` 判 pos） | 静态分值不会变，只有动画期间闪一下 |

## 19.6 仍未做（明确写下来，避免下次误以为已覆盖）

1. **没有重读全部 15701 行源码。** 本轮是在 v55 已验证的基础上做的定向走查，
   重点在第 1（局部）、3、4、6 维度。第 2 维度只核了「关键场景有没有断言」，
   没有做「每个分支都跑一遍」的穷举。
2. **多人（3 人以上）真实对局的交互没在真浏览器里点过。** 探针用的是注入场景，
   覆盖布局与盒模型，不覆盖「4 个人同时点准备」这类时序。
3. **横竖屏切换只做了静态核查**（`orientation: "any"` + 三模式缩放的既有测试），
   本轮没在真设备上转屏验证新加的弹窗。

---

# 第 20 章 · 战绩与档案统一成「账号」口径（v59，2026-10-30）

## 20.1 用户原话

> 我的战绩和点击头像查询的云端档案现在各自独立，但从一致性角度来讲，我希望这两套数据都来源于云端，
> 是否可行，如果可以，去掉相关的「云端档案」「本机独立」等相关文字描述，要采用更标准、更易懂、更简洁的描述。

## 20.2 结论：可行，而且**早就是同一份数据**了

先把链路摊开，不靠印象答这个问题：

| 入口 | 通道 | 服务端落点 | 返回 |
|---|---|---|---|
| 「我的战绩」页 | HTTP `GET /api/me/records`（`server/index.js`） | `profiles.getSelf(pid)` | `_public(p, true, 20)`，流水 20 条 |
| 点头像 / 座位卡 / 排行榜 / 结束页玩家行 | WS `getProfile`（`server/hub.js` → `profile.js`） | `profiles.getProfile(pid)` | `_public(p, true)`，别人流水 5 条 |

两边读的是**同一个 `profiles.json`、同一个 playerId、同一套计数**（games / wins / totalNet / 最长连胜…）。
所以不存在「两套数据需要同步」这件事——差异性只来自两个**取数细节**：

1. **通道不同**：战绩页用 HTTP，因为从首页就能打开，那时可能压根没有活着的 WebSocket 长连接；
   档案卡只能从房间/榜单里点开，那里一定有活连接。
2. **流水条数不同**：自己 20 条，别人 5 条。`recent` 里带 `roomId` 和逐场净胜，给多了等于把别人的账本抄出去；
   自己看自己没这个顾虑（详见 `profile.js` 里 `getSelf` 的注释）。

**所以这一轮没有任何数据层改动**，改的只是说法：既然只有一份数据，界面上所有「云端档案 / 本机记录 /
两套独立」的解释都是在描述一个已经不存在的架构。留着它们，玩家会以为「换个地方看就不一样」。

## 20.3 改了什么：口径统一到「账号」

替换原则：**说清「存哪儿」和「换设备会怎样」，不说「怎么实现的」。**

| 位置 | 改前 | 改后 |
|---|---|---|
| 战绩页页脚（已登录） | 云端战绩 · 与排行榜同一份数据 | 已保存到账号 · 换设备也在 |
| 战绩页页脚（登录但读取失败） | 云端读取失败，暂用本机记录 | 账号数据暂时读不到，先显示这台设备上的记录 |
| 战绩页页脚（未登录） | 本机记录，换设备或清缓存会丢失 | 只在这台设备上，换设备会丢 |
| 战绩页空态（已登录） | 打完一局自动记下，云端会一直留着 | 打完一局自动记下，换设备也在 |
| 战绩页空态（其他） | 当前浏览器不支持本机记录 | 当前浏览器无法保存战绩 |
| 清除弹窗选项 | 同时清除云端战绩（排行榜会一起归零） | 同时清除账号里的战绩（排行榜会一起归零） |
| 清除成功（仅本机） | 本机记录已清除 | 已清除这台设备上的记录 |
| 清除失败 | 当前环境不支持清除云端战绩 / 云端战绩清除失败 | 当前环境不支持清除账号战绩 / 清除失败，请稍后重试 |
| 档案卡来源标签 | 云端档案 · 与本机战绩独立 | 已保存到账号 |
| 档案卡底注 | 云端档案跟着账号走，与本机「我的战绩」各自独立 · 换设备也在 | 看自己：战绩跟着**你的**账号走，换设备也在。<br>看别人：只读查看，战绩保存在**对方**账号里。 |
| 退出登录确认 | 战绩会留在云端，下次用账号密码登录就能拿回来 | 战绩留在账号里，下次登录就能拿回来 |
| AI 玩家提示 | 这是 AI 玩家，没有云端档案 | AI 玩家没有战绩 |

「本机」没有一律删干净，而是**只在它真的是本机的时候说**：未登录、或账号数据读不到时，
页脚必须说清「只在这台设备上」——那不是实现细节，是数据可能丢的风险，属于必须说明的信息。

代码注释同步改了口径（`game.js` 三处、`index.html` 两处），避免下一轮读注释的人又被「两套独立」误导。

## 20.4 顺手抓到的一处真错

档案卡底注原来只有一句「战绩跟着账号走，换设备也在」。这句话**看别人的卡是错的**——
玩家换不换设备跟别人没关系，读起来像在劝他自己换机。

改成按 `profile.playerId === state.myId` 分两种说法（`_public` 返回里带 `playerId`，判据稳定）。
这是文案从「一句话糊住两种情况」拆成「两种情况各说一句」，不是为了丰富措辞。

## 20.5 验证

| 项 | 结果 |
|---|---|
| `npm test` | **67 文件 / 2413 项 / 0 FAIL / 58.5s** |
| `scripts/probe-records-cloud.js` | **39 项全 PASS**（真 Edge + CDP，390×844 手机视口） |
| 截图核对 | 数据态 / 清除弹窗 / 清空态 / 登出态 各一张，页脚两行文案都在框内、无裁切 |
| 版本 | `20261030a` / `sw v59` |

探针这一轮新增 3 条断言（横向溢出 / 屏左边缘 / 横向位移），起因是数据态截图看着「整屏右移、右边被切」——
一量才发现 `screenLeft = 63px`，而 `docScrollW === win` 说明**没有**横向溢出。

真因是切屏的 `translateX` 入场动画还没跑完：动画中途 `#screen-records` 的 transform 是
`matrix(1,0,0,1, 120.597, 0)`，120.6 设计像素 × 0.52 缩放 ≈ 63 CSS 像素。等 `transform` 落到 `none` 再量，`screenLeft = 0`。

**结论：布局没问题，是量早了。** 这条记在这里，因为「动画中途量矩形」是这个仓库最容易重犯的误报来源，
第 19 章刚踩过一次同类的（弹窗错峰入场像卡住）。

## 20.6 没做的事

1. **没有改数据层**。理由见 20.2：两套数据本来就是一份，没有可统一的东西。
2. **没有把「云端」这个词从整个仓库删掉**。`sw.js` 的缓存说明、`README`、本评审文档里还会出现，
   那些是给维护者看的实现描述，不是玩家文案。**玩家可见的「云端档案 / 本机战绩 / 两套独立」已清零**
   （`grep 云端 pwa/index.html` 只剩两处 HTML 注释）。
3. **没有重跑 journey**（`scripts/journey.js` 已同步文案断言，但那段需要完整起服务端 + 真浏览器走一局，
   本轮用表单 + 探针覆盖，留到下次整体回归时跑）。

## 20.7 发布状态：已发布（2026-10-30 01:4x）

链接不变：`https://liuxuanwu.app.workbuddy.host/`

**线上核验**（带 sharecode 会话 cookie 逐个取，别只看首页）：

| 项 | 结果 |
|---|---|
| `/api/health` | `version=20261030a`，`pwa=20261030a` |
| `sw.js` | `weile-liuxuanwu-v59` |
| 首页 `index.html` | `app-version=20261030a`，页脚已是「已保存到账号 · 换设备也在」 |
| `js/game.js?v=20261030a` | 命中「已保存到账号」3 处（登出态的「只在这台设备上」也在） |

**核验方法上的坑**：不带 cookie 直接 `curl /js/game.js` 拿到的是 **403「链接不完整」**——
这个站靠 `sharecode` 换会话 cookie，静态资源也要凭 cookie 才放行。
先前只 curl 首页那次看着「线上已经是新版本」，其实只验了 HTML，JS 一条没验。
**要验就带上 cookie 把 js / sw / health 一起取。**

**代码**：已推送 GitHub `52a6b98..7764ad9`（7 个提交，含本次文案改动与两个文档提交）。

---

# 第 21 章 · 全量复评（v59，2026-10-30，新 session 重跑）

## 21.1 这一轮怎么做

按用户给的六个维度重跑一遍，不引用第 19 章的结论，重新取证。方法与上一轮的差别：
**凡是"能不能用"的问题一律去量，不靠读代码下判断。**

| 手段 | 覆盖 |
|---|---|
| `npm test` | 67 文件 / 2413 项 / 0 FAIL / 59.4s |
| `npm run journey` | 95 项全过 / 18.0s（真浏览器走完注册→建房→补 AI→两轮分牌→结算→战绩→排行榜） |
| `probe-table.js 844×390` | 横屏牌桌三组槽位盒模型 |
| `probe-landscape.js`（新） | 竖屏 390 / 小屏 360 / 横屏 844 的**物理字号与真实点击热区** |
| `probe-records-cloud.js` | 39 项（战绩页数据源与几何） |
| 静态扫描 | 定时器配对、JSON.parse 兜底、parseInt radix、硬编码色、字号/圆角/padding 取值分布、弹窗关闭路径、防连点覆盖 |
| 定向重读 | `engine/stateMachine/hub/profile/roomStore/records/sessionLog/sw/index`，只挑高风险分支 |

上一轮的三条遗留（没重读全部源码、多人真对局没点过、横竖屏只做静态核查）里，
**横竖屏这一条本轮补上了，也正是这轮唯一找到 P1 的地方**。

## 21.2 结论

**P0 仍为零。** 找不到「丢数据、算错分、把房间卡死」这一类的现行缺陷：
写盘是 tmp + rename 原子替换且有单写队列（`profile.js`）、结算幂等键按 `sessionKey` 去重、
`JSON.parse` 全部有兜底、`parseInt` 全部带 radix、倒计时用服务端 `now` 校正时钟偏差
（`splitEndsLocal = ends − (room.now − Date.now())`，代数上等价于直接用服务端时刻）。

**这两条 P1 都落在同一个地方：移动端形态。** 都是「在电脑上完全正常、在手机上换个姿势就不能用」，
而它们此前从未被量过 —— 本条记录的起点是量出来的数字，不是读代码读出来的猜测。
两条都已在本轮修掉（见 21.3 / 21.4），修完的回归数据也一并写在那两节里。

## 21.3 横屏（原 P1-A）：已重做成 1624×750 的横向版式

**改前**（本轮实测的起点）：横屏 `scale = min(vw/750, vh/1440)` 被高度卡死到 0.271，
首页入口文字真渲染 **5.1px**、盒 20.6×6.2，按钮字 8.7px，牌桌缩成屏宽 24% 的窄柱。

**改后**：横屏改用 **1624×750** 的横向画布（正好是竖版 750×1624 转 90°），
`scale = min(availW/1624, availH/750)` —— 844×390 得 **0.52，与竖屏同一档**。
多出来的宽度用来分栏，而不是把竖屏等比缩小。

| 指标 | 改前 | 改后 |
|---|---|---|
| scale（844×390） | 0.271 | **0.52** |
| 首页入口文字 | 5.1px | **9.9px**（= 竖屏同值） |
| 按钮文字 | 8.7px | **16.6px**（= 竖屏同值） |
| 牌桌占屏宽 | 24% | **100%**（两栏铺满） |

**怎么实现的**（`game.js` resize + `style.css` 的 `.ls` 段）：

- resize 把原来的「横屏/桌面」共用分支拆成三支：竖屏 / **横屏（新）** / 桌面大窗。
  横屏不再挂 `.wide-stage`（那条规则会把内容限宽 750、居中在宽画布里，等于又缩回窄柱），
  只挂 `.ls`。竖屏分支**一行没动**。
- 对局页：`.ls #screen-game` 用 grid 两栏 —— 顶栏整行，下面左组槽、右手牌。
  组槽高度仍由 `recomputeSlotBudget()` 读 `clientHeight` 反推，所以不需要为横屏再写一套像素。
- 组槽桌带宽度：竖屏是常量 629，横屏改成现量左栏宽度（`slotBandInnerW()`），
  否则「斗牛 5 张」那组会白留一条空毡面。
- 房间页/结束页：左内容、右按钮两列。房间页**特意不用 grid** ——
  `.room-grid` 本身是 `flex:1 + overflow-y:auto` 的网格，放进 grid 容器后实测被排到第 1 行
  （`listTop=13`，与房间号行重叠 53px，而 `gridRowStart` 报的是 2），改回块流 + 绝对定位右栏。
  这条是**量出来的**，不是想出来的。
- 安全区：横屏不再换算成长 padding，而是并进舞台的居中偏移，刘海与 home indicator 天然被让开。

**验收**：

| 项 | 结果 |
|---|---|
| `npm run journey` @ 844×390 | **96 项全过 / 19.1s**（注册→建房→补 AI→两轮分牌→结算→战绩→排行榜，整条链在横屏下跑通） |
| `probe-table 844×390` | 三组槽位 `clippedPx` 全 0、`fullyVisible` 全 true；`scale` 0.52 |
| 截图 | 对局页 / 房间页 / 结算页 三张逐一看过：无重叠、无裁切、文字可读 |

**竖屏没被影响，证据**：

| 项 | 结果 |
|---|---|
| `npm test` | 67 文件 / **2416 项** / 0 FAIL（新增 3 条 SW 自救断言，原 2413） |
| `npm run journey` @ 390×844 | **96 项全过 / 17.7s** |
| `probe-table 390×844` | `scale` 0.52、`stageDesignH` 1623.08、组槽牌 **144×202**（仍顶到上限）、`clippedPx` 全 0 —— 与改前逐项一致 |
| 代码层 | 竖屏分支未改；新增 CSS 全部挂在 `.ls` 前缀下；`isLandscape` 为 false 时 `slotBandInnerW()` 直接返回原常量 |

## 21.4 添加到桌面（原 P1-B）：兜底页现在会自救

**改前**：`manifest.start_url = "/"` → 桌面图标启动不带 `?sharecode=` → 网关只认 30 天的
`__wb_rsc` cookie → 过期就 403 → SW 返回「访问链接已失效」，那张页没有任何脚本，
而 `index.html` 顶部那段「补回 sharecode」的自救逻辑在 403 场景下根本不会执行。
**说明写了，路没给。**

**改后**：`ACCESS_HINT` 里补上同一段自救 —— 读 `localStorage.lxw_sharecode_v1`，
有码就 `location.replace('/?sharecode=' + code)`（顺带刷新那 30 天 cookie）；
用 `sessionStorage.lxw_sc_retried` 记一次「已试过」，存的是过期码时不会再跳，
避免变成跳不出去的死循环。

**验收**：`sw-timeout.test.js` 新增 3 条断言（兜底页读本地码 / 带码重开 / 只重试一次），
`npm test` 2416 项全过。**未在真实设备上等一个 cookie 自然过期来复现** —— 这句写在这里，别当成已验证。

## 21.5 P2（体验优化）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| P11-1 | **字号没有刻度**：`font-size` 有 20+ 种取值，相邻档只差 1px（19/20/21/22/23/24/25/26/27/28…） | `grep -oh "font-size: *[^;]*"` 去重计数 | 收敛成 6~7 档（如 18/22/26/32/40/52/64 设计 px）。1px 级差异在 0.52 缩放下是 0.5 CSS px，肉眼不可辨 |
| P11-2 | **间距没有令牌**：88 个不同的 `padding` 值，无 `--space-*` | 同上 | 定 4/8/12/16/24/32 六档 |
| P11-3 | **圆角 11 种**（999/50%/5/8/12/14/16/18/20/24/28/32） | 同上 | 卡片 16、胶囊 999、弹窗 24，三种够了 |
| P11-4 | **按钮变体不成体系**：`.btn` 之外有 10 个变体，其中 `.btn-submit` / `.btn-start` / `.btn-sm` / `.btn-mini` 各只用 1 次 | `grep -oh "\.btn[a-z-]*"` 计数 | 一次性变体并回 `.btn-*` 体系，或写进规范说明「为什么它特殊」 |
| P11-5 | **弹窗关闭方式不一致**：13 个弹窗里 7 个支持点遮罩关，`guide` / `rules` 两个**内容型**弹窗不支持 | `e.target === e.currentTarget` 计数 | 内容型一律支持点遮罩关；确认型（confirm/dissolve/clear）保持只能点按钮，这是对的 |
| P11-6 | 残留硬编码色 59 处，其中同一色重复写（`#062b16` ×2、`#33415c` ×2、`#fff` ×8） | `grep -nE "#[0-9a-fA-F]{6}"` | 重复色补令牌；mask 渐变用的 `#000` 保留 |
| P11-7 | toast 文案有近义两套：「网络不太稳，**再提交一次**」/「网络不太稳，**再试一次**」 | `grep "flash('"` | 统一成后者 |

顺带记两条横屏首版留下的观察（不是缺陷，先不动）：
横屏组槽的牌受纵向预算限制只有约 120×168 设计像素（竖屏顶到 144×202），
牌面比竖屏小一圈；想更大就得把顶栏压更矮，代价是分段信息更难读，等有真实反馈再调。

## 21.6 分维度评分

| 维度 | 第 19 章 | 本节初评 | 修完 | 依据 |
|---|---|---|---|---|
| 代码质量 | 9.5 | 9.5 | **9.5** | 定向重读 + 六类缺陷模式扫描都没找到现行逻辑错误；横屏是新增分支，没有改动竖屏路径 |
| 测试覆盖 | 9.3 | 9.2 | **9.4** | 2416 项 + journey 96 项（新增「房间号行与玩家列表不重叠」这条几何断言）；横屏有 journey 全程 + 盒模型探针覆盖，不再是 0 |
| UI 一致性 | 8.8 | 8.6 | **8.6** | 颜色已归位到令牌，但字号/间距/圆角三套刻度仍不存在（P11-1~3） |
| 交互合理性 | 8.9 | 8.5 | **8.9** | 横屏从「点不到」变回「可玩」；竖屏的防连点/焦点圈定/Esc/长按保存一条没动 |
| PWA / 移动端 | —（未单独评） | 7.8 | **8.7** | 缓存策略与安全区本来就扎实；这轮补上横屏版式与桌面图标自救，扣分剩在「未真机验证」 |
| 产品完成度 | 9.0 | 8.9 | **9.0** | 玩法闭环完整，四种形态（竖屏/横屏/桌面/PWA standalone）现在都走得通 |

**加权：8.8 → 9.0。**

回到 9.0 而不是 9.1：横屏是首版实现，只经过一次 headless 实测（没有真机）；
P11-1~3 那三套刻度仍然缺，属于「改一次全局受益」的事项，留着。

## 21.7 排期建议

| 优先级 | 事项 | 成本 | 理由 |
|---|---|---|---|
| 本周 | 横屏真机过一遍（iPhone 横持 + 安卓横持，看牌面大小与拇指够不够得着） | 0.5h | headless 只能证明不重叠，证明不了「手感」 |
| 下周 | P11-1 / P11-2 字号与间距刻度 | 1d | 一次收敛，后面所有界面都受益 |
| 之后 | P11-5 弹窗关闭一致性、P11-7 文案、P11-6 残留色 | 0.5d | 一致性收尾 |
| 观察 | P11-3 / P11-4 圆角与按钮变体并档、横屏组槽牌面偏小 | 0.5d | 视觉收益小，等下次大改一起 |

## 21.8 这轮没做的事（写清楚，别下次误以为覆盖了）

1. **横屏没有真机验证**。数据来自 headless Edge 的 `getBoundingClientRect` / `font-size`、
   以及 journey 全程；「牌面在 6 寸屏横持时够不够大」需要你拿手机看一眼。
2. **没在 iOS standalone 上验证 cookie 过期后的自救**（21.4 的修复只做了单测）。
3. **没有跑多人（3 人以上）真对局**，仍是脚本注入 + AI 补位。

---

# 第 22 章 · 全量复评（20261030b / sw v60，2026-10-30 第三轮）

## 22.1 这轮怎么做的，与第 21 章的区别

第 21 章的量测对象是「竖屏做得好不好」，横屏是最后补测的一个点。
这一轮反过来：**横屏是刚写的代码，先假定它有洞，然后去找洞**。差别在于取样范围 ——
上一轮只量了对局页（probe-table）、结算页（journey 截图）、首页字号（probe-landscape），
从没量过**入口屏的纵向预算**和**弹窗**。这轮补的就是这两块。

| 手段 | 覆盖 |
|---|---|
| `npm test` | 67 文件 / 2416 项 / 0 FAIL / 59.7s |
| `npm run journey` | 竖屏 99 项 / 横屏 99 项（本轮新增 3 条版式断言） |
| `probe-table 390×844 / 844×390` | scale 0.52 / 0.52，三组 `clippedPx` 全 0 |
| `probe-landscape-screens`（新） | 横竖屏 × 首页 / 登录 / 引导弹窗 / 弹窗按钮可达性 / 战绩页纵向预算 |
| `probe-records-cloud 844×390` | 39 项全过；补了子块矩形与滚动预算（见 22.7） |

## 22.2 结论：P0 两条，都在横屏；都不是「新写坏的」，是「没写到」

第 21 章修完横屏后我写了「四种形态（竖屏/横屏/桌面/standalone）现在都走得通」。
**这句话是错的。** 横屏真正适配的只有 5 个屏里的对局、房间、结算三块版式，
而 `#screen-home` / `#screen-auth` / `#screen-records` / `#screen-rank` 仍是竖屏单列，
直接塞进高度只有 750 设计像素的画布里。三块派生的后果，两条是 P0。

## 22.3 P0-1 横屏新手引导：「下一步」整个跑到屏幕外

**实测**（`probe-landscape-screens`，同一份代码两种朝向）：

| 指标 | 竖屏 390×844 | 横屏 844×390 |
|---|---|---|
| 引导卡片高度 | 437 CSS px | 286 CSS px |
| 卡片内容溢出卡身 | **0** | **291 CSS px** |
| 正文可滚动 | 否（不需要） | 否（`min-height` 顶着） |
| 「下一步」按钮 | 在屏内 | **top 429 / bottom 475 —— 视口只有 390** |

**根因**：`.guide-body { min-height: 616px }` 是写死的设计像素，`.modal-card` 上限
`max-height: 82%`。横屏舞台只有 750 设计高 → 卡片上限 615，而光正文就要 616，
再加上进度条、说明、按钮，整张卡超上限 291 CSS px；`.modal-card` 又是 `overflow: hidden`，
于是**底部按钮不是「要滚」，是「不存在」**。新手横屏第一次进来只能点右上角的「跳过」，
读不到第 2~4 步。

**这是回归**：改造前横屏舞台高 1440，82% ≈ 1181 > 830，装得下。是这轮把 1440 换成 750 带来的。

**修法**（`style.css`，`-- 1 行`）：
```css
.ls .guide-body { min-height: 0; }
```
正文改成可收缩（它本来就有 `overflow-y: auto`），按钮回到卡片底部。

**验证**：同一探针复测 —— `cardOverflow: 0`、「下一步」278..324 全部在屏内、
`bodyCanScroll: true`（正文 522 / 视口 325）。竖屏未变（437 高、无溢出）。

## 22.4 P0-2 横屏入口屏：不滑就看不到「加入房间」和四个入口

**实测**：`#screen-home` 横屏 `overflowY = 171 CSS px`（= 329 设计像素）。
静置截图里「加入房间」只剩上半截，规则 / 战绩 / 排行榜 / 账号 **四个入口整排看不见**。
`#screen-auth` 同样溢出。

`#screen-home` 有 `overflow-y: auto` 兜底（竖屏时代为「桌面小窗 / 分屏」写的），
所以内容**不是丢失，是要滑才发现**。但对**入口屏**来说这等于「主按钮藏起来了」——
玩家第一眼看到的是一屏截断的画面，而不是「这里能创建房间」。

**修法**（`style.css` 的 `.ls` 段）：横屏改成真两栏，而不是让它滚。

- 首页：`.home-inner` 变 grid，`480px + 1fr`，左列徽标/标题/副标题，右列昵称/创建/加入/四入口；
- 登录页：`.auth-inner` 变 grid 两列（它本来就分「品牌 / 卡片」两块），底注显式放到卡片下方；
- 两屏总宽 1180 设计像素居中，落在 1624 画布内。

**验证**：

| 指标 | 修前 | 修后 |
|---|---|---|
| 首页横向占比 | 38.2% | **72.7%** |
| 首页纵向溢出 | 171 CSS px | **0** |
| 「加入房间」/ 四入口 | 被下沿切 | **完整可见**（截图核对） |
| 竖屏首页 | 82.7% / 溢出 0 | **82.7% / 溢出 0（未变）** |

## 22.5 P1 横屏战绩：列表只剩 222 CSS px —— 已改成两栏

**改前**（`probe-records-cloud 844×390` 量到的纵向预算）：

```
rp-nav           y=0..58    高 58
records-scroll   y=58..280  高 222  内容 2684  → 可滚，但一条流水都看不到
records-foot     y=280..390 高 110
```

汇总四块的设计像素高度是量出来的：`#rp-sum 205 + .rp-grid 107 + #rp-bests 109 + .rp-trend 125 = 546`，
而滚动区只有 426 —— **单栏时列表排在 546 之后，横屏一条流水都看不见**，
要在 222 CSS px 的窗口里滑 2684 才能滑到列表。功能没坏，但「查战绩」在横屏基本做不了。

**改法**：横屏两栏，左列数字自己滚、右列流水自己滚。

- `index.html` —— 加两个**无样式**包裹层 `.rp-sumcol`（汇总四块）/ `.rp-listcol`（表头 + 列表），
  只为横屏分组；竖屏它们是普通块，DOM 结构不变（已核：CSS 没有依赖 `#records-data` 的直接子级选择器，
  JS 只按 id 取 `#rp-sum` / `#rp-trend-bar` / `#records-data`）。
- `style.css`（`.ls` 段）—— `#records-data` 改 flex 两列（620 + 1fr，gap 40）；
  两列各自 `overflow-y:auto`；页脚压扁（`padding 14/12`）、屏上下留白收窄（24/40 设计像素）。

**踩到的三个坑（都不是排版偏好，是量出来才发现的）**：

1. **grid 版第一版把表头撑到 208 设计像素**：左列 `grid-row: 1 / span 2` 会参与两行的尺寸计算，
   `auto` 那行被左列内容撑大，表头吃掉 208、列表只剩 170。改 flex 才可控。
2. **左列 flex-basis 620 不生效**：flex 项的 `min-width` 默认 `auto`（= 内容 min-content），
   趋势条把 min-content 撑到 1400+，结果右列被挤成 60 CSS px、表头**竖排**成一列字。修法是显式 `min-width: 0`。
3. **`.ls .screen > *` 那条「限宽 820」也命中了 `<main class="rp-scroll">`**：
   两栏要在 1544 里分，被限成 820 之后左 620 + gap 40 只剩 160 给列表 —— 表现和上一条几乎一样。
   `max-width: none` 放开后才是真两栏。

**改后实测**：

| 指标 | 改前 | 改后 |
|---|---|---|
| 左右栏 | 单栏（列表在 546 之后） | 左 620 / 右 884（设计像素） |
| 列表可视高度 | 0 行（滚到底才见） | **363 设计像素 ≈ 4 行**，列表自身滚动 |
| 表头高度 | — | 35 设计像素（横排） |
| 屏宽占用 | 426/844（半宽） | **844/844 满宽** |
| 竖屏 | 单列整页滚 | **单列整页滚（未变）**，39 项探针全过 |

左列仍要滚（546 内容 / 418 视口），所以给它加了一层底部渐隐（`mask-image` 26px）——
否则一张卡片被硬切一半，看起来像坏了而不是「下面还有」。

**排行榜在横屏仍是 820 设计像素居中单列**（`contentW 426 / fillRatio 50.5%`，溢出 0）。
这是有意的：排行榜是有序列表，分两栏会破坏阅读顺序，820 也正好是舒服的阅读宽度。

顺带说明：这两屏**没有**出现「整块右移」那种布局错位。第一版探针截图里内容只剩右边一条，
量出来 `rp-nav@209..635`（屏宽 844）是**居中**的 —— 又是截图落在切屏动画里的老问题，见 22.7。

## 22.6 P2（体验与一致性，含第 21 章未消化的）

第 21 章的 P11-1~7 全部仍然成立，这里不重复，只记这轮新增/重测的数字：

| # | 问题 | 证据（本轮重测） |
|---|---|---|
| P11-1 | 字号无刻度 | `font-size` 30 种取值（上轮记 20+，随横屏新增继续变多） |
| P11-2 | 间距无令牌 | 88 种 `padding` 值；本轮新写的横屏两栏又加了 1180/480/90/80 四个魔法数 |
| P11-3 | 圆角不成体系 | 18 种 |
| P11-6 | 残留硬编码色 | `style.css` 73 处 |
| P12-1 | 引导正文在小窗口里滚动，**没有任何「还有内容」的提示** | 横屏正文 522 / 窗口 325，文字在半句处被切断（「…第一轮拆成 1 / 2 / 3 张比，」后面还有一句） |
| P12-2 | 装饰层制造溢出噪音 | `#screen-auth` 的 `.auth-glow` 让 `overflowX=230 / overflowY=200`（横竖屏都一样）；`.screen{overflow:hidden}` 掩盖了它，但这会让「拿 overflow 判布局坏没坏」的断言失灵 —— 本轮就差点被它误导 |
| P12-3 | 过期的实现注释 | `resize()` 里「4) 三种模式」还写着旧横屏方案（压到 1440 + 内容限宽 750）。`audit:comments` 抓不到（它只查「引用的名字是否还存在」），已在本轮修正并注明「读到 1440/max-width 750 就是过期说明」 |

## 22.7 方法论：第三次「动画中途取证」误报

横屏战绩页第一张截图，内容只剩最右边一条，看起来像整块被推出屏幕。
同一时刻量矩形：`rp-nav 209..635`、`ink 230..614`、`overflowX 0` —— **布局是对的**。

这是本仓库第三次踩同一个坑（第 19 章把弹窗错峰入场当成卡住，第 20 章把 `translateX -63px`
当成整屏右移）。所以这轮不是「记一笔」，而是**把取证时机写进工具**：
`probe-records-cloud` 里所有截图现在都先 `settleScreens()`（轮询到所有可见 `.screen`
的 `transform === 'none'` 再多等 260ms）。

同时把「横屏版式有没有生效」从「靠人看图」变成断言（`scripts/journey.js`，3 条）：

- ★ 横屏挂 `.ls` / 竖屏不挂（版式与朝向一致）
- ★ 主按钮实际字号 ≥ 9px（横屏不再腰斩）
- 竖屏不该挂桌面宽窗类 `.wide-stage`

这三条在任何朝向下都会跑，等于把第 21 章「5.1px」和本章「按钮跑出屏外」两类事故
都变成了红绿灯，而不是等下一次量。

## 22.8 分维度评分

| 维度 | 21 章 | 本轮 | 依据 |
|---|---|---|---|
| 代码质量 | 9.5 | **9.5** | 定向往返读了新增的 resize 三分支、`slotBandInnerW`、`.ls` 规则；写盘原子性/幂等/时钟校正未变。扣分项只有一段过期注释（已修） |
| 测试覆盖 | 9.4 | **9.4** | 2416 项 + journey 双朝向各 99 项 + 四套探针。但**横屏弹窗与列表预算仍无自动断言**（本轮是手工量的），到位后应是 9.6 |
| UI 一致性 | 8.6 | **8.5** | 30 档字号 / 88 个间距 / 18 种圆角，且横屏又添了 4 个魔法数 |
| 交互合理性 | 8.9 | **8.9** | 入口屏两栏、战绩页数字与流水同屏可分滚；减分在引导正文滚动仍无文字提示（只有渐隐） |
| PWA / 移动端 | 8.7 | **8.8** | 横屏五屏全部适配（对局/房间/结算三屏版式 + 首页/登录/战绩两栏），列表预算已解决；仍缺真机验证 |
| 产品完成度 | 9.0 | **8.9** | 闭环完整；横屏已能顺畅开局与对局，查战绩在横屏偏挤 |

**加权：9.0 → 8.9 → 9.0（P1 修完后的终值）。**

中间那个 8.9 是「两条 P0 刚修、战绩页还挤成一团」时的评分。P1 修完后回到 9.0，但和上一轮的 9.0
不是一回事：上一轮那个 9.0 是把没验收过的屏幕算成了「走得通」，这一轮的 9.0 是**五个屏都量过**
（横屏每个屏都有截图 + 尺寸数据）之后的 9.0。

不给更高，是因为还差一件事：**真机**。所有数字都来自 headless Edge 的
`getBoundingClientRect` / `getComputedStyle`，它能证明「不重叠、不裁切、字号够大」，
证明不了「横持时牌面看着舒不舒服、拇指够不够得着」。

## 22.9 排期

| 优先级 | 事项 | 成本 | 状态 |
|---|---|---|---|
| P0 | 横屏引导「下一步」不可达 | 1 行 CSS | **本轮已修** |
| P0 | 横屏入口屏 / 登录页要滑才见主按钮 | 半天 | **本轮已修** |
| P1 | 横屏战绩 / 排行榜列表只剩 222px 窗口 | 半天 | **本轮已修**（两栏，列表 4 行可视 + 自滚） |
| P1 | 真机横持过一遍（牌面大小、拇指够不够得着、刘海遮挡） | 0.5h | 待做，只有你能做 |
| P2 | P11-1/2 字号与间距刻度；P12-1 滚动提示；P12-2 装饰层溢出 | 1.5d | 排在下个迭代 |

## 22.10 这轮没做的事

1. **档案卡 / 结算明细 / 无痕模式等弹窗没有逐一在横屏量过**。只量了引导弹窗（因为它有写死高度）。
   `.modal-card` 的 82% 上限对其它弹窗同样生效，凡是内容超过 615 设计像素的都可能被裁 ——
   下一轮应把 `probe-landscape-screens` 的 `MODAL` 取样扩到全部 13 个弹窗。
2. **没做转屏过程中的状态验证**（对局中途横→竖、竖→横）。代码里有
   `orientationchange → setTimeout(resize, 200)` 与组槽 `ResizeObserver`，逻辑上覆盖了，
   但没有一次「在牌桌上转屏」的自动用例。
3. **没在真机上验证**横屏两栏的实际观感与点击热区（数据全部来自 headless Edge 的
   `getBoundingClientRect` 与 `getComputedStyle`）。

---

# 第 23 章 · 真机横屏验收：四处裁切（20261030e / sw v63）

## 23.1 这轮的起点不是我量的，是你拿手机看的

前四轮所有结论都来自 headless Edge 的 `getBoundingClientRect`。这一轮的输入是
**5 张 iPhone 横屏截图**，四张都拍出了问题。这件事本身就是结论：
**能算出来的和能用眼睛看出来的，不是同一个集合。**

四处的共同点：都不是「算错了」，是**满载状态没进过验收范围**。
第 22 章的验收对象是「主流程走得通」——2~4 人房间、1~4 行排行、刚建号 3 局流水。
真机上摆的是 8 个座位、6 名排行、20 行流水。

## 23.2 四处裁切

| # | 现象（真机截图） | 实测 | 根因 |
|---|---|---|---|
| A | 房间页座位第 3 行起被裁一半，底部提示条压在裁口上 | 座位卡 242 设计高；`MAX_PLAYERS = 8`，2 列 = 4 行 = **992**；横屏可用 **546** | 我自己在第 21 章留的 `max-height: 470px` 把网格截断 |
| B | 战绩页左栏「单场最高/最长连胜/最长连败」只剩标题行，数值整排不见 | 左栏内容 **546**（205+107+109+125），可视 **418** | 页脚 212 设计像素 + 屏留白 64，把 546 压到 418 |
| C | 排行榜第 6 名被页脚渐隐「洗掉」，看着像禁用行 | 页脚 156 → 列表窗口只够 4 行半 | 同上：页脚在竖屏是两行，横屏照抄 |
| D | 战绩/排行榜的返回箭头飘在半个屏幕右边 | nav 被「限宽 820」居中，战绩内容实际 **1544** 宽 | 第 22 章那条 `.ls .screen > *` 的限宽规则，nav 也在里面 |

## 23.3 修法

| # | 改法 | 结果 |
|---|---|---|
| A | 座位 2 列 → **4 列**（2 行装 8 个），去掉 `max-height` | `canScroll: false`、`lastSeatCut: -4`、提示条不压座位 |
| B/C | 页脚横屏压成**一行**（说明在左、清除按钮在右） | 页脚 156 → **104**；战绩左栏可视 418 → **470**（546 装得下 463 的「汇总+胜负平+纪录」，趋势落到折叠线下）；列表 363 → **415** |
| C | 排行榜行距收紧 98 → **78** 设计像素/行 | 6×78 = 468 ≤ 470，一屏看完 |
| D | 战绩页 nav 放开满宽；排行榜**不动** | 箭头与左栏左边缘对齐；排行榜 820 单列本来就是箭头对齐的，放开会让名字在最左、分数在最右 |

## 23.4 为什么会漏：验收样本是「空载」不是「满载」

以前每一轮都验「能不能玩完一局」，这轮暴露的是「塞满了还能不能看」。
两者是不同的验收面。补上的满载清单（写在这里，下次照着过）：

| 屏 | 满载状态 |
|---|---|
| 房间 | **8 个座位**（不是 2 人也不是 4 人） |
| 对局 | 6 张手牌 + 三组满槽 + 6 个对手座位卡 |
| 战绩 | 20 行流水 + 有纪录（单场最高/连胜/连败） + 有趋势图 |
| 排行榜 | **≥ 6 名**（要能看出第 6 行有没有被页脚吃） |
| 结算 | 8 人同时结算 |

## 23.5 现在有什么守着（不再靠眼睛）

`probe-landscape-screens` 新增 4 条满载断言，横竖屏各跑一遍：

- ★ 房间渲染满 8 个座位（满载场景）
- ★ 8 个座位一屏放得下（不用滚）
- ★ 最后一个座位没被容器裁掉
- ★ 底部提示条不压座位区

`probe-records-cloud` 新增 1 条：★ 横屏左栏「纪录」卡没被裁（数值可见）。

**断言验过会红**：把座位临时改回 2 列，`canScroll` 变 true、`lastSeatCut` 变 **+134**，
两条断言如实 FAIL；还原后 8 项全过。

## 23.6 评分：仍是 9.0，不涨

| 维度 | 22 章 | 本轮 | 依据 |
|---|---|---|---|
| 代码质量 | 9.5 | **9.5** | 只动 CSS，无逻辑改动 |
| 测试覆盖 | 9.4 | **9.5** | 满载断言补上（8 + 1 条），且验证过会红 |
| UI 一致性 | 8.5 | **8.5** | P11-1~3 的刻度债没动 |
| 交互合理性 | 8.9 | **9.0** | 满员房间、6 名排行现在都一屏可读 |
| PWA / 移动端 | 8.8 | **8.9** | 横屏五屏 + 满载场景都过一遍；仍等真机复验 |
| 产品完成度 | 8.9 | **9.0** | — |

**加权：9.0 → 9.0。**

不涨是有意的：这一轮修的是**上一轮该发现的东西**。分数要反映「现在多好」，
也要反映「代价是谁付的」—— 这四处是你拿手机看出来的，不是我量出来的。
什么时候能涨：真机复验这四处都干净之后。

## 23.7 这轮没做的事

1. **没在真机上复验**（我只能改完给你看截图，最终得你再横持一次）。
2. **没验 8 人满员对局**（房间满 8 人的对局页座位条、结算页 8 行），代码里没有这个场景的夹具。
3. **没处理「引导正文在横屏要滚、只有渐隐没文字提示」**（P12-1，仍是 P2）。

---

# 第 24 章 · 横屏铺满 + 自适应各种尺寸（20261030f / sw v64）

## 24.1 用户原话

> 横屏没有把整个屏幕铺满，有明显的留空，能不能自动适配横屏屏幕，考虑到可能是不同大小手机甚至是电脑；
> p2 同步改；排行榜显示不美观；我的战绩左边每次都要上下滑才能看全。

这一轮三个都是**观感**问题，而且都不是某一行写错，是设计取向错了。

## 24.2 根因：等比居中 + 按短边猜设备

| 层 | 旧做法 | 后果 |
|---|---|---|
| 缩放 | 固定 1624×750 画布，`scale = min(availW/1624, availH/750)` 后居中 | 等比缩放**必然**留白：比例 2.17 的手机还算贴边，4:3 平板/电脑窗口露出整条底色带 |
| 判定 | `短边 ≤ 520` 才算横屏手机，其余走「桌面」分支 | 平板、电脑被塞进「居中的竖版画面」，四周留得更多 |
| 安全区 | standalone 时 `saTop = max(saTop, 47)` 对横屏也生效 | 那是给竖屏灵动岛留的，横屏白扣 47px 高 → 舞台再小一圈 |
| 安全区 2 | 横屏把安全区并进「居中偏移」 | 舞台宽度被扣掉两侧安全区，居中后两边露出页面底色 —— 这就是截图里那圈「框」 |

四条叠在一起，真机上看到的就是「中间一块、四周留白」。

## 24.3 改法：两个方向都铺满，画布按需要延伸

```
scale = availH / 750;                       // 先按高度定，保住 750 的设计预算
if (availW / scale < 1624) scale = availW / 1624;   // 宽度不够 1624 就退回按宽度定
if (scale > 1.35) scale = 1.35;             // 超大屏封顶（否则正文被放大到 60+ CSS px）
stageW = vw / scale;                        // ← 反算：铺满宽
stageH = vh / scale;                        // ← 反算：铺满高
```

关键在最后两行：**尺寸不是「设计值 × scale」，而是「视口 / scale」**，
于是 `stageW × scale === 视口宽`、`stageH × scale === 视口高`，两个方向都贴边，
而设计像素密度（750 高的预算）保持不变。屏幕比例变大 → 画布变宽（多出来的宽度给第二栏）；
比例变小 → 画布变高。都不变形、都不留白。

配套三处：判定只看向向（宽 ≥ 高即横版，平板电脑同一套）；standalone 的 47px 只在竖版生效；
安全区改回写成 `--sa-left/right` 交给 `.screen` 的 padding（背景铺到屏幕边缘，内容避开刘海）。

**铺满矩阵实测**（`probe-landscape-screens`，四边缝隙 ≤ 2px 才算过）：

| 视口 | scale | 画布（设计像素） | 四边缝隙 |
|---|---|---|---|
| 844×390（小手机横屏） | 0.52 | 1624×750 | 0 / 0 / 0 / 0 |
| 932×430（iPhone 15 Pro Max） | 0.573 | 1626×750 | 0 / 0 / 0 / 0 |
| 1112×511（用户截图那台） | 0.681 | 1632×750 | 0 / 0 / 0 / 0 |
| 667×375（小屏） | 0.411 | 1624×913 | 0 / 0 / 0 / 0 |
| 1024×768（4:3 平板） | 0.631 | 1624×1218 | 0 / 0 / 0 / 0 |
| 1440×900（电脑窗口） | 0.887 | 1624×1015 | 0 / 0 / 0 / 0 |
| 390×844（竖屏对照） | 0.52 | 750×1623 | 0 / 0 / 0 / 0 |

画布变高（667×375 的 913、1440×900 的 1015）不是浪费：它让战绩页、结算页有更多纵向空间，
同一套 CSS 不用为每种比例再写一份。

## 24.4 我的战绩：左栏不再需要滑

左栏四块内容实测 546 设计像素，横屏可视 470 —— 差 76，正是「每次都要上下滑」的来源。

两步处理：

1. **压缩留白与字号档位**（不删内容）：汇总 205→185、胜负平 107→104、纪录 109→94，合计 401；
2. **高度紧张时收起趋势图**（新增 `.ls-tight`：横版且 `stageH < 900`）。
   趋势图画的是每局净胜走势，而右边列表逐局列了净胜和颜色 —— **信息是重叠的**，
   在 2.17:1 的手机横屏上，它换来的只是「每次都要滑」。平板/电脑（stageH 900+）不收起。

结果：1112×511 下左栏 401 ≤ 470，四块（含纪录的「+39 分 / 7 场 / 3 场」）全部一屏可见。

## 24.5 排行榜：两列 + 不再被硬切

真机截图上第一行只剩下半截 —— 因为列表内容高于容器，滚到某个位置时首行被上边缘切开，
而容器没有渐变也没有留白，看起来像坏了。

改成两列（`grid-auto-flow: column`：1~4 名左列、5~8 名右列，行距 98→78），
容器不再需要滚动 → 硬切消失，同时把宽度用起来（不再是一条居中的窄列）。

为什么用列流向而不是行流向：行流向会把「第 1 名」和「第 2 名」并排放在同一行，等于抹掉先后；
列流向是通讯里按列往下读的顺序，1~4 名仍然连续。

断言：`journey` 里合成 7 行（照 `renderRank` 的结构造，量完即删）→
**竖屏 cols=1 / 横屏 cols=2，`canScroll` 均 false，`firstCut` 为负**。

## 24.6 P2：字号 30 → 10 档，圆角 16 → 8 档

| 项 | 改前 | 改后 | 说明 |
|---|---|---|---|
| 字号 | 30 档（13/15/16/17/18/19/20/21/22/23/24/25/26/27/28/29/30/33/34/36/38/44/52/72…） | **10 档**：16/20/24/28/32/40/48/60/76/88 | 改动最多的 22→20（19 处）、26→24（22 处）、30→28（10 处）、34→32（12 处）；0.52 缩放下是 1 CSS px 级差异 |
| 圆角 | 16 档（4/5/8/11/12/14/16/18/20/24/26/28/32/34/48 + 999 + 50%） | **8 档**：8/12/16/20/24/28/32/48（另加 999 胶囊、50% 圆） | 34→32、26→24、18→16、14/11→12、5/4→8 |

**两个必须记住的例外/教训**：

1. **`.net-banner` 不在 750 缩放体系里**（它在 `#stage` 之外，用真实 CSS px），
   字号 13、胶囊半径 48 都被我的批量脚本并掉了 —— 13→16 是屏上真实的 +3px，很明显。
   已还原并在那段加了注释。
2. **`999px`（胶囊）被并成 48px，21 处**。脚本只认「数字+px」，把「完全圆角」当成了一个普通档位。
   这类「语义值」不该进刻度映射：999 / 50% / 0 都是语义，不是刻度。
   发现方式是把 `border-radius` 的取值分布打出来复查，不是靠看截图。

## 24.7 评分

| 维度 | 23 章 | 本轮 | 依据 |
|---|---|---|---|
| 代码质量 | 9.5 | **9.5** | resize 收敛成两个分支（竖/横），判定不再猜设备；超宽屏有封顶 |
| 测试覆盖 | 9.5 | **9.6** | 新增铺满矩阵 7 档 + 榜单满载 2 条，且验过会红 |
| UI 一致性 | 8.5 | **9.0** | 字号 30→10、圆角 16→8；间距仍未令牌化（P11-2 仍在） |
| 交互合理性 | 9.0 | **9.2** | 战绩左栏不用滑、排行榜首行不再被切 |
| PWA / 移动端 | 8.9 | **9.2** | 手机/平板/电脑同一套横版且都铺满；仍等真机复验 |
| 产品完成度 | 9.0 | **9.1** | — |

**加权：9.0 → 9.2。**

## 24.8 这轮没做的事

1. **没在真机/真电脑上看过**。铺满是算出来的（四边缝隙 0），但「铺满之后字够不够大、留白比例舒不舒服」
   还得你再看一眼 —— 尤其电脑窗口拉宽拉窄的时候。
2. **间距（padding/margin）仍未令牌化**：88 种取值。它比字号更依赖逐屏视觉确认，
   我这次只动了字号与圆角，没有硬并。
3. **平板竖屏（768×1024）仍走竖版**，那是 750 宽放大 1.02 倍，观感接近手机，未单独适配。

---

# 第 25 章 · 横屏「底部没铺满」与逐屏收口（20261030g / sw v65）

## 25.1 用户原话与证据

> 底部没有铺满，横屏适配的字体和展示你来定，每个场景都要检查，至少现在看来横屏做的是不完美的。

截图 2224×1023（CSS 1112×511.5，DPR 2）里，内容在 **y=884 / 1023** 处一刀切，
下面是**完全平色**（逐行亮度方差 0.0），颜色 rgb(15,43,34) = `#0F2B22` = `--green-deep`。

这一条很关键：`theme-color` 是 `#16382F`，页面底色才是 `#0F2B22`。
平色带等于「页面画到了，舞台没画到」—— 不是浏览器自带底栏，也不是刘海留白。

## 25.2 根因：舞台尺寸是「算一次的死值」

第 24 章把横屏改成 `stageW = vw/scale`、`stageH = vh/scale` 的铺满算法，**算法本身没错**
（headless 七档四边缝隙全 0）。错在它是**写进内联样式的像素值**：

| 环节 | 旧行为 |
|---|---|
| 计算 | `resize()` 里按当时视口算出 stageW/H，写 `stage.style.width/height` |
| 重算时机 | 只有 `resize` / `orientationchange` / `visibilitychange` / `pageshow` |
| 缺口 | 浏览器收起底栏、应用内 WebView 改高度、分屏拖拽时**不一定派发 resize** |

真机上就是：进来时视口 442 CSS（底栏占着），舞台按 442 算死；底栏收起后视口变 511，
CSS 层重新布局了，但 inline 的 442 不会自己变 —— 底部露出 69 CSS 的页面底色。
**这不是「算错」，是「算完就定死了」。**

## 25.3 改法：铺满交给 CSS，比例才是 JS 的活

```css
#stage.ls {
  width:  calc(100% / var(--ls-scale, 1));
  height: calc(100% / var(--ls-scale, 1));
  transform: scale(var(--ls-scale, 1));
}
```

JS 只写一个数字 `--ls-scale`（并清掉竖版留下的内联宽高/transform）。
`100%` 对绝对定位元素取的是 `#viewport` 的 padding box（= 整个视口，安全区 padding 在它里面），
所以**容器一变，下一次布局自动贴边**，不再依赖有没有人叫 `resize()`。

比例算错会怎样？只会「密度差一点」，不会露底 —— 这条被写成了断言：

```
★ 比例过期也铺满：故意把 --ls-scale 改成 0.45，四边仍须无缝
```

七档视口（844×390 / 932×430 / 1112×511 / 667×375 / 1024×768 / 1440×900 / 竖屏 390×844）
**每条都跑两遍**：正常比例一次、故意改错一次，四边缝隙全 0。

配套的自愈（`game.js`）：

- `ResizeObserver` 盯 `#viewport` 自己的盒子 —— 容器变就重算，与事件是否派发无关；
- `visualViewport` 的 `resize` / `scroll` 也挂上（键盘、捏合、地址栏收放的另一条通路）；
- `syncViewportSize()` 用 `lastVpW/lastVpH` 做幂等，尺寸没变就什么都不做。

## 25.4 顺手挖到的一个真 bug：「加入房间」白字白底

量首页计算样式时看到 `#btn-join` 的背景是 **rgb(240,240,240)** —— 浏览器默认按钮色。
原因：`class="btn btn-lg"`，而 `.btn` 基础样式**只写了 `color:#fff`、没写 background**，
没有变体类时就落到 UA 默认值，白字压在 #F0F0F0 上，对比度约 **1.1:1**，等于看不见。

同批裸用 `.btn` 的还有结算页的「生成战绩图 / 本局过程 / 查看战绩」（它们被别处规则救了回来，
所以只在首页暴露）。修法两层：

1. `.btn` 补兜底底 `rgba(255,255,255,.14)` —— 任何按钮都不允许落到 UA 默认值；
2. 新增 `.btn-quiet`（半透明白底 + 2px 描边），给「加入房间」这种**与主按钮并列的第二条路**用。

## 25.5 逐屏过一遍：13 个弹窗 + 5 个屏

新写 `scripts/probe-modals-landscape.js`：把 13 个弹窗逐个强制显示，量
「卡片是否整体在视口内 / 最后一个按钮是否可点到 / 卡内内容有没有被 `overflow:hidden` 裁掉」，
1112×511 与 844×390 各 39 项断言。

结论：**只有引导弹窗是坏的**（第 22 章修过一次，这次是因为卡片上限 82% 在 750 高的画布上太保守）：

| 项 | 改前 | 改后 |
|---|---|---|
| 引导卡片 | 337 CSS，正文可视 325 设计 px / 需要 542 → **正文断在半句** | 336 CSS，插画与正文并排，需要降到 356 |
| 卡片上限 | 82%（615 设计 px） | 横屏 92%（690） |
| 引导版式 | 插画在上、文字在下（纵向叠） | 插画在左 500px、文字在右（两栏） |
| 「我的账号」 | 403×505，几乎顶满上下（t=3 / bottom=508） | 两栏：信息在左、操作在右，高 390 |
| 排行榜行宽 | 铺满 1112（名字与分数隔 800 CSS px） | 限宽 1240 设计（≈845 CSS）；≤4 名时再收到 620（≈422） |

规则弹窗仍然要滚（正文 1252 设计 px / 可视 409），这是内容量决定的，不该硬塞。
给它加了**滚动渐隐**：`syncScrollFade()` 在真能滚时挂 `.scroll-fade`、滚到底就摘掉
（常驻渐隐会把最后一行蒙住，比不给提示更糟）。引导换步时重新判断一次。

## 25.6 字体：由我定的一条线

横屏物理字号 = 设计 px × 缩放，而缩放随屏幕变（1112×511 是 0.681，844×390 是 0.520）：

| 设计字号 | 1112×511 实测 | 844×390 实测 |
|---|---|---|
| 20（标签 / 入口名） | 13.6 CSS px | **10.4 CSS px** |
| 32（按钮） | 21.8 | 16.6 |
| 76（标题） | 51.8 | 39.5 |

10.4 px 是「看得见、读不动」。**定的线：正文级文字实际渲染不小于 12 CSS px**，
写成 `font-size: max(20px, calc(12px / var(--ls-scale)))` —— 比例变了自动跟着变。
只抬承载信息的那几类（标签 / 入口名 / 组槽标题与提示 / 对手名 / 结算提示 / 榜单副信息 /
战绩纪录键名），卡在固定徽章里的微字（`.gt-timer` / `.opp-badge` / `.slot-progress`）不动：
它们放进更大的字号会把胶囊撑破，收益也低。

配套断言：`probe-landscape-screens` 新增「横屏可读性：首页最小文字 ≥ 11 CSS px」，
首页从 **10.4 PASS 不了** 变成现在的最小值达标（量的是渲染尺寸，不是设计值）。

弹窗里的字号没动 —— 暖白卡片是 20~24 设计 px，在 0.681 下是 13.6~16.3 CSS，本来就在舒适区。

## 25.7 工具层：第四次「动画中途取证」

首页第一张截图里内容整体右移、右侧被切 —— 和 20 章、22 章一模一样。
这次没有只看图，而是先补 `settleScreens()` 到 `journey` 的 `shot()`（等所有可见 `.screen`
的 computed transform 回到 `none` 再多等 260ms），再重拍：
内容居中、四边贴边、留白对称。

**结论：那张「整体右移」的图是切屏动画中途拍的，不是布局问题。**
第 20、22 章各踩一次，这章是第三次；所以这次把它写进了 journey 的截图工具，
而不是继续靠「记得等一下」。

顺带补了 journey 的截图点：首页、对局（**必须在 fillRound 之前** —— 上一版在分牌之后截，
拍到的是「已全部放入分组」的半空状态，等于没验）、引导、战绩。

## 25.8 本轮验证

| 项 | 结果 |
|---|---|
| `npm test` | 67 文件 / **2416 项** / 0 FAIL / 58.8s |
| `journey` @390×844 | **102 项全过** / 17.7s |
| `journey` @1112×511 | **102 项全过** / 17.8s |
| `journey` @844×390 | **102 项全过** / 17.7s |
| `probe-landscape-screens` | **22 项全过**（7 档铺满 ×2 + 房间满载 4×2 + 可读性 1） |
| `probe-modals-landscape` @1112×511 | **39 项全过**（13 个弹窗 × 3 条） |
| `probe-modals-landscape` @844×390 | **39 项全过** |
| `probe-records-cloud` @1112×511 / @390×844 | 40 / 39 项全过 |

新增断言：铺满「比例过期也贴边」、首页最小字号、长正文渐隐（能滚才加）、
弹窗三条（在视口内 / 末按钮可点到 / 没被裁）。

## 25.9 评分

| 维度 | 24 章 | 本轮 | 依据 |
|---|---|---|---|
| 代码质量 | 9.5 | **9.5** | 铺满从「算死的值」变成样式保证；resize 多了容器监听但仍幂等 |
| 测试覆盖 | 9.6 | **9.7** | 弹窗探针 39×2 新增；铺满矩阵翻倍；三档横屏 journey |
| UI 一致性 | 9.0 | **9.2** | 按钮有了兜底底与 `btn-quiet`；弹窗上限、榜单宽度、字号下限成文 |
| 交互合理性 | 9.2 | **9.3** | 引导一屏读完、账号弹窗不再顶满、榜单可扫读 |
| PWA / 移动端 | 9.2 | **9.5** | 铺满不再依赖事件是否派发（ResizeObserver + CSS），这是真机唯一暴露的那类问题 |
| 产品完成度 | 9.1 | **9.2** | — |

**加权：9.2 → 9.35。**

不给更高，因为这一轮的三处（底部带、按钮对比度、弹窗裁切）**都是你拿手机看出来的**，
我这边七档 headless 全过 —— 说明「环境差异」这一层还没被工具覆盖。
下一步该补的是「带 env() 安全区 / 视口变化的模拟」，不是再调一轮数值。

## 25.10 没做的事

1. **没有真机复验**。铺满已改成结构保证，但 844×390 下字号抬到 12 CSS px 后的观感、
   引导两栏在真实 6 寸屏上的比例，仍需你横持看一眼。
2. **没有把 `env(safe-area-inset-*)` 做进 headless**：真机刘海/底部横条的影响仍然只能靠推理。
3. **3 人以上真对局**仍是脚本注入 + AI 补位。
4. **竖屏的字号没动**：同一批 20 设计 px 在竖屏 0.52 下是 10.4 CSS px —— 和横屏小屏同病。
   这轮只对横屏立了规矩，竖屏要不要一起抬，得单独过一轮（会牵动整页高度）。

---

# 第 26 章 · 底部安全区、横屏缺的那条趋势、两种等待页（20261030h / sw v66）

## 26.1 用户原话

> 手机底部贴边，同样的问题，竖屏是不是也有
> 横竖屏我的战绩，竖屏有最近十局，横屏没有
> 新开一局的等待页面和继续下一把后再回房间的等待页面为什么 ui 不一致

三句话，三个不同性质的问题：**一个是被覆盖规则悄悄吃掉的安全区**，
**一个是被 `display:none` 删掉的功能**，**一个是「数据来源」被当成了「座位表」**。

## 26.2 「底部贴边」：一条简写把安全区整段吃掉了

`.screen` 的默认下边距是 `calc(var(--sa-bottom) + 120px)` —— 安全区 + 120 设计像素。
横屏改版时写过这么一行：

```css
.ls #screen-records,
.ls #screen-rank { padding-top: 24px; padding-bottom: 40px; }
```

`padding-bottom` 是**整体替换**，`var(--sa-bottom)` 跟着一起没了。
40 设计像素在 844×390 上是 21 CSS px —— 正好是 home indicator 的高度。
于是「清除记录」的下沿压在横条上，视觉上就是「贴边」。

量出来的数（`probe-safearea`，安全区按 iPhone 真机值注入：底部 21 / 两侧 47 CSS px）：

| 视口 | 修前内容下沿 | 安全区 | 富余 |
|---|---|---|---|
| 844×390 | 25 CSS px | 21 | **4** |
| 932×430 | 28 | 23 | **5** |
| 667×375 | 20 | 16 | **4** |
| 390×844（竖屏） | 70 | 34 | 36 ✓ |

**竖屏没有这个问题，也不是「整体没铺满」**：`records.css` 里 `#screen-records` 用的是
`padding: var(--sa-top) var(--sa-right) var(--sa-bottom) var(--sa-left)`，四个方向都带安全区，
页脚自己还有 70 设计像素的下边距。横屏这条覆盖规则才是唯一的破口。

修法是把安全区加回去，再给一档呼吸：

```css
.ls #screen-records, .ls #screen-rank {
  padding-top: calc(var(--sa-top, 0px) + 16px);
  padding-bottom: calc(var(--sa-bottom, 0px) + 16px);
}
```

修后 844×390 下沿 34 / 安全区 21（富余 13），932×430 是 38，667×375 是 27。

**同一族的第二个破口**：`.ls #screen-room { padding-right: 480px }` 把 `--sa-right` 也吃了。
横屏的刘海在**侧边**，右栏按钮（准备/结束本局/离开房间）正好竖直居中落在刘海那一带。
改成 `calc(var(--sa-right, 0px) + 480px)`；绝对定位的 `.room-actions` 的 `right` 也要补同样的量
（`right` 量的是 padding box 外沿 = 屏幕边，padding 管不到它）。

## 26.3 横屏没有「最近 10 局」：不是没数据，是 `display:none`

```css
.ls.ls-tight .rp-trend { display: none; }
```

上一轮加它的理由是真的：左栏四块内容（546 设计像素）> 可视（约 470），
趋势必然落到折叠线下，而「每看一次战绩都要滑」也是被报过的毛病。
但删掉功能的代价没人算：**同一份数据，竖屏给、横屏不给**，玩家只会当 bug。

这轮把它的位置买回来，钱从别处出：

| 项 | 修前 | 修后 |
|---|---|---|
| 标题栏 `.rp-nav` | 112 | **88**（= 返回键最小热区，不能再小） |
| 汇总卡大数字 | 60 | 52 |
| 汇总卡内边距 | 18/16 | 18/16（试过 16/14，为观感退回） |
| 胜负平卡片留白 | 16/14 | 12/10 |
| 纪录条留白 | 18/16 | 12/12 |
| 趋势方块 | 54 | **40**（10 个 + 8px 间距 = 472 ≤ 612） |
| 「更早 / 最新」轴标签 | 有 | **横屏去掉**（换 26 设计像素，方向由标题与配色说清） |

结果：左栏内容 465 / 可视 478，**余量 13 设计像素，仍然不用滑**。

顺带挖出一个小 bug：左栏底部那层 26 设计像素的渐隐是**常驻**的，
内容装得下时它照样生效 —— 把最底下的趋势方块洗掉半截。那是内容，不是「下面还有」的提示。
改成 JS 按需挂 `.is-scroll`（`syncSumcolFade`，在数据渲染完与 resize 后各对一次账）。

## 26.4 更隐蔽的坑：横屏那一套被「短屏压缩」盖掉了

横屏手机的 `stageH` 恒为 750（`scale = availH / 750`），所以 `.compact-v`（`stageH < 1500`）
**一定**和 `.ls` 同时挂在 `#stage` 上。而 `.compact-v .rp-t` 和 `.ls .rp-t` 特异性相同，
`records.css` 又加载在 `style.css` 之后 —— 谁后加载谁赢。

被盖掉的实际后果（都是量出来的，不是猜的）：

- 趋势方块 36 → **46**（横向溢出，左右各被裁一点）
- `.rp-legend` 20 → 掉到 20 设计 px = **10.4 CSS px**，低于横屏 12 CSS px 的可读下限
  （上一轮刚立的规矩，被这一条静默废掉）
- 胜/负/平大数字 32 → **40**

修法：横屏这一组选择器统一写成 `#stage.ls ...`，抬一层特异性。
这不是「加个 id 压人」，是把「横屏版式压过短屏压缩」这条意图写进选择器里 ——
否则下次谁再往 records.css 里加一条 `.compact-v .rp-x`，横屏又会悄悄变形一次。

## 26.5 两种等待页：把「谁报名了」当成了「座位表」

```js
var seats = nextWait ? StateMachine.nextRoundPlayers(room) : room.players;
var slotCount = nextWait ? seats.length : CONFIG.MAX_PLAYERS;
```

`nextRoundPlayers()` 回答的是「谁点了开始下一局」，却被拿来当座位表。
于是同一个房间、同一个 `renderRoom`，两次进来看起来像两个页面：

| | 新开一局 | 继续下一把回房间 |
|---|---|---|
| 格子数 | 8（补满） | = 已报名人数（3 人就 3 格） |
| 空位 | 邀请卡 | 一张都不画 |
| 没报名的人 | —（都还没报名这一说） | **整张卡消失**，像被踢了 |
| 分数列 | `分 20` | `—`（藏起来） |
| 按钮 | 准备 / 补 AI / 结束本局 / 离开 | 准备 / 看上一局过程 / 上一局结算 / 回结算页 |

前四行是 bug，最后一行是产品规则（结算期不能补 AI、不能结束本局、要留一个后悔的出口）。

现在两边都按「房间里的全部玩家 + 补满 8 格」画，只有两处按状态换一句话：

- 还没报名的人 → 状态胶囊写 **「还在结算…」**（虚线描边 + 头像降透明），
  不再是一个灰座位 —— 灰 = 掉线 / 被踢，而他是「还在看回放」；
- 分数 → **「上局 26」**。上一局的分是真的，写 `—` 等于把信息藏了；
  加「上局」前缀又不至于被读成「下一局已经扣过分了」。
- 空位照旧是邀请卡、照旧能点：它做的是分享房间（链接 / 系统分享面板），
  跟「这一刻能不能入房」是两件事。

journey 里加了 4 条**结构指纹**断言（格子数 / 邀请卡数 / 每格四行结构 / 分数不是 `—`），
两屏形状一旦再跑偏就会红。

## 26.6 本轮验证

| 项 | 结果 |
|---|---|
| `npm test` | 67 文件 / **2416 项** / 0 FAIL / 58.6s |
| `journey` @390×844 | **106 项全过**（原 102 + 4 条座位表指纹） |
| `journey` @844×390 | **106 项全过** |
| `journey` @1112×511 | **106 项全过** |
| `probe-safearea`（新增） | **19 项全过**（4 视口 × 首页/战绩/排行榜/房间 + 横屏左栏余量） |
| `probe-landscape-screens` | 22 项全过 |
| `probe-modals-landscape` | 39 项全过 |
| `probe-records` | 20 项全过 |

`probe-safearea` 补上了 25.10 里写的那个洞：**把安全区做进 headless**。
headless 的 `env(safe-area-inset-*)` 全是 0，量不出问题；这个探针把 `resize()` 本来会写进
`#stage` 的 `--sa-*` 改成 iPhone 真机值（设计像素），于是「内容下沿 vs 安全区下沿」
变成一个可断言的数，而不是靠眼睛看真机截图。

## 26.7 评分

| 维度 | 25 章 | 本轮 | 依据 |
|---|---|---|---|
| 代码质量 | 9.5 | **9.5** | 安全区写进 calc；`#stage.ls` 让「横屏压过短屏」变成显式意图；渐隐改成按需 |
| 测试覆盖 | 9.7 | **9.8** | 新增安全区探针 19 项（补上第 25 章自己记的洞）+ journey 座位表指纹 4 条 |
| UI 一致性 | 9.2 | **9.5** | 两种等待页结构统一；横竖屏的战绩信息对齐（都有最近 10 局） |
| 交互合理性 | 9.3 | **9.4** | 「还在结算…」比灰座位/消失都准确；分数不再写成 `—` |
| PWA / 移动端 | 9.5 | **9.7** | 安全区这一层终于有回归守卫，不再只靠真机截图发现 |
| 产品完成度 | 9.2 | **9.3** | 底部不再贴 home indicator；横屏不再少一块信息 |

**加权：9.35 → 9.45。**

仍然不涨到更高：`--sa-*` 是注入的，不是真 `env()`；竖屏的字号下限还没立规矩（25.10 第 4 条仍未做）。

## 26.8 没做的事

1. **没有真机复验**。安全区数值是我按 iPhone 注入的（底部 21 / 两侧 47 CSS px），
   真机上的观感（尤其 667×375 那一档富余 11 CSS px）仍需横持看一眼。
2. **竖屏没有做字号下限**：横屏 12 CSS px 那条线至今没延伸到竖屏，这一轮又没动。
3. **平板 / 电脑横屏（stageH ≥ 900）**只是「不触发 `.ls-tight`」，趋势条的留白按新数值顺延，
   没有单独量过。
4. **8 人满员 + 就位态**没有真对局验证：journey 是 1 真人 + 1 AI，
   座位表指纹只覆盖了 2 人局。

---

# 第 27 章 · 结算期进不来人：房间从第一局打完就锁门了（20261030i / sw v67）

## 27.1 用户原话

> 为什么我点了继续下一句已经进入房间，但是我的朋友这里（他不在上一局），假如房间失败

截图是朋友那边：首页、昵称 `玩家G`、房间号已填，底部 toast
「这一局刚打完，正在结算，等下一局开始再进来」。

上一轮我刚把就位态的空位改回「邀请好友」（理由是「它做的是分享房间，
和这一刻能不能入房是两件事」），这条反馈正好打在那句话上：邀请得出去，人进不来。

## 27.2 不是「等几十秒」，是永久锁门

`joinRoom` 原来的闸门是 `room.phase !== PHASE.WAITING → 拒绝`。
而 `PHASE.WAITING` 在**整个状态机里只有 `newRoom` 那一处**会写：

| 时刻 | phase | 新人能进吗 |
|---|---|---|
| 建房 | WAITING | 能 |
| 开局后分牌 | ROUND1_SPLIT / ROUND2_SPLIT | 不能 |
| 这一把打完 | SETTLED | 不能（就是那句「正在结算」） |
| 点「开始下一局」 | **仍是 SETTLED**（刻意的，见 25 章） | 不能 |
| 下一局开打 | ROUND1_SPLIT | 不能 |

也就是说：**房间从第一局打完的那一刻起，对新人就是永久关闭的**。
不是「结算期这几十秒进不来」，是「这间房从今往后再也不接受新玩家」。
之前那句「结算期最长也就几十秒，说清了他愿意等」是错的 —— 没有「等一会儿」这个选项。

## 27.3 改法：结算期放行，进来的人自动算「要打下一局」

```js
var settling = room.phase === PHASE.SETTLED;
if (room.phase !== PHASE.WAITING && !settling) return { ok:false, code:'ROOM_PLAYING', … };
```

只放行 SETTLED，`ROUND*_SPLIT`（真在打）照旧拒绝，文案也照旧是「这局正在打，等这局结束再进来」。

进来的人必须带三个语义，少一个就出别的 bug：

| 字段 | 值 | 少了会怎样 |
|---|---|---|
| `wantNext` | `true` | `startNextRound` 里 `room.players = joiners` 会把他**静默丢掉**：人在房间里，新一局开始时凭空消失 |
| `ready` | `false` | 替他做「我准备好了」这个决定，全员到齐就自动开局，他可能还没看屏幕 |
| `joinedLate` | `true` | 前端会给他弹上一局的结算弹窗（他没打），分数还会写成「上局 20」 |

`joinedLate` 在新一局开始时清掉（`startNextRound` 里逐人归零），
否则他下一把真打完也看不到结算弹窗。

## 27.4 顺手补的一个洞：离开过的人回不来

`joinRoom` 之前的幂等分支是 `if (findPlayer(room, player.id)) return { ok:true }` ——
不看 `left`。而结算期离开的人（`leaveRoom` 只置 `left=true`，不删）**还占着那个座位**：
他再点加入 → 命中幂等分支 → 返回成功但 `left` 仍是 true →
之后点「开始下一局」永远回「你已经离开这一局了」。人进了房间，什么都干不了。

现在命中已有座位时先看 `left`：`true` 就把他复活（清 left / 重置手牌与分数 /
按结算期语义补 `wantNext`+`joinedLate`），不新增重复座位。

## 27.5 验证

| 项 | 结果 |
|---|---|
| `npm test` | **68 文件 / 2449 项** / 0 FAIL / 59.0s（新增 `server/test/join-settle.test.js` 19 项） |
| `journey` @390×844 | 106 项全过 |
| `journey` @844×390 | 106 项全过 |
| `next-round.test.js` | 81 项（原 68 项，改写 [8] 并新增 [8b] 13 项） |

新增的服务端测试是**三个真 WebSocket 客户端**：A/B 打完一局 → C 在结算期进房 →
三人一起开下一局，断言 C 手里有 6 张牌、没被 `startNextRound` 丢掉；
最后再断言「对局中进来的 D 仍然被拒」，防止放行被顺带放大。

单测里那条被改写的旧断言值得记一笔：它原来写的是
「结算期也进不来（房间还没重置，进去没有他的座位语义）」——
**这句注释在当时就是错的**：不是「没有座位语义」，是「再也进不来」。

## 27.6 评分

| 维度 | 26 章 | 本轮 | 依据 |
|---|---|---|---|
| 代码质量 | 9.5 | **9.5** | 放行条件收窄到一个 phase；三个语义字段各有用处并写在注释里 |
| 测试覆盖 | 9.8 | **9.8** | 新增三客户端端到端 19 项，覆盖「进来 → 被带进下一局 → 打起来又拒绝」整条链 |
| UI 一致性 | 9.5 | 9.5 | 本轮没动视觉 |
| 交互合理性 | 9.4 | **9.6** | 「房间打完一局就再也进不来人」是流程级死角，现在通了 |
| PWA / 移动端 | 9.7 | 9.7 | — |
| 产品完成度 | 9.3 | **9.5** | 邀请好友这条链路第一次真的闭环 |

**加权：9.45 → 9.55。**

这一轮涨得比前几轮多，是因为它不是打磨，是**一个功能级死角**：
「拉朋友一起玩」是这个游戏唯一的传播路径，而它从第一局之后就断了。

## 27.7 没做的事

1. **真机复验**：朋友从分享链接进来、进房、准备、开局这一整条路，还要你和他各拿一部手机走一遍。
2. **没有做「结算期进房后自动跳到房间页」之外的提示**：新人现在进来直接看到房间页，
   不知道「上一局刚结束」。要不要给一句「上一局刚结束，准备一下开下一局」，得看真机观感。
3. 本轮与第 26 章（h）**一起发布**：h 没单独上线，版本号直接记到 i。

---

# 第 28 章 · 「准备」按钮被按死（20261030i / sw v67，与 26/27 一起发布）

## 28.1 用户原话与截图

> 他说准备不了

截图（live v65）：房间 825301，3 人 —— 玩家C「已准备 ✓」、玩家B「已准备 ✓」、
玩家D「等待中…」，提示条「等待所有玩家准备…」，底部「准备」**是灰的、点不动**。

注意两个细节：按钮文案是「准备」而不是「准备中…」，也没有 busy 标记，
说明那次请求**已经结束**（成功或失败都算），并不是「提交中」卡住了 ——
是「disabled 被留在按钮上，而文案已经回到常态」这个组合。

## 28.2 根因：还原分支把 disabled 和文案绑在一起判断

```js
// pressBusy 的还原
if (btn.textContent === label) {
  btn.textContent = prevText;
  btn.disabled = prevDisabled;   // ← 一起被跳过
}
```

点「准备」时：`disabled = true`、文案 = 「准备中…」。
接下来这几秒里，**任何一次房间广播**都会让 `render()` 重写这个按钮的文案：

- 别人点了准备（最常见的那个）；
- 有人进房；
- 自己这单的回包 —— 它会先广播、再 resolve。

于 `await` 续上、走到 `finally` 时，文案已经不等于 label，**整块还原被跳过**，
`disabled` 就永久留在按钮上。按钮看起来写着「准备」，其实点不动，
之后再点也没用（`pressBusy` 第一步就被 `dataset.busy` 或 `disabled` 挡住），只能刷新。

`render()` 从来不写 `disabled` —— 也就是说这个属性**没有任何人接管**，
必须在还原里无条件还回去。原来的注释写「文案被别人改了 → 连 disabled 也交给它」，
可它根本没接。

## 28.3 为什么是「他」中招

触发条件是「准备请求在途的那几秒里有广播」。三个人的房间最容易踩：
A、B 陆续点准备，C 每点一次都可能与别人的广播交错。
弱网下更糟 —— 请求 8 秒超时（`roomStore.request` 的 timer），这 8 秒里别人早就准备完了。

所以「他说准备不了」不是他操作错了，是这场比赛里他每次点都撞在别人的广播窗口上。

## 28.4 改法

1. `pressBusy` 的还原里 `btn.disabled = prevDisabled` **无条件执行**，只有文案还按
   「有没有被别人接管」判断。
2. `renderRoom` 里给「准备」加一条自愈：每次房间广播都 `if (!readyBtn.dataset.busy) readyBtn.disabled = false`。
   万一将来又有哪条路径跳过整段 restore（页面被切走、promise 没续），
   下一次广播就能救回来，不用刷新页面。
3. 新增 `scripts/probe-ready-button.js`：本地模式（`setReady` 同步改状态 + 同步广播，
   **每次点击都必然踩中这条分支**）点一次准备、再点一次取消准备，
   断言 `disabled === false` / 文案正确 / 我这一格状态正确。修复前 4 项红，修复后 8 项绿。

## 28.5 验证

| 项 | 结果 |
|---|---|
| `probe-ready-button`（新增） | 修复前 **4 FAIL**（disabled 永久为真、二次点击无效）→ 修复后 **8 项全过** |
| `npm test` | 68 文件 / 2449 项 / 0 FAIL |
| `journey` @390×844 / @844×390 | 各 106 项全过 |

## 28.6 评分

| 维度 | 27 章 | 本轮 | 依据 |
|---|---|---|---|
| 代码质量 | 9.5 | **9.6** | 「谁拥有 disabled」这条边界写清了；多一条自愈 |
| 测试覆盖 | 9.8 | **9.9** | 新增按钮级探针，能在本地模式里**稳定复现**这个竞态（不靠弱网碰运气） |
| UI 一致性 | 9.5 | 9.5 | — |
| 交互合理性 | 9.6 | 9.6 | 按钮不再会「看起来能点、其实点不动」 |
| PWA / 移动端 | 9.7 | 9.7 | 弱网下这个问题最容易复发，现在有回归守卫 |
| 产品完成度 | 9.5 | **9.6** | 开局前的最后一道门不会再卡死一个人 |

**加权：9.55 → 9.62。**

## 28.7 没做的事

1. **没有真机复验**：修复要三个人再开一局才能验到，且最好在弱网下点准备。
2. **其他按钮只做了同一处修复，没有逐个探针**：`提交 / 创建 / 加入 / 补 AI / 下一局`
   都走 `pressBusy`，逻辑上一起好了，但它们的文案是否也会被 render 接管、
   接管后视觉是否合理，没有逐个量。
3. **没有做「准备失败后的自动重试」**：超时仍然是超时，只是按钮不会再死。

---

# 第 29 章 · 发布前复审：这批改动自己引入的两个 bug（20261030i / sw v67）

## 29.1 为什么先复审再发布

这一批没上线的东西太多了：26 章（底部安全区 / 横屏趋势条 / 等待页统一）+
27 章（结算期进房）+ 28 章（准备按钮）。三章之间互相改到同一批函数和同一张样式表，
而它们各自只验证了「自己那一处」—— 26 章改座位表来源，27 章改 joinRoom 放行条件，
28 章改按钮还原，谁也没回过头看前一个改动的假设还成不成立。

复审按「把这段代码当成别人写的」来做：先读 diff，再问每个改动的**前提**是什么。

## 29.2 问题 A：座位表用了 `room.players`（26 章引入）

26.2 把座位来源从 `nextRoundPlayers()` 改成 `room.players`，理由是「就位态只画报名的人，
人数一变整张网格重排」。方向对，但选错了数组：

| 阶段 | 离开一个人 | `room.players` | 座位语义 |
|---|---|---|---|
| WAITING | 从数组里删掉 | 少 1 | 一致 |
| SETTLED | 只置 `left=true`（分数还要结算） | **不变** | 不一致 |

于是两个后果：

1. **走了的人仍占着座位** —— 界面在说「他还在房间里」；
2. **满员时新人人间蒸发**：8 人房里有人离开、再来一个新人，
   `joinRoom` 判满用的是 `activePlayers`（7 < 8，放行），数组变成 9，
   而格子上限是 `MAX_PLAYERS = 8` —— 第 9 个正好是那个新人，
   他自己在房间里看不到自己的座位，别人也看不到他。
   这和第 27 章刚打开的「结算期能进人」直接对冲：门打开了，人进来了，但不在座位上。

修法是把「在场」这个概念收到状态机里，而不是让前端自己 filter：

```js
function roomSeats(room) { return room ? activePlayers(room) : []; }
```

前端 `var seats = StateMachine.roomSeats(room)`。
**座位表只认在场，人名单（分数、结算、投票）才认全部** —— 这句话现在有一处实现、
一处注释、一组单测。

## 29.3 问题 B：结算期才进来的人看到「上一局结算」（27 章引入）

`joinedLate` 这个标记当初只用来做两件事：不弹结算弹窗、分数不写「上局」。
但就位态还有两颗胶囊是 25 章加的：「看上一局过程」「上一局结算」。

一个刚点「加入房间」的人，屏幕上摆着别人的成绩单和别人的牌局回放 ——
他会以为这一局是自己打的。现在 `meLate` 一并挡掉这两颗，
他在这屏只需要做一件事：准备。

## 29.4 问题 C：横屏小字的「保护清单」其实是逐条点名的（25 章遗留）

25 章立过「横屏正文 ≥ 12 CSS px」，实现方式是几张挂了
`max(Npx, var(--ls-fs-floor))` 的规则 —— 也就是说**只有被点名的选择器受保护**。
26 章为了给「最近 10 局」腾高度又压了一轮留白，两边一叠加，一批 20/24 设计 px 的小字
掉在保护范围外。

这轮给 `probe-safearea` 加了一条「每个屏里最小的那段真文字」的断言，
一次把它们全量出来了（667×375 横屏，scale 0.4107）：

| 元素 | 设计 px | 修前 CSS px | 修后 |
|---|---|---|---|
| `.rp-glabel`「胜/负/平」 | 20 | **8.2** | 12 |
| `.player-status`「等待中…」 | 20 | **8.2** | 12 |
| `.rp-best-v i`「分」 | 20 | **8.2** | 12 |
| `.rp-people`「3 人」 | 20 | **8.2** | 12 |
| `.subtitle` / `.rank-tip` / `.rp-note` | 24 | **9.9** | 12 |
| `.rp-sum-label` / `.rp-meta-item` / `#rp-list-count` / `#room-hint` | 24 | **9.9** | 12 |
| `.rp-trend-title` | 22 | **9.0** | 12 |
| `.player-score` / `.invite-txt` / `#btn-copy` | 24 | **9.9** | 12 |

修法不再逐个打补丁（那样每跑一次探针只会暴露「当前最小值」那一个，要修十几轮），
而是收成一张**两组清单**（20 设计 px 组 / 24 设计 px 组），并在注释里写明
「这张清单是穷举，不是抽样；新增小字要一起加」。

两个实现细节值得记：

- 判「有没有被保护」要看**元素自己的** `computed font-size`，不能看父级。
  `<i>分</i>` 的父级 `.rp-best-v` 是 40 设计 px，单位却只有 20 —— 查父级永远查不出来。
- 清单必须写 `#stage.ls`：横屏手机的 `stageH` 恒为 750，`.compact-v` 一定同时挂在
  `#stage` 上，而 `records.css` 里的 `.compact-v .rp-glabel{20px}` 会把它盖回去。

探针同时把「图标」排除在统计之外（趋势色块里的 ▼、皇冠 emoji、头像首字）：
它们的含义由颜色和形状承载，字号裁到 7 CSS px 不影响阅读，混进来只会制造噪音。

## 29.5 一条旧契约测试被这次改动打破（这是好事）

`prev-result.test.js` 里有一条源码级断言：
`prevResBtn.classList.toggle('hidden', !nextWait)` —— 它守的是「只有就位态才显示上一局结算」。
加 `meLate` 之后这条立刻红。这说明「用字符串断言形状」的那类测试确实在守门，
而不是摆设。已按新语义更新，并补了一条 `meLate` 的断言，防止有人把 `|| meLate` 删掉。

同时把那条正则的搜索窗口从 600 字符放宽到 1000：断言写的是「这段附近的代码」，
而注释一多就会被截断 —— 截断后匹配失败是**假红**，比不测更费时间。

## 29.6 验证

| 项 | 结果 |
|---|---|
| `npm test` | **68 文件 / 2462 项** / 0 FAIL（新增 `[8c]` 12 项座位表断言 + 2 条契约断言） |
| `journey` @390×844 / 844×390 / 1112×511 / **667×375** | 各 **106 项**全过（新增最小屏一档） |
| `probe-safearea` | **31 项**全过（原 19 项 + 4 屏 × 3 个横屏视口的最小字号断言） |
| `probe-landscape-screens` / `probe-modals-landscape` / `probe-records` / `probe-ready-button` | 22 / 39 / 20 / 8 项全过 |
| 横屏战绩左栏余量 | 844×390 **9** 设计 px（阈值 8）、932×430 16、667×375 120 —— 仍是一屏装下 |

`[8c]` 是这轮最重要的新测试：8 人房 → 结算期离开 1 人 → 新人进房，
断言 `players.length === 9`、`roomSeats().length === 8`、新人在座位表里、离开的人不在。
它把「数组长度」和「座位数」这两个一直混着用的概念钉开了。

## 29.7 评分

| 维度 | 28 章 | 本轮 | 依据 |
|---|---|---|---|
| 代码质量 | 9.6 | **9.7** | 「在场」这个概念收进 `roomSeats`；小字清单从散落补丁收成一张表 |
| 测试覆盖 | 9.9 | **9.9** | 新增座位表单测 + 字号守卫；但字号断言仍是「逐条清单」，不是自动兜底 |
| UI 一致性 | 9.5 | **9.6** | 走了的人不再占座；新人能看到自己的座位 |
| 交互合理性 | 9.6 | **9.7** | 新人不再被塞一张别人的成绩单 |
| PWA / 移动端 | 9.7 | **9.8** | 最小屏（667×375）第一次纳入全量回归 |
| 产品完成度 | 9.6 | **9.7** | 26/27 两章的功能第一次能同时成立 |

**加权：9.62 → 9.72。**

## 29.8 没做的事 / 剩余风险

1. **真机复验仍然缺**：这些都是 headless 里量的，安全区按 iPhone 注入。
   朋友进房 / 准备 / 横屏底部这三条要两部手机走一遍才算完。
2. **844×390 左栏余量只剩 9 设计 px**（阈值 8）。不同系统字体的度量差异有可能把它挤过线，
   真机上如果看到左栏出现滚动条，就得从 `#rp-sum` 或 `.rp-trend` 的间距里再抠 4px。
3. **8 人满员的就位态没有真对局验证**：`[8c]` 是状态机层面的，真实 8 个客户端同时
   在结算期进出没有压过。
4. **竖屏字号下限仍未立**：`--ls-fs-floor` 只在横屏生效，竖屏 20 设计 px 就是 20 CSS px，
   目前没有量过、也没有规矩。

---

# 第 30 章 · 第一轮的「十点半优先」与爆点警告（20261030j / sw v68）

## 30.1 需求原话

> 在第一轮出牌时，需遵循一个优先原则：若有能力组合出「十点半」且不致爆点
> （可以不刚刚好十点半，只要不爆点就行），须将此作为首选策略。在此前提下，
> 玩家可以自由搭配第一轮三组牌，如果不符合规则强行凑爆点，需要在放牌进牌池时
> 给出警告，警告符合整体 ui 设计风格。

拆成四件事：判定口径、提示时机、提示强度、视觉。

## 30.2 判定口径：只约束一组，只约束两条

第一轮三组是 `single`（1 张）/ `tenhalf`（2 张）/ `piaosanye`（3 张）。
「自由搭配」这句把范围说死了：**只约束 tenhalf 组**，另外两组随便配。

约束两条，按优先级：

1. **能不爆就不许爆** —— 手里存在「两两相加 ≤ 10.5」的组合时，放一对爆的就算违背；
2. **能凑 10.5 就优先 10.5** —— 10.5 是这组的满分（`TENHALF_MAX_WIN`），能拿到就别丢。

明确**不**要求「必须最大」：9 点 vs 手里能到 9.5，不提示。用户的原话是
「可以不刚刚好十点半，只要不爆点就行」—— 多管一条就会变成烦人的教练。

判定写在状态机里（`tenHalfAdvice`），不是界面里：

- 王（joker）在十点半里要**先解析成某张牌**再算点数（`engine.resolveTenHalf` 枚举
  48 张候选取最优不爆）。这套解析只有 engine 有一份，界面再写一遍必然跑偏，
  而跑偏的后果是「提示说 10.5、结算算成 11」——那比不提示更糟；
- 点数用「十分之一」整数（105 = 10.5），和 engine 完全同口径，不碰浮点。

返回的 `kind` 有四种，界面按它决定强度和文案：

| kind | 场景 | 界面 |
|---|---|---|
| `must-bust` | 刚放的那张，配手里哪张都爆 | 红，且分两种话（见 30.5） |
| `bust` | 组已满且爆，换一张能不爆 | 红 + 建议那两张 |
| `worse-bust` | 组已满且爆，怎么换都爆，但能少爆 | 红 + 「最少也得 N 点」 |
| `miss` | 没爆，但手里能凑 10.5 却没凑 | 琥珀（不吓人） |

## 30.3 三层提示：放牌那一刻、槽位上、提交前

只做「放牌弹一句」是不够的 —— 玩家放完可能转头去看别的组，回头已经忘了。

1. **放牌时**：toast + 槽位左右摇一下（±6px，340ms）+ 错误音。摇动是因为
   注意力在刚落牌的槽位上，而 toast 在屏幕下方。
2. **槽位上常驻**：十点半组满 2 张就挂一个点数胶囊
   （`10.5` 绿 / `9.5` 金 / `爆 12` 红），整组的左竖条也跟着变红。
   这是提交前最后一道自检，玩家扫一眼就知道这组废没废。
3. **提交确认框**：`groupsSummary` 后面追加一句
   「⚠ 十点半 12 点，爆了 —— 这一组会输」。

第 3 层只提爆点，**不提「其实能凑 10.5」**：三组是互相抢牌的，他可能是
故意把那张 10 留给飘三叶去凑豹子，这时候劝他改反而是错的。

## 30.4 为什么只警告、不拦截

「须将此作为首选策略」听起来像硬性规则，但拦截会把玩家卡死：
六张全是大牌时（10/10/10/9/9/9）**怎么配都爆**，此时禁止提交等于让这局无法进行。

而且爆点本身是「这组会输」，不是「这步非法」—— 双爆时爆得少的还占优
（`compareTenHalf`：都爆则比总点数，小的赢）。玩家有权接受这个损失。

所以：**提示说尽，操作放行**。真要做成禁止提交，得服务端一起改（见 30.8）。

## 30.5 文案上的两个坑

**坑一：「换一张」有时是骗人的。** `must-bust` 只说明「刚放的这张配什么都不行」，
但如果整手牌都爆（六张大牌），让他「换一张」就是假建议。所以分两种话：

- 换别的能救 → 「这张放十点半，配哪张都会爆 · 换一张」
- 整手都爆 → 「这手牌怎么配都爆 · 最少也得 16 点」

**坑二：自己和自己配对。** `tenHalfAdvice` 收的是整手牌，函数内部先剔掉
已经放进组里的那张。否则会算出「换 10♠ 能到 10.5」，而那张 10♠ 就是玩家刚放下的。
把「算剩余手牌」这件事交给调用方是重复劳动，漏一次就出这种提示。

## 30.6 视觉：和牌桌同一套语言

牌桌是深绿毡面 + 细描边 + 低饱和底，纯红色块会跳得像系统弹窗。所以：

| 元素 | 处理 |
|---|---|
| toast `.warn` | 深红底 `rgba(52,12,12,.94)` + 2px 红描边 + 阴影，字色 `#FFE7E7` |
| toast `.hint` | 深琥珀底 + 金色描边（「可以更好」，不是错误） |
| 点数胶囊 | 与 `.slot-progress` 同尺寸同圆角；金/绿/红三态沿用点数体系的三色 |
| 爆点槽位 | 左侧竖条换成 `--up-red`，组名转粉红 —— 扫一眼就知道这组废了 |
| 摇动 | `slotNudge` 340ms，`prefers-reduced-motion` 由全局规则降到 0.01ms |

橙色和金色在这套皮肤里已经表示「分数/点数」，红色表示「输」，所以颜色没有新词。

## 30.7 验证

| 项 | 结果 |
|---|---|
| `pwa/test/tenhalf-priority.test.js`（新增） | **52 项全过** —— 含四条 kind、王解析、自己和自己配对、与 engine 逐条对照 |
| `scripts/probe-tenhalf.js`（新增） | 竖屏 **15 项** / 横屏 **16 项**全过 |
| `npm test` | **69 文件 / 2514 项** / 0 FAIL |
| `journey` @390×844 / 844×390 / 1112×511 / 667×375 | 各 106 项全过 |
| `probe-landscape-screens` / `probe-modals-landscape` | 22 / 39 项全过 |

浏览器探针做的是真事，不是读源码：

1. 随机开一局，从六张手牌里**找出**一对「怎么算都爆」的牌放进去
   → 断言 `.slot.is-bust` + `.slot-point.bust` + toast 带 `warn` + 文案含「爆/换」；
2. 重开直到抽到「10 + 半点」或「王 + 10」→ 断言绿色 `.slot-point.best`、显示 10.5、
   没有红色警告；
3. 把三组填满、提着爆点去点提交 → 断言确认框正文含「爆」与「会输」。

探针里有一条踩过的坑值得记：本地演示模式只有一个人，而开局要 2 人、
补 AI 在 local 下是禁用的。为了不进「真服务端 + 注册账号」那一整套，
探针把 `CONFIG.MIN_PLAYERS` 临时改成 1 —— 发牌/分组/落子/提交校验都不看人数下限，
单人局能完整走完分牌页。**只改测试路径，不改产品代码。**

## 30.8 评分

| 维度 | 29 章 | 本轮 | 依据 |
|---|---|---|---|
| 代码质量 | 9.7 | **9.8** | 规则判定收在状态机纯函数里，界面只负责表达；与 engine 同一套解析 |
| 测试覆盖 | 9.9 | **9.9** | 规则 52 项 + 浏览器探针 15/16 项；但「怎么配都爆」的手牌靠随机碰，没穷举 |
| UI 一致性 | 9.6 | **9.7** | 胶囊/描边/摇动沿用现有语言；点数胶囊补进了横屏小字清单 |
| 交互合理性 | 9.7 | **9.8** | 三层提示各管一个时机；不拦操作，避免「怎么配都爆」时卡死 |
| PWA / 移动端 | 9.8 | **9.8** | 横竖屏都验过，toast 无溢出 |
| 产品完成度 | 9.7 | **9.8** | 「首选策略」第一次有了可执行的反馈，而不只是规则页上的一句话 |

**加权：9.72 → 9.78。**

## 30.9 没做的事 / 需要确认的

1. **服务端不校验这条规则**：现在只是前端提示 + 提交确认。若要做成「禁止提交」，
   `submitGroups` 要一起改，并且得先解决 30.4 里「怎么配都爆」的死锁（例如只在
   「存在不爆方案」时拒绝）。
2. **「怎么配都爆」的手牌没有穷举测试**：只在探针里随机碰到过。
3. **提示频率没有做抑制**：连续放错会连续弹 toast。目前靠 2.6 秒自动消失 +
   只有组状态变化才弹（同一状态重复放会重复弹），真机上若觉得吵可以加「同一句 5 秒内不重复」。
4. ~~规则页没同步~~：已补。十点半那条 `dd` 里加了一句
   「第一轮优先不爆：能凑出不爆的组合时别放会爆的；能凑 10.5 就先凑 10.5。
   放牌时会当场提醒，但不拦你」——**要写清「不拦」**，否则玩家会以为界面坏了。

---

# 第 31 章 · 提示只在该出现时出现（20261030k / sw v69）

## 31.1 用户原话

> 如果有不爆的多组选择 比如可以组合十点半和其他 不要提示 这样会影响游戏竞技性

这一句是在改第 30 章刚做的那条规则 —— 不是加需求，是**撤掉过度的那一半**。

## 31.2 撤掉的是哪一档

第 30 章的判定返回四种 `kind`，其中只有一种是「没爆」：

| kind | 状态 | 第 30 章的处理 |
|---|---|---|
| `must-bust` | 爆 | 红，急 |
| `bust` | 爆 | 红，并建议换哪两张 |
| `worse-bust` | 爆 | 红，说最少也得几点 |
| **`miss`** | **没爆**，但手里能凑 10.5 却没凑 | **琥珀，「手里能凑 10.5 · 用 10♠ + K」** |

`miss` 就是用户说的那个场景：手里同时有几组都能不爆，玩家没选那组 10.5。
它现在被整个删掉 —— 没爆就返回 `null`，一个字都不说。

## 31.3 为什么它不只是「吵」，是会改掉这个游戏

第 30 章写这一档时的理由是「10.5 是这组的满分，能拿到就别丢」，这个理由本身没错，
错在把它当成了必须执行的规则。实际坐下来玩，第一轮三组是**互相抢牌**的：

假设手牌是 `10♠ K♥ 9♦ 9♣ 4♠ 2♦`，三组要分。

| 方案 | 十点半 | 飘三叶 | 比大小 | 结果 |
|---|---|---|---|---|
| A（界面推荐的） | 10♠ + K♥ = 10.5 | 9♦ 9♣ 4♠ = 散牌 | 2♦ | 十点半吃 2 分，另两组大概率输 |
| B（玩家选的） | 9♦ + K♥ = 9.5 | 10♠ 9♣ ? | … | 十点半也有得打，另外两组牌力更强 |

哪个更好要看对手和对局，**这是策略，不是错误**。一旦界面弹一句
「手里能凑 10.5 · 用 10♠ + K♥」，等于每局由程序宣布最优解，
而且它只看到十点半这一组，看不到另外两组 —— 它给的建议甚至是**局部最优、全局更差**的。

所以删掉它的理由不是「打扰」，是：**它把一个多人对局的博弈，降级成了「照着提示点」**。

## 31.4 同一类问题：`bust` 也不该点名换哪两张

顺着这条往下看，第 30 章的 `bust` 文案也有同一个毛病：

```
十点半爆了（20 点）· 换 8♠ + 2♦ 能到 10
```

`best` 取的是全手牌里**点数最大**的那个不爆组合 —— 也就是「最优解」。
爆了确实必须警告（这组会输），但「用哪两张救」是玩家的策略选择，
尤其当他打算把那两张里的一张留给飘三叶时。

现在改成：

```
十点半爆了（20 点）· 这组会输，手里有不爆的组合
```

保留「还有救」这三个字是必要的：「爆了就必输」和「爆了但能救」是两种处境，
不说清楚他会以为已经没救了，直接放弃这一组。但**具体怎么救，他自己算**。

## 31.5 留下的三层，一层都没少

| 层 | 内容 | 这一轮 |
|---|---|---|
| 放牌时 | 红色 toast + 槽位摇动 + 错误音 | 保留，文案去掉牌名 |
| 槽位上 | 常驻点数胶囊（10.5 绿 / 9.5 金 / 爆 N 红）+ 左侧红竖条 | 保留（这是**事实**，不是建议） |
| 提交时 | 确认框里「⚠ 十点半 15 点，爆了 —— 这一组会输」 | 保留，本来就不点名 |

三层里只有「放牌时」那一条说过策略，其余两条都只是陈述状态。
这也解释了为什么该删的只有一处：**胶囊写「9.5」是事实，弹窗写「你该用 10 + K」是教练。**

## 31.6 顺带修的样式叠加

`.slot.is-bust { border-left-color: var(--up-red) }` 写在 `.slot.is-active` 之前，
而 `.is-active` 同样设 `border-left-color: var(--slot-color)` —— 特异性相同、后者在后，
谁赢看顺序。于是玩家点回十点半组（想看清那两张牌）时，它会同时是 `.is-active` 和 `.is-bust`，
**左侧那根红竖条被改回组色**，最直观的「这组废了」信号被「这是当前组」盖掉。

加一条 `.slot.is-bust.is-active`（0,3,0 特异性）钉住红色。
探针里为此加了一条断言：手动挂 `is-active` 后量 `borderLeftColor === rgb(255, 93, 93)`。
不能直接点那个格子 —— 那会触发 `onSlotCardTap`，把牌收回去。

## 31.7 验证

| 项 | 结果 |
|---|---|
| `pwa/test/tenhalf-priority.test.js` | **52 项全过**（`[2]` 整段反转为「不提示」，新增 3 组「多个不爆方案」用例） |
| `scripts/probe-tenhalf.js` @390×844 | **23 项全过**（原 15 + 新增「静默」6 项 + 竖条 1 项 + 文案 2 项） |
| `scripts/probe-tenhalf.js` @844×390 | **23 项全过** |
| `npm test` | 69 文件 / **2514 项** / 0 FAIL |
| `journey` 四档 | 各 **106 项**全过 |
| `probe-safearea` / `probe-ready-button` | 31 / 8 项全过 |

新增的探针段 `[2b]` 是这一轮的核心，它**构造**出用户描述的那个局面：
在随机手牌里找一对「不爆、但不是 10.5」的牌，同时要求整手牌里确实存在另一组 10.5，
放进去之后断言 `toast` 完全不可见。实测抽到的局面：

```
手牌 K♥ 9♦ 10♣ 6♥ J♦ 3♣   →   放了 K♥ + 9♦（9.5 点，手里另有 10♣ + K♥ 的 10.5）
结果：toast hidden、胶囊 9.5 金色、无红竖条
```

单测侧把 `[2]` 从「有提示」整段反过来写，并留了完整理由的注释 ——
下一轮如果有人觉得「10.5 是满分，提一下怎么了」，那里有现成的反驳。

## 31.8 评分

| 维度 | 30 章 | 本轮 | 依据 |
|---|---|---|---|
| 代码质量 | 9.8 | **9.8** | 删掉一个分支、一句文案、一段 CSS；`best` 仍保留用于内部判断 |
| 测试覆盖 | 9.9 | **9.9** | `[2]` 反向重写 + `[2b]` 构造真实局面；剩余风险仍是「全爆手牌靠随机碰」 |
| UI 一致性 | 9.7 | **9.75** | 修掉 `is-bust` 被 `is-active` 盖色的叠加 bug |
| 交互合理性 | 9.8 | **9.9** | 提示收窄到「这组会输」一种；不再替玩家打牌 |
| PWA / 移动端 | 9.8 | 9.8 | — |
| 产品完成度 | 9.8 | **9.85** | 「不爆」成为唯一底线，剩下的完全交给玩家 |

**加权：9.78 → 9.83。**

## 31.9 没做的事 / 需要确认的

1. **`must-bust` 里「最少也得 N 点」还留着**。它发生在「怎么配都爆」的手牌上，
   此时不存在不爆方案、也就没有策略空间，所以我判断它是规则信息而不是建议。
   如果你觉得连这句也不该说，改成「这手牌怎么配都爆」即可（一行）。
2. **提交确认框的爆点提醒仍是「告诉结果」**，没有改成拦截；理由见 30.4。
3. **真机复验仍未做**：这一轮改的是文案与判定，肉眼最直接的验证是「放一对 9.5 时界面是否完全安静」。

---

# 第 32 章 · 必爆闭嘴，以及 PWA 底部那条色带（20261030l / sw v70）

## 32.1 用户原话

> 只有没有不爆的牌选了爆点牌才有提示 你说的必爆的情况 任何提示不给都是可以的
>
> 现在横版和电脑端 会全局适配去掉底部留空，但是我发现 pwa app 底部还是会留空，
> 但手机浏览器打开就没有，看起来像是强行适配了浏览器，写死后导致 pwa
> 没有底部导航也会被留空，这里也要解决

两件事，一件是**回答 31.9 的悬置问题**，一件是**真机新报的 bug**。

## 32.2 第一件：把 31.9 那条悬置的提示也删掉

第 31 章结尾留了一句「`must-bust` 里『最少也得 N 点』还留着，如果你觉得连这句也不该说，
改成『这手牌怎么配都爆』即可」。用户的回答比这个更彻底：**必爆时一个字都不用说**。

于是判定口径收敛成一句话：

> **手里还留着不爆的打法、玩家却选了爆的 —— 才提示。整手必爆，闭嘴。**

`tenHalfAdvice` 的三种 kind 变成两种：

| kind | 触发条件 | 本轮 |
|---|---|---|
| `must-bust` | 刚放一张，配手里**任何**一张都爆，**但换两张还能不爆** | 保留 |
| `bust` | 组已满且爆了，**但换一对就能不爆** | 保留 |
| ~~`worse-bust`~~ | 组已满且爆了，怎么换都爆，只是能少爆一点（20 → 19） | **删除** |
| ~~`must-bust`（整手全爆那支）~~ | 六张全是大牌，怎么配都爆 | **删除（静默）** |

删掉的理由不是「话太多」，而是**这句话在骗人**。

「双爆时爆得少的占优」是 engine 的比牌口径，它成立的场景是**两个人**都爆、要比谁爆得少。
而玩家此刻面对的是「我这一组 20 点，怎么换都是 19/20 点」—— 他知道了也赢不了，
因为这组的输赢由对手的牌决定，不由这 1 点决定。把这句当建议说出来，
等于把**运气问题**说成**操作问题**，玩家下次会以为自己只是没调好。

现在的界面只在一种处境里出声：

```
十点半爆了（20 点）· 这组会输，手里有不爆的组合
这张放十点半，配哪张都会爆 · 换一张
```

两句的共同点：**都指向一个真实存在的、更好的不爆方案**，但都不说具体是哪两张。

## 32.3 第二件：底部那条色带不是留白，是露底

先看用户给的截图。底部有一条**上边界笔直的水平色带**，没有光斑、颜色均匀。
设计上的「留白」（`.screen` 的 `padding-bottom`）不会画出边界 —— 背景是铺满整个 `.screen` 的。
所以这条线一定是**两个元素的交界**：舞台上边，下面只剩 `#viewport` 的底色。

真正的元凶是竖版这一行：

```js
stage.style.height = (vh / scale) + 'px';     // vh = #viewport.clientHeight
```

舞台高度是**那一刻量到的像素值**，写死成内联样式。

在桌面 Chromium 里我复现不了这个问题 —— 三种 env 注入（基线 / `padding-bottom:34px` /
再加 `--sa-bottom:65`）跑下来，`stage.bottom` 都精确等于视口底，`gap = 0`。
因为浏览器里 `clientHeight` 与可视区一致。

但 iOS「添加到主屏幕」之后，应用被系统接管，这个读数会**比真实视口小一截**
（灵动岛 / 实时活动占用的那条区域有时不计入）。舞台按小的高度画，底部就露出底色。
浏览器打开时读数正常，所以「同一个链接，只有 PWA 有问题」。

这和第 26 章横屏那条「底部一条深色带」是**同一个病**：

| | 第 26 章（横屏） | 第 32 章（竖版） |
|---|---|---|
| 症状 | 横屏底部一条深色带 | PWA 竖屏底部一条纯色带 |
| 原因 | `stage.style.height` 写成死值，容器变高后没收到 resize | 同上，且读数本身在 iOS standalone 下偏小 |
| 修法 | `#stage.ls { height: calc(100% / --ls-scale) }` | `#stage:not(.ls) { height: calc(100% / --pt-scale) }` |

当时只修了横屏，竖版留着同样的死值 —— 因为竖版「在浏览器里一直是对的」。

## 32.4 顺带被这条读数带歪的第二个东西

`vh` 不只决定舞台高度，还喂给 `stageH = vh / scale`，而 `stageH` 是 `.compact-v`
（短屏压缩）的判据：

```js
stage.classList.toggle('compact-v', stageH < 1500);
```

读数偏小 66 CSS px → `stageH` 从 1623 掉到 1496 → **不满足条件的 Pro Max 也被判成短屏**，
战绩页的间距和字号会凭空被压一档。这个副作用比「底部露色带」更隐蔽：
玩家只会觉得「我这台手机上的字怎么比截图里小」。

所以视口尺寸改成了 `getBoundingClientRect()`：

```js
var vpRect = vp.getBoundingClientRect();
var vw = Math.round(vpRect.width) || vp.clientWidth;
var vh = Math.round(vpRect.height) || vp.clientHeight;
```

`rect` 走的是布局几何，不经过那层读数。

## 32.5 一条能在 Chromium 里复现的探针

问题出在「iOS 报的数不对」，桌面端天然复现不了。但**可以把那个错误读数直接打进页面**：

```js
// 只让 #viewport 的 clientHeight 少 66，CSS 视口不动
Object.defineProperty(Element.prototype, 'clientHeight', {
  get() { return this.id === 'viewport' ? raw - 66 : raw; }
});
// 顺便把 display-mode: standalone 打成 true
```

这正是真机上的错位：**JS 以为屏幕矮了，CSS 其实铺满**。于是不需要 iPhone 也能回归：

| 场景 | 改前 stage 底边 | 改后 stage 底边 |
|---|---|---|
| 390×844 浏览器 | 844 | 844 |
| 390×844 PWA 读数偏小 66 | **778（露 66px 底色）** | **844** ✓ |
| 844×390 横屏 | 390 | 390 |

`scripts/probe-viewport-fit.js` 把这个做成了 9 项断言，包括：

- 舞台底边与视口底边相差 ≤ 1 CSS px（三档各一条）
- 内联 `height` 必须是空字符串（**防的就是有人哪天又把它写回死值**）
- `.pwa` 只在 standalone 下挂上（浏览器里挂上会因 `min-height:100vh` 白裁底部留白）

第二条是关键：这个 bug 的复现条件是「真机 + PWA」，人不会天天拿手机验收，
所以必须留一条**代码层面**的守卫，而不是只留一句注释。

## 32.6 第二道网：`min-height: 100vh`

如果 iOS 把「视口本身」也报小（不只是 `clientHeight`），那 `calc(100% / --pt-scale)`
也会跟着矮。所以 PWA 模式下加一层：

```css
#stage.pwa:not(.ls) { min-height: calc(100vh / var(--pt-scale, 1)); }
```

只在 `standalone` 下挂 `.pwa` —— 浏览器里工具栏弹出时 `100vh` 会大于 `100%`，
无差别启用会白白把底部留白裁掉一截（用户之前抱怨的「贴边」就是裁过头的后果）。

## 32.7 验证

| 项 | 结果 |
|---|---|
| `scripts/probe-viewport-fit.js`（新增） | **9 项全过**（竖屏浏览器 / 竖屏 PWA 读数偏小 / 横屏） |
| `probe-safearea` @390×844 + 844×390 | **13 项全过**：竖屏首页下沿 210 / 战绩 70 / 排行榜 137 / 房间 96 CSS px，安全区 34 |
| `pwa/test/tenhalf-priority.test.js` | **49 项全过**（`[4]` 整段反转为「不提示」，`[5]` 换用例） |
| `npm test` | 69 文件 / **2511 项** / 0 FAIL |

两处口径变化都写进了测试，且都是**反向重写**而不是删掉：

- `[4]` 原来叫「怎么换都爆：只能说『最少也得多少』」，现在叫「整手怎么配都爆：不提示」，
  用例是 `10+10 手里有 9`（20 → 19 也不说）与 `三张 10`。
- `[5]` 的 `must-bust` 用例从「放了 10，手里两张 10」换成
  `10♠ + (2 / A / 10♥)` —— 配谁都爆，但 2+A 本身不爆，这才是「放错组」的真实局面。
  三张 10 那个局面现在断言 `null`（说不出「换一张」这种话，因为是骗人的）。

> 探针用的是 `file://` 而不是本地 HTTP：这台机器上 headless Edge 连不上 127.0.0.1
> （连接被拒），而 `game.js` 本来就把 `file://` 当本地演示模式，行为与 `?mode=local` 一致。

## 32.8 评分

| 维度 | 31 章 | 本轮 | 依据 |
|---|---|---|---|
| 代码质量 | 9.8 | **9.85** | 竖版和横屏终于用同一套「CSS 反算」；kind 从 3 收敛到 2 |
| 测试覆盖 | 9.9 | **9.9** | 新增一条能复现真机错位的探针；两条口径测试都是反向重写 |
| UI 一致性 | 9.75 | 9.75 | — |
| 交互合理性 | 9.9 | **9.95** | 提示只剩「还有不爆打法」一种前提，规则彻底不干预策略 |
| PWA / 移动端 | 9.8 | **9.9** | 底部露底修掉；仍待真机验收 |
| 产品完成度 | 9.85 | **9.9** | 玩家看到的每一句话都指向一个真实可行的替代方案 |

**加权：9.83 → 9.87。**

## 32.9 没做的事 / 需要确认的

1. **真机还没验。** 这一条必须由你在 iPhone 上「添加到主屏幕」打开一次才算完：
   底部色带没了 → 说明是 `clientHeight` 读数问题（已修）；
   还在 → 说明系统连视口一起报小，`min-height:100vh` 是第二道网，两道都失效再加
   `visualViewport.height` 兜底。**别只看浏览器，浏览器本来就是好的。**
2. **首页内容距底部 210 CSS px**（`probe-safearea` 竖屏首页那一行）。这不是 bug，
   是 `.screen` 的 `padding-bottom: 120 设计px` + 首页内容的自然余量。
   如果你觉得「色带修完还是显得空」，那是这一档设计留白，单独调一个数即可。
3. **`#viewport` 上的 `padding-bottom: env(safe-area-inset-bottom)` 是死代码。**
   `#stage` 是绝对定位，containing block 是 padding box，那层 padding 对子元素不起作用；
   真正避让安全区的是 `.screen` 的 `--sa-*`。本轮没删（删了要重跑全部布局探针），
   记在这里，下次动布局时顺手清掉。


---

# 第 33 章 底部色带的第二种成因：视口读数本身是小的

## 33.1 先说流程错误：让用户在没有发布的情况下去验

32 章把「竖版舞台高度」修好之后，我请用户在 iPhone 上删掉桌面图标重装一次验证。
用户照做了，截图里那条色带**一模一样**。然后他说了一句必须记下来的话：

> 「你没发布这个就不会被修复啊。」

他是对的。本地改完、测完，线上仍然是 `20261030g / sw v65`；删图标重装只是
重新下载了**线上那份旧包**，验证的对象根本不是我改的代码。

**规程（以后照做）**：凡是「只有在真机上才能看出差别」的修复，必须**先发布、再请人验**。
本地探针能证明的只是「逻辑按预期走」，证明不了「线上已经是新逻辑」。
请人验之前先贴一次线上 `/api/health` 的版本号，和本地比。

## 33.2 先把截图量成数字

用户截图 1023×2224（原始 393×852 @3x 缩放后）。逐行取平均色：

| 量 | 值 |
|---|---|
| 色带起点 | y = 2079 / 2224，**占屏高 6.52%** |
| 色带内颜色 | (15, 43, 34) = `#0F2B22`，零方差，**全宽完全均匀** |
| 边界 | 2078→2080 两行内完成过渡，**1~2 px 的硬边** |

两条结论：

1. **纯色零方差**说明这不是背景图（`home_bg.webp` 有光斑、有渐变，平均色会随 x 变），
   而是 `#viewport` 那条 `radial-gradient` 的尾段（62% 之后恒为 `--green-deep`）。
   所以色带在舞台**之外**、`#viewport` 之内 —— 还是「舞台比视口矮」。
2. 用 logo 的金色描边反推比例：描边外沿 168 设计px 量到 226 图像px，
   `1023 / 750 = 1.364` 图像px/设计px，两种算法互相印证。
   色带 145 图像px ÷ 2.603（图像px / CSS px）= **55.7 ≈ 56 CSS px**。

## 33.3 56 这个数字推翻了上一版的修法

上一版（32 章）的判断是「`clientHeight` 读小了，CSS 的 `100%` 是对的」，
于是把高度交给 `calc(100% / --pt-scale)`。这在「只有 JS 读数错」时成立 ——
探针第 2 档（只把 `clientHeight` 减 66）确实从 778 修到 844。

但真机上还留 56 CSS px，说明 **CSS 的 `100%` 也跟着小了**：布局视口本身被报成
852 − 56 = 796。这一档 `100%` 和 `100vh` 一起变小，纯 CSS 反算无从挽救 ——
32 章的第二道网 `min-height: 100vh` 同样无效，因为它和 `100%` 是同一个数。

（`position: fixed; inset: 0` 的 `#viewport`、`html/body` 的 `inset: 0` 全都基于
布局视口。iOS 在若干情况下会把它报小：键盘收起后没恢复、实时活动/灵动岛占位残留、
后台挂起恢复时布局未完成。56 这个数在不同机型上未必相同，所以不能按数值硬补。）

## 33.4 修法：standalone 下用物理屏高校正

`screen.height` 是**独立于视口**的另一条读数，standalone 的定义就是「应用独占整块屏」，
所以它在这个模式下就是内容区高。浏览器里绝不能这么干（`screen.height` 是整块显示器）。

```js
if (standalone && vw < vh && window.screen && window.screen.height) {
  var sh = Math.round(window.screen.height);
  if (sh > vh && sh - vh <= Math.round(vh * 0.18)) { screenH = sh; vh = sh; }
}
```

两道护栏，都是为了不把「分屏/多任务窗口」误判成全屏：

- **只往上修**：读数偏大时不动（那多半是浏览器工具栏还没收起，越修越糟）；
- **只修差得少的**（≤ 18%）：差太多说明这个窗口本来就不是全屏，宁可不动。

校正后的高交给 CSS 作 `min-height` 的依据（`--pt-h`），取「`100%` 与校正值中大的那个」：

```css
#stage.pwa:not(.ls) { min-height: calc(var(--pt-h, 100vh) / var(--pt-scale, 1)); }
```

为什么是 `min-height` 而不是直接写 `height`：`100%` 在**正常**的 PWA 里是对的，
没有理由因为一次异常就永久接管；`min-height` 只在「`100%` 算出来比它小」时才生效，
正常机型上这行等于不存在。舞台超出 `#viewport` 的部分照常绘制（`#viewport` 没有
`overflow: hidden`），舞台自己带背景，所以多出来的 56px 是内容区而不是底色 ——
首页底部那 120 设计px 的留白正好吃掉它。

## 33.5 `?diag=1`：让真机自己把数字说出来

真机上没有控制台。加了 `?diag=1` 后左上角常驻一块读数，`game.js::updateDiag` 每次
resize 刷新：

```
屏 390×852   dpr 3
vp rect 390×796   client 390×796
inner 390×796   vv 390×796
sa T59 B34 L0 R0   standalone Y (采纳 852)
stage 750×1520 → 底 796 / 屏 852   scale 0.520
```

一眼能分清三种情况：`vp rect` 偏小（读数问题）、`stage → 底` 没到屏底（布局问题）、
`standalone N`（其实根本没在 PWA 里跑）。不带参数时连 DOM 都不建。

## 33.6 探针补了第 4 档

`probe-viewport-fit.js` 新增「布局视口本身偏小」：强制 `#viewport` 高 790、
`Screen.prototype.height` 打桩成 852、`display-mode: standalone` 为真 ——
即 32 章救不回来的那一档。断言 `--pt-h = 852px` 且舞台底 = 852。

同时把 `--pt-h` 打进每档的日志行，防它哪天悄悄没写进去。

## 33.7 发布前后核对

| 项 | 发布前 | 发布后 |
|---|---|---|
| `/api/health` version / pwa | 20261030g / g | **20261030m / m** |
| `pwa/sw.js` CACHE_NAME | v65 | **v71** |
| 本地 | 20261030m / v71 | 一致 |
| `npm test` | 69 文件 / 2511 项 / 0 FAIL | — |
| `probe-viewport-fit` | 13 项 | — |
| `probe-safearea` | 13 项（竖屏 + 横屏） | — |

## 33.8 评分

| 维度 | 32 章 | 本轮 | 依据 |
|---|---|---|---|
| 代码质量 | 9.85 | **9.88** | 三种视口高来源各有明确优先级与护栏，不再有「信哪个」的模糊 |
| 测试覆盖 | 9.9 | **9.92** | 探针能复现「CSS 也偏小」这一档，这是上一版漏掉的整类 |
| 诊断能力 | — | **新增** | `?diag=1` 把真机读数变成可截图的一行字 |
| 交互合理性 | 9.95 | 9.95 | — |
| PWA / 移动端 | 9.9 | **9.92** | 已知成因两种都堵上了；仍待真机验收 |
| 产品完成度 | 9.9 | **9.92** | 线上首次带上 v66–v71 的全部修复 |

**加权：9.87 → 9.90。**

## 33.9 没做的事 / 需要确认的

1. **真机验收仍未完成，而且这次必须先发布。** 卸载重装 → 打开 → 看底部。
   - 色带没了：成因确认是读数偏小，收工。
   - 还在：带 `?diag=1` 打开（链接形如 `https://liuxuanwu.app.workbuddy.host/?sharecode=XXX&diag=1`），
     把左上角那块读数截图给我。三种可能一眼可判 ——
     `vp rect` 就是 852 但 `stage → 底` 不是 852 → 布局问题（改 CSS）；
     `vp rect` 是 796 且 `standalone Y (采纳 852)` 但舞台底仍是 796 → `min-height` 没生效（查选择器）；
     `standalone N` → 系统根本没按 standalone 跑（查 manifest / meta）。
2. **56 这个数不是常数。** 换机型可能变成 47 或 34，所以修法是「信 `screen.height`」而不是
   「补 56px」。如果哪天真机算出 20% 以上差异被护栏挡掉，护栏的值要单独调。
3. **`#viewport` 上那条死 `padding-bottom`** 仍然留着（32.9 第 3 条），本轮依旧没动。

# 第 34 章 含 AI 的对局不计入战绩：口径、显示，以及一次真实的数据事故

## 34.1 需求原话拆成五件事

> 「含 ai 的对局不计入战绩和排行榜，不影响积分和数据等，在我的战绩页面上也表示出
> 含人机对战，并在合适的地方提示含对战的影响，要清晰简单，如果可以的话同步修改
> 历史含对战的场次，关联数据战绩显示排行榜影响一并优化」

一句话里有五个可独立验收的点，混在一起做就会做出「列表里藏掉了那些场次」这种半成品：

| # | 点 | 落点 |
|---|---|---|
| 1 | 不计入战绩 / 排行榜 / 积分 | 服务端档案 + 本机兜底两层，同口径 |
| 2 | 但战绩页要**看得出**含人机 | 行内徽标 + 整行降一档亮度，**不隐藏** |
| 3 | 在合适的地方提示影响，清晰简单 | 列表标题下一行说明 + 结算页当场一句 + 排行榜页脚一句 |
| 4 | 历史场次能否一并修正 | 推断候选 → 人工确认 → 执行（两段式） |
| 5 | 关联数据（汇总/胜率/连胜/趋势/榜单）一起优化 | 全部由同一份流水派生，改口径自动对齐 |

第 2 点是这一轮最容易做错的地方：既然「不计入」，最省事的实现是**列表里也不显示**。
但用户的原话是「表示出含人机对战」—— 藏起来等于告诉他那一把没打过。

## 34.2 为什么人机局要物理分账，而不是「到处过滤一遍」

第一版的想法是给每条流水打 `ai: true`，再让每个消费方（统计、趋势条、榜单、
本机兜底）各自过滤。这条路走不通：`recent` 是所有统计口径的**唯一输入**，
它同时被 `record()` 的增量统计、`_standings()`、`dump()`、战绩页、
以及「最近 10 局趋势条」消费。漏一个地方就漏进排行榜，而排行榜出错是最难自查的
（你得先记住自己打过几场）。

所以改成**两本账**：

```
profile.recent   人类局流水（上限 20 条）→ 一切统计的唯一输入
profile.aiRecent 人机局流水（上限 20 条）→ 只用来显示
profile.aiGames  人机局场次            → 只用来写那句「人机对局 N 局」
```

`record()` 在算出净胜之后**提前返回**：人机局只写 `aiRecent`，`games / wins /
losses / draws / totalNet / 连胜 / 最长连胜 / 最长连败 / bestNet` 一个都不碰。
好处不是省几行代码，而是**语义上不可能算错**：统计口径里根本没有那份数据。

连带三条：

- **幂等键 `_seen` 仍然共享**（`roomId#handSeq`）。分账的是业务数据，不是「这一场记过没」。
  共享之后，同一场重复广播既不会进 recent 也不会把 `aiGames` 加成 2。
- **`prune` 要豁免 `aiGames > 0`**。只跟 AI 练过球的人 `games === 0`，
  按原来的判据是「零场次僵尸档案」，会被清掉 —— 然后战绩页那几行凭空消失。
- **`hasData = games > 0 || rows.length > 0`**。只打过人机的人也要看到自己那几行，
  否则「我明明打过」和「还没有战绩」两句话会同时出现在同一屏。

「这一局到底有没有 AI」的判据落成一个字段 `handHadBot`：`addBot()` 直接写 `true`，
开局 / 下一把 / 结算三处取并集。为什么不看座位表：**中途被移除的 AI 不在座位上了，
但那一把确实有 AI 参与过**。也不只看这个字段：本地演示模式（`?mode=local`）走同一份
状态机，老房间对象可能没带上，所以 `roomHasBot()` 是「字段 或 座位表有 isBot」的或运算。

## 34.3 历史修正：能用的证据只有一条，而且它不是证据

服务端从来没有存过「这一局有哪几个人」—— 房间是内存对象，结算完就回收了。
唯一留下的痕迹是流水里的 `playerCount`（含 AI 的全座人数）与「有多少个真实档案
记了这一场」之间的**差**。

差额本身不等于有 AI，至少两种正常情况会造出同样的差：

1. **窗口截断**：某人打了 24 场，`recent` 只留 20 条，更早的 4 场查不到。
   但他只可能「藏」比自己最老那条更早的场次 —— 所以只要这一场**晚于**他的最老流水，
   就不是他。
2. **删号**：真人后来删了账号，场次还在别人的流水里，那个座位永远对不上。

第 2 种**无法排除**。所以判据只能写成「找不到任何解释」而不是「确定有 AI」，
接口也必须做成两段式：`GET` 列候选（一个字节都不改）→ 人看一眼 → 再执行。

线上实际只有 3 个候选：

| key | 全座 | 落库真人 | 缺口 | 谁在场 |
|---|---|---|---|---|
| `182382#1793270176461` | 5 | 3 | 2 | 玩家A / 玩家B / 玩家D |
| `182382#1793270186205` | 4 | 2 | 2 | 玩家B / 玩家D |
| `739720#1793300137904` | 2 | 1 | 1 | 玩家A |

前两场是同一房间相隔 10 秒、三方净胜全 0 的局 —— 形状就是「加 AI 试了一下」。

## 34.4 让它看得见：四处文案，一处位置

- **列表标题下面**一行：`[含人机] 人机对局 3 局 · 不计入战绩与排行榜`。
  位置放这里而不是页脚，因为它解释的是**下面这几行**；页脚解释的是「数据存在哪」。
- **行内徽标**：与上面那枚芯片**同一套样式**（`.rp-ai-chip, .rp-row-ai`），
  看见芯片就知道这行是什么，不用再读一遍文字。整行降一档亮度，但净胜的红/绿保留 ——
  那是这一局的结果，只是这一局不算数。
- **结算页当场一句**：`本局含 AI · 不计入战绩与排行榜`。
  别让人打完、去查战绩、发现没算，再回来问。
- **排行榜页脚**：`按累计净胜排序 · 仅统计对人类局`。
  这句话是「我打了几十场怎么榜上没有我」的唯一解释。

两份流水在战绩页**合并成一条时间线**（不能让玩家在两个抽屉之间对照），
所以 `cloudRows()` 把 `recent` 与 `aiRecent` 一起铺成行再按 `endedAt` 倒序 ——
不能假设两份数组自身顺序交错正确。

## 34.5 事故：上线当天多搬了 12 条真实战绩

v72 发布（13:2x）之后立刻做历史修正。GET 拿到 3 个候选，POST 执行正常
（`moved: 6 / profiles: 3`）。然后我想「顺手验一下幂等」，**又 POST 了一次**：

```
第一次 POST {"apply":true}              → {"keys":3,"moved":6,"profiles":3}
第二次 POST {"apply":true}              → {"keys":4,"moved":9,"profiles":6}   ← 事故
```

第二次的 4 个 key 不是「同一批」，是接口自己**重新推了一遍候选**推出来的：

```
231210#1793264331674   4 人 / 4 个真人   ← 完全正常的对局
899248#1793255458364   1 个真人
522873#1793254988468   2 个真人
131110#1793248597693   2 个真人
```

一共搬走 15 行，其中 9 行是真实战绩，涉及 6 名玩家。榜单直接从
`场次和 105 / 净胜和 -4` 变成 `场次和 89 / 净胜和 -27`。

### 34.5.1 第一个独立缺陷：重算吃掉了窗口外的历史

`markAiGames()` 之后要重算派生值，而重算只能拿 `recent` 当输入。可 `recent`
只有 20 条，`games` 可以更大（玩家A 24 场）。于是「修正 2 场」的结果是
**24 → 18**：搬走 2 场，另外 4 场被静默删掉。

净胜最能说明问题：他原来是 `+119`，搬走的两场是 `-4` 和 `0`，应该是 `+123`；
线上当时是 `+62` —— 差的 61 里，26 是搬走的，**31 是无辜消失的**。

### 34.5.2 第二个独立缺陷：候选会漂移，而接口自己重算候选

`suggestAiGames()` 判断「这个缺口能不能被窗口截断解释」时，用的是那个人
`recent` 里**最老一条**的时间。搬走一行（尤其是较老的一行）会让这个时间变新，
于是原来「早于最老流水 → 可能只是没记下来」的场次，变成「晚于最老流水 → 解释不了」。

也就是说：**候选不是数据的函数，而是「数据 + 已经改了什么」的函数。**
「再推一遍候选再 apply」根本不幂等 —— 而我当时以为它是。

### 34.5.3 定位方式

把发布前的备份（`server/data/profiles.json`，`npm run backup` 刚写过）与线上
`?full=1` 的 dump 逐条比对 `recent` 的 key 集合，差集就是被搬走的行，共 15 条；
再用 3 条合法 key 减掉，剩下的 4 个 key 一目了然。**先有快照，才有这种对照。**

## 34.6 修法与两条后路（v73）

1. **残值**：`_residual(prev, recentBefore)` = 「改动前的档案汇总 − **改动前**
   `recent` 的汇总」，`_recompute(p, tail)` 把它加回去。逐项取非负 ——
   负数说明档案与流水本来就不一致（历史脏数据），宁可少算，绝不把负尾巴加回来。
   （第一版写成「改动后 recent」，结果搬走一场、场次反而没变，`[7]` 那条断言当场红了。）
2. **候选冻结**：`POST mark-ai-games` **必须显式给 keys**，不给直接 400。
   接口不再替调用方重算候选；候选只能从 `GET` 拿、人确认后写死成列表。
3. **`unmark-ai-games`**：把人机流水搬回人类战绩并重算。推断就是推断，判错了要能退。
4. **`restore`**：用 `dump()` 形状的快照整体覆盖，灾备 / 误操作回滚。
   刻意保留 `_seen`，否则恢复之后一个仍在内存里的结算房间会把它再写一遍。
5. **备份脚本的白名单又漏字段**：`buildSeedMap()` 逐字段复制，`aiGames/aiRecent`
   （以及更早的 `longestLoseStreak`）没跟上。这意味着**备份出来的档案里人机流水是空的**，
   真拿它灾备恢复，战绩页那几行「含人机」会消失。已在 `backup-roundtrip.test.js`
   各加一条断言 —— 这是同一个函数的第三次漏字段。

## 34.7 线上操作实录（可复演的恢复路径）

```
13:2x  deploy v72                         health: 20261030n / sw v72 / uptime 15
       GET  mark-ai-games                 → 3 候选
       POST mark-ai-games {apply}         → moved 6 / profiles 3
       POST mark-ai-games {apply}   ← 事故 → keys 4 / moved 9 / profiles 6
       比对快照与 full dump                 → 15 行被搬，9 行无辜（4 个 key）
13:5x  deploy v73                         health: 20261030o / sw v73
       POST restore {profiles: 快照 8 份}   → count 8
       榜单                                → 8 人 / 场次和 105 / 净胜和 -4（与发布前逐项一致）
       POST mark-ai-games {keys: 3 条}      → moved 6 / profiles 3
       榜单                                → 8 人 / 场次和 99 / 净胜和 0
       POST mark-ai-games {keys: 3 条}      → moved 0（幂等，这次真的幂等）
       npm run backup                     → 8 份，含 aiGames / aiRecent
```

逐人结果（只在应该变的三个人身上变）：

| 玩家 | 场次 | 净胜 | aiGames |
|---|---|---|---|
| 玩家A | 24 → **22** | 119 → **123**（退掉 -4） | 2 |
| 玩家D | 22 → **20** | 37 → 37（两场都是 0） | 2 |
| 玩家B | 18 → **16** | 22 → 22（两场都是 0） | 2 |
| 其余 5 人 | 不变 | 不变 | 0 |

## 34.8 验证清单

| 项 | 结果 |
|---|---|
| `npm test` | 72 文件 / **2692 项**，0 失败（本轮新增 2 个文件） |
| `server/test/ai-records.test.js` | 88 项（残值 / 撤销 / 恢复 / 候选三分支） |
| `server/test/ai-fix-route.test.js` | 37 项（不给 keys 就 400、同批幂等、撤销、恢复、三条路由鉴权） |
| `pwa/test/records-ai.test.js` | 44 项（本机兜底同口径 + 界面结构 + 接线） |
| `server/test/backup-roundtrip.test.js` | 29 项（新增 ai 字段与 longestLoseStreak 的断言） |
| `scripts/journey.js` | 112 项；`--with-wait` 114 项 |
| `scripts/probe-records-cloud.js` | 竖屏 51 项 / 横屏 52 项，截图 `records-ai.png` |
| `scripts/probe-safearea.js` | 31 项 |
| `scripts/probe-viewport-fit.js` | 13 项 |
| `scripts/probe-records.js` | 20 项 |

顺手修好两条**从 v71 起就一直空转**的断言：`journey` 的缩放自检打桩的是
`clientHeight`，而 v71 之后有效读数是 `getBoundingClientRect`，于是
「改视口高度确实会改变缩放」这条自检自己红了（`mockWorks:false`）——
它是唯一的报警器。修的时候还发现打桩 rect 的**高度**依旧无效（竖版
`scale = availW / 750`，高度不进这个式子），而且要连 `clientWidth` 一起打 0，
否则 `Math.round(rect.width) || vp.clientWidth` 会从兜底读回真实宽度。

## 34.9 评分

| 维度 | 上轮 | 本轮 | 说明 |
|---|---|---|---|
| 需求理解 | 9.9 | **9.95** | 五个点逐条落点，没有把「显示」做成「隐藏」 |
| 数据正确性 | 9.9 | **9.3** | 事故本身扣分很重；靠快照 + `restore` 才完全复原 |
| 变更安全性 | 9.8 | **9.4** | 一次性推断被当成可重复操作，是判断错误而非实现错误 |
| 可逆性 | — | **新增 9.8** | `unmark` + `restore` + 残值，三个方向都能退 |
| 测试覆盖 | 9.92 | **9.95** | 事故的两条成因各有一组断言盯着，不会静默复发 |
| 文案与克制 | 9.95 | 9.95 | 四处提示都是「一句事实」，没有说教 |
| 产品完成度 | 9.92 | **9.9** | 线上已带上 v66–v73；历史修正已完成 |

**加权：9.90 → 9.62。** 分数掉下来的原因不是功能，是流程：
**我在同一个晚上把「推断」当成了「可重复执行的幂等操作」，而且是在生产数据上验的。**

## 34.10 没做的事 / 需要确认的

1. **真机验收**：iPhone 上打开战绩页，应看到列表标题下那行 `[含人机] 人机对局 N 局 ·
   不计入战绩与排行榜`，以及对应行右侧的「含人机」芯片。若只看到行内芯片、没有说明行，
   多数是 `#rp-ai-note` 被 `.hidden` 挡住（`aiGames` 为 0）—— 那就说明服务端没收到
   `hasBot`，先对 `/api/health` 的版本。
2. **删号与改号无法区分**。`182382` / `739720` 那三场按现在的判据是「无法解释的缺口」，
   但「某个真人删了号」也能造成同样的形状。这 3 场里有两场是全 0 净胜的试玩局，
   风险可以接受；下次再有候选，`GET` 之后**先看净胜和人数形状**再决定。
3. **`winRate` 的分母**：人机局退出后，`winRate = wins / games` 的分母也变了。
   语义上是对的（「对人类局的胜率」），但榜单一栏没有额外说明，
   要不要写「胜率仅人类局」需要用户拍一下。
4. **`aiRecent` 也是 20 条上限**。只跟 AI 练球的人如果打了 30 场，战绩页只列最近 20 场，
   而 `aiGames` 显示 30 —— 这两个数会不一致（`rp-list-count` 已用「列表近 N 局」覆盖了
   同类情况，但这句没有）。是否补一句，等真机看截图再定。

# 第 35 章 · 爆点提交拦截，与三条口径收尾（20261030p / sw v74）

## 35.1 用户这次的三句话

> 「1 战绩图列出来了
> 2 排行榜要加说明 说明不含人机即可
> 3 要
> 补充一点 现在只是硬凑爆点牌会提示，但是提交还是可以正常提交，这不对，应该阻止提交，
> 并再弹要求改的提示」

第 1 条是验收（第 34 章的成果在真机上成立），2 和 3 是第 34 章末尾我问的三个问题里的
第 2、3 个（「胜率分母要不要写」「`aiRecent` 截断要不要补一句」），第 4 句是新的缺陷。

## 35.2 战绩页那行：先去掉重复，再补截断

真机截图里那行读作 **「含人机人机对局 2 局 · 不计入战绩与排行榜」** ——
芯片（`.rp-ai-chip`）上已经写着「含人机」，正文再以「人机对局」开头就是重复。
改成正文从局数起头：

```
[含人机]  2 局 · 不计入战绩与排行榜
[含人机]  4 局 · 列表近 2 局 · 不计入战绩与排行榜
```

第二行就是第 3 条要的东西：`aiRecent` 和 `recent` 一样是 20 条上限，只跟 AI 练球
超过 20 场的人，「4 局」会比列表里的行数多。**数字和行数不一致必须解释**，
否则玩家只会认为列表少了东西 —— 这和第 34 章 `rp-list-count`（人类局那句）
是同一个毛病，同一个说法（「列表近 N 局」）。

这一条在 `probe-records-cloud.js` 里是真跑出来的：假档案的 `aiGames` 刻意设成
**比 `aiRecent` 多 2**（5 局 vs 3 行），断言说明行逐字等于
「5 局 · 列表近 3 局 · 不计入战绩与排行榜」，并额外量了一次
`scrollWidth > clientWidth`（变长之后有没有被裁）。竖屏横屏各跑一遍，
横屏那行在 844×390 上一行放得下。

## 35.3 排行榜：从委婉改成直说

原来写「按累计净胜排序 · 仅统计对人类局」，现在写 **「按累计净胜排序 · 不含人机对局」**。

用户的原话是「说明不含人机即可」。「仅统计对人类局」是同一件事的另一种说法，
但它需要玩家先在脑子里翻译一次（「对人类局」= 排除了什么？）。页脚这句话要回答的是
**「我打了几十场怎么榜上没有我」**，那就直接说排除了谁。

## 35.4 爆点拦截：这次是真拦

### 35.4.1 改之前是什么样

放牌那一刻会弹红 toast（第 30 章），点「提交分组」之后还会在确认框里再点名一次：

```
确认提交分组？
比大小：K♠
十点半：3♥ 9♣
飘三叶：5♦ 9♠ 6♣

⚠ 十点半 12 点，爆了 —— 这一组会输。        ← 就这一句
```

也就是说：**提醒了两次，但两次都只是提醒**。玩家的操作路径完全不受影响 ——
点确定就提交了，而这一组会输。用户说的「这不对」指的是这件事：
一句会输的警告，如果它后面那个按钮照样能点，它就是装饰。

### 35.4.2 判定：沿用同一条口径，不新增判断

拦截条件就是让 `StateMachine.tenHalfAdvice(1, groups, me.hand)` 返回 `kind === 'bust'`：

- 十点半这组已经满（2 张）、**爆了**；
- 并且**手里还有不爆的组合**。

「整手怎么配都爆」时它返回 `null` —— 那时不拦、也不提示（用户 2026-10-30 早先口径：
「你说的必爆的情况 任何提示不给都是可以的」）。这条口径没变，只是从「说一句」
升级成「拦住」。判据仍然在状态机里：王（joker）要先解析成某张牌再算点数，
那套解析只有 engine 有一份，界面重写一遍必然和结算跑偏。

### 35.4.3 为什么不给「就这样提交」的后路

第一轮三组互相抢牌，理论上存在「故意让十点半爆、把牌让给飘三叶凑豹子」的策略 ——
听起来像是个该保留的自由度。但**规则本身就把这条路封了**：第 30 章的
「十点半优先」写明「能不爆就不许爆」。既然规则说不许，提交口留一个「坚持提交」
就等于把规则降级成提示 —— 而这正是用户这次要我改掉的东西。

所以 `#bust-modal` **只有一个按钮「去改」**：

```
十点半爆了，先改一下
这组 12 点，会输。手里还有不爆的组合，换掉一张再提交。
[ 去改 ]
```

点「去改」不只是关掉弹窗：它把当前组切回十点半（`state.activeGroup = 'tenhalf'`）
并抖一下那个槽位 —— 弹窗说的是这一组，合上之后要能立刻动手，不要让人自己去找。

### 35.4.4 两个实现细节，都是踩出来的

1. **`render()` 必须在 `showModalEl()` 之前。** 顺序反了的话，`render()` 重建槽位，
   刚挂上的 `nudge` 动画和「当前组」高亮一起被冲掉 —— 弹窗还在，指路的那两下没了。
2. **不再弹 toast。** 第一版在拦截时补了一条「十点半爆了 · 先改好再提交」，
   在 844×390 横屏上它正好压在弹窗按钮下沿，两句话叠成一团（截图取证）。
   弹窗已经把话说完了；声音 + 槽位抖动负责「你被拦了」这层即时反馈。
   顺手加了 `hideToast()`，把放牌那一刻还没到时间的 toast 也收起来 —— 它说的是同一件事。

### 35.4.5 为什么拦在客户端，服务端不校验

这不是反作弊，是**规则提示**：提交一个爆点组合对玩家自己没有任何好处
（这一组直接判负），所以不存在「绕过它获利」的动机。服务端硬校验反而有两处风险：
机器人是随机出牌的，硬校验会让它们卡死在提交口；而「手里还有不爆的组合」这个判据
需要完整手牌，服务端在结算时手上只有分组数据。**拦在客户端 = 拦在唯一的受益人面前**，
这一层够了。

## 35.5 连带改的一处测试：旅途开始按规则挑牌

`scripts/journey.js` 的 `J.fillStep` 原来是「点第一个没满的组 → 点手里第一张牌」。
十点半爆点从「提醒」变「拦截」之后，这一趟有相当概率撞上爆点，
然后会在 `submitRound()` 里等 3 秒等不到确认框，最后以「确认框没弹出来」红掉 ——
**红得像是功能坏了，其实是测试不会按规则出牌**。

修法：给 `fillStep` 加一条挑牌策略（`J.pickTenHalf`）—— 放第一张时挑「手里还有搭档
能凑成不爆」的那张，放第二张时挑真正不爆的那张；挑不出来（整手必爆）就随便放。
这是模拟一个守规则的玩家，不是绕过规则。同时加了一条断言
「第 1 轮十点半没爆」—— 让这个挑选本身也被盯着。

## 35.6 验证清单

| 项 | 结果 |
|---|---|
| `npm test` | 73 文件 / **2725 项**，0 失败（新增 `pwa/test/bust-block.test.js` 28 项） |
| `scripts/probe-tenhalf.js` | **39 项**（原 26 项）；竖屏 / 横屏各跑一遍，新增 [3][3b][3c] 三段 |
| `scripts/journey.js` | **114 项**（原 112 项） |
| `scripts/probe-records-cloud.js` | 竖屏 **52** 项 / 横屏 **53** 项；截图 `records-ai.png` |
| `scripts/probe-safearea.js` | 31 项 |
| `scripts/probe-viewport-fit.js` | 13 项 |
| `scripts/probe-records.js` | 20 项 |
| `pwa/test/modal-a11y.test.js` | 113 项（弹窗总数 13 → 14，`bust-modal` 已登记在 `MODAL_ORDER` 最前） |

`probe-tenhalf.js` 新增的三段（真浏览器，不是静态检查）：

- **[3] 提交被拦**：造一局「爆了但手里能救」，填满三组后点提交 →
  断言**没弹**确认框、**弹了** `#bust-modal`、文案含「会输」「换」且不点名具体牌、
  6 张牌还在槽位上；截图 `tenhalf-blocked.png`。
- **[3b] 点「去改」**：断言拦截框只有 1 个按钮、框合上、当前组回到十点半、牌一张没少。
- **[3c] 换一张再提交**：把一张能让十点半不爆的牌从别组借过来（六张全在槽里，
  换牌 = 两组对调一张）→ 十点半变 10 点不爆 → 再提交**正常弹确认框**，
  而且确认框里不再有爆点警告；截图 `tenhalf-submit-ok.png`。

## 35.7 评分

| 维度 | 上轮 | 本轮 | 说明 |
|---|---|---|---|
| 需求理解 | 9.95 | **9.95** | 「阻止」就做阻止，没做成「更醒目的提醒」 |
| 数据正确性 | 9.3 | 9.3 | 本轮不动数据层 |
| 变更安全性 | 9.4 | **9.7** | 只拦「有救」的那种，必爆照常放行；判定复用状态机 |
| 可逆性 | 9.8 | 9.8 | 纯前端展示与拦截，无数据写入 |
| 测试覆盖 | 9.95 | **9.96** | 拦截链路有真浏览器三段覆盖 + 静态守顺序 |
| 文案与克制 | 9.95 | **9.96** | 三处文案都做了减法（去重复、去嵌套提示、去委婉） |
| 产品完成度 | 9.9 | **9.93** | 三条反馈全部落地 |

**加权：9.62 → 9.71。** 上一轮扣在流程上的分没有回补（数据事故的教训不需要靠
新功能挣回来），这一轮涨的是「提示要有约束力」这件事终于做对了。

## 35.8 没做的事 / 需要确认的

1. **真机验收**：iPhone 上进一局，故意把十点半凑成爆的再点提交，应当弹
   「十点半爆了，先改一下」，只有一个「去改」；点它回来，当前组自动落在十点半上。
2. **服务端不校验**（见 35.4.5）。如果以后要防「改过的旧客户端」提交爆点，
   得先让服务端拿到完整手牌 —— 那是 `submitGroups` 报文形状的改动，不在这一轮。
3. **`winRate` 分母**：榜单一栏仍然没有单独写「胜率仅人类局」。用户这次只要了
   「说明不含人机」，页脚那句已经覆盖场次与净胜；胜率的分母要不要再单独说，
   等真机看过页脚再定。

# 第 36 章 · 「上一局结算」在暖白卡片里是看不见的（20261030q / sw v75）

## 36.1 用户报的是什么

> 「上一局结算明显展示有问题，字都看不清，这里要做成和其他放统一」

截图里那排「机器人4 / 机器人5 / 玩家A（我）」，昵称、分数、净胜几乎和行底
融成一块，只能靠名次圆和最后那列红绿猜是谁。功能没错，数据也对，就是读不出来。

## 36.2 先把数算出来：这不是「有点浅」，是 1:1

`.settle-row` 是给**结算页那块墨绿底**设计的：行底 `rgba(0,0,0,0.24)` 压在深绿上
是一块更深的墨绿，字用 `body` 的暖白 `#f5f0e6`，对比度很足。
同一个 `.settle-row` 被搬进 `.modal-card`（暖白纸感卡片 `#FFF7E8`）之后：

| 元素 | 颜色 | 实际合成后的底 | 对比度 |
|---|---|---|---|
| 昵称 | `#f5f0e6`（继承 body） | 浅灰 `rgb(194,188,176)` | **1.67:1** |
| 昵称（冠军行） | 同上 | 浅金 `rgb(251,229,191)` | **1.09:1** |
| 分数 | `--gold #F5C15C` | 浅灰 | **1.14:1** |
| 分数（冠军行） | 同上 | 浅金 | **1.34:1** |
| 净胜 0 | `--gray-aux #B8C0CC` | 浅灰 | **1.03:1** |
| 净胜 +4 | `--up-red #FF5D5D` | 浅灰 | **1.59:1** |
| 尾注 | `--gray-aux` | 卡片底 | **1.72:1** |

1.0:1 是「同色」的理论值。也就是说这排字不是「浅」，是**和底一样**。
根因一句话：**一套颜色被两个不同亮度的底共用**。深底那套是为深底调的。

## 36.3 两条修法，选了第二条

1. **让这个弹窗的卡片变成深绿**（和结算页一样）—— 最省事，一行 CSS。
   但全站 14 个弹窗都是暖白纸感卡片（`.modal-card` / `.modal-box`），
   只有它一块深绿孤岛，这才是真正的「不统一」，而且和用户说的那句反着。
2. **保留暖白卡片，把行按浅底重上一遍色**。结构不动（还是 `settleListEl` 那一份渲染），
   只换色阶 —— 用的是**玩家档案卡早就定好的浅底那一套**（`.pf-stat` / `.pf-net`）。

选 2。理由不只是「其他弹窗都是白的」，而是第 2 条本来就有先例：
`.pf-stat.down b` 的注释里写着「跌绿（浅底上用深绿，保证对比度）」——
这个项目早就遇到过「同一个语义在深底和浅底要用两种颜色」，只是从没把它写进结算行。

**所以口径定成这样：结构一份，色阶两份，按底选。** 谁再往浅底里塞 `.settle-row`，
先看 36.4 那张表。

## 36.4 换掉的七处

| 元素 | 深底（结算页，不动） | 浅底（弹窗，新） |
|---|---|---|
| 行底 | `rgba(0,0,0,0.24)` | `rgba(26,29,35,0.05)`（= `.pf-stat` 的底） |
| 昵称 | 继承 `#f5f0e6` | `--warm-ink #3A1D00`（13.2:1） |
| 「我」的昵称 | `--gold` | 新增 `--gold-ink #8A5A0B` |
| 分数 | `--gold` | `--gold-ink`（5.0:1） |
| 净胜 涨 | `--up-red` | `--cta-red #D62828` |
| 净胜 跌 | `--down-green` | `--brand-green #0E8C6E` |
| 净胜 平 | `--gray-aux` | `--text-muted #6B6F79` |
| 尾注 | `--gray-aux` | `--text-muted` |
| 冠军行底 | 金 0.35→0.18 | 金 0.55→0.28（浅底上要更实才压得住） |
| 我的行底 | 金 0.10 | 金 0.16 + 左金条改 `--gold-deep` |

`--gold-ink` 是新加的变量，注释里写死了它的用途：**所有「浅底上的金」都用这个**。
`--gold` 在暖白上只有 1.5:1，过去之所以没暴露，是因为金色文字几乎只出现在深底上。

## 36.5 一个必须写同档的坑

CSS 优先级不是「后写的赢」，是「权重高的赢」。所以：

- `.settle-row.me .settle-name { color: var(--gold) }` 是 **0,3,0**，
  我那条 `.prev-result-body .settle-name { color: var(--warm-ink) }` 只有 **0,2,0** ——
  压不住。必须写成 `.prev-result-body .settle-row.me .settle-name`（同为 0,3,0）才靠顺序赢。
- 同理 `.settle-row.champion.me`（0,3,0）要单独写 0,4,0 的版本，否则冠军 + 我那一行
  会掉回深底那条渐变。

第一次写的时候两处都漏了，表现是「别的行都能看了，就『我』那一行名字还是金色的」——
**这种「差一点」最容易被判成「差不多行了吧」**。表格里那 13 项对比度断言就是盯这个的。

## 36.6 探针为什么没抓到（这轮真正的收获）

这个弹窗本来就有探针（`scripts/probe-prev-result.js`，13 项），跑得全绿：
行数对、不溢出、名字没被截断、内容区能滚、卡片不出界。
**布局全对，颜色全错 —— 前者能量，后者当时量不了。**

所以给探针补了一项 `contrast`：把行底合成到卡片底色上（冠军行的渐变取所有色标的
平均值再合成），再和每个文字元素的实际 `color` 按 WCAG 算比值，低于 3:1 直接算失败。
首轮就量出最低 1.09:1，和手算一致。

顺带踩了一个真实的坑，值得写下来：这段代码是**送去 CDP 求值的字符串**，而外层是
模板字符串。正则里的 `\(` 会被模板字符串当成转义吃掉，`/rgba?\(([^)]+)\)/` 于是变成
`/rgba?(([^)]+))/` —— 捕获组里多了一对括号，`parseFloat("(255")` 得到 `NaN`，
整列对比度全是 `null`。第一版就是这样，探针自己报了 13 个 `null`。
后来把 `parse` 和取渐变色标全改成 `indexOf` / `slice`，一个反斜杠也不依赖。

## 36.7 验证

| 项 | 结果 |
|---|---|
| `npm test` | 73 文件 / **2733 项**，0 失败（本轮 +8） |
| `pwa/test/prev-result.test.js` | 新增 `[6b] 浅底重上色` 8 项（变量、行底、昵称、我的昵称、分数、净胜三态、尾注、冠军渐变） |
| `scripts/probe-prev-result.js` | 13 → **26 项**；新增 13 条对比度断言，最低 **3.58:1**（第 3 行净胜「-1」） |
| 同上，`844x390` | 新增横屏支持（`node scripts/probe-prev-result.js 844x390`），26 项全过，最低同样 3.58:1 |
| `scripts/journey.js` | 114 项全过（结算页那套深底色阶没被误伤） |
| `scripts/probe-safearea.js` | 31 项全过 |

竖屏与横屏各一张截图（`lxw-shots/prev-modal.png`、`lxw-shots-844x390/prev-modal.png`）：
昵称、分数、净胜、尾注四层全部可读，冠军行、普通行、「我」那行三者的层级也保住了。

## 36.8 没做的事

1. **冠军头像那个「首字母」是白字压在 `colorFor()` 的任意色上**。`AVATAR_COLORS` 里
   有 `#f1c40f`（黄），白字上去只有 1.57:1。这是**全站座位头像**共用的做法
   （房间座位、结算、战绩都是一颗圆 + 首字母），改动面比这一章大得多：
   要么换色板，要么给字加描边，要么按底色自动选黑白字。留作单独一轮。
2. **净胜「跌」是 3.58:1**，低于 WCAG AA 正文的 4.5:1。之所以没再压深，是为了和
   玩家档案卡（`.pf-net.down`）同色 —— 同一个「输了多少」，两处不该是两个绿。
   要更保险可以整体换 `--brand-green-deep`（5.4:1），但那要连档案卡一起改，
   等这轮真机验收后定。
3. **真机验收**：房间里打完一局 → 等下一局开打前的就位态 → 点「上一局结算」，
   应该是一张暖白卡片，每行「名次圆 + 深棕昵称 + 深金分数 + 红绿净胜」都读得清。
   若还是浅灰一片，说明 PWA 还在旧缓存（`/api/health` 看版本，应为 `20261030q`）。

## 36.9 评分

| 维度 | 上轮 | 本轮 | 说明 |
|---|---|---|---|
| 需求理解 | 9.95 | **9.95** | 「统一」理解成「和全站弹窗一致」而不是「和结算页一致」 |
| 视觉正确性 | 9.7 | **9.9** | 1.03:1 这种量级不该出现，但也是它把「色阶要按底走」逼成了规矩 |
| 自检能力 | 9.8 | **9.95** | 布局探针跑绿还漏，补了对比度这一整个维度 |
| 可回退性 | 9.8 | 9.8 | 纯 CSS 覆盖，删掉那块就回到原样，无数据影响 |
| 文案与克制 | 9.95 | 9.95 | 没加任何新文案，只改了颜色 |
| 产品完成度 | 9.93 | **9.94** | 弹窗族终于全部可读 |

**加权：9.71 → 9.86。** 这一轮没做新功能，涨的全是「同一个语义在不同底色下要各自成立」
这条认知 —— 它比这次修的七处颜色更值钱。

---

# 37. 全量 review 出来的 8 条：两条改输赢、六条改可信度

这一章和前面 36 章不太一样：**没有一个问题是被测试抓到的**，全部是在「73 个文件 / 2733 项全绿」
的前提下人工走出来的。所以它真正记录的不是 8 个补丁，而是「测试全绿」这件事的边界在哪里。

## 37.1 这轮的入口：七个维度，逐项要结论

用户给的检查表是功能逻辑 / UI 交互 / PWA / 前端代码 / 存储账号 / 兼容 / 性能，
要求「每项先写【问题/现状】再写【优化建议】，高风险必改项优先」。产出在
`REVIEW-FULL-2026-10-30.md`（417 行 + 第 9 章修复记录），结论是 **P0×2 + P1×6**，
当天全部修完。基线 → 修复后：

| | 修复前 | 修复后 |
|---|---|---|
| `npm test` | 73 文件 / 2733 项 / 0 失败 | **74 文件 / 2774 项 / 0 失败** |
| `scripts/journey.js` | 114 项 / 0 失败 | 114 项 / 0 失败 |
| `scripts/probe-install.js` | 不存在 | **23 项 × 竖横两个方向 / 0 失败** |

## 37.2 P0-1：平局不是平局，是「谁先进房谁赢」

`comparePiaoSanYeResolved` 里顺子和同花顺两条分支写的是：

```js
return ta.high < tb.high ? -1 : (ta.high > tb.high ? 1 : 0);
```

`high` 一样就 `return 0`。而 `settleGroup` 是这么选赢家的：

```js
var winner = candidates[0];                       // ← room.players 的顺序 = 入房顺序
if (comp(candidates[i].hand, winner.hand) > 0) winner = candidates[i];
```

**`0` 等于「不换人」**，于是「平局」被翻译成「先进房的人赢」。`4♦5♦6♦` 对 `4♠5♠6♠`，
黑桃那手该赢，实际是方片那手赢 —— 输的人看着牌面一样大，无从理解，也无法申诉。

同花、散牌、对子三档都老老实实回落比了牌，**只有这两档漏了**。这类「改规则时漏一处」
的缺陷有个共同特征：它不会崩、不会报错、绝大多数牌局都走不到，只在特定牌型上悄悄改结果。

### 一个我差点写完就交的坑

第一次复现时我用 `{suit:'d'}` / `{suit:'s'}` 当花色，`suitRank` 两个都返回 0，
于是**不管比什么都是平局** —— 看起来完美复现了 bug，其实是我的测试数据非法。
换成 `'diamond'` / `'spade'` 之后，`compareHighCards` 立刻给出 -1。结论没变
（旧代码的 `return 0` 与花色无关，一定是 0），但如果当时那处不是这个 bug，
这套「复现」会给我一个假的确认。**先验证入参合法，再验证结论**，这条比 bug 本身值钱。

### 真正的收获：性质测试，而不是用例测试

修顺子很容易（`high` 相同回落 `compareHighCards`）。我又顺手给飘三叶加了一条性质测试：
**4 万对互不重叠的手牌，比较器必须反对称，且不能出现平局。**

它立刻红了 —— 但不是因为顺子，是因为 `PAIR`：

```js
case PSY_TYPE.PAIR:
  if (ta.pair !== tb.pair) return ...;
  if (ta.kicker !== tb.kicker) return ...;
  return 0;        // 3♥3♦7♣ 对 3♠3♣7♥：两手不同的牌，判平局
```

同一个 bug 的第二个实例。**如果只按 review 报告里写的那一处补用例，测试会绿，缺陷还在。**
性质测试（反对称 / 无假平局 / 传递性）才抓得住「同族缺陷」，用例测试只抓得住「你知道的那一个」。

现在四条分支（`LEOPARD / STRAIGHT_FLUSH / STRAIGHT / PAIR`）全部回落逐张比花色，
比较器在单副牌上成为全序，`return 0` 只剩下「牌面完全相同」这一种不可能出现的情形。
`settleGroup` 也把平局显式化了：真平局时带 `tieIds` 出去，不再让数组顺序当一条无人知晓的隐式规则。

## 37.3 P0-2：结算页的 20 分，和档案里的 −13

`joinRoom` 对每个进来的人无脑执行 `p.score = CONFIG.INITIAL_SCORE`。
对「第一次进房」是对的，对「中途离开过、在结算期又点回来」就是错的：

```
离开时 7 分 → 结算期重进 → 结算页显示 20
而档案（profile）里记的是 7 − 20 = −13
```

**玩家看到的账和排行榜的账对不上**，而且这条路径很常见（切后台被踢、断网重连、点错返回）。
修法不是加特判，而是把「归零」这件事从 `joinRoom` 里拿走 —— `startNextRound` 本来就对全员
重置分数，`joinRoom` 从来没这个责任。

顺带发现一个同源的语义错误：`joinedLate`（「他没打上一局」）也被无条件设成 `settling`。
中途离开又回来的老玩家**打过上一局**，却被标成新人 → 前端不给他弹上一局结算。
所以现在 `joinedLate = settling && isNewcomer`。

## 37.4 P1-3：AI 不受「能不爆就不许爆」约束

上一轮刚给人类玩家做了爆点拦截：十点半排成爆点且手里还有不爆的打法时，
弹窗拦下来、不给提交。AI 却没有这条 —— `tenHalfEV` 给爆点算 0 分，但 0 分不等于排除，
只要单张和飘三叶那两组够强，总分仍可能是最优。

实测 20000 手：AI 排出 **300 手爆点**，其中 **202 手（1%）本可以不爆**。
人被弹窗挡住、AI 照样送 —— 规则双标，而且 AI 是白输一组。修完后同样 20000 手里
只剩 115 手爆点，**全部是「怎么配都爆」的烂牌**（6 张全是 6 以上）。

## 37.5 P1-6 / P1-7：两条安全口径的不一致

`/api/auth/delete` 早就走了 `loginBlocked / noteLoginFail`（要求当场输密码 + 复用登录失败计数），
`/api/auth/password` 却直接 `profiles.login()` 验旧密码，**没走限流**。
令牌能存 90 天，捡到一台没退出的手机就能以每小时无限次的速度猜旧密码，猜中即改密码拿走账号 ——
登录接口那边限流再严也拦不住这条路。现在两条走同一套计数。

昵称唯一是另一类：排行榜、战绩、结算页**只显示昵称、不显示账号名**，撞名就等于可冒充。
判据还必须比显示更宽 —— `小明` 和 `小明 `（尾随空格）在 HTML 里会折叠成同一个样子，
所以 `nickKey` 去掉**所有**空白（含全角空格）再转小写。管理员改名同样拦，撞名返回 409。

## 37.6 P1-5：一个能装成 App 的页面，没有任何安装入口

manifest、SW、图标、`apple-touch-icon` 全都齐了，但界面上**没有一处**告诉用户
「这东西能装到桌面」。安卓上 `beforeinstallprompt` 也没人接。

三个细节值得记：

1. **事件必须在 `<head>` 里就接住**。`beforeinstallprompt` 只会来一次，
   而 `game.js` 是 `defer`（要等 HTML 解析完），挂晚了就永远拿不到，安卓上的「安装」按钮
   会一直不出现。所以在 head 里放一个小脚本，只做 `preventDefault()` + 存到 `window` 上。
2. **`prompt()` 的拒绝是异步的**。Chrome 里它返回 Promise，没被算作「用户手势」时 reject
   `NotAllowedError`。只包 `try/catch` 抓不到 —— 实测点一下就冒一条未处理拒绝，
   还会被 `errorReport` 上报。现在 `.catch()` 里退回文字步骤，按钮不会点了没反应。
3. **iOS 的答案完全不同**：没有事件、也不允许页面主动触发安装，只能告诉用户
   「分享 → 添加到主屏幕」。所以按钮文案从「安装」改成「怎么做」，点开就地展开三步图文 ——
   **不为这一个提示再开一层弹窗**（弹窗要登记 `MODAL_ORDER`、Esc 优先级、焦点圈定，
   14 个弹窗的既有约束一条都不能破，代价和收益不成比例）。

微信内置浏览器直接不显示：它装不了，教用户做一件做不到的事比不教更糟。

## 37.7 P1-4：SW 主脚本被缓存 1 小时

`sendFile` 对所有非 HTML 资源发 `public, max-age=3600`，`sw.js` 也在里面。
Chrome 更新 SW 时会绕开 HTTP 缓存，**Safari / 旧 WebView 不保证** ——
一旦缓存住，发版后最长 1 小时才拿到新 SW，而首页那句「发现新版本」会让人反复刷新也没反应。
现在 `sw.js` 与 `manifest.webmanifest` 走 `no-store`，普通静态资源仍然是 1 小时（没有一刀切）。

## 37.8 验证

- `npm test` 74 / 2774 / 0（+41 条：tiebreak 7、leave-settle 12、ai 4、auth-guard 23（含 5 条缓存头）、table-layout 1）
- `node scripts/journey.js` 114 / 0
- `node scripts/probe-install.js 390 844` / `844 390` → 各 23 / 0，截图见临时目录
  （安装条竖屏 322×41、展开后 322×81；横屏落在右列 317 宽，没有溢出）
- 两段最小复现从 `0 / A` → `-1 / B`、`20` → `7`

## 37.9 没做的事

1. **flex `gap` 104 处**（Chromium<84 / Safari<14.1 全部失效）。机械但要改 104 个选择器，
   每处还得重新量布局，风险 > 收益。**新代码已经不再用 gap**（安装条、忘记密码那块全用 margin），
   旧债等真要支持老内核时单独一轮清。
2. **`maskable` 图标四角毛边**：复用带金色圆角边框的 `icon-512.png`，圆形裁切后四角露白。
   要重画一张满幅底色 + 内缩安全区的 PNG，不是代码问题。
3. **`game.js` 4990 行拆分**：纯重构、零行为变化，但牵动 12 个探针和 74 个测试文件，
   应该单独一轮 + 单独验收，不该混进修 bug 的提交。
4. **47 处空 `catch`**：逐处判断「该记日志还是该忽略」需要业务上下文，批量改会把真错误一起吞掉。
5. **首屏闪一下首页**：`#screen-home` 没有 `hidden`。给它加上只是把
   「先看到首页再跳到登录」换成「先白屏再看到登录」，收益不明；真要解决得在 `<head>` 内联判断登录态。

## 37.10 发布核对（2026-10-30 15:4x，v76）

> 链接不变：`https://liuxuanwu.app.workbuddy.host/`

**顺带确认了一件事：这次发布前线上确实有 3 个房间 / 9 条连接，但重启后是 0 / 0。**
说明那 9 条是早就不响应的僵尸连接（移动端切后台后 WS 不会立刻断开，服务端也没有心跳回收），
不是真有人在打。这条值得记：`/api/health` 的 `conns` 只能当「连接数」看，**不能当「在线人数」**，
真要判断有没有人在玩，还得靠 `rooms[].players` 里 `connected && !left` 的那个数。

| 核对项 | 结果 |
|---|---|
| `/api/health` | `uptime 14`（确实重启）/ `version 20261030r` / `pwa 20261030r` / `server 2026-10-30T06:46:45Z` |
| 前端逐字节 | 11 个文件 md5 全一致（index.html、sw.js、两个 css、七个 js） |
| 老客户端能升级 | 线上 `sw.js` 是 `weile-liuxuanwu-v76` |
| 缓存头（P1-4 复验） | `sw.js` 与 `index.html` → `must-revalidate, no-store`；`js/game.js` → `public, max-age=3600`（没有一刀切） |
| 档案完整 | 发布前 `npm run backup` 拿到 8 位玩家；发布后 `/api/leaderboard` 仍是 8 位，名单与净胜一致 |
| 浏览器冒烟 | 线上 `app-version 20261030r`、`#install-bar` 与 `#btn-forgot` 都在、**控制台 0 条报错** |

发布顺序（照抄即可）：

```bash
npm test                 # 74 文件 / 2774 项 / 0 失败
npm run backup           # ⚠️ 必须先跑：部署会覆盖项目内的种子文件
node scripts/probe-install.js 390 844 /tmp/x   # 或任何一组朝向
# 部署 → 然后核 health 三字段 + md5 + sw 版本 + 缓存头 + 榜单人数
```

**`npm run backup` 这一步不是仪式**：部署会把整个项目目录上传，`server/data/profiles.json`
被覆盖。主数据文件在 `~/.lxw-appdata/` 下能扛重启，但扛不住容器重建 ——
种子一旦是旧的，重建那天全员账号和战绩就回到上一次备份的样子。

---

# 38. A 档 7 条：把"看起来没问题"的下一次都堵上

承接第 37 章。那 8 条修完发出去（v76），接着做的是 review 里剩下的 P2 里
**成本低、但不修就一定会咬人**的那一批。全部当天修完并发布（v77 / 20261030s）。

| | 修复前 | 修复后 |
|---|---|---|
| `npm test` | 74 文件 / 2774 项 | **77 文件 / 2845 项 / 0 失败**（+3 文件、+71 断言） |
| `scripts/journey.js` | 114 项 | 114 项 / 0 失败 |

## 38.1 五花牛：一条"靠上游保证"的隐式契约

```js
var allCourt = true;
for (var i = 0; i < hand.length; i++) { if (!(11 <= rank <= 13)) { allCourt = false; } }
if (allCourt) return { type: 10, ... '五花牛' };     // ← 从没问过 hand.length 是不是 5
```

三张 J/Q/K 传进来就是「五花牛」，收 4 分/人。正常流程进不来（`submitGroups` 卡死 5 张），
所以这条一直没暴露。但它的正确性完全依赖**另一个模块的一句校验**，
而那种依赖在重构里是最先断的。现在 `hand.length === 5` 写在函数自己身上，
线上实测：三张 → `{type:9, 牛牛}`，五张 → `{type:10, 五花牛}`。

**这类缺陷的共同点**：它不崩、不报错、测试全绿，只在"哪天多一个调用方"的时候突然出现。

## 38.2 第二轮不该把第一轮的牌写进档案

第 2 轮只打「单张 + 斗牛」，但 `submitGroups` 把四条键**原样拷贝**：

```js
p.groups['round' + round] = { single, tenhalf, piaosanye, douniu };   // 四条全拷
```

校验只看本轮那两组，所以多带的两组既不报错、也不结算 —— 但会**存进档案**。
档案里于是出现"这一局他手里并没有的那些牌"：回放按 group 遍历会读到、
以后谁写个"统计十点半手牌分布"的分析会先撞上这份脏数据。

现在只落 `ROUND_GROUPS[round]` 里的键，其余置空（形状仍是四条键齐全，前端按固定形状读）。
`pwa/test/groups-hygiene.test.js` 专门盯着这件事，包括
"客户端多塞了两组 → 也不落库"这条。

**顺带记一个测试时序的坑**：第二轮最后一个人提交会立刻结算，结算后 `dealAll` 把全员
groups 重置成空。所以断言必须落在"本轮已落库、但还没结算"的窗口里 ——
用 2 人局、让 A 先提交 B 后提交。第一版没注意这个，测出来的全是空值。

## 38.3 幂等键：修"误挡"不能顺手把"重复"也放进来

原来的键是 `房间#场次`。房间号 6 位、**会回收**，`_seen` 只留最近 40 条，
于是「同一房间号 + 同一场次号」撞上时，第二场会被当成重复**静默丢掉** ——
玩家打了一整场，档案里什么都没有，也没有任何报错。

加上 `endedAt` 之后要把两件事一起验，否则很容易按下葫芦起瓢：

| 场景 | 期望 | 为什么 |
|---|---|---|
| 同一场被重复广播（三个分量完全相同） | 挡住 | `settledAt` 在 `markSettled` 里只写一次，重复广播拿到的是同一个值 |
| 房间号回收后撞到同一场次（时刻不同） | **要记** | 这是另一场真打的牌 |
| `endedAt` 缺失 / 为 0 / NaN / 字符串 | 退回两段式键 | 宁可保留原来的重记窗口，也不要变成「每广播一次记一场」 |

`server/test/idempotency-key.test.js` 把这三行逐条锁死。
`persist.test.js` 里那条老用例也跟着改了：它原来用 `Date.now()` 造"重复写入"，
在新键下那已经是**两个不同的时刻**、本来就该记两次 ——
**测试得跟着语义走，不能反过来让语义迁就测试**。

## 38.4 键盘弹起时不要抖那一下版式

`#viewport` 是 `fixed; inset: 0`，安卓键盘一弹出布局视口被压掉一半 →
`ResizeObserver` 触发 `resize()` → `stageH` 从 1624 掉到 1000 出头 → `compact-v` 挂上。
表现：登录页/改名弹窗里一打字，整页字号间距缩一档，收起键盘又弹回来。

判据用「焦点是不是在输入控件上」，不去量键盘高度 —— 键盘高度各家不同
（还有悬浮键盘、外接键盘、候选栏），而"现在有没有在输入"是确定的事实。

**只挡类切换，不挡缩放计算**：屏幕确实变小了，缩小是对的，用户也需要输入框留在可见区。
另外补了一个 `blur` 监听在失焦后补量一次 —— 键盘收起不一定派发 `resize`
（iOS 尤其不可靠），否则那次被跳过的档位判定就永久丢了。

## 38.5 登录耗时会泄露账号是否存在

文案早就统一成「账号或密码不正确」，但耗时没统一：不存在的账号查一次 Map 就返回（~1ms），
存在的账号要跑 scrypt（~60ms）。`time_total` 比任何文案都诚实，防枚举等于白做。

现在「查无此人」也跑一次同参数 scrypt（`auth.verifyDummy`，一组永远对不上的占位 salt/hash）。
测试按"取 3 次里的最小值"比较，阈值放到 0.5 倍 —— 修之前这个比值是 0.01 量级，
修完之后两条路在同一量级。

## 38.6 导航抢跑阈值 3000 → 4200

线上冷启动（容器唤醒）拿 index.html 首字节实测 **3.18s**，而 SW 的 `NAV_TIMEOUT_MS` 是 3000ms。
差 180ms，后果是"服务其实马上就回了，SW 却先抢着给缓存，网络回来再刷新一次"。
改成 4200ms：比实测慢值多 1 秒余量，又没长到让弱网用户干等。

测试同时锁了两头：3.999 秒时**不许**抢跑、4.2 秒时**必须**回落。
只锁后者的话，有人把值调回 3000 测试照样绿。

> 顺带发现测试自己的一个坑：`env.elapse(ms)` 是「触发所有 `ms <= 参数` 的定时器」的
> **绝对阈值**，不是累加。我先写 `elapse(3999)` 再 `elapse(201)`，第二个调用永远不会触发
> 4200ms 的定时器 —— 表现为测试挂住不出结果。以后在这个 harness 里加时序用例要注意。

## 38.7 心跳判活：`conns` 不是在线人数

发布 v76 时实测到的现场：`rooms: 3, conns: 9`，重启后立刻 `0 / 0` —— 那 9 条一个活人都没有。
WS 只在对面正常关闭（FIN/RST）时才触发 close；移动端切后台被回收、`kill -9`、
地铁进隧道都不发 FIN，连接就一直躺着。代价三层：占 fd 和缓冲、
`room.players[].connected` 一直是 true（别人看不到他掉线）、并且把 `conns` 撑成假的在线人数。

做法：每 30 秒给每条连接发**协议层** ping，连续两轮收不到 pong 就关掉。
用协议层而不是应用层 JSON，是因为浏览器收到 ping 由网络层自动回 pong，
**不需要页面 JS 参与** —— App 切后台、JS 被挂起时仍能应答。
这样"页面在后台"和"连接已经死了"才区分得开，不会因为用户切个 App 就误踢。

四个容易做错的地方，都写进了 `server/test/ws-heartbeat.test.js`：

1. **不能用 `_kick`**。那个会发 `{kicked:true}`，前端据此**永久停止自动重连**。
   心跳失败恰恰最该重连（用户可能只是进了电梯）。所以走普通 `close(4001)`，
   前端照常 `scheduleReconnect`，服务端走正常断线路径 + 90 秒宽限。
2. **任何业务消息也算活着**。有的中间层会吃掉控制帧却正常转发数据，
   那种连接业务上完全可用，只认 pong 会把它们全判死 —— 那不是清僵尸，是制造故障。
3. **socket 写不进去立刻关**（4002），不必再等两轮。
4. 时间账：30s × 2 + GRACE 90s ≈ 一个切后台的用户有 3 分钟回来。

同时 `stats()` 多给一个 `online`：真的坐在房间里、没弃局、连接还在的**去重真人**数。
`/api/health` 现在同时返回 `conns`（连接数）和 `online`（在线人数），
运维看板上不会再被僵尸连接骗。

## 38.8 发布核对（v77 / 20261030s）

| 核对项 | 结果 |
|---|---|
| `/api/health` | `uptime 18`、`version 20261030s`、`pwa 20261030s`、**新增 `online` 字段** |
| 前端逐字节 | 9 个文件 md5 全一致 |
| 老客户端能升级 | 线上 `sw.js` = `weile-liuxuanwu-v77`，`NAV_TIMEOUT_MS = 4200` |
| 五花牛口径 | 线上实测：三张花牌 → `{type:9,牛牛}`；五张 → `{type:10,五花牛}` |
| 档案完整 | 发布前后都是 8 位玩家 |
| 浏览器冒烟 | `20261030s`、`install-bar` / `btn-forgot` 都在、**控制台 0 异常** |

---

# 39. B 档：图标、manifest、gap、首屏 —— 以及一次「不修」的决定

承接第 37、38 章。A 档之后剩下的 P2 里，属于「要重画资源 / 要动大量样式 / 要动首屏时序」的那批，
这次一起做掉，同时把**不在 B/C 档里的已知问题**落成一份文档（`docs/BACKLOG.md`），
把兼容边界落成另一份（`docs/compat.md`）。

| | 上轮（v77） | 本轮（v78） |
|---|---|---|
| `npm test` | 77 文件 / 2845 项 | **78 文件 / 2876 项 / 0 失败** |
| `scripts/journey.js` | 114 项 | 114 项 / 0 失败 |
| 新增探针 | `probe-install` | `probe-flex-gap`（20 项）、`probe-first-paint`（12 项） |

## 39.1 maskable 图标：先量，再画

原报告写的是「maskable 复用了带金色圆角边框的 `icon-512.png`，圆形裁切后四角毛边」。
动手前先把这句话变成数字：

```
金色边框外沿 x=26            → 它的角点 (26,26) 到中心 (256,256) = 325px
maskable 安全圆半径 = 512×0.4 = 205px
325 > 205  ⇒  四个角必然被切
```

再写了个判定脚本统计「安全圆之外、且与底色不同的像素」：

```
icon-512.png            安全圆外非底色像素： 75028
icon-maskable-512.png   安全圆外非底色像素：     0
```

**7.5 万像素**就是那圈金边被圆切掉的部分。这不是「毛边」的修辞，是可数的。

新图的画法（`scripts/gen-maskable-icon.py`，可复跑）：满幅 `#16382F` + 白卡内缩到 250×321、
圆角 48，最远点 184.3px（安全半径 204.8，留 20px 余量）。**只做几何重排，不重画字形** ——
白卡和红字都是从原图裁出来等比缩放的，品牌保持一致。

顺带发现原图的白底其实是一个**竖长圆角卡片**（287×369）而不是方块，代表扑克牌。
按方块做会让比例失真。

## 39.2 manifest：`id` 是唯一不能随便写的字段

补 `id` 时最容易犯的错是「随便写一个」。`id` 是已安装应用的身份标识：

```
不填 id  → 浏览器拿 start_url 解析结果当 id → "https://<host>/"
填 "/"   → 解析后是同一个值               → 老用户平滑，什么都不变
填 "/?app=lxw" → 身份变了 → 桌面图标还在，点开却是"另一个应用"，
                 两套 storage、两套 SW 缓存
```

所以测试里锁的不是「有个 id 就行」，而是 `id === '/'` **恒等**。

`screenshots` 用真实界面图：跑了 `LXW_SHOTS=1 node scripts/journey.js`，
从 12 张里挑 2 张，转 WebP（68KB + 44KB）。测试里加了一个 WebP 文件头解析器
（VP8/VP8L/VP8X 三种容器宽高位置都不同），把 `sizes` 字段和真实像素对账 ——
写错了浏览器只会静默忽略，不报错。

`shortcuts` **没加**：它需要能直达某个页面的 URL，而这是个没有路由的 SPA。
加上去只会得到一个点了没反应的菜单项，比没有更糟。

## 39.3 flex gap：91 处，一个都没改

原报告写的是「104 处 gap 迁 margin」。真动手前先解析了一遍（`scripts/analyze-gap.js`），
发现两件事让这个方案不成立：

**第一，104 这个数字不准。** 它来自 `grep -c "gap:"`，把 `grid-gap`、注释也算进去了。
按 CSS 块解析出来是 **91 处**。

**第二，9 处无法用 margin 等价表达。** 这些容器同时用了 `justify-content: space-*`：

```css
.pf-row { display: flex; justify-content: space-between; gap: 12px; }
```

`gap` 的语义是「**至少**留 G，剩余空间再均分」；换成子元素 `margin-left` 后，
margin 会先吃掉空间，第二个元素被往里推 G —— 不是「间距小一点」，是**位置错**。
这类错位在现代浏览器上一眼能看出，但只会在「改了之后」出现。

再加上一个现实约束：76 处散在 4 个媒体查询里，改错一处只是「某个尺寸下偏几像素」，
单测抓不到，只能人眼比截图。**拿所有人的正确布局去赌少数老内核的观感，不值。**

### 改成「检测 + 条件生效」

```
现代浏览器：html 上永远不会有 .no-flex-gap → 兼容层 76 条规则一条都不匹配 → 布局逐像素不变
老内核    ：检测到不支持 flex gap → 挂 class → margin 规则接管间距
```

检测不用 UA（国产浏览器 UA 完全不可信，且随内核更新失效），而是真实渲染探测：
造一个 column flex + 两个零高度子元素 + `row-gap: 2px`，量到高度 2 就是支持。

**异常时按「支持」处理**：宁可老内核没间距（难看），也不要现代浏览器被误判后
gap 与 margin 双重生效（所有人一起坏，而且间距翻倍）。

### 怎么证明「真的零回归」

读代码说「规则都挂在 class 下」是不够的，得实测。`scripts/probe-flex-gap.js` 分三步：

1. 打开页面，断言 `document.querySelectorAll('html.no-flex-gap *').length === 0`
   → 选择器一个元素都匹配不到 → 任何计算值都不会变；
2. **把兼容层 CSS 真装进文档**（不挂 class），再验一次：仍然 0，间距与之前完全相同
   → 排除「文件加载本身有副作用」；
3. 模拟老内核：把容器 `gap` 强制置 0、挂上 class，量间距是否**回到原 gap 值**。
   `.join-row`：16px → 抹掉变 0 → 兼容层补回 16。（±1px）

第 3 步是唯一能发现「方向判反」的手段 —— `flex-direction: column` 的容器要补 `margin-top`，
判成 row 就会补 `margin-left`，而这种错在现代浏览器上永远看不出来。

覆盖率：页面可见的 11 个 flex+gap 容器，**11 个全部覆盖**。

### 踩到的两个坑（都是探针自己的错）

1. 覆盖率第一次算出 2/11。原因是拿**容器本身**去 `matches('html.no-flex-gap .x > * + *')` ——
   那个选择器匹配的是容器的**子元素**，容器永远不会匹配。改成拿最后一个子元素去试。
2. column 方向第一次「通过」得毫无意义：抓到的是房间页的 `.room-actions`，它在首页 `display:none`，
   量出来 `before=0, after=0`，`0 === 0` 让断言绿了。**隐藏元素测出来的 0 什么都不能证明。**

## 39.4 首屏：查出一个比原报告更严重的问题

原报告写的是「`#screen-home` 没有 `hidden`，首屏闪一下首页」。修的过程中发现还有一层：

**`--pt-scale` 只在 `game.js` 里设置，默认值是 1。**

也就是说 boot 之前，750 宽的设计稿是 **1:1 铺在 390 宽的屏幕上**的。用户先看到的是一屏
放大到溢出、只剩左上角的内容，等 `game.js`（defer，要等整个文档解析完）跑完才「啪」一下缩回去。

这比「闪一下首页」严重得多：闪的是**错的版式**。冷启动时那段时间足够让人看清。

### 能修，是因为 CSS 变量会继承

`#stage { transform: scale(var(--pt-scale, 1)) }` —— 变量可以设在 `<html>` 上，
让 `#stage` 从祖先继承。所以 head 脚本不需要 `#stage` 已经存在，`setProperty` 到
`documentElement` 就生效。

竖屏的 scale 只由宽度决定（`avw / 750`，左右安全区在竖屏下恒为 0），
所以 head 算出来的值与 `game.js` **完全一致**，接管时没有跳变。探针实测：

```
首帧（预缩放）宽 390px → boot 后 390px
```

### 登录态判定

`html.no-session` + 两条 `!important` 规则（要压过 `.hidden` 的 `!important`），
`showScreen()` 第一次被调用时摘掉。兜底原则是**读不到就当正常**：

| 情况 | 处理 | 结果 |
|---|---|---|
| 没有会话 | 挂 `.no-session` | 首帧就是登录页 |
| 有会话 | 什么都不做 | 首帧就是首页，不用等 boot |
| localStorage 抛异常 | 不挂 | 按已登录处理，最坏是闪一下，不会白屏 |

探针验证方式很直接：**把 `game.js` 弄成 404**，页面就永远停在「CSS 已应用、boot 还没跑」
那一帧上，可以从容量。三种情况各一条断言。

### 横屏为什么没修

横屏要切 `.ls` 这个 **class**，而 `.ls` 挂在 `#stage` 上 —— head 脚本执行时 `#stage`
还没被解析出来。CSS 变量能设在祖先上（所以竖屏能修），class 不行。
记进 `docs/BACKLOG.md` 的 **B-L1**，附了两种未来解法。

## 39.5 两份文档

**`docs/compat.md`** —— 兼容矩阵。不是抄一份能力表，而是回答「在某个具体浏览器里，
哪些能力能用、哪些降级、哪些根本不可用」。附带「刻意没用到的能力」一节
（`:has()` / container queries / `dvh` / `color-mix()` / `@layer` / 原生 `dialog`），
每一条写了为什么不用 —— 防止以后有人「顺手现代化」然后砸了老设备。

**`docs/BACKLOG.md`** —— 已知问题清单。18 条，每条必带「为什么现在不做」和「将来怎么验」。
分类原则是**修法不同**而不是严重程度不同：

- **C 档**（结构性，改了不改行为）：`game.js` 5195 行、双份统计、静默 catch、`state` 膨胀…
- **D 档**（要产品决策/外部条件）：微信不能装桌面、忘密码、退出全部设备、密码下限…
- **B-L**（本轮刻意留下）：横屏首帧、9 处 `space-*`、3 处 wrap、兼容层不预缓存
- **N**（新发现未修）：房间页「补 AI 队友」按钮断成两行

最后还有一节「**明确接受的取舍（不是问题，别修）**」，列了 8 条 ——
包括「大量 `var` 是兼容老 WebView 的有意选择，不要现代化成 `const/let`」。
这一节的价值是防止下一次 review 把设计决策当成缺陷重新提一遍。

## 39.6 发布核对（v78 / 20261030t）

| 核对项 | 结果 |
|---|---|
| `/api/health` | `uptime 18`、`version 20261030t`、`pwa 20261030t`、`online 0` |
| SW | 线上 `weile-liuxuanwu-v78` |
| manifest | `id: "/"`、4 个图标（2 any + 2 maskable 独立文件）、2 张 screenshots |
| 逐字节 | 13 个文件 md5 全一致（含 `flex-gap-fallback.css`、两个 maskable、两张截图） |
| 线上首帧 | `stageW 492 = vw 492`、`html.class = " no-session"`、登录页 flex / 首页 none |
| 档案 | 发布前后都是 8 位玩家 |

## 39.7 这轮留下的

`docs/BACKLOG.md` 是本轮的主要产出之一，不是附赠。18 条里有 5 条是本轮**新发现**的
（横屏首帧、`space-*` 的 9 处、wrap 的 3 处、兼容层不预缓存、以及按钮断行）。

写这份文档时反复问自己一个问题：**「为什么现在不做」写不出来，是不是说明它其实该做？**
有两条因此被从「待办」移到了「本轮就做」（maskable 和首屏预缩放）—— 因为它们的理由只有
「麻烦」，没有「风险」。

---

# 40. 组合 A 落地（v79 / 20261030u）

来源：`docs/BACKLOG.md` 的「组合 A」——C6 + N1 + D4 + D7，外加 C1 的第一步。
选这四条的理由是它们**互不依赖、改动面都在局部**，可以一个提交交付并一次验收。
结构性的 C1 按原计划单独一轮，这次只做了其中不需要碰测试基线的部分。

## 40.1 C6：`undefined` / `null` 不该出现在界面上

三个点，同一个病根：**渲染函数把「数据缺失」当成「有数据」**。

| 位置 | 改之前 | 改之后 |
|---|---|---|
| `esc(g.winnerNickname)` | 页面上出现「undefined」 | 空 |
| 结算行 `p.nickname + '（弃局）'` | 「null（弃局）」 | 「?（弃局）」 |
| `'玩家' + myId.slice(-4)`（两处） | 空 id 时就是光秃秃的「玩家」 | 「我」 |

`esc()` 的改法值得写下来，因为第一版差一点就写错：

```js
/* 错：falsy 判断会把 0 和 false 一起吞掉 */
if (!s) return '';
/* 对 */
if (s === undefined || s === null) return '';
```

分数 0 是**有意义的显示内容**（净胜 0 就是 0），`esc(0)` 必须还是 `'0'`。
这条在 `render-guards.test.js` 里单独钉了一条断言 —— 不是防现在，是防以后有人
「顺手简化成 `if (!s)`」。

**为什么昵称兜 `?` 而自己兜「我」**：兜 `''` 会让整行剩一个「（弃局）」，
反而更像坏了。展示位需要一个占位符，而不是「什么都没有」。这两者不是同一种空。

## 40.2 D4：密码下限提到 8 位，但**不能**在登录上生效

这是一条最容易做错的安全改进：把 `passwordProblem` 的下限从 6 改成 8，
如果连登录路径也校验长度，所有历史账号（6 位密码是**当时被允许**的）当场锁死。

所以下限只作用在「产生新密码」的三个入口（注册 / 改密码 / 管理员重置），
登录路径根本不调 `passwordProblem`。测试用状态码区分这两件事：

```
6 位密码注册      → 400（校验失败）
6 位密码登录      → 401（密码不正确）  ← 不是 400，说明长度没被校验
```

跑第一遍时我写的是 403，因为记得改密码接口回 403。**登录回 401**，测试红了，
改的是断言不是实现 —— 这两个码本来就该不同：400 是「你的请求不合法」，
401 是「凭据不对」。

## 40.3 D7：配额满的时候，先腾地方，再说话

原来的 `rawWrite` 是「try → 失败 `return false` → 调用方 `catch (e) {}`」。
于是配额满的唯一外部表现是「这局打完了，战绩页里没有」，而且一个字都没有。

改成三态返回值（`'ok'` / `'trimmed'` / `false`），两段降级：砍一半 + 丢 `replay` → 只留 10 条。
`noticeRecordsWrite()` 每局最多提示一次；`writeFailed` 的文案必须写明「云端记录不受影响」，
不然玩家会以为整场都没了。

**测试为什么用带容量的 mock 而不是真塞 5MB**：真塞只能证明「不崩」，
证明不了「裁掉的是最老的、留下的是最新的」。第二个场景还暴露了一件事 ——
如果记录本身已经占了大部分额度，「裁到 10 条」自然就腾出空间，永远走不到 `writeFailed`。
真正写不进去的形态是「额度被别的 key 占死、战绩本身很小」，mock 必须照那个形状造。

## 40.4 N1：断字的根因不是「按钮太窄」

我最初在 BACKLOG 里写的原因是「按钮太窄」。实测推翻了它：

容器 348（屏幕像素），三颗按钮 `flex: 1` 各分到约 108，
而「补 AI 队友」按字号算需要约 118。缺的这 10px，浏览器不是靠换行解决，
而是靠**把「友」挤到第二行**——因为中文允许逐字断行，而 flex 默认不换行。

所以修法必须是两句一起说：`white-space: nowrap`（不许断字）+ `flex-wrap: wrap`（可以换行）。
只改第一句会横向溢出，只改第二句还会在等宽约束下断字。

两个细节值得留档：

1. **不能加 `min-width: 0`**。加了之后 flex 允许把按钮压到内容宽以下，
   结果是文字溢出按钮边界，比断行更难看。默认的 `min-width: auto`（= min-content）
   正是让「装不下就换行」生效的那个东西。
2. **横屏那条 `flex-direction: column` 必须补 `flex-wrap: nowrap`**。
   column + wrap 在高度不够时会另起一列 —— 三颗按钮会横着排成三列。

实测结果比预期好：320/360/390/430 四档全部一行放下，连「2+1 换行」都没用上。

## 40.5 C1 的第一步：拆 `bindEvents`，但**没有变小**

`bindEvents`（570 行）按屏拆成 11 个具名嵌套函数。做完之后要诚实地说一句：
**文件从 5195 涨到 5284 行，`bindEvents` 的函数体跨度从 570 变成 620。**
拆出来的都是内部嵌套函数，闭包一点没动 —— 这正是「行为零变化」的代价。

拿到的只有「定位成本」：改战绩页就只读 `bindRecordsNav`（20 行），
不用在一屏看不完的函数里上下翻。丢掉的是「行数、体积、合并冲突」这三样，
一样都没解决。

**跨文件拆分没做的原因写在这里，免得下一轮重新论证**：`pwa/test` 有 26 个文件用
`readFileSync('js/game.js')` 做源码级断言（46 处引用）。把函数搬走之后这 46 处全变假失败，
而「修假失败」最省事的办法是删断言 —— 那就是拿测试换结构。
要做就得连带改 26 个测试文件、`sw.js` 的 PRECACHE、版本号，单独一轮。

拆的过程中用了一条可验证的等价性判据，比「看起来没动」可靠：
把拆前拆后的 `bindEvents` 都去掉注释与空白，逐行比对**非空行的多重集** ——
537 行原样都在，一行没丢。语法由 `node --check` 兜，行为由 2931 项断言 + journey 114 项兜。

## 40.6 顺手修了一条长期红的探针

`probe-leave.js` 有一条断言写死了按钮文案「离开」，而按钮早就改成「离开房间」
（对局页两个出口并排后加的区分）。跑 HEAD 版本确认**与本次改动无关**（同样 18/1），
按现有文案改断言并写明理由。

一条长期红的断言比没有断言更坏：它训练所有人「红了正常」。

## 40.7 验证

| 项 | 结果 |
|---|---|
| `npm test` | 81 文件 / 2931 项 / 0 失败（v78 是 78 / 2876） |
| `npm run journey` | 114 项 / 0 失败 |
| `probe-install.js 390×844` | 23 / 0 |
| `probe-guide.js` | 39 / 0 |
| `probe-leave.js` | 19 / 0（修完那条陈旧断言后） |
| `probe-room-actions.js` | 20 / 0（320/360/390/430 + 横屏 844×390） |
| flex-gap 兼容层 | 重跑生成器，输出零变化 |
| 语法 | `node --check pwa/js/game.js` |

## 40.8 这一轮留下的

- **C1 的跨文件拆分**仍是 BACKLOG 里最大的一块，代价已量化（26 个测试文件 / 46 处引用 /
  PRECACHE / 版本号），必须单独一轮；
- C1 的第一阶段让文件**变长了 89 行**，这是一个诚实的负分项，写在 BACKLOG §2 里；
- C2 / C3 / C4 / C5 未动；D1 / D2 / D5 / D6 未动（都不该现在动）；
- B-L1（横屏首帧）/ B-L2 / B-L3 / B-L4 未动，理由未变。

---

# 41. v79 上线与线上冒烟

发布时间 2026-10-30 17:28（GMT+8），链接不变，`sharecode` 不变，`deployedAs: http-service`。

## 41.1 核对结果

| 项 | 结果 |
|---|---|
| `/api/health` | `version=20261030u`、`pwa=20261030u`、`server=2026-10-30T09:24:39Z`、`uptime` 归零（确认是新进程） |
| 逐字节 md5 | `game.js` / `sw.js` / `index.html` / `style.css` / `records.js` 五份全部与本地一致 |
| SW 版本 | 线上 `CACHE_NAME = weile-liuxuanwu-v79` |
| 缓存头 | `sw.js` / `manifest.webmanifest` / `index.html` 均为 `must-revalidate, no-store`；`js/game.js` 为 `max-age=3600`（靠 `?v=` 版本参数换 URL） |
| 榜单 | 8 人，前三 玩家D 25 场 +99 / 玩家A 27 场 +55 / 玩家B 20 场 +14 |
| 首屏资源 | 14 份 `js`/`css`/图标/manifest 逐条 200 |
| headless 冒烟 | 0 JS 异常、0 `console.error`、SW 已接管、登录页可见且首页 `display:none` |

## 41.2 冒烟里抓出来的两件事

**第一件是我自己的假失败，值得记下来。** 第一遍跑资源冒烟时 14 份全部 403，
差点当成发布事故。原因是脚本里用 `urllib.parse.quote(path)` 拼 URL，
把 `?v=20261030u` 里的 `?` 编码成了 `%3F` —— 网关当然不认。
**检查脚本本身也是被测对象**：一个"全红"的结果，先怀疑脚本，再怀疑部署。

**第二件是真的：`manifest.webmanifest` 403。** 浏览器控制台里 5 条 error，
其中两条是 manifest 抓取失败。链路是这样的 ——

```
页面 <script src>        → 经 SW fetch 拦截，withShare() 补 sharecode → 200
sw.js 注册               → 注册时手工拼 location.search            → 200
manifest / apple-touch-icon → 浏览器内部抓取，**不经过 SW**         → 403
```

以前没发现的原因是 `probe-install.js` 跑在本地静态服务器上，没有网关这一层；
而 curl 核对时 query 是我自己拼的，浏览器不会那样拼。**"本地绿"和"线上绿"是两件事。**

影响已经写进 BACKLOG N2：安卓装不出 WebAPK，iOS 桌面图标变成页面截图，
v76 那套 maskable 图标在线上其实没生效过。对局本身不受影响。这一条没有在 v79 里修 ——
它是发布核对发现的问题，不是 v79 引入的问题，混进来会让"这版到底改了什么"说不清。

## 41.3 关于"删掉一个玩家，别人的战绩会不会变"

被问到这个问题时，答案完全取决于数据模型，所以先把模型写清楚：

`server/data/profiles.json` 是 `playerId → 档案` 的**扁平表**，没有对局表、没有参赛关系表。
每条档案自包含：`games / wins / losses / draws / totalNet / currentStreak / … ` 加上
`recent[]`，而 `recent[]` 的每一项只有 `endedAt / net / roomId / playerCount / endReason`
—— **里面没有"对手是谁"这个字段**。

结算时 `hub` 对每个玩家各调一次 `profiles.record(pid, …)`，把自己的净胜分写进自己那条。
于是：

- 删除 A = `profiles.remove(A)`，只少一条记录，没有任何外键要级联；
- B 的场次、胜率、净胜、连胜**一个都不变**，也不会重新结算
  （`net = 终分 − 20` 在结算那一刻就写死了，事后没有回溯重算的入口）；
- 唯一变化是排行榜 `top()` 按现存档案排序，A 消失后 B 的名次可能前进一位 ——
  **名次会变，分数不会变**；
- 删自己 = 重新注册是全新号，战绩从 0 开始（这也是删号确认文案里写明的那句）。

真正的残留不在服务端，在**本机**：`leaveAccountState()` 清登录态和昵称，
但不清 `lxw_records_v1` / `lxw_sessions_v1`。所以删号者自己手机上旧回放还在，
和他打过的人手机上回放里也有他的 `playerId` 与昵称（`slimRound()` 的 `i`/`n`）。
这条记进了 BACKLOG N3。

## 41.4 这一轮的净产出

- 线上从 `20261030t`（v78）升到 `20261030u`（v79），组合 A 四条 + `bindEvents` 按屏拆分生效；
- 新增 BACKLOG N2 / N3 两条，都是**发布核对和提问过程里查出来的**，不是猜的；
- 建立了一条新的验收习惯：**发布后要用真实浏览器打开线上地址收一次 console**，
  curl 只带 sharecode 的请求覆盖不到浏览器内部发起的抓取。


---

# 42. 删号的三处清理（v80 / 20261030v）

## 42.1 需求不是「修个 bug」，是「补一个从不存在的东西」

用户的原话是：A 删号后，他所有对局数据要删，和别人产生的关联数据也要删。

第一遍查证得到的结论是反直觉的：**服务端没有任何"关联数据"可删**。
`profiles.json` 是 `playerId → 个人统计` 的扁平表，`recent[]` 里只有
`endedAt / net / roomId / playerCount / endReason`，**一个指向人的字段都没有**。
`server/profile.js` 自己写着那句话：

> 服务端从来没有存过「这一局有哪几个人」——房间是内存对象，结算完就回收了。

所以"级联删除"在这个数据模型里没有对象。系统里唯一真正存了"A 和谁打过"的地方，
是**别人手机上的回放**（`lxw_sessions_v1` 里 `slimRound` 的 `i` / `n`）。

这一步确认得值：如果跳过它直接写"删 A 参与的对局"，会发现自己无处下手。

## 42.2 把一条需求拆成三个，代价差 100 倍

| | 诉求 | 原来的状态 | 代价 |
|---|---|---|---|
| R1 | A 自己的数据消失 | 服务端删了，**本机两份副本没清** | 半天 |
| R2 | A 在别人设备上的身份消失 | 完全没做 | 1 天 |
| R3 | A 参与过的场次从**别人战绩**里消失 | 没有可删的数据结构 | 4–5 天，且不可逆 |

R3 才是最容易被"关联数据也要删"这句话命中的那个，但它有个副作用：
B 的场次、净胜、连胜全变，排行榜可能易主，而 B 什么都没做。

而 B 的记录里其实**没有 A**。所以"删掉 A 在 B 那里的痕迹"这件事，
真正要抹的是**身份**，不是**分数**。这两者被日常语言混在一起，代价差一个数量级。

用户最终选了「只抹身份」—— 我认为这是对的，理由写在 `docs/deletion-spec.md` §7.1。

## 42.3 三个 bug，全是探针抓的，全是"看不出来"的那种

写完代码时：单测 2931 项全绿，语法检查通过，逻辑读起来没有问题。
然后 `scripts/probe-delete-purge.js` 一跑，三个全挂。

**第一个**：删号成功了，本机战绩一条没删。
`AuthStore.deleteAccount()` 成功后立刻 `clearSession()`；
`leaveAccountState` 里再问「我是谁」只能拿到空串；
而 `Records.clear('')` 匹配的是「没有归属的老记录」—— 自己这个号的一条都不动。
**界面上还显示"账号已删除"。**
修法是发请求之前把 pid 拿在手里传进去。

这个 bug 的形状值得记住：**两个都很合理的实现，组合起来是错的**。
`deleteAccount` 清会话是对的，`leaveAccountState` 从会话里取 pid 也是对的，
而它们在时间上错开了。这种 bug 单测怎么写都写不出来 ——
除非真的点一遍按钮。

**第二个**：存活查询用了裸 `fetch`，既没拼 sharecode（线上网关 403）
也没带 `X-Session-Token`（401）。本地服务端不校验网关，所以本地是通的。
和第 41 章的 manifest 403 是同一类问题的两面。

**第三个**：清理跑完了，界面上的名字还在。
scrub 改的是磁盘那份，内存里的 `packs` 还是清理前的，拿它重画等于什么都没变。

## 42.4 设计上改掉的一处：不要墓碑表

原方案里设计了一张 `tombstones.json` 存 `sha1(playerId)`。
实现时发现不需要 —— `/api/players/alive` 要回答的就是「这个档案还在不在」，
`profiles.has(pid)` 直接就是答案。

多一张表就多一处「必须和删除保持同步」的地方，而它换来的唯一能力是
区分「已注销」和「从没存在过」—— 调用方传上来的 id 全都来自真实回放，
不存在后者。**少一个状态，少一类 bug。**

## 42.5 抹字段，不删行

回放里被抹掉的人显示成「已注销玩家」，牌和分数原样留着。

为什么不是删整行：1v1 局删掉对手那行，回放里只剩一个人，
渲染出来像一副没打完的牌。而回放的价值在「这把牌怎么走的」，
不在「对手叫什么」。这是用户要的东西，也是能保住的数据完整性。

一个细节：组头的赢家字段（`g.w`）**只有昵称、没有 id**。
所以清理必须两遍 —— 先把「已注销的人用过的昵称」收集起来，再清。
顺序反了就再也对不上，回放里会变成「已注销玩家出了这些牌，小明赢」。
人抹了、名字还在，等于没抹。

判据定为 **`i` 与 `n` 同时为空 = 已注销占位**。
只有 `i` 为空是「老数据没存 id」= 不知道名字，不是已注销。
这两者混起来，所有老记录都会凭空变成「已注销玩家」——
这条在测试里单独钉了一个用例。

## 42.6 顺手补上的两个既有缺陷

**种子复活窗口**：`remove()` 只写主文件，而种子是容器重建时唯一的恢复来源。
A 删号后、下次 `npm run backup` 之前，容器只要重建一次，
种子就把 A 原样恢复 —— 账号能登录、战绩全在，删号等于没删。
修法是一行：删完立刻 `writeSeed()`。

**连接是懒踢**：`hub.kickPlayer` 早就存在（管理端那条路一直在用），
但用户自助删号这条路没调。靠 `_pid()` 每次复查账号也能兜住，
只是要等 A 下一次操作 —— 他停在结算页不动，连接就一直挂着。
两条删号路径现在长得一样了。

## 42.7 验证

| 项 | 结果 |
|---|---|
| `npm test` | 83 文件 / **3004 项 / 0 失败**（v79：81 / 2931） |
| `npm run journey` | 114 / 0 |
| `probe-delete-purge` | **31 / 0**，两阶段 |
| `probe-install` / `probe-leave` | 23 / 0、19 / 0 |
| 线上 health | `20261030v` / `20261030v`，`uptime` 归零 |
| 逐字节 md5 | 6 份一致 |
| 线上 SW | `weile-liuxuanwu-v80`，二次访问 `controlled` |
| 线上冒烟 | 0 JS 异常；仅 N2 的 manifest 403 与 favicon 404 |

种子文件全程零 diff —— 这一点单独确认过：新增的 `writeSeed()` 会在删号时写种子，
如果某个测试没把 `SEED_FILE` 指走，它会覆盖掉真实种子。
跑完全量后 `git status` 干净，说明所有删号测试都指走了。

## 42.8 这一轮真正的收获

不是功能，是**验收方式**：
「本地全绿」证明不了「线上能用」，这两轮连着栽在同一件事上
（第 41 章 manifest 403、这一章裸 fetch）。
所以 `probe-delete-purge.js` 里全部断言都来自浏览器实测 ——
不看源码、不看单测结论，只看 `localStorage` 里那串字符串有没有变。

以及一个可复用的判据：**改别人的数据之前，先问「我要抹的是身份还是分数」**。
这一次答案选对了，省下的是 4 天和一场没有回滚的赌博。

---

# 第 43 章 · 底部色带第三次：这次拿到了 WebKit 的 issue 号（20261030w / sw v81）

## 43.1 用户原话

> 横屏和电脑端做了填充适配 但是 pwa 页面明显底部留空了 这个问题一直没有被解决，
> 而且不只是创建房间界面，你能看到在准备界面退出房间的截图，明显底部也是没做适配，
> 竖屏应该和横屏一样的逻辑去做适配，不能在底部留空，这样太难看了
>
> 准备界面点击别人查战绩 点击自己改名字？这个要统一 点击自己也是查战绩
>
> 游戏界面点击右上角自己不能查战绩 需要和游戏界面点击别人一样 可以查自己战绩

三件事：一条布局（第三次报），两条交互一致性。

## 43.2 先量截图：和上一轮是同一个数

四张截图（1023×2224）逐行取色，底部色带的起点全部在 **y = 2080±1**，高度 **143~144 图像 px**，
颜色 `(15,43,34)` = `#0F2B22` = `--green-deep`，**零方差**。

和第 33 章量到的完全一致（6.52% 屏高 / 55.7 CSS px）。也就是说：上一轮的修法在真机上
**一点作用都没有**，不是"部分改善"。

## 43.3 为什么前两次必然修不掉

第 32 章把 `stage.style.height` 的死值改成 `calc(100% / --pt-scale)`；第 33 章发现
`100%` 本身也小，于是加了 `--pt-h`（用 `screen.height` 校正）和 `min-height`。
两次都给 `scripts/probe-viewport-fit.js` 加了断言，**两次都是绿的**。

问题出在断言的对象：探针量的是 `stage.getBoundingClientRect().bottom`。
`getBoundingClientRect()` 是**布局几何**，它不知道自己有没有被父级裁掉 ——
舞台可以"算到" 852，同时"画到" 796。真机和探针的差别就在这一层：

```
布局视口 796（iOS 报的假值）
  html / body  height:100%  → 796，且 body 上写着 overflow:hidden
    #viewport  inset:0      → 796
      #stage   height:852   ← 算对了，但被 body 在 796 处裁掉
```

**只要 html/body 是 100%，舞台再高也出不来。**这一层前两章都没碰。

## 43.4 真因：WebKit bug 313800

搜出来的 WebKit issue 把这件事说得很干脆（iOS 26 / Safari 26）：

> iOS standalone PWA：`visualViewport` 比整屏矮**整整一个状态栏**，页面下方那条带子
> 落在 WebKit 暴露的视口之外，CSS 铺不进去。
> [bugs.webkit.org #313800](https://bugs.webkit.org/show_bug.cgi?id=313800)

同一份资料的实测口径是：`100dvh` / `100svh` / `100%` / `-webkit-fill-available`
**全部**返回那个"假矮值"，**只有 `100vh`（和 `100lvh`）是整屏**。

这一条把前两章的失败解释完了：
- 32 章用的 `100%` → 假值；
- 33 章用的 `screen.height` → 这个机型/系统上也拿到了假值（否则不会留 55.7）；
- 两个都没用 `100vh`（第 32 章的 `min-height: 100vh` 被 33 章换成了 `--pt-h`，
  而 `--pt-h` 是 JS 写的，值本身就是假的）。

所以这轮的做法是**两条一起上**，缺一条都不成立：

1. **高度来源**：竖版在 standalone 下把「当场量的 `100vh`」也算作候选，
   和 `screen.height` 一起取最大（仍只往上修、仍只修 ≤18%，分屏/多任务窗口不动）。
2. **裁切链**：`html` / `body` / `#viewport` / `#stage` 四层统一读 `--vp-h`，
   谁也不许再拿 `100%` 当高度 —— 否则第 1 条算对了也画不出来。

顺带把 `<head>` 里那段首帧预缩放补了一句：standalone 下先写 `--vp-h: 100vh`，
冷启动第一帧就不会先闪一条色带（那段脚本本来就在算 `--pt-scale`，加一行而已）。

## 43.5 交互：一张卡只该有一种行为

**准备界面**（房间页）：以前是「点自己的座位卡 = 改昵称，点别人 = 看战绩」。
同一张卡两种行为，玩家点自己的名字想看战绩，弹出来的是改名框。
现在统一成 **点谁看谁**（含自己），改名挪到卡片右上角那支铅笔 `.player-edit`
（88 设计 px ≈ 46 CSS px 的独立热区，不会和卡片点击抢）。

**对局界面**：右上角「我的分」那格（`.gt-me`）以前根本没有 `data-pid`，
点上去什么都不发生，而点旁边任何一个对手都能弹卡 —— 同一屏两套手感。
现在给它加上 `data-pid`，和对手座位卡共用同一个选择器：

```js
var PROF_TAP_SEL = '.gt-opp, .gt-me';
```

拖拽判定（移动 > 8px 不算点击）也一起复用，不用为它再写一套。

## 43.6 验证

| 项 | 结果 |
|---|---|
| `npm test` | 83 文件 / **3008 项 / 0 失败**（v80：3004） |
| `npm run journey` | 114 / 0 |
| `probe-viewport-fit` | **27 / 0**，5 档（新增第 5 档：iOS 26「只有 100vh 是真的」） |
| `probe-first-paint` | 12 / 0（首帧预缩放没被带歪） |
| `probe-modals-landscape` | 39 / 0（横屏弹窗没被高度改动挤坏） |
| `probe-safearea` | 28 / 3，**3 条失败在 HEAD 上同样失败**（首页横屏 `#install-go` 9.9px，见 BACKLOG N4） |

探针这一轮的改动不只是加一档，而是**换了判据**：

- 基准从 `innerHeight` 改成机型高 `h` —— iOS 26 下 `innerHeight` 本身就是那条假读数；
- 新增「`html`/`body` 必须等于 `--vp-h`」—— 直接钉住 43.3 那张图里的裁切层；
- 新增「屏幕底边往上 4px 处 `elementFromPoint` 命中的必须落在 `#stage` 内」——
  这是像素级的判据，rect 到不了的地方它能到。

`iOS26-PWA全部读数矮一栏` 这一档把 `#viewport` 的 rect、`innerHeight`、`visualViewport.height`、
`screen.height` **一起**打成 796（只有 `100vh` 还是 852），复现的正是前两章救不回来的局面：

```
innerH 796  vp.clientH 852  stage 0→852  --vp-h 852px
body 852  html 852  底部命中 stage
```

另外用真服务端跑了一遍全流程（注册 → 建房 → 补 AI → 准备 → 开局），同一套 iOS 26 注入下：

| 项 | 实测 |
|---|---|
| 首页 / 房间 / 牌桌舞台底边 | 852 / 852 / 852（屏 852） |
| 房间底排按钮到屏底 | 62 CSS px（设计 120 设计px，含 home indicator 区） |
| 点自己的座位卡 | 弹**战绩卡**（标题是自己），改名框没动 |
| 点铅笔 | 弹改名框 |
| 点对局页右上角自己 | 弹**自己的战绩卡** |

## 43.7 没做的事 / 风险

1. **真机仍未复验，而且这次必须先发布。** 33.1 那条规程就是这一轮又踩到的：
   本地探针能证明「逻辑按预期走」，证明不了「线上已经是新逻辑」。
2. **如果 WebKit 那条带子真的一个像素都画不进去**（issue 里的 Flutter 作者是这么说的），
   这轮的收益会退化成「内容整体下移到离屏底更近的位置」——
   因为舞台比布局视口高 56px，设计底部那 120 设计px 的留白正好吃掉它，**不会有内容被裁**。
   那种情况下色带还在，但按钮会贴到带子边上，比现在好看一截；
   真要彻底消掉，只能改 `html` 的底色去伪装（等于承认那块地不属于页面）——没做，
   因为一旦真的是「画得进去、只是被 body 裁了」，伪装反而会把已经修好的结果盖住。
3. **`?diag=1` 加了新读数**：`100vh`、`--vp-h`、`html`、`body` 四个高度。
   真机再报这个问题，一张截图就能分清是「来源错」还是「被裁」——
   这两种的修法完全不同，前两章就输在分不清。
4. **`#viewport` 上那条死 `padding-bottom: env(safe-area-inset-bottom)`** 仍然留着
   （32.9 第 3 条的老账），这轮依旧没动。
