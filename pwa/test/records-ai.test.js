/**
 * 战绩页的「含人机」口径（前端侧）
 * 跑法：node pwa/test/records-ai.test.js
 *
 * 服务端的口径已经由 server/test/ai-records.test.js 锁死（人机局不进 recent、
 * 不碰任何统计字段）。这个文件管的是**前端这一半**，两件不同的事：
 *
 *   1. 本机兜底数据层（records.js）也必须同口径。
 *      离线 / ?mode=local 时战绩页读的是 localStorage，如果那里不排除 ai 行，
 *      同一个账号在线上和离线会看到两套数字 —— 那是最难解释的一种 bug。
 *   2. 界面要**看得出**哪一场含人机，并在合适的位置说清它不算数。
 *      用户原话是「不计入战绩和排行榜…但在我的战绩页面上表示出含人机对战」，
 *      所以「不算」和「要显示」必须同时成立，不能藏。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

function makeLS() {
  var map = Object.create(null);
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem: function (k, v) { map[k] = String(v); },
    removeItem: function (k) { delete map[k]; },
    clear: function () { map = Object.create(null); }
  };
}
global.localStorage = makeLS();
const Records = require('../js/records.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const gameJs = readGameAll();
const recCss = fs.readFileSync(path.join(ROOT, 'css', 'records.css'), 'utf8');
const styleCss = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);
let seq = 0;
function rec(extra) {
  seq++;
  const o = {
    roomId: String(200000 + seq),
    endedAt: T0 + seq * 60000,
    playerCount: 3,
    myStartScore: 100,
    myEndScore: 100 + (extra && extra.net !== undefined ? extra.net : 5),
    rounds: seq,
    endReason: 'scoreZero',
    playerId: 'pa'
  };
  if (extra) for (const k in extra) o[k] = extra[k];
  return o;
}
function reset() { global.localStorage.clear(); }

/* ========================================================================== */
console.log('\n[1] 本机兜底：ai 行不进统计，但留在列表里');
reset();
Records.add(rec({ net: 6 }));
Records.add(rec({ net: -4 }));
Records.add(rec({ net: 30, playerCount: 3, ai: true }));   // ← 赢了一大把的人机局

const st = Records.stats('pa');
eq(st.games, 2, '★ 场次只算人类局（人机那场不进）');
eq(st.totalNet, 2, '★ 净胜 6-4 = 2（+30 没进来）');
eq(st.wins, 1, '★ 胜场只算人类局');
eq(st.bestNet, 6, '★ 单场最高 6（30 不算「我打得最好」）');
/* v111 口径统一：currentStreak 带符号（+N 连胜 / -N 连败），与云端档案一致；
 * 以前这里只记连胜（输了返回 0），于是本地兜底路径永远显示不出「连败」。
 * 列表最新一条其实是 +30 的人机局；如果它被算进来，这里会是 1 —— 那才是 bug。 */
eq(st.currentStreak, -1, '★ 当前是连败 1（人机那把 +30 既没续上连胜、也没消掉连败）');
eq(st.longestStreak, 1, '最长连胜 1');

eq(Records.all('pa').length, 3, '★ 列表里三条都在（要显示，不能藏）');
const aiRow = Records.all('pa').filter(function (r) { return r.ai; });
eq(aiRow.length, 1, '人机那行带 ai 标记');
eq(aiRow[0].myNet, 30, '那行的净胜照样保留（要给玩家看结果）');

/* 趋势条只取人类局：人机局不该出现在「最近 10 局」的赢输序列里 */
eq(st.recent.length, 2, '趋势条 2 格（人机局不占格子）');
eq(st.recent.join(','), 'win,lose', '趋势条顺序：旧 → 新');

/* ========================================================================== */
console.log('\n[2] ai 标记的规范化：只认 true，脏值不认');
reset();
Records.add(rec({ net: 3, ai: true }));
Records.add(rec({ net: 4, ai: 'true' }));   // 字符串不算
Records.add(rec({ net: 5, ai: 1 }));        // 数字不算
const list = Records.all('pa');
eq(list.filter(function (r) { return r.ai === true; }).length, 1, '只有真 true 的那条被标记');
ok(list.some(function (r) { return r.ai === undefined; }), '非 true 的记录干脆不带 ai 字段（别在磁盘上留垃圾）');
eq(Records.stats('pa').games, 2, '统计只排除真 true 的那一条');

/* ========================================================================== */
console.log('\n[3] 只有人机局的账号：有数据可显示，但统计是 0');
reset();
Records.add(rec({ net: 12, ai: true }));
Records.add(rec({ net: -7, ai: true }));
const onlyAi = Records.stats('pa');
eq(onlyAi.games, 0, '★ 场次 0（所以不会进排行榜）');
eq(onlyAi.totalNet, 0, '★ 净胜 0');
eq(onlyAi.bestNet, 0, '★ 单场最高 0（n === 0 时不该冒出 -7）');
eq(onlyAi.winRate, 0, '胜率 0，不是 50');
eq(Records.all('pa').length, 2, '★ 但列表里有 2 行 —— 不能让「我明明打过」和「还没有战绩」同时成立');

/* ========================================================================== */
console.log('\n[4] 界面结构：说明 + 徽标 + 结算提示都在');
ok(html.indexOf('id="rp-ai-note"') >= 0, '战绩页有 #rp-ai-note 说明行');
ok(/id="rp-ai-note"[^>]*class="[^"]*\bhidden\b/.test(html), '#rp-ai-note 默认隐藏（没有 AI 局时不占位）');
ok(html.indexOf('class="rp-ai-chip"') >= 0, '说明行里有一枚「含人机」徽标（视觉上与行内徽标同形）');
ok(/id="rp-ai-note-text"/.test(html), '说明文案是独立节点（js 要往里写局数）');
ok(/<span class="rp-ai-chip">含人机<\/span>/.test(html), '徽标文案就是「含人机」三个字');

/* 说明放在列表标题下面，而不是页脚：它解释的是下面这几行 */
const iHead = html.indexOf('rp-list-head');
const iNote = html.indexOf('id="rp-ai-note"');
const iList = html.indexOf('id="records-list"');
ok(iHead >= 0 && iNote > iHead && iList > iNote, '★ 位置：列表标题 → 人机说明 → 列表（解释的是下面这几行）');

ok(gameJs.indexOf("el('span', 'rp-row-ai', '含人机')") >= 0, '行内徽标由 renderRecordRows 生成');
ok(gameJs.indexOf("li.classList.add('is-ai')") >= 0, '人机行加 .is-ai（整行降一档亮度）');
ok(/\.rp-row\.is-ai/.test(recCss), '样式里有 .rp-row.is-ai');
ok(/\.rp-ai-chip,\s*\n?\s*\.rp-row-ai\s*\{/.test(recCss), '说明徽标与行内徽标共用一套样式（同形 = 一看就懂）');

/* 横屏小字保护：这一批新元素都在清单里，否则 390px 高的横屏会糊成一片 */
const lsBlocks = styleCss.split('#stage.ls').slice(1).join('#stage.ls');
ok(lsBlocks.indexOf('.rp-ai-chip') >= 0, '横屏：.rp-ai-chip 有字号下限');
ok(lsBlocks.indexOf('.rp-ai-note') >= 0, '横屏：.rp-ai-note 有字号下限');
ok(gameJs.indexOf("el('p', 'settle-ai-note', '本局含 AI · 不计入战绩与排行榜')") >= 0,
  '★ 结算页当场说明「本局含 AI · 不计入战绩与排行榜」（别让人打完才发现没算）');
ok(styleCss.indexOf('.settle-ai-note') >= 0, '结算页提示有样式');

/* ========================================================================== */
console.log('\n[5] 数据源接线：本机写 ai、云端合并两份流水');
ok(/ai:\s*roomHasBot\(room\)/.test(gameJs), 'recordSettled 写入 ai: roomHasBot(room)');
ok(/function roomHasBot\(room\)/.test(gameJs), '存在 roomHasBot()');
ok(/room\.handHadBot === true/.test(gameJs), 'roomHasBot 认服务端权威字段 handHadBot');
ok(/ps\[i\]\.isBot/.test(gameJs), 'roomHasBot 还兜底看座位表（中途移除的 AI 不在座位上了）');
ok(/hasBot:\s*hasBot/.test(fs.readFileSync(path.join(ROOT, '..', 'server', 'hub.js'), 'utf8')),
  '服务端结算把 hasBot 一并写进 meta');

ok(/for \(var a = 0; a < aiRec\.length; a\+\+\) pushRow\(aiRec\[a\], true\)/.test(gameJs),
  '★ cloudRows 把 aiRecent 也铺成行（否则战绩页看不到人机局）');
ok(/out\.sort\(function \(x, y\) \{ return \(Number\(y\.endedAt\)/.test(gameJs),
  '★ 两份流水合并后按时间倒序（不能假设两份数组自身顺序交错正确）');
ok(/aiGames:\s*Number\(p && p\.aiGames\) \|\| 0/.test(gameJs), 'cloudStats 透出 aiGames');
ok(/var aiCount = Number\(st\.aiGames\) \|\| \(rows\.length - humanRows\)/.test(gameJs),
  '说明里的局数：优先服务端 aiGames，本地兜底退回数行数');
ok(/var hasData = st\.games > 0 \|\| rows\.length > 0/.test(gameJs),
  '★ hasData 把「只有人机局」也算有数据（否则空态文案会和列表打架）');

/* 排行榜页脚必须写清口径，否则「我打了几十场怎么榜上没有我」无从解释。
 * 用户 2026-10-30 的原话是「排行榜要加说明 说明不含人机即可」——
 * 所以这里守的是「不含人机」这四个字，不是「仅统计对人类局」这种委婉说法。 */
ok(/不含人机对局/.test(html), '★ 排行榜页脚写明「不含人机对局」');

/* ========================================================================== */
console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
