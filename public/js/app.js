import { $, escapeHtml, toast } from './dom.js';
import { cardEl, preloadCardImages } from './cards.js';
import { announcePlay, playUiSound, syncVoiceToggle } from './audio.js';
import { renderTable, startClock } from './tableRenderer.js';

const socket = io();
const DEBUG_MODE = new URLSearchParams(window.location.search).has('debug');

let me = { username: null, name: '', score: 0 };
let state = null;
const selected = new Set();

function doLogin(username, password) {
  socket.emit('login', { username, password });
}

function showLogin() {
  $('login').classList.remove('hidden');
  $('lobby').classList.add('hidden');
  $('table').classList.add('hidden');
}

function showLobby() {
  $('login').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  $('table').classList.add('hidden');
  socket.emit('lobby:get');
}

function showTable() {
  $('login').classList.add('hidden');
  $('lobby').classList.add('hidden');
  $('table').classList.remove('hidden');
}

function openCreateRoomModal() {
  playUiSound('click');
  syncCreateChoices();
  $('createRoomModal').classList.remove('hidden');
}

function closeCreateRoomModal() {
  playUiSound('click');
  $('createRoomModal').classList.add('hidden');
}

function syncCreateChoices() {
  document.querySelectorAll('.choice').forEach((label) => {
    const input = label.querySelector('input');
    label.classList.toggle('selected', input.checked);
  });
  document.querySelectorAll('.check-choice').forEach((label) => {
    const input = label.querySelector('input');
    label.classList.toggle('checked', input.checked);
  });
  const preset = document.querySelector('input[name="roundPreset"]:checked')?.value;
  $('customRoundLimit').disabled = preset !== 'custom';
}

function roomOptionsText(r) {
  const opts = r.options || {};
  const round = opts.roundLimit || 6;
  const max = opts.maxMultiplier || 24;
  const doubleText = opts.allowDouble === false ? '不可加倍' : '可加倍';
  const progress = r.completedRounds != null ? ` · ${r.completedRounds}/${round}局` : '';
  return `${round}局 · 封顶${max}倍 · ${doubleText}${progress}`;
}

function render() {
  renderTable(state, {
    socket,
    selected,
    debugMode: DEBUG_MODE,
    render,
    onToggleCard(id, el) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      el.classList.toggle('selected');
      playUiSound('select');
    },
  });
}

function bindSocketEvents() {
  socket.on('connect', () => {
    const u = localStorage.getItem('ddz_user');
    const p = localStorage.getItem('ddz_pass');
    if (u && p) doLogin(u, p);
  });

  socket.on('login:ok', (d) => {
    me.username = d.username;
    me.name = d.name;
    $('nameInput').value = d.name;
    $('myAccount').textContent = d.username;
    $('loginErr').textContent = '';
    if (!state) showLobby();
  });

  socket.on('login:fail', (d) => {
    localStorage.removeItem('ddz_user');
    localStorage.removeItem('ddz_pass');
    $('loginErr').textContent = d.msg || '登录失败';
    showLogin();
  });

  socket.on('kicked', () => {
    state = null;
    showLogin();
  });

  socket.on('error:msg', (d) => {
    toast(d.msg);
  });

  socket.on('room:left', () => {
    state = null;
    showLobby();
  });

  socket.on('lobby', (d) => {
    const list = $('roomList');
    list.innerHTML = '';
    if (!d.rooms.length) list.innerHTML = '<div class="meta">暂无房间,点「快速开始」或「创建房间」</div>';
    d.rooms.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'room-row';
      const phase = { waiting: '等待中', bidding: '叫分中', playing: '游戏中', finished: '已结束' }[r.phase] || r.phase;
      row.innerHTML = `<div><b>${escapeHtml(r.name)}</b> <span class="meta">${r.count}/3 · ${phase}</span><div class="room-options">${roomOptionsText(r)}</div></div>`;
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = r.count < 3 && r.phase === 'waiting' ? '加入' : '观战';
      btn.onclick = () => socket.emit('room:join', { roomId: r.id });
      row.appendChild(btn);
      list.appendChild(row);
    });
  });

  socket.on('room:state', (s) => {
    state = s;
    showTable();
    render();
    // 计时器仅在收到服务器新状态时重置,本地重渲染(如「清空」)不打断倒计时
    startClock(s);
    announcePlay(s);
  });

  socket.on('replay:list', ({ replays }) => {
    renderReplayList(replays || []);
  });

  socket.on('replay:detail', ({ replay }) => {
    renderReplayDetail(replay);
  });

  socket.on('replay:fail', (d) => toast(d.msg || '读取回放失败'));
}

function bindDomEvents() {
  $('loginBtn').onclick = () => {
    const u = $('loginUser').value.trim().toLowerCase();
    const p = $('loginPass').value;
    if (!u || !p) {
      $('loginErr').textContent = '请输入账号和密码';
      return;
    }
    localStorage.setItem('ddz_user', u);
    localStorage.setItem('ddz_pass', p);
    doLogin(u, p);
  };
  $('loginPass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('loginBtn').click();
  });
  $('logoutBtn').onclick = () => {
    localStorage.removeItem('ddz_user');
    localStorage.removeItem('ddz_pass');
    if (state) socket.emit('room:leave');
    me.username = null;
    state = null;
    showLogin();
  };
  $('quickStart').onclick = () => {
    playUiSound('success');
    socket.emit('room:quickStart');
  };
  $('createRoom').onclick = () => openCreateRoomModal();
  $('historyBtn').onclick = () => {
    playUiSound('click');
    openReplayModal();
  };
  $('refreshLobby').onclick = () => socket.emit('lobby:get');
  $('saveName').onclick = () => {
    const n = $('nameInput').value.trim();
    if (n) socket.emit('setName', { name: n });
  };
  $('leaveRoom').onclick = () => {
    if (state && ['bidding', 'playing'].includes(state.phase) && state.yourSeat >= 0) {
      playUiSound('pass');
      socket.emit('dissolve:request');
      return;
    }
    playUiSound('pass');
    socket.emit('room:leave');
  };
  syncVoiceToggle($('audioToggle'));
  $('closeCreateRoom').onclick = () => closeCreateRoomModal();
  $('closeReplay').onclick = () => closeReplayModal();
  $('replayModal').onclick = (e) => {
    if (e.target === $('replayModal')) closeReplayModal();
  };
  $('createRoomModal').onclick = (e) => {
    if (e.target === $('createRoomModal')) closeCreateRoomModal();
  };
  $('joinAfterCreate').onclick = () => {
    playUiSound('success');
    closeCreateRoomModal();
    socket.emit('room:quickStart');
  };
  $('confirmCreateRoom').onclick = () => {
    const roundPreset = document.querySelector('input[name="roundPreset"]:checked').value;
    const roundLimit = roundPreset === 'custom'
      ? Number($('customRoundLimit').value)
      : Number(roundPreset);
    const options = {
      roundLimit,
      maxMultiplier: Number(document.querySelector('input[name="maxMultiplier"]:checked').value),
      allowDouble: $('allowDouble').checked,
    };
    playUiSound('success');
    socket.emit('room:create', { options });
    closeCreateRoomModal();
  };
  document.querySelectorAll('.choice input').forEach((input) => {
    input.addEventListener('change', syncCreateChoices);
  });
  $('customRoundLimit').addEventListener('input', () => {
    document.querySelector('input[name="roundPreset"][value="custom"]').checked = true;
    syncCreateChoices();
  });
  $('allowDouble').addEventListener('change', syncCreateChoices);
}

function openReplayModal() {
  $('replayModal').classList.remove('hidden');
  $('replayList').innerHTML = '<div class="meta">加载中...</div>';
  $('replayDetail').textContent = '选择一局查看出牌顺序';
  socket.emit('replay:list');
}

function closeReplayModal() {
  $('replayModal').classList.add('hidden');
}

function seatName(replay, seat) {
  return replay.participants.find((p) => p.seat === seat)?.name || `座位${seat + 1}`;
}

function replaySummary(replay) {
  if (!replay.result) return '未结算';
  const winner = replay.result.winnerSide === 'landlord' ? '地主胜' : '农民胜';
  return `${winner} · 底分${replay.result.base} × ${replay.result.multiplier}`;
}

function appendReplayCards(parent, cards, cls = 'mini') {
  const row = document.createElement('div');
  row.className = 'replay-cards';
  cards.forEach((id) => row.appendChild(cardEl(id, { cls })));
  parent.appendChild(row);
}

function renderReplayList(replays) {
  const list = $('replayList');
  list.innerHTML = '';
  if (!replays.length) {
    list.innerHTML = '<div class="meta">暂无历史牌局</div>';
    return;
  }
  replays.forEach((replay) => {
    const item = document.createElement('button');
    item.className = 'replay-item';
    const names = replay.participants.map((p) => escapeHtml(p.name)).join(' / ');
    item.innerHTML = `<b>${escapeHtml(replay.roomName)} 第${replay.roundNo}局</b>
      <span>${names}</span>
      <em>${replaySummary(replay)}</em>`;
    item.onclick = () => socket.emit('replay:get', { id: replay.id });
    list.appendChild(item);
  });
}

function renderReplayDetail(replay) {
  const box = $('replayDetail');
  box.innerHTML = `<h3>${escapeHtml(replay.roomName)} 第${replay.roundNo}局</h3>
    <div class="replay-meta">参与者: ${replay.participants.map((p) => escapeHtml(p.name)).join(' / ')}</div>`;

  const hands = document.createElement('div');
  hands.className = 'replay-section';
  hands.innerHTML = '<h4>初始牌</h4>';
  replay.initialHands.forEach((hand, seat) => {
    const line = document.createElement('div');
    line.className = 'replay-hand';
    line.innerHTML = `<strong>${escapeHtml(seatName(replay, seat))}</strong>`;
    appendReplayCards(line, hand, 'mini');
    hands.appendChild(line);
  });
  const bottom = document.createElement('div');
  bottom.className = 'replay-hand';
  bottom.innerHTML = '<strong>底牌</strong>';
  appendReplayCards(bottom, replay.bottom, 'mini');
  hands.appendChild(bottom);
  box.appendChild(hands);

  const actions = document.createElement('div');
  actions.className = 'replay-section';
  actions.innerHTML = '<h4>出牌顺序</h4>';
  replay.actions
    .filter((a) => ['bid', 'landlord', 'play', 'pass', 'finish'].includes(a.type))
    .forEach((action, index) => {
      const row = document.createElement('div');
      row.className = 'replay-action';
      const who = action.seat != null ? escapeHtml(seatName(replay, action.seat)) : '';
      if (action.type === 'bid') {
        row.innerHTML = `<span>${index}. ${who}</span><b>${action.value === 0 ? '不叫' : `叫${action.value}分`}</b>`;
      } else if (action.type === 'landlord') {
        row.innerHTML = `<span>${index}. ${who}</span><b>成为地主,底分${action.baseScore}</b>`;
      } else if (action.type === 'play') {
        row.innerHTML = `<span>${index}. ${who}</span><b>出 ${action.moveType}</b>`;
        appendReplayCards(row, action.cards, 'mini');
      } else if (action.type === 'pass') {
        row.innerHTML = `<span>${index}. ${who}</span><b>不要</b>`;
      } else if (action.type === 'finish') {
        row.innerHTML = `<span>${index}. 结算</span><b>${replaySummary(replay)}</b>`;
      }
      actions.appendChild(row);
    });
  box.appendChild(actions);
}

bindSocketEvents();
bindDomEvents();
showLogin();
preloadCardImages();
