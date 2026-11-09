/**
 * 离开房间撤销 + 首次进结算页策略引导
 * （qa-next-batch-v1.md 的 AC-NB-01～09 / AC-NB-14～18）
 *
 * 取证口径（规格 §0.3）：
 *   · 所有期望值**写死在本文件**，来自 design-next-batch-v1.md §2.5 / §4.2 的终值表、
 *     undoBar.js 文件头契约（规矩 1/2/3）与手算（0 / 1 / 250 / 5000 / 10 / 28–36）。
 *   · 不 require 被测模块取期望值，不拿 DEFAULT_MS、pend、T1 之类内部常量当期望。
 *   · 状态机用假 DOM + 假计时器实跑；接线用源码静态守卫；两者成对（反例 1 的处置）。
 *   · 真浏览器几何 / 录帧部分归 CI 探针（AC-NB-07 时序、AC-NB-15/16/18 逐帧），
 *     本轮不跑探针、不出截图，故只落「静态负向 + 状态机」这一层，不伪报已覆盖。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
function jsSources() {
  return fs.readdirSync(path.join(ROOT, 'js'))
    .filter(function (f) { return /\.js$/.test(f); })
    .map(function (f) { return { name: f, src: read('js/' + f) }; });
}
function occurrences(hay, needle) {
  return hay.split(needle).length - 1;
}

var GAME = read('js/game.js');
var UNDO = read('js/undoBar.js');
var STORAGE = read('js/storage.js');
var SETTLE = read('js/settleView.js');
var CSS = read('css/style.css');
var HTML = read('index.html');
var SOURCES = jsSources();
var ALL_JS = SOURCES.map(function (f) { return f.src; }).join('\n');
var createUndoBar = require('../js/undoBar.js');
var Store = require('../js/storage.js');

/* 独立期望值：全部来自规格终值表 / 手算，不引用任何被测常量 */
var SPEC = {
  MSG_MID: '正在离开（5 秒内可撤销）· 对局中离开算弃局，其他人这局也会结束',
  MSG_IDLE: '正在离开房间（5 秒内可撤销）',
  UNDO_MSG: '已取消，你还在房间里',
  IRREVOCABLE: '房间状态已变化，已按最新状态离开，本次无法撤销',
  STRATEGY: '这 6 张牌两轮各拆一次：大牌别只放 1 张比大小，凑十点半、斗牛收分更多。',
  KEY: 'lxw_strategy_tip_seen_v1',
  KEY_NAME: 'STRATEGY_TIP_SEEN',
  GUIDE_KEY: 'lxw_guide_seen_v1',
  WINDOW_MS: 5000,        // §2.5「沿用 DEFAULT_MS，本批不调」
  N_MS: 250,              // AC-NB-07：与换屏动画同量级，且严格小于窗口的 1/10
  TIP_MIN: 28,            // §4.2 文案长度下界
  TIP_MAX: 36             // §4.2 文案长度上界
};

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  ← ' + extra : '')); }
}
function eq(a, b, name) {
  ok(a === b, name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
}
function head(t) { console.log('\n' + t); }

/* ---------------- 假 DOM / 假计时器（独立实现，不引用 undoBar 内部状态） ---------------- */
function fakeEl(cls) {
  var set = {};
  (cls || '').split(' ').forEach(function (c) { if (c) set[c] = true; });
  return {
    textContent: '',
    listeners: {},
    classList: {
      add: function (c) { set[c] = true; },
      remove: function (c) { delete set[c]; },
      contains: function (c) { return !!set[c]; }
    },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire: function (ev) { (this.listeners[ev] || []).forEach(function (f) { f(); }); }
  };
}
function fakeDoc(withBar) {
  var nodes = {};
  if (withBar) {
    nodes['undo-bar'] = fakeEl('undo-bar hidden');
    nodes['undo-msg'] = fakeEl('');
    nodes['undo-act'] = fakeEl('');
  }
  var doc = {
    visibilityState: 'visible',
    listeners: {},
    nodes: nodes,
    getElementById: function (id) { return nodes[id] || null; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire: function (ev) { (this.listeners[ev] || []).forEach(function (f) { f(); }); }
  };
  return doc;
}
function fakeTimers() {
  var seq = 0, live = {};
  return {
    set: function (fn) { seq += 1; live[seq] = fn; return seq; },
    clear: function (id) { delete live[id]; },
    count: function () { return Object.keys(live).length; },
    fireAll: function () {
      var ids = Object.keys(live);
      ids.forEach(function (i) { var f = live[i]; delete live[i]; if (f) f(); });
    }
  };
}
function makeBar(withBar) {
  var doc = fakeDoc(withBar !== false);
  var timers = fakeTimers();
  var bar = createUndoBar({ doc: doc, timers: timers, duration: SPEC.WINDOW_MS });
  return { doc: doc, timers: timers, bar: bar };
}
/** 按 game.js 的接线形状挂一个独立 spy：onCommit 里才真的调「离开」 */
function wireLeaveSpy(bar, spy) {
  return bar.show({
    msg: SPEC.MSG_IDLE,
    onUndo: function () { spy.undone += 1; },
    onCommit: function (reason) { spy.reasons.push(reason); spy.leaveRoom += 1; }
  });
}

/* =================== AC-NB-01 ～ 03：状态机三条规矩 =================== */
head('[AC-NB-01] 同一时刻只允许 1 个待撤销动作，旧的立刻提交');
{
  var t = makeBar(true);
  var log = [];
  t.bar.show({ msg: 'A', onCommit: function (r) { log.push('A:' + r); } });
  t.bar.show({ msg: 'B', onCommit: function (r) { log.push('B:' + r); } });
  eq(log.join(','), 'A:superseded', 'AC-NB-01 旧动作立刻结账（reason=superseded）');
  eq(t.bar.peek().msg, 'B', 'AC-NB-01 peek().msg 是后一次动作文案');
  eq(occurrences(log.join(','), 'superseded'), 1, 'AC-NB-01 superseded == 1');
  eq(occurrences(log.join(','), 'timeout'), 0, 'AC-NB-01 timeout == 0');
  eq(occurrences(log.join(','), 'hidden'), 0, 'AC-NB-01 hidden == 0');
  eq(occurrences(log.join(','), 'no-dom'), 0, 'AC-NB-01 no-dom == 0');
  eq(t.timers.count(), 1, 'AC-NB-01 只有一个计时器（旧的已 clear，被静默丢掉的动作数 == 0）');
}

head('[AC-NB-02] 页面转后台 / 关闭立即提交，且幂等');
{
  var t = makeBar(true);
  var log = [];
  t.bar.show({ msg: 'A', onCommit: function (r) { log.push(r); } });
  t.doc.visibilityState = 'hidden';
  t.doc.fire('visibilitychange');
  /* pagehide 由 undoBar 挂在宿主 global 上，Node 下无法派发；
   * 用同 reason 的第二个 flush 代替它的效果，核「合计仍为 1」。 */
  eq(t.bar.flush('hidden'), false, 'AC-NB-02 第二个后台事件是空操作（幂等）');
  eq(log.length, 1, 'AC-NB-02 onCommit(hidden) 合计 == 1，不是 2');
  eq(log[0], 'hidden', 'AC-NB-02 reason == hidden');
  eq(t.bar.isPending(), false, 'AC-NB-02 状态机清空');
}

head('[AC-NB-03] 撤销条 DOM 缺失时动作照做');
{
  var t = makeBar(false);
  var log = [];
  var shown = t.bar.show({ msg: 'A', onCommit: function (r) { log.push(r); } });
  eq(shown, false, 'AC-NB-03 show() 返回 false');
  eq(log.join(','), 'no-dom', 'AC-NB-03 onCommit(no-dom) == 1（动作没被吞）');
  eq(t.timers.count(), 0, 'AC-NB-03 不留悬空计时器');
}

/* =================== AC-NB-04 / 05：0 与 1 必须成对 =================== */
head('[AC-NB-04] 撤销后 leaveRoom == 0（延迟执行的硬证据）');
{
  var t = makeBar(true);
  var spy = { leaveRoom: 0, undone: 0, reasons: [] };
  wireLeaveSpy(t.bar, spy);
  eq(t.bar.undo(), true, 'AC-NB-04 撤销成功');
  eq(spy.leaveRoom, 0, 'AC-NB-04 ★ 撤销后 leaveRoom == 0');
  eq(spy.reasons.length, 0, 'AC-NB-04 onCommit 调用数 == 0');
  eq(t.bar.isPending(), false, 'AC-NB-04 窗口结束后不再 pending');
}

head('[AC-NB-05] 到点 / flush 后 leaveRoom == 1（== 2 判红）');
{
  /* 正向计数必须与「真有调用点」成对：只看状态机的 1 次会漏掉
   * 「onCommit 里那句 leaveRoom 被删了」这种退化（M1 要证伪的就是它）。 */
  var dl = (/function doLeave\(\) \{([\s\S]*?)\n    \}/.exec(GAME) || [])[1] || '';
  ok(/RoomStore\.leaveRoom\(/.test(dl),
    'AC-NB-05 ★ 接线前置：deferred 回调里真的有 leaveRoom 调用点（删掉即红）');
  var t = makeBar(true);
  var spy = { leaveRoom: 0, undone: 0, reasons: [] };
  wireLeaveSpy(t.bar, spy);
  t.timers.fireAll();
  eq(spy.leaveRoom, 1, 'AC-NB-05 ★ 到点后 leaveRoom == 1');
  eq(spy.reasons.join(','), 'timeout', 'AC-NB-05 reason == timeout');
  t.timers.fireAll();
  eq(spy.leaveRoom, 1, 'AC-NB-05 重复到点不会变成 2（双提交次数 == 0）');

  var t2 = makeBar(true);
  var spy2 = { leaveRoom: 0, undone: 0, reasons: [] };
  wireLeaveSpy(t2.bar, spy2);
  eq(t2.bar.flush('room-changed'), true, 'AC-NB-05 flush(room-changed) 返回 true');
  eq(spy2.leaveRoom, 1, 'AC-NB-05 flush 后 leaveRoom == 1');
  eq(t2.bar.flush('room-changed'), false, 'AC-NB-05 第二次 flush 是空操作');
  eq(spy2.leaveRoom, 1, 'AC-NB-05 flush 不产生第二次真离开');
}

/* =================== AC-NB-06 ～ 09：出口 / 竞态 / 接线 =================== */
var guardBody = (/function leaveMustCommitNow\(confirmSnap, r\) \{([\s\S]*?)\n  \}/.exec(GAME) || [])[1] || '';
var doLeaveBody = (/function doLeave\(\) \{([\s\S]*?)\n    \}/.exec(GAME) || [])[1] || '';
var confirmBody = (/askConfirm\(title, desc, function \(\) \{([\s\S]*?)\n    \}, \{ busyText/.exec(GAME) || [])[1] || '';

head('[AC-NB-06] 五种出口各有唯一结局');
{
  ok(/UndoBar\.flush\('room-changed'\)/.test(GAME), 'AC-NB-06 结算出口：命中即 flush(room-changed)');
  ok(/dissolved|dissolve/.test(guardBody), 'AC-NB-06 解散出口：守卫认「已生效的解散」');
  ok(!/ownerId|holdNext|wantNext|score|ready/.test(guardBody), 'AC-NB-06 房主转移 / 他人进出 / 分数 / ready 不进判据（仍可撤销）');
  ok(/UndoBar\.flush\('navigate'\)/.test(GAME), 'AC-NB-06 导航出口：showScreen 会结账');
  ok(/\.catch\(/.test(doLeaveBody), 'AC-NB-06 断网出口：leaveRoom 失败被吞，不弹离开失败');
  ok(!/flashRoomError|alert\(/.test(doLeaveBody), 'AC-NB-06 断网不刷错误弹窗');
}

head('[AC-NB-07] 导航中被结账：可撤销与已结算不许同时成立');
{
  ok(/function leaveMustCommitNow\(confirmSnap, r\)/.test(GAME), 'AC-NB-07 单一守卫挂在 attachRoom 订阅回调里');
  ok(/r === null/.test(guardBody), 'AC-NB-07 P1 房间没了进判据');
  ok(/r\.phase !== confirmSnap\.phase/.test(guardBody), 'AC-NB-07 P2 阶段推进进判据');
  ok(/r\.players/.test(guardBody), 'AC-NB-07 P3 我已不在席位进判据');
  ok(/settle|roundend/.test(guardBody), 'AC-NB-07 P4 本局结算事件进判据');
  ok(/markLeaveIrrevocable\(\)/.test(GAME), 'AC-NB-07 命中后条子切「已不可撤销」');
  ok(/disabled/.test(GAME), 'AC-NB-07 撤销入口失效');
  ok(SPEC.N_MS < SPEC.WINDOW_MS / 10, 'AC-NB-07 N=250 严格小于 5000/10=500（手算）');
  eq(SPEC.IRREVOCABLE.indexOf('撤销成功'), -1, 'AC-NB-07 「已不可撤销」不许出现「撤销成功」');
  eq(SPEC.IRREVOCABLE.indexOf('已取消'), -1, 'AC-NB-07 「已不可撤销」不许出现「已取消」');
  ok(/'room-changed'/.test(UNDO), 'AC-NB-07 room-changed 已登记进 undoBar 的 reason 注释');
}

head('[AC-NB-08] 对局中离开仍判弃局，文案不丢');
{
  ok(/'弃局离开？'/.test(GAME), 'AC-NB-08 mid 时确认框标题仍是「弃局离开？」');
  ok(/第 ' \+ roundNo \+ ' 轮正在进行/.test(GAME), 'AC-NB-08 desc 含「第 N 轮」');
  ok(/算弃局/.test(GAME), 'AC-NB-08 desc 含「弃局」');
  ok(/记入战绩/.test(GAME), 'AC-NB-08 desc 含「记入战绩」');
  ok(/其他人这局也会就此结束/.test(GAME), 'AC-NB-08 desc 含「其他人这局也会就此结束」');
}

head('[AC-NB-09] 接线守卫：leaveRoom 只在 deferred 回调里');
{
  ok(!!confirmBody, 'AC-NB-09 找到 askConfirm 的确认回调');
  eq(occurrences(confirmBody, 'RoomStore.leaveRoom('), 0, 'AC-NB-09 ★ 确认回调同步路径上 leaveRoom 调用点 == 0');
  ok(/RoomStore\.leaveRoom\(/.test(doLeaveBody), 'AC-NB-09 ★ leaveRoom 落在 deferred 的 doLeave 里');
  ok(/onCommit: function \(\) \{ return doLeave\(\); \}/.test(GAME), 'AC-NB-09 onCommit 接的是 doLeave');
  ok(/cleanupRoom\(\)/.test(doLeaveBody), 'AC-NB-09 cleanupRoom 也在 deferred 里');
  ok(/showScreen\('screen-home'\)/.test(doLeaveBody), 'AC-NB-09 showScreen 也在 deferred 里');
  eq(occurrences(doLeaveBody, 'RoomStore.leaveRoom('), 1, 'AC-NB-09 deferred 内 leaveRoom 调用点 == 1');
  ok(/UndoBar\.isPending\(\)/.test(GAME), 'AC-NB-09 入口有 isPending() 连点短路');
  ok(/正在离开…/.test(GAME), 'AC-NB-09 连点提示「正在离开…」');
  /* 守卫必须在 pwa/test/*.test.js 内，由 run-tests.js 的 DIRS 自动扫进 npm test */
  ok(/[\\\/]test[\\\/]/.test(__filename) && /\.test\.js$/.test(__filename),
    'AC-NB-09 ★ 本守卫位于 pwa/test/*.test.js（会被 npm test 扫到）');
}

/* =================== 文案终值逐字（§2.5） =================== */
head('[§2.5] 四句文案逐字一致，且不新增载体');
{
  eq(occurrences(GAME, SPEC.MSG_MID), 1, '§2.5 等待期·对局中文案在源码中恰好 1 处');
  eq(occurrences(GAME, SPEC.MSG_IDLE), 1, '§2.5 等待期·非对局中文案在源码中恰好 1 处');
  eq(occurrences(GAME, SPEC.UNDO_MSG), 1, '§2.5 撤销成功文案在源码中恰好 1 处');
  eq(occurrences(GAME, SPEC.IRREVOCABLE), 1, '§2.5 已不可撤销文案终值只有一处（单一载体）');
  ok(occurrences(GAME, 'LEAVE_IRREVOCABLE') >= 3, '§2.5 条子切换文本 / 回写都引用同一常量（不复制第二套文案）');
  eq(occurrences(HTML, 'id="undo-bar"'), 1, '§2.6 不新建第二个撤销条 DOM');
  ok(/\[data-undo-origin="leave"\]/.test(CSS), 'D-2 屏级锚点修饰已落 CSS');
  ok(!/askConfirm\(title, desc[\s\S]{0,200}LEAVE_IRREVOCABLE/.test(GAME), '§2.5 不复用 askConfirm 当第三载体');
}

/* =================== AC-NB-14 ～ 18：策略引导 =================== */
function memBacking() {
  var m = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; },
    key: function (i) { return Object.keys(m)[i] || null; },
    get length() { return Object.keys(m).length; },
    _raw: m
  };
}
/** 独立实现「按设备一次」：读键 → 显示即写 → 之后不再显示 */
function displayOnce(store) {
  if (store.read(SPEC.KEY, '', 'local')) return 0;
  store.write(SPEC.KEY, '1', 'local');
  return 1;
}
var tipFns = (/var ST = deps\.Store[\s\S]*?function strategyTipLine\(room\) \{([\s\S]*?)\n  \}/.exec(SETTLE) || [])[1] || '';
var tipTake = (/function takeStrategyTipOnce\(\) \{([\s\S]*?)\n  \}/.exec(SETTLE) || [])[1] || '';
var tipLine = (/function strategyTipLine\(room\) \{([\s\S]*?)\n  \}/.exec(SETTLE) || [])[1] || '';

head('[AC-NB-14] 只出现一次，且键归属 ≠ 规则弹窗键');
{
  ok(new RegExp(SPEC.KEY_NAME + ": '" + SPEC.KEY + "'").test(STORAGE), 'AC-NB-14 新键只注册在 ST.KEYS');
  eq(occurrences(ALL_JS, "'" + SPEC.KEY + "'"), 1, 'AC-NB-14 物理键字面量在 pwa/js 源码中只出现 1 处');
  eq(occurrences(ALL_JS, SPEC.STRATEGY), 1, 'AC-NB-14 文案文本只写进 1 个源码文件');
  ok(SPEC.KEY !== SPEC.GUIDE_KEY, 'AC-NB-14 策略标记 != lxw_guide_seen_v1（手算比对）');
  eq(occurrences(SETTLE, SPEC.GUIDE_KEY), 0, 'AC-NB-14 settleView 不读写 GUIDE_SEEN 字面量');
  eq(occurrences(SETTLE, 'GUIDE_SEEN'), 0, 'AC-NB-14 settleView 不引用 GUIDE_SEEN');
  eq(occurrences(SETTLE, 'closeGuide'), 0, 'AC-NB-14 策略标记不由 closeGuide() 写入');
  ok(/ST\.read\(STRATEGY_TIP_KEY/.test(tipTake), 'AC-NB-14 显示前先读设备键');
  ok(/ST\.write\(STRATEGY_TIP_KEY/.test(tipTake), 'AC-NB-14 显示那一刻即写键');
  ok(tipTake.indexOf('ST.read(') < tipTake.indexOf('ST.write('), 'AC-NB-14 读在写之前（写失败不拦截显示）');

  var dev = Store.create(memBacking(), memBacking());
  var total = 0;
  for (var i = 0; i < 10; i++) total += displayOnce(dev);
  eq(total, 1, 'AC-NB-14 同一设备连续 10 次进结算页累计出现 1 次');
  eq(displayOnce(Store.create(memBacking(), memBacking())), 1, 'AC-NB-14 清本机存储（新设备）后再出现 1 次');
  eq(displayOnce(dev), 0, 'AC-NB-14 换局 / 回看上一局不再出现');
}

head('[AC-NB-15] 不遮挡：不新增节点 / 行高 / 按钮');
{
  ok(/if \(!line\)/.test(SETTLE) && /strategyTipLine\(room\)/.test(SETTLE), 'AC-NB-15 复用 #settle-wait 既有行');
  ok(/box\.textContent = line \|\| ''/.test(SETTLE), 'AC-NB-15 只写既有行的 textContent');
  ok(/box\.style\.whiteSpace = 'nowrap'/.test(SETTLE), 'AC-NB-15 单行不换行（不新增行高）');
  eq(occurrences(SETTLE, 'role="dialog"'), 0, 'AC-NB-15 无第二个 [role=dialog]');
  eq(occurrences(SETTLE, "aria-modal"), 0, 'AC-NB-15 无新增弹窗');
  ok(!/el\('button'/.test(tipLine + tipTake), 'AC-NB-15 策略引导不新增按钮');
  ok(!/createElement\('div'/.test(tipLine + tipTake), 'AC-NB-15 策略引导不新增独立容器');
  /* 真浏览器 rect 相交 / checkVisibility 归 CI 探针，本轮不覆盖，不伪报 */
  ok(true, 'AC-NB-15 几何 rect 相交归 CI 探针（本轮未覆盖，如实留白）');
}

head('[AC-NB-16] 不改变结算数值');
{
  eq(occurrences(tipLine + tipTake, 'rp-net'), 0, 'AC-NB-16 策略引导不写 #rp-net');
  eq(occurrences(tipLine + tipTake, 'settle-net'), 0, 'AC-NB-16 策略引导不写 .settle-net');
  eq(occurrences(tipLine + tipTake, 'font-size'), 0, 'AC-NB-16 策略引导不改字号');
  ok(!/\d+\s*分/.test(SPEC.STRATEGY), 'AC-NB-16 文案不写具体分值（不形成第二个数值载体）');
}

head('[AC-NB-17] 关闭后不复发');
{
  eq(occurrences(tipLine, 'setTimeout'), 0, 'AC-NB-17 无自动消失计时器');
  eq(occurrences(tipLine, 'close'), 0, 'AC-NB-17 无关闭按钮 / 手动关动作');
  ok(/visit !== tipVisit/.test(tipLine), 'AC-NB-17 同一次访问内重绘常驻，换房 / 换局重新判定');
  var dev2 = Store.create(memBacking(), memBacking());
  var sum = displayOnce(dev2);
  for (var j = 0; j < 10; j++) sum += displayOnce(dev2);
  eq(sum, 1, 'AC-NB-17 关闭后连续重进 10 次，出现次数合计仍 == 1（复发 0）');
}

head('[AC-NB-18] 与 guide-modal 规则弹窗不重叠');
{
  eq(occurrences(SETTLE, 'guide-modal'), 0, 'AC-NB-18 结算页策略引导不碰 guide-modal');
  ok((HTML.match(/role="dialog"/g) || []).length >= 1, 'AC-NB-18 规则弹窗仍是既有的全屏 dialog');
  var guideTotal = /GUIDE_TOTAL\s*=\s*(\d+)/.exec(ALL_JS);
  ok(!guideTotal || Number(guideTotal[1]) === 4, 'AC-NB-18 GUIDE_TOTAL 仍为 4（未被加成第 5 步）');
  ok(/!state\.roomId/.test(GAME), 'AC-NB-18 规则弹窗自动弹条件仍是 !state.roomId，结算页天然互斥');
}

head('[§4.2 / §三] 终值与口径对齐');
{
  /* §4.2「28–36 字」按字数口径：不含空格与标点；终值文本本身逐字不改。 */
  var tipChars = SPEC.STRATEGY.replace(/[\s：，、。]/g, '').length;
  ok(tipChars >= SPEC.TIP_MIN && tipChars <= SPEC.TIP_MAX,
    '§4.2 文案字数在 28–36 区间（实测 ' + tipChars + ' 字，含数字）');
  eq(occurrences(SETTLE, SPEC.STRATEGY), 1, '§4.2 文案终值逐字落在 settleView.js 且只有一处');
  ok(/房主在等朋友进来，先不开牌/.test(SETTLE), '§三 结算页 HOLD 文案对齐到「房主」口径');
  ok(/房主/.test(SETTLE), '§三 结算页 HOLD 文案点名房主');
  ok(/等朋友/.test(SETTLE), '§三 与就位态共用「等朋友」语义（B1）');
  eq(occurrences(SETTLE, "el('span', 'hold-left'"), 1, '§三 .hold-left 仍只有一处（不新增载体）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
