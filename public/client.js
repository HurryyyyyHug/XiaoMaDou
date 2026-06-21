// client.js —— 斗地主前端
const socket = io();

const RANK_LABELS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUITS = ['♠', '♥', '♣', '♦'];

let me = { username: null, name: '', score: 0 };
let state = null; // 当前房间状态
let selected = new Set();
let clockInt = null; // 本地倒计时

const $ = (id) => document.getElementById(id);
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 1800);
}

// ===== 扑克牌渲染 =====
function cardInfo(id) {
  if (id === 52) return { rank: '小', suit: 'JOKER', red: false, joker: true };
  if (id === 53) return { rank: '大', suit: 'JOKER', red: true, joker: true };
  const ri = Math.floor(id / 4);
  const s = id % 4;
  return { rank: RANK_LABELS[ri], suit: SUITS[s], red: s === 1 || s === 3, joker: false };
}
function cardEl(id, { cls = '', selectable = false } = {}) {
  const info = cardInfo(id);
  const el = document.createElement('div');
  el.className = 'card ' + cls + (info.red ? ' red' : '');
  if (info.joker) {
    el.innerHTML = `<div class="corner">${info.rank}</div><div class="mid">🃏</div>`;
  } else {
    el.innerHTML = `<div class="corner">${info.rank}<br>${info.suit}</div><div class="mid">${info.suit}</div>`;
  }
  if (selectable) {
    el.dataset.id = id;
    if (selected.has(id)) el.classList.add('selected');
    el.onclick = () => {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      el.classList.toggle('selected');
    };
  }
  return el;
}

// ===== 连接 / 登录 =====
function doLogin(username, password) {
  socket.emit('login', { username, password });
}
socket.on('connect', () => {
  // 断线重连或刷新:用本地保存的凭证自动登录
  const u = localStorage.getItem('ddz_user');
  const p = localStorage.getItem('ddz_pass');
  if (u && p) doLogin(u, p);
});
socket.on('login:ok', (d) => {
  me.username = d.username; me.name = d.name;
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
  toast('该账号已在别处登录');
  state = null;
  showLogin();
});
socket.on('error:msg', (d) => toast(d.msg));
socket.on('room:left', () => { state = null; showLobby(); });

socket.on('lobby', (d) => {
  const list = $('roomList');
  list.innerHTML = '';
  if (!d.rooms.length) list.innerHTML = '<div class="meta">暂无房间,点「快速开始」或「创建房间」</div>';
  d.rooms.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'room-row';
    const phase = { waiting: '等待中', bidding: '叫分中', playing: '游戏中', finished: '已结束' }[r.phase] || r.phase;
    row.innerHTML = `<div><b>${r.name}</b> <span class="meta">${r.count}/3 · ${phase}</span></div>`;
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
});

// ===== 大厅按钮 =====
$('loginBtn').onclick = () => {
  const u = $('loginUser').value.trim().toLowerCase();
  const p = $('loginPass').value;
  if (!u || !p) { $('loginErr').textContent = '请输入账号和密码'; return; }
  localStorage.setItem('ddz_user', u);
  localStorage.setItem('ddz_pass', p);
  doLogin(u, p);
};
$('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });
$('logoutBtn').onclick = () => {
  localStorage.removeItem('ddz_user');
  localStorage.removeItem('ddz_pass');
  if (state) socket.emit('room:leave');
  me.username = null; state = null;
  showLogin();
};
$('quickStart').onclick = () => socket.emit('room:quickStart');
$('createRoom').onclick = () => socket.emit('room:create', {});
$('refreshLobby').onclick = () => socket.emit('lobby:get');
$('saveName').onclick = () => {
  const n = $('nameInput').value.trim();
  if (n) socket.emit('setName', { name: n });
};
$('leaveRoom').onclick = () => socket.emit('room:leave');

function showLogin() { $('login').classList.remove('hidden'); $('lobby').classList.add('hidden'); $('table').classList.add('hidden'); }
function showLobby() { $('login').classList.add('hidden'); $('lobby').classList.remove('hidden'); $('table').classList.add('hidden'); socket.emit('lobby:get'); }
function showTable() { $('login').classList.add('hidden'); $('lobby').classList.add('hidden'); $('table').classList.remove('hidden'); }

// ===== 渲染牌桌 =====
function render() {
  if (!state) return;
  const s = state;
  // 非结算阶段移除残留的结算弹窗
  if (s.phase !== 'finished') { const rc = document.getElementById('resultCard'); if (rc) rc.remove(); }
  $('roomTitle').textContent = s.name + (s.baseScore ? ` · 底分${s.baseScore}` : '');
  $('multInfo').textContent = s.phase === 'playing' || s.phase === 'finished'
    ? `倍数 ×${s.multiplier}（炸${s.bombCount}）` : '';

  const mySeat = s.yourSeat;
  // 两个对家:座位相对位置
  const leftSeat = mySeat >= 0 ? (mySeat + 2) % 3 : 1;
  const rightSeat = mySeat >= 0 ? (mySeat + 1) % 3 : 2;
  renderSeat($('seatLeft'), s, leftSeat);
  renderSeat($('seatRight'), s, rightSeat);

  // 底牌
  const bc = $('bottomCards');
  bc.innerHTML = '';
  if (s.bottomRevealed) {
    const lbl = document.createElement('span'); lbl.className = 'play-label'; lbl.textContent = '底牌 ';
    bc.appendChild(lbl);
    s.bottom.forEach((id) => bc.appendChild(cardEl(id, { cls: 'small' })));
  } else if (s.phase !== 'waiting') {
    [0, 1, 2].forEach(() => bc.appendChild(cardEl(0, { cls: 'small back' })));
  }

  // 中央出牌区
  renderPlayArea(s);

  // 我的信息与手牌
  renderMe(s);
  renderActions(s);

  // 日志
  $('logBox').innerHTML = s.log.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  $('logBox').scrollTop = $('logBox').scrollHeight;

  // 结算弹窗
  if (s.phase === 'finished' && s.result) renderResult(s);

  startClock(s);
}

// 回合倒计时:每次收到新状态以服务端给的秒数为准,本地每秒递减
function startClock(s) {
  clearInterval(clockInt);
  const el = $('turnClock');
  if (s.turnSecondsLeft == null) { el.textContent = ''; el.classList.remove('urgent'); return; }
  let left = s.turnSecondsLeft;
  const who = s.seats[s.turn];
  const label = s.turn === s.yourSeat ? '你' : (who ? who.name : '');
  const paint = () => {
    el.textContent = `⏱ ${label} ${left}s`;
    el.classList.toggle('urgent', left <= 10);
  };
  paint();
  clockInt = setInterval(() => {
    left--;
    if (left < 0) { left = 0; clearInterval(clockInt); }
    paint();
  }, 1000);
}

function renderSeat(box, s, seat) {
  const p = s.seats[seat];
  box.innerHTML = '';
  const inner = document.createElement('div');
  inner.className = 'seat-box' + (s.turn === seat && (s.phase === 'playing' || s.phase === 'bidding') ? ' turn' : '');
  if (!p) {
    inner.innerHTML = '<div class="seat-name">空座位</div>';
    box.appendChild(inner);
    return;
  }
  let tags = '';
  if (p.isLandlord) tags += '<span class="tag landlord">地主</span>';
  if (!p.connected) tags += '<span class="tag off">离线</span>';
  let actionTxt = '';
  if (s.phase === 'bidding' && p.bid != null) actionTxt = p.bid === 0 ? '不叫' : `叫${p.bid}分`;
  inner.innerHTML = `<div class="seat-name">${escapeHtml(p.name)} ${tags}</div>
    <div class="seat-cards">剩 ${p.handCount} 张　总分 ${p.score}</div>
    <div class="seat-cards">${actionTxt}</div>`;
  // 对家最近出的牌
  const played = document.createElement('div');
  played.className = 'opp-played mini-cards';
  if (p.lastAction === 'pass') played.textContent = '不要';
  else if (p.lastAction && p.lastAction.cards) p.lastAction.cards.forEach((id) => played.appendChild(cardEl(id, { cls: 'mini' })));
  inner.appendChild(played);
  box.appendChild(inner);
}

function renderPlayArea(s) {
  const area = $('playArea');
  const status = $('statusMsg');
  area.innerHTML = '';
  status.textContent = '';
  if (s.phase === 'waiting') {
    const seated = s.seats.filter(Boolean).length;
    status.textContent = `等待玩家… (${seated}/3)　全部「准备」后开局`;
  } else if (s.phase === 'bidding') {
    const turnName = s.seats[s.turn]?.name || '';
    status.textContent = s.turn === s.yourSeat ? '轮到你叫分' : `等待 ${turnName} 叫分…`;
  } else if (s.phase === 'playing') {
    if (s.lastPlay) {
      const lbl = document.createElement('div'); lbl.className = 'play-label';
      lbl.textContent = `${s.seats[s.lastPlay.seat]?.name || ''} 出的 ${s.lastPlay.typeName}`;
      area.appendChild(lbl);
      const row = document.createElement('div'); row.className = 'mini-cards';
      s.lastPlay.cards.forEach((id) => row.appendChild(cardEl(id, { cls: 'small' })));
      area.appendChild(row);
    } else {
      const lbl = document.createElement('div'); lbl.className = 'play-label';
      lbl.textContent = '自由出牌';
      area.appendChild(lbl);
    }
    const turnName = s.seats[s.turn]?.name || '';
    status.textContent = s.turn === s.yourSeat ? '👉 轮到你出牌' : `等待 ${turnName} 出牌…`;
  }
}

function renderMe(s) {
  const info = $('meInfo');
  if (s.yourSeat < 0) {
    info.textContent = '你正在观战';
  } else {
    const meSeat = s.seats[s.yourSeat];
    let tag = meSeat?.isLandlord ? ' 👑地主' : '';
    info.textContent = `${meSeat?.name || ''}${tag}　总分 ${meSeat?.score ?? 0}`;
  }
  const hand = $('myHand');
  hand.innerHTML = '';
  // 清理 selected 中已不在手牌的
  const handSet = new Set(s.yourHand);
  [...selected].forEach((id) => { if (!handSet.has(id)) selected.delete(id); });
  s.yourHand.forEach((id) => hand.appendChild(cardEl(id, { selectable: s.phase === 'playing' && s.turn === s.yourSeat })));
}

function renderActions(s) {
  const a = $('actions');
  a.innerHTML = '';
  const mySeat = s.yourSeat;

  if (s.phase === 'waiting') {
    if (mySeat >= 0) {
      const ready = s.seats[mySeat]?.ready;
      const b = button(ready ? '取消准备' : '准备', () => socket.emit('room:ready'), ready ? '' : 'primary');
      a.appendChild(b);
    } else {
      const free = s.seats.includes(null);
      a.appendChild(button(free ? '坐下' : '暂无空位', () => socket.emit('room:sit'), 'primary'));
      if (!free) a.lastChild.disabled = true;
    }
    return;
  }

  if (s.phase === 'bidding' && s.turn === mySeat) {
    const wrap = document.createElement('div'); wrap.className = 'bid-btns';
    wrap.appendChild(button('不叫', () => socket.emit('bid', { value: 0 })));
    [1, 2, 3].forEach((v) => {
      const b = button(`${v}分`, () => socket.emit('bid', { value: v }), 'primary');
      if (v <= s.bidding.highest) b.disabled = true;
      wrap.appendChild(b);
    });
    a.appendChild(wrap);
    return;
  }

  if (s.phase === 'playing' && s.turn === mySeat) {
    a.appendChild(button('出牌', () => {
      if (!selected.size) return toast('请选择要出的牌');
      socket.emit('play', { cards: [...selected] });
      selected.clear();
    }, 'primary'));
    const passBtn = button('不要', () => { socket.emit('pass'); selected.clear(); });
    if (!s.lastPlay) passBtn.disabled = true; // 自由出牌不能不要
    a.appendChild(passBtn);
    a.appendChild(button('清空', () => { selected.clear(); render(); }));
    return;
  }

  if (s.phase === 'finished') {
    if (mySeat >= 0) a.appendChild(button('下一局', () => socket.emit('room:next'), 'primary'));
  }
}

function renderResult(s) {
  if (document.getElementById('resultCard')) return; // 已显示
  const r = s.result;
  const card = document.createElement('div');
  card.className = 'result-card'; card.id = 'resultCard';
  const win = r.winnerSide === 'landlord' ? '👑 地主胜利' : '🌾 农民胜利';
  let html = `<h2>${win}</h2>
    <div class="delta">底分 ${r.base} × 倍数 ${r.multiplier}${r.spring ? '（含春天)' : ''} = ${r.unit} 分/家</div>
    <div class="delta">炸弹/王炸 ${r.bombCount} 个</div><hr style="opacity:.3">`;
  s.seats.forEach((p) => {
    if (!p) return;
    const d = r.deltas[p.playerId] || 0;
    html += `<div class="delta ${d >= 0 ? 'up' : 'down'}">${escapeHtml(p.name)}${p.isLandlord ? '(地主)' : ''}: ${d >= 0 ? '+' : ''}${d}</div>`;
  });
  card.innerHTML = html;
  const next = button('下一局', () => socket.emit('room:next'), 'primary big');
  next.style.marginTop = '12px';
  card.appendChild(next);
  $('playArea').parentElement.appendChild(card);
}

function button(text, onclick, cls = '') {
  const b = document.createElement('button');
  b.className = 'btn ' + cls;
  b.textContent = text;
  b.onclick = onclick;
  return b;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

showLogin();
