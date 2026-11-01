/**
 * 服务端集成测试的账号辅助
 *
 * 为什么需要它：WS 身份改成「必须先用登录令牌 auth」之后，
 * 测试不能再靠 payload.playerId 自称是谁——那正是被堵掉的洞。
 * 所以每个测试玩家都要真实注册一个账号、拿真令牌，走和生产一样的链路。
 *
 * 注册一次约 60~80ms（scrypt 成本），单个套件最多几个玩家，可以接受。
 */
'use strict';

const http = require('http');

/** 发一个 JSON 请求，永远 resolve（失败用 status 判断），避免测试里到处 try/catch */
function httpJson(port, method, path, body, headers) {
  return new Promise((resolve) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
    const req = http.request({
      host: '127.0.0.1',
      port: port,
      path: path,
      method: method,
      headers: h
    }, (res) => {
      let buf = '';
      res.on('data', (d) => buf += d);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { /* 非 JSON 响应 */ }
        /* headers 一并带出去：缓存头（Cache-Control）这类断言只能从响应头看，
         * 以前这里只回 status/json/raw，测不了「/sw.js 是不是 no-store」。 */
        resolve({ status: res.statusCode, json: json, raw: buf, headers: res.headers });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, raw: String(e && e.message) }));
    if (data) req.write(data);
    req.end();
  });
}

/** 带 Bearer 令牌的请求 */
/**
 * 带令牌请求。走自定义头 `X-Session-Token`——和前端线上实际用法一致
 * （部署网关会把 `Authorization` 消费掉，后端收不到）。
 */
function httpAuth(port, method, path, token, body) {
  return httpJson(port, method, path, body, token ? { 'X-Session-Token': token } : {});
}

/** 老写法兼容性：`Authorization: Bearer` 在本地/调试场景仍应可用 */
function httpAuthBearer(port, method, path, token, body) {
  return httpJson(port, method, path, body, token ? { Authorization: 'Bearer ' + token } : {});
}

let seq = 0;

/**
 * 注册一个新玩家，返回 { name, password, token, playerId }。
 * 账号名带随机后缀 + 递增序号，避免同进程内重复。
 */
async function registerPlayer(port, nickname) {
  seq += 1;
  const name = 't' + seq + Math.random().toString(36).slice(2, 8);
  const password = 'pw-' + Math.random().toString(36).slice(2, 12);
  const r = await httpJson(port, 'POST', '/api/auth/register', {
    name: name,
    password: password,
    nickname: nickname || ''
  });
  if (r.status !== 200 || !r.json || !r.json.ok) {
    throw new Error('测试账号注册失败：' + r.status + ' ' + r.raw);
  }
  return {
    name: name,
    password: password,
    token: r.json.token,
    playerId: r.json.me.playerId,
    nickname: r.json.me.nickname
  };
}

/** 用已有账号名/密码登录，拿新令牌（测「换设备」） */
async function loginPlayer(port, name, password) {
  const r = await httpJson(port, 'POST', '/api/auth/login', { name: name, password: password });
  return r;
}

module.exports = { httpJson, httpAuth, httpAuthBearer, registerPlayer, loginPlayer };
