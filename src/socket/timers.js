import { canFollow } from '../../gameLogic.js';
import { NO_FOLLOW_SECONDS, TURN_SECONDS } from '../config.js';

function isDebugPlayer(playerId) {
  return String(playerId || '').startsWith('__debug_');
}

export function clearTimer(room) {
  if (room._timer) {
    clearTimeout(room._timer);
    room._timer = null;
  }
}

export function armTimer(room, onTimeout) {
  if (room.phase !== 'playing' && room.phase !== 'bidding') {
    clearTimer(room);
    room._armedSeq = -1;
    return;
  }
  if (room._armedSeq === room.turnSeq && room._timer) return;
  clearTimer(room);
  room._armedSeq = room.turnSeq;
  const seat = room.turn;
  let ms = TURN_SECONDS * 1000;
  if (isDebugPlayer(room.seats[seat])) {
    ms = 1000;
  }
  if (room.phase === 'playing' && room.lastPlay && !canFollow(room.hands[seat], room.lastPlay.move)) {
    ms = NO_FOLLOW_SECONDS * 1000;
  }
  const seq = room.turnSeq;
  room._timer = setTimeout(() => {
    room._timer = null;
    if (room.turnSeq !== seq) return;
    onTimeout(room, seat);
  }, ms);
}

export function autoAct(room, seat) {
  if (seat !== room.turn) return;
  if (room.phase === 'bidding') {
    room.doBid(seat, 0);
  } else if (room.phase === 'playing') {
    if (!room.lastPlay) {
      const hand = room.hands[seat];
      if (hand.length) room.doPlay(seat, [hand[hand.length - 1]]);
    } else {
      room.doPass(seat);
    }
  }
}
