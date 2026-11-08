#!/usr/bin/env node
/**
 * 探针台账校验 / 生成器（v129）
 *
 * 解决的问题：仓库里有一批真浏览器探针，起初**只有 1 个在 CI 里**（probe-ui-flow），
 * 其余的处境是：不知道谁还在绿、不知道谁已经过期、也不知道谁是一次性的。
 * 条数会随台账增长，**不在注释里写死** —— 当前值一律以 scripts/probes.json 为准。
 * BACKLOG N18 就是这么一条挂了很久的债 ——「其余探针的断言是否还反映当前规则，未逐条核」。
 *
 * 这一轮不再指望「把所有探针都塞进 CI」（理由见 docs/PROBES.md），而是先把
 * **归属**这件事变成可机检的：每个探针必须被登记为三档之一（ci / manual / oneshot），
 * 且登记为 ci 的必须真的在 workflow 里被调用。
 *
 * 校验的六条，每一条都对着一个真实的失效模式：
 *   ① 新增探针没登记        → 它会悄悄变成第二个 N18
 *   ② 登记了但文件没了      → 台账变谎话，读的人会按它去找脚本
 *   ③ 登记 ci 但没人跑      → 「在 CI 里」这句话本身是假的
 *   ④ CI 在跑但没登记 ci    → 台账漏报，等于没有台账
 *   ⑤ manual / oneshot 没写 why → 半年后没人知道为什么留着
 *   ⑥ run 取值不在三档内    → 拼错一个词就绕过上面所有判断
 *
 * 用法：
 *   node scripts/probes.js            # 打印汇总
 *   node scripts/probes.js --check    # 只校验，有问题退出码 1（挂在 npm test 里）
 *   node scripts/probes.js --write     # 重新生成 docs/PROBES.md
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_FILE = path.join(__dirname, 'probes.json');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const DOC_FILE = path.join(ROOT, 'docs', 'PROBES.md');

/* 三档的唯一真源。名字改了要同步 docs 与 manifest 里的值。 */
const RUN_KINDS = {
  ci: '进 CI（每次 push 都跑）',
  manual: '手工（发版前跑一次）',
  oneshot: '一次性（保留作复现脚本，不排期）'
};

/* probe-ci.js 是启动器，不是探针：它自己需要参数，永远不该出现在台账里。
 * 少了这一句，校验会要求给启动器也写一条 what —— 而那是没有内容的。 */
const NOT_A_PROBE = ['probe-ci.js'];

function loadManifest(file) {
  const raw = fs.readFileSync(file || MANIFEST_FILE, 'utf8');
  const json = JSON.parse(raw);
  return { version: json.version || '', probes: json.probes || [] };
}

/** 磁盘上真实存在的探针文件（不含启动器） */
function diskProbes(dir) {
  return fs.readdirSync(dir || __dirname)
    .filter((f) => /^probe-.*\.js$/.test(f))
    .filter((f) => NOT_A_PROBE.indexOf(f) < 0)
    .sort();
}

/**
 * workflow 里**真的被执行的**探针。
 *
 * 为什么不能只做 substring 匹配：`# probe-xxx.js 已废弃` 这种注释也会命中，
 * 于是「登记 ci 但没人跑」这条校验就永远绿 —— 一条因为实现方式而失明的守卫
 * 比没有守卫更糟（它给的是"全绿"）。
 * 所以：先按行过滤掉注释行（yaml 的 # 开头的行），再从中找 `probe-*.js`。
 */
function workflowProbes(dir) {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(dir || WF_DIR).filter((f) => /\.ya?ml$/.test(f)); } catch (e) { return out; }
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir || WF_DIR, f), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;              // 注释行不算
      const re = /probe-[a-z0-9-]+\.js/g;
      let m;
      while ((m = re.exec(line))) {
        if (NOT_A_PROBE.indexOf(m[0]) >= 0) continue; // 启动器不算「被跑的探针」
        (out[m[0]] = out[m[0]] || []).push(f);
      }
    }
  }
  return out;
}

/**
 * 校验。参数全部可注入，测试里直接喂假数据 —— 免得为了测一条规则
 * 去改真文件（改真文件跑测试，是这个仓库早就吃过亏的路子）。
 */
function check(input) {
  const probes = input.probes || [];
  const disk = input.disk || [];
  const wf = input.wf || {};
  const errors = [];
  const warnings = [];

  const seen = Object.create(null);
  for (const p of probes) {
    const f = p && p.file;
    if (!f) { errors.push('有一条没有 file 字段'); continue; }
    if (seen[f]) errors.push('重复登记：' + f);
    seen[f] = 1;

    if (RUN_KINDS[p.run] === undefined) {
      errors.push(f + '：run 取值 ' + JSON.stringify(p.run) + '，只能是 ci / manual / oneshot');
    }
    if (!String(p.what || '').trim()) errors.push(f + '：what 是空的（「守什么」没写，等于没登记）');

    const inWf = !!wf[f];
    if (p.run === 'ci' && !inWf) {
      errors.push(f + '：登记为 ci，但 .github/workflows 里没有一行真的执行它');
    }
    if (p.run !== 'ci' && inWf) {
      errors.push(f + '：CI 真的在跑它（' + wf[f].join(',') + '），但台账写的是 ' + p.run + ' —— 台账漏报');
    }
    if (p.run !== 'ci' && !String(p.why || '').trim()) {
      errors.push(f + '：' + p.run + ' 必须写 why（半年后要能回答「这个为什么还留着」）');
    }
    /* ★ v130：manual 档必须有执行链。
     * 以前它只要求写 why —— 也就是说 17 条探针的唯一保障是「发版前记得跑」。
     * 本轮已实证那条链会腐坏（3 条红的原因写错、1 条「绿」其实是崩的）。
     * 豁免必须**显式**写：默认豁免等于没有规则。
     * `wfManual` 为 undefined 表示「调用方没告诉我」，此时跳过这条（老调用点不炸）。 */
    if (p.run === 'manual' && input.wfManual === false && !String(p.nightlyExempt || '').trim()) {
      errors.push(f + '：manual 档没有夜间执行链，也没写 nightlyExempt 理由');
    }
    if (p.run === 'manual' && String(p.nightlyExempt || '').length > 120) {
      warnings.push(f + '：nightlyExempt 理由超过 120 字');
    }
    if (p.run !== 'ci' && String(p.why || '').length > 120) {
      warnings.push(f + '：why 有 ' + String(p.why).length + ' 字，超过 120 —— 说明理由里塞了别的信息');
    }
  }

  for (const f of disk) {
    if (!seen[f]) errors.push(f + '：磁盘上存在但台账里没有（新探针必须先登记，否则它就是下一个 N18）');
  }
  for (const f of Object.keys(seen)) {
    if (disk.indexOf(f) < 0) errors.push(f + '：台账里有，磁盘上没有（幽灵条目）');
  }
  for (const f of Object.keys(wf)) {
    if (!seen[f]) errors.push(f + '：workflow 在跑它，台账里却没有 —— 这一步没人管');
  }

  /* 只告警不失败：这些是会积累但不该拦住合入的东西。
   * 「一次都没核过」不是错误 —— 老探针本来就没人逐条核，把它判红只会逼人补一个假版本号。 */
  const never = probes.filter((p) => !String(p.lastVerified || '').trim());
  if (never.length) warnings.push(never.length + ' 条从没记录过「最近一次确认是绿的」（可以接受，但别再加）');
  const oneshot = probes.filter((p) => p.run === 'oneshot');
  if (oneshot.length >= 15) warnings.push('一次性脚本 ' + oneshot.length + ' 条 —— 建议每季度问一次「还留吗」');

  return { errors, warnings };
}

/** 生成 docs/PROBES.md。手写文档必然会和代码分叉，所以只生成、不手改。 */
function render(manifest, extra) {
  const probes = manifest.probes || [];
  const counts = { ci: 0, manual: 0, oneshot: 0 };
  probes.forEach((p) => { counts[p.run] = (counts[p.run] || 0) + 1; });
  const total = probes.length;
  const lines = [];
  const P = (s) => lines.push(s === undefined ? '' : s);

  P('# 探针台账');
  P();
  P('> **这份文件是生成的，不要手改。** 真源是 [`scripts/probes.json`](../scripts/probes.json)，');
  P('> 改完跑 `node scripts/probes.js --write` 重生成；`npm test` 会校验两边是否一致。');
  P('>');
  P('> 生成于版本 `' + (manifest.version || '?') + '`，共 ' + total + ' 个探针。');
  P();
  P('## 为什么不是「全部塞进 CI」');
  P();
  P(total + ' 个探针里只有 ' + counts.ci + ' 个在 CI 里。这个差距看着像欠账，但直接补齐是错的：');
  P();
  P('| 理由 | 具体数字 |');
  P('|---|---|');
  P('| **大量重叠** | `probe-ui-flow` 已经在 12 个视口 × 13 屏上量过布局，`journey` 走完整条玩家路径（158 项）。`probe-devices` / `probe-table` / `probe-room-actions` / `probe-landscape*` / `probe-type-scale` 量的是同一批东西 |');
  P('| **一次性脚本** | ' + counts.oneshot + ' 条的文件头自己就写着「一次性诊断脚本」。它们的价值是**当时怎么查的**，不是回归网 |');
  P('| **反馈时间** | 全量串行跑一轮是**分钟级到二十几分钟**（每个探针都要起服务端 + 浏览器）。CI 的 ui-probe 现在每片约 5 分钟；推到 20 分钟以上的直接后果不是更安全，是**没人看** |');
  P('| **测不准** | 安全区（`probe-safearea`）、旧内核 flex gap（`probe-flex-gap`）、PWA 全屏贴合（`probe-viewport-fit`）在 CI 的 Linux + 桌面 Chrome 上恒为同一结果，跑一万次也不会红 |');
  P();
  P('所以真正的判据不是「进没进 CI」，而是**「有没有人知道它现在还绿不绿」**。');
  P('这份台账就是回答这句话的：每条都有归属，`ci` 的由 CI 保证，`manual` 的由发版前那一遍保证，');
  P('`oneshot` 的明确承认不保证。**被承认的不保证，好过假装都在管。**');
  P();
  P('### 什么情况下应该把一条 manual 收编进 CI');
  P();
  P('三个条件同时成立才收编，缺一条都会让 CI 变慢而不变可靠：');
  P();
  P('1. 它守的东西**单测和 journey / ui-flow 都覆盖不到**；');
  P('2. 它自己**稳定**（连跑 3 次不红、断言项数不变）；');
  P('3. 单次运行 **≤ 60 秒**。');
  P();
  P('`probe-tenhalf` 就是被第 2 条挡住的例子：连跑时出现过一次 35 项 4 红，');
  P('两次重跑都是 39 项 0 红。不可复现的红进了 CI，只会教人学会忽略红色。');
  P();
  P('## 归属分布');
  P();
  P('| 档 | 条数 | 谁保证它绿 |');
  P('|---|---:|---|');
  P('| `ci` | ' + counts.ci + ' | 每次 push 的 GitHub Actions |');
  P('| `manual` | ' + counts.manual + ' | 发版前 `node scripts/run-probes.js`（全量串行；耗时随条数变，不在此写死） |');
  P('| `oneshot` | ' + counts.oneshot + ' | 没人保证。留着是为了能复现当时的现场 |');
  P();
  P('## 全部探针');
  P();
  P('| 探针 | 守什么 | 档 | 最近确认绿 | 备注 |');
  P('|---|---|---|---|---|');
  for (const p of probes) {
    P('| `' + p.file + '` | ' + oneLine(p.what) + ' | ' + p.run + ' | '
      + (String(p.lastVerified || '').trim() || '—') + ' | ' + oneLine(p.why || '') + ' |');
  }
  P();
  if (extra && extra.run) {
    P('## 全量实跑记录');
    P();
    P(extra.run);
    P();
  }
  P('## 怎么跑');
  P();
  P('```bash');
  P('node scripts/run-probes.js                 # 全量（串行，约 20 分钟）');
  P('node scripts/run-probes.js tenhalf leave   # 只跑名字含 tenhalf / leave 的');
  P('node scripts/run-probes.js --list          # 只列清单');
  P('node scripts/probes.js --check       # 校验台账与磁盘 / workflow 是否一致');
  P('```');
  P();
  P('**不要并行跑两个探针**：它们各自起一个 HTTP 服务（端口写在脚本里）和一个 CDP 连接，');
  P('撞上端口后的症状是「昵称已经被别人用了」这种误导性失败 —— 看起来像功能坏了，其实是自己踩了自己。');
  P();
  return lines.join('\n');
}

/** 表格单元格里不能有竖线与换行 */
function oneLine(s) {
  return String(s == null ? '' : s).replace(/\|/g, '／').replace(/\r?\n/g, ' ');
}

/** 夜间 workflow 是否存在且真的跑 `--manual`（只看非注释行） */
function manualWorkflowOk() {
  let files = [];
  try { files = fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)); } catch (e) { return false; }
  let ok = false;
  for (const f of files) {
    const text = fs.readFileSync(path.join(WF_DIR, f), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      if (/run-probes\.js\s+--manual/.test(line)) ok = true;
    }
  }
  return ok;
}

function main() {
  const args = process.argv.slice(2);
  const manifest = loadManifest();
  const disk = diskProbes();
  const wf = workflowProbes();
  const wfManual = manualWorkflowOk();
  /* 传 wfManual 让「manual 有没有执行链」这条生效；传不到就等于没这条规则 */
  const res = check({ probes: manifest.probes, disk, wf, wfManual });

  if (args.indexOf('--list-manual') >= 0) {
    manifest.probes.filter((x) => x.run === 'manual').forEach((x) => console.log(x.file));
    return;
  }

  if (args.indexOf('--write') >= 0) {
    const extra = { run: readRunNote() };
    fs.writeFileSync(DOC_FILE, render(manifest, extra), 'utf8');
    console.log('已生成 ' + path.relative(ROOT, DOC_FILE) + '（' + manifest.probes.length + ' 条）');
  }

  if (args.indexOf('--check') >= 0) {
    res.errors.forEach((e) => console.error('  ✗ ' + e));
    res.warnings.forEach((w) => console.warn('  ! ' + w));
    if (res.errors.length) {
      console.error('\n台账校验失败：' + res.errors.length + ' 条');
      process.exit(1);
    }
    console.log('台账校验通过：' + manifest.probes.length + ' 条，磁盘 ' + disk.length
      + ' 个探针，CI 里跑 ' + Object.keys(wf).length + ' 个'
      + '，夜间跑 manual ' + (wfManual ? '是' : '否'));
    return;
  }

  const counts = { ci: 0, manual: 0, oneshot: 0 };
  manifest.probes.forEach((p) => { counts[p.run] = (counts[p.run] || 0) + 1; });
  console.log('探针台账 ' + manifest.probes.length + ' 条');
  Object.keys(RUN_KINDS).forEach((k) => console.log('  ' + (k + '     ').slice(0, 8) + counts[k] + ' 条  ' + RUN_KINDS[k]));
  console.log('\nCI 里真的在跑的：' + (Object.keys(wf).join(', ') || '（无）'));
  console.log('夜间 manual 执行链：' + (manualWorkflowOk() ? '有' : '没有'));
  res.errors.forEach((e) => console.error('  ✗ ' + e));
  res.warnings.forEach((w) => console.warn('  ! ' + w));
  if (res.errors.length) process.exit(1);
}

/** 全量实跑记录的正文：只有真的跑过才写进文档 */
function readRunNote() {
  const f = path.join(__dirname, '..', 'docs', 'probes-last-run.txt');
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    return t || '';
  } catch (e) { return ''; }
}

if (require.main === module) main();

module.exports = {
  loadManifest, diskProbes, workflowProbes, check, render, readRunNote,
  RUN_KINDS, NOT_A_PROBE, oneLine, MANIFEST_FILE, DOC_FILE, WF_DIR
};
