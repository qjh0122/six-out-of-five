/**
 * 成就事件日志（node server/test/event-log.test.js）
 *
 * 守的是「改口径以后还能不能重算历史」这件事的第一环：原始观测有没有落下来，
 * 落下来的形状对不对，重复结算会不会写两遍。
 *
 * 几条断言不是形式：
 *   · **默认关闭** —— 忘了这条，单测会往真实数据目录写几千条日志。
 *   · **场级事件必须含 AI** —— posCount/negCount 是全场算的，少一个 bot，
 *     「全场只有我一个人正分」的重放结果就和线上不一致。
 *   · **(k,r,h,rd) 去重** —— 状态机改牌重结算会再触发一次，不去重就是双倍。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'lxw-evtlog-' + Date.now());
const DIR = path.join(TMP, 'events');
fs.mkdirSync(TMP, { recursive: true });

const EventLog = require('../eventLog.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) pass += 1;
  else { fail += 1; console.error('✗ ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(a, b, name) {
  ok(a === b, name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
}

console.log('\n[1] 默认关闭：没 configure 就什么都不写');
{
  EventLog._reset();
  eq(EventLog.isEnabled(), false, '默认没开');
  const room = { roomId: 'R1', handSeq: 1 };
  eq(EventLog.appendRound(room, 1, [{ group: 'tenhalf', winnerId: 'p1', entries: [{ id: 'p1', typeName: '10.5' }] }]),
    false, '★ 关闭时 appendRound 返回 false');
  eq(EventLog.appendSettlement(room, [{ id: 'p1', net: 5 }]), false, '关闭时 appendSettlement 也返回 false');
  ok(!fs.existsSync(DIR), '★ 一个文件都没生成（不许污染真实数据目录）');
}

console.log('\n[2] 打开后落盘');
{
  ok(EventLog.configure({ dir: DIR, enabled: true }) === true, '目录可写 → 开启成功');
  const room = { roomId: 'R1', handSeq: 7 };
  const results = [
    { group: 'tenhalf', winnerId: 'p1', entries: [
      { id: 'p1', typeName: '10.5' },
      { id: 'p2', typeName: '爆点' },
      { id: 'p3' }                                  // 没有 typeName：弃权那种
    ] },
    { group: 'douniu', winnerId: 'p2', entries: [
      { id: 'p1', typeName: '没牛' },
      { id: 'p2', typeName: '牛牛' }
    ] }
  ];
  eq(EventLog.appendRound(room, 1, results), true, '轮级事件写成功');
  const files = fs.readdirSync(DIR);
  eq(files.length, 1, '一个月片');
  ok(/^\d{4}-\d{2}\.jsonl$/.test(files[0]), '文件名是 YYYY-MM.jsonl', files[0]);
}

console.log('\n[3] 重复结算只写一次');
{
  const room = { roomId: 'R2', handSeq: 3 };
  const results = [{ group: 'tenhalf', winnerId: 'p1', entries: [{ id: 'p1', typeName: '10.5' }] }];
  eq(EventLog.appendRound(room, 1, results), true, '第一次写进去');
  eq(EventLog.appendRound(room, 1, results), false, '★ 同一个 (房间,场次,轮) 第二次被挡掉');
  eq(EventLog.appendRound(room, 2, results), true, '同一场换一轮可以写');
  eq(EventLog.appendSettlement(room, [{ id: 'p1', net: 3 }]), true, '场级第一次写进去');
  eq(EventLog.appendSettlement(room, [{ id: 'p1', net: 3 }]), false, '★ 同一场场级第二次被挡掉');
}

console.log('\n[4] 空轮不记');
{
  const room = { roomId: 'R3', handSeq: 1 };
  eq(EventLog.appendRound(room, 1, []), false, '★ 一组都没结算 → 不写（记了也重放不出东西）');
  eq(EventLog.appendRound(room, 1, null), false, 'null 也不写');
}

console.log('\n[5] 读回来：形状、去重、after 过滤');
{
  const all = EventLog.readAll({ dir: DIR });
  ok(all.length > 0, '读得到事件');
  const g = all.filter(function (e) { return e.k === 'g'; })[0];
  eq(g.g[0][0], 'tenhalf', '组名原文保留');
  eq(g.g[0][1], 'p1', '赢家');
  eq(g.g[0][2][0][1], '10.5', '★ 牌型存 typeName 原文（不存映射后的短键）');
  eq(g.g[0][2][2][1], '', '没有 typeName 的写成空串（弃权），不崩');
  eq(g.g[1][2].length, 2, '第二组两个人');

  /* 按时间去重：把同一批事件重复喂给 writeShards 再读，条数不变 */
  const before = all.length;
  EventLog.writeShards(all.concat(all), DIR);
  const after = EventLog.readAll({ dir: DIR });
  eq(after.length, before, '★ 写回时重复事件被 (k,r,h,rd) 去重');

  const maxT = after.reduce(function (m, e) { return Math.max(m, Number(e.t) || 0); }, 0);
  eq(EventLog.readAll({ dir: DIR, after: maxT }).length, 0, 'after = 最新时刻 → 一条都不剩');
  eq(EventLog.readAll({ dir: DIR, after: 0 }).length, before, 'after = 0 → 全给');
}

console.log('\n[6] 时间排序：同一毫秒也要「轮在结算之前」');
{
  const D2 = path.join(TMP, 'events2');
  const T = 1700000000000;
  EventLog.writeShards([
    { k: 's', v: 1, r: 'A', h: 5, t: T, p: [['p1', 1, 0]] },
    { k: 'g', v: 1, r: 'A', h: 5, rd: 1, t: T, g: [['tenhalf', 'p1', [['p1', '10.5']]]] }
  ], D2);
  const list = EventLog.readAll({ dir: D2 });
  eq(list.length, 2, '两条都在');
  eq(list[0].k, 'g', '★ 同一毫秒：轮级排在场级前面（rd 为 0 的场级排后面）');
  eq(list[1].k, 's', '场级在后');
}

console.log('\n[7] 场级事件必须带 AI');
{
  const room = { roomId: 'R4', handSeq: 1 };
  EventLog.appendSettlement(room, [
    { id: 'p1', net: 12 },
    { id: 'bot_a', net: -12, bot: true }
  ]);
  const evt = EventLog.readAll({ dir: DIR }).filter(function (e) {
    return e.k === 's' && e.r === 'R4';
  })[0];
  ok(!!evt, '场级事件在');
  eq(evt.p.length, 2, '★ 两个人都在（AI 也进事件，否则 posCount 会算错）');
  eq(evt.p[1][2], 1, 'AI 带 bot 标记');
  eq(evt.p[0][2], 0, '真人标记是 0');
  eq(evt.p[1][1], -12, '净胜是整数');
}

console.log('\n[8] 写失败不抛');
{
  /* 指到一个「已经存在且是文件」的路径当目录：mkdir 会失败 */
  const bad = path.join(TMP, 'not-a-dir');
  fs.writeFileSync(bad, 'x');
  eq(EventLog.configure({ dir: path.join(bad, 'events'), enabled: true }), false,
    '★ 目录建不出来时 configure 返回 false，不抛');
  eq(EventLog.isEnabled(), false, '并且保持关闭');
  EventLog._reset();
}

console.log('\n[9] 接线：生产入口确实把基线冻上了');
{
  /* 这一节读源码，不跑进程 —— 因为要守的是「接线还在不在」，
   * 而不是「stampAchBase 对不对」（那个由 ach-replay 那一套守）。
   *
   * 为什么值得单独守：基线缺失时重放器会**跳过所有人**（宁可不判，也不从 0 算），
   * 于是整套事件日志对真实玩家等于不存在，线上没有任何症状 ——
   * 有人把这几行删掉，功能就安静地死了。 */
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  ok(/EventLog\.configure\(\s*\{[^}]*enabled:\s*true/.test(src),
    'index.js 里打开了事件日志');
  ok(/profiles\.stampAchBase\(/.test(src),
    '★★ index.js 会冻基线（删掉它 = 重放器永远没人可放，且无任何报错）');

  /* 顺序：configure 成功（on）之后才冻 —— 反过来就是「基线早于日志」，
   * 那段时间的牌既不在基线也没事件，重放会抹掉。 */
  const iCfg = src.indexOf('EventLog.configure({ dir: EVENT_LOG_DIR');
  const iStamp = src.indexOf('profiles.stampAchBase(');
  ok(iCfg > 0 && iStamp > iCfg, '★ 冻结发生在打开日志之后（否则会留一段抹不回来的空窗）');
  ok(/if\s*\(on\)\s*\{\s*[\s\S]{0,200}?profiles\.stampAchBase\(/.test(src),
    '只在日志真的打开时才冻（目录不可写时不冻，免得冻了却没有重放依据）');

  /* 幂等靠 stampAchBase 自己判，这里只确认它真的判了 —— 每次重启都覆盖，
   * 等于把「基线之后已经重放进去的增量」再冻一遍，重放一次涨一次。 */
  const prof = fs.readFileSync(path.join(__dirname, '..', 'profile.js'), 'utf8');
  ok(/stampAchBase\(now\)\s*\{[\s\S]{0,400}?if\s*\(p\.achBase && Number\(p\.achBase\.at\) > 0\)\s*return;/.test(prof),
    '★★ stampAchBase 幂等：已有基线的档案不覆盖');
}

console.log('\n----------------------------------------');
if (fail) {
  console.error('失败 ' + fail + ' 项，通过 ' + pass + ' 项');
  process.exit(1);
} else {
  console.log('通过 ' + pass + ' 项，失败 0 项');
}
