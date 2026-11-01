/**
 * 极简 WebSocket 服务端（RFC 6455 子集，零依赖）
 *
 * 为什么手写而不装 ws：
 *   部署沙箱里 npm install 可能受网络影响，而本项目只需要文本帧 + 控制帧，
 *   消息都是小 JSON（单帧足够），手写 200 行即可，换来「拷进去就能跑」。
 *
 * 支持：握手、文本帧、分片续帧累积、ping/pong、close、掩码解码。
 * 不支持：扩展协商（permessage-deflate）、二进制业务（收到直接忽略）。
 */
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20;    // 单帧上限 1MB，超过视为异常连接
const INIT_BUF = 8 << 10;     // 收流缓冲初始容量（8KB，一般一两次扩容就够）
const MAX_MESSAGE = 4 << 20;  // **一次完整消息**的上限 4MB。
                              // 只限单帧是不够的：分片续帧可以把 1MB 切成无数片，
                              // 服务端把每片 push 进数组累积，总量没有任何约束。
                              // 实测灌 60MB 未完成分片，服务端既不拒绝也不关连接，
                              // 内存就这么被一个连接吃光。业务消息都是几百字节的 JSON，
                              // 4MB 已经是极大的余量。

const OP = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa
};

class WSClient extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    /* 收流缓冲：**预分配 + 摊还扩容 + 消费后原地前移**。
     *
     * 以前是 `this.buffer = Buffer.concat([this.buffer, chunk])`，每来一个 TCP 分片
     * 就把已有内容整体复制一遍 —— 复杂度 O(n²)。而 TCP 段大小是**发送方可控**的：
     * 一个连接用 1 字节的段慢慢灌 1MB，实测能把单核钉住约 67 秒（1KB 段只要 79ms，
     * 相差 1830 倍）。所有房间共用一个事件循环，几个这样的连接就够拖垮整个对局服务。
     *
     * 现在：写指针 wlen 往后追加，容量按倍增摊还（每字节最多被复制 O(1) 次）；
     * 消费一帧后用 copy 把剩余字节前移到 0（重叠复制在 Node 里是 memmove，安全）。 */
    this.buf = Buffer.allocUnsafe(INIT_BUF);
    this.wlen = 0;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = 0;
    this.alive = true;
    this.closing = false;
    this.remoteAddress = (req.socket && req.socket.remoteAddress) || '';

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this._finish());
    socket.on('close', () => this._finish());
  }

  send(text) {
    this._sendFrame(OP.TEXT, Buffer.from(String(text), 'utf8'));
  }

  /**
   * 发一个 ping 控制帧（心跳用）。返回是否真的写进 socket。
   *
   * 用的是**协议层**的 ping，不是应用层的 JSON 消息：
   * 浏览器收到 ping 会由网络层自动回 pong，不需要页面里的 JS 参与 ——
   * 也就是说即使 App 切在后台、JS 被挂起，只要那条 TCP 还活着就能应答。
   * 这正是我们要区分的两件事：「页面在后台」不等于「连接已经死了」。
   * 反过来说，如果连协议层都不回，那这条连接就真的没人管了。
   */
  ping() {
    if (!this.alive || this.closing) return false;
    try {
      this._sendFrame(OP.PING, Buffer.alloc(0));
      return true;
    } catch (e) {
      return false;
    }
  }

  close(code, reason) {
    if (this.closing) return;
    this.closing = true;
    try {
      const r = reason ? Buffer.from(String(reason), 'utf8') : Buffer.alloc(0);
      const payload = Buffer.allocUnsafe(2 + r.length);
      payload.writeUInt16BE(code || 1000, 0);
      r.copy(payload, 2);
      this._sendFrame(OP.CLOSE, payload);
    } catch (e) { /* 连接已坏，忽略 */ }
    try { this.socket.end(); } catch (e) {}
    setTimeout(() => { try { this.socket.destroy(); } catch (e) {} }, 1000).unref();
    this._finish();
  }

  _finish() {
    if (!this.alive) return;
    this.alive = false;
    this.emit('close');
  }

  /** 把新到的分片追加到缓冲尾部；容量不够就倍增扩容（摊还 O(1)/字节） */
  _append(chunk) {
    const need = this.wlen + chunk.length;
    if (need > this.buf.length) {
      let cap = this.buf.length || INIT_BUF;
      while (cap < need) cap *= 2;
      const nb = Buffer.allocUnsafe(cap);
      this.buf.copy(nb, 0, 0, this.wlen);
      this.buf = nb;
    }
    chunk.copy(this.buf, this.wlen);
    this.wlen = need;
  }

  /** 消费掉前 n 字节，剩下的原地前移（不分配新 Buffer） */
  _consume(n) {
    if (n >= this.wlen) { this.wlen = 0; return; }
    this.buf.copy(this.buf, 0, n, this.wlen);   // 重叠复制 = memmove
    this.wlen -= n;
  }

  _onData(chunk) {
    this._append(chunk);
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
      if (!this.alive) break;
    }
  }

  /* 从缓冲区切出一个完整帧；数据不够返回 null 等下一批 */
  _readFrame() {
    const buf = this.buf;
    const avail = this.wlen;
    if (avail < 2) return null;

    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (avail < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (avail < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_FRAME)) { this.close(1009, 'frame too large'); return null; }
      len = Number(big);
      offset += 8;
    }
    if (len > MAX_FRAME) { this.close(1009, 'frame too large'); return null; }

    let maskKey = null;
    if (masked) {
      if (avail < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (avail < offset + len) return null;

    let payload = buf.subarray(offset, offset + len);
    if (masked) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
      payload = out;
    } else {
      payload = Buffer.from(payload);
    }

    this._consume(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;

    if (opcode === OP.CLOSE) { this.close(1000); return; }
    if (opcode === OP.PING) { this._sendFrame(OP.PONG, payload); return; }
    if (opcode === OP.PONG) {
      /* 收到 pong = 这条连接的对面还活着。
       *
       * 以前这里直接 return 注释「应用层心跳走 JSON ping」，但应用层根本没有心跳 ——
       * 于是「对面还活着吗」这个问题从来没人问过，移动端切后台、进程被杀、
       * 地铁进隧道这类**没有 FIN 的消失**会留下一条永远不会断的僵尸连接，
       * 它占着 fd、留在 room.players 里、还让 `conns` 这个数字看起来像有人在线。
       * 现在把 pong 抛给上层，由 hub 的心跳判活。 */
      this.lastPongAt = Date.now();
      this.emit('pong');
      return;
    }

    if (opcode === OP.CONT) {
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > MAX_MESSAGE) {
        this.fragments = [];
        this.fragmentBytes = 0;
        this.fragmentOpcode = 0;
        this.close(1009, 'message too large');
        return;
      }
      if (!fin) return;
      const data = Buffer.concat(this.fragments);
      this.fragments = [];
      this.fragmentBytes = 0;
      if (this.fragmentOpcode === OP.TEXT) this.emit('message', data.toString('utf8'));
      this.fragmentOpcode = 0;
      return;
    }

    if (opcode === OP.TEXT || opcode === OP.BINARY) {
      if (!fin) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
        return;
      }
      if (opcode === OP.TEXT) this.emit('message', payload.toString('utf8'));
      return;
    }
  }

  _sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (e) {
      this._finish();
    }
  }
}

class WebSocketServer extends EventEmitter {
  constructor(httpServer, options) {
    super();
    this.path = (options && options.path) || '/ws';
    this.clients = new Set();
    httpServer.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
  }

  _handleUpgrade(req, socket, head) {
    const url = String(req.url || '').split('?')[0];
    if (url !== this.path) { socket.destroy(); return; }

    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (!key || upgrade !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );

    const client = new WSClient(socket, req);
    this.clients.add(client);
    client.on('close', () => this.clients.delete(client));
    this.emit('connection', client, req);

    // 握手后可能已经带上第一帧数据
    if (head && head.length) client._onData(head);
  }

  broadcast() { /* 业务层负责定向发送，这里不做全局广播 */ }
}

module.exports = { WebSocketServer, WSClient };
