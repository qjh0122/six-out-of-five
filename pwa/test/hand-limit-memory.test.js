/**
 * 「记住上次的把数」守卫（node pwa/test/hand-limit-memory.test.js）
 *
 * 这个功能只有三种坏法，三种都不会报错：
 *   1. 读回来了但没喂给 createLimit → 打开弹窗还是 10（功能看起来「没做」）
 *   2. 存的是「最后点过的」而不是「提交出去的」→ 点了 15 又取消，下次真成 15
 *   3. 不校验白名单 → 档位列表改了之后，老记忆里那个已下架的档位被拿去建房，
 *      服务端拒绝，玩家只看到一句「创建失败」，而原因在一个月前就不存在了
 *
 * game.js 是浏览器模块（顶层就要 DOM），没法 require 进来跑，
 * 所以这里读源码做结构断言 —— 和项目里 49 个同类守卫一个路数。
 * 判别力靠「精确到调用点」而不是「全文有没有这个词」。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { readOne } = require('./helpers/gameSource.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const src = readOne('game.js');

console.log('\n[1] 读写函数存在且命名一致');
/* v111 起键名从 js/storage.js 的唯一清单取（物理键只允许在那里出现一次）。
 * 这里改成「取的是清单里的那一项」+「清单里确实叫这个名」两条一起守，
 * 只守后一条会被「代码里又写死一遍」绕过。 */
ok(/var HAND_LIMIT_KEY = ST \? ST\.KEYS\.HAND_LIMIT : 'lxw_hand_limit_v1';/.test(src),
  '键名从存储清单取（storage.js 的 HAND_LIMIT）');
ok(/HAND_LIMIT: 'lxw_hand_limit_v1'/.test(fs.readFileSync(path.join(__dirname, '..', 'js', 'storage.js'), 'utf8')),
  '清单里确实是 lxw_hand_limit_v1（与 lxw_guide_seen_v1 同一命名）');
ok(/function readSavedLimit\(\)/.test(src), '有 readSavedLimit');
ok(/function saveLimit\(n\)/.test(src), '有 saveLimit');

/* 读写都要有「不抛」的兜底：隐私模式下 localStorage 直接抛 SecurityError，
 * 一个没包 try 的读会让整个建房弹窗打不开 —— 那是最难查的一类（只有部分用户会遇到）。 */
const readFn = /function readSavedLimit\(\)\s*\{([\s\S]*?)\n  \}/.exec(src);
const saveFn = /function saveLimit\(n\)\s*\{([\s\S]*?)\n  \}/.exec(src);
/* 「不能被隐私模式炸掉」是这里真正要守的性质，v111 起由 storage.js 统一保证：
 * Store.read / Store.write 契约上**永不抛**（storage.test.js [3] 用会抛的 backing 证过）。
 * 所以判据从「函数里有 try/catch」换成「走的是那个不抛的入口」——
 * 守的仍是同一件事，且不再逼着每个调用点各写一份 try/catch。 */
ok(!!readFn && /ST\.read\(HAND_LIMIT_KEY/.test(readFn[1]), '★ readSavedLimit 走 ST.read（契约上不抛）');
ok(!!saveFn && /ST\.write\(/.test(saveFn[1]), '★ saveLimit 走 ST.write（写不进返回 false，不抛）');
ok(!/(local|session)Storage\s*\.\s*(get|set|remove)Item/.test(src),
  '不再直接读写 localStorage（收口后只剩 storage.js 一处；注释里提到不算）');

console.log('\n[2] 白名单校验');
ok(!!readFn && /CONFIG\.HAND_LIMITS[\s\S]*indexOf\(n\)\s*>=\s*0/.test(readFn[1]),
  '★ 记忆值必须在 CONFIG.HAND_LIMITS 里才采用（下架档位自动失效）');
ok(!!readFn && /return 0;/.test(readFn[1]), '不认识的值返回 0（由调用方回落默认，不在读函数里猜）');

console.log('\n[3] 读回来的值真的被用了');
/* 精确到那一行：createLimit = readSavedLimit() || CONFIG.DEFAULT_HAND_LIMIT
 * 只查「openCreateModal 里有 readSavedLimit」不够 —— 调用结果丢掉也能过。 */
ok(/createLimit = readSavedLimit\(\) \|\| CONFIG\.DEFAULT_HAND_LIMIT;/.test(src),
  '★ openCreateModal 用「记忆值 || 默认档」赋值给 createLimit');
/* 只查 openCreateModal 的函数体，不能全文查 —— 模块顶部那句
 * `var createLimit = CONFIG.DEFAULT_HAND_LIMIT;` 是合法初值（第一次打开前的占位），
 * 全文查会把正确代码判红。第一版就是这么写的，假红一次。 */
const openFn = /function openCreateModal\(\)\s*\{([\s\S]*?)\n  \}/.exec(src);
ok(!!openFn, '找得到 openCreateModal 的函数体');
ok(!!openFn && !/createLimit = CONFIG\.DEFAULT_HAND_LIMIT;/.test(openFn[1]),
  '★ openCreateModal 里没有「无条件重置成默认」（留着它会覆盖记忆）');

console.log('\n[4] 存的是提交出去的值');
const confirmIdx = src.indexOf('async function onCreateConfirm()');
ok(confirmIdx > 0, '找得到 onCreateConfirm');
const confirmBody = src.slice(confirmIdx, confirmIdx + 500);
const savePos = confirmBody.indexOf('saveLimit(limit)');
const closePos = confirmBody.indexOf('closeCreateModal()');
ok(savePos > 0, '★ onCreateConfirm 里调了 saveLimit(limit)');
ok(savePos > 0 && savePos < closePos, '★ saveLimit 在 closeCreateModal 之前（先记再关，顺序反了会读到旧值）');
/* 不能存 createLimit（点过但可能被取消的值），必须存 limit（真的提交的那个） */
ok(confirmBody.indexOf('saveLimit(createLimit)') < 0, '★ 不存 createLimit —— 存的是本次提交的 limit');

console.log('\n[5] 与档位表对齐');
const cfg = readOne('config.js');
const limits = /HAND_LIMITS:\s*\[([^\]]+)\]/.exec(cfg);
ok(!!limits, 'config.js 里有 HAND_LIMITS');
const list = limits ? limits[1].split(',').map((x) => Number(x.trim())) : [];
ok(list.length >= 3, '档位至少 3 档（实际 ' + list.length + '）');
ok(/DEFAULT_HAND_LIMIT:\s*10/.test(cfg), '默认档仍是 10（产品口径没变）');
ok(list.indexOf(10) >= 0, '10 在档位表里（默认值必须是合法档位，否则回落逻辑会崩）');

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
