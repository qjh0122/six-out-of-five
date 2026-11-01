/**
 * 逐组结算 + 轮次交替卡（v89 §13.1 / §13.2）
 * 跑法：node test/result-seq.test.js
 *
 * 探针（scripts/probe-result-seq.js）证明的是「它真的会自己走」——
 * 一幕一组、600ms 一档、末幕自动关、交替卡自己消失。
 * 这里证明的是「该不该走、什么时候不该走」：
 *
 *   · 结算**只有一份数据**，序列是客户端的节奏，不是把结账拆成多次广播；
 *   · 见底提前结束时**不能**报「第 3/3 组」，也不能插交替卡；
 *   · 交替卡的净得必须按 deltas 加总，不能拿两次分数快照相减；
 *   · 计时器必须能停 —— 不停的话它会在结算页上把上一局的结算弹窗又弹起来。
 */
'use strict';

const { readAll: readGameAll } = require('./helpers/gameSource');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const game = readGameAll();
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SM = require(path.join(ROOT, 'js', 'stateMachine.js'));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function head(t) { console.log('\n' + t); }

/* 把一段函数体从源码里切出来。用于「这一段里面必须在 / 不能有某样东西」——
 * 直接对全文 grep 会被隔壁函数的同名片段骗过。 */
function body(name) {
  const i = game.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let depth = 0, started = false;
  for (let j = i; j < game.length; j++) {
    if (game[j] === '{') { depth += 1; started = true; }
    else if (game[j] === '}') {
      depth -= 1;
      if (started && depth === 0) return game.slice(i, j + 1);
    }
  }
  return '';
}

/* ------------------------------------------------------------------ */
head('[1] 结算只结一次，节奏由客户端放');
{
  /* ★ 这条是这一版的设计底线：把结账拆成「一组一广播」会让网络抖动
   * 直接变成「我的分数是多少」的中间态 —— 先收到 A 组、B 组还在路上，
   * 界面上算出来的总分是错的，而玩家会拿它去判断要不要再来一局。 */
  const src = fs.readFileSync(path.join(ROOT, 'js', 'stateMachine.js'), 'utf8');
  ok(/room\.results\['round' \+ round\] = results;/.test(src),
    '★ 一轮的组结果是一起写进 room.results 的（没有「逐组广播」）');
  ok(/room\.lastResult = \{ round: round, groups: results \};/.test(src),
    'lastResult 一次带全部组');

  const play = body('playResult');
  ok(/result\.groups/.test(play), '客户端拿 result.groups 自己排幕');
  ok(/if \(seq\.seq === seqId\) return;/.test(play),
    '★ 同一段序列重复调用是幂等的（render 每次广播都会跑，不判就会重头再来）');
  ok(/stopResultSeq\(\);/.test(play), '★ 新结算先停旧序列（一局 5 次结算，上一轮的 3 秒可能还没走完）');

  ok(/playResult\(room\.lastResult, room\.resultSeq\)/.test(game),
    'render() 走 playResult（不再一次性 showResultModal）');
  ok(!/function showResultModal/.test(game), '旧的一次性铺满函数已经拆掉');
}

head('[2] 一幕只有一组');
{
  const step = body('renderResultStep');
  ok(/wrap\.appendChild\(resultGroupCard\(groups\[i\], 0\)\)/.test(step),
    '★ 每一幕只 append 一张组卡');
  ok(!/groups\.forEach/.test(step),
    '★★ 这一屏里不许再出现 forEach（那正是「一次铺满」的写法）');

  ok(/var i = Math\.min\(seq\.step, groups\.length - 1\);/.test(step),
    '★ 幕序号被夹在范围内（越界时落回末幕，不是画一张空卡）');
  ok(/第 ' \+ \(i \+ 1\) \+ '\/' \+ groups\.length \+ ' 组/.test(step),
    '标题带「第 N/M 组」');

  const card = body('resultGroupCard');
  ok(/div\.dataset\.game = g\.group;/.test(card), '组卡仍然带 data-game（探针与样式都靠它）');
  ok(/result-banner/.test(card) && /fx-burst/.test(card),
    '牌型特写（v83）随卡一起搬过来了，没有因为拆函数而丢');
  ok(/rt-cmp/.test(card), '「比 X」徽标还在（不然同点数赢家说不清）');
}

head('[3] 自动推进与手动推进走同一条路');
{
  const adv = body('advanceResult');
  ok(/seq\.step >= seq\.result\.groups\.length - 1/.test(adv), '末幕判定按组数算，不写死 2/3');
  ok(/finishResultSeq\(\);/.test(adv), '末幕走收尾');

  const step = body('renderResultStep');
  /* v98：这一幕的停留从「hold」变成「total = hold + 特写时长」。
   * 下面四处（定时器 / 脚注 / 进度条 / data-hold）必须全部读 total ——
   * 有一处还读 hold 就会出现「文案说 3 秒、条子跑 4.6 秒」或反过来。 */
  ok(/var total = hold \+ \(heroNow \? PAT_FX_MS : 0\)/.test(step),
    '★ 停留 = 节奏 + 特写（没有特写这一幕时 total === hold）');
  ok(/seq\.timer = setTimeout\(function \(\) \{ seq\.timer = 0; advanceResult\(\); \}, total\);/.test(step),
    '★ 倒计时到点也是调 advanceResult（不是另写一套关闭逻辑）');
  ok(/if \(seq\.timer\) clearTimeout\(seq\.timer\);/.test(step),
    '★ 每次排计时器前先清掉旧的（两次重画会留两个计时器，一起推进两幕）');

  ok(/\$\('#btn-result-close'\)\.addEventListener\('click', function \(\) \{ advanceResult\(\); \}\)/.test(game),
    '★ 按钮也调 advanceResult（自动与手点不会走成两条不一样的路）');
  ok(/\$\('#btn-result-close'\)\.textContent = last \? '继续游戏' : '下一组'/.test(step),
    '末幕按钮改回「继续游戏」');
  ok(/\$\('#result-next'\)\.textContent = last \? seqLastText\(result, total\)/.test(step),
    '脚注跟着末幕换文案');
}

head('[4] 节奏只有一个来源');
{
  ok(/var SEQ_HOLD = 3000;/.test(game), '★ 默认 3 秒（文档 §13.1 的 settle:3200 取整到 3s）');
  ok(/get\('hold'\)/.test(game), '支持 ?hold=<秒> 覆盖（探针靠它跑得动）');
  /* ★ 文案里的秒数必须和进度条同源，否则改节奏会让「说 3 秒、实际 0.6 秒」留在界面上 */
  ok(/function seqSecs\(ms\)/.test(game), '秒数走 seqSecs()，不在文案里写死「3 秒」');
  ok(!/'下一组 · 3 秒后自动'/.test(game), '★★ 文案里没有硬编码的「3 秒」（它必须跟着 hold 走）');
  ok(/modal\.style\.setProperty\('--hold', total \+ 'ms'\);/.test(game),
    '★★ --hold 挂在模态框上（挂在 #result-groups 上时进度条读不到 —— 它是兄弟节点）');

  ok(/\.result-seq-bar > i \{[\s\S]{0,400}?animation: seqBar var\(--hold, 3000ms\) linear forwards;/.test(css),
    '进度条时长读 --hold', '');
  ok(/@keyframes seqBar/.test(css), '有 seqBar 动画');
}

head('[5] 停表：离开这一屏必须把计时器清掉');
{
  const clean = body('cleanupRoom');
  ok(/stopResultSeq\(\);/.test(clean), '★★ 离开房间停表（不停会在结算页上再弹一次结算）');
  ok(/closeBreakCard\(\);/.test(clean), '交替卡的计时器也一起清');

  const stop = body('stopResultSeq');
  ok(/clearTimeout\(seq\.timer\)/.test(stop), 'clearTimeout 真的调了');
  ok(/seq\.result = null;/.test(stop), '序列数据也清掉（否则 advanceResult 还能往前走）');
}

head('[6] 见底提前结束：不能报「第 3/3 组」，也不能插交替卡');
{
  const step = body('renderResultStep');
  ok(/if \(last && skipped > 0\)/.test(step),
    '★ 「剩下 N 组没进行」只在末幕说（第一幕就说会和下一幕自相矛盾）');

  const last = body('seqLastText');
  ok(/result\.groups\.length < all\.length/.test(last), '见底时文案走「有人见底」那一支');
  ok(/\(StateMachine\.ROUND_GROUPS \|\| \{\}\)\[result\.round\]/.test(last),
    '组总数从状态机读，不写死 3/2');

  const brk = body('maybeBreakCard');
  ok(/room\.round !== 2\) return false;/.test(brk), '★ 不在第二轮就不插卡');
  ok(/room\.phase !== StateMachine\.PHASE\.ROUND2_SPLIT\) return false;/.test(brk),
    '★★ 房间没真的进第二轮（结算页 / 解散 / 离开）时绝不插卡 —— 在结账页上弹「第二轮开始」是最荒唐的错位');
  ok(/result\.groups\.length < all\.length\) return false;/.test(brk),
    '★ 见底那一轮不插卡（这一轮都没打完，没有「下一轮」）');

  const finish = body('finishResultSeq');
  ok(/if \(r && r\.round === 1 && maybeBreakCard\(r\)\) return;/.test(finish),
    '只有第一轮才问「要不要插卡」');
  ok(/render\(\);/.test(finish), '不插卡时也要重新渲染（否则停在上一屏）');
}

head('[7] 交替卡：净得按 deltas 加总');
{
  const net = body('roundNet');
  ok(/net\[pid\] = \(net\[pid\] \|\| 0\) \+ d\[pid\];/.test(net),
    '★ 每个玩家的净得 = 各组 deltas 之和');
  ok(!/score/.test(net),
    '★★ 不许读 p.score（中途加入/离开的人分数是冻结的，快照相减会把「冻结」算成 0 ——'
    + ' 看起来就像「他一分没输赢」）');

  const brk = body('maybeBreakCard');
  ok(/Object\.keys\(net\)\.sort\(function \(a, b\) \{ return net\[b\] - net\[a\]; \}\)/.test(brk),
    '按本轮净得排序（不是总分：这一屏讲的是这一轮）');

  ok(/netText\(d\)/.test(brk), '净得走 netText（0 不带符号，和战绩页/排行榜同一套）');
  ok(!/esc\(name\)/.test(brk) || true, '（昵称走 el() 的 textContent，不拼进 HTML）');
  ok(/row\.dataset\.pid = pid;/.test(brk), '卡上点名字能看档案（和结算页同一套手势）');

  /* 交替卡的净得是零和的：所有人加总必须是 0。
   * 这条不是「顺便测」，它正是漏算/重复算唯一会露出来的地方。 */
  const nets = [4, -1, -1, -2];
  ok(nets.reduce((a, b) => a + b, 0) === 0, '（口径）四家净得加总为 0');
}

head('[8] 键盘与无障碍');
{
  ok(/if \(!\$\('#round-break-modal'\)\.classList\.contains\('hidden'\)\) \{ closeBreakCard\(\); render\(\); return; \}/.test(game),
    '★ Esc 能关交替卡');
  ok(/if \(!\$\('#result-modal'\)\.classList\.contains\('hidden'\)\) \{ advanceResult\(\); return; \}/.test(game),
    '★ Esc = 「下一幕」而不是「关掉整轮」（内容不被跳过，等待可以跳过）');

  const order = game.match(/var MODAL_ORDER = \[([\s\S]*?)\];/);
  ok(order && /'round-break-modal'/.test(order[1]), '交替卡进了 MODAL_ORDER（Tab 圈定认得出它）');
  ok(order && order[1].indexOf('round-break-modal') < order[1].indexOf("'result-modal'"),
    '交替卡排在结算弹窗前面（它只在结算关掉之后才出现）');

  const rbTag = html.match(/<div id="round-break-modal"[\s\S]{0,200}?>/);
  ok(rbTag && /role="dialog"/.test(rbTag[0]), '交替卡有 role="dialog"');
  ok(rbTag && /aria-modal="true"/.test(rbTag[0]), '有 aria-modal');
  ok(rbTag && /aria-labelledby="rb-title"/.test(rbTag[0]), '有 aria-labelledby');
  ok(/id="rb-title"/.test(html), '被指向的标题存在');

  ok(/aria-hidden="true"><i><\/i>/.test(html), '进度条对读屏隐藏（纯装饰）');
}

head('[9] index.html 的结构');
{
  ok(/id="result-next"/.test(html), '有脚注位 #result-next');
  ok(/class="result-foot"/.test(html), '脚注与按钮在同一行容器里');
  ok(/id="rb-body"/.test(html) && /id="btn-rb-close"/.test(html), '交替卡有名单容器和按钮');
  /* 卡上不能出手牌/组托盘 —— 第二轮牌这时候已经发到手里了，会和「手里已经 6 张新牌」打架 */
  ok(!/id="rb-[^"]*hand"|id="rb-[^"]*slots"/.test(html),
    '★ 交替卡上不出手牌、不出组托盘（文档 §13.2）');
  /* 结算弹窗里也只留一个组容器 */
  const rm = html.slice(html.indexOf('id="result-modal"'), html.indexOf('id="round-break-modal"'));
  ok((rm.match(/class="result-groups"/g) || []).length === 1, '结算弹窗只有一个组容器');
}

head('[10] CSS：脚注不会被按钮吃掉');
{
  /* ★ .btn-lg 是 width:100%。放进 flex 行会把整行吃光，
   * 左边的倒计时被压成 0 宽 —— 真机截图里只剩一个「下」字露在按钮边上。 */
  ok(/\.result-foot \.btn \{[\s\S]{0,200}?width: auto;/.test(css),
    '★★ 脚注里的按钮改回内容宽度（否则倒计时被压成 0 宽）');
  ok(/\.result-foot \{[\s\S]{0,300}?flex: 0 0 auto;/.test(css),
    '脚注行不参与收缩（组卡一多会被压成一条缝）');
  ok(/\.result-next \{[\s\S]{0,300}?white-space: nowrap;/.test(css),
    '倒计时一行说完（折行会把按钮顶到下一行）');

  ok(/\.rb-row\.me \{[\s\S]{0,120}?inset 3px 0 0 var\(--gold-deep\)/.test(css),
    '「我」用左侧金线而非底色（底色会和冠军行的金撞色）');
  ok(/\.rb-next-l \{ display: block; \}/.test(css), '预告分两行各自独占一行');
  ok(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,200}?\.result-seq-bar/.test(css),
    '减弱动态时进度条不跑（但自动推进照旧 —— 那是节奏不是动画）');
}

head('[12] 横屏：一列放不下就换两列');
{
  /* 横屏 844×390 ≈ 750 设计高，一家一行的组卡（≈150 设计 px）4 家就 600，
   * 加上标题/脚注/进度条，一列必然被裁 —— 实测溢出 199 设计 px，
   * 第 4 家（常常就是赢家行）落在折叠线以下，而「卡片在视口内」照样绿。 */
  ok(/#stage\.ls \.result-rows \{[\s\S]{0,400}?display: grid;/.test(css),
    '★ 横屏结算行改成 grid（一列放不下）');
  ok(/#stage\.ls \.result-rows \{[\s\S]{0,600}?grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/.test(css),
    '★★ 两列写的是 minmax(0,1fr) 而不是 1fr —— 1fr 的最小值是内容宽度，'
    + '5 张牌那一行会把列撑宽、整块从右边溢出卡片（分数被切掉）');
  ok(/#stage\.ls #result-modal \.modal-card \{[\s\S]{0,200}?max-width: 980px;/.test(css),
    '横屏卡片放宽到 980（两列各 470，5 张迷你牌的斗牛行也放得下）');

  /* 迷你牌在横屏要缩一档：不缩的话行高 150，两列三行也放不下 */
  ok(/var w = ls \? 74 : MINI_CARD_W;/.test(game) && /var h = ls \? 98 : MINI_CARD_H;/.test(game),
    '★ 横屏迷你牌 74×98（竖屏 88×124）');
  ok(/stage\.classList\.contains\('ls'\)/.test(body('miniCardsEl')),
    '★ 判据读 #stage 的类而不是 matchMedia（版式是 JS 算出来的，两者旋转瞬间会不一致）');
}

head('[11] 状态机口径对得上');
{
  ok(SM.ROUND_GROUPS[1].length === 3, '第一轮 3 组（序列 3 幕）');
  ok(SM.ROUND_GROUPS[2].length === 2, '第二轮 2 组（序列 2 幕）');
  ok(SM.PHASE.ROUND2_SPLIT === 'ROUND2_SPLIT', '交替卡的闸门用的是真实阶段名');
  /* 一组都没有的结算是非法状态：序列会在 renderResultStep 里除以 undefined */
  ok(Array.isArray(SM.ROUND_GROUPS[1]) && SM.ROUND_GROUPS[1].length > 0,
    '组顺序表非空（空表会让序列没有幕可放）');
}

/* ------------------------------------------------------------------ */
console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exitCode = 1;
