/**
 * `state` 字段归位的守卫（node pwa/test/state-reset.test.js）
 *
 * 这一条结构债的真实症状是「从战绩页回首页再进房，看到上一局的状态」，
 * 而它一直是查不出来的：字段靠首次赋值动态挂上，没有清单可对照，
 * 谁也不知道「该清哪些」。v111 的整理做的是把清单写出来，这个文件负责让清单**不能再腐化**。
 *
 * 四条判据（都做过证红：故意漏一个字段就红）：
 *   1. 字面量里出现的字段，STATE_DEFAULT 里必须有（否则新字段没人知道默认值是什么）
 *   2. STATE_DEFAULT 里每个字段都必须被某一个 reset 函数真的写回去（否则「有默认值」只是纸面）
 *   3. 代码里不许出现「字面量之外」的 state 字段（`state.xxx = ...` 而 xxx 不在清单里）
 *   4. 三个时机的调用点都在：退房、换手、清空重分
 */
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'game.js'), 'utf8');

/* 取对象字面量 { ... } 的键（只认 `name: value` 形态，够用且不会误收代码） */
function keysOf(block) {
  const out = [];
  block.split('\n').forEach((line) => {
    const code = line.replace(/\/\/.*$/, '');   // 去掉行尾注释，注释里也有冒号
    const re = /(?:^|[\s,])([a-zA-Z_$][\w$]*)\s*:\s*/g;
    let m;
    while ((m = re.exec(code))) out.push(m[1]);
  });
  return out;
}

const litMatch = /var state = \{([\s\S]*?)\n  \};/.exec(src);
const defMatch = /var STATE_DEFAULT = \{([\s\S]*?)\n  \};/.exec(src);
const fnMatch = {
  split: /function resetSplitState\(\)\s*\{([\s\S]*?)\n  \}/.exec(src),
  room: /function resetRoomState\(\)\s*\{([\s\S]*?)\n  \}/.exec(src),
  session: /function resetSessionState\(\)\s*\{([\s\S]*?)\n  \}/.exec(src)
};

console.log('\n[1] 清单完整性');
ok(!!litMatch, '找得到 state 字面量');
ok(!!defMatch, '找得到 STATE_DEFAULT');
const declared = litMatch ? keysOf(litMatch[1]) : [];
const defaults = defMatch ? keysOf(defMatch[1]) : [];
ok(declared.length >= 16, 'state 字段数 ≥ 16（实际 ' + declared.length + '）', declared.join(','));

/* myId 是身份，不随退房/换手清，所以只要求它「被声明」，不要求进制表 */
const needDefault = declared.filter((k) => k !== 'myId');
const missingDefault = needDefault.filter((k) => defaults.indexOf(k) < 0);
ok(missingDefault.length === 0, '★ 每个会话/房间/分牌字段都有默认值', missingDefault.join(','));

console.log('\n[2] 默认值必须真的被写回去');
const bodies = {};
Object.keys(fnMatch).forEach((k) => { bodies[k] = fnMatch[k] ? fnMatch[k][1] : ''; });
const allResets = Object.keys(bodies).map((k) => bodies[k]).join('\n');
const neverReset = needDefault.filter((k) => !new RegExp('state\\.' + k + '\\s*=').test(allResets));
ok(neverReset.length === 0, '★ STATE_DEFAULT 里的每个字段都被某个 reset 函数写回', neverReset.join(','));

/* 三个字段以前是「首次赋值时动态挂上」的，这条把它们钉在字面量里 */
['justDealt', 'absorbSig', 'dissolveWasActive'].forEach((k) => {
  ok(declared.indexOf(k) >= 0, '★ ' + k + ' 已写进字面量（不再靠首次赋值动态挂上）');
});

console.log('\n[3] 不许再出现「清单之外」的字段');
{
  /* 扫全仓 pwa/js：`state.xxx =` 的 xxx 必须在清单里（读写都查会更啰嗦，写才是新字段的来源） */
  const dir = path.join(ROOT, 'js');
  const bad = [];
  fs.readdirSync(dir).filter((f) => f.endsWith('.js')).forEach((f) => {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /\bstate\.([a-zA-Z_$][\w$]*)\s*=(?!=)/g;
    let m;
    while ((m = re.exec(s))) {
      if (declared.indexOf(m[1]) < 0) bad.push(f + ':state.' + m[1]);
    }
  });
  ok(bad.length === 0, '★ 没有字面量之外的 state 字段（新字段必须先声明）', bad.join(','));
}

console.log('\n[4] 三个时机都接上了');
{
  const cleanup = /function cleanupRoom\(\)\s*\{([\s\S]*?)\n  \}/.exec(src);
  ok(!!cleanup, '找得到 cleanupRoom');
  const body = cleanup ? cleanup[1] : '';
  ok(/resetRoomState\(\)/.test(body), '退房：房间级字段归位');
  ok(/resetSplitState\(\)/.test(body), '退房：分牌级字段归位');
  ok(/resetSessionState\(\)/.test(body), '退房：会话级字段（当前屏 / 页面来处 / 压制点击）归位');

  const ensure = /function ensureDraft\(room\)\s*\{([\s\S]*?)\n  \}/.exec(src);
  ok(!!ensure && /resetSplitState\(\)/.test(ensure[1]), '★ 换手（ensureDraft）：分牌级字段归位');

  const clearBtn = /function onClearGroups\([\s\S]*?\n  \}/.exec(src);
  ok(!clearBtn || /resetSplitState\(\)/.test(clearBtn[0]), '清空重分：也走同一个重置（不留手写副本）');

  ok(!/state\.lastMeScore = null;\s*\n\s*state\.settleCelebrated = false;/.test(body),
    '★ cleanupRoom 里不再有逐行手写的字段清理（那样加字段必漏）');
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
