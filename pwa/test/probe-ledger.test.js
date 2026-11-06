/**
 * 探针台账守卫（v129）
 *
 * 守的是一句很容易说假的话：**「探针都在管」**。
 *
 * 起因：仓库里 37 个真浏览器探针，只有 1 个在 CI 里（probe-ui-flow）。
 * 剩下 36 个的处境没人说得清 —— 谁还绿、谁已过期、谁只是一次性脚本。
 * BACKLOG N18 就是这条：「其余探针的断言是否还反映当前规则，未逐条核」。
 *
 * 这一轮不再追求「全塞进 CI」（理由写在 docs/PROBES.md），而是把**归属**变成机检的：
 * 每条必须登记为 ci / manual / oneshot，登记为 ci 的必须真的在 workflow 里被执行。
 *
 * 这个文件的重点不是「真台账现在通过」（那只证明了一次），而是
 * **[2] 段：把每一条违规注入进去，校验必须报出来**。
 * 一条只验证"正常情况通过"的守卫，和没有守卫一样 —— 它从来没被证明过会红。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* 这里 require 的是台账工具本身。它不是探针（名字不以 probe- 开头），
 * 所以不会出现在 scripts 目录的探针扫描里 —— 这也是它改名的原因：
 * 第一版叫 probe-ledger.js，结果被自己的扫描规则判成「未登记的新探针」。 */
const L = require(path.join(__dirname, '..', '..', 'scripts', 'probes.js'));

let pass = 0, fail = 0;
function ok(c, m, extra) {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra !== undefined ? '  ← ' + extra : '')); }
}
function eq(a, b, m) { ok(a === b, m, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }
function head(t) { console.log('\n' + t); }

/** 在结果里找包含某个片段的错误 */
function has(list, frag) { return list.some((e) => String(e).indexOf(frag) >= 0); }

/* 一条合规的最小条目，作为注入违规的基底 */
function base(over) {
  return Object.assign({ file: 'probe-a.js', what: '守 A', run: 'manual', why: '因为需要真机', lastVerified: '' }, over || {});
}

/* =================== [1] 真台账 / 真磁盘 / 真 workflow =================== */
head('[1] 仓库里的真数据是一致的');
const manifest = L.loadManifest();
const disk = L.diskProbes();
const wf = L.workflowProbes();
const real = L.check({ probes: manifest.probes, disk, wf });
{
  eq(real.errors.length, 0, '★★ 真台账零错误（不一致的话下面几条的结论都不作数）', real.errors.join(' / '));
  ok(manifest.probes.length >= 30, '台账里有 ' + manifest.probes.length + ' 条（少于 30 说明清单被截断了）');
  eq(manifest.probes.length, disk.length, '台账条数 == scripts 目录里真实的探针文件数');

  /* 启动器不能出现在台账里：它要参数、自己不是检查项 */
  ok(disk.indexOf('probe-ci.js') < 0, '启动器 probe-ci.js 不算探针（否则会被要求写一条 what）');
  ok(fs.existsSync(path.join(__dirname, '..', '..', 'scripts', 'probe-ci.js')), '启动器本身还在（刚才那句不是因为它不存在才通过）');

  /* 每档都得有人，否则说明分类整体漂了 */
  const kinds = {};
  manifest.probes.forEach((p) => { kinds[p.run] = (kinds[p.run] || 0) + 1; });
  ok((kinds.ci || 0) >= 1, 'ci 档有 ' + (kinds.ci || 0) + ' 条');
  ok((kinds.manual || 0) >= 1, 'manual 档有 ' + (kinds.manual || 0) + ' 条');
  ok((kinds.oneshot || 0) >= 1, 'oneshot 档有 ' + (kinds.oneshot || 0) + ' 条');
  eq(Object.keys(kinds).sort().join(','), 'ci,manual,oneshot', '只出现了三档里的值');

  /* 真 workflow：必须能解析出至少一条，且必须是 ui-flow */
  ok(Object.keys(wf).length >= 1, 'workflow 里解析出 ' + Object.keys(wf).length + ' 个被执行的探针');
  ok(!!wf['probe-ui-flow.js'], '★ probe-ui-flow 确实在 workflow 里被调用（不是只在注释里被提到）');
}

/* =================== [2] 每一条校验规则都要真的会红 =================== */
head('[2] 注入违规 —— 每一条规则都必须被抓到');
{
  /* ① 新增探针没登记 */
  const r1 = L.check({ probes: [base()], disk: ['probe-a.js', 'probe-new.js'], wf: {} });
  ok(has(r1.errors, 'probe-new.js') && has(r1.errors, '磁盘上存在但台账里没有'),
    '① 新增探针没登记 → 报「磁盘上存在但台账里没有」', r1.errors.join(' / '));

  /* ② 幽灵条目 */
  const r2 = L.check({ probes: [base({ file: 'probe-gone.js' })], disk: [], wf: {} });
  ok(has(r2.errors, '幽灵条目'), '② 台账里有、磁盘上没有 → 报「幽灵条目」', r2.errors.join(' / '));

  /* ③ 登记 ci 但没人跑 */
  const r3 = L.check({ probes: [base({ run: 'ci' })], disk: ['probe-a.js'], wf: {} });
  ok(has(r3.errors, '没有一行真的执行它'),
    '③ 登记为 ci 但 workflow 里没有 → 报「没有一行真的执行它」', r3.errors.join(' / '));

  /* ④ CI 在跑但台账没认 */
  const r4 = L.check({ probes: [base({ run: 'manual' })], disk: ['probe-a.js'], wf: { 'probe-a.js': ['test.yml'] } });
  ok(has(r4.errors, '台账漏报'), '④ CI 真在跑但写的是 manual → 报「台账漏报」', r4.errors.join(' / '));

  /* ⑤ manual / oneshot 没写 why */
  const r5 = L.check({ probes: [base({ why: '   ' })], disk: ['probe-a.js'], wf: {} });
  ok(has(r5.errors, '必须写 why'), '⑤ manual 没写 why → 报「必须写 why」', r5.errors.join(' / '));
  const r5b = L.check({ probes: [base({ run: 'oneshot', why: '' })], disk: ['probe-a.js'], wf: {} });
  ok(has(r5b.errors, '必须写 why'), '⑤b oneshot 没写 why 也一样报');

  /* ⑥ run 取值拼错 */
  const r6 = L.check({ probes: [base({ run: 'C I' })], disk: ['probe-a.js'], wf: {} });
  ok(has(r6.errors, '只能是 ci / manual / oneshot'),
    '⑥ run 拼错一个词 → 报取值非法（拼错不该绕过上面所有判断）', r6.errors.join(' / '));

  /* ⑦ what 为空 */
  const r7 = L.check({ probes: [base({ what: null })], disk: ['probe-a.js'], wf: {} });
  ok(has(r7.errors, 'what 是空的'), '⑦ what 为空 → 报「what 是空的」', r7.errors.join(' / '));

  /* ⑧ 重复登记 */
  const r8 = L.check({ probes: [base(), base()], disk: ['probe-a.js'], wf: {} });
  ok(has(r8.errors, '重复登记'), '⑧ 同一条登记两次 → 报「重复登记」', r8.errors.join(' / '));

  /* ⑨ workflow 在跑但台账完全没有这一条 */
  const r9 = L.check({ probes: [base()], disk: ['probe-a.js', 'probe-x.js'], wf: { 'probe-x.js': ['test.yml'] } });
  ok(has(r9.errors, 'workflow 在跑它，台账里却没有'),
    '⑨ workflow 跑着一条台账里没有的探针 → 报出来', r9.errors.join(' / '));

  /* ⑩ 完全合规的一组必须零错误 —— 否则上面九条可能只是「什么都说错」 */
  const r10 = L.check({ probes: [base(), base({ file: 'probe-b.js', run: 'ci', why: '' })],
    disk: ['probe-a.js', 'probe-b.js'], wf: { 'probe-b.js': ['test.yml'] } });
  eq(r10.errors.length, 0, '⑩ 合规的一组零错误（证明上面九条不是因为「一律报错」通过）', r10.errors.join(' / '));
}

/* =================== [3] 注释不算「被执行」 =================== */
head('[3] workflow 的注释行不算「真的在跑」');
{
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lxw-wf-'));
  try {
    fs.writeFileSync(path.join(tmp, 'a.yml'),
      'jobs:\n'
      + '  # node scripts/probe-commented.js  ← 这行是注释，不代表在跑\n'
      + '  steps:\n'
      + '    - run: node scripts/probe-real.js\n'
      + '    # 下面这句也带 probe-：node scripts/probe-also-commented.js\n', 'utf8');
    const got = L.workflowProbes(tmp);
    ok(!!got['probe-real.js'], '真的被执行的那条被解析出来了');
    ok(!got['probe-commented.js'], '★ 注释里出现的探针不算被执行（否则「登记 ci 但没人跑」永远绿）');
    ok(!got['probe-also-commented.js'], '★ 行尾带 # 的注释也一样不算');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* 这条守的是上面那个排除不是"因为压根没解析" */
  const tmp2 = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lxw-wf2-'));
  try {
    fs.writeFileSync(path.join(tmp2, 'b.yml'), 'run: node scripts/probe-ci.js scripts/probe-target.js\n', 'utf8');
    const got2 = L.workflowProbes(tmp2);
    ok(!!got2['probe-target.js'], '★ 通过启动器跑的探针（probe-ci.js 的参数位）也算被执行');
    ok(!got2['probe-ci.js'], '启动器自己不算（它是跑别人的那个）');
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
}

/* =================== [4] 生成的文档不能和台账分叉 =================== */
head('[4] docs/PROBES.md 与台账一致');
{
  const docPath = path.join(__dirname, '..', '..', 'docs', 'PROBES.md');
  ok(fs.existsSync(docPath), 'docs/PROBES.md 存在');
  const onDisk = fs.readFileSync(docPath, 'utf8');
  const expect = L.render(manifest, { run: L.readRunNote() });
  /* 逐字比对：文档是生成的。手改文档（或改了台账忘了重生成）都会红 ——
   * 这是「文档与代码分叉」这类问题唯一挡得住的地方。 */
  eq(onDisk.trim() === expect.trim(), true,
    '★ 文档内容 == 用当前台账重新生成的内容（改台账后要跑 --write）',
    firstDiff(onDisk, expect));

  /* 台账里每一条都要在文档里出现一次 —— 防止渲染时漏行 */
  const missing = manifest.probes.filter((p) => onDisk.indexOf('`' + p.file + '`') < 0);
  eq(missing.length, 0, '每个探针都在文档表格里出现', missing.map((p) => p.file).join(','));
}

/** 给出第一处差异的位置，否则只说"不一致"等于没说 */
function firstDiff(a, b) {
  const la = a.split(/\r?\n/), lb = b.split(/\r?\n/);
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      return '第 ' + (i + 1) + ' 行：文件=' + JSON.stringify((la[i] || '').slice(0, 60))
        + ' 期望=' + JSON.stringify((lb[i] || '').slice(0, 60));
    }
  }
  return '行数一致但没有逐字差异？';
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
