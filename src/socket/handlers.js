import { Room } from '../game/Room.js';
import { getReplayForUser, listReplaysForUser } from '../db/replays.js';
import { findUser, updateUserName, upsertRuntimePlayer, verifyPassword } from '../db/users.js';
import { players, rooms } from '../state.js';
import { armTimer, autoAct, clearTimer } from './timers.js';

function lobbyData() {
  return {
    rooms: [...rooms.values()].map((r) => ({
      id: r.id,
      name: r.name,
      options: r.options,
      roundNo: r.roundNo,
      completedRounds: r.completedRounds,
      count: r.seatedPlayerIds().length,
      phase: r.phase,
    })),
  };
}

function getDebugPlayer(id, name) {
  const existing = players.get(id);
  const runtime = existing || {
    id,
    username: id,
    socketId: null,
    roomId: null,
  };
  runtime.name = name;
  players.set(id, runtime);
  return runtime;
}

export function registerSocketHandlers(io) {
  function isActiveRound(room) {
    return room.phase === 'bidding' || room.phase === 'playing';
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

  function armRoomTimer(room) {
    armTimer(room, (timedRoom, seat) => {
      autoAct(timedRoom, seat);
      armRoomTimer(timedRoom);
      broadcastRoom(timedRoom);
      broadcastLobby();
    });
  }

  function leaveRoom(player) {
    const room = rooms.get(player.roomId);
    player.roomId = null;
    if (!room) return;
    const seat = room.seatOf(player.id);
    if (seat >= 0) {
      room.seats[seat] = null;
      room.ready[seat] = false;
      if (room.phase === 'bidding' || room.phase === 'playing') {
        room.phase = 'waiting';
        room.ready = [false, false, false];
        room.resetRound();
        room.addLog('有玩家离开,本局结束');
      }
    }
    room.spectators.delete(player.id);
    if (room.isEmpty()) {
      clearTimer(room);
      rooms.delete(room.id);
    } else {
      armRoomTimer(room);
      broadcastRoom(room);
    }
    broadcastLobby();
  }

  function dissolveRoom(room, reason = '房间已解散') {
    clearTimer(room);
    if (room._dissolveTimer) {
      clearTimeout(room._dissolveTimer);
      room._dissolveTimer = null;
    }
    const ids = new Set([...room.seatedPlayerIds(), ...room.spectators]);
    rooms.delete(room.id);
    for (const pid of ids) {
      const p = players.get(pid);
      if (p) {
        p.roomId = null;
        if (p.socketId) {
          io.to(p.socketId).emit('room:left');
          io.to(p.socketId).emit('error:msg', { msg: reason });
        }
      }
    }
    broadcastLobby();
  }

  function cancelDissolve(room, reason = '解散申请已取消') {
    if (room._dissolveTimer) {
      clearTimeout(room._dissolveTimer);
      room._dissolveTimer = null;
    }
    room.dissolve = null;
    room.addLog(reason);
    broadcastRoom(room);
    broadcastLobby();
  }

  function requestDissolve(room, requesterId) {
    if (!isActiveRound(room)) return { err: '当前不需要申请解散,可以直接退出房间' };
    if (!room.seatedPlayerIds().includes(requesterId)) return { err: '只有本局玩家可以申请解散' };
    if (room.dissolve) return {};
    room.dissolve = {
      requester: requesterId,
      agree: new Set([requesterId]),
      reject: new Set(),
      expiresAt: Date.now() + 60 * 1000,
    };
    room.addLog(`${players.get(requesterId)?.name || requesterId} 申请解散房间`);
    room._dissolveTimer = setTimeout(() => {
      if (!rooms.has(room.id) || !room.dissolve) return;
      dissolveRoom(room, '解散申请超时无人应答,房间已自动解散');
    }, 60 * 1000);
    return {};
  }

  function voteDissolve(room, playerId, agree) {
    if (!room.dissolve) return { err: '当前没有解散申请' };
    if (!room.seatedPlayerIds().includes(playerId)) return { err: '只有本局玩家可以投票' };
    if (agree) {
      room.dissolve.reject.delete(playerId);
      room.dissolve.agree.add(playerId);
      room.addLog(`${players.get(playerId)?.name || playerId} 同意解散`);
      if (room.dissolve.agree.size >= 3) {
        dissolveRoom(room, '三名玩家已同意,房间已解散');
        return {};
      }
    } else {
      room.dissolve.agree.delete(playerId);
      room.dissolve.reject.add(playerId);
      cancelDissolve(room, `${players.get(playerId)?.name || playerId} 拒绝解散`);
      return {};
    }
    broadcastRoom(room);
    broadcastLobby();
    return {};
  }

  function cancelDissolveByRequester(room, playerId) {
    if (!room.dissolve) return { err: '当前没有解散申请' };
    if (room.dissolve.requester !== playerId) return { err: '只有申请人可以取消解散申请' };
    cancelDissolve(room, `${players.get(playerId)?.name || playerId} 取消了解散申请`);
    return {};
  }

  io.on('connection', (socket) => {
    let player = null;

    function joinRoom(room) {
      if (!room) return;
      if (player.roomId && player.roomId !== room.id) leaveRoom(player);
      player.roomId = room.id;
      const freeSeat = room.seats.indexOf(null);
      if (freeSeat >= 0 && room.seatOf(player.id) < 0 && room.phase === 'waiting') {
        room.seats[freeSeat] = player.id;
        if (!(player.id in room.scores)) room.scores[player.id] = 0;
        room.spectators.delete(player.id);
      } else if (room.seatOf(player.id) < 0) {
        room.spectators.add(player.id);
      }
      broadcastRoom(room);
      broadcastLobby();
    }

    function withRoomSeat(fn) {
      if (!player || !player.roomId) return;
      const room = rooms.get(player.roomId);
      if (!room) return;
      const seat = room.seatOf(player.id);
      if (seat < 0) return;
      const res = fn(room, seat) || {};
      if (res.err) socket.emit('error:msg', { msg: res.err });
      armRoomTimer(room);
      broadcastRoom(room);
      broadcastLobby();
    }

    socket.on('login', ({ username, password } = {}) => {
      const uname = String(username || '').trim().toLowerCase();
      const user = findUser(uname);
      if (!user || !verifyPassword(password, user)) {
        socket.emit('login:fail', { msg: '账号或密码错误' });
        return;
      }
      const p = upsertRuntimePlayer(user);
      if (p.socketId && p.socketId !== socket.id) {
        io.to(p.socketId).emit('kicked');
      }
      player = p;
      player.socketId = socket.id;
      socket.emit('login:ok', { username: player.username, name: player.name });
      if (player.roomId && rooms.has(player.roomId)) {
        broadcastRoom(rooms.get(player.roomId));
      }
      socket.emit('lobby', lobbyData());
    });

    socket.on('setName', ({ name }) => {
      if (!player || !name) return;
      player.name = String(name).slice(0, 12);
      updateUserName(player.username, player.name);
      socket.emit('login:ok', { username: player.username, name: player.name });
      if (player.roomId && rooms.has(player.roomId)) broadcastRoom(rooms.get(player.roomId));
    });

    socket.on('lobby:get', () => socket.emit('lobby', lobbyData()));

    socket.on('replay:list', () => {
      if (!player) return;
      socket.emit('replay:list', { replays: listReplaysForUser(player.id) });
    });

    socket.on('replay:get', ({ id } = {}) => {
      if (!player || !id) return;
      const replay = getReplayForUser(id, player.id);
      if (!replay) {
        socket.emit('replay:fail', { msg: '没有找到这局回放,或你不是参与者' });
        return;
      }
      socket.emit('replay:detail', { replay });
    });

    socket.on('room:quickStart', () => {
      if (!player) return;
      let room = [...rooms.values()].find((r) => r.phase === 'waiting' && r.seats.includes(null));
      if (!room) {
        room = new Room();
        rooms.set(room.id, room);
      }
      joinRoom(room);
    });

    socket.on('room:create', ({ name, options } = {}) => {
      if (!player) return;
      const room = new Room(name, options);
      rooms.set(room.id, room);
      joinRoom(room);
    });

    socket.on('room:join', ({ roomId }) => {
      if (!player) return;
      joinRoom(rooms.get(roomId));
    });

    socket.on('room:leave', () => {
      if (!player) return;
      const room = player.roomId ? rooms.get(player.roomId) : null;
      if (room && isActiveRound(room) && room.seatOf(player.id) >= 0) {
        const res = requestDissolve(room, player.id);
        if (res.err) socket.emit('error:msg', { msg: res.err });
        broadcastRoom(room);
        broadcastLobby();
        return;
      }
      leaveRoom(player);
      socket.emit('room:left');
      socket.emit('lobby', lobbyData());
    });

    socket.on('dissolve:request', () => {
      if (!player || !player.roomId) return;
      const room = rooms.get(player.roomId);
      if (!room) return;
      const res = requestDissolve(room, player.id);
      if (res.err) socket.emit('error:msg', { msg: res.err });
      broadcastRoom(room);
      broadcastLobby();
    });

    socket.on('dissolve:vote', ({ agree } = {}) => {
      if (!player || !player.roomId) return;
      const room = rooms.get(player.roomId);
      if (!room) return;
      const res = voteDissolve(room, player.id, !!agree);
      if (res.err) socket.emit('error:msg', { msg: res.err });
    });

    socket.on('dissolve:cancel', () => {
      if (!player || !player.roomId) return;
      const room = rooms.get(player.roomId);
      if (!room) return;
      const res = cancelDissolveByRequester(room, player.id);
      if (res.err) socket.emit('error:msg', { msg: res.err });
    });

    socket.on('room:sit', () => {
      if (!player || !player.roomId) return;
      const room = rooms.get(player.roomId);
      if (!room || room.phase !== 'waiting') return;
      if (room.seatOf(player.id) >= 0) return;
      const freeSeat = room.seats.indexOf(null);
      if (freeSeat >= 0) {
        room.seats[freeSeat] = player.id;
        if (!(player.id in room.scores)) room.scores[player.id] = 0;
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
      armRoomTimer(room);
      broadcastRoom(room);
      broadcastLobby();
    });

    socket.on('debug:fillRoom', () => {
      if (!player || !player.roomId) return;
      const room = rooms.get(player.roomId);
      if (!room || room.phase !== 'waiting') return;
      const seat = room.seatOf(player.id);
      if (seat < 0) return;

      const bots = [
        getDebugPlayer('__debug_farmer_a', '测试玩家A'),
        getDebugPlayer('__debug_farmer_b', '测试玩家B'),
      ];
      for (const bot of bots) {
        if (room.seatOf(bot.id) >= 0) continue;
        const freeSeat = room.seats.indexOf(null);
        if (freeSeat < 0) break;
        room.seats[freeSeat] = bot.id;
        bot.roomId = room.id;
        if (!(bot.id in room.scores)) room.scores[bot.id] = 0;
        room.spectators.delete(bot.id);
      }
      room.ready = room.seats.map(Boolean);
      room.startRoundIfReady();
      armRoomTimer(room);
      broadcastRoom(room);
      broadcastLobby();
    });

    socket.on('bid', ({ value }) => withRoomSeat((room, seat) => room.doBid(seat, value)));
    socket.on('play', ({ cards }) => withRoomSeat((room, seat) => room.doPlay(seat, cards)));
    socket.on('pass', () => withRoomSeat((room, seat) => room.doPass(seat)));
    socket.on('room:next', () => withRoomSeat((room) => {
      if (room.phase === 'finished') room.nextRound();
    }));

    socket.on('disconnect', () => {
      if (player) {
        player.socketId = null;
        if (player.roomId && rooms.has(player.roomId)) broadcastRoom(rooms.get(player.roomId));
      }
    });
  });
}
