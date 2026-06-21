// server.js —— 斗地主服务端(Express + Socket.IO)
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  deal, identify, canBeat, canFollow, isSubset, removeCards, sortCards, cardLabel,
} from './gameLogic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// 出牌/叫分计时
const TURN_SECONDS = 30;       // 界面显示的回合时长
const NO_FOLLOW_SECONDS = 5;   // 确定压不过上家时的实际时长(界面仍显示 30s)

const TYPE_NAMES = {
  single: '单张', pair: '对子', triple: '三张', triple_single: '三带一', triple_pair: '三带二',
  straight: '顺子', straight_pair: '连对', plane: '飞机', plane_single: '飞机带单',
  plane_pair: '飞机带对', four_two_single: '四带二', four_two_pair: '四带两对',
  bomb: '炸弹', rocket: '王炸',
};

// ====== 账号系统(固定账号,密码=账号+621) ======
// 分数按「房间」计算,开房即从 0 开始,因此不做账号级分数持久化。
const ACCOUNT_NAMES = ['sjb', 'mzs', 'fyb', 'lgr', 'zh', 'ylw', 'zy', 'wsq', 'lxy'];
const players = new Map(); // username -> { id, username, password, name, socketId, roomId }

for (const name of ACCOUNT_NAMES) {
  players.set(name, {
    id: name,
    username: name,
    password: name + '621',
    name,
    socketId: null,
    roomId: null,
  });
}

// ====== 房间 ======
const rooms = new Map(); // roomId -> Room

class Room {
  constructor(name) {
    this.id = 'R' + crypto.randomInt(100000, 999999);
    this.name = name || ('房间' + this.id.slice(1));
    this.seats = [null, null, null]; // 每个为 playerId 或 null
    this.spectators = new Set();
    this.scores = {}; // playerId -> 本房间内累计总分(开房即从 0 开始)
    this.phase = 'waiting'; // waiting | bidding | playing | finished
    this.resetRound();
    this.log = [];
    this.dealerSeat = crypto.randomInt(3); // 首叫座位,每局轮换
  }

  resetRound() {
    this.hands = [[], [], []];
    this.bottom = [];
    this.bottomRevealed = false;
    this.bids = [null, null, null]; // 每座位叫分:null未叫,0不叫,1/2/3
    this.currentBidder = -1;
    this.bidStartSeat = -1;
    this.bidActions = 0;
    this.highestBid = 0;
    this.highestBidder = -1;
    this.landlord = -1;
    this.turn = -1;
    this.lastPlay = null; // { seat, cards, move }
    this.passesInRow = 0;
    this.lastActions = [null, null, null]; // 'pass' | {cards} | null
    this.multiplier = 1;
    this.baseScore = 0;
    this.bombCount = 0;
    this.farmerPlays = 0;
    this.landlordPlays = 0;
    this.result = null;
    this.turnSeq = (this.turnSeq || 0) + 1; // 回合序号,每次轮转 +1(用于计时)
    this.turnStartTime = Date.now();
  }

  seatedPlayerIds() {
    return this.seats.filter(Boolean);
  }
  seatOf(playerId) {
    return this.seats.indexOf(playerId);
  }
  isFull() {
    return this.seats.every(Boolean);
  }
  isEmpty() {
    return this.seatedPlayerIds().length === 0 && this.spectators.size === 0;
  }

  addLog(msg) {
    this.log.push(msg);
    if (this.log.length > 40) this.log.shift();
  }

  // 切换当前回合并刷新计时
  setTurn(seat) {
    this.turn = seat;
    this.turnSeq = (this.turnSeq || 0) + 1;
    this.turnStartTime = Date.now();
  }

  // 全员准备状态(用 ready 标记在 player 对象上,简单存到房间)
  ready = [false, false, false];

  startRoundIfReady() {
    if (this.phase !== 'waiting') return false;
    if (!this.isFull()) return false;
    if (!this.ready.every(Boolean)) return false;
    this.startRound();
    return true;
  }

  startRound() {
    this.resetRound();
    const d = deal();
    this.hands = d.hands;
    this.bottom = d.bottom;
    this.phase = 'bidding';
    this.bidStartSeat = this.dealerSeat;
    this.currentBidder = this.dealerSeat;
    this.setTurn(this.dealerSeat);
    this.addLog('🎴 新一局开始,开始叫分');
  }

  doBid(seat, value) {
    if (this.phase !== 'bidding') return { err: '现在不是叫分阶段' };
    if (seat !== this.currentBidder) return { err: '还没轮到你叫分' };
    if (![0, 1, 2, 3].includes(value)) return { err: '叫分非法' };
    if (value !== 0 && value <= this.highestBid) return { err: '必须比当前最高分高(或选择不叫)' };
    this.bids[seat] = value;
    this.bidActions++;
    const pname = players.get(this.seats[seat])?.name || '玩家';
    if (value === 0) this.addLog(`${pname} 不叫`);
    else this.addLog(`${pname} 叫 ${value} 分`);
    if (value > this.highestBid) {
      this.highestBid = value;
      this.highestBidder = seat;
    }
    // 叫到 3 分直接结束
    if (value === 3) return this.finishBidding();
    // 三人都叫过
    if (this.bidActions >= 3) return this.finishBidding();
    // 轮到下一位
    this.currentBidder = (this.currentBidder + 1) % 3;
    this.setTurn(this.currentBidder);
    return {};
  }

  finishBidding() {
    if (this.highestBid === 0) {
      // 无人叫分,重新发牌
      this.addLog('💤 无人叫分,重新发牌');
      this.dealerSeat = (this.dealerSeat + 1) % 3;
      this.startRound();
      return { redeal: true };
    }
    this.landlord = this.highestBidder;
    this.baseScore = this.highestBid;
    this.hands[this.landlord] = sortCards(this.hands[this.landlord].concat(this.bottom));
    this.bottomRevealed = true;
    this.phase = 'playing';
    this.setTurn(this.landlord);
    this.dealerSeat = (this.dealerSeat + 1) % 3; // 下局轮换首叫
    const lname = players.get(this.seats[this.landlord])?.name || '玩家';
    this.addLog(`👑 ${lname} 成为地主(底分 ${this.baseScore})`);
    return {};
  }

  doPlay(seat, cards) {
    if (this.phase !== 'playing') return { err: '现在不是出牌阶段' };
    if (seat !== this.turn) return { err: '还没轮到你出牌' };
    if (!Array.isArray(cards) || cards.length === 0) return { err: '请选择要出的牌' };
    if (!isSubset(cards, this.hands[seat])) return { err: '你没有这些牌' };
    const move = identify(cards);
    if (!move) return { err: '牌型不合法' };
    const free = this.lastPlay === null;
    if (!free && !canBeat(this.lastPlay.move, move)) return { err: '压不过上家的牌' };

    this.hands[seat] = sortCards(removeCards(this.hands[seat], cards));
    this.lastPlay = { seat, cards: sortCards(cards), move };
    this.lastActions = this.lastActions.map((a, i) => (i === seat ? { cards: sortCards(cards) } : a));
    this.passesInRow = 0;
    if (seat === this.landlord) this.landlordPlays++;
    else this.farmerPlays++;
    if (move.bomb) {
      this.multiplier *= 2;
      this.bombCount++;
    }
    const pname = players.get(this.seats[seat])?.name || '玩家';
    this.addLog(`${pname} 出 ${TYPE_NAMES[move.type]}:${cards.map(cardLabel).join(' ')}` + (move.bomb ? '  💥翻倍!' : ''));

    if (this.hands[seat].length === 0) {
      this.endGame(seat);
      return {};
    }
    this.setTurn((seat + 1) % 3);
    return {};
  }

  doPass(seat) {
    if (this.phase !== 'playing') return { err: '现在不是出牌阶段' };
    if (seat !== this.turn) return { err: '还没轮到你' };
    if (this.lastPlay === null) return { err: '你是首发/自由出牌,不能不出' };
    this.lastActions = this.lastActions.map((a, i) => (i === seat ? 'pass' : a));
    this.passesInRow++;
    const pname = players.get(this.seats[seat])?.name || '玩家';
    this.addLog(`${pname} 不要`);
    // 两家连续不出 → 上一手出牌者自由出牌
    if (this.passesInRow >= 2) {
      const leader = this.lastPlay.seat;
      this.lastPlay = null;
      this.passesInRow = 0;
      this.lastActions = [null, null, null];
      this.setTurn(leader);
    } else {
      this.setTurn((seat + 1) % 3);
    }
    return {};
  }

  endGame(winnerSeat) {
    const landlordWon = winnerSeat === this.landlord;
    // 春天判定
    let spring = false;
    if (landlordWon && this.farmerPlays === 0) spring = true; // 春天
    if (!landlordWon && this.landlordPlays === 1) spring = true; // 反春天
    if (spring) {
      this.multiplier *= 2;
      this.addLog(landlordWon ? '🌸 春天!分数翻倍' : '🌸 反春天!分数翻倍');
    }
    const unit = this.baseScore * this.multiplier;
    const deltas = {};
    for (let s = 0; s < 3; s++) {
      const pid = this.seats[s];
      if (!pid) continue;
      let delta;
      if (s === this.landlord) delta = landlordWon ? 2 * unit : -2 * unit;
      else delta = landlordWon ? -unit : unit;
      deltas[pid] = delta;
      this.scores[pid] = (this.scores[pid] || 0) + delta; // 按房间累计
    }
    this.result = {
      winnerSide: landlordWon ? 'landlord' : 'farmer',
      landlordSeat: this.landlord,
      base: this.baseScore,
      multiplier: this.multiplier,
      bombCount: this.bombCount,
      spring,
      unit,
      deltas,
    };
    this.phase = 'finished';
    const wname = landlordWon ? '地主' : '农民';
    this.addLog(`🏆 ${wname}胜!底分${this.baseScore} × 倍数${this.multiplier} = ${unit} 分/家`);
  }

  // 下一局:回到等待,需重新准备
  nextRound() {
    this.phase = 'waiting';
    this.ready = [false, false, false];
    this.resetRound();
    this.addLog('点击「准备」开始下一局');
  }

  // 生成发给某玩家的视图
  viewFor(playerId) {
    const mySeat = this.seatOf(playerId);
    const seats = this.seats.map((pid, s) => {
      if (!pid) return null;
      const p = players.get(pid);
      return {
        seat: s,
        playerId: pid,
        name: p.name,
        score: this.scores[pid] || 0,
        ready: this.ready[s],
        connected: !!p.socketId,
        handCount: this.hands[s].length,
        isLandlord: s === this.landlord,
        bid: this.bids[s],
        lastAction: this.lastActions[s],
      };
    });    return {
      id: this.id,
      name: this.name,
      phase: this.phase,
      seats,
      yourSeat: mySeat,
      yourHand: mySeat >= 0 ? this.hands[mySeat] : [],
      bottom: this.bottom,
      bottomRevealed: this.bottomRevealed,
      bidding: {
        current: this.currentBidder,
        highest: this.highestBid,
        highestBy: this.highestBidder,
      },
      landlord: this.landlord,
      turn: this.turn,
      turnSecondsLeft:
        this.phase === 'playing' || this.phase === 'bidding'
          ? Math.max(0, TURN_SECONDS - Math.floor((Date.now() - this.turnStartTime) / 1000))
          : null,
      lastPlay: this.lastPlay
        ? { seat: this.lastPlay.seat, cards: this.lastPlay.cards, typeName: TYPE_NAMES[this.lastPlay.move.type] }
        : null,
      multiplier: this.multiplier,
      baseScore: this.baseScore,
      bombCount: this.bombCount,
      result: this.result,
      log: this.log.slice(-12),
    };
  }
}

function lobbyData() {
  return {
    rooms: [...rooms.values()].map((r) => ({
      id: r.id,
      name: r.name,
      count: r.seatedPlayerIds().length,
      phase: r.phase,
    })),
  };
}

function broadcastRoom(room) {
  const ids = new Set([...room.seatedPlayerIds(), ...room.spectators]);
  for (const pid of ids) {
    const p = players.get(pid);
    if (p && p.socketId) {
      io.to(p.socketId).emit('room:state', room.viewFor(pid));
    }
  }
}

function broadcastLobby() {
  io.emit('lobby', lobbyData());
}

// ====== 回合计时器 ======
function clearTimer(room) {
  if (room._timer) { clearTimeout(room._timer); room._timer = null; }
}

function armTimer(room) {
  // 仅在叫分/出牌阶段计时
  if (room.phase !== 'playing' && room.phase !== 'bidding') {
    clearTimer(room);
    room._armedSeq = -1;
    return;
  }
  // 同一回合已在计时则不重置(避免重连/重复广播刷新时间)
  if (room._armedSeq === room.turnSeq && room._timer) return;
  clearTimer(room);
  room._armedSeq = room.turnSeq;
  const seat = room.turn;
  // 默认 30 秒;出牌阶段若确定压不过上家,实际只给 5 秒(界面仍显示 30 秒)
  let ms = TURN_SECONDS * 1000;
  if (room.phase === 'playing' && room.lastPlay && !canFollow(room.hands[seat], room.lastPlay.move)) {
    ms = NO_FOLLOW_SECONDS * 1000;
  }
  const seq = room.turnSeq;
  room._timer = setTimeout(() => {
    room._timer = null;
    if (room.turnSeq !== seq) return; // 回合已变,作废
    autoAct(room, seat);
    armTimer(room);
    broadcastRoom(room);
    broadcastLobby();
  }, ms);
}

// 超时自动处理:叫分→不叫;出牌→能压时不强制,这里超时一律按"自动跳过"(自由出牌则自动出最小单张)
function autoAct(room, seat) {
  if (seat !== room.turn) return;
  if (room.phase === 'bidding') {
    room.doBid(seat, 0);
  } else if (room.phase === 'playing') {
    if (!room.lastPlay) {
      // 自由出牌必须出牌:自动打出最小的单张(手牌降序,末位最小)
      const hand = room.hands[seat];
      if (hand.length) room.doPlay(seat, [hand[hand.length - 1]]);
    } else {
      room.doPass(seat);
    }
  }
}

function leaveRoom(player) {
  const room = rooms.get(player.roomId);
  player.roomId = null;
  if (!room) return;
  const seat = room.seatOf(player.id);
  if (seat >= 0) {
    room.seats[seat] = null;
    room.ready[seat] = false;
    // 游戏进行中有人离开 → 本局作废回到等待
    if (room.phase === 'bidding' || room.phase === 'playing') {
      room.phase = 'waiting';
      room.ready = [false, false, false];
      room.resetRound();
      room.addLog('⚠️ 有玩家离开,本局结束');
    }
  }
  room.spectators.delete(player.id);
  if (room.isEmpty()) {
    clearTimer(room);
    rooms.delete(room.id);
  } else {
    armTimer(room);
    broadcastRoom(room);
  }
  broadcastLobby();
}

io.on('connection', (socket) => {
  let player = null;

  socket.on('login', ({ username, password } = {}) => {
    const uname = String(username || '').trim().toLowerCase();
    const p = players.get(uname);
    if (!p || p.password !== password) {
      socket.emit('login:fail', { msg: '账号或密码错误' });
      return;
    }
    // 顶号:踢掉该账号的旧连接
    if (p.socketId && p.socketId !== socket.id) {
      io.to(p.socketId).emit('kicked');
    }
    player = p;
    player.socketId = socket.id;
    socket.emit('login:ok', { username: player.username, name: player.name });
    // 断线重连:若仍在房间内,重新发送房间状态
    if (player.roomId && rooms.has(player.roomId)) {
      broadcastRoom(rooms.get(player.roomId));
    }
    socket.emit('lobby', lobbyData());
  });

  socket.on('setName', ({ name }) => {
    if (!player || !name) return;
    player.name = String(name).slice(0, 12);
    socket.emit('login:ok', { username: player.username, name: player.name });
    if (player.roomId && rooms.has(player.roomId)) broadcastRoom(rooms.get(player.roomId));
  });

  socket.on('lobby:get', () => socket.emit('lobby', lobbyData()));

  function joinRoom(room) {
    if (!room) return;
    // 已在别的房间则先离开
    if (player.roomId && player.roomId !== room.id) leaveRoom(player);
    player.roomId = room.id;
    const freeSeat = room.seats.indexOf(null);
    if (freeSeat >= 0 && room.seatOf(player.id) < 0 && room.phase === 'waiting') {
      room.seats[freeSeat] = player.id;
      if (!(player.id in room.scores)) room.scores[player.id] = 0; // 进房从 0 开始
      room.spectators.delete(player.id);
    } else if (room.seatOf(player.id) < 0) {
      room.spectators.add(player.id); // 满员或游戏中 → 观战
    }
    broadcastRoom(room);
    broadcastLobby();
  }

  socket.on('room:quickStart', () => {
    if (!player) return;
    // 找一个有空位且处于等待中的房间,否则新建
    let room = [...rooms.values()].find((r) => r.phase === 'waiting' && r.seats.includes(null));
    if (!room) {
      room = new Room();
      rooms.set(room.id, room);
    }
    joinRoom(room);
  });

  socket.on('room:create', ({ name } = {}) => {
    if (!player) return;
    const room = new Room(name);
    rooms.set(room.id, room);
    joinRoom(room);
  });

  socket.on('room:join', ({ roomId }) => {
    if (!player) return;
    joinRoom(rooms.get(roomId));
  });

  socket.on('room:leave', () => {
    if (!player) return;
    leaveRoom(player);
    socket.emit('room:left');
    socket.emit('lobby', lobbyData());
  });

  // 坐下:观战者尝试坐到空位
  socket.on('room:sit', () => {
    if (!player || !player.roomId) return;
    const room = rooms.get(player.roomId);
    if (!room || room.phase !== 'waiting') return;
    if (room.seatOf(player.id) >= 0) return;
    const freeSeat = room.seats.indexOf(null);
    if (freeSeat >= 0) {
      room.seats[freeSeat] = player.id;
      if (!(player.id in room.scores)) room.scores[player.id] = 0; // 进房从 0 开始
      room.spectators.delete(player.id);
      broadcastRoom(room);
      broadcastLobby();
    }
  });

  socket.on('room:ready', () => {
    if (!player || !player.roomId) return;
    const room = rooms.get(player.roomId);
    if (!room) return;
    const seat = room.seatOf(player.id);
    if (seat < 0) return;
    room.ready[seat] = !room.ready[seat];
    room.startRoundIfReady();
    armTimer(room);
    broadcastRoom(room);
    broadcastLobby();
  });

  function withRoomSeat(fn) {
    if (!player || !player.roomId) return;
    const room = rooms.get(player.roomId);
    if (!room) return;
    const seat = room.seatOf(player.id);
    if (seat < 0) return;
    const res = fn(room, seat) || {};
    if (res.err) socket.emit('error:msg', { msg: res.err });
    armTimer(room);
    broadcastRoom(room);
    broadcastLobby();
  }

  socket.on('bid', ({ value }) => withRoomSeat((room, seat) => room.doBid(seat, value)));
  socket.on('play', ({ cards }) => withRoomSeat((room, seat) => room.doPlay(seat, cards)));
  socket.on('pass', () => withRoomSeat((room, seat) => room.doPass(seat)));
  socket.on('room:next', () => withRoomSeat((room) => {
    if (room.phase === 'finished') room.nextRound();
  }));

  socket.on('disconnect', () => {
    if (player) {
      player.socketId = null;
      // 保留座位以便重连;若在房间则刷新连接状态
      if (player.roomId && rooms.has(player.roomId)) broadcastRoom(rooms.get(player.roomId));
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`斗地主服务已启动: http://localhost:${PORT}`);
});
