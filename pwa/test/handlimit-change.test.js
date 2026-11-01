/**
 * C-3「候场期改把数」的守卫（v117）
 * 跑法：node pwa/test/handlimit-change.test.js
 *
 * 把数原来是「建房时定死、房间内不可改」。要改档位只能退房重建，
 * 而房号会换一个 —— 一桌人得重新集合。C-3 开了一个**干净窗口**：
 * 结算期（SETTLED）里由房主改，改的是「下一场打几把」，不碰任何既成事实。
 *
 * 守五条，每条对应一个能出错的地方：
 *   ① 只在结算期能改 —— 打到一半把 10 改成 3，等于用新规则结算已经按旧规则打完的把；
 *   ② 只有房主能改 —— 把数是整桌的规则，需要一个人负责；
 *   ③ 脏值必须**明说拒绝**，不能悄悄收敛成默认档（那会让「我选了 7」变成「按 10 打」）；
 *   ④ 两端接线都在：服务端有协议动作、本地演示模式也有对应实现
 *      （本地漏了不会报错，只会在 ?mode=local 里点不动那颗按钮）；
 *   ⑤ 结算页那块真的会画出来、而且只有房主的按钮能点。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const SM = require('../js/stateMachine.js');
/* settleView 里 StateMachine 是浏览器全局（脚本顺序即依赖图），node 里得手动挂上，
 * 否则 handLimitBlock 一调就 ReferenceError —— 这不是产品 bug，是测试环境缺一块。 */
global.StateMachine = SM;
const CONFIG = require('../js/config.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function room(phase, ownerId, limit) {
  return {
    roomId: 'r-hl', ownerId: ownerId, cap: 5, handLimit: limit || 10,
    phase: phase, round: 2, handCount: 3, results: { round1: null, round2: null },
    history: [], bustedIds: [], groupsDone: 5, anyScoreChange: true,
    players: [
      { id: 'owner', nickname: '房主', isBot: false, left: false, score: 3 },
      { id: 'guest', nickname: '客人', isBot: false, left: false, score: -3 }
    ]
  };
}

/* ================================================================ */
console.log('\n[1] 结算期：房主可以改');
{
  const r = room(SM.PHASE.SETTLED, 'owner', 10);
  const res = SM.setHandLimit(r, 'owner', 15);
  ok(res.ok === true, '房主把 10 改成 15', res.error);
  eq(r.handLimit, 15, '★ 房间上的档位真的变了');
  eq(SM.handLimitOf(r), 15, 'handLimitOf 读到的也是 15');

  /* 5 个档位都能选，一个都不能漏 —— 白名单是前后端同源的那一份 */
  SM.handLimitOptions().forEach(function (n) {
    eq(SM.setHandLimit(r, 'owner', n).ok, true, '档位 ' + n + ' 可选');
    eq(r.handLimit, n, '档位 ' + n + ' 生效');
  });

  /* 幂等：连点两次同一个档位不该报错，也不该改 updatedAt 之外的东西 */
  const again = SM.setHandLimit(r, 'owner', 30);
  ok(again.ok === true, '重复点同一个档位算成功（幂等）');
  eq(r.handLimit, 30, '值没变');
}

/* ================================================================ */
console.log('\n[2] 对局中不许改：窗口只有结算期');
{
  [SM.PHASE.WAITING, SM.PHASE.ROUND1_SPLIT, SM.PHASE.ROUND1_SETTLE,
    SM.PHASE.ROUND2_SPLIT, SM.PHASE.ROUND2_SETTLE].forEach(function (ph) {
    const r = room(ph, 'owner', 10);
    const res = SM.setHandLimit(r, 'owner', 3);
    eq(res.ok, false, ph + ' 阶段拒绝');
    eq(res.code, 'NOT_SETTLED', ph + ' 阶段给出 NOT_SETTLED 码（前端据此换文案）');
    eq(r.handLimit, 10, '★ ' + ph + ' 阶段档位没被改掉');
  });
}

/* ================================================================ */
console.log('\n[3] 只有房主能改');
{
  const r = room(SM.PHASE.SETTLED, 'owner', 10);
  const res = SM.setHandLimit(r, 'guest', 15);
  eq(res.ok, false, '★ 非房主被拒');
  ok(String(res.error).indexOf('房主') >= 0, '理由说的是「只有房主能改把数」', res.error);
  eq(r.handLimit, 10, '★ 档位没变');
  eq(SM.setHandLimit(r, 'nobody', 15).ok, false, '不在房间里的人也被拒');
}

/* ================================================================ */
console.log('\n[4] 脏值必须明说拒绝，不能悄悄变成默认档');
{
  const r = room(SM.PHASE.SETTLED, 'owner', 10);
  /* 这一条是建房与改档位的关键区别：建房时 normalizeHandLimit 会把 7 收敛成 10
   * （不能因为一个下拉框把人挡在门外）；改契约时收敛就等于骗人。 */
  [7, 0, -5, 3.5, NaN, Infinity, 'abc', null, undefined, ''].forEach(function (v) {
    const res = SM.setHandLimit(r, 'owner', v);
    eq(res.ok, false, '脏值 ' + JSON.stringify(v) + ' 被拒');
    eq(r.handLimit, 10, '★ 脏值 ' + JSON.stringify(v) + ' 没有把档位改成默认值');
  });
  /* 表单控件送来的是字符串，这个要收 */
  eq(SM.setHandLimit(r, 'owner', '5').ok, true, "字符串 '5' 照收（下拉框送的就是字符串）");
  eq(r.handLimit, 5, '生效');
  ok(/3 \/ 5 \/ 10 \/ 15 \/ 30/.test(SM.setHandLimit(r, 'owner', 7).error),
    '★ 拒绝时把合法档位列出来（别让玩家猜）');
}

/* ================================================================ */
console.log('\n[5] 两端接线都在');
{
  const store = fs.readFileSync(path.join(__dirname, '..', 'js', 'roomStore.js'), 'utf8');
  ok(/setHandLimit: function \(roomId, playerId, handLimit\) \{\s*\n\s*return MODE === 'local'/.test(store),
    '★ roomStore 对外接口有 setHandLimit（本地 / 联机两条路都走它）');
  ok(/setHandLimit: function \(roomId, handLimit\) \{\s*\n\s*return request\(\{ type: 'setHandLimit', payload: \{ handLimit: handLimit \} \}\)/.test(store),
    '★ 联机侧发了 setHandLimit 协议');
  ok(/setHandLimit: function \(roomId, playerId, handLimit\) \{[\s\S]{0,220}StateMachine\.setHandLimit/.test(store),
    '★ 本地演示模式直接跑状态机（漏了它，?mode=local 里这颗按钮就是死的）');

  const hub = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'hub.js'), 'utf8');
  ok(/case 'setHandLimit': return this\.setHandLimit\(client, payload, reqId\);/.test(hub),
    '★ 服务端有协议动作');
  ok(/setHandLimit\(client, payload, reqId\)[\s\S]{0,320}SM\.setHandLimit/.test(hub),
    '★ 服务端把请求转给了状态机（不在 hub 里另写一套判定）');
  /* 改把数不会让任何人更接近开局，不该顺手触发自动开局 */
  const handler = hub.slice(hub.indexOf('setHandLimit(client, payload, reqId)'),
    hub.indexOf('setHandLimit(client, payload, reqId)') + 420);
  ok(!/_maybeAutoStart/.test(handler), '★ 改把数不触发自动开局');
}

/* ================================================================ */
console.log('\n[6] 结算页那块：会画、房主能点、别人只读');
{
  /* settleView 是 UMD，`el` 从模块自己的 LXW.utils 取（node 里 this 就是 module.exports） */
  function mk(tag, cls, text) {
    const n = {
      tag: tag, cls: cls || '', text: text === undefined ? '' : String(text),
      children: [], attrs: {}, disabled: false,
      classList: { add(c) { this._s.cls += ' ' + c; }, contains() { return false; } },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k]; },
      appendChild(x) { this.children.push(x); return x; }
    };
    n.classList._s = n;
    return n;
  }
  const M = require('../js/settleView.js');
  M.LXW.utils = {
    $: function () { return null; }, el: mk, esc: function (s) { return String(s); },
    netText: function (n) { return String(n); }, netCls: function () { return ''; },
    pad2: function (n) { return String(n); }, fmtTime: function () { return ''; },
    cardText: function () { return ''; }, short: function (s) { return String(s); },
    colorFor: function () { return ''; }
  };

  const ownerView = M.LXW.settleView({ state: { myId: 'owner' } });
  const ownerBlock = ownerView.handLimitBlock(room(SM.PHASE.SETTLED, 'owner', 10));
  const ownerBtns = ownerBlock.children.filter(function (c) { return c.cls === 'shl-opts'; })[0].children;
  eq(ownerBtns.length, SM.handLimitOptions().length, '★ 五个档位都画出来了');
  ok(ownerBtns.every(function (b) { return b.disabled === false; }), '★ 房主看到的是可点的按钮');
  ok(ownerBtns.every(function (b) { return b.attrs['data-hand-limit']; }),
    '★ 每个按钮都带 data-hand-limit（点击靠它认档位）');
  const on = ownerBtns.filter(function (b) { return b.cls.indexOf('is-on') >= 0; });
  eq(on.length, 1, '★ 恰好一个档位是「当前」');
  eq(on[0].attrs['data-hand-limit'], '10', '当前档位就是房间上的那个值');

  const guestView = M.LXW.settleView({ state: { myId: 'guest' } });
  const guestBlock = guestView.handLimitBlock(room(SM.PHASE.SETTLED, 'owner', 10));
  const guestBtns = guestBlock.children.filter(function (c) { return c.cls === 'shl-opts'; })[0].children;
  ok(guestBtns.every(function (b) { return b.disabled === true; }),
    '★ 非房主的按钮全部禁用（看得到、点不动）');
  /* 但「现在打几把」必须看得清 —— 否则他连下一局打多久都不知道 */
  const guestOn = guestBtns.filter(function (b) { return b.cls.indexOf('is-on') >= 0; });
  eq(guestOn.length, 1, '★ 非房主也看得出当前档位');

  /* 结算页什么时候才放这块：人数不够 2 人时不放（下一局根本开不起来） */
  const view = fs.readFileSync(path.join(__dirname, '..', 'js', 'settleView.js'), 'utf8');
  ok(/canStillPlay[\s\S]{0,120}handLimitBlock\(room\)/.test(view),
    '★ 人数不足时那块不画（摆一堆按不动的档位只是噪音）');
}

/* ================================================================ */
console.log('\n[7] 结构不变量');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'stateMachine.js'), 'utf8');
  const a = src.indexOf('function setHandLimit(');
  const b = src.indexOf('function unWantNext(');
  ok(a > 0 && b > a, 'setHandLimit 在（位置正常）');
  const body = src.slice(a, b);
  ok(/room\.phase !== PHASE\.SETTLED/.test(body), '★ 先判结算期');
  ok(/room\.ownerId !== actorId/.test(body), '★ 再判房主');
  ok(!/normalizeHandLimit\(/.test(body),
    '★ 不用 normalizeHandLimit 校验（它会把脏值收敛成默认档，等于悄悄改契约）');
  ok(/handLimitOptions\(\)\.indexOf\(n\) < 0/.test(body), '白名单逐个比');
  eq(CONFIG.DEFAULT_HAND_LIMIT, 10, '默认档仍是 10 把（这条不该被顺手改掉）');
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
