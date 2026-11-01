# 兼容性矩阵与降级说明

> 最后核对：2026-11-01（v106 / `20261031v` / sw `weile-liuxuanwu-v106`）
> 对应代码：`pwa/css/flex-gap-fallback.css`、`pwa/index.html` 的 head 检测、`pwa/sw.js`、
> `pwa/css/style.css`（§2.1 那批现代 CSS 特性的降级）
>
> **v103 新增 §2.1，v104 那节从「只记账」改成了「已补降级」**：四个越过底线的 CSS 特性里，
> `inset` / `aspect-ratio` / `conic-gradient` 三条补了降级，`:has()` 保持原样（本来就有降级分支）。
> 降级本身**仍未在 Chrome 84–86 / iOS 14 真机验证过** —— 所以下面写的是「能玩」，不是「完整支持」。
>
> **v105 没动兼容层**：只改了版式判据与几处热区（见 `docs/device-support.md` §6），
> 新增的 CSS 全部走 `padding/margin`、`flex`、`transform` 这类老特性，没有碰 §2.1 那四条。
> 唯一连带变化是 flex `gap` 兼容层从 99 条涨到 100 条 —— 新增的是
> `html.no-flex-gap .ls #screen-game.rt-ring.is-ready .tr-body > * + *`，
> 来自 §2.4「就位态在矮横屏上的重叠」那处修复（去掉了冗余提示行，`gap` 要改成 `margin` 补）。
>
> **v106 也没动兼容层**（仍是 100 条）：新增的 `.card-box.drop-swap` 只用
> `border-radius` / `box-shadow` / `transform` / `transition`，全是老特性。
> 拖拽本身走的是 `PointerEvent` + `elementFromPoint`，**iOS 13 / Safari 13 起才全支持**。
> 老内核没有 PointerEvent 时 `pointerdown` 根本不触发，表现是**拖不动**（这是拖拽这条通路本身的前提，
> 不是新增的兼容缺口）。放牌不受影响：手牌走的是 `img.addEventListener('click', …)`，
> 收牌走槽位的 click，两条路径与 PointerEvent 无关 —— 交换用不了、放牌照常。

这份文档回答一个问题：**在某个具体浏览器里，这个游戏哪些能力能用、哪些会降级、哪些根本不可用。**

写它的原因不是"抄一份兼容表"，而是这个项目里已经出现过三次同类事情 ——
「功能在现代 Chrome 里好好的，在真机上静默少了一块，而没有任何一处会报错」。
matrix 让下一个改动的人能在动手前就知道边界在哪。

---

## 1. 一句话结论

| 目标环境 | 结论 |
|---|---|
| 安卓 Chrome 87+ / iOS Safari 15+ | **完整支持**，没有任何降级 |
| 安卓 Chrome 84–86 / iOS Safari 14.1–14.x | **能玩**：`inset` / `aspect-ratio` 有降级（§2.1），降级本身未真机验证 |
| 安卓 Chrome 57–83 | 能玩，flex `gap` 由兼容层补（见 §3） |
| iOS Safari 10.3–14.0 | 能玩，flex `gap` 由兼容层补；同时也吃 §2.1 的降级路径 |
| 微信内置浏览器 | 能玩，但**不能装到桌面、没有离线能力**（§4） |
| 国产浏览器（QQ/UC/百度/夸克等） | 取决于内核；Chromium 87+ 完整，更老的走兼容层 + §2.1 的风险 |

**底线是「能玩」而不是「长得一样」**：牌桌是联机实时游戏，只要 WS、发牌、结算三条链正常，
间距差几像素不影响任何人。

---

## 2. 能力矩阵

| 能力 | 安卓 Chrome | iOS Safari | 微信内置 | 说明 |
|---|---|---|---|---|
| 联机对局（WS） | ✅ 40+ | ✅ 8+ | ✅ | `server/ws.js` 是手写的 RFC 6455 子集，只用 text frame + close/ping/pong |
| 添加到桌面 | ✅ | ✅ 需手动「分享 → 添加到主屏幕」 | ❌ | 见 §4 |
| Service Worker / 离线 | ✅ 40+ | ✅ 11.3+ | ❌ | 微信里 `navigator.serviceWorker` 不存在 |
| flex `gap` | ✅ 84+ | ✅ 14.1+ | 看内核 | 更老的走兼容层，见 §3 |
| grid `gap` | ✅ 57+ | ✅ 10.1+ | ✅ | 早于本项目底线，**不做兼容** |
| CSS 自定义属性 | ✅ 49+ | ✅ 9.1+ | ✅ | 全站依赖，没有回退 |
| `env(safe-area-inset-*)` | ✅ 69+ | ✅ 11+ | 部分 | 读不到时按 0 处理，`standalone` 下 iOS 另有 47px 兜底 |
| `100vh` 当「整屏高」用 | ✅ | ✅（**iOS 26 standalone 只有它是对的**） | 看内核 | 见 §5.2：`100%` / `dvh` / `svh` 在 iOS 26 standalone 下会一起报「矮一个状态栏」 |
| `beforeinstallprompt` | ✅ 68+ | ❌ 不存在 | ❌ | iOS 只能走文字引导 |
| Web Share API | ✅ | ✅ 12+ | ✅ 用自家分享 | 分享战绩图 |
| WebP | ✅ | ✅ 14+ | ✅ | 背景图/牌背 |
| `position: sticky` | ✅ | ✅ 13+ | ✅ | 战绩页表头 |
| `aspect-ratio` | ✅ 88+ | ✅ 15+ | 看内核 | ⚠️ 只用于 `.av-cell`（头像面板格子）。**失效不是「不影响布局」**，见 §2.1 |
| CSS `:has()` | ✅ 105+ | ✅ 15.4+ | ❌ | 只用了 1 处（`.ls #rank-body:not(:has(...))`），**带显式降级**，见 §6 |
| `inset` 简写 | ✅ 87+ | ✅ 14.1+ | ⚠️ 看内核 | **14 处**，全部没有 `top/left/right/bottom` 双写。老内核上这些定位层会跑位，见 §2.1 |
| `conic-gradient` | ✅ 69+ | ✅ 12.1+ | 看内核 | 3 处，v98 牌型特写的金环。失效只是没有金环，粒子与大字还在 |

---

## 2.1 四个越过底线的现代 CSS 特性 —— **v104 已补降级（三条），保留一条记账**

§1 那句「安卓 Chrome 84+ / iOS Safari 14.1+ 完整支持」曾是不准确的：这几个特性
从 v89 / v98 起陆续进来，一直没人拿底线量过。v104 逐条处理：

| 特性 | 最早可用版本 | 用处 | v104 处理 | 现在老内核上的表现 |
|---|---|---|---|---|
| `inset`（简写） | Chrome **87** / Safari 14.1 | 13 处定位层（`html`、`#viewport`、`#screen-game::after`、表情层…） | **每处前面补 `top/right/bottom/left`** | 长手写先生效，`inset` 那行被丢弃也不影响；版面不再塌 |
| `aspect-ratio` | Chrome **88** / Safari **15** | 1 处：`.av-cell` 头像格子 | **加 `@supports not (aspect-ratio: 1/1)` 兜底**（`height:0` + `padding-bottom:100%` + 图片绝对定位） | 格子仍是正圆；现代浏览器不匹配该 `@supports`，一行都不生效 |
| `conic-gradient` | Chrome 69 / Safari 12.1 | 3 处牌型特写金环 | **每条前面加一层纯色底** | 降级成「静止的一圈暖光」，而不是什么都没有 |
| `:has()` | Chrome 105 / Safari 15.4 | 1 处：评比榜「不足 5 行时收窄」 | **不改**（已有降级分支） | 退回两列，只是偏宽 —— 有意为之，不算漏洞 |

**为什么 `inset` 优先修**：它是这四条里唯一「丢掉就完全不能用」的 ——
被丢的是 `position:fixed` 的全屏遮罩，`auto` 定位下它塌成一条线，
底下牌桌看得见却点不到。`aspect-ratio` 塌了是难看，`conic-gradient` 塌了是少一层光，
`inset` 塌了是**打不了牌**。优先级按「失灵后果」排，不是按出现次数排。

**仍然存在的风险（诚实记账）**：

- 三条降级**都没有老内核真机验证**（手头没有 Chrome 84–86 / iOS 14 样本）。
  它们保证的是「声明不会被整条丢弃」和「有可读的降级外观」，不保证像素级一致。
- 因此 §1 的分档措辞改成：**Chrome 87+ / iOS 15+ 完整支持；更老的能玩，不保证精确版式**。
- 降级代码本身没有独立的运行时守卫（`probe-flex-gap` 那套「不挂 class 就匹配 0 个元素」
  的证明方式在 `@supports` 上不适用）—— 靠的是「现代浏览器不匹配 `@supports not`」这一条浏览器语义。

**怎么验**：`node scripts/gen-flex-gap-fallback.js --check`（确认兼容层没被新样式带过期）、
`probe-viewport-fit` 四档（确认长手写没有改变现代内核的布局）、
`probe-avatar`（确认 `@supports` 块在现代内核里是惰性的）。

---

## 3. flex `gap` 兼容层

### 3.1 做法

`style.css` / `records.css` / `emoji.css` 里现在共 **92 处** `gap` 声明（v103 时点统计），
其中绝大多数位于 flex 容器；剩下的是 grid、零值、或 `space-*` 布局，见 §3.3。

**数字不要手抄，以生成器输出为准**（它会随样式增删而变）：

```bash
node scripts/gen-flex-gap-fallback.js --check
# → flex-gap-fallback.css 是最新的（100 条规则）
```

现代浏览器一行没动。检测到不支持 flex gap 时，`<html>` 会挂上 `.no-flex-gap`，
再由 `pwa/css/flex-gap-fallback.css` 用 `容器 > * + * { margin-left / margin-top }` 补齐间距。
**现代浏览器永远不会有这个 class**，所以那份 CSS 对它们是完全惰性的。

检测方式（`index.html` 的 head 内联脚本）：

```js
// 造一个 column flex + 两个零高度子元素 + row-gap:2px
// 支持 → 量到高度 2；不支持 → 0
```

不用 UA 判断：国产浏览器的 UA 完全不可信，而且 UA 判断会随内核更新失效。

### 3.2 生成与维护

这份 CSS 是**生成物，不要手改**：

```bash
node scripts/gen-flex-gap-fallback.js          # 重新生成
node scripts/gen-flex-gap-fallback.js --check  # 校验是否过期（测试里会跑）
```

所以以后改了任何 `gap`，都要重跑一次。忘了跑的话，测试会红（`pwa/test/flex-gap-fallback.test.js`），
不会静默漏掉。

### 3.3 刻意不处理的（生成器报告共 19 处，其中可归类的是这 15 处）

| 数量 | 类型 | 为什么不处理 |
|---|---|---|
| 5 | grid 容器 | grid 的 `gap` 从 Chrome 57 / Safari 10.1 就有，早于本项目底线 |
| 9 | `justify-content: space-*` | **语义不等价**。space-between 是「先用 gap 保证最小间距，剩余空间再均分」；换成子元素 margin 后，margin 会先吃掉空间，第二个元素被往里推 G，布局直接错位。这 9 处无法用 margin 等价表达 |
| 1 | `gap: 0` | 没有间距要补 |

剩下 4 处是生成器识别到「补了也不会生效」或「补了会和别的规则打架」的边角，逐条注释写在
`flex-gap-fallback.css` 里，改了样式后跑一次 `--check` 就能看到它们是否还在。

这 9 处在老内核上的实际影响：**元素间距变成 0**，但 `space-between` 本身还会把元素推到两端，
所以观感是"贴边而不是黏在一起"，比彻底没有好。已知可接受。

### 3.4 已知偏差

**`flex-wrap` 的 3 处容器**（`.group-chips` / `.result-head` / `.result-row .rt`）在老内核上，
换行之后每行的**第一个**元素会多出一个 G 的左边距（因为 `> * + *` 不区分行首）。
表现为整行略微右偏。已知，不修 —— 修它需要负 margin 方案，而那两个容器本身有自己的
`margin-bottom`，互相覆盖的风险大于收益。

---

## 4. 微信内置浏览器

| 项 | 情况 |
|---|---|
| 能不能打开 | ✅ 能 |
| 能不能玩 | ✅ 能（WS 正常） |
| 能不能装到桌面 | ❌ 不能，微信不允许 |
| 有没有离线能力 | ❌ 没有 SW |
| 安装引导条 | **不显示**（`isWeChat()` 直接 return） |

为什么安装引导要跳过微信：教用户做一件他在这个环境里做不到的事，比不教更糟。
他会去找「添加到主屏幕」找不到，然后认为应用坏了。

---

## 5. 首屏的两条早期脚本

`<head>` 里有两段同步脚本，都是为「首帧」服务的，改动时要知道它们在抢时间：

| 脚本 | 作用 | 失效后果 |
|---|---|---|
| 预缩放 | 把 750 设计空间按 `vw / 750` 收进屏幕，写到 `<html>` 的 `--pt-scale` | 用户先看到一屏放大到溢出、只剩左上角的内容，等 boot 跑完才"啪"一下缩回去 |
| 登录态判定 | 没有会话就给 `<html>` 挂 `.no-session` | 用户先闪一下首页再跳登录页 |

两条都遵守同一个兜底原则：**读不到就当"正常"处理**。
预缩放读不到视口 → 不设变量，退回原行为（会闪但不坏）；
登录态读不到 localStorage → 不挂 class，当作已登录（最坏是闪一下，而不是白屏）。

`showScreen()` 第一次被调用时会把 `.no-session` 摘掉，之后可见性完全由 `.hidden` 接管。

### 5.1 横屏首帧为什么没修

横屏要切 `.ls` 版式，而 `.ls` 是加在 `#stage` 上的 —— head 脚本执行时那个元素还没被解析出来。
CSS 变量可以设在祖先上，class 不行。所以横屏在 boot 之前仍然是竖版 + 未收窄的状态。
记在 `docs/BACKLOG.md` 的 B-L1。

### 5.2 iOS 26 standalone：只有 `100vh` 是整屏高（`--vp-h`）

「添加到主屏幕」之后，iOS 26 会把布局视口报成「整屏 − 一个状态栏」，
于是在页面底部留一条谁也铺不进去的带子（WebKit bug 313800）。

关键差别是**各个高度单位在那一刻的说法不一致**：

| 读数 / 单位 | iOS 26 standalone 下 |
|---|---|
| `100%`、`dvh`、`svh`、`-webkit-fill-available` | **矮的那个（假值）** |
| `innerHeight`、`visualViewport.height`、`#viewport` 的 rect | **矮的那个（假值）** |
| `100vh`、`100lvh` | **整屏（真值）** |

所以竖版的高度**不能**挂在 `100%` 上，也不能只信 JS 读到的 rect：

- `game.js::resize()` 把「`#viewport` 的 rect / `screen.height` / 当场量的 `100vh`」
  三者取最大（只往上修、只修差 ≤18%），写进 `--vp-h`；
- `html` / `body` / `#viewport` / `#stage` **四层同时**读 `--vp-h` ——
  少一层都不行，因为 `body` 上的 `overflow: hidden` 会在布局视口处把超出的部分裁掉；
- `<head>` 的预缩放脚本在 standalone 下先写 `--vp-h: 100vh`，保证冷启动第一帧就是对的。

浏览器里 `--vp-h` 就等于可视高，所以这一套对「手机浏览器打开」零影响。
回归守卫是 `scripts/probe-viewport-fit.js` 的第 5 档（把 rect / innerHeight / screen.height
一起打成矮值，只留 `100vh` 是真的）。

---

## 6. 刻意没用到的能力

| 能力 | 为什么不用 |
|---|---|
| CSS `:has()` | **只用 1 处**（`.ls #rank-body:not(:has(.rank-row:nth-child(5)))`，评比榜不足 5 行时收窄两列）。这一处是 v88 加的，**代码里写了显式降级**：不支持时退回上面的两列，能看、只是偏宽。此前这一格写的是「刻意没用到」—— 那是过期说法，v103 review 改正 |
| `container queries` | Safari 16 才有，且这个布局是固定 750 设计空间，容器尺寸本来就已知 |
| `dvh` / `svh` | iOS 15.4 才有；而且 iOS 26 standalone 下它们报的正是那个假矮值，见 §5.2 |
| `color-mix()` | Safari 16.2，太新 |
| `@layer` | 会让"特异性"这层调试手段失效，而本项目的样式覆盖关系已经够绕 |
| 原生 `dialog` | 弹窗要做焦点圈定 / Esc 优先级 / 层级栈，自己控制更直接（14 个弹窗共用一套 `MODAL_ORDER`） |

---

## 7. 怎么验证

```bash
node scripts/probe-flex-gap.js 390 844    # 兼容层：惰性 / 补间距 / 覆盖率 / grid 不受影响
node scripts/probe-first-paint.js 390 844 # 首帧：预缩放 + 登录态判定
node scripts/probe-safearea.js            # 安全区
node scripts/probe-viewport-fit.js        # 视口适配（5 档，含 iOS 26 standalone 假读数）
node scripts/gen-flex-gap-fallback.js --check   # 兼容层是否过期
npm test                                  # 106 文件 / 4374 项
```

`probe-flex-gap` 里最关键的一条断言是 **「不挂 class 时兼容层匹配 0 个元素」** ——
那是「现代浏览器零回归」的唯一直接证据，比读代码可靠。

**§2.1 那四个特性目前没有任何断言守着**，只能 grep 复查：

```bash
grep -rn "inset:\|aspect-ratio\|:has(\|conic-gradient" pwa/css/*.css
```

跑完对着 §2.1 的表数一遍数量。数量变了就说明有人加了新的越线用法 ——
要么补降级，要么来改这张表，**不要让它悄悄长大**。
