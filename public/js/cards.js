const RANK_LABELS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUITS = ['♠', '♥', '♣', '♦'];
const CARD_SUITS = ['Spade', 'Heart', 'Club', 'Diamond'];

function cardInfo(id) {
  if (id === 52) return { rank: '小', suit: 'JOKER', red: false, joker: true, file: 'JOKER-B.png' };
  if (id === 53) return { rank: '大', suit: 'JOKER', red: true, joker: true, file: 'JOKER-A.png' };
  const ri = Math.floor(id / 4);
  const s = id % 4;
  return {
    rank: RANK_LABELS[ri],
    suit: SUITS[s],
    red: s === 1 || s === 3,
    joker: false,
    file: `${CARD_SUITS[s]}${RANK_LABELS[ri]}.png`,
  };
}

export function cardEl(id, { cls = '', selectable = false, selected, onToggle } = {}) {
  const info = cardInfo(id);
  const el = document.createElement('div');
  el.className = 'card ' + cls + (info.red ? ' red' : '');
  const img = document.createElement('img');
  img.alt = info.joker ? info.rank : `${info.suit}${info.rank}`;
  img.draggable = false;
  img.src = cls.includes('back') ? '/card_picture/PNG/Background.png' : `/card_picture/PNG/${info.file}`;
  el.appendChild(img);
  if (selectable) {
    el.dataset.id = id;
    if (selected?.has(id)) el.classList.add('selected');
    el.onclick = () => onToggle?.(id, el);
  }
  return el;
}
