/**
 * 落盘的两个边界：dirty=false 仍然要写、写不进去要退让。
 * 跑法：node server/test/profile-flush.test.js
 *
 * 背景（线上真出现过、本地也复现过）：
 *
 *   1. `flush()` 以前开头是 `if (!this.dirty) return;`。
 *      dirty 的含义是「有改动还没**排队**」，不是「磁盘已经是最新的」——
 *      500ms 的定时路径会先清 dirty 再异步写。这个窗口里调 flush()，
 *      磁盘上还是上一版，而调用方以为刚同步落盘了。
 *      表现：`record → flush → new ProfileStore(同一文件)` 读回来是旧的/空的，
 *      而且是**偶发**（取决于那 500ms 有没有被机器负载挤出来），
 *      单跑复现不了，并发跑才红 —— ai-records / me-records / reset 都栽在这。
 *
 *   2. 原子写用 `fs.renameSync(tmp, target)`。Windows 上目标被索引器 / 杀软 /
 *      另一个编辑器碰一下就是 EBUSY，而 catch 只把 dirty 置回 true：
 *      下次还是同一条 rename，还是失败，于是**永远写不进去**，且没有任何报错。
 *      现在分三层退让（rename → copyFile → writeFile），本机就一直走第 2 层。
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const { ProfileStore } = require('../profile.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + a); }

let seq = 0;
function freshFile() {
  seq += 1;
  return path.join(os.tmpdir(), 'lxw-flush-' + process.pid + '-' + seq + '.json');
}
function rm(f) { try { fs.unlinkSync(f); } catch (e) { /* 忽略 */ } }

async function main() {
  console.log('\n[1] flush() 之后立刻读，必须是最新内容');
  {
    const file = freshFile();
    const s = new ProfileStore({ file: file, seedFile: null });
    s.record('u1', '甲', 5, 1700000000000, 'r1', 1);
    s.flush();
    ok(fs.existsSync(file), '文件已生成（写不进去的话这里就红）');
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok(!!disk.u1, '文件里有刚记的那一场');
    eq(disk.u1.games, 1, '场次写对了');

    const again = new ProfileStore({ file: file, seedFile: null });
    eq(again.getSelf('u1').games, 1, '新实例读同一个文件 → 数据还在');
    rm(file);
  }

  console.log('\n[2] ★ dirty=false 时 flush 不能直接返回');
  {
    const file = freshFile();
    const s = new ProfileStore({ file: file, seedFile: null });
    s.record('u2', '乙', 3, 1700000000000, 'r1', 1);
    s.flush();

    /* 直接改内存、不经过 record（故意不置 dirty），再 flush。
     * 旧实现在这里直接 return，磁盘上还是上一版 —— 而调用方以为写了。 */
    s.data.get('u2').nickname = '乙改名';
    s.dirty = false;
    s.flush();
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    eq(disk.u2.nickname, '乙改名', '★ dirty=false 也真的写盘了');
    rm(file);
  }

  console.log('\n[3] 异步写排队期间同步 flush，旧快照不能反过来覆盖');
  {
    const file = freshFile();
    const s = new ProfileStore({ file: file, seedFile: null });
    s.record('u3', '丙', 4, 1700000000000, 'r1', 1);

    /* 手动跑一次异步排队（不等 500ms 定时器，逻辑相同） */
    s.dirty = true;
    const p = s._flushAsync();
    s.record('u3', '丙', 6, 1700000002000, 'r2', 1);   // 队列在飞时又来一条
    s.flush();                                        // 同步写最新的一份
    await p;
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    eq(disk.u3.games, 2, '★ 旧快照没有把 flush 写进去的新内容盖掉');
    rm(file);
  }
}

main().then(() => {
  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('测试异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
