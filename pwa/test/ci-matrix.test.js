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

  /* 分片大小要均匀：一个 8 档的分片会让整轮 CI 的墙钟时间等于它自己 */
  const sizes = shards.map((s) => s.length);
  ok(Math.max.apply(null, sizes) - Math.min.apply(null, sizes) <= 1,
    '分片大小均匀（' + sizes.join(' / ') + '）', '差 ' + (Math.max.apply(null, sizes) - Math.min.apply(null, sizes)));
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
  ok(/n !== 4/.test(job), '★ 断言每片恰好 4 档（数字写死，改分片必须同步改这里）');
  ok(/分片应跑 4 档/.test(job), '★ 少跑的时候会报 ::error::，不是静默通过');
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
