/**
 * 「5 秒内可以反悔」条（node pwa/test/undo-bar.test.js）
 *
 * 这个模块只有三四百行，但它的**每一条规矩都对应一次真实事故的形状**，
 * 而且都是"看不出来"的那种：
 *
 *   1) 新的待办顶掉旧的，旧的必须立刻结账 —— 否则用户点了清除，什么也没发生，
 *      而界面上没有任何东西告诉他这一点。
 *   2) 页面转后台必须立即提交 —— 否则他以为删了、关掉 App，回来发现还在；
 *      或者更糟：以为删了，其实一直没删（数据的两种方向都能骗到人）。
 *   3) 条子渲染不出来时动作也要照做 —— 旧缓存里的 HTML 没有 #undo-bar，
 *      此时如果 show() 直接 return，清除就永远不执行，且没有任何报错。
 *
 * 所以这里不用真 DOM 也不用真定时器：假 doc + 假计时器，把这三条逐一打出来。
 * 注意**不要**用"等 5 秒"来验超时 —— 那种测试要么慢到没人跑，要么被 skip。
 */
'use strict';

var createUndoBar = require('../js/undoBar.js');

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  ← ' + extra : '')); }
}
function eq(a, b, name) {
  ok(a === b, name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
}
function head(t) { console.log('\n' + t); }

/* ---------------- 假 DOM：只实现这个模块真的用到的那几个 API ---------------- */
function el(id, cls) {
  var set = {};
  (cls || '').split(' ').forEach(function (c) { if (c) set[c] = true; });
  return {
    id: id,
    textContent: '',
    listeners: {},
    classList: {
      add: function (c) { set[c] = true; },
      remove: function (c) { delete set[c]; },
      contains: function (c) { return !!set[c]; }
    },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire: function (ev, arg) { (this.listeners[ev] || []).forEach(function (f) { f(arg); }); }
  };
}

/** nodes = null 表示"旧缓存里根本没有这条 DOM" */
function fakeDoc(withBar) {
  var nodes = {};
  if (withBar) {
    nodes['undo-bar'] = el('undo-bar', 'undo-bar hidden');
    nodes['undo-msg'] = el('undo-msg');
    nodes['undo-act'] = el('undo-act');
  }
  var doc = {
    visibilityState: 'visible',
    listeners: {},
    getElementById: function (id) { return nodes[id] || null; },
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire: function (ev) { (this.listeners[ev] || []).forEach(function (f) { f(); }); }
  };
  doc.nodes = nodes;
  return doc;
}

/* 假计时器：不真的等，由测试手动 fire */
function fakeTimers() {
  var seq = 0, live = {};
  return {
    set: function (fn) { seq += 1; live[seq] = fn; return seq; },
    clear: function (id) { delete live[id]; },
    count: function () { return Object.keys(live).length; },
    lastId: function () { return seq; },
    fire: function (id) { var f = live[id]; delete live[id]; if (f) f(); },
    fireAll: function () { var ids = Object.keys(live); ids.forEach(function (i) { var f = live[i]; delete live[i]; if (f) f(); }); }
  };
}

function make() {
  var doc = fakeDoc(true);
  var timers = fakeTimers();
  var calls = [];
  var bar = createUndoBar({
    doc: doc,
    timers: timers,
    duration: 5000,
    /* 不让它去挂全局 pagehide（node 里没有 window） */
    // global 由模块自己取，这里只保证不炸
  });
  return { doc: doc, timers: timers, bar: bar, calls: calls };
}

/* =================== [1] 基本生命周期 =================== */
head('[1] 显示 → 到点执行 / 撤销 → 不执行');
{
  var t = make();
  var committed = 0, undone = 0;
  var r = t.bar.show({
    msg: '将清除 12 场记录（含云端）',
    seconds: 5,
    onUndo: function () { undone++; },
    onCommit: function (reason) { committed++; t.lastReason = reason; }
  });
  eq(r, true, 'show 返回 true（条子渲染出来了）');
  eq(t.bar.isPending(), true, '★ 进入待撤销状态');
  eq(t.doc.nodes['undo-bar'].classList.contains('hidden'), false, '★ 条子可见（hidden 已摘）');
  eq(t.doc.nodes['undo-msg'].textContent, '将清除 12 场记录（含云端）', '文案原样写进条子');
  eq(t.doc.nodes['undo-act'].textContent, '撤销', '按钮默认文案是「撤销」');
  eq(t.timers.count(), 1, '★ 只起了一个计时器（不是每个动作一个）');

  t.timers.fireAll();
  eq(committed, 1, '到点后执行一次');
  eq(t.lastReason, 'timeout', 'reason 是 timeout（日志能区分到点与被打断）');
  eq(t.doc.nodes['undo-bar'].classList.contains('hidden'), true, '★ 执行后条子收起');
  eq(t.bar.isPending(), false, '状态机清空');
}

{
  var t = make();
  var committed = 0, undone = 0;
  t.bar.show({ msg: 'x', onUndo: function () { undone++; }, onCommit: function () { committed++; } });
  eq(t.bar.undo(), true, 'undo 返回 true');
  eq(undone, 1, '★ 撤销回调被调用');
  eq(committed, 0, '★★ 撤销之后绝不执行（这是整个功能的唯一意义）');
  eq(t.timers.count(), 0, '★ 计时器被清掉了（否则 5 秒后还是会在背后删）');
  eq(t.doc.nodes['undo-bar'].classList.contains('hidden'), true, '条子收起');
  eq(t.bar.undo(), false, '★ 连点第二下是空操作（不报错、不重复触发）');
  eq(undone, 1, '撤销回调仍然只调用了一次');
  eq(t.bar.isPending(), false, '空操作之后仍然是未待办状态');
}

/* =================== [2] 规矩 1：新的顶掉旧的，旧的立刻结账 =================== */
head('[2] 一次只允许一个待撤销动作');
{
  var t = make();
  var log = [];
  t.bar.show({ msg: 'A', onCommit: function (r) { log.push('A:' + r); } });
  t.bar.show({ msg: 'B', onCommit: function (r) { log.push('B:' + r); } });
  eq(log.join(','), 'A:superseded', '★★ 旧的被立刻结账（reason=superseded），不是悄悄丢掉');
  eq(t.doc.nodes['undo-msg'].textContent, 'B', '条子显示的是新的那条');
  eq(t.bar.isPending(), true, '新的仍在待撤销');
  eq(t.timers.count(), 1, '★ 计时器没有被泄成两个（旧的已被 clear）');
  t.timers.fireAll();
  eq(log.join(','), 'A:superseded,B:timeout', '新的到点后结账');
}

/* =================== [2b] 撤销之后的旧计时器不能误伤下一件事 =================== */
head('[2b] 撤销后旧计时器不能把下一件事提前结账');
{
  /* 这条是 v136 实现时的真 bug：undo() 先把 pend 置空、再调 clearTimer()，
   * 而 clearTimer 里读的是 pend —— 读到 null，计时器**从来没被清掉**。
   * 表面上撤销是"成功"的（commit 拿不到 pend，直接 return false），
   * 但那个野计时器还在跑；等它到点，commit() 拿到的会是**下一件事**的 pend，
   * 于是 B 在自己的 5 秒远没走完时就被执行了 ——
   * 用户看到的是"我撤销了 A，结果 B 突然生效了"。 */
  var t = make();
  var log = [];
  t.bar.show({ msg: 'A', onCommit: function (r) { log.push('A:' + r); } });
  var oldId = t.timers.lastId();
  t.bar.undo();
  t.bar.show({ msg: 'B', onCommit: function (r) { log.push('B:' + r); } });
  eq(t.timers.count(), 1, '★ 只剩 B 的一个计时器（A 的已被清掉）');
  t.timers.fire(oldId);                  // 旧计时器到点 —— 如果没清掉，这里就会误伤
  eq(log.join(','), '', '★★ 旧计时器到点不会碰新待办（B 仍然是待撤销）');
  eq(t.bar.isPending(), true, 'B 仍在待撤销状态');
  t.timers.fireAll();
  eq(log.join(','), 'B:timeout', 'B 只在自己的计时器到点时结账');
}

/* =================== [3] 规矩 2：转后台立刻提交 =================== */
head('[3] 页面转入后台 / 关闭');
{
  var t = make();
  var log = [];
  t.bar.show({ msg: 'A', onCommit: function (r) { log.push(r); } });
  t.doc.visibilityState = 'hidden';
  t.doc.fire('visibilitychange');
  eq(log.join(','), 'hidden', '★★ 转后台立刻提交（不能等到"下次打开"才删）');
  eq(t.bar.isPending(), false, '状态机清空');

  /* 重新可见不该再触发一次 */
  t.doc.visibilityState = 'visible';
  t.doc.fire('visibilitychange');
  eq(log.length, 1, '★ 回到前台不会再提交一次（幂等）');
}
{
  var t = make();
  var log = [];
  t.bar.show({ msg: 'A', onCommit: function (r) { log.push(r); } });
  eq(t.bar.flush('navigate'), true, 'flush 返回 true');
  eq(log.join(','), 'navigate', '★ 离开这一屏也会结账');
  eq(t.bar.flush('navigate'), false, '没有待办时 flush 是空操作');
}

/* =================== [4] 规矩 3：渲染不出来也要照做 =================== */
head('[4] DOM 缺失（旧缓存）');
{
  var doc = fakeDoc(false);          // 没有 #undo-bar
  var timers = fakeTimers();
  var log = [];
  var bar = createUndoBar({ doc: doc, timers: timers });
  var r = bar.show({ msg: 'A', onCommit: function (reason) { log.push(reason); } });
  eq(r, false, 'show 返回 false（如实报告没渲染出来）');
  eq(log.join(','), 'no-dom', '★★ 但动作照做了（否则清除会永远不执行，且零报错）');
  eq(timers.count(), 0, '没有留下悬空计时器');
}

/* =================== [5] 回调抛异常不能把状态机卡住 =================== */
head('[5] 回调抛异常');
{
  var t = make();
  t.bar.show({
    msg: 'A',
    onCommit: function () { throw new Error('boom'); }
  });
  var threw = false;
  try { t.timers.fireAll(); } catch (e) { threw = true; }
  eq(threw, false, '★ 提交回调抛异常不会把异常甩给计时器');
  eq(t.bar.isPending(), false, '★★ 状态机已经清空（不会出现"条子还在但永远不会执行"）');
  eq(t.doc.nodes['undo-bar'].classList.contains('hidden'), true, '条子已经收起');
}
{
  var t = make();
  t.bar.show({ msg: 'A', onUndo: function () { throw new Error('boom'); } });
  var threw = false;
  try { t.bar.undo(); } catch (e) { threw = true; }
  eq(threw, false, '★ 撤销回调抛异常也不会把异常甩出来');
  eq(t.bar.isPending(), false, '状态机干净');
}

/* =================== [6] 秒数可配 =================== */
head('[6] 时长');
{
  var doc = fakeDoc(true);
  var timers = fakeTimers();
  var seen = [];
  var bar = createUndoBar({ doc: doc, timers: timers, duration: 8000 });
  var origSet = timers.set;
  timers.set = function (fn, ms) { seen.push(ms); return origSet(fn, ms); };
  bar.show({ msg: 'A', onCommit: function () {} });
  eq(seen[0], 8000, '不传 seconds 时用初始化里的 duration');
  bar.show({ msg: 'B', seconds: 2, onCommit: function () {} });
  eq(seen[1], 2000, '★ 单次可以覆盖（2 秒）');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
