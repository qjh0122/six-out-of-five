/**
 * manifest 的图标内联（部署网关要求每个请求带 sharecode）
 * 跑法：node server/test/manifest.test.js
 *
 * 为什么这条必须有单测：
 * 线上曾经是「页面全对、图标全裂」—— manifest 与 apple-touch-icon 一律 403。
 * 第一版修法是「给图标 URL 拼上 sharecode」，部署后实测**没生效**：
 * 网关会校验 sharecode，但转发给应用时把 query 剥掉了，服务端拿不到。
 *
 * 所以改成把图标**内联成 data URI** —— 不需要任何网络请求，天然绕开网关。
 * 这条测试就是钉住这个决定：几个图标必须是 data URI，而且 base64 解出来得是真 PNG。
 *
 * 「浏览器到底能不能装上」由 scripts/probe-manifest.js 用真 Edge 验
 * （Page.getAppManifest + Page.getInstallabilityErrors）。两者不重复：
 * 一个测服务端输出，一个测浏览器认不认。
 */
'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

process.env.PROFILE_FILE = path.join(os.tmpdir(), 'lxw-mf-test-' + Date.now() + '.json');
process.env.SEED_FILE = path.join(os.tmpdir(), 'lxw-mf-test-seed-' + Date.now());
process.env.PORT = process.env.PORT || '3211';
const PORT = Number(process.env.PORT);

const { server } = require('../index.js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expect ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

/** 发一个 GET / HEAD，可选 gzip。返回 { status, headers, text } */
function req(pathname, opts) {
  const o = opts || {};
  const headers = {};
  if (o.gzip) headers['Accept-Encoding'] = 'gzip';
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: o.method || 'GET', headers: headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') {
          try { buf = zlib.gunzipSync(buf); } catch (e) { /* 解不开就留着原字节，断言会红 */ }
        }
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8') });
      });
    });
    r.on('error', (e) => resolve({ status: 0, headers: {}, text: String(e && e.message) }));
    r.end();
  });
}

function parse(r) {
  try { return JSON.parse(r.text); } catch (e) { return null; }
}

/** data:image/png;base64,xxxx → Buffer；不是 PNG 的 data URI 返回 null */
function decodePng(src) {
  if (typeof src !== 'string') return null;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(src);
  if (!m) return null;
  try { return Buffer.from(m[1], 'base64'); } catch (e) { return null; }
}

/** PNG 魔数：89 50 4E 47 0D 0A 1A 0A */
function isPng(buf) {
  return !!buf && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50
    && buf[2] === 0x4e && buf[3] === 0x47;
}

async function run() {
  if (!server.listening) {
    await new Promise((resolve) => server.once('listening', resolve));
  }

  const CODE = 'TESTCODE';
  const withCode = await req('/manifest.webmanifest?sharecode=' + CODE);
  const doc = parse(withCode);

  console.log('\n[1] 图标必须内联成 data URI（不再依赖任何网络请求）');
  eq(withCode.status, 200, 'manifest 200');
  ok(!!doc, '是合法 JSON', withCode.text.slice(0, 120));
  eq(withCode.headers['content-type'], 'application/manifest+json; charset=utf-8', 'Content-Type 正确');
  ok(doc && doc.icons && doc.icons.length === 4, '4 张图标（含两张 maskable）', doc && doc.icons && doc.icons.length);

  const srcs = doc && doc.icons ? doc.icons.map((i) => i.src) : [];
  ok(srcs.length === 4 && srcs.every((s) => s.indexOf('data:image/png;base64,') === 0),
    '★ 每张都是 data URI（不是 /icons/... 这种会被网关 403 的路径）',
    srcs.map((s) => String(s).slice(0, 28)));

  /* 只断言「以 data: 开头」不够 —— 拼错的 base64 也是 data: 开头，
   * 浏览器拿到会当成坏图，安装直接失败。所以解出来验 PNG 魔数。 */
  const decoded = srcs.map(decodePng);
  ok(decoded.every(isPng), '★ base64 解出来是合法 PNG（魔数 89 50 4E 47）',
    decoded.map((b) => (b ? b.length : 'null')));

  /* 尺寸与用途不能丢：Chrome 生成 WebAPK 时要按 sizes 挑图，
   * maskable 那两张丢了 purpose 就不是自适应图标了。 */
  ok(doc && doc.icons.filter((i) => i.purpose === 'maskable').length === 2,
    '两张 maskable 的 purpose 还在', doc && JSON.stringify(doc.icons.map((i) => i.purpose)));
  const sizes = doc && doc.icons ? doc.icons.map((i) => i.sizes).join(',') : '';
  eq(sizes, '192x192,512x512,192x192,512x512', '四张图的 sizes 都还在');

  console.log('\n[2] screenshots 从响应里去掉');
  /* 两张 webp 内联后约 150KB，而浏览器每次加载页面都会抓 manifest。
   * 留着更糟：它们的 URL 拼不上码，只会稳定 403。 */
  ok(doc && !('screenshots' in doc), '★ 响应里没有 screenshots（不内联、也不留 403 的死链）',
    doc && JSON.stringify(doc.screenshots));

  console.log('\n[3] start_url / id 不许带码');
  eq(doc && doc.start_url, '/', '★ start_url 是 "/"（写死码会破坏轮换自愈）');
  eq(doc && doc.id, '/', 'id 是 "/"（改了等于换一个应用）');

  console.log('\n[4] 与 sharecode 无关 —— 带不带码返回完全一致');
  /* 这是这一版和上一版最本质的差别。上一版「带码才改写」，
   * 而网关会把 query 剥掉，所以线上永远走「不带码」那条路 —— 看着逻辑对，实际没跑。 */
  const bare = await req('/manifest.webmanifest');
  const bdoc = parse(bare);
  eq(bare.status, 200, '无码也 200');
  ok(bare.text === withCode.text, '★ 带码与不带码的响应逐字节相同（不再依赖 query）',
    'len ' + bare.text.length + ' vs ' + withCode.text.length);
  ok(bdoc && bdoc.icons.every((i) => i.src.indexOf('data:') === 0), '无码时同样是 data URI');
  ok(withCode.text.indexOf('sharecode=') < 0, '响应里不出现 sharecode= 字样（没有任何待抓的 URL）');

  console.log('\n[5] 缓存头：manifest 必须 no-store');
  ok(/no-store/.test(withCode.headers['cache-control'] || ''),
    'Cache-Control 含 no-store', withCode.headers['cache-control']);
  ok(/no-store/.test(bare.headers['cache-control'] || ''), '无码路径同样 no-store');

  console.log('\n[6] gzip：解压后仍是合法 JSON');
  const gz = await req('/manifest.webmanifest?sharecode=' + CODE, { gzip: true });
  eq(gz.headers['content-encoding'], 'gzip', '带 Accept-Encoding 时确实压缩了');
  const gdoc = parse(gz);
  ok(!!gdoc && gdoc.icons.length === 4, '解压后是完整的 manifest', gz.text.slice(0, 80));
  ok(gdoc && isPng(decodePng(gdoc.icons[0].src)), '压缩路径里的图标也能解出 PNG');
  /* Content-Length 必须是**压缩后**的长度。写成原始长度是这类实现最常见的错 ——
   * 浏览器按原长等数据，直接卡住。 */
  const rawLen = Number(gz.headers['content-length']);
  ok(rawLen > 0 && rawLen < Buffer.byteLength(withCode.text),
    '★ Content-Length 是压缩后的长度（不是原始长度）', rawLen + ' vs ' + Buffer.byteLength(withCode.text));

  console.log('\n[7] HEAD：要 200 且不发 body');
  const head = await req('/manifest.webmanifest', { method: 'HEAD' });
  eq(head.status, 200, 'HEAD 200');
  eq(head.text, '', 'HEAD 没有 body');
  ok(Number(head.headers['content-length']) > 0, 'HEAD 仍给出 Content-Length', head.headers['content-length']);

  console.log('\n[8] 别把别的文件也当成 manifest 改写');
  const index = await req('/index.html');
  ok(index.status === 200 && /<title>/.test(index.text), 'index.html 仍然按原样发（没被误改）');
  const css = await req('/css/style.css');
  ok(css.status === 200 && css.headers['content-type'].indexOf('text/css') === 0, 'CSS 仍是 text/css');
  const icon = await req('/icons/icon-192.png');
  ok(icon.status === 200 && icon.headers['content-type'] === 'image/png', '图标文件本身仍可正常取（离线/别处要用）');

  server.close();
  await new Promise((r) => setTimeout(r, 200));
  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.log('  异常：' + (e && e.stack ? e.stack.split('\n')[0] : e));
  process.exit(1);
});
