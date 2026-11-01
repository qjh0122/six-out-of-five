/**
 * 落盘失败必须留痕（node server/test/profile-save-fail.test.js）
 *
 * 修的是什么（P0-3）：`flush()` 与 `_flushAsync()` 的失败分支以前只把
 * `dirty = true` 置回去，**一行日志都没有**。后果是「磁盘满 / 只读挂载 /
 * 数据目录被删」这类故障线上完全静默 —— 玩家打了一整场，战绩在内存里、
 * 磁盘上没有，进程一重启就没了，而日志里查不到任何东西。
 *
 * 这个文件锁四条：
 *   1. 写失败 → 日志里出现「落盘失败」并带上阶段、路径与错误码；
 *   2. **进程不崩**（失败不该让服务挂掉，内存里的数据还在）；
 *   3. dirty 仍然为 true（失败还要重试，不能把状态清成「已保存」）；
 *   4. 负向断言：**正常情况一条都不该有** —— 否则日志被噪音淹没，
 *      真出问题时反而看不见（这是「加日志」这件事最常见的反向失败）。
 *
 * 怎么造失败：把一个**普通文件**当目录用（`file = <某个文件>/profiles.json`）。
 * 这样 mkdir 必然失败，跨平台行为一致（Windows 报 ENOTDIR/EEXIST，Linux 报 ENOTDIR）。
 * 比「把目录设成只读」可靠：后者在 Windows 要改 ACL，在 CI 里又常因以 root 跑而失效。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'lxw-savefail-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

const { ProfileStore } = require('../profile.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

(async function main() {
  /* ---------- 负向基线：正常目录不产生任何「落盘失败」 ---------- */
  console.log('\n[1] 正常落盘：一条「落盘失败」都不该有');
  const goodLogs = [];
  const good = new ProfileStore({
    file: path.join(TMP, 'ok', 'profiles.json'),
    seedFile: path.join(TMP, 'no-seed.json'),
    log: function (m) { goodLogs.push(m); }
  });
  good.record('gp1', '正常玩家', 5, 1700000000000, 'GR', 1, { playerCount: 2, endReason: 'handLimit' });
  good.flush();
  ok(fs.existsSync(path.join(TMP, 'ok', 'profiles.json')), '正常目录下文件真的写出来了');
  eq(goodLogs.filter(function (m) { return m.indexOf('落盘失败') >= 0; }).length, 0,
    '★ 正常路径没有「落盘失败」日志（噪音会把真问题淹掉）');
  eq(good.dirty, false, '写成功后 dirty 是 false');

  /* ---------- 造一个必然失败的路径 ---------- */
  console.log('\n[2] 写不进去：日志必须有，进程不能崩');
  const blocker = path.join(TMP, 'blocker');
  fs.writeFileSync(blocker, 'x', 'utf8');                // 这是一个**文件**
  const badFile = path.join(blocker, 'profiles.json');   // 把文件当目录用

  const logs = [];
  let bad = null;
  try {
    bad = new ProfileStore({
      file: badFile,
      seedFile: path.join(TMP, 'no-seed.json'),
      log: function (m) { logs.push(m); }
    });
    ok(true, '构造 ProfileStore 不抛异常（磁盘坏了也要能起来）');
  } catch (e) {
    ok(false, '构造 ProfileStore 不抛异常', e.message);
  }

  if (bad) {
    bad.record('bp1', '倒霉玩家', 3, 1700000000000, 'BR', 1, { playerCount: 2, endReason: 'handLimit' });
    ok(!!bad.data.get('bp1'), '（前置）档案在内存里正常建好了');

    let threw = null;
    try { bad.flush(); } catch (e) { threw = e; }
    eq(threw, null, '★ flush 不抛异常（失败只记一笔，不该炸调用方）');

    const syncFails = logs.filter(function (m) { return m.indexOf('落盘失败（sync）') >= 0; });
    eq(syncFails.length, 1, '★ 同步落盘失败记了 1 条日志');
    ok(syncFails.length > 0 && syncFails[0].indexOf(badFile) >= 0,
      '日志里带完整文件路径（运维才定位得到）');
    ok(syncFails.length > 0 && /E[A-Z]+/.test(syncFails[0]),
      '日志里带系统错误码（ENOTDIR / EACCES …）');
    eq(bad.dirty, true, '★ 失败后 dirty 仍为 true（下一轮还会重试，不能当成功）');

    /* 异步路径：500ms 定时器走的就是这一条 */
    bad.record('bp1', '倒霉玩家', 4, 1700000001000, 'BR', 2, { playerCount: 2, endReason: 'handLimit' });
    await bad._flushAsync().catch(function () {});
    const asyncFails = logs.filter(function (m) { return m.indexOf('落盘失败（async）') >= 0; });
    eq(asyncFails.length >= 1, true, '★ 异步落盘失败也记日志（定时器走这条）');
    eq(bad.dirty, true, '异步失败后同样保持 dirty');

    /* 进程没崩：能继续读内存里的数据 */
    eq(bad.data.size, 1, '内存里的档案还在（落盘失败不等于数据丢失）');
    ok(!!bad.achOf('bp1'), '还能正常读档案');
  }

  /* ---------- 序列化失败也要留痕 ---------- */
  console.log('\n[3] 序列化失败：同样不能静默');
  const serLogs = [];
  const ser = new ProfileStore({
    file: path.join(TMP, 'ok2', 'profiles.json'),
    seedFile: path.join(TMP, 'no-seed.json'),
    log: function (m) { serLogs.push(m); }
  });
  ser.record('sp1', '玩家', 1, 1700000000000, 'SR', 1, { playerCount: 2, endReason: 'handLimit' });
  /* 造一个循环引用，让 JSON.stringify 抛 TypeError */
  const loop = {}; loop.self = loop;
  ser.data.get('sp1')._loop = loop;
  ser.dirty = true;
  /* _flushAsync 在序列化失败时**提前 return**（返回 undefined，不是 Promise）——
   * 所以要先包一层 Promise.resolve 再 catch，否则测试自己会 TypeError。 */
  try { await Promise.resolve(ser._flushAsync()); } catch (e) { /* 期望失败 */ }
  const serFails = serLogs.filter(function (m) { return m.indexOf('落盘失败（serialize）') >= 0; });
  eq(serFails.length, 1, '★ 序列化失败记了 1 条（症状是「一直重试、一直没落盘」）');
  eq(ser.dirty, true, '序列化失败后保持 dirty');

  /* ================================================================
   * 汇总
   * ================================================================ */
  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 项通过，' + fail + ' 项失败');
  try { good.flush(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
