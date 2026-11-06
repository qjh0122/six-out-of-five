/**
 * 「等个人」剩余时间：读绝对到期时刻，并扣掉设备时钟偏差（v125）
 * 跑法：node pwa/test/hold-left-text.test.js
 *
 * 【为什么必须扣偏差】
 * 服务端下发的是 `holdNextEndsAt`（服务端时间轴上的绝对时刻）。
 * 如果客户端直接 `ends - Date.now()`，那么设备时间被手动改过、
 * 或者时区/自动对时出了岔子的人，看到的倒计时会整体偏掉 ——
 * 可能一进结算页就写「即将放行」，也可能永远停在「还剩 3 分钟」。
 * 分牌倒计时当初就是因为这个从「剩余秒数」改成「绝对时刻 + now」的
 * （见 hub._view 里 splitEndsAt 那段注释），这里走同一条口径。
 *
 * 【这条为什么能测】
 * holdLeftText 是纯计算：给定 room 上的两个数字，返回一句话。
 * 不碰 DOM、不读当前状态 —— 所以它能被直接调用，而不是靠正则守源码。
 */
'use strict';

/* settleView 是浏览器全局模块（IIFE 挂 window.LXW）。
 * create() 只在用到渲染函数时才碰 DOM，holdLeftText 完全不需要 ——
 * 但 create 顶层解构了 LXW.utils 的一堆函数，所以要给个最小桩。 */
global.self = global;
global.LXW = {
  utils: {
    $: function () { return null; },
    el: function (tag, cls, text) { return { tag: tag, cls: cls, text: text, children: [], appendChild: function () {} }; },
    esc: function (s) { return String(s == null ? '' : s); },
    netText: function () { return ''; },
    netCls: function () { return ''; },
    pad2: function (n) { return String(n); },
    fmtTime: function () { return ''; },
    cardText: function () { return ''; },
    short: function (s) { return String(s || ''); },
    colorFor: function () { return ''; }
  }
};
require('../js/settleView.js');
var SV = global.LXW.settleView({ state: { myId: 'pa' } });

var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

ok(typeof SV.holdLeftText === 'function', '导出了 holdLeftText');

console.log('\n[1] 没在等的时候不显示');
{
  eq(SV.holdLeftText({}), '', '没有 holdNextEndsAt → 空串');
  eq(SV.holdLeftText(null), '', '没有房间 → 空串（不抛）');
  eq(SV.holdLeftText({ holdNextEndsAt: 0 }), '', '0 也当没有');
}

console.log('\n[2] 剩余时间按「绝对到期时刻」算');
{
  const now = Date.now();
  const txt = SV.holdLeftText({ holdNextEndsAt: now + 125000, now: now });
  eq(txt, '还剩 2 分 5 秒', '125 秒 → 2 分 5 秒');
  const txt2 = SV.holdLeftText({ holdNextEndsAt: now + 42000, now: now });
  eq(txt2, '还剩 42 秒', '不到一分钟只说秒');
  const txt3 = SV.holdLeftText({ holdNextEndsAt: now + 120000, now: now });
  eq(txt3, '还剩 2 分', '整分钟不带「0 秒」');
}

console.log('\n[3] 设备时钟偏差必须扣掉（服务的 now 比本地快 10 秒）');
{
  const localNow = Date.now();
  const serverNow = localNow + 10000;
  /* 服务端时间轴上「还有 60 秒」：ends = serverNow + 60000。
   * 不扣偏差会算成 70 秒 —— 那就是把「服务端时钟快」当成了「等得更久」。 */
  const txt = SV.holdLeftText({ holdNextEndsAt: serverNow + 60000, now: serverNow });
  eq(txt, '还剩 1 分', '★ 扣掉 10 秒偏差后正好 60 秒');
  const wrong = SV.holdLeftText({ holdNextEndsAt: serverNow + 60000, now: localNow });
  ok(wrong !== txt, '（对照）不扣偏差会得到另一个值：' + wrong);
}

console.log('\n[4] 已经过期：说「即将放行」，不说负数');
{
  const now = Date.now();
  eq(SV.holdLeftText({ holdNextEndsAt: now - 5000, now: now }), '即将放行', '过期 → 即将放行');
  eq(SV.holdLeftText({ holdNextEndsAt: now, now: now }), '即将放行', '恰好到点 → 即将放行');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
