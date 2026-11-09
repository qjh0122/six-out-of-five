/**
 * CI 覆盖守卫（v128）
 *
 * 守的是一句很容易在半年后失效的话：**探针支持的每一个视口，CI 都在跑。**
 *
 * 为什么需要：v110 起 CI 只跑 390×844 / 844×390 两档，而探针一直支持 12 档。
 * 那 10 档「一直都在那儿」，只是没人跑 —— 于是最窄的 360×640 从来没被检查过。
 * v128 第一次跑它就撞上 6 条告警（其中一条还是 v123 刚加的「等人」按钮）。
 *
 * 更坏的情况还没发生：如果哪天有人往 VIEWPORTS 里加第 13 档，
 * 却忘了往 matrix 里加，探针会一直"支持"它、CI 永远不跑它 ——
 * 这种漏法没有任何症状，只能靠断言钉住。
 *
 * 这里**故意解析源码文本**而不是 require：
 *   · probe-ui-flow.js 是个顶层就跑的脚本，require 会真的去开浏览器；
 *   · workflow 本来就不是 JS。
 * 解析错的风险由「数量下限」和「逐档比对」一起兜住：
 * 解析不出来时断言会红，不会静默通过。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
function ok(c, m, extra) {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra !== undefined ? '  ← ' + extra : '')); }
}
function eq(a, b, m) { ok(a === b, m, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }
function head(t) { console.log('\n' + t); }

const probe = fs.readFileSync(path.join(ROOT, 'scripts', 'probe-ui-flow.js'), 'utf8');
const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');

/* ---- 探针支持的视口 ---- */
head('[1] 探针支持的视口清单');
const viewports = [];
{
  const block = (probe.match(/const VIEWPORTS = \[([\s\S]*?)\n\];/) || [])[1] || '';
  const re = /\{\s*g:\s*'([^']+)',\s*m:\s*'([^']+)',\s*w:\s*(\d+),\s*h:\s*(\d+)\s*\}/g;
  let m;
  while ((m = re.exec(block))) viewports.push({ g: m[1], m: m[2], w: Number(m[3]), h: Number(m[4]), key: m[3] + 'x' + m[4] });
  ok(viewports.length >= 12, '取到 ' + viewports.length + ' 个视口（少于 12 说明解析坏了或真的被删了）');
  eq(new Set(viewports.map((v) => v.key)).size, viewports.length, '没有重复的宽高组合');
}

/* ---- CI 里真正会跑的档位 ---- */
head('[2] CI matrix 里配置的档位');
const shards = [];
{
  /* ui-probe 的 matrix.include 里每条都有一个 only: '...' */
  const job = (ci.match(/\n  ui-probe:([\s\S]*?)\n  [a-z-]+:\s*\n/) || ci.match(/\n  ui-probe:([\s\S]*)$/) || [])[1] || '';
  ok(job.length > 200, '找到了 ui-probe 这个 job（' + job.length + ' 字符）');

  const re = /only:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(job))) {
    shards.push(m[1].split(',').map((s) => s.trim()).filter(Boolean));
  }
  ok(shards.length >= 3, '配置了 ' + shards.length + ' 个分片');
}

const scheduled = shards.reduce((a, b) => a.concat(b), []);
{
  const dup = scheduled.filter((k, i) => scheduled.indexOf(k) !== i);
  eq(dup.length, 0, '同一个档位没有被两个分片重复配置', dup.join(','));

  /* ★ R5：320×568 是**独立分片**（只有 1 档），分片大小天然不均匀。
   * 旧的「max - min <= 1」守的是墙钟时间，会把正确接线直接判红 —— 它已经不适用了。
   * 真正要守的是「每片自检的期望数取自**本片** ONLY」，而不是抄一个 4。
   * 这条与 [4] 的自检表达式一起构成「按分片期望数取」的一致性守卫。 */
  const sizes = shards.map((s) => s.length);
  const sum = sizes.reduce((a, b) => a + b, 0);
  eq(sum, viewports.length,
    '★★ 各分片档数之和 == 探针支持档数（' + sizes.join('+') + '=' + sum + '，不多不少）',
    'supported=' + viewports.length);
  ok(shards.every((s) => s.length >= 1), '★ 每个分片至少 1 档（没有空片）');
  eq(shards.length, 4, '★ iOS / 安卓 / 电脑 / 320 最小档，共 4 片');
}

/* ---- 两边必须一一对应 ---- */
head('[3] 支持的每一档，CI 都真的在跑');
{
  const supported = viewports.map((v) => v.key);
  const missing = supported.filter((k) => scheduled.indexOf(k) < 0);
  eq(missing.length, 0,
    '★★ 探针支持的 ' + supported.length + ' 档，CI 全都在跑',
    missing.map((k) => {
      const v = viewports.find((x) => x.key === k);
      return v.g + v.m;
    }).join(' / '));

  const extra = scheduled.filter((k) => supported.indexOf(k) < 0);
  eq(extra.length, 0,
    '★ CI 里没有配置"探针不认识"的档位（配错会零匹配退出，看起来像跑过了）',
    extra.join(','));
}

head('[4] 每个分片都自带"真的跑了 N 档"的自检');
{
  const job = (ci.match(/\n  ui-probe:([\s\S]*?)\n  [a-z-]+:\s*\n/) || ci.match(/\n  ui-probe:([\s\S]*)$/) || [])[1] || '';
  /* 这一条守的是「ONLY 拼错但恰好匹配到 0 档」：
   * probe 会以 exit 2 退出，但如果哪天有人把它改成"零匹配也算过"，
   * 分片就会静默跑 0 档。自检那段断言数字必须还在。 */
  ok(/本轮视口 \(d\+\) 个/.test(job.replace(/\\/g, '')) || /本轮视口/.test(job),
    '★ 分片里有「本轮视口」的解析（真的跑了才算过）');
  /* ★ R5 核心：期望数按**本片** ONLY 的档数取，不再写死 4。
   * 留着 n !== 4 的话，320 那一片（1 档）会立刻 exit 3 假红（M7 要证伪的正是它）。 */
  ok(/ONLY\.split\(','\)/.test(job), '★★ 自检期望数取自本片 ONLY.split(",")（按分片期望数取）');
  ok(!/n !== 4/.test(job), '★★ 旧的 n !== 4 写死断言已删除');
  ok(/process\.exit\(3\)/.test(job), '★ 少跑时会 exit 3，不是静默通过');
  ok(/::error::/.test(job) && /分片应跑/.test(job),
    '★ 少跑的时候会报 ::error:: 并说明应跑几档，不是静默通过');
}

head('[4b] 320×568 真的挂进了 CI（AC-NB-23 / AC-NB-24 核到调用点）');
{
  /* 除「退出码 == 0」外，还要核到 workflow 的哪个 run: 块真的调用了探针。
   * 只加 VIEWPORTS 一行而没挂探针 = 新档从没被真跑过（R5 四步同改的第 3 步）。 */
  ok(/probe-numbers\.js 320 568/.test(ci) || /probe-numbers\.js\s+320\s+568/.test(ci),
    '★★ CI 里真有 `node scripts/probe-ci.js scripts/probe-numbers.js 320 568` 调用');
  ok(/probe-ci\.js scripts\/probe-numbers\.js 320 568/.test(ci),
    '★★ 调用点走 probe-ci.js 启动器（参数原样转发到 W/H）');
  ok(/only:\s*'320x568'/.test(ci), "★★ matrix.include 有半角 x 的独立分片 '320x568'");
  /* 半角 x 归一：全角 × 经 YAML→env→Node 会被改坏，曾「安静跑 0 档然后通过」 */
  ok(!/only:\s*'[^']*×/.test(ci), '★ only 值里没有全角 ×（M7 负向）');
  ok(/320×568/.test(probe), '★ 探针 VIEWPORTS 里确实有 320×568 这一档');
}

/* ---- 顺带守一件事：ONLY 的多值语法 ---- */
head('[5] ONLY 支持逗号分隔（分片靠它）');
{
  ok(/ONLY\.split\(','\)/.test(probe), '★ 探针按逗号切分 ONLY');
  ok(/onlyParts\.some/.test(probe), '★ 任一片段命中即选中');
  /* 单值仍然要能用：人工排查时天天在用 */
  ok(/if \(!onlyParts\.length\) return true;/.test(probe), '★ 不传 ONLY 就是全跑');
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
