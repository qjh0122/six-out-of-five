/**
 * 四态 + 错误三级的接线守卫（build-states v1）
 *
 * `states.test.js` 证明的是**纯函数与文案表**对不对；这个文件证明的是
 * **它真的接到了界面上**。分开的理由：四态有一整套"拿不到就降级"的兜底
 * （没有 recordsState 模块时退回两态、没有 #records-fail 时静默不显示），
 * 兜底本身是对的，但它同时意味着 —— **接线断了不会报错**。
 * 忘了加 DOM 块、忘了把块放进 setRecordsState、忘了在 HTML 里改 data-rstate，
 * 表现都是"页面看着正常，四态里有几个永远出不来"，而纯函数那套断言依然全绿。
 *
 * 三条最容易假绿的断言，这里都用负向形式钉住：
 *   ① "加载态只换文案"也能让文案断言变绿 → 所以断言**载体**与"零按钮"；
 *   ② "失败文案写进隐藏元素"也能让文本断言变绿 → 所以断言文案写在可见块里；
 *   ③ "两态同屏叠着"不会让任何单条断言变红 → 所以断言显隐只有**一个出口**。
 *
 * 跑法：node pwa/test/states-wiring.test.js（`npm test` 会自动收进来）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HTML = read('index.html');
const CSS = read('css/records.css');
const RECORDS = read('js/recordsView.js');
const GAME = read('js/game.js');
const SW = read('sw.js');
const STATEJS = read('js/recordsState.js');

let pass = 0, fail = 0;
function ok(c, m, extra) {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra !== undefined ? '  ← ' + extra : '')); }
}
function eq(a, b, m) { ok(a === b, m, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }
function head(t) { console.log('\n' + t); }

/** 从源码里取 `function NAME(...) { … }` 的整段（含嵌套花括号） */
function fnBody(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) return null;
  let i = src.indexOf('{', at);
  if (i < 0) return null;
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(start, i);
}

/** 取 `id="x"` 那个元素的整段（按 <div / </div> 配平，含嵌套）。
 *  第一版按第一个 </div> 截断，于是离线块的按钮（在 .rp-state__body 里面）
 *  被算成 0 个 —— 断言写错比实现写错更常见，记在这里。 */
function block(html, id) {
  const at = html.indexOf('id="' + id + '"');
  if (at < 0) return '';
  const open = html.lastIndexOf('<div', at);
  const from = open < 0 ? at : open;
  let i = from;
  let depth = 0;
  for (; i < html.length; i++) {
    if (html.startsWith('<div', i)) { depth += 1; i += 4; continue; }
    if (html.startsWith('</div>', i)) {
      depth -= 1;
      if (depth === 0) return html.slice(from, i + 6);
      i += 5;
    }
  }
  return html.slice(from);
}

/** 抹掉注释（保留等长换行）：注释里提到的词不算"代码里造了节流" */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/[^\n]/g, ' '));
}

/* =================== [1] 五个载体与 data-rstate =================== */
head('[1] 载体齐全、位置正确、唯一真源就位');
{
  ['records-loading', 'records-fail', 'records-offline', 'records-empty', 'records-scroll', 'records-data']
    .forEach((id) => ok(HTML.indexOf('id="' + id + '"') >= 0, '存在 #' + id));
  ok(/id="records-source-retry"/.test(HTML), '★ 存在 #records-source-retry（失败降级时的行内出口）');
  ok(/id="rank-fail"/.test(HTML), '★ 存在 #rank-fail（榜单失败独立于空态）');
  ok(/id="screen-records"[^>]*data-rstate="/.test(HTML), '★★ #screen-records 上有 data-rstate（唯一真源）');

  /* 位置：四态块必须在 #records-empty 之后、#records-foot 之前，作为兄弟块。
   * 位置错了的表现：离线横条跑到页脚下面去，或者被滚动区吃掉。 */
  const iEmpty = HTML.indexOf('id="records-empty"');
  const iLoading = HTML.indexOf('id="records-loading"');
  const iFail = HTML.indexOf('id="records-fail"');
  const iOffline = HTML.indexOf('id="records-offline"');
  const iFoot = HTML.indexOf('id="records-foot"');
  ok(iEmpty > 0 && iLoading > iEmpty && iFail > iLoading && iOffline > iFail && iFoot > iOffline,
    '★★ 三个新块依次夹在 #records-empty 与 #records-foot 之间（' + [iEmpty, iLoading, iFail, iOffline, iFoot].join(' < ') + '）');

  /* 三个新块默认都带 hidden：出厂时屏上是空的，由 setRecordsState 决定露哪一块 */
  ['records-loading', 'records-fail', 'records-offline'].forEach((id) => {
    ok(new RegExp('id="' + id + '"[^>]*class="[^"]*\\bhidden\\b').test(HTML), '★ #' + id + ' 默认隐藏');
  });

  /* ★ M3（fix1）：成就数字的 HTML 初值不许是「数字/总数」。
   * 进屏那一刻还没拿到账号档案，写 0/N 就是拿未知冒充零；
   * 而且那个分母（26）早就和 Ach.TOTAL（35）漂了 —— 数字只许由 JS 在拿到值后写。 */
  const achInit = /id="ach-entry-num"[^>]*>([^<]*)</.exec(HTML);
  ok(!!achInit, '★ 找到 #ach-entry-num 的初值');
  ok(!!achInit && !/^\s*\d+\s*\//.test(achInit[1]),
    '★★★ M3：HTML 初值不是「n/N」（未知不许冒充零）', achInit && achInit[1]);
}

/* =================== [2] 按钮数量就是签名（design §①-b / ⑥-3） =================== */
head('[2] 按钮数量是签名：加载 0 / 失败 2 / 离线 1 / 空 1');
{
  const count = (s) => (s.match(/<button\b/g) || []).length;
  eq(count(block(HTML, 'records-loading')), 0, '★★★ 加载态零按钮（唯一零按钮的态，这是它和空态的分界）');
  eq(count(block(HTML, 'records-fail')), 2, '★★★ 失败态两个按钮（唯一两按钮的态）');
  eq(count(block(HTML, 'records-offline')), 1, '★ 离线态一个按钮');
  eq(count(block(HTML, 'records-empty')), 1, '★ 空态一个按钮（原样保留）');

  /* 所有新按钮必须 type="button"：将来被包进 form 时，缺省 type 会变成 submit */
  const allBtns = (block(HTML, 'records-loading') + block(HTML, 'records-fail') + block(HTML, 'records-offline'))
    .match(/<button[^>]*>/g) || [];
  const noType = allBtns.filter((b) => !/type="button"/.test(b));
  eq(noType.length, 0, '★ 四态里的每个按钮都是 type="button"', noType.join(' '));

  /* 失败态的两个按钮必须能区分主次：主按钮可点后重发，次按钮是"先开一局" */
  ok(/id="btn-records-retry"/.test(HTML) && /id="btn-records-fail-create"/.test(HTML),
    '★ 失败态有主（再读一次）次（先开一局）两个具名按钮');

  /* 无障碍：坏消息必须被读出来（assertive），"在等"和"没网"是 polite */
  const load = block(HTML, 'records-loading');
  const failB = block(HTML, 'records-fail');
  const offB = block(HTML, 'records-offline');
  ok(/role="status"/.test(load) && /aria-live="polite"/.test(load), '★ 加载态 role=status + aria-live=polite');
  ok(/role="status"/.test(failB) && /aria-live="assertive"/.test(failB), '★★ 失败态 aria-live=assertive（它是坏消息）');
  ok(/role="status"/.test(offB) && /aria-live="polite"/.test(offB), '★ 离线态 role=status + polite');
  ok(/aria-hidden="true"/.test(load), '★ 加载环 aria-hidden（读屏念"正在读取战绩…"就够了）');

  /* 文案复用的证明：新块用 .rp-empty-title / .rp-empty-sub，所以**没有新增字号阶梯**。
   * 设计 §⑤-a 要求复用，这里把"复用"变成可机检的：新块里出现的是那两个类。 */
  [load, failB, offB].forEach((b) => ok(/class="rp-empty-title"/.test(b), '★ 新块复用 .rp-empty-title（不新起一套字号）'));
}

/* =================== [3] 脚本顺序 / 离线缓存 / 模块登记 =================== */
head('[3] 新模块必须做的四件事（漏一件 npm test 就红）');
{
  /* 必须找 `<script src=` 那一次：head 里还有 preload，裸 indexOf 会命中预加载那行 */
  const iState = HTML.indexOf('<script src="./js/recordsState.js');
  const iRecords = HTML.indexOf('<script src="./js/recordsView.js');
  const iGame = HTML.indexOf('<script src="./js/game.js');
  ok(iState > 0, 'index.html 引了 recordsState.js');
  ok(iState < iRecords, '★★ recordsState 在 recordsView 之前（后者 create() 时就要取它）');
  ok(iState < iGame, '★★ 也在 game.js 之前');
  ok(/'\/js\/recordsState\.js'/.test(SW), '★★ 进了 sw 预缓存（否则离线第二次打开就没有四态）');
  ok(SW.indexOf("'/js/recordsState.js'") < SW.indexOf("'/js/recordsView.js'"),
    '★ 预缓存顺序也把 recordsState 排在前面');

  /* module-contract 的登记：MODULES 里有文件名、NAMESPACES 里有映射 */
  const MC = read('test/module-contract.test.js');
  ok(/MODULES = \[[^\]]*'recordsState\.js'/.test(MC), '★ module-contract 的 MODULES 里登记了 recordsState.js');
  ok(/RS: 'recordsState'/.test(MC), '★ module-contract 的 NAMESPACES 里有 RS → recordsState');
  ok(/recordsState: host\.LXW\.recordsState/.test(MC), '★ RESOLVED 里给了 recordsState 的实例（否则 [3] 段查不到它）');

  /* 注入：game.js 把模块塞给 recordsView，recordsView 从 deps 取 */
  ok(/recordsState:\s*window\.LXW\.recordsState/.test(GAME), '★ game.js 把 recordsState 注入了 recordsView');
  ok(/var RS = deps\.recordsState/.test(RECORDS), '★ recordsView 从 deps 取（不是到处摸 window.LXW）');
}

/* =================== [4] 唯一的切态执行者 =================== */
head('[4] data-rstate 唯一真源、setRecordsState 唯一切换者');
{
  ok(/function setRecordsState\(name, opt\)/.test(RECORDS), '★★ 存在 setRecordsState(name, opt)');
  const ss = fnBody(RECORDS, 'setRecordsState') || '';
  ok(/scr\.setAttribute\('data-rstate', name\)/.test(ss), '★★ 它写 data-rstate（唯一写入口之一）');

  /* data-rstate 的写入总共只许出现在 setRecordsState 里（门槛那一支 + 主行），
   * 别处再写一次就等于出现了第二个真源。 */
  const writes = (RECORDS.match(/setAttribute\('data-rstate'/g) || []).length;
  const inSetter = (ss.match(/setAttribute\('data-rstate'/g) || []).length;
  eq(writes, inSetter, '★★ data-rstate 的所有写入都在 setRecordsState 内（共 ' + writes + ' 处）');
  ok(writes >= 1 && writes <= 2, '★ 写入点数量合理（门槛一处在压着时的分支，一处在主行）');

  /* ★ 反向断言：renderRecords 里**一个 classList 都不许有**。
   * 这一条直接对着"四处散着的 toggle 收进一处"这条施工要求：
   * 谁再往里加一句 classList.toggle('hidden', …)，两态同屏叠着就会回来。 */
  const rr = fnBody(RECORDS, 'renderRecords') || '';
  ok(rr.length > 500, '取到了 renderRecords 的函数体（' + rr.length + ' 字符，太少说明解析坏了）');
  /* 只数**载体**的 classList：`#rp-ai-note` 那种"人机说明"的显隐不是状态切换
   * （它是内容的一部分），把它也算进来会逼着人为了迁就断言去改实现。 */
  const toggles = rr.match(/\$\('#records-[a-z-]+'\)\.classList/g) || [];
  eq(toggles.length, 0, '★★★★ renderRecords 里对载体的 classList 操作 = 0（显隐只有 setRecordsState 一个出口）', toggles.join(' '));

  /* 加载态不许再搭空态的便车：`#records-empty-title` 的写入必须从这个文件里消失。
   * 这是"只换文案"那条实现的指纹 —— 它一回来，S3 就会红，但那是探针级；
   * 这里先静态拦一次，跑得快、失败信息也准。 */
  ok(RECORDS.indexOf('#records-empty-title') < 0, '★★★ recordsView 不再改写 #records-empty-title（加载态不是"空态换句话"）');
  ok(RECORDS.indexOf('#records-empty-sub') < 0, '★★★ 同上，副文案也不改写');

  /* 载体白名单：五个 id 只能出现在 CARRIERS 里，不许在别处手写第二个名单 */
  ok(/var CARRIERS = \['records-loading', 'records-fail', 'records-empty', 'records-scroll', 'records-offline'\]/.test(RECORDS),
    '★★ 载体白名单是一处常量（五个值，与 QA §1.1 的映射表一致）');
  ok(/#records-offline/.test(RECORDS), '★ 离线态的块被真的用上了');
  ok(/is-strip/.test(RECORDS) && /is-panel/.test(RECORDS), '★★ 离线一个块两种形态（is-strip / is-panel）都接了');

  /* 纯函数模块必须是纯的：不认识 document / 不挂事件。
   * 它一旦开始摸 DOM，"判断"和"落 DOM"就又粘在一起，
   * 于是这条链重新变成"只能在浏览器里验"，单测那 100 多条断言就白写了。 */
  ok(!/document\./.test(STATEJS), '★★ recordsState.js 零 DOM（不认识 document）');
  ok(!/addEventListener/.test(STATEJS), '★ recordsState.js 不挂事件（纯函数 + 文案表）');
}

/* =================== [5] 离线与重试的行为接线 =================== */
head('[5] 离线不发请求 / 重试真的重发 / online 收条');
{
  const open = fnBody(RECORDS, 'openRecords') || '';
  ok(/if \(!isOfflineNow\(\)\) loadCloudRecords\(false\)/.test(open), '★★★ 离线时 openRecords 不发 /me/records（S9）');
  const load = fnBody(RECORDS, 'loadCloudRecords') || '';
  ok(/if \(isOfflineNow\(\)\) return;/.test(load), '★★★ loadCloudRecords 自己也会在离线时直接返回（双保险）');
  const rank = fnBody(RECORDS, 'renderRank') || '';
  ok(/if \(isOfflineNow\(\)\) \{[\s\S]{0,120}showRankFail\(\)/.test(rank), '★★★ 离线时榜单不发 /api/leaderboard（S9）');

  const retry = fnBody(RECORDS, 'retryCloudRecords') || '';
  ok(/loadCloudRecords\(true\)/.test(retry), '★★ 重试走 loadCloudRecords(true)，即真的重发一次（S6）');
  ok((retry.match(/loadCloudRecords\(true\)/g) || []).length >= 1 && !/debounce|防抖/i.test(retry),
    '★ 重试没有防抖（"点了没反应"的另一种写法）');
  ok(/if \(isOfflineNow\(\)\) \{/.test(retry), '★★ 离线点重试只说话不发请求（S9 的边界情形）');

  const net = fnBody(RECORDS, 'onNetChange') || '';
  ok(/loadCloudRecords\(true\)/.test(net), '★★ online 回来后重取数据（不是只把横条收掉）');
  ok(/renderRecords\(\)/.test(net), '★ online/offline 都会立刻重画（500ms 内收条）');
  ok(/onNetChange\(false\)/.test(GAME) && /onNetChange\(true\)/.test(GAME),
    '★★ game.js 的 offline / online 两个事件都通知了战绩页');
  ok(/setNetBanner\(false\)[\s\S]{0,80}onNetChange\(false\)/.test(GAME),
    '★ 横幅与页面态是同一次事件里一起切的（横幅只说事实，页面态说"给你什么"）');

  /* 上报走 ERR[key].report → ErrorReport.capture，不新建节流 */
  ok(/function reportErr\(key, extra\)/.test(RECORDS), '★ 上报收在一个出口 reportErr');
  ok(/ErrorReport\.capture\(/.test(RECORDS), '★ 走 ErrorReport.capture（唯一入口）');
  ok(!/MAX_PER_SESSION|seenKeys|lastReportAt/.test(stripComments(RECORDS)), '★★ 没有自己造节流（errorReport.js 已自带去重与上限）');
  ok(/reportErr\('err\.silent\.purge'\)/.test(RECORDS), '★★ 静默类至少有一处真实接线（清理查询失败）');
}

/* =================== [5b] 页脚：降级出口与离线口径（fix1 M1 / M2 / M3 / M4） =================== */
head('[5b] 页脚那一行与成就数字：离线时不许邀请注定失败的动作');
{
  const src = fnBody(RECORDS, 'renderSourceLine') || '';
  ok(src.length > 200, '取到了 renderSourceLine 的函数体（' + src.length + ' 字符）');

  /* ★★★★ M1：degraded（页脚那个「再读一次」的条件）里必须有离线判定。
   * 少了它，离线时页脚会挂着一个点下去什么都不会发生的按钮 ——
   * loadCloudRecords() 第一行就 return，那不是出路，是邀请。 */
  const deg = (src.match(/var degraded = ([^;]+);/) || [])[1] || '';
  ok(/isOfflineNow\(\)|onlineNow/.test(deg), '★★★★ M1：degraded 的定义里含离线判定（' + deg.trim() + '）');
  ok(/var onlineNow = !isOfflineNow\(\);/.test(src), '★★ onlineNow 是从 isOfflineNow() 取的（和页面其他地方同一判据）');

  /* ★★★★ M2：页脚的三个分支里，离线那一支必须**先**出现。
   * 顺序错了的表现不是报错，是离线时页脚说「账号数据暂时读不到」——
   * 那不是"读不到"，是根本没发，属于结果误报。 */
  const iOffline = src.indexOf("'只在这台设备上，换设备会丢'");
  const iDegradedText = src.indexOf("'账号数据暂时读不到");
  ok(iOffline > 0 && iDegradedText > iOffline,
    '★★★★ M2：「只在这台设备上」那一支写在「读不到」之前（离线优先）', iOffline + ' vs ' + iDegradedText);

  /* ★★★ M3：成就数字不许再用 `|| 0` 把未知吞成零 */
  ok(RECORDS.indexOf('Number(cloudRecords.achCount)) || 0') < 0,
    '★★★ M3：不再有 `… achCount) || 0`（那正是"用未知冒充零"的写法）');
  ok(/RS\.achLabel|achLabel\(/.test(RECORDS), '★★ M3：数字由纯函数 achLabel 决定（可单测，见 states.test.js [8]）');

  /* ★★★★ M4：离线形态的 base 必须用"假如有网会不会在加载"（wouldLoad），
   * 不能用 loading —— 后者在离线时恒为 false，会把「本机 0 局 + 登录中」算成
   * "有网也是空"，于是露出空态那张 0 分插画（替玩家下了"你这号没打过"的结论）。 */
  const app = fnBody(RECORDS, 'applyRecordsState') || '';
  ok(/online: true, cloudErr: cloudRecordsErr, cloudLoading: wouldLoad/.test(app),
    '★★★★ M4：base 的 cloudLoading 传的是 wouldLoad（不是 loading）');
  const rr2 = fnBody(RECORDS, 'renderRecords') || '';
  ok(/var wouldLoad = !useCloud && !cloudRecordsErr && cloudRecordsReady\(\);/.test(rr2),
    '★★ wouldLoad 在 renderRecords 里独立算出来（与 online 无关）');
  ok(/var loading = online && wouldLoad;/.test(rr2), '★★ loading = online && wouldLoad（离线时不算加载）');

  /* ★★★ F1（fix2 / R8）：离线副文案按形态取 —— panel 那一支底下是空的，
   * 沿用 strip 那句就是假话。仍是同一个块、同一张表，只是取值多一档。 */
  const setState = fnBody(RECORDS, 'setRecordsState') || '';
  ok(/ot\.subPanel/.test(setState), '★★★ F1：setRecordsState 里按形态取 subPanel');
  ok(/form === 'panel' && ot\.subPanel/.test(setState), '★★ F1：取 subPanel 的条件是 form === panel（strip 保持原句）');

  /* ★★★★ F2（fix2）：横幅在战绩页**让位**，不是给它让位置（加 padding 会在
   * 800×360 上挤掉内容，S17 会红）。两条成对：战绩页隐藏 + 其余屏照旧。 */
  const snb = fnBody(GAME, 'setNetBanner') || '';
  ok(/recordsScreenVisible\(\)/.test(snb), '★★★★ F2：setNetBanner 里含"战绩页可见"这个让位条件');
  ok(/online !== false \|\| recordsScreenVisible\(\)/.test(snb),
    '★★★ F2：条件是"或"—— 在线隐藏、战绩页也隐藏，其余屏离线时仍然显示');
  const ssc = fnBody(GAME, 'showScreen') || '';
  ok(/setNetBanner\(!isOffline\(\)\)/.test(ssc),
    '★★★★ F2：切屏时重算一次（不在 showScreen 里重算，"让位"会变成"从战绩页出来也不显示"）');
}

/* =================== [6] 榜单失败不许复用空态 =================== */
head('[6] #rank-fail 独立于 #rank-empty（design ⑥-11）');
{
  ok(/id="rank-fail"/.test(HTML) && /id="rank-empty"/.test(HTML), '★ 两个元素都在');
  ok(/id="rank-fail"[^>]*class="[^"]*\brank-tip\b/.test(HTML), '★ #rank-fail 复用 .rank-tip 的排版（不新建 tip 样式）');
  ok(/id="rank-fail"[^>]*class="[^"]*\bis-fail\b/.test(HTML), '★ 带 is-fail 修饰类');
  ok(/id="rank-fail"[^>]*class="[^"]*\bhidden\b/.test(HTML), '★ 默认隐藏');

  const rank = fnBody(RECORDS, 'renderRank') || '';
  /* 负向：失败分支里不许再出现对 #rank-empty 的写入。
   * 写法上先抠掉"成功/空态"那一支，剩下的就是失败支 —— 直接断言那句三元已消失更稳。 */
  ok(rank.indexOf('排行榜加载失败') < 0, '★★★ renderRank 里不再有"排行榜加载失败，请检查网络后重试"（那句含禁用词且没有按钮）');
  ok(/if \(failed\) \{ showRankFail\(\); return; \}/.test(rank), '★★ 失败走 showRankFail()');
  ok(/emptyEl\.textContent = '还没有人上榜，打完一局就会出现在这里'/.test(rank),
    '★★ #rank-empty 的文案恒定（不再兼职"失败"）');
  ok(/err\.net\.rank/.test(RECORDS), '★ 榜单失败有自己的一档（err.net.rank）');
}

/* =================== [7] CSS：只用语令牌、不新增色相 =================== */
head('[7] CSS 段落与约束');
{
  ok(CSS.indexOf('/* ===== 四态（build-states v1）=====') >= 0, '★★ 新增且只新增一个段落（有段落标题）');
  const at = CSS.indexOf('/* ===== 四态（build-states v1）=====');
  const sec = CSS.slice(at, CSS.indexOf('/* ---------- 清除确认弹窗', at));

  ok(/\.rp-state \{/.test(sec), '★ 有 .rp-state 的几何');
  ok(/@keyframes rpSpin/.test(sec), '★ 有加载环的关键帧');
  ok(/\.is-strip/.test(sec) && /\.is-panel/.test(sec), '★ 有 strip / panel 的形态差异');
  /* 空态原样保留：几何从 .rp-empty 抄过来，而不是另写一套 */
  ok(/flex: 1 1 auto/.test(sec) && /justify-content: center/.test(sec), '★★ 复用 .rp-empty 的几何语义（flex + 居中）');

  /* 过渡只准令牌：出现字面量 ms/s 就红 */
  const trans = sec.match(/transition:[^;]+;/g) || [];
  ok(trans.length > 0, '有过渡声明（' + trans.length + ' 条）');
  const badTrans = trans.filter((t) => /\b\d+(\.\d+)?m?s\b/.test(t));
  eq(badTrans.length, 0, '★★ 过渡时长只来自 var(--dur-*)，没有字面量', badTrans.join(' | '));
  const badEase = trans.filter((t) => /cubic-bezier/.test(t));
  eq(badEase.length, 0, '★★ 缓动只来自 var(--ease-*)，没有第二种曲线', badEase.join(' | '));

  /* 阴影只准 token（design §⑤-a） */
  const shadows = sec.match(/box-shadow:[^;]+;/g) || [];
  const badShadow = shadows.filter((s) => !/var\(--(elev|edge)-/.test(s));
  eq(badShadow.length, 0, '★★ 阴影全部来自 --elev-* / --edge-*', badShadow.join(' | '));

  /* 不引入新色相：段落里所有 rgb/rgba 只能是金色那三通道；也不许新 hex */
  const rgbs = sec.match(/rgba?\([^)]+\)/g) || [];
  const badRgb = rgbs.filter((c) => {
    const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c);
    return !m || !(Number(m[1]) === 245 && Number(m[2]) === 193 && Number(m[3]) === 92);
  });
  eq(badRgb.length, 0, '★★ 只有 rgba(245,193,92, α) 一种颜色（金色透明分档，不新增色相）', badRgb.join(' | '));
  eq((sec.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length, 0, '★★ 段落里没有新的 hex 颜色');

  /* 对齐是结构差异：离线块必须左对齐（design ⑥-6）。
   * 改成居中，它就退化成"只换了文案的第二个空态"。 */
  ok(/\.rp-state--offline \{[^}]*text-align: left/.test(sec), '★★★ 离线块 text-align: left（结构差异，不是口味）');
  ok(/\.rp-state \{[^}]*text-align: center/.test(sec), '★ 其余三态居中');

  /* 不用 gap：用了就必须重跑 scripts/gen-flex-gap-fallback.js。
   * 这条断言的作用不是禁止，而是**逼那条命令非跑不可**（不然没人记得）。 */
  eq((sec.match(/\bgap:/g) || []).length, 0, '★ 新段落里没有 gap（否则要跑 node scripts/gen-flex-gap-fallback.js）');
}

/* =================== [8] 门禁：守卫真的在跑（QA S19） =================== */
head('[8] 门禁在链子里（QA S19）');
{
  /* 「npm test 会跑这个文件」的唯一证据：跑批器是扫描 pwa/test 目录的。
   * 这一条比"package.json 里写了"更强 —— 目录扫描不会漏，而手写长链会漏（历史上漏过 7 套）。 */
  const RUNNER = read('../scripts/run-tests.js');
  ok(/'pwa\/test'/.test(RUNNER), '★★ 跑批器扫描 pwa/test（新测试放进目录就自动纳入）');
  ok(/\.test\.js/.test(RUNNER), '★ 只收 *.test.js');

  /* 探针登记：probes.json 里有 probe-states.js 且 run: 'ci' */
  const manifest = JSON.parse(read('../scripts/probes.json'));
  const entry = (manifest.probes || []).filter((p) => p.file === 'probe-states.js')[0];
  ok(!!entry, '★★ probe-states.js 已登记进 scripts/probes.json');
  eq(entry ? entry.run : '', 'ci', '★★ 登记为 ci 档');
  ok(!!entry && String(entry.what || '').trim().length > 0, '★ 写了 what（守什么）');

  /* CI 里真的有一行执行它：probes:check 只校验登记，校验不了 CI 是否真跑 */
  const WF = read('../.github/workflows/test.yml');
  const wfLines = WF.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  ok(wfLines.some((l) => l.indexOf('probe-states.js') >= 0), '★★★ .github/workflows/test.yml 里有一行真的执行 probe-states.js');

  /* 探针文件本身存在，且不是空壳 */
  const probe = read('../scripts/probe-states.js');
  ok(probe.length > 2000, '★ scripts/probe-states.js 有实质内容（' + probe.length + ' 字符）');
  ok(/390/.test(probe) && /800/.test(probe), '★★ 探针自带两档极值视口（390×844 与 800×360）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
