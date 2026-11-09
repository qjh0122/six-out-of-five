/**
 * 探针不许直读「老」存储键（v130）
 *
 * 为什么需要这一条守卫：
 *   v111 把 16 个物理键收口进 `storage.js`，老的 `weile_*` 键改名成 `lxw_*_v1`。
 *   **产品侧写了 `migrate()` 把旧键搬过来，自己的测试也覆盖了 —— 但「外部读取方」
 *   （`scripts/` 下的探针）没跟上**，它们还在 `localStorage.getItem('weile_rooms')`。
 *   结果：三个探针静默烂掉，而 `npm test` 全绿、CI 全绿。
 *
 * 更贵的是它导致了一次误诊：v129 的台账把这三条红的根因写成「建房两步 / 文案改口径」，
 * 下一轮要是按那个原因去修，会去改一个早就修好的步骤。
 *
 * 判据（可以机检的两句话）：
 *   ① `scripts/**` 里任何 `localStorage.getItem('字面量')` 这类调用，字面量必须是
 *      `storage.js` 里 `KEYS` 的**值**之一（产品当前的键）；
 *   ② `LEGACY.from` 里的老键**不算合法** —— 那五个只允许出现在 `storage.js` 的 `migrate()` 里。
 *      探针读老键就是「读一个已经没人写的抽屉」。
 *   ③ 谁都不认识的键也算违规 —— 拼错一个字母就是这个形状。
 *
 * 为什么不干脆禁掉所有字面量：`scripts/` 下有 40 多处存储调用，绝大多数写的是当前键，
 * 一次全改风险远大于收益。这条守卫只钉「老键 / 错键」，那才是有过事故的那一类。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');

let pass = 0, fail = 0;
function ok(c, m, extra) {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra !== undefined ? '  ← ' + extra : '')); }
}
function eq(a, b, m, extra) { ok(a === b, m, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + (extra ? '  |  ' + extra : '')); }
function head(t) { console.log('\n' + t); }

/* ---- 从源头取两份清单，不复制字面量 ---- */
const Store = require(path.join(ROOT, 'pwa', 'js', 'storage.js'));
const storageSrc = fs.readFileSync(path.join(ROOT, 'pwa', 'js', 'storage.js'), 'utf8');

const CURRENT = new Set(Object.keys(Store.KEYS).map((k) => Store.KEYS[k]));

/* 后台（`pwa/admin.html`）有自己的一组键：它管的是「管理密钥 / 账号密码 / 页签」，
 * 不属于游戏存档，所以不进 `storage.js` 的 KEYS。
 * 这里**从页面源码里取**，不在这里再抄一份字面量 —— 抄一份就是又造了一个会漂移的真源，
 * 而这条守卫存在的理由正是「清单和实际用法漂移了，没人发现」。 */
{
  const adminSrc = fs.readFileSync(path.join(ROOT, 'pwa', 'admin.html'), 'utf8');
  for (const name of ['KEY_STORE', 'PW_STORE', 'TAB_STORE']) {
    const m = new RegExp('var ' + name + " = '([^']+)'").exec(adminSrc);
    if (m) CURRENT.add(m[1]);
  }
}
/* LEGACY 没导出，从源码里读 `{ from: 'weile_xxx', to: ... }`。
 * 读不到就红 —— 「解析不出来」不能静默当成「没有老键」。 */
const LEGACY = new Set();
{
  const re = /\{\s*from:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(storageSrc))) LEGACY.add(m[1]);
}

/** 分类一个键字面量：'current' | 'legacy' | 'unknown' */
function classify(lit) {
  if (CURRENT.has(lit)) return 'current';
  if (LEGACY.has(lit)) return 'legacy';
  return 'unknown';
}

/**
 * 从源码里找「存储访问 + 字符串字面量」。
 * 只认 getItem/setItem/removeItem 的第一个实参是字面量的形态；
 * 变量、模板串、表达式一律放过（那是合法的间接访问）。
 */
function scanLiterals(src) {
  const out = [];
  const re = /(?:localStorage|sessionStorage)\.(getItem|setItem|removeItem)\s*\(\s*(['"])([^'"`$]+)\2/g;
  let m;
  while ((m = re.exec(src))) out.push({ api: m[1], key: m[3] });
  return out;
}

/* =================== [1] 源头清单读得出来 =================== */
head('[1] 两份清单本身');
{
  ok(CURRENT.size >= 15, 'KEYS 取到 ' + CURRENT.size + ' 个当前键');
  ok(LEGACY.size >= 4, 'LEGACY 取到 ' + LEGACY.size + ' 个老键（读不到就说明解析坏了）');
  /* 两个集合不能有交集：一个键既是当前键又是老键，说明收口没收干净 */
  const both = [...CURRENT].filter((k) => LEGACY.has(k));
  eq(both.length, 0, '没有键同时属于「当前」和「老」', both.join(','));
  /* 老键必须真的是 weile_ 开头 —— 这条防的是「以后有人拿这条守卫当摆设」 */
  const weird = [...LEGACY].filter((k) => k.indexOf('weile_') !== 0);
  eq(weird.length, 0, '老键都是 weile_ 前缀', weird.join(','));
}

/* =================== [2] 分类函数的三个方向都要对 =================== */
head('[2] 分类自测（三个方向都验，否则等于没验）');
{
  eq(classify(Store.KEYS.ROOMS), 'current', '当前键 → current');
  eq(classify('weile_rooms'), 'legacy', '★ 老键 → legacy（不是 current，这是本守卫的全部意义）');
  eq(classify('lxw_rooms_v2'), 'unknown', '不存在的键 → unknown（拼错一个字符就是这个形状）');

  /* 扫描器自身：三种写法都要能捞到，两种该放过的要放过 */
  const sample = [
    "localStorage.getItem('weile_rooms')",
    'sessionStorage.removeItem("weile_myid")',
    "localStorage.setItem('lxw_rooms_v1', v)",
    'localStorage.getItem(KEY_NAME)',          // 变量 → 放过
    'localStorage.getItem(`lxw_${x}_v1`)'      // 模板串 → 放过
  ].join('\n');
  const found = scanLiterals(sample).map((x) => x.key);
  eq(found.length, 3, '扫到 3 处字面量（变量与模板串不误报）', found.join(','));
  ok(found.indexOf('weile_rooms') >= 0 && found.indexOf('weile_myid') >= 0, '两处老键都扫到了');
}

/* =================== [3] 真仓库：scripts/ 下不许出现老键 =================== */
head('[3] scripts/ 全量扫描');
{
  let files = [];
  try { files = fs.readdirSync(SCRIPTS).filter((f) => /\.js$/.test(f)); } catch (e) { files = []; }
  ok(files.length >= 40, '扫到 ' + files.length + ' 个脚本（少于 40 说明目录读错了）');

  const bad = [];
  let total = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
    for (const hit of scanLiterals(src)) {
      total += 1;
      const kind = classify(hit.key);
      if (kind !== 'current') bad.push({ file: f, key: hit.key, kind: hit.kind, api: hit.api, kindOf: kind });
    }
  }
  ok(total >= 30, '一共扫到 ' + total + ' 处带字面量的存储访问（太多或太少都要看）');
  eq(bad.length, 0, '★★ scripts/ 下没有一处读老键或不认识的键',
    bad.map((b) => b.file + ':' + b.api + "('" + b.key + "') → " + b.kindOf).join(' | '));
}

/* =================== [4] 这条守卫真的会红（用真文件造一次） =================== */
head('[4] 变异自证：塞一处老键进去，扫描必须报出来');
{
  const tmpFile = path.join(SCRIPTS, 'probe-zzz-guard-sample.js');
  try {
    fs.writeFileSync(tmpFile, "localStorage.getItem('weile_rooms');\n", 'utf8');
    const files = fs.readdirSync(SCRIPTS).filter((f) => /\.js$/.test(f));
    const bad = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
      for (const hit of scanLiterals(src)) {
        if (classify(hit.key) !== 'current') bad.push(f + ':' + hit.key);
      }
    }
    ok(bad.some((b) => b.indexOf('probe-zzz-guard-sample.js') >= 0),
      '★ 新塞进去的老键被扫到了（证明上面那条「零违规」不是因为它没在看）', bad.join(','));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) { /* 清不掉也只是留个临时文件 */ }
  }
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
