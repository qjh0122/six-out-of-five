/**
 * 成就键定点清零（数据层 + 接口层）
 * 跑法：node server/test/ach-reset.test.js
 *
 * 守的是三条，全都是「不做就会悄悄出错」的：
 *
 *   1. **必须同时清 `achBase.counts`**。只清 `ach` 的话，下次重放以基线为起点
 *      fold，那个错数字又被叠回来，界面看起来像「修了没用」—— 没有任何报错。
 *   2. **只能清白名单里的战绩键**。`vs` / `vsn` / `t.*` 是比率的分母，
 *      清掉分母不是「修正」，是把那条成就变成 0/0 永久废掉。
 *   3. **默认必须 dryRun**。这条会删全服的计数，给一次「看一眼原值」的机会，
 *      比事后整份 restore 便宜得多（上一次 mark-ai-games 连发两次误伤 4 条战绩）。
 */
'use strict';

const path = require('path');
const os = require('os');

process.env.PROFILE_FILE = path.join(os.tmpdir(), 'lxw-achreset-profiles-' + Date.now() + '.json');
process.env.SEED_FILE = path.join(os.tmpdir(), 'lxw-achreset-seed-' + Date.now() + '.json');
process.env.BACKUP_KEY = 'achreset-test-key-0123456789';
process.env.PORT = process.env.PORT || '3199';
const PORT = Number(process.env.PORT);

const { server, profiles } = require('../index.js');
const { registerPlayer, httpJson } = require('./helpers/account');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

const KEY = process.env.BACKUP_KEY;
const SC = '?sharecode=TESTCODE';

function admin(body, key) {
  return httpJson(PORT, 'POST', '/api/admin/ach-reset' + SC, body,
    { 'x-backup-key': key === undefined ? KEY : key });
}

/* 造一份「判定写错」的档案：r9 攒了 801 次，而场次只有 3 */
function seedAch(pid, ach) {
  const p = profiles.data.get(pid);
  p.ach = ach;
  p.achBase = {
    at: Date.now() - 1000,
    achv: Number(ach.v) || 1,
    counts: JSON.parse(JSON.stringify(ach)),
    currentStreak: 0
  };
  return p;
}

(async function main() {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  await new Promise((r) => setTimeout(r, 60));

  const acc = await registerPlayer(PORT, '清零甲');
  const acc2 = await registerPlayer(PORT, '清零乙');
  const bad = {
    v: 1, since: Date.now(), r9: 801, r10: 5, r12: 3,
    vs: 100, vsn: 240, t: { th: 12, lp: 4 }
  };
  seedAch(acc.playerId, bad);
  seedAch(acc2.playerId, Object.assign({}, bad, { r9: 0, r10: 2, r12: 0 }));

  console.log('\n[1] 鉴权与参数');
  {
    const noKey = await admin({ keys: ['r9'] }, '');
    ok(noKey.status === 403, '没密钥 → 403', noKey.status);
    const wrongKey = await admin({ keys: ['r9'] }, 'x'.repeat(KEY.length));
    ok(wrongKey.status === 403, '等长伪造 → 403', wrongKey.status);

    const empty = await admin({ keys: [] });
    eq(empty.status, 400, '空 keys → 400（不给就等于「清全部」，接口不替人猜）');
    const none = await admin({ keys: ['vs', 'vsn', 't'] });
    eq(none.status, 400, '★ 全在白名单外 → 400');
    ok((none.json.skipped || []).join(',').indexOf('vs') >= 0, '并把被拒的键报回来', JSON.stringify(none.json));
  }

  console.log('\n[2] 默认预演：一格都不动');
  {
    const r = await admin({ keys: ['r9'] });            // 不传 dryRun
    eq(r.status, 200, '200');
    eq(r.json.dryRun, true, '★ 不传 dryRun 就是预演');
    const p = profiles.data.get(acc.playerId);
    eq(p.ach.r9, 801, '★ 预演后 ach.r9 原样');
    eq(p.achBase.counts.r9, 801, '★ 预演后基线也原样');
    eq(r.json.cells, 1, '预演报告了会动几格（只有甲有 801，乙本来就是 0）');
    const row = (r.json.detail || []).filter((x) => x.id === acc.playerId)[0];
    ok(!!row && row.keys.r9 === 801, '★ detail 里带着原值（运维要能对账）', JSON.stringify(row));
  }

  console.log('\n[3] 真清：ach 与基线一起归零');
  {
    const r = await admin({ keys: ['r9'], dryRun: false });
    eq(r.status, 200, '200');
    eq(r.json.dryRun, false, '回执标明是应用');
    const p = profiles.data.get(acc.playerId);
    eq(p.ach.r9, 0, 'ach.r9 → 0');
    eq(p.achBase.counts.r9, 0, '★★ 基线里的 r9 也 → 0（不清它，下次重放会叠回来）');
    eq(r.json.baseCells, 1, '基线那半边单独记账（甲 1 格，乙没有 r9）');

    /* 分母不许动：清了 vs/vsn，出现率与胜率会变成 0/0，等于把成就废掉 */
    eq(p.ach.vs, 100, '★★ vs 原样（分母不能清）');
    eq(p.ach.vsn, 240, '★★ vsn 原样');
    eq(p.ach.t.th, 12, '★★ 牌型计数 t.th 原样');
    eq(p.ach.r10, 5, '★ 没点名的 r10 原样');
  }

  console.log('\n[4] 幂等：再清一次没有可清的格子');
  {
    const r = await admin({ keys: ['r9'], dryRun: false });
    eq(r.status, 200, '200');
    eq(r.json.cells, 0, '★ 第二次 cells = 0（甲已经清过，乙本来也是 0）');
    eq(r.json.baseCells, 0, '★ 基线的 0 格');
  }

  console.log('\n[5] 白名单外的键不静默通过');
  {
    const r = await admin({ keys: ['r10', 'vs'], dryRun: false });
    eq(r.status, 200, '200（白名单外只忽略，不整单拒绝）');
    eq((r.json.keys || []).join(','), 'r10', '只认 r10');
    eq((r.json.skipped || []).join(','), 'vs', '★ vs 被明确列进 skipped');
    const p = profiles.data.get(acc.playerId);
    eq(p.ach.r10, 0, 'r10 清了');
    eq(p.ach.vs, 100, '★ vs 依然是 100');
  }

  console.log('\n[6] 没有基线的人也能清（老档案不该被落下）');
  {
    const acc3 = await registerPlayer(PORT, '清零丙');
    const p3 = profiles.data.get(acc3.playerId);
    p3.ach = { v: 1, since: Date.now(), r12: 9 };
    delete p3.achBase;
    const r = await admin({ keys: ['r12'], dryRun: false });
    eq(r.status, 200, '200');
    eq(profiles.data.get(acc3.playerId).ach.r12, 0, '★ 没有 achBase 的人也清掉了 ach');
    ok(typeof r.json.baseCells === 'number', 'baseCells 始终是数字，不是 undefined');
  }

  console.log('\n[7] 基线与清零都必须**自己落盘**（线上踩过）');
  {
    /* 线上真事：两次发布间隔 9 分钟，18 份档案的基线时刻整体后移了 9 分钟。
     * 原因是 stampAchBase / resetAchKeys 只置了 dirty，没排队落盘 ——
     * 服务刚启动还没人开局时，没有任何别的写操作会顺带把 dirty 刷下去，
     * 于是基线只活在内存里；一重启，磁盘上没有 achBase，启动逻辑再冻一次，
     * 时刻变成新的。数据不算错，但重放器的 cutoff 跟着往后跑：
     * 「重启之前的历史」永远落在 cutoff 之前，永远重算不了 —— 功能看着在跑，
     * 实际每次都只剩最后一小段可算。 */
    const fs = require('fs');
    const tmpFile = path.join(os.tmpdir(), 'lxw-achreset-persist-' + Date.now() + '.json');
    /* 档案要「新到不能再新」：longestLoseStreak / aiRecent / aiGames / ach 都给全，
     * 这样加载时 `_ensureDerived` 返回 false、不会顺带排一次 flush。
     * 少给一个字段，这条断言就变成在验「补字段顺手落盘」，验不到基线自己那一下。 */
    fs.writeFileSync(tmpFile, JSON.stringify({
      ptest: {
        id: 'ptest', nickname: '落盘甲', createdAt: Date.now(),
        games: 1, wins: 1, losses: 0, totalNet: 10, bestNet: 10,
        longestLoseStreak: 0, aiRecent: [], aiGames: 0, currentStreak: 1,
        ach: { v: 1, since: Date.now(), r9: 3, r12: 7, vs: 5, vsn: 5 }
      }
    }), 'utf8');

    const { ProfileStore } = require('../profile.js');
    const store = new ProfileStore({ file: tmpFile });
    const at = Date.now() - 5;
    eq(store.stampAchBase(at), 1, '冻了一个人');

    /* 等一次去抖（500ms）—— 不 flush() 硬写，要验的正是「它自己排上了队」 */
    await new Promise((r) => setTimeout(r, 700));
    const onDisk = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    ok(!!(onDisk.ptest && onDisk.ptest.achBase), '★★ 基线自己写进了磁盘（只置 dirty 会丢）');
    eq(onDisk.ptest.achBase.at, at, '★★ 落盘的时刻就是冻结时刻');

    /* 模拟重启：新实例从磁盘读回来，再冻一次应当一个都不冻 */
    const again = new ProfileStore({ file: tmpFile });
    eq(again.data.get('ptest').achBase.at, at, '★ 重启后基线还在，时刻不变');
    eq(again.stampAchBase(Date.now()), 0, '★★ 重启不会再冻一次（幂等，cutoff 不会往后跑）');

    /* 清零同样要自己落盘，否则「修了」只存在于内存里 */
    const r = again.resetAchKeys(['r9'], { dryRun: false });
    eq(r.cells, 1, '清了一格');
    await new Promise((res) => setTimeout(res, 700));
    const disk2 = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    eq(disk2.ptest.ach.r9, 0, '★ ach.r9 落盘为 0');
    eq(disk2.ptest.achBase.counts.r9, 0, '★★ 基线那份也落盘为 0');
    eq(disk2.ptest.ach.vsn, 5, '分母原样留在磁盘上');
  }

  console.log('\n----------------------------------------');
  if (fail) {
    console.error('失败 ' + fail + ' 项，通过 ' + pass + ' 项');
    process.exit(1);
  }
  console.log('通过 ' + pass + ' 项，失败 0 项');
  process.exit(0);
})().catch((e) => {
  console.error('测试自身出错：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
