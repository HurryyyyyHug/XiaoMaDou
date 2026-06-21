import crypto from 'crypto';
import {
  deal,
  identify,
  canBeat,
  isSubset,
  removeCards,
  sortCards,
  cardLabel,
} from '../../gameLogic.js';
import { TURN_SECONDS } from '../config.js';
import { TYPE_NAMES } from '../constants.js';
import { appendGameAction, createGameRecord, finishGameRecord } from '../db/replays.js';
import { players } from '../state.js';

const DEFAULT_ROOM_OPTIONS = {
  roundLimit: 6,
  maxMultiplier: 24,
  allowDouble: true,
};

function normalizeRoomOptions(options = {}) {
  const requestedRoundLimit = Math.floor(Number(options.roundLimit));
  const roundLimit = Number.isFinite(requestedRoundLimit)
    ? Math.min(99, Math.max(1, requestedRoundLimit))
    : DEFAULT_ROOM_OPTIONS.roundLimit;
  const maxMultiplier = [12, 24].includes(Number(options.maxMultiplier))
    ? Number(options.maxMultiplier)
    : DEFAULT_ROOM_OPTIONS.maxMultiplier;
  return {
    roundLimit,
    maxMultiplier,
    allowDouble: options.allowDouble !== false,
  };
}

export class Room {
  constructor(name, options = {}) {
    this.id = 'R' + crypto.randomInt(100000, 999999);
    this.name = name || ('房间' + this.id.slice(1));
    this.options = normalizeRoomOptions(options);
    this.seats = [null, null, null];
    this.spectators = new Set();
    this.scores = {};
    this.phase = 'waiting';
    this.roundNo = 1;
    this.completedRounds = 0;
    this.ready = [false, false, false];
    this.dissolve = null;
    this.resetRound();
    this.log = [];
    this.dealerSeat = crypto.randomInt(3);
  }

  resetRound() {
    this.hands = [[], [], []];
    this.bottom = [];
    this.bottomRevealed = false;
    this.bids = [null, null, null];
    this.currentBidder = -1;
    this.bidStartSeat = -1;
    this.bidActions = 0;
    this.highestBid = 0;
    this.highestBidder = -1;
    this.landlord = -1;
    this.turn = -1;
    this.lastPlay = null;
    this.passesInRow = 0;
    this.lastActions = [null, null, null];
    this.multiplier = 1;
    this.baseScore = 0;
    this.bombCount = 0;
    this.farmerPlays = 0;
    this.landlordPlays = 0;
    this.result = null;
    this.replayId = null;
    this.turnSeq = (this.turnSeq || 0) + 1;
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

  setTurn(seat) {
    this.turn = seat;
    this.turnSeq = (this.turnSeq || 0) + 1;
    this.turnStartTime = Date.now();
  }

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
    this.replayId = createGameRecord({
      roomId: this.id,
      roomName: this.name,
      roundNo: this.roundNo,
      options: this.options,
      participants: this.seats.map((pid, seat) => {
        const p = players.get(pid);
        return { seat, id: pid, name: p?.name || pid };
      }),
      initialHands: this.hands.map((hand) => hand.slice()),
      bottom: this.bottom.slice(),
    });
    this.phase = 'bidding';
    this.bidStartSeat = this.dealerSeat;
    this.currentBidder = this.dealerSeat;
    this.setTurn(this.dealerSeat);
    this.addLog('新一局开始,开始叫分');
  }

  doBid(seat, value) {
    if (this.phase !== 'bidding') return { err: '现在不是叫分阶段' };
    if (seat !== this.currentBidder) return { err: '还没轮到你叫分' };
    if (![0, 1, 2, 3].includes(value)) return { err: '叫分非法' };
    if (value !== 0 && value <= this.highestBid) return { err: '必须比当前最高分高(或选择不叫)' };
    this.bids[seat] = value;
    this.bidActions++;
    appendGameAction(this.replayId, {
      type: 'bid',
      seat,
      playerId: this.seats[seat],
      value,
    });
    const pname = players.get(this.seats[seat])?.name || '玩家';
    this.addLog(value === 0 ? `${pname} 不叫` : `${pname} 叫 ${value} 分`);
    if (value > this.highestBid) {
      this.highestBid = value;
      this.highestBidder = seat;
    }
    if (value === 3) return this.finishBidding();
    if (this.bidActions >= 3) return this.finishBidding();
    this.currentBidder = (this.currentBidder + 1) % 3;
    this.setTurn(this.currentBidder);
    return {};
  }

  finishBidding() {
    if (this.highestBid === 0) {
      this.addLog('无人叫分,重新发牌');
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
    this.dealerSeat = (this.dealerSeat + 1) % 3;
    const lname = players.get(this.seats[this.landlord])?.name || '玩家';
    this.addLog(`${lname} 成为地主(底分 ${this.baseScore})`);
    appendGameAction(this.replayId, {
      type: 'landlord',
      seat: this.landlord,
      playerId: this.seats[this.landlord],
      baseScore: this.baseScore,
      bottom: this.bottom.slice(),
      landlordHand: this.hands[this.landlord].slice(),
    });
    return {};
  }

  doPlay(seat, cards) {
    if (this.phase !== 'playing') return { err: '现在不是出牌阶段' };
    if (seat !== this.turn) return { err: '还没轮到你出牌' };
    if (!Array.isArray(cards) || cards.length === 0) return { err: '请选择要出的牌' };
    if (!isSubset(cards, this.hands[seat])) return { err: '你没有这些牌' };
    const move = identify(cards);
    if (!move) return { err: '牌型不合法' };
    if (this.lastPlay && !canBeat(this.lastPlay.move, move)) return { err: '压不过上家的牌' };

    this.hands[seat] = sortCards(removeCards(this.hands[seat], cards));
    this.lastPlay = { seat, cards: sortCards(cards), move };
    this.lastActions = this.lastActions.map((a, i) => (i === seat ? { cards: sortCards(cards) } : a));
    this.passesInRow = 0;
    if (seat === this.landlord) this.landlordPlays++;
    else this.farmerPlays++;
    if (move.bomb) {
      this.multiplier = Math.min(this.options.maxMultiplier, this.multiplier * 2);
      this.bombCount++;
    }
    appendGameAction(this.replayId, {
      type: 'play',
      seat,
      playerId: this.seats[seat],
      cards: sortCards(cards),
      moveType: move.type,
      bomb: !!move.bomb,
      multiplier: this.multiplier,
      handLeft: this.hands[seat].slice(),
    });
    const pname = players.get(this.seats[seat])?.name || '玩家';
    this.addLog(`${pname} 出 ${TYPE_NAMES[move.type]}:${cards.map(cardLabel).join(' ')}` + (move.bomb ? ' 翻倍!' : ''));

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
    appendGameAction(this.replayId, {
      type: 'pass',
      seat,
      playerId: this.seats[seat],
    });
    const pname = players.get(this.seats[seat])?.name || '玩家';
    this.addLog(`${pname} 不要`);
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
    let spring = false;
    if (landlordWon && this.farmerPlays === 0) spring = true;
    if (!landlordWon && this.landlordPlays === 1) spring = true;
    if (spring) {
      this.multiplier = Math.min(this.options.maxMultiplier, this.multiplier * 2);
      this.addLog(landlordWon ? '春天!分数翻倍' : '反春天!分数翻倍');
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
      this.scores[pid] = (this.scores[pid] || 0) + delta;
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
    this.completedRounds++;
    finishGameRecord(this.replayId, {
      landlordSeat: this.landlord,
      baseScore: this.baseScore,
      multiplier: this.multiplier,
      bombCount: this.bombCount,
      result: this.result,
    });
    this.addLog(`${landlordWon ? '地主' : '农民'}胜!底分${this.baseScore} × 倍数${this.multiplier} = ${unit} 分/家`);
  }

  nextRound() {
    if (this.completedRounds >= this.options.roundLimit) {
      this.addLog(`房间已完成 ${this.options.roundLimit} 局`);
      return;
    }
    this.phase = 'waiting';
    this.ready = [false, false, false];
    this.roundNo = this.completedRounds + 1;
    this.resetRound();
    this.addLog('点击「准备」开始下一局');
  }

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
    });
    return {
      id: this.id,
      name: this.name,
      options: this.options,
      roundNo: this.roundNo,
      completedRounds: this.completedRounds,
      roomDone: this.completedRounds >= this.options.roundLimit,
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
      dissolve: this.dissolve
        ? {
          requester: this.dissolve.requester,
          requesterName: players.get(this.dissolve.requester)?.name || this.dissolve.requester,
          agree: [...this.dissolve.agree],
          reject: [...this.dissolve.reject],
          expiresAt: this.dissolve.expiresAt,
          secondsLeft: Math.max(0, Math.ceil((this.dissolve.expiresAt - Date.now()) / 1000)),
        }
        : null,
    };
  }
}
