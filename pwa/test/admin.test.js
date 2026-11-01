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
ok(!/localStorage/.test(html), '不把管理密钥写进 localStorage');
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

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
