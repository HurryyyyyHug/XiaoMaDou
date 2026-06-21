import { cardEl } from './cards.js';
import { $, button, escapeHtml, toast } from './dom.js';

let clockInt = null;

function roleText(p, s) {
  if (!p) return '';
  if (s.landlord == null || s.landlord < 0) return '待定';
  return p.isLandlord ? '地主' : '农民';
}

function seatAvatarText(p, seat) {
  if (!p) return '?';
  if (p.isLandlord) return '地';
  return seat === 0 ? '东' : seat === 1 ? '南' : '西';
}

function startClock(s) {
  clearInterval(clockInt);
  const el = $('turnClock');
  if (s.turnSecondsLeft == null) {
    el.textContent = '';
    el.classList.remove('urgent');
    return;
  }
  let left = s.turnSecondsLeft;
  const paint = () => {
    el.textContent = left;
    el.classList.toggle('urgent', left <= 10);
  };
  paint();
  clockInt = setInterval(() => {
    left--;
    if (left < 0) {
      left = 0;
      clearInterval(clockInt);
    }
    paint();
  }, 1000);
}

function renderSeat(box, s, seat) {
  const p = s.seats[seat];
  box.innerHTML = '';
  const inner = document.createElement('div');
  inner.className = 'seat-box' + (s.turn === seat && (s.phase === 'playing' || s.phase === 'bidding') ? ' turn' : '');
  if (!p) {
    inner.innerHTML = `
      <div class="avatar empty">?</div>
      <div class="seat-main">
        <div class="seat-name">空座位</div>
        <div class="seat-cards">等待玩家入座</div>
      </div>`;
    box.appendChild(inner);
    return;
  }
  let tags = '';
  if (p.isLandlord) tags += '<span class="tag landlord">地主</span>';
  if (!p.connected) tags += '<span class="tag off">离线</span>';
  let actionTxt = '';
  if (s.phase === 'bidding' && p.bid != null) actionTxt = p.bid === 0 ? '不叫' : `叫${p.bid}分`;
  inner.innerHTML = `
    <div class="avatar ${p.isLandlord ? 'landlord-avatar' : ''}">${seatAvatarText(p, seat)}</div>
    <div class="seat-main">
      <div class="seat-name">${escapeHtml(p.name)} ${tags}</div>
      <div class="seat-cards">${roleText(p, s) || '待定'} · 剩 ${p.handCount} 张 · 总分 ${p.score}</div>
      <div class="seat-action">${actionTxt}</div>
    </div>`;
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
  document.querySelectorAll('.dissolve-banner').forEach((el) => el.remove());
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
      const lbl = document.createElement('div');
      lbl.className = 'play-label';
      lbl.textContent = `${s.seats[s.lastPlay.seat]?.name || ''} 出的 ${s.lastPlay.typeName}`;
      area.appendChild(lbl);
      const row = document.createElement('div');
      row.className = 'mini-cards played-cards';
      s.lastPlay.cards.forEach((id) => row.appendChild(cardEl(id, { cls: 'small' })));
      area.appendChild(row);
    } else {
      const lbl = document.createElement('div');
      lbl.className = 'play-label';
      lbl.textContent = '自由出牌';
      area.appendChild(lbl);
    }
    const turnName = s.seats[s.turn]?.name || '';
    status.textContent = s.turn === s.yourSeat ? '👉 轮到你出牌' : `等待 ${turnName} 出牌…`;
  }
  if (s.dissolve) {
    const dissolve = document.createElement('div');
    dissolve.className = 'dissolve-banner';
    dissolve.textContent = `${s.dissolve.requesterName} 申请解散房间 · 已同意 ${s.dissolve.agree.length}/3 · ${s.dissolve.secondsLeft}s 后自动解散`;
    status.after(dissolve);
  }
}

function renderMe(s, selected, onToggle) {
  const info = $('meInfo');
  if (s.yourSeat < 0) {
    info.textContent = '你正在观战';
  } else {
    const meSeat = s.seats[s.yourSeat];
    const role = roleText(meSeat, s) || '待定';
    info.innerHTML = `
      <div class="avatar self-avatar ${meSeat?.isLandlord ? 'landlord-avatar' : ''}">${meSeat?.isLandlord ? '地' : '我'}</div>
      <div>
        <div class="me-name">${escapeHtml(meSeat?.name || '')}</div>
        <div class="me-score">${role} · 总分 ${meSeat?.score ?? 0}</div>
      </div>`;
  }
  const hand = $('myHand');
  hand.innerHTML = '';
  const handSet = new Set(s.yourHand);
  [...selected].forEach((id) => {
    if (!handSet.has(id)) selected.delete(id);
  });
  s.yourHand.forEach((id) => {
    hand.appendChild(cardEl(id, {
      selectable: s.phase === 'playing' && s.turn === s.yourSeat,
      selected,
      onToggle,
    }));
  });
}

function renderActions(s, context) {
  const { socket, selected, debugMode, render } = context;
  const a = $('actions');
  a.innerHTML = '';
  const mySeat = s.yourSeat;
  if (s.dissolve && mySeat >= 0) {
    const myPlayerId = s.seats[mySeat]?.playerId;
    const voted = s.dissolve.agree.includes(myPlayerId) || s.dissolve.reject.includes(myPlayerId);
    if (s.dissolve.requester === myPlayerId) {
      a.appendChild(button('取消解散申请', () => socket.emit('dissolve:cancel')));
    } else if (!voted) {
      a.appendChild(button('同意解散', () => socket.emit('dissolve:vote', { agree: true }), 'danger'));
      a.appendChild(button('拒绝并取消解散', () => socket.emit('dissolve:vote', { agree: false })));
    } else {
      a.appendChild(button('已投票', () => {}, ''));
      a.lastChild.disabled = true;
    }
  }

  if (s.phase === 'waiting') {
    if (mySeat >= 0) {
      const ready = s.seats[mySeat]?.ready;
      a.appendChild(button(ready ? '取消准备' : '准备', () => socket.emit('room:ready'), ready ? '' : 'primary'));
      if (debugMode) a.appendChild(button('测试满员发牌', () => socket.emit('debug:fillRoom'), 'debug'));
    } else {
      const free = s.seats.includes(null);
      a.appendChild(button(free ? '坐下' : '暂无空位', () => socket.emit('room:sit'), 'primary'));
      if (!free) a.lastChild.disabled = true;
    }
    return;
  }

  if (s.phase === 'bidding' && s.turn === mySeat) {
    const wrap = document.createElement('div');
    wrap.className = 'bid-btns';
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
    const passBtn = button('不要', () => {
      socket.emit('pass');
      selected.clear();
    });
    if (!s.lastPlay) passBtn.disabled = true;
    a.appendChild(passBtn);
    a.appendChild(button('清空', () => {
      selected.clear();
      render();
    }));
    return;
  }

  if (s.phase === 'finished' && mySeat >= 0) {
    const next = button(s.roomDone ? '已完成全部局数' : '下一局', () => socket.emit('room:next'), 'primary');
    next.disabled = s.roomDone;
    a.appendChild(next);
  }
}

function renderResult(s, socket) {
  if (document.getElementById('resultCard')) return;
  const r = s.result;
  const card = document.createElement('div');
  card.className = 'result-card';
  card.id = 'resultCard';
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
  const next = button(s.roomDone ? '已完成全部局数' : '下一局', () => socket.emit('room:next'), 'primary big');
  next.disabled = s.roomDone;
  next.style.marginTop = '12px';
  card.appendChild(next);
  $('playArea').parentElement.appendChild(card);
}

export function renderTable(state, context) {
  if (!state) return;
  const s = state;
  if (s.phase !== 'finished') {
    const rc = document.getElementById('resultCard');
    if (rc) rc.remove();
  }
  $('roomTitle').textContent = `${s.name} · 第${s.roundNo}/${s.options?.roundLimit || 6}局` + (s.baseScore ? ` · 底分${s.baseScore}` : '');
  $('leaveRoom').textContent = ['bidding', 'playing'].includes(s.phase) && s.yourSeat >= 0 ? '申请解散' : '← 退出';
  $('multInfo').textContent = s.phase === 'playing' || s.phase === 'finished'
    ? `倍数 ×${s.multiplier}/${s.options?.maxMultiplier || 24}（炸${s.bombCount}）`
    : '';

  const mySeat = s.yourSeat;
  const leftSeat = mySeat >= 0 ? (mySeat + 2) % 3 : 1;
  const rightSeat = mySeat >= 0 ? (mySeat + 1) % 3 : 2;
  renderSeat($('seatLeft'), s, leftSeat);
  renderSeat($('seatRight'), s, rightSeat);

  const bc = $('bottomCards');
  bc.innerHTML = '';
  if (s.bottomRevealed) {
    const lbl = document.createElement('span');
    lbl.className = 'play-label';
    lbl.textContent = '底牌 ';
    bc.appendChild(lbl);
    s.bottom.forEach((id) => bc.appendChild(cardEl(id, { cls: 'small' })));
  } else if (s.phase !== 'waiting') {
    [0, 1, 2].forEach(() => bc.appendChild(cardEl(0, { cls: 'small back' })));
  }

  renderPlayArea(s);
  renderMe(s, context.selected, context.onToggleCard);
  renderActions(s, context);
  if (s.phase === 'finished' && s.result) renderResult(s, context.socket);
  startClock(s);
}
