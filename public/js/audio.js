const STORAGE_KEY = 'ddz_voice_enabled';

let enabled = localStorage.getItem(STORAGE_KEY) !== '0';
let preferredVoice = null;
let lastAnnouncedKey = '';
let audioContext = null;

const VALUE_TEXT = {
  3: '三',
  4: '四',
  5: '五',
  6: '六',
  7: '七',
  8: '八',
  9: '九',
  10: '十',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
  15: '二',
  16: '小王',
  17: '大王',
};

function cardValue(card) {
  if (card === 52) return 16;
  if (card === 53) return 17;
  return Math.floor(card / 4) + 3;
}

function valueText(value) {
  return VALUE_TEXT[value] || String(value);
}

function refreshVoices() {
  if (!('speechSynthesis' in window)) return;
  const voices = window.speechSynthesis.getVoices();
  preferredVoice = voices.find((voice) => /zh/i.test(voice.lang) || /中文|Chinese/i.test(voice.name)) || voices[0] || null;
}

if ('speechSynthesis' in window) {
  refreshVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
}

function speak(text, emphasis = 'normal') {
  if (!enabled || !text || !('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = emphasis === 'strong' ? 0.95 : 1;
  utterance.pitch = emphasis === 'strong' ? 1.08 : 1;
  utterance.volume = 1;
  if (preferredVoice) utterance.voice = preferredVoice;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function speakVariant(options) {
  if (!enabled || !options?.length || !('speechSynthesis' in window)) return;
  const choice = options[Math.floor(Math.random() * options.length)];
  const text = typeof choice === 'string' ? choice : choice.text;
  const emphasis = typeof choice === 'string' ? 'normal' : (choice.emphasis || 'normal');
  speak(text, emphasis);
}

function numText(value) {
  return ({ 0: '不叫', 1: '一', 2: '两', 3: '三' }[value] || String(value));
}

function ensureAudioContext() {
  if (!enabled) return null;
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null;
  if (!audioContext) audioContext = new AudioContextCtor();
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}

function playTone(ctx, { frequency, duration = 0.08, type = 'sine', gain = 0.04, at = 0 }) {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.exponentialRampToValueAtTime(gain, at + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(amp);
  amp.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + duration + 0.02);
}

export function playUiSound(kind = 'click') {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  const base = ctx.currentTime + 0.01;
  const patterns = {
    select: [
      { frequency: 620, duration: 0.045, gain: 0.03, at: 0 },
      { frequency: 840, duration: 0.05, gain: 0.028, at: 0.05 },
    ],
    play: [
      { frequency: 880, duration: 0.06, gain: 0.045, at: 0 },
      { frequency: 660, duration: 0.07, gain: 0.04, at: 0.065 },
      { frequency: 990, duration: 0.05, gain: 0.035, at: 0.135 },
    ],
    pass: [
      { frequency: 360, duration: 0.07, gain: 0.03, at: 0 },
      { frequency: 280, duration: 0.08, gain: 0.022, at: 0.075 },
    ],
    bid: [
      { frequency: 520, duration: 0.05, gain: 0.035, at: 0 },
      { frequency: 740, duration: 0.06, gain: 0.04, at: 0.06 },
      { frequency: 920, duration: 0.05, gain: 0.036, at: 0.13 },
    ],
    next: [
      { frequency: 784, duration: 0.05, gain: 0.035, at: 0 },
      { frequency: 988, duration: 0.05, gain: 0.035, at: 0.06 },
      { frequency: 1175, duration: 0.08, gain: 0.04, at: 0.12 },
    ],
    success: [
      { frequency: 660, duration: 0.06, gain: 0.04, at: 0 },
      { frequency: 880, duration: 0.07, gain: 0.045, at: 0.07 },
      { frequency: 1040, duration: 0.08, gain: 0.05, at: 0.16 },
    ],
    click: [
      { frequency: 700, duration: 0.05, gain: 0.03, at: 0 },
    ],
  };
  const steps = patterns[kind] || patterns.click;
  steps.forEach((step) => playTone(ctx, { ...step, at: base + step.at }));
}

function summarize(cards) {
  const values = cards.map(cardValue).sort((a, b) => a - b);
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const distinct = [...counts.keys()].sort((a, b) => a - b);
  return { values, counts, distinct };
}

function describeMove(play) {
  const info = summarize(play.cards || []);
  const first = info.values[0];
  const last = info.values[info.values.length - 1];
  const tripleValue = [...info.counts.entries()].find(([, count]) => count === 3)?.[0];
  const fourValue = [...info.counts.entries()].find(([, count]) => count === 4)?.[0];
  const tripleValues = info.distinct.filter((value) => (info.counts.get(value) || 0) >= 3);
  const tripleStart = tripleValues[0];
  const tripleEnd = tripleValues[tripleValues.length - 1];

  switch (play.moveType) {
    case 'single':
      return valueText(first);
    case 'pair':
      return `对${valueText(first)}`;
    case 'triple':
      return `三个${valueText(first)}`;
    case 'triple_single':
      return `三带一`;
    case 'triple_pair':
      return `三带一对`;
    case 'straight':
      return '顺子';
    case 'straight_pair':
      return '连对';
    case 'plane':
      return '飞机';
    case 'plane_single':
    case 'plane_pair':
      return '飞机带翅膀';
    case 'four_two_single':
      return '四带二';
    case 'four_two_pair':
      return '四带两对';
    case 'bomb':
      return `炸弹`;
    case 'rocket':
      return '王炸';
    default:
      if (fourValue) return `炸弹`;
      if (tripleStart && tripleStart === tripleEnd) return `三个${valueText(tripleStart)}`;
      return play.typeName || '出牌';
  }
}

function buildKey(state) {
  if (!state?.lastPlay) return '';
  return [state.id, state.roundNo, state.lastPlay.moveType, state.lastPlay.cards.join(',')].join('|');
}

export function setVoiceEnabled(next) {
  enabled = !!next;
  localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  return enabled;
}

export function isVoiceEnabled() {
  return enabled;
}

export function toggleVoiceEnabled() {
  return setVoiceEnabled(!enabled);
}

export function syncVoiceToggle(button) {
  if (!button) return;
  const paint = () => {
    button.textContent = enabled ? '🔊 音效开' : '🔇 音效关';
    button.setAttribute('aria-pressed', String(enabled));
    button.classList.toggle('muted', !enabled);
  };
  button.onclick = () => {
    toggleVoiceEnabled();
    paint();
    playUiSound('click');
  };
  paint();
}

export function announcePlay(state) {
  if (!state?.lastPlay || !['playing', 'finished'].includes(state.phase)) return;
  const key = buildKey(state);
  if (!key || key === lastAnnouncedKey) return;
  lastAnnouncedKey = key;
  const summary = describeMove(state.lastPlay);
  speak(summary, state.lastPlay.moveType === 'bomb' || state.lastPlay.moveType === 'rocket' ? 'strong' : 'normal');
}

export function playNextRoundSound() {
  playUiSound('next');
}

export function playSuccessSound() {
  playUiSound('success');
}

export function announceBid(value) {
  const label = numText(value);
  if (value === 0) {
    speakVariant([
      { text: '不叫', emphasis: 'normal' },
      { text: '不叫', emphasis: 'strong' },
    ]);
    return;
  }
  speakVariant([
    { text: `${label}分`, emphasis: 'normal' },
    { text: `${label}分`, emphasis: 'strong' },
  ]);
}

export function announcePass() {
  speakVariant([
    { text: '不要', emphasis: 'normal' },
    { text: 'pass', emphasis: 'normal' },
    { text: '过', emphasis: 'normal' },
  ]);
}