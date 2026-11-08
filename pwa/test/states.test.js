/**
 * 四态 + 错误三级：纯函数与文案表的守卫（build-states v1）
 *
 * ── 这个文件守什么 ────────────────────────────────────────────────────
 * 1. **判定顺序**：`offline > fail > loading > empty > data`。用 32 组输入 ×
 *    手写真值表来钉 —— 真值表是照设计文档的语义一格一格写出来的，不是从实现
 *    里跑一遍抄下来。抄实现的"期望值"只能证明"代码没变"，证明不了"代码是对的"。
 * 2. **值域**：`data-rstate` 只有 5 个值，且 5 个值都可达（少一个说明某态永远出不来）。
 * 3. **文案逐字**：标题 ≤14 字、副文案 ≤26 字，且与 design-states-v1.md §②-b
 *    一字不差。文案是设计定稿，代码里改一个字都算施工不合格。
 * 4. **错误三级唯一**：11 个 key 各属一个级别，三级各有 ≥1 例（QA S11）。
 *    同一错误码映射到两个级别 = 0。
 * 5. **禁用词分类器**：不可恢复类的可见文案不许出现 再试/重试/稍后再试（QA S12）。
 *    分类器**先自测报数**（QA S20）：≥3 样本、≥1 命中、≥1 不命中 ——
 *    不自测的正则，"零违规"可能只是因为那条正则永远不匹配。
 *
 * 跑法：node pwa/test/states.test.js（`npm test` 会自动收进来）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RS = require(path.join(__dirname, '..', 'js', 'recordsState.js'));
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(c, m, extra) {
  if (c) { pass++; console.log('  ✓ ' + m); }
  else { fail++; console.log('  ✗ ' + m + (extra !== undefined ? '  ← ' + extra : '')); }
}
function eq(a, b, m) { ok(a === b, m, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }
function head(t) { console.log('\n' + t); }

/* =================== [1] 判定顺序：32 组输入 × 手写真值表 =================== */
head('[1] 判定顺序 offline > fail > loading > empty > data');
{
  /* 手写真值表。枚举顺序写死在这里：
   *   外层 online(true→false) → cloudErr(false→true) → cloudLoading(false→true)
   *        → hasData(false→true) → avail(true→false)
   * 期望值全部是照规则**手工填**的，没有一格来自实现。 */
  const ORDER = [
    /* online = true */
    'empty', 'fail', 'data', 'data',   // err=F, loading=F → (data=F,avail=T) (F,F) (T,T) (T,F)
    'loading', 'fail', 'loading', 'data', // err=F, loading=T
    'fail', 'fail', 'data', 'data',    // err=T, loading=F
    'fail', 'fail', 'data', 'data',    // err=T, loading=T（fail 压过 loading）
    /* online = false：一律 offline，与其余四个字段无关 */
    'offline', 'offline', 'offline', 'offline',
    'offline', 'offline', 'offline', 'offline',
    'offline', 'offline', 'offline', 'offline',
    'offline', 'offline', 'offline', 'offline'
  ];

  const cases = [];
  [true, false].forEach((online) => {
    [false, true].forEach((cloudErr) => {
      [false, true].forEach((cloudLoading) => {
        [false, true].forEach((hasData) => {
          [true, false].forEach((avail) => {
            cases.push({ online, cloudErr: cloudErr ? 'boom' : '', cloudLoading, hasData, avail });
          });
        });
      });
    });
  });

  eq(cases.length, 32, '枚举出 32 组输入（5 个布尔量的全组合）');
  eq(ORDER.length, cases.length, '真值表的格数与输入组数一致（少一格就是漏了一种组合）');

  const bad = [];
  cases.forEach((input, i) => {
    const got = RS.recordsStateOf(input);
    if (got !== ORDER[i]) bad.push(i + ': got ' + got + ' want ' + ORDER[i] + ' ← ' + JSON.stringify(input));
  });
  ok(bad.length === 0, '★★ 32 组全部与手写真值表一致', bad.slice(0, 4).join(' | '));

  /* 顺序本身也要单独钉三条：这是设计文档里最容易在重构时被换掉的东西，
   * 而换掉之后 32 组里有 8 组会静默变成另一种态（页面看着还是"正常"）。 */
  ok(RS.recordsStateOf({ online: false, cloudErr: 'x', cloudLoading: true, hasData: true, avail: true }) === 'offline',
    '★ 离线压过失败（先说原因，玩家才知道该修什么）');
  ok(RS.recordsStateOf({ online: true, cloudErr: 'x', cloudLoading: true, hasData: false, avail: true }) === 'fail',
    '★ 失败压过加载（请求已经有结论了，转圈就是撒谎）');
  ok(RS.recordsStateOf({ online: true, cloudErr: '', cloudLoading: true, hasData: false, avail: true }) === 'loading',
    '★★ 加载压过空（这是现状最伤的一条：hasData 在加载期间恒为 false）');
  ok(RS.recordsStateOf({ online: true, cloudErr: 'x', cloudLoading: false, hasData: true, avail: true }) === 'data',
    '★ 有本机数据时失败降级为 data（不占满屏，改走页脚一行）');
  ok(RS.recordsStateOf({ online: true, cloudErr: '', cloudLoading: false, hasData: false, avail: false }) === 'fail',
    '★ 存不了（无痕）属于失败·不可恢复类，不是空态（"存不了"≠"你还没打过"）');
  ok(RS.recordsStateOf(null) === 'empty', '入参为空时不抛异常（返回 empty，不炸整屏）');
}

/* =================== [2] 值域：5 个值，缺一或越界即红 =================== */
head('[2] 状态值域（QA S2）');
{
  const EXPECTED = ['offline', 'fail', 'loading', 'empty', 'data'];   // 手写，不来自实现
  eq(RS.STATES.length, 5, '值域是 5 值（不是"四态"：有数据正常展示也是一态）');
  EXPECTED.forEach((v) => ok(RS.STATES.indexOf(v) >= 0, '值域含 ' + v));

  /* 五值都可达：把 32 组输入跑出来的结果去重，必须正好是这 5 个 */
  const seen = new Set();
  [true, false].forEach((online) => [false, true].forEach((cloudErr) => [false, true].forEach((cloudLoading) => [false, true].forEach((hasData) => [false, true].forEach((avail) => {
    seen.add(RS.recordsStateOf({ online, cloudErr: cloudErr ? 'x' : '', cloudLoading, hasData, avail }));
  })))));
  eq(seen.size, 5, '五个值都跑得出来（少一个说明某态永远出不来）');
  const outside = Array.from(seen).filter((v) => EXPECTED.indexOf(v) < 0);
  eq(outside.length, 0, '★★★★ 取值域外的值 = 0', outside.join(','));

  /* 静态一侧：HTML 上那个初值也必须在同一值域里 */
  const m = /id="screen-records"[^>]*data-rstate="([a-z]+)"/.exec(HTML);
  ok(!!m, '★ #screen-records 上写了 data-rstate（唯一真源）');
  ok(!!m && EXPECTED.indexOf(m[1]) >= 0, '★ 初值 ' + (m ? m[1] : '?') + ' 在值域内');
  eq(m ? m[1] : '', 'loading', '★★ 初值是 loading 而不是 empty（进屏第一帧还不知道有没有数据）');
}

/* =================== [3] 文案：逐字 + 长度 =================== */
head('[3] 文案表逐字对照 design-states-v1.md §②-b');
{
  /* 这张期望值表是照着**设计文档**手抄的，不是从实现里读出来的。 */
  const COPY = {
    'err.net.offline': ['现在没有网络', '先把这台设备上的记录给你看', ['重新载入']],
    'err.net.timeout': ['账号数据没读上来', '这台设备上也没有可显示的战绩', ['再读一次', '先开一局']],
    'err.net.server': ['账号数据没读上来', '服务器那边没应声，过一会儿再来', ['再读一次', '先开一局']],
    'err.net.rank': ['榜单没读上来', '可能网络不稳，过一会儿再看', ['刷新榜单']],
    'err.data.no_storage': ['这个浏览器存不了战绩', '关掉无痕模式，或换个浏览器', ['照样开一局']],
    'err.data.auth': ['登录已经过期了', '重新登录就能看到账号里的记录', ['重新登录']],
    'err.data.malformed': ['', '账号数据格式不对，先看本机的', []],
    'err.data.quota': ['本机存不下了', '清掉一些旧记录就能继续记', ['清一下旧记录']],
    'err.silent.profile': ['', '', []],
    'err.silent.purge': ['', '', []],
    'err.silent.prefetch': ['', '', []]
  };

  const keys = Object.keys(COPY);
  eq(keys.length, 11, '设计 §②-a 的表里是 11 个 key');
  keys.forEach((k) => {
    const want = COPY[k];
    const got = RS.ERR[k];
    if (!got) { ok(false, k + ' 在 ERR 表里存在'); return; }
    eq(got.title, want[0], k + ' 标题逐字');
    eq(got.sub, want[1], k + ' 副文案逐字');
    eq((got.actions || []).map((a) => a.label).join('|'), want[2].join('|'), k + ' 按钮文案逐字');
  });

  /* 长度：标题 ≤14、副文案 ≤26（空的成立）。超了就会在 320 宽或 800×360 里断成三行。 */
  const tooLong = [];
  keys.forEach((k) => {
    const e = RS.ERR[k] || {};
    if ((e.title || '').length > 14) tooLong.push(k + '.title=' + e.title.length);
    if ((e.sub || '').length > 26) tooLong.push(k + '.sub=' + e.sub.length);
  });
  Object.keys(RS.STATE_TEXT).forEach((k) => {
    const t = RS.STATE_TEXT[k] || {};
    /* subPanel 是"副文案的另一档"（fix2 / F1），按副文案的口径量（≤26） */
    ['title', 'sub', 'subPanel', 'slow'].forEach((f) => {
      if ((t[f] || '').length > 26) tooLong.push('STATE_TEXT.' + k + '.' + f + '=' + t[f].length);
      if ((f === 'title' || f === 'slow') && (t[f] || '').length > 14) tooLong.push('STATE_TEXT.' + k + '.' + f + '=' + t[f].length);
    });
  });
  eq(tooLong.length, 0, '★ 标题 ≤14 字、副文案 ≤26 字', tooLong.join(', '));

  /* 四态标题互不相同（design ⑥-4）：去重后必须还是 4 个。
   * 两个态说同一句话，玩家就分不出自己看到的是哪一个。 */
  const titles = ['empty', 'loading', 'fail', 'offline'].map((k) => (RS.STATE_TEXT[k] || {}).title);
  eq(new Set(titles).size, 4, '★ 四态标题互不相同：' + titles.join(' / '));

  /* ★★★ F1（fix2 / 制作人 R8）：离线一个块两种形态，副文案按形态取值。
   * 期望值逐字来自裁定，不是从实现里抄的。 */
  const off = RS.STATE_TEXT.offline || {};
  eq(off.sub, '先把这台设备上的记录给你看', '★ strip 形态的副文案没动（本机有记录，这句话是真的）');
  eq(off.subPanel, '连上网就能看到账号里的记录', '★★★ panel 形态有独立副文案（本机 0 局时不许说"先给你看这台设备上的记录"）');
  ok(off.subPanel && off.subPanel !== off.sub, '★★★ 两档文案确实不同（相同就等于没修）');
  ok((off.subPanel || '').length <= 26, '★ panel 副文案 ≤26 字（' + (off.subPanel || '').length + '）');

  eq(RS.STATE_DELAY_MS, 250, '★ 加载门槛是 250ms（不是散在 if 里的魔法数字）');
  eq(RS.STATE_SLOW_MS, 1000, '★ 慢文案的升级线是 1000ms');
}

/* =================== [4] 错误三级：11 key 各属一个级别（QA S11） =================== */
head('[4] 错误三级（QA S11）');
{
  const KEYS = ['err.net.offline', 'err.net.timeout', 'err.net.server', 'err.net.rank',
    'err.data.no_storage', 'err.data.auth', 'err.data.malformed', 'err.data.quota',
    'err.silent.profile', 'err.silent.purge', 'err.silent.prefetch'];
  eq(Object.keys(RS.ERR).length, 11, '★ ERR 表里正好 11 个 key（多一个少一个都红）');
  KEYS.forEach((k) => ok(!!RS.ERR[k], '有 ' + k));

  const levels = { retry: 0, fatal: 0, silent: 0 };
  const weird = [];
  KEYS.forEach((k) => {
    const lv = RS.errClassOf(k);
    if (levels[lv] === undefined) weird.push(k + '=' + lv);
    else levels[lv] += 1;
    /* 每个 key 只能属于一个级别：级别就存在 ERR[key].level 一处，
     * 这里顺带证明 errClassOf 没有第二张表 */
    eq(lv, RS.ERR[k].level, k + ' 的级别唯一（errClassOf 与表里同一个值）');
  });
  eq(weird.length, 0, '★★ 没有 key 落在三级之外', weird.join(','));
  ok(levels.retry >= 1, '★★ 可重试（L1）至少 1 例：' + levels.retry);
  ok(levels.fatal >= 1, '★★ 不可恢复（L2）至少 1 例：' + levels.fatal);
  ok(levels.silent >= 1, '★★ 静默（L3）至少 1 例：' + levels.silent);
  eq(levels.retry + levels.fatal + levels.silent, 11, '三级加总 = 11（没有第七条漏网）');

  /* 未知 key 的默认级别：不可恢复。把「不可恢复」误说成「再来一次」，
   * 玩家会多点一次然后更困惑 —— 这是唯一不会骗人的默认。 */
  eq(RS.errClassOf('err.nope.nothing'), 'fatal', '★ 未知 key 按不可恢复处理（不承诺"再试"）');

  /* 不可恢复类只给一条出路；静默类一个动作都没有。 */
  const badFatal = KEYS.filter((k) => RS.errClassOf(k) === 'fatal' && (RS.ERR[k].actions || []).length > 1);
  eq(badFatal.length, 0, '★★ L2 最多一条出路（给两条就等于说"还有别的路"）', badFatal.join(','));
  const badSilent = KEYS.filter((k) => RS.errClassOf(k) === 'silent'
    && ((RS.ERR[k].actions || []).length || (RS.ERR[k].title || '') || (RS.ERR[k].sub || '')));
  eq(badSilent.length, 0, '★★ L3 不带任何文案与动作（页面一个像素都不动）', badSilent.join(','));

  /* 上报口径：可重试与不可恢复都要报，静默也必须报（静默只是"不打扰玩家"） */
  const noReport = KEYS.filter((k) => !RS.ERR[k].report || !RS.ERR[k].report.source);
  eq(noReport.length, 0, '★★ 11 个 key 全部带 report.source（"该不该上报"只有一处答案）', noReport.join(','));
}

/* =================== [5] 禁用词分类器：先自测，再用在真表上（QA S12 / S20） =================== */
head('[5] 禁用词分类器（QA S12 + S20）');
{
  /* 禁用词表**手写**，不从实现字符串里抄（QA §1.3 的口径）。
   * 「请重新登录」含「重」但不含禁用词 —— 这类不误伤正是下面自测要证明的。 */
  const BANNED = /再试一次|再试|重试|稍后\s*(再试|重试)/;

  const SAMPLES = [
    ['账号不存在，请再试一次', true, '精确命中'],
    ['请稍后重试', true, '稍后 + 重试'],
    ['重试', true, '单词命中'],
    ['重新登录就能看到账号里的记录', false, '含「重」但不含「重试」（不误伤）'],
    ['再读一次', false, '具体动词不是泛词'],
    ['刷新榜单', false, '榜单的动词'],
    ['现在没有网络', false, '离线标题']
  ];
  let hit = 0, miss = 0, selfBad = 0;
  SAMPLES.forEach((s) => {
    const got = BANNED.test(s[0]);
    if (s[1]) hit++; else miss++;
    if (got !== s[1]) { selfBad++; console.log('    自测不符：' + s[0] + ' got ' + got + ' want ' + s[1]); }
  });
  const selfPass = SAMPLES.length - selfBad;
  console.log('    分类器自测：' + selfPass + '/' + SAMPLES.length + ' 通过（命中样本 ' + hit + ' 个、不命中样本 ' + miss + ' 个）');
  ok(SAMPLES.length >= 3, '★★ 自测样本 ≥3（实际 ' + SAMPLES.length + '）');
  ok(hit >= 1 && miss >= 1, '★★ 自测样本里既有该命中的也有不该命中的');
  eq(selfBad, 0, '★★ 分类器自测 ' + selfPass + '/' + SAMPLES.length + '（正则自己不测，"零违规"就没有意义）');

  /* 用在真表上：L2 的可见文案（标题 / 副文案 / 按钮）不许命中禁用词。
   * 作用域只到 L2 —— 可重试类允许说「再读一次」，但它也不该用泛词（design §②-c）。 */
  const l2Bad = [];
  Object.keys(RS.ERR).forEach((k) => {
    if (RS.errClassOf(k) !== 'fatal') return;
    const e = RS.ERR[k] || {};
    const visible = [e.title || '', e.sub || ''].concat((e.actions || []).map((a) => a.label));
    visible.forEach((s) => { if (s && BANNED.test(s)) l2Bad.push(k + ': ' + s); });
  });
  eq(l2Bad.length, 0, '★★ L2 可见文案命中禁用词 = 0', l2Bad.join(' | '));

  const allBad = [];
  Object.keys(RS.ERR).forEach((k) => {
    const e = RS.ERR[k] || {};
    (e.actions || []).forEach((a) => { if (a.label && BANNED.test(a.label)) allBad.push(k + ': ' + a.label); });
  });
  eq(allBad.length, 0, '★ 全站没有一个按钮用泛词（三个具体动词：再读一次 / 刷新榜单 / 重新载入）', allBad.join(' | '));
}

/* =================== [6] 结果 → 错误 key 的映射 =================== */
head('[6] 云端回包 → 错误 key');
{
  eq(RS.errKeyOf(null), 'err.net.timeout', 'null（连回包都没有）→ 可重试·超时');
  eq(RS.errKeyOf({ ok: false, offline: true }), 'err.net.timeout', 'fetch 自己 reject → 可重试·超时');
  eq(RS.errKeyOf({ ok: false, status: 500 }), 'err.net.server', '5xx → 可重试·服务端');
  eq(RS.errKeyOf({ ok: false, status: 503 }), 'err.net.server', '503 同上');
  eq(RS.errKeyOf({ ok: false, status: 429 }), 'err.net.server', '429 → 可重试·服务端（副文案换"人有点多"）');
  eq(RS.errKeyOf({ ok: false, status: 401 }), 'err.data.auth', '401 → 不可恢复·身份失效');
  eq(RS.errKeyOf({ ok: false, status: 403 }), 'err.data.auth', '403 同上');
  eq(RS.errKeyOf({ ok: false, status: 404 }), 'err.data.auth', '404（档案不存在=已注销）→ 身份失效');
  eq(RS.errKeyOf({ ok: false, error: 'x' }), 'err.net.timeout', '没有状态码的业务失败 → 可重试');
  ok(RS.ERR['err.net.server'].sub429 !== RS.ERR['err.net.server'].sub,
    '★ 429 有自己的副文案（和 5xx 混一档会让"炸了"和"人太多"说同一句话）');
}

/* =================== [7] 档案形状检查 =================== */
head('[7] profileLooksValid：缺必需字段 = 服务端契约变了');
{
  ok(RS.profileLooksValid({ totalNet: 3, games: 2 }), '正常档案 → 通过');
  ok(!RS.profileLooksValid(null), 'null（这号还没打过）→ 不通过');
  ok(!RS.profileLooksValid({ games: 2 }), '缺 totalNet → 不通过');
  ok(!RS.profileLooksValid({ totalNet: 3 }), '缺 games → 不通过');
  ok(RS.profileLooksValid({ totalNet: 0, games: 0 }), '★ 字段在、值是 0 → 通过（0 是合法值，不是缺失）');
  ok(!RS.profileLooksValid('oops'), '字符串 → 不通过（不抛异常）');
}

/* =================== [8] 成就数字：「未知 ≠ 零」（fix1 / M3） =================== */
head('[8] 成就数字：拿不到确定值时写「—/N」，不许写 0/N');
{
  /* 期望值手写。分母 35 取自 achievements.js 的目录长度（静态常量），
   * 分子只有**拿到**的时候才写 —— 这组用例守的就是这条分界。 */
  eq(RS.achLabel(null, 35), '—/35', '未知（null）→ —/35');
  eq(RS.achLabel(undefined, 35), '—/35', '未知（undefined）→ —/35');
  eq(RS.achLabel('', 35), '—/35', '★ 未知（空串）→ —/35（空串会被 Number() 悄悄变成 0，必须先拦掉）');
  eq(RS.achLabel(NaN, 35), '—/35', '★ 坏值（NaN）→ —/35（不许冒充 0）');
  eq(RS.achLabel(0, 35), '0/35', '★★★ 0 是**确定值** → 0/35（"一个都没解锁"是合法结论，不许写 —）');
  eq(RS.achLabel(3, 35), '3/35', '确定值 3 → 3/35');
  eq(RS.achLabel('7', 35), '7/35', '字符串数字也认（服务端可能给字符串）');
  eq(RS.achLabel(-1, 35), '0/35', '★ 负数按 0（-1/35 上屏比 0/35 更糟）');
  ok(/^—\//.test(RS.achLabel(null, 35)), '★★ 未知时的形状是「—/N」：分母留着，切态时不跳版');

  /* ★★★★ 负向断言：把"未知"的四种输入全跑一遍，结果里出现 0/N 的次数必须为 0。
   * 正向断言只能证明"这一条没写错"，负向这条才是"用未知冒充零"这个缺陷的红灯。 */
  const unknownish = [null, undefined, '', NaN].map((v) => RS.achLabel(v, 35));
  eq(unknownish.filter((s) => /^0\//.test(s)).length, 0,
    '★★★★ 未知输入写成 0/N 的用例数 = 0', unknownish.join(','));
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
