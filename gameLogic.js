// gameLogic.js —— 斗地主核心牌型逻辑(纯函数,可单元测试)
import crypto from 'crypto';

// 牌编码:0..51 为普通牌,id = rankIndex*4 + suit
// rankIndex: 0->'3', 1->'4', ... 10->'K', 11->'A', 12->'2'
// suit: 0..3 (♠♥♣♦,斗地主中花色无意义,仅用于区分四张)
// 52 = 小王, 53 = 大王
export const RANK_LABELS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
export const SUIT_LABELS = ['♠', '♥', '♣', '♦'];

// 牌面用于比较的“点数”:3..15(2=15),小王16,大王17
export function cardValue(card) {
  if (card === 52) return 16;
  if (card === 53) return 17;
  return Math.floor(card / 4) + 3;
}

export function cardLabel(card) {
  if (card === 52) return '小王';
  if (card === 53) return '大王';
  return SUIT_LABELS[card % 4] + RANK_LABELS[Math.floor(card / 4)];
}

export function isRed(card) {
  if (card === 53) return true; // 大王红
  if (card === 52) return false;
  const s = card % 4;
  return s === 1 || s === 3; // ♥♦ 红
}

// 生成一副牌(54 张)
export function makeDeck() {
  const deck = [];
  for (let i = 0; i < 54; i++) deck.push(i);
  return deck;
}

// 加密安全的 Fisher-Yates 洗牌 —— 保证发牌公平
export function shuffle(deck) {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    // crypto.randomInt 提供无偏的均匀随机数
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 发牌:三人各 17 张,底牌 3 张
export function deal() {
  const deck = shuffle(makeDeck());
  const hands = [
    deck.slice(0, 17),
    deck.slice(17, 34),
    deck.slice(34, 51),
  ].map(sortCards);
  const bottom = deck.slice(51, 54);
  return { hands, bottom };
}

// 按点数降序排序(同点数按花色),用于展示
export function sortCards(cards) {
  return cards.slice().sort((a, b) => {
    const dv = cardValue(b) - cardValue(a);
    if (dv !== 0) return dv;
    return b - a;
  });
}

// ====== 牌型识别 ======
// 返回 { type, main, len, bomb } 或 null(非法)
// type: single/pair/triple/triple_single/triple_pair/straight/straight_pair/
//       plane/plane_single/plane_pair/four_two_single/four_two_pair/bomb/rocket
// main: 用于比较大小的关键点数;len: 用于顺子/飞机的长度(其余为 1)
export function identify(cards) {
  const n = cards.length;
  if (n === 0) return null;
  const vals = cards.map(cardValue).sort((a, b) => a - b);
  const cnt = new Map();
  for (const v of vals) cnt.set(v, (cnt.get(v) || 0) + 1);
  const groups = [...cnt.entries()].sort((a, b) => a[0] - b[0]); // [value,count]
  const distinct = groups.map((g) => g[0]);

  // 连续判断(点数依次 +1,且最大不超过 A=14,不含 2 与王)
  const consec = (arr) =>
    arr.length > 0 &&
    arr.every((v, i) => (i === 0 ? true : v === arr[i - 1] + 1)) &&
    arr[arr.length - 1] <= 14;

  // 王炸
  if (n === 2 && cnt.has(16) && cnt.has(17)) return { type: 'rocket', main: 100, len: 1, bomb: true };
  // 炸弹
  if (n === 4 && groups.length === 1) return { type: 'bomb', main: groups[0][0], len: 1, bomb: true };

  if (n === 1) return { type: 'single', main: vals[0], len: 1 };
  if (n === 2 && groups.length === 1) return { type: 'pair', main: vals[0], len: 1 };
  if (n === 3 && groups.length === 1) return { type: 'triple', main: vals[0], len: 1 };

  // 三带一
  if (n === 4 && groups.length === 2) {
    const t = groups.find((g) => g[1] === 3);
    const s = groups.find((g) => g[1] === 1);
    if (t && s) return { type: 'triple_single', main: t[0], len: 1 };
  }
  // 三带二
  if (n === 5 && groups.length === 2) {
    const t = groups.find((g) => g[1] === 3);
    const p = groups.find((g) => g[1] === 2);
    if (t && p) return { type: 'triple_pair', main: t[0], len: 1 };
  }

  // 单顺(>=5 张连续单牌)
  if (n >= 5 && groups.every((g) => g[1] === 1) && consec(distinct)) {
    return { type: 'straight', main: distinct[distinct.length - 1], len: n };
  }
  // 连对(>=3 对连续)
  if (n >= 6 && n % 2 === 0 && groups.every((g) => g[1] === 2) && consec(distinct)) {
    return { type: 'straight_pair', main: distinct[distinct.length - 1], len: distinct.length };
  }

  // 四带二(单):四张 + 任意两张单(n=6)
  if (n === 6) {
    const four = groups.find((g) => g[1] === 4);
    if (four) {
      const restCount = groups.filter((g) => g !== four).reduce((s, g) => s + g[1], 0);
      if (restCount === 2) return { type: 'four_two_single', main: four[0], len: 1 };
    }
  }
  // 四带二(对):四张 + 两对(n=8)
  if (n === 8) {
    const four = groups.find((g) => g[1] === 4);
    if (four) {
      const rest = groups.filter((g) => g !== four);
      if (rest.length === 2 && rest.every((g) => g[1] === 2))
        return { type: 'four_two_pair', main: four[0], len: 1 };
    }
  }

  // 飞机(连续三张,带或不带翅膀)
  const plane = identifyPlane(cnt, n);
  if (plane) return plane;

  return null;
}

function identifyPlane(cnt, n) {
  const tripleVals = [...cnt.keys()].filter((v) => cnt.get(v) >= 3 && v <= 14).sort((a, b) => a - b);
  // 枚举连续的三张窗口(优先取长窗口)
  for (let i = 0; i < tripleVals.length; i++) {
    for (let j = tripleVals.length - 1; j >= i; j--) {
      let ok = true;
      for (let k = i + 1; k <= j; k++)
        if (tripleVals[k] !== tripleVals[k - 1] + 1) { ok = false; break; }
      if (!ok) continue;
      const t = j - i + 1;
      if (t < 2) continue;
      const core = tripleVals.slice(i, j + 1);
      const rem = new Map(cnt);
      for (const v of core) rem.set(v, rem.get(v) - 3);
      let remTotal = 0;
      for (const c of rem.values()) remTotal += c;
      const top = core[core.length - 1];
      // 纯飞机
      if (remTotal === 0 && n === 3 * t) return { type: 'plane', main: top, len: t };
      // 飞机带单
      if (n === 4 * t && remTotal === t) return { type: 'plane_single', main: top, len: t };
      // 飞机带对
      if (n === 5 * t && remTotal === 2 * t) {
        let allPairs = true;
        for (const c of rem.values()) if (c !== 0 && c !== 2) { allPairs = false; break; }
        if (allPairs) return { type: 'plane_pair', main: top, len: t };
      }
    }
  }
  return null;
}

// 判断 cur 能否压过 prev(prev 为 null 表示自由出牌)
export function canBeat(prev, cur) {
  if (!cur) return false;
  if (!prev) return true;
  if (cur.type === 'rocket') return true;
  if (cur.type === 'bomb') {
    if (prev.type === 'rocket') return false;
    if (prev.type === 'bomb') return cur.main > prev.main;
    return true; // 炸弹压普通牌
  }
  if (prev.bomb) return false; // 普通牌压不过炸弹/王炸
  if (cur.type !== prev.type) return false;
  if (cur.len !== prev.len) return false;
  return cur.main > prev.main;
}

// 校验 cards 是否为 hand 的子集(按 id 精确匹配)
export function isSubset(cards, hand) {
  const pool = hand.slice();
  for (const c of cards) {
    const idx = pool.indexOf(c);
    if (idx === -1) return false;
    pool.splice(idx, 1);
  }
  return true;
}

export function removeCards(hand, cards) {
  const pool = hand.slice();
  for (const c of cards) pool.splice(pool.indexOf(c), 1);
  return pool;
}

// 判断 hand 中是否存在任意一手能压过 last(last 为上家出的牌型对象)。
// 用于出牌计时:确定无牌可压时,只给 5 秒。
// 原则:宁可保守返回 true(给满 30 秒),只有确定压不过才返回 false。
export function canFollow(hand, last) {
  if (!last) return true; // 自由出牌,总能出
  const cnt = new Map();
  for (const c of hand) {
    const v = cardValue(c);
    cnt.set(v, (cnt.get(v) || 0) + 1);
  }
  const total = hand.length;
  // 王炸最大
  if (cnt.get(16) && cnt.get(17)) return true;
  const bombVals = [...cnt.entries()].filter(([, c]) => c >= 4).map(([v]) => v);
  if (last.bomb) {
    if (last.type === 'rocket') return false; // 王炸无法被压
    return bombVals.some((v) => v > last.main); // 上家炸弹:需更大炸弹
  }
  // 上家非炸弹:任意炸弹都能压
  if (bombVals.length) return true;

  const entries = [...cnt.entries()];
  switch (last.type) {
    case 'single':
      return entries.some(([v]) => v > last.main);
    case 'pair':
      return entries.some(([v, c]) => c >= 2 && v > last.main);
    case 'triple':
      return entries.some(([v, c]) => c >= 3 && v > last.main);
    case 'triple_single':
      return total >= 4 && entries.some(([v, c]) => c >= 3 && v > last.main);
    case 'triple_pair':
      for (const [v, c] of entries) {
        if (c >= 3 && v > last.main) {
          for (const [v2, c2] of entries) if (v2 !== v && c2 >= 2) return true;
        }
      }
      return false;
    case 'straight':
      return hasRun(cnt, last.len, 1, last.main);
    case 'straight_pair':
      return hasRun(cnt, last.len, 2, last.main);
    case 'plane':
    case 'plane_single':
    case 'plane_pair':
      // 只能被更大的飞机(同长度连续三张)或炸弹压;炸弹已在上面判断
      return hasRun(cnt, last.len, 3, last.main);
    case 'four_two_single':
    case 'four_two_pair':
      // 需要更大的四张;但有四张即为炸弹,已在上面返回 true,故此处必为 false
      return false;
    default:
      return true; // 未知牌型,保守给满时间
  }
}

// 是否存在长度为 len 的连续点数(每个点数张数 >= need,且最高点 > gtMain,点数 <= 14)
function hasRun(cnt, len, need, gtMain) {
  for (let top = 14; top - len + 1 >= 3; top--) {
    if (top <= gtMain) continue;
    let ok = true;
    for (let v = top - len + 1; v <= top; v++) {
      if ((cnt.get(v) || 0) < need) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}
