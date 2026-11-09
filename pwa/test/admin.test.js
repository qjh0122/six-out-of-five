/**
 * 管理后台静态契约测试（pwa/admin.html）。
 *
 * 后台是个独立页面，不参与运行时测试。但它有一类容易悄悄坏掉的地方：
 * 页面里写死了一串 /api/admin/* 路径，服务端一旦改名，前端不会报错，
 * 只会静默「载入失败」。这里把两边字符串对一遍，防止漂移。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, '..', 'server', 'index.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg); }
}

console.log('\n[页面存在且不被索引]');
ok(html.length > 2000, 'admin.html 有实际内容');
ok(/<meta\s+name="robots"\s+content="noindex/i.test(html), '带 noindex，不会被搜索引擎收录');
ok(!/<script[^>]+src=/.test(html), '不引游戏脚本（自己一套极简逻辑，避免被 750px 舞台样式拖进来）');
ok(html.indexOf('game.js') < 0, '没有混入 game.js');

console.log('\n[接口路径与服务端一致]');
// 页面里所有 call('METHOD', '/path') 的路径
const calls = [];
const re = /call\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/g;
let m;
while ((m = re.exec(html))) calls.push({ method: m[1], path: m[2] });
ok(calls.length >= 5, '页面里找到 ' + calls.length + ' 处后台调用');

const missing = calls.filter((c) => server.indexOf("'/api" + c.path + "'") < 0);
ok(missing.length === 0, '每个路径在服务端都有对应路由' + (missing.length ? ' → 缺失 ' + missing.map((c) => c.path).join(',') : ''));

ok(calls.some((c) => c.path === '/admin/users' && c.method === 'GET'), 'GET /admin/users（列表）');
ok(calls.some((c) => c.path === '/admin/nickname' && c.method === 'POST'), 'POST /admin/nickname（改昵称）');
ok(calls.some((c) => c.path === '/admin/password' && c.method === 'POST'), 'POST /admin/password（重置密码）');
ok(calls.some((c) => c.path === '/admin/disable' && c.method === 'POST'), 'POST /admin/disable（停用/恢复）');
ok(calls.some((c) => c.path === '/admin/delete' && c.method === 'POST'), 'POST /admin/delete（删号）');

console.log('\n[鉴权]');
ok(/x-backup-key/.test(html), '所有请求都带 x-backup-key');
ok(/sessionStorage/.test(html), '密钥只存 sessionStorage（关标签页即失效，不长期落在设备上）');
ok(/KEY_STORE_LEGACY/.test(html), '兼容旧版 sessionStorage 里的密钥（升级不丢登录态）');
ok(/401|403|无权/.test(html) || /error/.test(html), '有失败态提示，不是静默失败');

console.log('\n[视觉与游戏一致]');
ok(/#0F2B22/i.test(html) && /#F5C15C/i.test(html), '沿用游戏的深绿 + 金色两色');
ok(/--warm-white:\s*#FFF7E8/i.test(html), '沿用暖白文字色');
ok(/linear-gradient/.test(html) && /border-radius/.test(html), '面板有渐变与圆角，不是裸表格');

console.log('\n[窄屏可用性（这几条是真机踩过的坑）]');
ok(/@media\s*\(max-width:\s*620px\)/.test(html), '有窄屏断点');
ok(/\.table-scroll\s*\{[^}]*overflow-x:\s*auto/.test(html), '表格横向滚动收在面板里（否则整页横溢 325px）');
ok(/\.col-games,\s*\.col-last\s*\{\s*display:\s*none/.test(html), '窄屏隐藏场次/最后登录两列，保住状态与操作列');
ok(/\.acts\s*\{\s*display:\s*grid/.test(html), '操作按钮走 2×2 网格（自由换行会散成参差三行）');
// 曾经把 width:100% 写在 button.mini 上，把「刷新」也撑成了整行。
// 注意要排掉「.acts button.mini」——否则这条会误伤自己的那条正确规则。
ok(!/(?<!\.acts\s)button\.mini\s*\{[^}]*width:/.test(html), 'width:100% 没漏到 button.mini（会撑歪刷新按钮）');
ok(/\.acts\s+button\.mini\s*\{[^}]*width:\s*100%/.test(html), 'width:100% 只作用于操作区按钮');

console.log('\n[安全相关]');
ok(/function esc\(/.test(html), '有 HTML 转义函数');
// 六个可注入字段都必须过 esc()
const escUses = (html.match(/esc\(/g) || []).length;
ok(escUses >= 6, '账号/昵称等用户数据渲染前都转了义（' + escUses + ' 处）');
ok(html.indexOf("esc(u.account)") >= 0 && html.indexOf("esc(u.nickname") >= 0, '账号名与昵称确实过 esc()');

console.log('\n[三个页签]');
ok(/data-tab="users"/.test(html) && /data-tab="bot"/.test(html) && /data-tab="board"/.test(html), '用户管理 / 模拟对战 / 排行榜 三个页签');
ok(/id="pane-users"/.test(html) && /id="pane-bot"/.test(html) && /id="pane-board"/.test(html), '三个面板容器都在');

console.log('\n[模拟对战：能选人、能定场数局数]');
ok(calls.some((c) => c.path === '/admin/bot/start' && c.method === 'POST'), 'POST /admin/bot/start（启动任务）');
ok(calls.some((c) => c.path === '/admin/bot/jobs' && c.method === 'GET'), 'GET /admin/bot/jobs（进度轮询）');
ok(calls.some((c) => c.path === '/admin/bot/job' && c.method === 'GET'), 'GET /admin/bot/job（逐把明细）');
ok(calls.some((c) => c.path === '/admin/bot/stop' && c.method === 'POST'), 'POST /admin/bot/stop（停止）');
ok(/id="bot-rooms"/.test(html), '有「对战场数」输入');
ok(/id="bot-hands"/.test(html), '有「每场局数」选择');
ok(/<option value="3"/.test(html) && /<option value="30"/.test(html), '局数选项覆盖 3~30（建房白名单）');
ok(/data-acc=/.test(html) && /input\[type="checkbox"\]/.test(html), '玩家池用勾选框选人');
ok(/pool-count/.test(html), '显示已选人数（2~5 人约束）');

console.log('\n[排行榜页]');
ok(calls.some((c) => c.path === '/admin/leaderboard' && c.method === 'GET'), 'GET /admin/leaderboard（完整名次）');
ok(/名次/.test(html) && /净胜/.test(html), '表头含名次与净胜');

console.log('\n[密钥与密码的存储策略]');
/* 2026-11-09 起按使用者要求改成「默认记住」：密钥与账号密码都存 localStorage，
 * 免得每次刷新重填。便利性成了需求，但下面四条是不能丢的底线 ——
 * 丢了以后页面照样能用，只是密码长期躺在浏览器里、而且没有出口。 */
ok(/localStorage\.setItem\(KEY_STORE, key\(\)\)/.test(html), '密钥存本机（下次打开自动载入）');
ok(/localStorage\.setItem\(PW_STORE, JSON\.stringify\(pwMap\)\)/.test(html), '账号密码存本机');
ok(/function rememberPw/.test(html) && /#pw-remember/.test(html), '有「记住密码」开关（关掉就只留内存）');
ok(/function clearPwMap/.test(html) && /#btn-pw-clear/.test(html), '有「清除已存」的出口');
ok(!/sessionStorage\.setItem\([^)]*[Pp]assword/.test(html), '不把密码写进 sessionStorage');
ok(!/console\.log\([^)]*password/i.test(html), '不把密码打进控制台');

console.log('\n[跑完能再跑一次 / 流水不丢状态 / 打法可选]');
/* 这三条对应 2026-11-09 反馈的三个真问题，都是「代码在、行为不对」，
 * 静态契约先钉住形状，真正的行为由 scripts/probe-admin.js 在浏览器里点。 */
ok(/if \(!running\) updatePoolCount\(\);/.test(html), '任务结束后按勾选恢复「开始模拟」（不用刷新）');
ok(/id="job-hands"/.test(html) && /#job-hands/.test(html), '逐把流水有独立容器，不跟摘要一起重绘');
ok(/#job-hands'\)\.addEventListener\('click'/.test(html), '流水的展开/收起走事件委托（面板是增量建的）');
ok(/pollTick % 2 === 0\) loadJobDetail/.test(html), '跑的过程中定时刷新流水（条数跟得上已完成把数）');
ok(/#bot-strategy/.test(html) && /strategy: \$\('#bot-strategy'\)/.test(html), '打法可选（smart 挑牌 / naive 按位置）');

console.log('\n[逐把流水：按场分组 / 不跳回顶部 / 累计净胜单起一条]');
/* 2026-11-10 的第二轮反馈。三条都不是「功能没有」，是「有了但不好用」，
 * 所以契约要钉的是**结构选择**，不只是一句文案：
 *   分组 → 每场一个 data-room 面板；
 *   不跳顶 → 复用同一个面板 + 重建 tbody 前后搬 scrollTop；
 *   累计净胜 → 单独一条，且不许再占表头（表头就是「本把盈亏」）。 */
ok(/det\.setAttribute\('data-room', key\)/.test(html), '流水按场分组：每场一个独立面板');
ok(/handsUI\.rooms\[key\] = ui/.test(html) && /if \(!ui\) \{/.test(html),
  '面板按场复用同一个 DOM 节点（重建才会丢展开状态与滚动位置）');
ok(/scrollTop = prevTop/.test(html) && /ui\.stick/.test(html),
  '重绘后把 scrollTop 搬回去（新记录不会把页面顶回第一条）');
ok(/scrollHeight - ui\.sc\.scrollTop - ui\.sc\.clientHeight < 24/.test(html),
  '贴着底部才继续跟随，用户往上翻就停（不在看历史时把人拽走）');
ok(/class="hands-sum"/.test(html) && /<th>本把盈亏<\/th>/.test(html),
  '累计净胜单起一条，表头写「本把盈亏」');
ok(!/<th>累计净胜<\/th>/.test(html), '不再把「累计净胜」当表头（格子里装的是本把）');

console.log('\n[轮询只在需要时开]');
ok(/function startPoll\(/.test(html) && /function stopPoll\(/.test(html), '有轮询开关');
ok(/if \(name === 'bot'\) \{ startPoll\(\); \} else \{ stopPoll\(\); \}/.test(html), '只在模拟对战页签轮询，切走就停');

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
