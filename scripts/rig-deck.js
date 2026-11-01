/**
 * 发牌注入（仅审计用）—— 把一副牌的洗牌结果拧成指定顺序
 *
 * 为什么需要它：
 *   十点半 10.5 / 豹子 / 牛牛 / 五花牛 这四种牌型都是**小概率事件**
 *   （五花牛约 0.8%，豹子约 4.5%）。靠随机发牌「等它出现」来审计特效，
 *   要么永远等不到，要么等到了也复现不了。
 *
 * 为什么能这么做还算是真审计：
 *   注入点只有一个 —— `Card.shuffle` 的**顺序**。往后的每一环都是真的：
 *   真 stateMachine 发牌 / 真 seatRing / 真 group 装箱校验（submitGroups 会
 *   校验「必须用满 6 张手牌、不能有手牌以外的牌」）/ 真 engine 结算 /
 *   WebSocket 广播 / 真浏览器渲染。换句话说，被换掉的只有「牌堆顺序」，
 *   没有换掉任何一个判定或渲染环节 —— 而牌堆顺序本来就该是随机的。
 *
 * 用法（由 scripts/audit-pattern-fx.js 负责拉起，手写调试时）：
 *   LXW_RIG_FILE=/tmp/hand.json NODE_OPTIONS="--require .../rig-deck.js" node server/index.js
 *   hand.json 内容：{ "order": ["spade-14", "heart-14", ...] }
 *
 * ★ 每次洗牌都**重读**文件：一次服务端进程可以连验多个「把」，
 *   每把开始前改文件即可，不必反复重启（重启会丢房间，探针要重来一遍）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CARD_PATH = path.join(__dirname, '..', 'pwa', 'js', 'card.js');
const Card = require(CARD_PATH);
const FILE = process.env.LXW_RIG_FILE || '';

/* 只包一次：--require 在某些启动路径里可能被加载两次 */
if (!Card.__rigged) {
  const orig = Card.shuffle;

  Card.shuffle = function (arr) {
    let plan = null;
    try {
      plan = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
      plan = null;
    }
    if (!plan || !Array.isArray(plan.order) || !plan.order.length) return orig(arr);

    const pool = new Map();
    for (const c of arr) pool.set(c.suit + '-' + c.rank, c);

    const front = [];
    for (const id of plan.order) {
      const c = pool.get(id);
      /* 计划里出现这副牌没有的 id（拼错 / 上一把的残留）：
       * 直接放弃注入、走正常洗牌。**宁可这张牌随机，也不要悄悄少一张** ——
       * 少一张牌会让后面所有人手牌整体错位，探针会以为「注入生效了」却验错人。 */
      if (!c) return orig(arr);
      pool.delete(id);
      front.push(c);
    }
    const rest = [];
    pool.forEach((c) => rest.push(c));
    if (front.length + rest.length !== arr.length) return orig(arr);

    for (let i = 0; i < arr.length; i++) arr[i] = (i < front.length ? front[i] : rest[i - front.length]);
    return arr;
  };

  Card.__rigged = true;
}
