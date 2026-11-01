/**
 * 「上一局结算」只读弹窗（纯静态解析，不开浏览器）
 * 跑法：node pwa/test/prev-result.test.js
 *
 * 守的是这个功能存在的**唯一理由**：
 *   就位态（点了「开始下一局」、人在房间页等别人）座位表上的分数显示「—」，
 *   想看自己上局拿了几分，原先只有「回结算页」一条路 —— 而那颗按钮走 unWantNext，
 *   一看就把报名撤回，全员准备跟着失效，另外几个人得重新等。
 *   所以这个弹窗必须**只读**：不写 wantNext、不调 unWantNext、不改任何房间状态。
 *
 * 这条不变量在界面上看不出来 —— 弹窗照样打开、数字照样对，
 * 只有另一个人的准备状态悄悄被打回。只能靠扫源码守住。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const gameJs = readGameAll();
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

/* 取一个具名函数的函数体（从 `function name(` 到下一个缩进两格的收尾大括号）。
 * game.js 全是 ES5 函数声明 + 两格缩进，这个足够稳。 */
function fnBody(name) {
  const start = gameJs.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const end = gameJs.indexOf('\n  }', start);
  return end < 0 ? '' : gameJs.slice(start, end);
}

/* ---------- 1. 入口 ---------- */
console.log('\n[1] 房间页的两颗胶囊');
const rowMatch = /<div class="room-prev-row">([\s\S]*?)<\/div>/.exec(html);
ok(!!rowMatch, '有 .room-prev-row 容器（两颗胶囊并排，不占 ghost-row 的位置）');
if (rowMatch) {
  ok(/id="btn-prev-replay"/.test(rowMatch[1]), '「看上一局过程」在这一行里');
  ok(/id="btn-prev-result"/.test(rowMatch[1]), '「上一局结算」在同一行里');
  const inRow = (rowMatch[1].match(/room-prev\b/g) || []).length;
  ok(inRow === 2, '两颗都用同一套 .room-prev 胶囊样式（实际 ' + inRow + ' 处）');
}
ok(/id="btn-prev-result"[^>]*class="[^"]*\bhidden\b/.test(html)
  || /class="[^"]*\bhidden\b[^"]*"[^>]*id="btn-prev-result"/.test(html),
  '「上一局结算」默认 hidden（只有就位态才露）');
const ghostMatch = /<div class="ghost-row">([\s\S]*?)<\/div>/.exec(html);
ok(!!ghostMatch, '能找到 .ghost-row（房内次要操作那一行）');
if (ghostMatch) {
  ok(!/btn-prev-result/.test(ghostMatch[1]),
    '★ 没有塞进 .ghost-row：那里现在是 3 个按钮各 200px，加第 4 个会把每个挤到 148px，「补 AI 队友」要缩字');
  const ghostBtns = (ghostMatch[1].match(/<button/g) || []).length;
  ok(ghostBtns === 4, '.ghost-row 保持 4 个按钮（含就位态才露的「回结算页」），实际 ' + ghostBtns + ' 个');
}

/* ---------- 2. ★ 只读：不许碰报名状态 ---------- */
console.log('\n[2] ★ 只读：不撤回报名、不改房间状态');
const openBody = fnBody('openPrevResult');
const closeBody = fnBody('closePrevResult');
ok(openBody.length > 0, '能找到 openPrevResult');
ok(!/unWantNext/.test(openBody), '★ openPrevResult 里没有 unWantNext（一看就把全员准备打回，这是它存在的理由）');
ok(!/wantNext\s*=/.test(openBody), '★ 没有写 wantNext');
ok(!/RoomStore\./.test(openBody), '★ 没有发任何请求（纯读 state.room）');
ok(/state\.room/.test(openBody), '数据来自 state.room');
ok(/showModalEl\('prev-result-modal'\)/.test(openBody), '用 showModalEl 打开（焦点进出才有效）');
ok(/hideModalEl\('prev-result-modal'\)/.test(closeBody), 'closePrevResult 用 hideModalEl');
ok(/room\.phase !== StateMachine\.PHASE\.SETTLED/.test(openBody),
  '只在 SETTLED 才打开（非结算期没有「上一局」可看）');

/* ---------- 3. 和结算页共用同一份渲染 ---------- */
console.log('\n[3] 和结算页共用同一份渲染（不各画一套）');
ok((gameJs.match(/appendChild\(settleListEl\(room\)\)/g) || []).length === 2,
  '★ settleListEl 正好被两处渲染调用：结算页 + 弹窗（实际 '
  + (gameJs.match(/appendChild\(settleListEl\(room\)\)/g) || []).length + ' 处）');
/* 尾注按需要拆开：结算页要「原因 + 算法公式」，回看弹窗只要原因。
 * 合并着写会在窄容器里折成两行，「初始 / 20 分」孤零零一行。 */
ok((gameJs.match(/settleTipText\(room\)\)\)/g) || []).length === 1,
  '结算页用完整尾注（原因 + 公式），只此一处');
ok(/settleReasonText\(room\)/.test(fnBody('settleTipText')), '结算页尾注由「原因 + 公式」拼成');
ok(/settleReasonText\(room\)/.test(fnBody('openPrevResult')),
  '★ 弹窗只用原因（不把公式带进来）');
ok(!/settleTipText\(room\)/.test(fnBody('openPrevResult')),
  '★ 弹窗里没有 settleTipText（那会把公式也带进去）');
ok(/var reason = settleReasonText\(room\);\s*if \(reason\) inner\.appendChild/.test(gameJs),
  '原因为空时不渲染空段落（占一行空白反而更怪）');
ok(/function settleListEl\(/.test(gameJs) && /function settleTipText\(/.test(gameJs),
  '两个共用函数都存在');
/* 排名/冠军/「我」胶囊这些规则只该有一份 */
ok((gameJs.match(/classList\.add\('champion'\)/g) || []).length === 1,
  'champion 判定只有一处（两份实现迟早跑偏）');
ok((gameJs.match(/settle-you/g) || []).length === 1,
  '「我」胶囊只渲染一处');

/* ---------- 4. 显隐条件 ---------- */
console.log('\n[4] 显隐：只在就位态');
const prevBlock = /var prevResBtn = \$\('#btn-prev-result'\);([\s\S]{0,1000}?)\n\n/.exec(gameJs)
  || /var prevResBtn = \$\('#btn-prev-result'\);([\s\S]{0,1000})/.exec(gameJs);
ok(!!prevBlock, '能找到 prevResBtn 的显隐逻辑');
if (prevBlock) {
  ok(/prevResBtn\.classList\.toggle\('hidden', !nextWait \|\| meLate\)/.test(prevBlock[1]),
    '★ 只在 nextWait（就位态）露出，不等同于「有回放可看」');
  /* 结算期才进来的人（joinedLate）没有上一局 —— 给他这颗按钮等于把别人的成绩单
   * 摆在一个没打的人面前。这条和上面那条是「与」的关系，别把 meLate 删掉。 */
  ok(/var meLate = !!\(me && me\.joinedLate\)/.test(prevBlock[1]),
    '★ joinedLate（结算期才进来）不显示「上一局结算」');
}

/* ---------- 5. 弹窗本身 ---------- */
console.log('\n[5] 弹窗接线');
ok(/id="prev-result-modal"/.test(html), 'HTML 里有 #prev-result-modal');
ok(/aria-labelledby="prev-result-title"/.test(html), 'aria-labelledby 指向标题');
ok(/id="prev-result-title"/.test(html), '标题元素存在');
ok(/MODAL_ORDER = \[[\s\S]*?'prev-result-modal'/.test(gameJs), '登记进 MODAL_ORDER（否则 Tab 圈不住）');
ok(/\$\('#prev-result-modal'\)\.classList\.contains\('hidden'\)\) \{ closePrevResult\(\); return; \}/.test(gameJs),
  'Esc 能关（和回放同一层）');
ok(/btn-prev-result-close/.test(html) && /btn-prev-result-close'\)\.addEventListener\('click', closePrevResult\)/.test(gameJs),
  '右上角 X 绑了关闭');
ok(/e\.target === e\.currentTarget\) closePrevResult\(\)/.test(gameJs),
  '点遮罩关闭，且用 e.target === e.currentTarget 判定');
/* 手势与结算页同一套（v89 起：头像 = 档案、行的其他地方 = 这一把的回放），
 * 所以两个 body 绑的是同一个函数。断言从「有没有一条 click 监听」改成
 * 「这两个 body 都经过 bindSettleRowTap」—— 那才是「两边不会跑偏」的保证。 */
ok(/bindSettleRowTap\('#settle-body'\)/.test(gameJs) && /bindSettleRowTap\('#prev-result-body'\)/.test(gameJs),
  '弹窗里的玩家行也能点（和结算页共用 bindSettleRowTap，不各画一套）');
ok(/body\.addEventListener\('click'[\s\S]{0,400}?closest\('\.settle-rank'\)[\s\S]{0,200}?openProfile/.test(gameJs),
  '★ 头像 → 玩家档案');
ok(/body\.addEventListener\('click'[\s\S]{0,600}?openReplayHere\(\)/.test(gameJs),
  '★ 行的其他地方 → 这一把的回放');

/* ---------- 6. 样式 ---------- */
console.log('\n[6] 样式');
ok(/\.room-prev-row \{[^}]*display: flex/.test(css), '.room-prev-row 是 flex 一行');
ok(/\.prev-result-card \{[^}]*max-width: 620px/.test(css), '宽度和回放弹窗同档（来回点不会一宽一窄地跳）');
const bodyCss = /\.prev-result-body \{([\s\S]*?)\}/.exec(css);
ok(!!bodyCss, '有 .prev-result-body');
if (bodyCss) {
  ok(/overflow-y: auto/.test(bodyCss[1]), '内容多了能滚动');
  ok(!/vh/.test(bodyCss[1]),
    '★ 没写 vh（#stage 被 transform: scale() 缩过，vh 落在缩放坐标系里只剩三成高度 —— 回放弹窗踩过这个坑）');
}
ok(!/prev-result-body[^{]*\{[^}]*overflow:\s*hidden/.test(css),
  '没套 .settle-body（那个在 .modal-open 时会锁死滚动）');

/* ---------- 6b. 浅底重上色（第 36 章） ----------
 * .settle-row 那套色是按结算页的墨绿底写的。同一个弹窗装在暖白卡片里时，
 * rgba(0,0,0,0.24) 落到 #FFF7E8 上变成浅灰、字还是 body 的暖白 —— 实测
 * 昵称 1.67:1、分数 1.14:1、净胜 0 只有 1.03:1（都在「等于没写」的档位）。
 * 所以 .prev-result-body 必须把这一整套色重上成浅底色阶。
 * 这几条是防回退：谁把这一段删掉，测试立刻红，而不是等人再截一次图。 */
console.log('\n[6b] 浅底重上色（暖白弹窗里不许沿用深底那套色）');
ok(/--gold-ink:\s*#8A5A0B/.test(css), '★ 有 --gold-ink（浅底上的金色文字档）');
ok(/\.prev-result-body \.settle-row \{[^}]*background:\s*rgba\(26,\s*29,\s*35/.test(css),
  '★ 行底换成浅底那套 rgba(26,29,35,<alpha>)（不是 rgba(0,0,0,0.24)）');
ok(/\.prev-result-body \.settle-name \{[^}]*color:\s*var\(--warm-ink\)/.test(css),
  '★ 昵称用 --warm-ink（不再继承 body 的暖白）');
ok(/\.prev-result-body \.settle-row\.me \.settle-name \{[^}]*var\(--gold-ink\)/.test(css),
  '★ 「我」那一行的名字也要压到 --gold-ink（0,3,0 的既有规则会盖住泛用规则）');
ok(/\.prev-result-body \.settle-score \{[^}]*var\(--gold-ink\)/.test(css),
  '★ 分数用 --gold-ink（--gold 在暖白上 1.5:1）');
ok(/\.prev-result-body \.settle-net\.up \{[^}]*var\(--cta-red\)/.test(css)
  && /\.prev-result-body \.settle-net\.down \{[^}]*var\(--brand-green\)/.test(css)
  && /\.prev-result-body \.settle-net\.flat \{[^}]*var\(--text-muted\)/.test(css),
  '★ 净胜三态换成浅底档（--up-red/--down-green/--gray-aux 是深底的）');
ok(/\.prev-result-body \.settle-tip \{[^}]*var\(--text-muted\)/.test(css),
  '★ 尾注也用浅底档（--gray-aux 在暖白上 1.7:1）');
ok(/\.prev-result-body \.settle-row\.champion \{[^}]*linear-gradient/.test(css),
  '★ 冠军行的渐变在浅底上要提亮（沿用深底那档会糊成一片）');

/* ---------- 7. 结束原因文案 ---------- */
console.log('\n[7] 结束原因文案与入口口径一致');
const reasonBlock = /var END_REASON_TEXT = \{([\s\S]*?)\};/.exec(gameJs);
ok(!!reasonBlock, '有 END_REASON_TEXT');
if (reasonBlock) {
  ok(!/解散/.test(reasonBlock[1]),
    '★ 文案里没有「解散」（入口叫「结束本局」，房间不散，写解散等于说玩家做了他没做的事）');
  ok(/dissolve: '提前结束'/.test(reasonBlock[1]), 'dissolve 显示「提前结束」');
  ok(/scoreZero: '分数见底结束'/.test(reasonBlock[1]), 'scoreZero 不变');
  ok(/someoneLeft: '有人离开结束'/.test(reasonBlock[1]), 'someoneLeft 不变');
}
/* 全前端不该再有用户可见的「解散」二字（注释和内部标识符允许） */
const visibleDissolve = (gameJs.match(/'[^'\n]*解散[^'\n]*'/g) || [])
  .filter(function (s) { return !/^'(dissolve|解散)'$/.test(s); });
ok(visibleDissolve.length === 0,
  '★ 前端字符串字面量里没有残留「解散」', visibleDissolve.join(' / '));

/* ---------- 8. 净胜分与冠军标记 ---------- */
console.log('\n[8] 净胜三态 + 冠军标记');
const listBody = fnBody('settleListEl');
ok(/netCls\(net\)/.test(listBody), '★ 净胜走 netCls（up/down/flat 三态）');
ok(/netText\(net\)/.test(listBody), '★ 数字走 netText（0 不带符号，不是「+0」）');
ok(!/net >= 0 \? 'pos' : 'neg'/.test(listBody),
  '★ 没有把 0 归进 pos —— 那会让净胜 0 显示成红色，而排行榜里同一个 0 是灰的');
ok(!/🥇/.test(listBody), '★ 名字前没有 🥇（头像那颗皇冠已经在说「冠军」了，一排两个奖牌）');
ok(/settle-net\.up \{ color: var\(--up-red\)/.test(css), '.settle-net.up 用同一个红');
ok(/settle-net\.down \{ color: var\(--down-green\)/.test(css), '.settle-net.down 用同一个绿');
ok(/settle-net\.flat \{ color: var\(--gray-aux\)/.test(css), '.settle-net.flat 中性灰（和排行榜一致）');

/* ---------- 9. recordSettled 与 render 解耦 ---------- */
console.log('\n[9] 收录不受屏幕形态影响');
ok(/function absorbRoom\(r\) \{\s*absorbHistory\(r\);\s*recordSettled\(r\);/.test(gameJs),
  '★ absorbRoom 同时收过程与战绩（两件事都幂等）');
const renderBody = fnBody('render');
ok(!/recordSettled\(/.test(renderBody),
  '★ render() 里不再调 recordSettled（它会在战绩/排行/登录页早退）');
ok(/absorbRoom\(r\);\s*render\(\);/.test(gameJs), '订阅回调里先收录再渲染');
/* attachRoom 直接带房间进来时也要收一次，否则「刷新时停在结算页」那局不记 */
ok(/absorbRoom\(room\);\s*render\(\);/.test(gameJs), 'attachRoom 首次进入也收一次（刷新场景）');

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
